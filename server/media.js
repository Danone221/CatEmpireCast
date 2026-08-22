const config = require('./config');
const Channel = require('./database/models/Channel');

const activeCasts = new Map();

function isActive(channelId) {
  return activeCasts.has(channelId);
}

function getActiveCastInfo(channelId) {
  if (!activeCasts.has(channelId)) return null;
  return { playbackUrl: buildPlaybackUrl(channelId) };
}

function isConfigured() {
  return !!(config.media.publicRtmpHost && config.media.publicHttpBase);
}

function buildRtmpUrl() {
  if (!config.media.publicRtmpHost) return null;
  const host = config.media.publicRtmpHost;
  return `${host.replace(/\/$/, '')}/live`;
}

function buildPlaybackUrl(channelId) {
  if (!config.media.publicHttpBase) return null;
  const base = config.media.publicHttpBase;
  return `${base.replace(/\/$/, '')}/live/${channelId}.flv`;
}

function getCastCredentials(channelId) {
  const configured = isConfigured();
  return {
    rtmpUrl: configured ? buildRtmpUrl() : null,
    streamKey: configured ? channelId : null,
    playbackUrl: configured ? buildPlaybackUrl(channelId) : null,
    configured,
    error: configured ? null : 'Servidor RTMP não configurado. Defina MEDIA_PUBLIC_RTMP_HOST e MEDIA_PUBLIC_HTTP_BASE.'
  };
}

function startMediaServer(io) {
  if (!config.media.enabled) {
    console.log('📱 Servidor de mídia (RTMP p/ cast externo) desligado (MEDIA_SERVER_ENABLED != true).');
    return null;
  }

  let NodeMediaServer;
  try {
    NodeMediaServer = require('node-media-server');
  } catch (e) {
    console.error('❌ node-media-server não instalado. Rode "npm install" novamente.');
    return null;
  }

  const nms = new NodeMediaServer({
    rtmp: { port: config.media.rtmpPort, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
    http: { port: config.media.httpPort, allow_origin: '*', mediaroot: './media' },
    logType: 1
  });

  nms.on('prePublish', async (id, StreamPath) => {
    const channelId = StreamPath.split('/').pop();
    try {
      const channel = await Channel.findById(channelId);
      if (!channel || channel.type !== 'voice') {
        const session = nms.getSession(id);
        session.reject();
        return;
      }
      activeCasts.set(channelId, { sessionId: id });
      io.to(`channel-${channelId}`).emit('external-cast-live', { channelId, playbackUrl: buildPlaybackUrl(channelId) });
    } catch (e) {
      console.error('❌ Erro ao validar publish do cast externo:', e);
      const session = nms.getSession(id);
      session.reject();
    }
  });

  nms.on('donePublish', (id, StreamPath) => {
    const channelId = StreamPath.split('/').pop();
    activeCasts.delete(channelId);
    io.to(`channel-${channelId}`).emit('external-cast-ended', { channelId });
  });

  nms.run();
  console.log(`📱 Cast externo: RTMP em rtmp://<host>:${config.media.rtmpPort}/live/<chave>`);
  console.log(`📱 Cast externo: HTTP-FLV em http://<host>:${config.media.httpPort}/live/<chave>.flv`);
  return nms;
}

module.exports = { startMediaServer, getCastCredentials, isActive, getActiveCastInfo };
