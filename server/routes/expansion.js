const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../database');
const { authenticate } = require('../middleware/auth');
const { sanitizePlainText, validateImageValue } = require('../security');

const router = express.Router();
router.use(authenticate);

const fail = (res, error, fallback) => res.status(error.status || 400).json({ error: error.message || fallback });
const requireServerMember = async (serverId, userId) => {
  const member = await queryOne('SELECT * FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, userId]);
  if (!member) throw Object.assign(new Error('Você não é membro deste servidor'), { status: 403 });
  return member;
};
const requireManage = async (serverId, userId) => {
  const member = await requireServerMember(serverId, userId);
  const role = String(member.role || '').toLowerCase();
  if (member.is_owner || ['owner', 'admin', 'administrator'].includes(role)) return member;
  const admin = await queryOne(`SELECT 1 FROM server_role_members rm JOIN server_roles r ON r.id=rm.role_id
    WHERE rm.server_id=$1 AND rm.user_id=$2 AND (r.name IN ('OWNER','ADMIN') OR COALESCE((r.permissions->>'administrator')::boolean,false)=true)`, [serverId, userId]);
  if (!admin) throw Object.assign(new Error('Sem permissão para gerenciar este servidor'), { status: 403 });
  return member;
};

function boundedJson(value, maxBytes, label) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw Object.assign(new Error(`${label} excede o limite permitido`), { status: 413 });
  }
  return json;
}

async function validateServerChannel(serverId, channelId, label) {
  if (!channelId) return null;
  const row = await queryOne('SELECT id FROM channels WHERE id=$1 AND server_id=$2', [channelId, serverId]);
  if (!row) throw Object.assign(new Error(`${label} não pertence a este servidor`), { status: 400 });
  return row.id;
}

async function requireModerationTarget(serverId, actorId, targetId) {
  if (!targetId || typeof targetId !== 'string') {
    throw Object.assign(new Error('Usuário alvo inválido'), { status: 400 });
  }
  if (targetId === actorId) {
    throw Object.assign(new Error('Você não pode aplicar moderação em si mesmo'), { status: 400 });
  }
  const [server, actor, target] = await Promise.all([
    queryOne('SELECT creator_id, owner_id FROM servers WHERE id=$1', [serverId]),
    queryOne('SELECT role,is_owner FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, actorId]),
    queryOne('SELECT role,is_owner FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, targetId])
  ]);
  if (!target) throw Object.assign(new Error('Membro alvo não pertence a este servidor'), { status: 404 });
  const actorIsOwner = Boolean(
    server && (server.creator_id === actorId || server.owner_id === actorId) ||
    actor?.is_owner ||
    String(actor?.role || '').toLowerCase() === 'owner'
  );
  const targetIsOwner = Boolean(
    server && (server.creator_id === targetId || server.owner_id === targetId) ||
    target.is_owner ||
    String(target.role || '').toLowerCase() === 'owner'
  );
  if (targetIsOwner && !actorIsOwner) {
    throw Object.assign(new Error('Somente o proprietário pode moderar outro proprietário'), { status: 403 });
  }
  return target;
}

// ===== SERVER PROFILE / SECURITY / COMMUNITY =====
router.get('/servers/:serverId/full', async (req, res) => {
  try {
    await requireServerMember(req.params.serverId, req.user.id);
    const server = await queryOne('SELECT * FROM servers WHERE id=$1', [req.params.serverId]);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    const [members, roles, categories, channels, security, community, onboarding, automod] = await Promise.all([
      query(`SELECT sm.*,u.username,u.display_name,u.avatar,u.banner,u.status,u.created_at AS account_created_at
        FROM server_members sm JOIN users u ON u.id=sm.user_id WHERE sm.server_id=$1 ORDER BY u.username`, [server.id]),
      query('SELECT * FROM server_roles WHERE server_id=$1 ORDER BY position DESC', [server.id]),
      query('SELECT * FROM channel_categories WHERE server_id=$1 ORDER BY position,id', [server.id]),
      query('SELECT * FROM channels WHERE server_id=$1 ORDER BY position,id', [server.id]),
      queryOne('SELECT * FROM server_security WHERE server_id=$1', [server.id]),
      queryOne('SELECT * FROM server_community WHERE server_id=$1', [server.id]),
      queryOne('SELECT * FROM onboarding_configs WHERE server_id=$1', [server.id]),
      queryOne('SELECT * FROM automod_configs WHERE server_id=$1', [server.id])
    ]);
    res.json({ server, members, roles, categories, channels, security, community, onboarding, automod });
  } catch (e) { fail(res, e, 'Erro ao carregar servidor'); }
});

router.patch('/servers/:serverId/profile', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const fields = [];
    const values = [];
    const add = (key, value) => {
      values.push(value);
      fields.push(`${key}=$${values.length}`);
    };

    if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
      const name = sanitizePlainText(req.body.name, 50);
      if (!name) return res.status(400).json({ error: 'Nome do servidor inválido' });
      add('name', name);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'description')) {
      add('description', sanitizePlainText(req.body.description, 300));
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'icon')) {
      add('icon', validateImageValue(req.body.icon, { allowShortText: true, maxLength: 700000 }));
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'banner')) {
      const raw = req.body.banner == null ? '' : String(req.body.banner).trim();
      add('banner', !raw ? null : validateImageValue(raw, { maxLength: 900000 }));
    }
    if (req.body.settings && typeof req.body.settings === 'object' && !Array.isArray(req.body.settings)) {
      add('settings', boundedJson(req.body.settings, 32768, 'Configurações do servidor'));
    }

    if (!fields.length) return res.status(400).json({ error: 'Nenhuma alteração informada' });
    values.push(req.params.serverId);
    const server = await queryOne(`UPDATE servers SET ${fields.join(', ')} WHERE id=$${values.length} RETURNING *`, values);
    res.json(server);
  } catch (e) { fail(res, e, 'Erro ao salvar perfil do servidor'); }
});

