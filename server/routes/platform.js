const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { query, queryOne } = require('../database');
const Server = require('../database/models/Server');
const User = require('../database/models/User');
const Role = require('../database/models/Role');
const { sanitizePlainText } = require('../security');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

async function memberRole(serverId, userId) {
  return Server.getMemberRole(serverId, userId);
}

async function requireMember(serverId, userId) {
  const role = await memberRole(serverId, userId);
  if (!role) throw Object.assign(new Error('Você não é membro deste servidor'), { status: 403 });
  return role;
}

async function requireManage(serverId, userId) {
  const server = await Server.findById(serverId);
  if (!server) throw Object.assign(new Error('Servidor não encontrado'), { status: 404 });
  if (server.creator_id === userId || server.owner_id === userId) return 100;
  const role = await memberRole(serverId, userId);
  if (role === 'owner') return 100;
  if (role === 'admin') return 90;
  throw Object.assign(new Error('Sem permissão para gerenciar este servidor'), { status: 403 });
}

function cleanPermissionMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, enabled] of Object.entries(value).slice(0, 64)) {
    if (!/^[a-z0-9_.:-]{1,64}$/i.test(key)) continue;
    out[key] = !!enabled;
  }
  return out;
}

function boundedJson(value, fallback, maxBytes = 32768) {
  const json = JSON.stringify(value == null ? fallback : value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw Object.assign(new Error('Configuração excede o limite permitido'), { status: 413 });
  }
  return json;
}

async function assertScopedReference(serverId, table, id) {
  if (!id) return null;
  const allowed = new Map([
    ['channel_categories', 'id'],
    ['channels', 'id'],
    ['server_roles', 'id'],
    ['server_members', 'user_id']
  ]);
  const column = allowed.get(table);
  if (!column) throw Object.assign(new Error('Referência inválida'), { status: 400 });
  const row = await queryOne(`SELECT 1 FROM ${table} WHERE server_id=$1 AND ${column}=$2 LIMIT 1`, [serverId, id]);
  if (!row) throw Object.assign(new Error('Referência não pertence a este servidor'), { status: 400 });
  return id;
}

