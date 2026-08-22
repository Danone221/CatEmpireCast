const express = require('express');
const router = express.Router();
const Server = require('../database/models/Server');
const Channel = require('../database/models/Channel');
const User = require('../database/models/User');
const Invite = require('../database/models/Invite');
const { query, queryOne } = require('../database');
const { authenticate } = require('../middleware/auth');

// Endpoint público usado pela tela inicial.
router.get('/servers/active', async (req, res) => {
  try {
    const row = await queryOne('SELECT COUNT(*) AS count FROM servers');
    res.json({ count: parseInt(row.count, 10) });
  } catch (error) {
    console.error('Erro ao contar servidores:', error);
    res.status(500).json({ error: 'Erro ao contar servidores' });
  }
});

// ========== PERFIL DO USUÁRIO ==========

// Dados completos do usuário logado (pra pré-preencher o modal de edição)
router.get('/me', authenticate, async (req, res) => {
  res.json(req.user);
});

// Editar meu perfil: nome de exibição, avatar, bio, cor do banner
router.put('/me/profile', authenticate, async (req, res) => {
  try {
    const { displayName, avatar, bio, bannerColor } = req.body;
    const data = {};
    if (typeof displayName === 'string') {
      const trimmed = displayName.trim().slice(0, 32);
      if (trimmed) data.display_name = trimmed;
    }
    if (typeof bio === 'string') data.bio = bio.slice(0, 190);
    if (typeof bannerColor === 'string' || bannerColor === null) data.banner_color = bannerColor || null;
    if (typeof avatar === 'string') {
      // Base64 data URL — limite de ~500KB pra não pesar no banco.
      if (avatar.length > 700000) {
        return res.status(400).json({ error: 'Imagem muito grande (máx. ~500KB).' });
      }
      data.avatar = avatar;
    }
    const user = await User.update(req.user.id, data);

    // Propaga em tempo real pra quem estiver com a página aberta em
    // qualquer servidor que essa pessoa participa — sem isso, nomes e
    // avatares atualizados só apareceriam pros outros membros depois de
    // um refresh manual da página.
    const io = req.app.get('io');
    if (io) {
      const servers = await User.getServers(req.user.id);
      const publicUser = await User.getPublicProfile(req.user.id);
      for (const s of servers) {
        io.to(`server-${s.id}`).emit('member-profile-updated', publicUser);
      }
    }

    res.json(user);
  } catch (error) {
    console.error('Erro ao editar perfil:', error);
    res.status(500).json({ error: 'Erro ao editar perfil' });
  }
});

// Alterar senha da conta
router.put('/me/password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'A nova senha deve ter no mínimo 4 caracteres.' });
    }
    await User.updatePassword(req.user.id, currentPassword, newPassword);
    res.json({ success: true, message: 'Senha atualizada com sucesso!' });
  } catch (error) {
    console.error('Erro ao atualizar senha:', error);
    res.status(400).json({ error: error.message || 'Erro ao alterar senha' });
  }
});