router.get('/servers/:serverId/security', async (req, res) => {
  try { await requireServerMember(req.params.serverId, req.user.id); res.json(await queryOne('SELECT * FROM server_security WHERE server_id=$1', [req.params.serverId]) || {}); }
  catch (e) { fail(res, e, 'Erro ao carregar segurança'); }
});
router.put('/servers/:serverId/security', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const s = await queryOne(`INSERT INTO server_security(server_id,verification_level,explicit_media_filter,raid_protection,two_factor_moderation)
      VALUES($1,COALESCE($2,'low'),COALESCE($3,false),COALESCE($4,false),COALESCE($5,false))
      ON CONFLICT(server_id) DO UPDATE SET verification_level=EXCLUDED.verification_level,
      explicit_media_filter=EXCLUDED.explicit_media_filter,raid_protection=EXCLUDED.raid_protection,
      two_factor_moderation=EXCLUDED.two_factor_moderation,updated_at=extract(epoch FROM now())::bigint RETURNING *`,
      [req.params.serverId, req.body.verificationLevel, req.body.explicitMediaFilter, req.body.raidProtection, req.body.twoFactorModeration]);
    res.json(s);
  } catch (e) { fail(res, e, 'Erro ao salvar segurança'); }
});

router.get('/servers/:serverId/community', async (req, res) => {
  try { await requireServerMember(req.params.serverId, req.user.id); res.json(await queryOne('SELECT * FROM server_community WHERE server_id=$1', [req.params.serverId]) || {}); }
  catch (e) { fail(res, e, 'Erro ao carregar comunidade'); }
});
router.put('/servers/:serverId/community', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const rulesChannelId = await validateServerChannel(req.params.serverId, req.body.rulesChannelId || null, 'Canal de regras');
    const updatesChannelId = await validateServerChannel(req.params.serverId, req.body.updatesChannelId || null, 'Canal de atualizações');
    const defaultNotifications = sanitizePlainText(req.body.defaultNotifications || 'all', 32) || 'all';
    const c = await queryOne(`INSERT INTO server_community(server_id,enabled,rules_channel_id,updates_channel_id,default_notifications)
      VALUES($1,COALESCE($2,false),$3,$4,COALESCE($5,'all'))
      ON CONFLICT(server_id) DO UPDATE SET enabled=EXCLUDED.enabled,rules_channel_id=EXCLUDED.rules_channel_id,
      updates_channel_id=EXCLUDED.updates_channel_id,default_notifications=EXCLUDED.default_notifications,
      updated_at=extract(epoch FROM now())::bigint RETURNING *`, [req.params.serverId, req.body.enabled, rulesChannelId, updatesChannelId, defaultNotifications]);
    res.json(c);
  } catch (e) { fail(res, e, 'Erro ao salvar comunidade'); }
});