async function audit(serverId, actorId, action, targetType, targetId, changes = {}, reason = null) {
  await query(`INSERT INTO audit_logs (id,server_id,actor_id,action,target_type,target_id,reason,changes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [uuidv4(), serverId, actorId, action, targetType, targetId, reason, JSON.stringify(changes)]);
}

function fail(res, e, fallback) {
  console.error(fallback, e);
  return res.status(e.status || 400).json({ error: e.message || fallback });
}

// ===== ROLES =====
router.get('/servers/:serverId/roles', async (req, res) => {
  try {
    await requireMember(req.params.serverId, req.user.id);
    const roles = await query(`SELECT r.*, COUNT(rm.user_id)::int AS member_count
      FROM server_roles r LEFT JOIN server_role_members rm ON rm.role_id=r.id
      WHERE r.server_id=$1 GROUP BY r.id ORDER BY r.position DESC`, [req.params.serverId]);
    res.json(roles);
  } catch (e) { fail(res, e, 'Erro ao listar cargos'); }
});

router.post('/servers/:serverId/roles', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const role = await Role.create(req.params.serverId, req.body || {});
    await audit(req.params.serverId, req.user.id, 'role.create', 'role', role.id, { name: role.name, position: role.position });
    res.status(201).json(role);
  } catch (e) { fail(res, e, 'Erro ao criar cargo'); }
});

router.put('/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    const level = await requireManage(req.params.serverId, req.user.id);
    const role = await Role.findById(req.params.serverId, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'Cargo não encontrado' });
    if (role.position >= level || ['owner','@everyone'].includes(String(role.name || '').trim().toLowerCase())) {
      return res.status(403).json({ error: 'Você não pode editar este cargo protegido ou acima da sua hierarquia' });
    }
    const next = { ...(req.body || {}) };
    if (next.position !== undefined && Number(next.position) >= level) next.position = level - 1;
    const updated = await Role.update(req.params.serverId, req.params.roleId, next);
    await audit(req.params.serverId, req.user.id, 'role.update', 'role', updated.id, {
      name: updated.name,
      position: updated.position,
      mentionable: updated.mentionable
    });
    res.json(updated);
  } catch (e) { fail(res, e, 'Erro ao editar cargo'); }
});

router.delete('/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    const level = await requireManage(req.params.serverId, req.user.id);
    const role = await Role.findById(req.params.serverId, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'Cargo não encontrado' });
    if (Number(role.position || 0) >= level || ['owner','@everyone'].includes(String(role.name || '').trim().toLowerCase())) {
      return res.status(403).json({ error: 'Você não pode excluir este cargo protegido ou acima da sua hierarquia' });
    }
    const result = await Role.remove(req.params.serverId, req.params.roleId);
    await audit(req.params.serverId, req.user.id, 'role.delete', 'role', role.id);
    res.json(result);
  } catch (e) { fail(res, e, 'Erro ao excluir cargo'); }
});

router.put('/servers/:serverId/members/:userId/roles', async (req, res) => {
  try {
    const level = await requireManage(req.params.serverId, req.user.id);
    const server = await queryOne('SELECT creator_id, owner_id FROM servers WHERE id=$1', [req.params.serverId]);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    const targetMember = await queryOne('SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.params.userId]);
    if (!targetMember) return res.status(404).json({ error: 'Usuário não é membro deste servidor' });

    const actorIsOwner = level >= 100;
    const targetIsOwner = server.creator_id === req.params.userId || server.owner_id === req.params.userId || String(targetMember.role || '').toLowerCase() === 'owner';
    if (targetIsOwner && !actorIsOwner) {
      return res.status(403).json({ error: 'Somente o proprietário pode alterar os próprios cargos' });
    }

    const roleIds = Array.isArray(req.body.roleIds)
      ? [...new Set(req.body.roleIds.filter(id => typeof id === 'string').slice(0, 50))]
      : [];

    const roles = roleIds.length
      ? await query('SELECT id,name,position FROM server_roles WHERE server_id=$1 AND id = ANY($2::text[])', [req.params.serverId, roleIds])
      : [];

    if (roles.length !== roleIds.length) {
      return res.status(400).json({ error: 'Um ou mais cargos são inválidos para este servidor' });
    }
    if (!actorIsOwner && roles.some(role =>
      String(role.name || '').toUpperCase() === 'OWNER' || Number(role.position || 0) >= level
    )) {
      return res.status(403).json({ error: 'Você não pode atribuir cargo acima ou igual à sua hierarquia' });
    }

    await query('DELETE FROM server_role_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.params.userId]);
    for (const role of roles) {
      await query(
        'INSERT INTO server_role_members(role_id,server_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [role.id, req.params.serverId, req.params.userId]
      );
    }
    await audit(req.params.serverId, req.user.id, 'member.roles.update', 'user', req.params.userId, { roleIds });
    res.json({ success: true, roleIds });
  } catch (e) { fail(res, e, 'Erro ao atualizar cargos do membro'); }
});

// ===== CATEGORIES / CHANNELS / PERMISSIONS =====
router.get('/servers/:serverId/structure', async (req, res) => {
  try {
    await requireMember(req.params.serverId, req.user.id);
    const [categories, channels, roles, overrides] = await Promise.all([
      query('SELECT * FROM channel_categories WHERE server_id=$1 ORDER BY position,id', [req.params.serverId]),
      query('SELECT * FROM channels WHERE server_id=$1 ORDER BY position,id', [req.params.serverId]),
      query('SELECT * FROM server_roles WHERE server_id=$1 ORDER BY position DESC', [req.params.serverId]),
      query('SELECT * FROM permission_overrides WHERE server_id=$1', [req.params.serverId])
    ]);
    res.json({ categories, channels, roles, overrides });
  } catch (e) { fail(res, e, 'Erro ao carregar estrutura'); }
});

router.put('/servers/:serverId/permissions', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const id = uuidv4();
    const body = req.body || {};
    const categoryId = await assertScopedReference(req.params.serverId, 'channel_categories', body.categoryId || null);
    const channelId = await assertScopedReference(req.params.serverId, 'channels', body.channelId || null);
    const roleId = await assertScopedReference(req.params.serverId, 'server_roles', body.roleId || null);
    const userId = await assertScopedReference(req.params.serverId, 'server_members', body.userId || null);
    const permissions = cleanPermissionMap(body.permissions);
    await query(`INSERT INTO permission_overrides(id,server_id,category_id,channel_id,role_id,user_id,permissions)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO NOTHING`, [id, req.params.serverId, categoryId, channelId, roleId, userId, JSON.stringify(permissions)]);
    await audit(req.params.serverId, req.user.id, 'permissions.update', 'permission', id, { categoryId, channelId, roleId, userId, permissions });
    res.json({ id, serverId:req.params.serverId, categoryId, channelId, roleId, userId, permissions });
  } catch (e) { fail(res, e, 'Erro ao salvar permissões'); }
});

// ===== THREADS / FORUM =====
router.get('/channels/:channelId/threads', async (req, res) => {
  try {
    const channel = await queryOne('SELECT * FROM channels WHERE id=$1', [req.params.channelId]);
    if (!channel) return res.status(404).json({ error:'Canal não encontrado' });
    await requireMember(channel.server_id, req.user.id);
    res.json(await query('SELECT * FROM threads WHERE channel_id=$1 ORDER BY created_at DESC', [req.params.channelId]));
  } catch(e) { fail(res,e,'Erro ao listar threads'); }
});

router.post('/channels/:channelId/threads', async (req,res) => {
  try {
    const channel = await queryOne('SELECT * FROM channels WHERE id=$1',[req.params.channelId]);
    if (!channel) return res.status(404).json({error:'Canal não encontrado'});
    await requireMember(channel.server_id, req.user.id);
    const parentMessageId = req.body.parentMessageId || null;
    if (parentMessageId) {
      const parent = await queryOne('SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2 AND deleted_at IS NULL', [parentMessageId, channel.id]);
      if (!parent) return res.status(400).json({ error: 'Mensagem pai inválida para este canal' });
    }
    const name = sanitizePlainText(req.body.name || 'Thread', 80) || 'Thread';
    const thread = await queryOne(`INSERT INTO threads(id,channel_id,parent_message_id,name,creator_id)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [uuidv4(), req.params.channelId, parentMessageId, name, req.user.id]);
    res.json(thread);
  } catch(e) { fail(res,e,'Erro ao criar thread'); }
});

