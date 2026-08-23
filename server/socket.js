const { Server } = require('socket.io');
const Channel = require('./database/models/Channel');
const ServerModel = require('./database/models/Server');
const User = require('./database/models/User');
const Dm = require('./database/models/Dm');
const jwt = require('jsonwebtoken');
const config = require('./config');

function setupSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    // Padrão do Socket.IO é 1MB — muito pouco pra imagem em base64 (até ~11MB
    // pra um arquivo de 8MB). Sem isso, 'send-message' com anexo grande
    // simplesmente não chegava no servidor: o pacote era descartado (ou a
    // conexão derrubada) por estourar o buffer, e o cliente ficava esperando
    // pra sempre um retorno que nunca vinha ("cai em um vazio").
    maxHttpBufferSize: 15 * 1024 * 1024,
    // Um pouco mais tolerante que o padrão (20s) — em celular, abrir a
    // câmera/tela pode travar a thread principal por alguns segundos
    // (prompt de permissão, seletor nativo de tela) e isso pode atrasar o
    // pong o suficiente pro servidor achar que a conexão morreu.
    pingTimeout: 30000,
    pingInterval: 25000
  });

  const userSockets = new Map(); // userId -> socketId
  const socketUsers = new Map(); // socketId -> userId
  const userChannels = new Map(); // userId -> channelId
  const onlineUsers = new Set(); // userId presente com pelo menos 1 socket ativo
  const screenShareSockets = new Map(); // screen:<userId> -> socketId

  function notifyScreenSharesToViewer(socket, channelId) {
    for (const [peerId, nativeSocketId] of screenShareSockets.entries()) {
      const nativeSocket = io.sockets.sockets.get(nativeSocketId);
      if (!nativeSocket || nativeSocket.screenChannelId !== channelId) continue;
      socket.emit('native-screen-started', {
        peerId,
        userId: nativeSocket.screenOwnerId,
        userName: nativeSocket.screenOwnerName
      });
      if (socket.userId && socket.userId !== nativeSocket.screenOwnerId) {
        nativeSocket.emit('native-screen-viewer-joined', { userId: socket.userId });
      }
    }
  }

  function notifyScreenSharesViewerLeft(userId, channelId) {
    if (!userId || !channelId) return;
    for (const nativeSocketId of screenShareSockets.values()) {
      const nativeSocket = io.sockets.sockets.get(nativeSocketId);
      if (nativeSocket?.screenChannelId === channelId && nativeSocket.screenOwnerId !== userId) {
        nativeSocket.emit('native-screen-viewer-left', { userId });
      }
    }
  }

  io.on('connection', (socket) => {
    console.log('🔌 Conectado:', socket.id);

    // ========== REGISTRO ==========
    socket.on('register', async ({ userId, token, serverId }) => {
      try {
        // Verificar token se necessário
        const user = await User.findById(userId);
        if (!user) {
          socket.emit('error', { message: 'Usuário não encontrado' });
          return;
        }

        socketUsers.set(socket.id, userId);
        userSockets.set(userId, socket.id);
        socket.userId = userId;
        socket.userName = user.display_name || user.username;

        socket.join(`user-${userId}`);
        console.log(`👤 ${socket.userName} (${userId}) registrado`);

        // Entra na "sala" do servidor (página) atual, se informado — é isso
        // que permite avisar quem já está com a página aberta quando ALGUÉM
        // NOVO entra no servidor (ver rota HTTP /api/servers/:id/join, que
        // emite 'member-joined' pra essa sala). Sem isso o servidor nunca
        // tinha como empurrar essa novidade pra quem já estava conectado —
        // o array de membros no cliente só era carregado uma vez, no load()
        // inicial, e ficava desatualizado (por isso membros novos apareciam
        // como "MEMBRO" genérico nas chamadas de voz).
        if (serverId) {
          socket.join(`server-${serverId}`);
          socket.serverId = serverId;
        }

        // ===== Presença online/offline (bolinha verde estilo Discord) =====
        const wasOffline = !onlineUsers.has(userId);
        onlineUsers.add(userId);
        // Manda a lista atual pra quem acabou de entrar, pra ele já
        // desenhar as bolinhas certas sem esperar um evento de outra pessoa.
        socket.emit('presence-list', Array.from(onlineUsers));
        if (wasOffline && serverId) {
          io.to(`server-${serverId}`).emit('presence-update', { userId, online: true });
        }

        // Enviar servidores do usuário
        const servers = await User.getServers(userId);
        socket.emit('servers-list', servers);

      } catch (error) {
        console.error('❌ Erro no registro:', error);
        socket.emit('error', { message: 'Erro ao registrar' });
      }
    });

    // ========== ENTRAR NO CANAL DE VOZ ==========
    socket.on('join-voice-channel', async ({ channelId }) => {
      try {
        const channel = await Channel.findById(channelId);
        if (!channel) {
          socket.emit('error', { message: 'Canal não encontrado' });
          return;
        }

        // Sair do canal anterior
        const prevChannel = userChannels.get(socket.userId);
        if (prevChannel) {
          await Channel.leaveVoice(socket.userId, prevChannel);
          io.to(`channel-${prevChannel}`).emit('user-left', {
            userId: socket.userId,
            userName: socket.userName
          });
          socket.leave(`channel-${prevChannel}`);
        }

        // Entrar no novo canal
        await Channel.joinVoice(socket.userId, channelId);
        userChannels.set(socket.userId, channelId);

        socket.join(`channel-${channelId}`);
        socket.currentChannel = channelId;

        // Buscar membros atuais
        const members = await Channel.getVoiceMembers(channelId);
        io.to(`channel-${channelId}`).emit('channel-members', members);

        // Notificar entrada
        io.to(`channel-${channelId}`).emit('user-joined', {
          userId: socket.userId,
          userName: socket.userName
        });

        console.log(`🎤 ${socket.userName} entrou no canal ${channel.name}`);

        // Se já existe uma transmissão externa (celular) rolando nesse
        // canal, avisa quem acabou de entrar pra ele já renderizar o tile.
        const { getActiveCastInfo } = require('./media');
        const castInfo = getActiveCastInfo(channelId);
        if (castInfo) {
          socket.emit('external-cast-live', { channelId, playbackUrl: castInfo.playbackUrl });
        }
        notifyScreenSharesToViewer(socket, channelId);

      } catch (error) {
        console.error('❌ Erro ao entrar no canal de voz:', error);
        socket.emit('error', { message: 'Erro ao entrar no canal' });
      }
    });

    // ========== SAIR DO CANAL DE VOZ ==========
    socket.on('leave-voice-channel', async () => {
      try {
        const channelId = userChannels.get(socket.userId);
        if (!channelId) return;

        await Channel.leaveVoice(socket.userId, channelId);
        userChannels.delete(socket.userId);

        socket.leave(`channel-${channelId}`);
        socket.currentChannel = null;

        const members = await Channel.getVoiceMembers(channelId);
        io.to(`channel-${channelId}`).emit('channel-members', members);
        io.to(`channel-${channelId}`).emit('user-left', {
          userId: socket.userId,
          userName: socket.userName
        });
        notifyScreenSharesViewerLeft(socket.userId, channelId);

        console.log(`🎤 ${socket.userName} saiu do canal`);

      } catch (error) {
        console.error('❌ Erro ao sair do canal de voz:', error);
      }
    });

    // ========== AUDIO TOGGLE ==========
    socket.on('audio-toggle', async ({ muted }) => {
      try {
        const channelId = userChannels.get(socket.userId);
        if (!channelId) return;

        await Channel.updateVoiceState(socket.userId, channelId, muted, false);
        io.to(`channel-${channelId}`).emit('user-audio-toggle', {
          userId: socket.userId,
          muted
        });

      } catch (error) {
        console.error('❌ Erro no audio toggle:', error);
      }
    });

    // ========== ESTADO DE MÍDIA (mic/câmera) NA CHAMADA DE VOZ ==========
    socket.on('voice-media-state', ({ muted, camera, screen }) => {
      try {
        const channelId = userChannels.get(socket.userId);
        if (!channelId) return;
        io.to(`channel-${channelId}`).emit('user-media-state', {
          userId: socket.userId,
          muted: !!muted,
          camera: !!camera,
          screen: !!screen
        });
      } catch (error) {
        console.error('❌ Erro no voice-media-state:', error);
      }
    });

    // ========== SINALIZAÇÃO WEBRTC (peer-to-peer mesh) ==========
    // Repassa SDP offers/answers e ICE candidates diretamente para o usuário-alvo.
    socket.on('voice-signal', ({ to, data }) => {
      try {
        const screenSocketId = screenShareSockets.get(to);
        if (screenSocketId) {
          const nativeSocket = io.sockets.sockets.get(screenSocketId);
          if (!socket.userId || userChannels.get(socket.userId) !== nativeSocket?.screenChannelId) return;
        }
        const targetSocketId = userSockets.get(to) || screenSocketId;
        if (targetSocketId) {
          io.to(targetSocketId).emit('voice-signal', {
            from: socket.userId,
            data
          });
        }
      } catch (error) {
        console.error('❌ Erro na sinalização WebRTC:', error);
      }
    });

    // ========== TELA NATIVA DO APK VIA WEBRTC ==========
    socket.on('register-native-screen', async ({ userId, token, channelId }) => {
      try {
        const decoded = jwt.verify(String(token || ''), config.jwtSecret);
        if (decoded.id !== userId) throw new Error('Token não corresponde ao usuário');
        const user = await User.findById(userId);
        const channel = await Channel.findById(channelId);
        if (!user || !channel || channel.type !== 'voice') throw new Error('Canal de voz inválido');
        const role = await ServerModel.getMemberRole(channel.server_id, userId);
        if (!role) throw new Error('Usuário não participa do servidor');

        const peerId = `screen:${userId}`;
        const previousId = screenShareSockets.get(peerId);
        if (previousId && previousId !== socket.id) io.sockets.sockets.get(previousId)?.disconnect(true);

        socket.screenPeerId = peerId;
        socket.screenOwnerId = userId;
        socket.screenOwnerName = user.display_name || user.username;
        socket.screenChannelId = channelId;
        screenShareSockets.set(peerId, socket.id);
        socket.join(`channel-${channelId}`);

        const members = await Channel.getVoiceMembers(channelId);
        socket.emit('native-screen-registered', {
          peerId,
          viewers: members.map(member => member.user_id).filter(id => id !== userId)
        });
        io.to(`channel-${channelId}`).emit('native-screen-started', {
          peerId,
          userId,
          userName: socket.screenOwnerName
        });
      } catch (error) {
        console.error('❌ Erro ao registrar tela nativa:', error.message);
        socket.emit('native-screen-error', { message: 'Não foi possível iniciar a tela nativa.' });
      }
    });

    socket.on('native-screen-signal', ({ to, data }) => {
      try {
        if (!socket.screenPeerId || !socket.screenChannelId) return;
        if (userChannels.get(to) !== socket.screenChannelId) return;
        const targetSocketId = userSockets.get(to);
        if (!targetSocketId) return;
        io.to(targetSocketId).emit('voice-signal', { from: socket.screenPeerId, data });
      } catch (error) {
        console.error('❌ Erro na sinalização da tela nativa:', error);
      }
    });

    // ========== ENTRAR NO CANAL DE TEXTO (necessário pro broadcast de mensagens) ==========
    socket.on('join-text-channel', ({ channelId }) => {
      try {
        if (socket.textChannel) {
          socket.leave(`channel-${socket.textChannel}`);
        }
        socket.textChannel = channelId;
        socket.join(`channel-${channelId}`);
      } catch (error) {
        console.error('❌ Erro ao entrar no canal de texto:', error);
      }
    });

    // ========== MENSAGEM ==========
    socket.on('send-message', async ({ channelId, message, file }) => {
      try {
        const channel = await Channel.findById(channelId);
        if (!channel) {
          socket.emit('error', { message: 'Canal não encontrado' });
          return;
        }

        const msgData = await Channel.saveMessage({
          channelId,
          userId: socket.userId,
          content: message,
          file: file ? {
            name: file.name,
            type: file.type,
            size: file.size || null,
            data: file.data || null
          } : null
        });

        io.to(`channel-${channelId}`).emit('new-message', msgData);

      } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error);
        socket.emit('error', { message: 'Erro ao enviar mensagem' });
      }
    });

    // ========== EDITAR MENSAGEM ==========
    socket.on('edit-message', async ({ messageId, content }) => {
      try {
        const original = await Channel.getMessage(messageId);
        if (!original) return socket.emit('error', { message: 'Mensagem não encontrada' });
        if (original.user_id !== socket.userId) {
          return socket.emit('error', { message: 'Você só pode editar suas próprias mensagens' });
        }
        const trimmed = (content || '').trim();
        if (!trimmed) return;
        const updated = await Channel.editMessage(messageId, trimmed.slice(0, 2000));
        io.to(`channel-${original.channel_id}`).emit('message-edited', updated);
      } catch (error) {
        console.error('❌ Erro ao editar mensagem:', error);
        socket.emit('error', { message: 'Erro ao editar mensagem' });
      }
    });

    // ========== EXCLUIR MENSAGEM ==========
    socket.on('delete-message', async ({ messageId }) => {
      try {
        const original = await Channel.getMessage(messageId);
        if (!original) return;
        const channel = await Channel.findById(original.channel_id);
        const role = channel ? await ServerModel.getMemberRole(channel.server_id, socket.userId) : null;
        const isOwner = original.user_id === socket.userId;
        const isAdmin = role === 'admin';
        if (!isOwner && !isAdmin) {
          return socket.emit('error', { message: 'Você não pode excluir essa mensagem' });
        }
        await Channel.deleteMessage(messageId);
        io.to(`channel-${original.channel_id}`).emit('message-deleted', { id: messageId, channel_id: original.channel_id });
      } catch (error) {
        console.error('❌ Erro ao excluir mensagem:', error);
        socket.emit('error', { message: 'Erro ao excluir mensagem' });
      }
    });

    // ========== INDICADOR "ESTÁ DIGITANDO…" ==========
    socket.on('typing-start', ({ channelId }) => {
      socket.to(`channel-${channelId}`).emit('user-typing', { channelId, userId: socket.userId, userName: socket.userName });
    });
    socket.on('typing-stop', ({ channelId }) => {
      socket.to(`channel-${channelId}`).emit('user-stop-typing', { channelId, userId: socket.userId });
    });

    // ========== MENSAGENS PRIVADAS (DM) ==========
    // Cada usuário já está numa sala `user-${id}` desde o registro (ver
    // 'register' acima), então dá pra mandar DM direto pra sala da pessoa
    // sem precisar que ela esteja com a página de DMs aberta.
    socket.on('send-dm', async ({ toUserId, message, file }) => {
      try {
        if (!toUserId || toUserId === socket.userId) return;
        const target = await User.findById(toUserId);
        if (!target) return socket.emit('error', { message: 'Usuário não encontrado' });
        const block = await require('./database').queryOne('SELECT blocker_id FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1', [socket.userId, toUserId]);
        if (block) return socket.emit('dm-send-error', { toUserId, message: block.blocker_id === socket.userId ? 'Desbloqueie este usuário antes de enviar mensagens' : 'Você não pode enviar mensagens para este usuário' });
        const text = (message || '').trim();
        if (!text && !file) return;
        if (text.length > 2000) return socket.emit('error', { message: 'Mensagem muito longa' });

        const dm = await Dm.send({ senderId: socket.userId, recipientId: toUserId, content: text, file });
        io.to(`user-${toUserId}`).emit('new-dm', dm);
        io.to(`user-${socket.userId}`).emit('new-dm', dm); // ecoa pro remetente (multi-aba)
      } catch (error) {
        console.error('❌ Erro ao enviar DM:', error);
        socket.emit('error', { message: 'Erro ao enviar mensagem privada' });
      }
    });

    socket.on('edit-dm', async ({ messageId, content }) => {
      try {
        const original = await Dm.getById(messageId);
        if (!original || original.sender_id !== socket.userId) {
          return socket.emit('error', { message: 'Você só pode editar suas próprias mensagens' });
        }
        const trimmed = (content || '').trim();
        if (!trimmed) return;
        const updated = await Dm.edit(messageId, trimmed.slice(0, 2000));
        io.to(`user-${original.sender_id}`).emit('dm-edited', updated);
        io.to(`user-${original.recipient_id}`).emit('dm-edited', updated);
      } catch (error) {
        console.error('❌ Erro ao editar DM:', error);
        socket.emit('error', { message: 'Erro ao editar mensagem' });
      }
    });

    socket.on('delete-dm', async ({ messageId }) => {
      try {
        const original = await Dm.getById(messageId);
        if (!original || original.sender_id !== socket.userId) {
          return socket.emit('error', { message: 'Você só pode excluir suas próprias mensagens' });
        }
        await Dm.delete(messageId);
        const payload = { id: messageId, sender_id: original.sender_id, recipient_id: original.recipient_id };
        io.to(`user-${original.sender_id}`).emit('dm-deleted', payload);
        io.to(`user-${original.recipient_id}`).emit('dm-deleted', payload);
      } catch (error) {
        console.error('❌ Erro ao excluir DM:', error);
        socket.emit('error', { message: 'Erro ao excluir mensagem' });
      }
    });

    socket.on('dm-typing-start', ({ toUserId }) => {
      if (!toUserId) return;
      io.to(`user-${toUserId}`).emit('dm-user-typing', { userId: socket.userId, userName: socket.userName });
    });
    socket.on('dm-typing-stop', ({ toUserId }) => {
      if (!toUserId) return;
      io.to(`user-${toUserId}`).emit('dm-user-stop-typing', { userId: socket.userId });
    });

    // ========== GO LIVE ==========
    socket.on('start-go-live', ({ channelId }) => {
      try {
        io.to(`channel-${channelId}`).emit('stream-started', {
          userId: socket.userId,
          userName: socket.userName
        });
      } catch (error) {
        console.error('❌ Erro no start go live:', error);
      }
    });

    socket.on('stop-go-live', ({ channelId }) => {
      try {
        io.to(`channel-${channelId}`).emit('stream-stopped', {
          userId: socket.userId
        });
      } catch (error) {
        console.error('❌ Erro no stop go live:', error);
      }
    });

    // ========== DESCONEXÃO ==========
    socket.on('disconnect', async () => {
      console.log('🔌 Desconectado:', socket.id);

      if (socket.screenPeerId && screenShareSockets.get(socket.screenPeerId) === socket.id) {
        screenShareSockets.delete(socket.screenPeerId);
        io.to(`channel-${socket.screenChannelId}`).emit('native-screen-ended', {
          peerId: socket.screenPeerId,
          userId: socket.screenOwnerId
        });
      }

      const userId = socketUsers.get(socket.id);
      if (userId) {
        // Sair do canal de voz
        const channelId = userChannels.get(userId);
        // Entre este 'disconnect' disparar e chegarmos aqui, o cliente pode
        // já ter reconectado com um socket NOVO e reentrado no canal (ele
        // reemite 'register' + 'join-voice-channel' automaticamente no
        // reconnect). Nesse caso userSockets.get(userId) já aponta pro
        // socket novo, não mais pra este socket.id que está desconectando.
        // Sem essa checagem, este handler (que só roda um pouco depois,
        // já que os awaits abaixo esperam o banco) apagava o voice_state
        // recém-criado pela reconexão e avisava todo mundo (user-left) que
        // a pessoa saiu — mesmo ela já tendo voltado. Do lado de quem
        // reconectou, a própria tela nunca mostrou saída (o tile dela é
        // sempre renderizado localmente), então parecia que só os OUTROS a
        // viam sumir da call.
        const stillCurrentSocket = userSockets.get(userId) === socket.id;
        if (channelId && stillCurrentSocket) {
          try {
            await Channel.leaveVoice(userId, channelId);
            const members = await Channel.getVoiceMembers(channelId);
            io.to(`channel-${channelId}`).emit('channel-members', members);
            io.to(`channel-${channelId}`).emit('user-left', {
              userId,
              userName: socket.userName || 'Usuário'
            });
            notifyScreenSharesViewerLeft(userId, channelId);
          } catch (e) {
            console.error('❌ Erro ao remover do canal:', e);
          }
        }

        // Mesma checagem: só limpar os mapas globais se nenhuma reconexão
        // já assumiu esse userId.
        if (userSockets.get(userId) === socket.id) {
          userSockets.delete(userId);
          userChannels.delete(userId);
          onlineUsers.delete(userId);
          // Avisa todo mundo que divide servidor com essa pessoa que ela
          // ficou offline (bolinha cinza), igual à entrada em 'register'.
          try {
            const servers = await User.getServers(userId);
            for (const s of servers) {
              io.to(`server-${s.id}`).emit('presence-update', { userId, online: false });
            }
          } catch (e) {
            console.error('❌ Erro ao propagar presença offline:', e);
          }
        }
      }

      socketUsers.delete(socket.id);
    });
  });

  return io;
}

module.exports = { setupSocket };