// Ver o perfil público de outra pessoa — só liberado pra quem divide
// pelo menos um servidor com ela (evita expor perfis pra estranhos).
router.get('/users/:userId/profile', authenticate, async (req, res) => {
  try {
    if (req.params.userId === req.user.id) {
      return res.json(await User.getPublicProfile(req.user.id));
    }
    const myServers = await User.getServers(req.user.id);
    let sharesServer = false;
    for (const s of myServers) {
      const role = await Server.getMemberRole(s.id, req.params.userId);
      if (role) { sharesServer = true; break; }
    }
    if (!sharesServer) {
      return res.status(403).json({ error: 'Você não divide nenhum servidor com esse usuário' });
    }
    const profile = await User.getPublicProfile(req.params.userId);
    if (!profile) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(profile);
  } catch (error) {
    console.error('Erro ao buscar perfil:', error);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// ========== MENSAGENS PRIVADAS (DM) ==========
const Dm = require('../database/models/Dm');

// Lista de conversas — pra montar a lista lateral da aba de DMs.
router.get('/dms', authenticate, async (req, res) => {
  try {
    const conversations = await Dm.getConversations(req.user.id);
    res.json(conversations);
  } catch (error) {
    console.error('Erro ao listar DMs:', error);
    res.status(500).json({ error: 'Erro ao listar mensagens privadas' });
  }
});

// Total de DMs não lidas — pro badge no ícone que abre a aba de DMs.
router.get('/dms/unread-count', authenticate, async (req, res) => {
  try {
    const count = await Dm.getUnreadTotal(req.user.id);
    res.json({ count });
  } catch (error) {
    console.error('Erro ao contar DMs não lidas:', error);
    res.status(500).json({ error: 'Erro ao contar mensagens não lidas' });
  }
});

// Histórico de conversa com uma pessoa específica. Marca como lidas as
// mensagens dela pra mim como efeito colateral de abrir a conversa.
router.get('/dms/:userId', authenticate, async (req, res) => {
  try {
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'Não é possível enviar DM pra você mesmo' });
    }
    const otherUser = await User.getPublicProfile(req.params.userId);
    if (!otherUser) return res.status(404).json({ error: 'Usuário não encontrado' });
    const messages = await Dm.getMessages(req.user.id, req.params.userId);
    const blockState = await queryOne(`
      SELECT EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2) AS blocked_by_me,
             EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=$2 AND blocked_id=$1) AS blocked_me`,
      [req.user.id, req.params.userId]);
    await Dm.markRead(req.user.id, req.params.userId);
    res.json({ user: otherUser, messages, blockState });
  } catch (error) {
    console.error('Erro ao carregar conversa:', error);
    res.status(500).json({ error: 'Erro ao carregar conversa' });
  }
});

// ========== SERVIDORES ==========

// Criar servidor
router.post('/servers', authenticate, async (req, res) => {
  try {
    const { name, icon } = req.body;
    const cleanName = String(name || 'Servidor do Cat').trim().slice(0, 50);
    const server = await Server.create({
      name: cleanName || 'Servidor do Cat',
      icon: icon || '🐱',
      creatorId: req.user.id
    });
    res.json(server);
  } catch (error) {
    console.error('Erro ao criar servidor:', error);
    res.status(500).json({ error: 'Erro ao criar servidor' });
  }
});

// Listar servidores do usuário
router.get('/servers', authenticate, async (req, res) => {
  try {
    const servers = await Server.findByUser(req.user.id);
    res.json(servers);
  } catch (error) {
    console.error('Erro ao listar servidores:', error);
    res.status(500).json({ error: 'Erro ao listar servidores' });
  }
});

// Buscar servidor por ID
router.get('/servers/:serverId', authenticate, async (req, res) => {
  try {
    const server = await Server.findById(req.params.serverId);
    if (!server) {
      return res.status(404).json({ error: 'Servidor não encontrado' });
    }
    const channels = await Server.getChannels(req.params.serverId);
    const members = await Server.getMembers(req.params.serverId);
    const myRole = await Server.getMemberRole(req.params.serverId, req.user.id);
    res.json({ ...server, channels, members, myRole });
  } catch (error) {
    console.error('Erro ao buscar servidor:', error);
    res.status(500).json({ error: 'Erro ao buscar servidor' });
  }
});