// ===== INVITES =====
router.post('/servers/:serverId/invites', async (req, res) => {
  try {
    await requireServerMember(req.params.serverId, req.user.id);
    let code = String(req.body.code || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    if (!code) code = uuidv4().replace(/-/g, '').slice(0, 10);
    const invite = await queryOne(`INSERT INTO server_invites(code,server_id,channel_id,creator_id,max_uses,expires_at)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [code, req.params.serverId, req.body.channelId || null, req.user.id,
      req.body.maxUses ? Number(req.body.maxUses) : null, req.body.expiresAt ? Number(req.body.expiresAt) : null]);
    res.json(invite);
  } catch (e) { fail(res, e, 'Erro ao criar convite'); }
});
router.get('/servers/:serverId/invites', async (req, res) => {
  try { await requireManage(req.params.serverId, req.user.id); res.json(await query('SELECT * FROM server_invites WHERE server_id=$1 ORDER BY created_at DESC', [req.params.serverId])); }
  catch (e) { fail(res, e, 'Erro ao listar convites'); }
});
router.post('/invites/:code/use', async (req, res) => {
  try {
    const invite = await queryOne(`
      WITH candidate AS (
        SELECT code, server_id
        FROM server_invites
        WHERE code=$1
          AND status='active'
          AND (expires_at IS NULL OR expires_at > extract(epoch FROM now())::bigint)
          AND (max_uses IS NULL OR uses < max_uses)
        FOR UPDATE
      ),
      joined AS (
        INSERT INTO server_members(server_id,user_id,role)
        SELECT server_id,$2,'member' FROM candidate
        ON CONFLICT (server_id,user_id) DO NOTHING
        RETURNING server_id
      )
      UPDATE server_invites si
      SET uses=si.uses+1
      FROM joined
      WHERE si.code=$1 AND si.server_id=joined.server_id
      RETURNING si.*
    `, [req.params.code, req.user.id]);

    if (invite) return res.json(invite);

    const existing = await queryOne(`
      SELECT si.*
      FROM server_invites si
      JOIN server_members sm ON sm.server_id=si.server_id AND sm.user_id=$2
      WHERE si.code=$1
        AND si.status='active'
        AND (si.expires_at IS NULL OR si.expires_at > extract(epoch FROM now())::bigint)
    `, [req.params.code, req.user.id]);
    if (existing) return res.json({ ...existing, alreadyMember: true });

    return res.status(404).json({ error: 'Convite inválido, expirado ou esgotado' });
  } catch (e) { fail(res, e, 'Erro ao usar convite'); }
});
router.delete('/invites/:code', async (req, res) => {
  try {
    const invite = await queryOne('SELECT * FROM server_invites WHERE code=$1', [req.params.code]);
    if (!invite) return res.status(404).json({ error: 'Convite não encontrado' });
    await requireManage(invite.server_id, req.user.id);
    await query("UPDATE server_invites SET status='revoked' WHERE code=$1", [req.params.code]);
    res.json({ success: true });
  } catch (e) { fail(res, e, 'Erro ao revogar convite'); }
});

// ===== EMOJIS / STICKERS =====
router.get('/servers/:serverId/emojis', async (req, res) => {
  try { await requireServerMember(req.params.serverId, req.user.id); res.json(await query('SELECT * FROM server_emojis WHERE server_id=$1 ORDER BY name', [req.params.serverId])); }
  catch (e) { fail(res, e, 'Erro ao listar emojis'); }
});
router.post('/servers/:serverId/emojis', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const name = sanitizePlainText(req.body.name || 'emoji', 32);
    const image = validateImageValue(req.body.image, { maxLength: 200000 });
    if (!name || !image) return res.status(400).json({ error: 'Emoji inválido' });
    const e = await queryOne(`INSERT INTO server_emojis(id,server_id,name,image,animated) VALUES($1,$2,$3,$4,$5) RETURNING *`, [uuidv4(),req.params.serverId,name,image,!!req.body.animated]);
    res.json(e);
  }
  catch (e) { fail(res, e, 'Erro ao criar emoji'); }
});
router.delete('/servers/:serverId/emojis/:emojiId', async (req, res) => {
  try { await requireManage(req.params.serverId, req.user.id); await query('DELETE FROM server_emojis WHERE id=$1 AND server_id=$2',[req.params.emojiId,req.params.serverId]); res.json({success:true}); }
  catch(e){fail(res,e,'Erro ao excluir emoji');}
});
router.get('/servers/:serverId/stickers', async (req, res) => {
  try { await requireServerMember(req.params.serverId, req.user.id); res.json(await query('SELECT * FROM server_stickers WHERE server_id=$1 ORDER BY name',[req.params.serverId])); }
  catch(e){fail(res,e,'Erro ao listar stickers');}
});
router.post('/servers/:serverId/stickers', async (req,res)=>{
  try{
    await requireManage(req.params.serverId,req.user.id);
    const name=sanitizePlainText(req.body.name||'sticker',32);
    const description=sanitizePlainText(req.body.description||'',200);
    const image=validateImageValue(req.body.image,{maxLength:200000});
    if(!name||!image)return res.status(400).json({error:'Sticker inválido'});
    const s=await queryOne(`INSERT INTO server_stickers(id,server_id,name,description,image) VALUES($1,$2,$3,$4,$5) RETURNING *`,[uuidv4(),req.params.serverId,name,description,image]);
    res.json(s);
  }catch(e){fail(res,e,'Erro ao criar sticker');}
});

// ===== MODERATION / AUDIT =====
router.get('/servers/:serverId/moderation', async (req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await query(`SELECT m.*,u.username,m2.username AS moderator_username FROM moderation_actions m JOIN users u ON u.id=m.user_id JOIN users m2 ON m2.id=m.moderator_id WHERE m.server_id=$1 ORDER BY m.started_at DESC`,[req.params.serverId]));}catch(e){fail(res,e,'Erro ao carregar moderação');}});
router.post('/servers/:serverId/moderation', async(req,res)=>{
  try{await requireManage(req.params.serverId,req.user.id);await requireModerationTarget(req.params.serverId,req.user.id,req.body.userId);const action=String(req.body.action||'warning');if(!['warning','kick','ban','timeout'].includes(action))return res.status(400).json({error:'Ação inválida'});const row=await queryOne(`INSERT INTO moderation_actions(id,server_id,user_id,moderator_id,action,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[uuidv4(),req.params.serverId,req.body.userId,req.user.id,action,sanitizePlainText(req.body.reason||'',1000),req.body.expiresAt?Number(req.body.expiresAt):null]);await query(`INSERT INTO audit_logs(id,server_id,actor_id,action,target_type,target_id,reason,changes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[uuidv4(),req.params.serverId,req.user.id,`moderation.${action}`,'user',req.body.userId,row.reason,JSON.stringify(row)]);res.json(row);}catch(e){fail(res,e,'Erro ao executar moderação');}
});
router.get('/servers/:serverId/audit-log',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await query(`SELECT a.*,u.username AS actor_username FROM audit_logs a JOIN users u ON u.id=a.actor_id WHERE a.server_id=$1 ORDER BY a.created_at DESC LIMIT 500`,[req.params.serverId]));}catch(e){fail(res,e,'Erro ao carregar audit log');}});

// ===== ONBOARDING / AUTOMOD =====
router.get('/servers/:serverId/onboarding',async(req,res)=>{try{await requireServerMember(req.params.serverId,req.user.id);res.json(await queryOne('SELECT * FROM onboarding_configs WHERE server_id=$1',[req.params.serverId])||{});}catch(e){fail(res,e,'Erro ao carregar onboarding');}});
router.put('/servers/:serverId/onboarding',async(req,res)=>{try{
  await requireManage(req.params.serverId,req.user.id);
  const questions=Array.isArray(req.body.questions)?req.body.questions.slice(0,25):[];
  const defaultRoles=[...new Set((Array.isArray(req.body.defaultRoles)?req.body.defaultRoles:[]).filter(id=>typeof id==='string').slice(0,25))];
  const defaultChannels=[...new Set((Array.isArray(req.body.defaultChannels)?req.body.defaultChannels:[]).filter(id=>typeof id==='string').slice(0,25))];
  const [roles,channels]=await Promise.all([
    defaultRoles.length?query('SELECT id FROM server_roles WHERE server_id=$1 AND id = ANY($2::text[])',[req.params.serverId,defaultRoles]):Promise.resolve([]),
    defaultChannels.length?query('SELECT id FROM channels WHERE server_id=$1 AND id = ANY($2::text[])',[req.params.serverId,defaultChannels]):Promise.resolve([])
  ]);
  if(roles.length!==defaultRoles.length||channels.length!==defaultChannels.length)return res.status(400).json({error:'Onboarding contém referência de outro servidor ou inexistente'});
  const welcomeText=sanitizePlainText(req.body.welcomeText||'',1500)||null;
  const row=await queryOne(`INSERT INTO onboarding_configs(server_id,enabled,welcome_text,questions,default_roles,default_channels) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(server_id) DO UPDATE SET enabled=EXCLUDED.enabled,welcome_text=EXCLUDED.welcome_text,questions=EXCLUDED.questions,default_roles=EXCLUDED.default_roles,default_channels=EXCLUDED.default_channels,updated_at=extract(epoch FROM now())::bigint RETURNING *`,[req.params.serverId,!!req.body.enabled,welcomeText,boundedJson(questions,32768,'Perguntas do onboarding'),boundedJson(defaultRoles,8192,'Cargos padrão'),boundedJson(defaultChannels,8192,'Canais padrão')]);
  res.json(row);
}catch(e){fail(res,e,'Erro ao salvar onboarding');}});
router.get('/servers/:serverId/automod',async(req,res)=>{try{await requireServerMember(req.params.serverId,req.user.id);res.json(await queryOne('SELECT * FROM automod_configs WHERE server_id=$1',[req.params.serverId])||{});}catch(e){fail(res,e,'Erro ao carregar automod');}});
router.put('/servers/:serverId/automod',async(req,res)=>{try{
  await requireManage(req.params.serverId,req.user.id);
  const rules=req.body.rules&&typeof req.body.rules==='object'&&!Array.isArray(req.body.rules)?req.body.rules:{};
  const actions=req.body.actions&&typeof req.body.actions==='object'&&!Array.isArray(req.body.actions)?req.body.actions:{};
  const keywords=(Array.isArray(req.body.keywords)?req.body.keywords:[]).slice(0,200).map(v=>sanitizePlainText(v,80)).filter(Boolean);
  const row=await queryOne(`INSERT INTO automod_configs(server_id,enabled,rules,keywords,actions) VALUES($1,$2,$3,$4,$5) ON CONFLICT(server_id) DO UPDATE SET enabled=EXCLUDED.enabled,rules=EXCLUDED.rules,keywords=EXCLUDED.keywords,actions=EXCLUDED.actions,updated_at=extract(epoch FROM now())::bigint RETURNING *`,[req.params.serverId,!!req.body.enabled,boundedJson(rules,32768,'Regras do automod'),boundedJson(keywords,32768,'Palavras do automod'),boundedJson(actions,32768,'Ações do automod')]);
  res.json(row);
}catch(e){fail(res,e,'Erro ao salvar automod');}});

// ===== GLOBAL SEARCH =====
router.get('/search',async(req,res)=>{
  try{
    const q=String(req.query.q||'').trim();
    if(q.length<2)return res.json({users:[],servers:[],channels:[],messages:[],threads:[],posts:[],events:[]});
    const like=`%${q.replace(/[%_]/g,'\\$&')}%`;
    const uid=req.user.id;
    const [users,servers,channels,messages,threads,posts,events]=await Promise.all([
      query(`
        SELECT DISTINCT u.id,u.username,u.display_name,u.avatar,u.status
        FROM users u
        WHERE (u.username ILIKE $1 OR u.display_name ILIKE $1)
          AND (
            u.id=$2 OR EXISTS (
              SELECT 1
              FROM server_members mine
              JOIN server_members shared ON shared.server_id=mine.server_id
              WHERE mine.user_id=$2 AND shared.user_id=u.id
            )
          )
        ORDER BY u.username
        LIMIT 25
      `,[like,uid]),
      query(`
        SELECT s.id,s.name,s.icon,s.banner,s.description
        FROM servers s
        JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$2
        WHERE s.name ILIKE $1 OR s.description ILIKE $1
        LIMIT 25
      `,[like,uid]),
      query(`
        SELECT c.id,c.server_id,c.name,c.type,c.topic
        FROM channels c
        JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=$2
        WHERE c.name ILIKE $1 OR c.topic ILIKE $1
        LIMIT 50
      `,[like,uid]),
      query(`
        SELECT m.id,m.channel_id,m.user_id AS author_id,m.content,m.created_at
        FROM messages m
        JOIN channels c ON c.id=m.channel_id
        JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=$2
        WHERE m.deleted_at IS NULL AND m.content ILIKE $1
        ORDER BY m.created_at DESC
        LIMIT 50
      `,[like,uid]),
      query(`
        SELECT t.id,t.channel_id,t.name,t.creator_id,t.created_at
        FROM threads t
        JOIN channels c ON c.id=t.channel_id
        JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=$2
        WHERE t.name ILIKE $1
        LIMIT 25
      `,[like,uid]),
      query(`
        SELECT p.id,p.channel_id,p.author_id,p.title,p.content,p.created_at
        FROM forum_posts p
        JOIN channels c ON c.id=p.channel_id
        JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=$2
        WHERE p.title ILIKE $1 OR p.content ILIKE $1
        LIMIT 25
      `,[like,uid]),
      query(`
        SELECT e.id,e.server_id,e.name,e.description,e.start_at,e.status
        FROM server_events e
        JOIN server_members sm ON sm.server_id=e.server_id AND sm.user_id=$2
        WHERE e.name ILIKE $1 OR e.description ILIKE $1
        LIMIT 25
      `,[like,uid])
    ]);
    res.json({users,servers,channels,messages,threads,posts,events});
  }catch(e){fail(res,e,'Erro na pesquisa');}
});

// ===== MEMBER DETAILS =====
router.get('/servers/:serverId/members/:userId',async(req,res)=>{try{await requireServerMember(req.params.serverId,req.user.id);const row=await queryOne(`SELECT sm.*,u.id,u.username,u.display_name,u.avatar,u.banner,u.bio,u.status,u.activities,u.badges,u.created_at AS account_created_at FROM server_members sm JOIN users u ON u.id=sm.user_id WHERE sm.server_id=$1 AND sm.user_id=$2`,[req.params.serverId,req.params.userId]);if(!row)return res.status(404).json({error:'Membro não encontrado'});row.roles=await query(`SELECT r.* FROM server_roles r JOIN server_role_members rm ON rm.role_id=r.id WHERE rm.server_id=$1 AND rm.user_id=$2 ORDER BY r.position DESC`,[req.params.serverId,req.params.userId]);res.json(row);}catch(e){fail(res,e,'Erro ao carregar membro');}});

module.exports = router;
