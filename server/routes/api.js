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