router.delete('/servers/:serverId/members/me', authenticate, async (req, res) => {
  try {
    const server = await Server.findById(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    if (server.creator_id === req.user.id) return res.status(400).json({ error: 'O dono não pode sair do servidor. Transfira ou exclua o servidor.' });
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (!role) return res.status(404).json({ error: 'Você não participa deste servidor' });
    await query('DELETE FROM server_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.user.id]);
    res.json({ success:true });
  } catch (error) {
    console.error('Erro ao sair do servidor:', error);
    res.status(500).json({ error: 'Erro ao sair do servidor' });
  }
});

// ========== CONVITES DE SERVIDOR ==========

// Criar convite para o servidor
router.post('/servers/:serverId/invites', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (!role) {
      return res.status(403).json({ error: 'Você precisa ser membro do servidor para gerar convites' });
    }
    const { maxUses, expiresInHours } = req.body || {};
    const invite = await Invite.create({
      serverId: req.params.serverId,
      creatorId: req.user.id,
      maxUses: maxUses ? parseInt(maxUses, 10) : null,
      expiresInHours: expiresInHours ? parseInt(expiresInHours, 10) : null
    });
    res.json(invite);
  } catch (error) {
    console.error('Erro ao criar convite:', error);
    res.status(500).json({ error: 'Erro ao criar convite' });
  }
});

// Listar convites do servidor (somente ADMIN)
router.get('/servers/:serverId/invites', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem visualizar todos os convites' });
    }
    const invites = await Invite.listByServer(req.params.serverId);
    res.json(invites);
  } catch (error) {
    console.error('Erro ao listar convites:', error);
    res.status(500).json({ error: 'Erro ao listar convites' });
  }
});

// Revogar convite
router.delete('/servers/:serverId/invites/:code', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    const invite = await Invite.findByCode(req.params.code);
    if (!invite) return res.status(404).json({ error: 'Convite não encontrado' });
    const isCreator = invite.creator_id === req.user.id;
    if (role !== 'admin' && !isCreator) {
      return res.status(403).json({ error: 'Você não tem permissão para revogar este convite' });
    }
    await Invite.revoke(req.params.code, req.params.serverId);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao revogar convite:', error);
    res.status(500).json({ error: 'Erro ao revogar convite' });
  }
});

// Prévia pública de convite
router.get('/invites/:code', async (req, res) => {
  try {
    const invite = await Invite.findByCode(req.params.code);
    if (!invite) {
      return res.status(404).json({ error: 'Convite inválido ou expirado' });
    }
    if (invite.expired) {
      return res.status(410).json({ error: 'Este convite expirou' });
    }
    if (invite.maxUsesReached) {
      return res.status(410).json({ error: 'Este convite atingiu o limite de usos' });
    }

    let isMember = false;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const config = require('../config');
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, config.jwtSecret);
        if (decoded && decoded.id) {
          const role = await Server.getMemberRole(invite.server_id, decoded.id);
          isMember = !!role;
        }
      } catch (e) {}
    }

    res.json({
      code: invite.code,
      serverId: invite.server_id,
      serverName: invite.server_name,
      serverIcon: invite.server_icon,
      serverBannerColor: invite.server_banner_color,
      serverDescription: invite.server_description,
      memberCount: parseInt(invite.member_count, 10) || 1,
      creatorName: invite.creator_name,
      expiresAt: invite.expires_at,
      uses: invite.uses,
      maxUses: invite.max_uses,
      isMember
    });
  } catch (error) {
    console.error('Erro ao buscar prévia de convite:', error);
    res.status(500).json({ error: 'Erro ao buscar dados do convite' });
  }
});

// Entrar em servidor usando convite
router.post('/invites/:code/join', authenticate, async (req, res) => {
  try {
    const invite = await Invite.findByCode(req.params.code);
    if (!invite) {
      return res.status(404).json({ error: 'Convite inválido ou inexistente' });
    }
    if (invite.expired) {
      return res.status(410).json({ error: 'Este convite expirou' });
    }
    if (invite.maxUsesReached) {
      return res.status(410).json({ error: 'Este convite atingiu o limite de usos' });
    }

    await Server.addMember(invite.server_id, req.user.id);
    await Invite.use(invite.code);

    // Avisa quem já está com o servidor aberto
    const io = req.app.get('io');
    if (io) {
      const members = await Server.getMembers(invite.server_id);
      const newMember = members.find(m => m.id === req.user.id);
      if (newMember) {
        io.to(`server-${invite.server_id}`).emit('member-joined', newMember);
      }
    }

    res.json({ success: true, serverId: invite.server_id });
  } catch (error) {
    console.error('Erro ao entrar via convite:', error);
    res.status(500).json({ error: 'Erro ao entrar no servidor' });
  }
});