router.patch('/threads/:threadId', async (req,res) => {
  try {
    const thread = await queryOne('SELECT t.*, c.server_id FROM threads t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1',[req.params.threadId]);
    if (!thread) return res.status(404).json({error:'Thread não encontrada'});
    await requireManage(thread.server_id, req.user.id);
    const nextName = typeof req.body.name === 'string' ? (sanitizePlainText(req.body.name, 80) || null) : null; const updated = await queryOne('UPDATE threads SET name=COALESCE($1,name), archived=COALESCE($2,archived), locked=COALESCE($3,locked) WHERE id=$4 RETURNING *',[nextName, typeof req.body.archived==='boolean'?req.body.archived:null, typeof req.body.locked==='boolean'?req.body.locked:null, req.params.threadId]);
    res.json(updated);
  } catch(e) { fail(res,e,'Erro ao editar thread'); }
});

router.get('/channels/:channelId/forum/posts', async (req,res) => {
  try {
    const channel=await queryOne('SELECT * FROM channels WHERE id=$1',[req.params.channelId]);
    if(!channel) return res.status(404).json({error:'Canal não encontrado'});
    await requireMember(channel.server_id,req.user.id);
    res.json(await query('SELECT p.*,u.username,u.display_name,u.avatar FROM forum_posts p JOIN users u ON u.id=p.author_id WHERE p.channel_id=$1 ORDER BY p.created_at DESC',[req.params.channelId]));
  } catch(e){ fail(res,e,'Erro ao listar fórum'); }
});

