const { Server } = require('socket.io');
const Channel = require('./database/models/Channel');
const ServerModel = require('./database/models/Server');
const User = require('./database/models/User');
const Dm = require('./database/models/Dm');
const config = require('./config');
const {
  SESSION_COOKIE,
  parseCookies,
  verifySessionToken,
  verifyNativeCastToken
} = require('./security/session');

function setupSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: config.nodeEnv === 'production' ? (config.appOrigin || false) : config.corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true
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

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie || '');
      const sessionToken = cookies[SESSION_COOKIE];
      if (sessionToken) {
        const session = await verifySessionToken(sessionToken);
        socket.authKind = 'session';
        socket.authUser = session.user;
        socket.auth = session.decoded;
        socket.userId = session.user.id;
        return next();
      }

      const authorization = String(socket.handshake.headers.authorization || '');
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match) return next(new Error('unauthorized'));
      const cast = await verifyNativeCastToken(match[1]);
      socket.authKind = 'cast';
      socket.userId = cast.sub;
      socket.castChannelId = String(cast.channelId);
      socket.auth = cast;
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  const userSockets = new Map(); // userId -> socketId
  const socketUsers = new Map(); // socketId -> userId
  const userChannels = new Map(); // userId -> channelId
  const onlineUsers = new Set(); // userId presente com pelo menos 1 socket ativo
  const screenShareSockets = new Map(); // screen:<userId> -> socketId

  function sanitizeAttachment(file) {
    if (!file) return null;
    const allowedTypes = new Set(config.upload.allowedTypes || []);
    const type = String(file.type || '').toLowerCase();
    if (!allowedTypes.has(type)) throw new Error('Tipo de arquivo não permitido');
    const data = String(file.data || '');
    const prefix = `data:${type};base64,`;
    if (!data.startsWith(prefix)) throw new Error('Conteúdo do arquivo inválido');
    const encoded = data.slice(prefix.length).replace(/[\r\n]/g, '');
    if (!/^[a-z0-9+/]*={0,2}$/i.test(encoded)) throw new Error('Arquivo Base64 inválido');
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const decodedBytes = Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
    const maxBytes = Math.min(Number(config.upload.maxSize) || 8 * 1024 * 1024, 8 * 1024 * 1024);
    if (decodedBytes < 1 || decodedBytes > maxBytes) throw new Error('Arquivo excede o limite de 8MB');
    const name = String(file.name || 'arquivo')
      .replace(/[\\/\0\r\n]/g, '_')
      .slice(0, 160);
    return { name, type, size: decodedBytes, data };
  }

  const viewerPeerId = socketId => `viewer:${socketId}`;
  const viewerSocketId = peerId => String(peerId || '').startsWith('viewer:')
    ? String(peerId).slice('viewer:'.length)
    : null;

  function activeScreenViewers(channelId) {
    const room = io.sockets.adapter.rooms.get(`channel-${channelId}`) || new Set();
    return [...room]
      .map(socketId => io.sockets.sockets.get(socketId))
      .filter(viewer => viewer?.userId && userChannels.get(viewer.userId) === channelId)
      .map(viewer => viewerPeerId(viewer.id));
  }

  function notifyScreenSharesToViewer(socket, channelId) {
    for (const [peerId, nativeSocketId] of screenShareSockets.entries()) {
      const nativeSocket = io.sockets.sockets.get(nativeSocketId);
      if (!nativeSocket || nativeSocket.screenChannelId !== channelId) continue;
      socket.emit('native-screen-started', {
        peerId,
        userId: nativeSocket.screenOwnerId,
        userName: nativeSocket.screenOwnerName
      });
      if (socket.userId && userChannels.get(socket.userId) === channelId) {
        nativeSocket.emit('native-screen-viewer-joined', { userId: viewerPeerId(socket.id) });
      }
    }
  }

  function notifyScreenSharesViewerLeft(socket, channelId) {
    if (!socket?.id || !channelId) return;
    for (const nativeSocketId of screenShareSockets.values()) {
      const nativeSocket = io.sockets.sockets.get(nativeSocketId);
      if (nativeSocket?.screenChannelId === channelId) {
        nativeSocket.emit('native-screen-viewer-left', { userId: viewerPeerId(socket.id) });
      }
    }
  }

  function stopNativeScreenForOwner(userId, reason = 'voice-left') {
    if (!userId) return false;
    const peerId = `screen:${userId}`;
    const nativeSocketId = screenShareSockets.get(peerId);
    const nativeSocket = nativeSocketId && io.sockets.sockets.get(nativeSocketId);
    if (!nativeSocket) {
      screenShareSockets.delete(peerId);
      return false;
    }
    const channelId = nativeSocket.screenChannelId;
    screenShareSockets.delete(peerId);
    if (channelId) {
      nativeSocket.leave(`channel-${channelId}`);
      io.to(`channel-${channelId}`).emit('native-screen-ended', {
        peerId,
        userId,
        reason
      });
    }
    // O serviço Android encerra MediaProjection, áudio, peers e foreground
    // service. Apenas desconectar faria o Socket.IO reconectar e registrar
    // a transmissão órfã novamente.
    nativeSocket.emit('native-screen-force-stop', { reason });
    nativeSocket.screenPeerId = null;
    nativeSocket.screenChannelId = null;
    return true;
  }

  io.on('connection', (socket) => {
    console.log('🔌 Conectado:', socket.id);

    const castEvents = new Set([
      'register-native-screen',
      'native-screen-signal',
      'native-screen-debug',
      'native-screen-audio'
    ]);
    socket.use(([event], next) => {
      if (socket.authKind === 'cast' && !castEvents.has(event)) {
        return next(new Error('forbidden'));
      }
      next();
    });

    // ========== REGISTRO ==========
    socket.on('register', async ({ serverId } = {}) => {
      try {
        if (socket.authKind !== 'session' || !socket.authUser) {
          return socket.emit('error', { message: 'Sessão inválida' });
        }
        const user = socket.authUser;
        const userId = user.id;

        socketUsers.set(socket.id, userId);
        userSockets.set(userId, socket.id);
        socket.userId = userId;
        socket.userName = user.display_name || user.username;

        socket.join(`user-${userId}`);
        console.log(`👤 ${socket.userName} (${userId}) registrado`);

        if (serverId) {
          const role = await ServerModel.getMemberRole(String(serverId), userId);
          if (!role) {
            socket.emit('error', { message: 'Você não participa deste servidor' });
          } else {
            socket.join(`server-${serverId}`);
            socket.serverId = String(serverId);
          }
        }

        const wasOffline = !onlineUsers.has(userId);
        onlineUsers.add(userId);
        socket.emit('presence-list', Array.from(onlineUsers));
        if (wasOffline && socket.serverId) {
          io.to(`server-${socket.serverId}`).emit('presence-update', { userId, online: true });
        }

        const servers = await User.getServers(userId);
        socket.emit('servers-list', servers);
      } catch (error) {
        console.error('❌ Erro no registro:', error?.message || error);
        socket.emit('error', { message: 'Erro ao registrar' });
      }
    });

    // ========== ENTRAR NO CANAL DE VOZ ==========
    socket.on('join-voice-channel', async ({ channelId }) => {
      try {
        if (socket.authKind !== 'session' || !socket.userId) {
          return socket.emit('error', { message: 'Sessão inválida' });
        }
        const channel = await Channel.findById(channelId);
        if (!channel || channel.type !== 'voice') {
          socket.emit('error', { message: 'Canal de voz não encontrado' });
          return;
        }
        const memberRole = await ServerModel.getMemberRole(channel.server_id, socket.userId);
        if (!memberRole) {
          socket.emit('error', { message: 'Você não participa deste servidor' });
          return;
        }

        // Sair do canal anterior
        const prevChannel = userChannels.get(socket.userId);
        if (prevChannel) {
          stopNativeScreenForOwner(socket.userId, 'channel-changed');
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

        stopNativeScreenForOwner(socket.userId, 'voice-left');

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
        notifyScreenSharesViewerLeft(socket, channelId);

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
          if (!screenSocketId) {
            const myChannel = userChannels.get(socket.userId);
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (!myChannel || !targetSocket?.userId || userChannels.get(targetSocket.userId) !== myChannel) return;
          }
          if (screenSocketId && data?.sdp) {
            console.log(`📡 Oferta ${data.sdp.type} do visualizador ${socket.id} encaminhada para ${to}`);
          }
          io.to(targetSocketId).emit('voice-signal', {
            // Para a tela nativa, identifica esta conexão exata. Isso evita
            // mandar a resposta para outra aba/WebView do mesmo usuário.
            from: screenSocketId ? viewerPeerId(socket.id) : socket.userId,
            data
          });
        }
      } catch (error) {
        console.error('❌ Erro na sinalização WebRTC:', error);
      }
    });

    // ========== TELA NATIVA DO APK VIA WEBRTC ==========
    socket.on('register-native-screen', async ({ channelId } = {}) => {
      try {
        if (socket.authKind !== 'cast') throw new Error('Credencial de transmissão necessária');
        const userId = socket.userId;
        channelId = String(channelId || '');
        if (!channelId || socket.castChannelId !== channelId) throw new Error('Token não corresponde ao canal');
        const user = await User.findById(userId);
        const channel = await Channel.findById(channelId);
        if (!user || !channel || channel.type !== 'voice') throw new Error('Canal de voz inválido');
        const role = await ServerModel.getMemberRole(channel.server_id, userId);
        if (!role) throw new Error('Usuário não participa do servidor');
        if (userChannels.get(userId) !== channelId) throw new Error('Usuário não está neste canal de voz');

        const peerId = `screen:${userId}`;
        const previousId = screenShareSockets.get(peerId);
        if (previousId && previousId !== socket.id) io.sockets.sockets.get(previousId)?.disconnect(true);

        socket.screenPeerId = peerId;
        socket.screenOwnerId = userId;
        socket.screenOwnerName = user.display_name || user.username;
        socket.screenChannelId = channelId;
        screenShareSockets.set(peerId, socket.id);
        socket.join(`channel-${channelId}`);

        const viewers = activeScreenViewers(channelId);
        socket.emit('native-screen-registered', {
          peerId,
          // Inclui o próprio transmissor para que o APK mostre uma prévia
          // real da tela no mosaico, além dos demais membros do canal.
          viewers
        });
        console.log(`📱 Tela nativa de ${socket.screenOwnerName} registrada no canal ${channelId} para ${viewers.length} visualizador(es)`);
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
        const targetSocketId = viewerSocketId(to);
        const targetSocket = targetSocketId && io.sockets.sockets.get(targetSocketId);
        if (!targetSocket?.userId || userChannels.get(targetSocket.userId) !== socket.screenChannelId) return;
        if (data?.sdp) console.log(`📡 Resposta ${data.sdp.type} de ${socket.screenPeerId} encaminhada para ${targetSocketId}`);
        io.to(targetSocketId).emit('voice-signal', { from: socket.screenPeerId, data });
      } catch (error) {
        console.error('❌ Erro na sinalização da tela nativa:', error);
      }
    });

    socket.on('native-screen-viewer-ready', ({ peerId }) => {
      try {
        const nativeSocketId = screenShareSockets.get(peerId);
        const nativeSocket = nativeSocketId && io.sockets.sockets.get(nativeSocketId);
        if (!socket.userId || !nativeSocket || userChannels.get(socket.userId) !== nativeSocket.screenChannelId) return;
        nativeSocket.emit('native-screen-viewer-joined', { userId: viewerPeerId(socket.id) });
      } catch (error) {
        console.error('❌ Erro ao preparar visualizador da tela nativa:', error);
      }
    });

    socket.on('native-screen-viewer-debug', ({ peerId, stage, detail }) => {
      try {
        const nativeSocketId = screenShareSockets.get(peerId);
        const nativeSocket = nativeSocketId && io.sockets.sockets.get(nativeSocketId);
        if (!socket.userId || !nativeSocket || userChannels.get(socket.userId) !== nativeSocket.screenChannelId) return;
        const safeStage = String(stage || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
        const safeDetail = String(detail || '').replace(/[\r\n]/g, ' ').slice(0, 160);
        console.log(`🔎 Tela ${peerId} · viewer ${socket.id} · ${safeStage}${safeDetail ? ` · ${safeDetail}` : ''}`);
      } catch (error) {
        console.error('❌ Erro no diagnóstico do visualizador nativo:', error);
      }
    });

    socket.on('native-screen-debug', ({ stage, detail }) => {
      if (!socket.screenPeerId) return;
      const safeStage = String(stage || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
      const safeDetail = String(detail || '').replace(/[\r\n]/g, ' ').slice(0, 160);
      console.log(`🔎 Tela ${socket.screenPeerId} · APK · ${safeStage}${safeDetail ? ` · ${safeDetail}` : ''}`);
    });

    socket.on('native-screen-audio', ({ data, sampleRate, channels, sequence }) => {
      try {
        if (!socket.screenPeerId || !socket.screenChannelId || typeof data !== 'string') return;
        // 40 ms de PCM mono/48 kHz gera ~5,1 KB em Base64. Limites abaixo
        // impedem que um cliente adulterado use o evento para pacotes grandes.
        const safeSampleRate = Number(sampleRate);
        if (data.length < 1 || data.length > 6_000 || ![32_000, 48_000].includes(safeSampleRate) || Number(channels) !== 1) return;
        const now = Date.now();
        if (!socket.screenAudioWindowAt || now - socket.screenAudioWindowAt >= 1_000) {
          socket.screenAudioWindowAt = now;
          socket.screenAudioWindowBytes = 0;
        }
        socket.screenAudioWindowBytes += data.length;
        if (socket.screenAudioWindowBytes > 150_000) return;

        const room = io.sockets.adapter.rooms.get(`channel-${socket.screenChannelId}`) || new Set();
        for (const viewerSocketId of room) {
          const viewer = io.sockets.sockets.get(viewerSocketId);
          if (!viewer?.userId || viewer.userId === socket.screenOwnerId) continue;
          if (userChannels.get(viewer.userId) !== socket.screenChannelId) continue;
          viewer.emit('native-screen-audio', {
            peerId: socket.screenPeerId,
            data,
            sampleRate: safeSampleRate,
            channels: 1,
            sequence: Number(sequence) || 0
          });
        }
      } catch (error) {
        console.error('❌ Erro ao encaminhar áudio da tela nativa:', error);
      }
    });

    // ========== ENTRAR NO CANAL DE TEXTO (necessário pro broadcast de mensagens) ==========
    socket.on('join-text-channel', async ({ channelId } = {}) => {
      try {
        const channel = await Channel.findById(channelId);
        if (!channel || channel.type !== 'text') return socket.emit('error', { message: 'Canal de texto não encontrado' });
        const role = await ServerModel.getMemberRole(channel.server_id, socket.userId);
        if (!role) return socket.emit('error', { message: 'Você não participa deste servidor' });
        if (socket.textChannel) socket.leave(`channel-${socket.textChannel}`);
        socket.textChannel = channelId;
        socket.join(`channel-${channelId}`);
      } catch (error) {
        console.error('❌ Erro ao entrar no canal de texto:', error?.message || error);
      }
    });

    // ========== MENSAGEM ==========
    socket.on('send-message', async ({ channelId, message, file }) => {
      try {
        const channel = await Channel.findById(channelId);
        if (!channel || channel.type !== 'text') {
          socket.emit('error', { message: 'Canal de texto não encontrado' });
          return;
        }
        const role = await ServerModel.getMemberRole(channel.server_id, socket.userId);
        if (!role) return socket.emit('error', { message: 'Você não participa deste servidor' });
        if (socket.textChannel !== channelId) return socket.emit('error', { message: 'Entre no canal antes de enviar mensagens' });
        const text = String(message || '').trim().slice(0, 2000);
        const safeFile = file ? sanitizeAttachment(file) : null;
        if (!text && !safeFile) return;

        const msgData = await Channel.saveMessage({
          channelId,
          userId: socket.userId,
          content: text,
          file: safeFile
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
      if (!channelId || socket.textChannel !== channelId) return;
      socket.to(`channel-${channelId}`).emit('user-typing', { channelId, userId: socket.userId, userName: socket.userName });
    });
    socket.on('typing-stop', ({ channelId }) => {
      if (!channelId || socket.textChannel !== channelId) return;
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

        const safeFile = file ? sanitizeAttachment(file) : null;
        const dm = await Dm.send({ senderId: socket.userId, recipientId: toUserId, content: text, file: safeFile });
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
        if (!channelId || userChannels.get(socket.userId) !== channelId) return;
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
        if (!channelId || userChannels.get(socket.userId) !== channelId) return;
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
            stopNativeScreenForOwner(userId, 'voice-disconnected');
            await Channel.leaveVoice(userId, channelId);
            const members = await Channel.getVoiceMembers(channelId);
            io.to(`channel-${channelId}`).emit('channel-members', members);
            io.to(`channel-${channelId}`).emit('user-left', {
              userId,
              userName: socket.userName || 'Usuário'
            });
            notifyScreenSharesViewerLeft(socket, channelId);
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