// Entrar em servidor direto (se já tiver permissão)
router.post('/servers/:serverId/join', authenticate, async (req, res) => {
  try {
    await Server.addMember(req.params.serverId, req.user.id);

    const io = req.app.get('io');
    if (io) {
      const members = await Server.getMembers(req.params.serverId);
      const newMember = members.find(m => m.id === req.user.id);
      if (newMember) {
        io.to(`server-${req.params.serverId}`).emit('member-joined', newMember);
      }
    }

    res.json({ success: true, serverId: req.params.serverId });
  } catch (error) {
    console.error('Erro ao entrar no servidor:', error);
    res.status(500).json({ error: 'Erro ao entrar no servidor' });
  }
});

// Editar servidor (somente ADMIN): nome, ícone, cor do banner, descrição
router.put('/servers/:serverId', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem editar o servidor' });
    }
    const { name, icon, bannerColor, description } = req.body;
    const data = {};
    if (typeof name === 'string') {
      const trimmed = name.trim().slice(0, 40);
      if (trimmed) data.name = trimmed;
    }
    if (typeof icon === 'string') {
      // Emoji curto OU imagem (data URL/URL) — limite generoso só pra
      // barrar payloads absurdos, a validação de tipo fica pro cliente.
      if (icon.length > 700000) {
        return res.status(400).json({ error: 'Ícone muito grande (máx. ~500KB).' });
      }
      data.icon = icon;
    }
    if (typeof bannerColor === 'string' || bannerColor === null) {
      if (typeof bannerColor === 'string' && bannerColor.length > 700000) {
        return res.status(400).json({ error: 'Banner muito grande (máx. ~500KB).' });
      }
      data.banner_color = bannerColor || null;
    }
    if (typeof description === 'string') data.description = description.slice(0, 300);

    const server = await Server.update(req.params.serverId, data);

    const io = req.app.get('io');
    if (io) io.to(`server-${req.params.serverId}`).emit('server-updated', server);

    res.json(server);
  } catch (error) {
    console.error('Erro ao editar servidor:', error);
    res.status(500).json({ error: 'Erro ao editar servidor' });
  }
});

// Alterar cargo de membro do servidor (somente ADMIN)
router.put('/servers/:serverId/members/:memberId/role', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem gerenciar cargos' });
    }
    const server = await Server.findById(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    if (server.creator_id === req.params.memberId && req.body.role !== 'admin') {
      return res.status(400).json({ error: 'O criador do servidor não pode ter o cargo de administrador removido' });
    }
    const newRole = req.body.role === 'admin' ? 'admin' : 'member';
    await Server.updateMemberRole(req.params.serverId, req.params.memberId, newRole);

    const io = req.app.get('io');
    if (io) {
      io.to(`server-${req.params.serverId}`).emit('member-role-updated', {
        userId: req.params.memberId,
        role: newRole
      });
    }

    res.json({ success: true, role: newRole });
  } catch (error) {
    console.error('Erro ao alterar cargo:', error);
    res.status(500).json({ error: 'Erro ao alterar cargo' });
  }
});