router.post('/channels/:channelId/forum/posts', async(req,res)=>{
  try{
    const channel=await queryOne('SELECT * FROM channels WHERE id=$1',[req.params.channelId]);
    if(!channel) return res.status(404).json({error:'Canal não encontrado'});
    await requireMember(channel.server_id,req.user.id);
    const title=sanitizePlainText(req.body.title||'Sem título',200)||'Sem título';
    const content=sanitizePlainText(req.body.content||'',10000);
    const tags=(Array.isArray(req.body.tags)?req.body.tags:[]).slice(0,10).map(tag=>sanitizePlainText(tag,32)).filter(Boolean);
    const post=await queryOne(`INSERT INTO forum_posts(id,channel_id,author_id,title,content,tags) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[uuidv4(),req.params.channelId,req.user.id,title,content,JSON.stringify(tags)]);
    res.json(post);
  }catch(e){fail(res,e,'Erro ao criar post');}
});

// ===== SOCIAL / NOTIFICATIONS =====
router.get('/friends', async(req,res)=>{
  try{ const rows=await query(`SELECT f.status,f.created_at,u.id,u.username,u.display_name,u.avatar FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=$1 ORDER BY u.username`,[req.user.id]); res.json(rows); }
  catch(e){fail(res,e,'Erro ao listar amigos');}
});
router.post('/friends/:username', async(req,res)=>{
  try {
    const other = await queryOne('SELECT id,username FROM users WHERE lower(username)=lower($1)', [req.params.username]);
    if (!other) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (other.id === req.user.id) return res.status(400).json({ error: 'Você não pode adicionar a si mesmo' });
    const block = await queryOne(
      'SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1',
      [req.user.id, other.id]
    );
    if (block) return res.status(403).json({ error: 'Não é possível enviar solicitação para este usuário' });
    const existing = await queryOne(
      'SELECT * FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1) LIMIT 1',
      [req.user.id, other.id]
    );
    if (existing?.status === 'accepted') return res.status(409).json({ error: 'Vocês já são amigos' });
    if (existing?.status === 'pending') {
      if (existing.user_id === other.id && existing.friend_id === req.user.id) {
        await query("UPDATE friends SET status='accepted',updated_at=extract(epoch FROM now())::bigint WHERE user_id=$1 AND friend_id=$2", [other.id, req.user.id]);
        await query("INSERT INTO friends(user_id,friend_id,status) VALUES($1,$2,'accepted') ON CONFLICT(user_id,friend_id) DO UPDATE SET status='accepted',updated_at=extract(epoch FROM now())::bigint", [req.user.id, other.id]);
        return res.json({ success:true, accepted:true });
      }
      return res.status(409).json({ error: 'Solicitação já enviada' });
    }
    await query("INSERT INTO friends(user_id,friend_id,status) VALUES($1,$2,'pending')", [req.user.id, other.id]);
    await query(`INSERT INTO notifications(id,user_id,type,title,description,target) VALUES($1,$2,'friend_request','Nova solicitação',$3,$4)`, [uuidv4(), other.id, `${req.user.username} enviou uma solicitação de amizade.`, JSON.stringify({userId:req.user.id})]);
    res.json({ success:true, user:other });
  } catch(e) {
    if (e?.code === '23505') return res.status(409).json({ error:'Solicitação já enviada' });
    fail(res,e,'Erro ao enviar solicitação');
  }
});

router.post('/friends/:userId/accept',async(req,res)=>{
  try {
    const requester = req.params.userId;
    const block = await queryOne(
      'SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1',
      [req.user.id, requester]
    );
    if (block) return res.status(403).json({ error:'Não é possível aceitar esta solicitação' });
    const pending = await queryOne(
      "SELECT 1 FROM friends WHERE user_id=$1 AND friend_id=$2 AND status='pending'",
      [requester, req.user.id]
    );
    if (!pending) return res.status(404).json({ error:'Solicitação não encontrada' });
    await query("UPDATE friends SET status='accepted',updated_at=extract(epoch FROM now())::bigint WHERE user_id=$1 AND friend_id=$2", [requester, req.user.id]);
    await query("INSERT INTO friends(user_id,friend_id,status) VALUES($1,$2,'accepted') ON CONFLICT(user_id,friend_id) DO UPDATE SET status='accepted',updated_at=extract(epoch FROM now())::bigint", [req.user.id, requester]);
    res.json({ success:true });
  } catch(e) { fail(res,e,'Erro ao aceitar solicitação'); }
});

router.get('/notifications',async(req,res)=>{try{res.json(await query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[req.user.id]));}catch(e){fail(res,e,'Erro ao listar notificações');}});
router.post('/notifications/:id/read',async(req,res)=>{try{await query('UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);res.json({success:true});}catch(e){fail(res,e,'Erro ao marcar notificação');}});

// ===== EVENTS / MODERATION / AUDIT =====
router.get('/servers/:serverId/events',async(req,res)=>{try{await requireMember(req.params.serverId,req.user.id);res.json(await query('SELECT e.*,u.username AS creator_name,COUNT(a.user_id)::int AS attendees FROM server_events e JOIN users u ON u.id=e.creator_id LEFT JOIN event_attendees a ON a.event_id=e.id WHERE e.server_id=$1 GROUP BY e.id,u.username ORDER BY e.start_at',[req.params.serverId]));}catch(e){fail(res,e,'Erro ao listar eventos');}});
router.post('/servers/:serverId/events',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);const name=sanitizePlainText(req.body.name||'Evento',100)||'Evento';const description=sanitizePlainText(req.body.description||'',2000);const location=sanitizePlainText(req.body.location||'',200)||null;const startAt=Math.trunc(Number(req.body.startAt));const endAt=req.body.endAt==null||req.body.endAt===''?null:Math.trunc(Number(req.body.endAt));if(!Number.isFinite(startAt)||startAt<=0||endAt!=null&&(!Number.isFinite(endAt)||endAt<startAt))return res.status(400).json({error:'Datas do evento inválidas'});const type=['other','voice','stage','external'].includes(req.body.type)?req.body.type:'other';const status=['scheduled','active','completed','cancelled'].includes(req.body.status)?req.body.status:'scheduled';const e=await queryOne(`INSERT INTO server_events(id,server_id,creator_id,name,description,start_at,end_at,location,type,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[uuidv4(),req.params.serverId,req.user.id,name,description,endAt?startAt:startAt,endAt,location,type,status]);res.json(e);}catch(e){fail(res,e,'Erro ao criar evento');}});
router.post('/events/:eventId/rsvp',async(req,res)=>{try{const e=await queryOne('SELECT * FROM server_events WHERE id=$1',[req.params.eventId]);if(!e)return res.status(404).json({error:'Evento não encontrado'});await requireMember(e.server_id,req.user.id);await query('INSERT INTO event_attendees(event_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[e.id,req.user.id]);res.json({success:true});}catch(e){fail(res,e,'Erro ao confirmar presença');}});
router.get('/servers/:serverId/moderation',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await query('SELECT m.*,u.username,m2.username AS moderator_name FROM moderation_actions m JOIN users u ON u.id=m.user_id JOIN users m2 ON m2.id=m.moderator_id WHERE m.server_id=$1 ORDER BY m.started_at DESC',[req.params.serverId]));}catch(e){fail(res,e,'Erro ao listar moderação');}});
router.post('/servers/:serverId/moderation',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);const action=String(req.body.action||'warning');if(!['warning','kick','ban','timeout'].includes(action))return res.status(400).json({error:'Ação inválida'});const targetUserId=String(req.body.userId||'').trim();if(!targetUserId||targetUserId===req.user.id)return res.status(400).json({error:'Alvo de moderação inválido'});const target=await queryOne('SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2',[req.params.serverId,targetUserId]);if(!target)return res.status(404).json({error:'Usuário não é membro deste servidor'});const server=await queryOne('SELECT creator_id,owner_id FROM servers WHERE id=$1',[req.params.serverId]);if(targetUserId===server?.creator_id||targetUserId===server?.owner_id||String(target.role||'').toLowerCase()==='owner')return res.status(403).json({error:'O proprietário do servidor não pode ser moderado por esta ação'});const reason=sanitizePlainText(req.body.reason||'',1000);const expiresAt=req.body.expiresAt==null||req.body.expiresAt===''?null:Math.trunc(Number(req.body.expiresAt));if(expiresAt!=null&&(!Number.isFinite(expiresAt)||expiresAt<=Math.floor(Date.now()/1000)))return res.status(400).json({error:'Expiração de moderação inválida'});const m=await queryOne(`INSERT INTO moderation_actions(id,server_id,user_id,moderator_id,action,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[uuidv4(),req.params.serverId,targetUserId,req.user.id,action,reason||null,expiresAt]);await audit(req.params.serverId,req.user.id,`moderation.${action}`,'user',targetUserId,{reason:reason||null},reason||null);res.json(m);}catch(e){fail(res,e,'Erro ao aplicar moderação');}});
router.get('/servers/:serverId/audit-log',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await query('SELECT a.*,u.username AS actor_name FROM audit_logs a JOIN users u ON u.id=a.actor_id WHERE a.server_id=$1 ORDER BY a.created_at DESC LIMIT 500',[req.params.serverId]));}catch(e){fail(res,e,'Erro ao carregar audit log');}});

// ===== ONBOARDING / AUTOMOD / SERVER SETTINGS =====
router.get('/servers/:serverId/onboarding',async(req,res)=>{try{await requireMember(req.params.serverId,req.user.id);res.json(await queryOne('SELECT * FROM onboarding_configs WHERE server_id=$1',[req.params.serverId]) || {server_id:req.params.serverId,enabled:false,questions:[],default_roles:[],default_channels:[]});}catch(e){fail(res,e,'Erro ao carregar onboarding');}});
router.put('/servers/:serverId/onboarding',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);const row=await queryOne(`INSERT INTO onboarding_configs(server_id,enabled,welcome_text,questions,default_roles,default_channels,updated_at) VALUES($1,$2,$3,$4,$5,$6,extract(epoch FROM now())::bigint) ON CONFLICT(server_id) DO UPDATE SET enabled=EXCLUDED.enabled,welcome_text=EXCLUDED.welcome_text,questions=EXCLUDED.questions,default_roles=EXCLUDED.default_roles,default_channels=EXCLUDED.default_channels,updated_at=EXCLUDED.updated_at RETURNING *`,[req.params.serverId,!!req.body.enabled,(sanitizePlainText(req.body.welcomeText||'',2000)||null),boundedJson(req.body.questions||[],[],32768),boundedJson(req.body.defaultRoles||[],[],8192),boundedJson(req.body.defaultChannels||[],[],8192)]);res.json(row);}catch(e){fail(res,e,'Erro ao salvar onboarding');}});
router.get('/servers/:serverId/automod',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await queryOne('SELECT * FROM automod_configs WHERE server_id=$1',[req.params.serverId]) || {server_id:req.params.serverId,enabled:false,rules:{},keywords:[],actions:{}});}catch(e){fail(res,e,'Erro ao carregar automod');}});
router.put('/servers/:serverId/automod',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);const row=await queryOne(`INSERT INTO automod_configs(server_id,enabled,rules,keywords,actions,updated_at) VALUES($1,$2,$3,$4,$5,extract(epoch FROM now())::bigint) ON CONFLICT(server_id) DO UPDATE SET enabled=EXCLUDED.enabled,rules=EXCLUDED.rules,keywords=EXCLUDED.keywords,actions=EXCLUDED.actions,updated_at=EXCLUDED.updated_at RETURNING *`,[req.params.serverId,!!req.body.enabled,boundedJson(req.body.rules||{},{},16384),boundedJson(req.body.keywords||[],[],16384),boundedJson(req.body.actions||{},{},16384)]);res.json(row);}catch(e){fail(res,e,'Erro ao salvar automod');}});

module.exports = router;
