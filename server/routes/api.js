const express = require('express');
const router = express.Router();
const Server = require('../database/models/Server');
const Channel = require('../database/models/Channel');
const User = require('../database/models/User');
const { queryOne } = require('../database');
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

// ========== SERVIDORES ==========

// Criar servidor
router.post('/servers', authenticate, async (req, res) => {
  try {
    const { name, icon } = req.body;
    const server = await Server.create({
      name: name || 'Servidor do Cat',
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

// Buscar servidor por código
router.get('/servers/code/:code', authenticate, async (req, res) => {
  try {
    const server = await Server.findByCode(req.params.code);
    if (!server) {
      return res.status(404).json({ error: 'Servidor não encontrado' });
    }
    res.json(server);
  } catch (error) {
    console.error('Erro ao buscar servidor por código:', error);
    res.status(500).json({ error: 'Erro ao buscar servidor' });
  }
});

// Entrar em servidor
router.post('/servers/:serverId/join', authenticate, async (req, res) => {
  try {
    await Server.addMember(req.params.serverId, req.user.id);

    // Avisa quem já está com a página do servidor aberta que um membro novo
    // chegou. Antes disso não existia: o array de membros do cliente só era
    // buscado uma vez (no load() inicial), então quem entrava depois nunca
    // aparecia pra quem já estava lá — e como o nome nas chamadas de voz
    // vem desse array local, esses membros novos caíam no fallback
    // genérico "Membro".
    const io = req.app.get('io');
    if (io) {
      const members = await Server.getMembers(req.params.serverId);
      const newMember = members.find(m => m.id === req.user.id);
      if (newMember) {
        io.to(`server-${req.params.serverId}`).emit('member-joined', newMember);
      }
    }

    res.json({ success: true });
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
    if (typeof bannerColor === 'string' || bannerColor === null) data.banner_color = bannerColor || null;
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