// Expulsar membro ou sair do servidor
router.delete('/servers/:serverId/members/:memberId', authenticate, async (req, res) => {
  try {
    const isSelf = req.params.memberId === req.user.id || req.params.memberId === 'me';
    const targetUserId = isSelf ? req.user.id : req.params.memberId;

    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (!role) {
      return res.status(403).json({ error: 'Você não é membro deste servidor' });
    }
    if (!isSelf && role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem expulsar membros' });
    }
    const server = await Server.findById(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    if (server.creator_id === targetUserId) {
      return res.status(400).json({ error: isSelf ? 'O criador não pode sair do servidor (exclua o servidor se desejar)' : 'Você não pode expulsar o criador do servidor' });
    }

    await Server.removeMember(req.params.serverId, targetUserId);

    const io = req.app.get('io');
    if (io) {
      io.to(`server-${req.params.serverId}`).emit('member-kicked', {
        userId: targetUserId
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover membro:', error);
    res.status(500).json({ error: 'Erro ao remover membro' });
  }
});

// Excluir servidor permanentemente (somente o CRIADOR do servidor)
router.delete('/servers/:serverId', authenticate, async (req, res) => {
  try {
    const server = await Server.findById(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    if (server.creator_id !== req.user.id) {
      return res.status(403).json({ error: 'Apenas o criador do servidor pode excluí-lo' });
    }

    await Server.delete(req.params.serverId);

    const io = req.app.get('io');
    if (io) {
      io.to(`server-${req.params.serverId}`).emit('server-deleted', {
        serverId: req.params.serverId
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao excluir servidor:', error);
    res.status(500).json({ error: 'Erro ao excluir servidor' });
  }
});

// ========== CANAIS ==========

// Criar canal (somente ADMIN do servidor)
router.post('/servers/:serverId/channels', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem criar canais' });
    }
    const { name, type, category } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome do canal é obrigatório' });
    }
    const channel = await Channel.create({
      serverId: req.params.serverId,
      name: name.trim(),
      type: type === 'voice' ? 'voice' : 'text',
      category: category || (type === 'voice' ? 'CANAIS DE VOZ' : 'CANAIS')
    });
    res.json(channel);
  } catch (error) {
    console.error('Erro ao criar canal:', error);
    res.status(500).json({ error: 'Erro ao criar canal' });
  }
});

// Deletar canal (somente ADMIN do servidor)
router.delete('/servers/:serverId/channels/:channelId', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem excluir canais' });
    }
    await Channel.delete(req.params.channelId);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao excluir canal:', error);
    res.status(500).json({ error: 'Erro ao excluir canal' });
  }
});

// Buscar canal por ID
router.get('/channels/:channelId', authenticate, async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Canal não encontrado' });
    }
    res.json(channel);
  } catch (error) {
    console.error('Erro ao buscar canal:', error);
    res.status(500).json({ error: 'Erro ao buscar canal' });
  }
});

// Buscar mensagens do canal
router.get('/channels/:channelId/messages', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const messages = await Channel.getMessages(req.params.channelId, limit);
    res.json(messages);
  } catch (error) {
    console.error('Erro ao buscar mensagens:', error);
    res.status(500).json({ error: 'Erro ao buscar mensagens' });
  }
});

// Buscar membros no canal de voz
router.get('/channels/:channelId/voice', authenticate, async (req, res) => {
  try {
    const members = await Channel.getVoiceMembers(req.params.channelId);
    res.json(members);
  } catch (error) {
    console.error('Erro ao buscar membros de voz:', error);
    res.status(500).json({ error: 'Erro ao buscar membros de voz' });
  }
});

// Credenciais de RTMP pra transmitir a tela do celular (app externo tipo
// Larix Broadcaster) pro canal de voz — ver server/media.js.
router.get('/channels/:channelId/cast-credentials', authenticate, async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.channelId);
    if (!channel || channel.type !== 'voice') {
      return res.status(404).json({ error: 'Canal de voz não encontrado' });
    }
    const { getCastCredentials } = require('../media');
    res.json(getCastCredentials(channel.id));
  } catch (error) {
    console.error('Erro ao gerar credenciais de cast:', error);
    res.status(500).json({ error: 'Erro ao gerar credenciais de cast' });
  }
});

module.exports = router;
