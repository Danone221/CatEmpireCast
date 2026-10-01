const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { query, queryOne } = require('../database');
const Server = require('../database/models/Server');
const User = require('../database/models/User');
const Role = require('../database/models/Role');
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
  const role = await memberRole(serverId, userId);
  if (!role || !['admin', 'owner'].includes(role)) {
    throw Object.assign(new Error('Sem permissão para gerenciar este servidor'), { status: 403 });
  }
  return role;
}

function boundedJson(value, maxBytes, label) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw Object.assign(new Error(`${label} excede o limite permitido`), { status: 413 });
  }
  return json;
}

async function validateServerIds(serverId, table, column, ids, label) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string').slice(0, 25))];
  if (!clean.length) return [];
  const allowed = new Map([
    ['server_roles:id', 'SELECT id FROM server_roles WHERE server_id=$1 AND id = ANY($2::text[])'],
    ['channels:id', 'SELECT id FROM channels WHERE server_id=$1 AND id = ANY($2::text[])']
  ]);
  const sql = allowed.get(`${table}:${column}`);
  if (!sql) throw Object.assign(new Error('Validação de referência inválida'), { status: 500 });
  const rows = await query(sql, [serverId, clean]);
  if (rows.length !== clean.length) {
    throw Object.assign(new Error(`${label} contém referência de outro servidor ou inexistente`), { status: 400 });
  }
  return clean;
}

async function requireModerationTarget(serverId, actorId, targetId) {
  if (!targetId || typeof targetId !== 'string') {
    throw Object.assign(new Error('Usuário alvo inválido'), { status: 400 });
  }
  if (targetId === actorId) {
    throw Object.assign(new Error('Você não pode aplicar moderação em si mesmo'), { status: 400 });
  }
  const [server, actorRole, target] = await Promise.all([
    queryOne('SELECT creator_id,owner_id FROM servers WHERE id=$1', [serverId]),
    Server.getMemberRole(serverId, actorId),
    queryOne('SELECT role,is_owner FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, targetId])
  ]);
  if (!target) throw Object.assign(new Error('Membro alvo não pertence a este servidor'), { status: 404 });
  const actorIsOwner = actorRole === 'owner' || server?.creator_id === actorId || server?.owner_id === actorId;
  const targetIsOwner = String(target.role || '').toLowerCase() === 'owner' || target.is_owner || server?.creator_id === targetId || server?.owner_id === targetId;
  if (targetIsOwner && !actorIsOwner) {
    throw Object.assign(new Error('Somente o proprietário pode moderar outro proprietário'), { status: 403 });
  }
  return target;
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
router.put('/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    const actorRole = await requireManage(req.params.serverId, req.user.id);
    const actorLevel = actorRole === 'owner' ? 100 : 90;
    const existingRole = await Role.findById(req.params.serverId, req.params.roleId);
    if (!existingRole) return res.status(404).json({ error: 'Cargo não encontrado' });
    if (Number(existingRole.position || 0) >= actorLevel) {
      return res.status(403).json({ error: 'Você não pode editar um cargo acima ou igual à sua hierarquia' });
    }

    const next = { ...(req.body || {}) };
    if (next.position !== undefined && Number(next.position) >= actorLevel) {
      next.position = actorLevel - 1;
    }

    const role = await Role.update(req.params.serverId, req.params.roleId, next);
    await audit(req.params.serverId, req.user.id, 'role.update', 'role', role.id, next);
    res.json(role);
  } catch (e) { fail(res, e, 'Erro ao editar cargo'); }
});

router.put('/servers/:serverId/members/:userId/roles', async (req, res) => {
  try {
    const actorRole = await requireManage(req.params.serverId, req.user.id);
    const actorLevel = actorRole === 'owner' ? 100 : 90;
    const server = await queryOne('SELECT creator_id FROM servers WHERE id=$1', [req.params.serverId]);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });

    const targetMember = await queryOne(
      'SELECT user_id FROM server_members WHERE server_id=$1 AND user_id=$2',
      [req.params.serverId, req.params.userId]
    );
    if (!targetMember) return res.status(404).json({ error: 'Membro não encontrado neste servidor' });

    const actorIsOwner = server.creator_id === req.user.id || actorRole === 'owner';
    const targetIsOwner = server.creator_id === req.params.userId;
    if (targetIsOwner && !actorIsOwner) {
      return res.status(403).json({ error: 'Somente o proprietário pode alterar os próprios cargos' });
    }

    if (!actorIsOwner) {
      const targetHighest = await queryOne(
        `SELECT COALESCE(MAX(r.position),0)::int AS position
         FROM server_role_members rm
         JOIN server_roles r ON r.id=rm.role_id
         WHERE rm.server_id=$1 AND rm.user_id=$2`,
        [req.params.serverId, req.params.userId]
      );
      if (Number(targetHighest?.position || 0) >= actorLevel) {
        return res.status(403).json({ error: 'Você não pode alterar cargos de um membro acima ou igual à sua hierarquia' });
      }
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
    if (roles.some(role => ['owner', '@everyone'].includes(String(role.name || '').trim().toLowerCase()))) {
      return res.status(403).json({ error: 'Cargos reservados não podem ser atribuídos manualmente' });
    }
    if (roles.some(role => Number(role.position || 0) >= actorLevel)) {
      return res.status(403).json({ error: 'Você não pode atribuir um cargo acima ou igual à sua hierarquia' });
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
    const { categoryId=null, channelId=null, roleId=null, userId=null, permissions={} } = req.body || {};
    const refs = [
      categoryId ? queryOne('SELECT id FROM channel_categories WHERE id=$1 AND server_id=$2', [categoryId, req.params.serverId]) : Promise.resolve({ id: null }),
      channelId ? queryOne('SELECT id FROM channels WHERE id=$1 AND server_id=$2', [channelId, req.params.serverId]) : Promise.resolve({ id: null }),
      roleId ? queryOne('SELECT id FROM server_roles WHERE id=$1 AND server_id=$2', [roleId, req.params.serverId]) : Promise.resolve({ id: null }),
      userId ? queryOne('SELECT user_id AS id FROM server_members WHERE user_id=$1 AND server_id=$2', [userId, req.params.serverId]) : Promise.resolve({ id: null })
    ];
    const [categoryRef, channelRef, roleRef, userRef] = await Promise.all(refs);
    if ((categoryId && !categoryRef) || (channelId && !channelRef) || (roleId && !roleRef) || (userId && !userRef)) {
      return res.status(400).json({ error: 'Referência de permissão inválida para este servidor' });
    }
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
      return res.status(400).json({ error: 'Permissões inválidas' });
    }
    const serializedPermissions = JSON.stringify(permissions);
    if (serializedPermissions.length > 12000) {
      return res.status(413).json({ error: 'Conjunto de permissões muito grande' });
    }
    await query(`INSERT INTO permission_overrides(id,server_id,category_id,channel_id,role_id,user_id,permissions)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO NOTHING`, [id, req.params.serverId, categoryId, channelId, roleId, userId, serializedPermissions]);
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
    const thread = await queryOne(`INSERT INTO threads(id,channel_id,parent_message_id,name,creator_id)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [uuidv4(), req.params.channelId, req.body.parentMessageId || null, String(req.body.name || 'Thread').slice(0,80), req.user.id]);
    res.json(thread);
  } catch(e) { fail(res,e,'Erro ao criar thread'); }
});

router.patch('/threads/:threadId', async (req,res) => {
  try {
    const thread = await queryOne('SELECT t.*, c.server_id FROM threads t JOIN channels c ON c.id=t.channel_id WHERE t.id=$1',[req.params.threadId]);
    if (!thread) return res.status(404).json({error:'Thread não encontrada'});
    await requireManage(thread.server_id, req.user.id);
    const updated = await queryOne('UPDATE threads SET name=COALESCE($1,name), archived=COALESCE($2,archived), locked=COALESCE($3,locked) WHERE id=$4 RETURNING *',[req.body.name || null, typeof req.body.archived==='boolean'?req.body.archived:null, typeof req.body.locked==='boolean'?req.body.locked:null, req.params.threadId]);
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
    const post=await queryOne(`INSERT INTO forum_posts(id,channel_id,author_id,title,content,tags) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[uuidv4(),req.params.channelId,req.user.id,String(req.body.title||'Sem título').slice(0,200),String(req.body.content||'').slice(0,10000),JSON.stringify(Array.isArray(req.body.tags)?req.body.tags.slice(0,10):[])]);
    res.json(post);
  }catch(e){fail(res,e,'Erro ao criar post');}
});

// ===== SOCIAL / NOTIFICATIONS =====
router.get('/friends', async(req,res)=>{
  try{ const rows=await query(`SELECT f.status,f.created_at,u.id,u.username,u.display_name,u.avatar FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=$1 ORDER BY u.username`,[req.user.id]); res.json(rows); }
  catch(e){fail(res,e,'Erro ao listar amigos');}
});
router.post('/friends/:username', async(req,res)=>{
  try{
    const other=await queryOne('SELECT id,username FROM users WHERE lower(username)=lower($1)',[req.params.username]);
    if(!other) return res.status(404).json({error:'Usuário não encontrado'});
    if(other.id===req.user.id) return res.status(400).json({error:'Você não pode adicionar a si mesmo'});
    await query(`INSERT INTO friends(user_id,friend_id,status) VALUES($1,$2,'pending') ON CONFLICT(user_id,friend_id) DO UPDATE SET status='pending',updated_at=extract(epoch FROM now())::bigint`,[req.user.id,other.id]);
    await query(`INSERT INTO notifications(id,user_id,type,title,description,target) VALUES($1,$2,'friend_request','Nova solicitação', $3, $4)`,[uuidv4(),other.id,`${req.user.username} enviou uma solicitação de amizade.`,JSON.stringify({userId:req.user.id})]);
    res.json({success:true,user:other});
  }catch(e){fail(res,e,'Erro ao enviar solicitação');}
});
router.post('/friends/:userId/accept',async(req,res)=>{
  try{
    const other=req.params.userId;
    await query(`UPDATE friends SET status='accepted',updated_at=extract(epoch FROM now())::bigint WHERE user_id=$1 AND friend_id=$2`,[req.user.id,other]);
    await query(`INSERT INTO friends(user_id,friend_id,status) VALUES($1,$2,'accepted') ON CONFLICT(user_id,friend_id) DO UPDATE SET status='accepted',updated_at=extract(epoch FROM now())::bigint`,[other,req.user.id]);
    res.json({success:true});
  }catch(e){fail(res,e,'Erro ao aceitar solicitação');}
});
router.get('/notifications',async(req,res)=>{try{res.json(await query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[req.user.id]));}catch(e){fail(res,e,'Erro ao listar notificações');}});
router.post('/notifications/:id/read',async(req,res)=>{try{await query('UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);res.json({success:true});}catch(e){fail(res,e,'Erro ao marcar notificação');}});

// ===== EVENTS / MODERATION / AUDIT =====
router.get('/servers/:serverId/events',async(req,res)=>{try{await requireMember(req.params.serverId,req.user.id);res.json(await query('SELECT e.*,u.username AS creator_name,COUNT(a.user_id)::int AS attendees FROM server_events e JOIN users u ON u.id=e.creator_id LEFT JOIN event_attendees a ON a.event_id=e.id WHERE e.server_id=$1 GROUP BY e.id,u.username ORDER BY e.start_at',[req.params.serverId]));}catch(e){fail(res,e,'Erro ao listar eventos');}});
router.post('/servers/:serverId/events',async(req,res)=>{try{
  await requireManage(req.params.serverId,req.user.id);
  const name=String(req.body.name||'Evento').replace(/[<>]/g,'').trim().slice(0,100)||'Evento';
  const description=String(req.body.description||'').replace(/[<>]/g,'').trim().slice(0,2000);
  const location=String(req.body.location||'').replace(/[<>]/g,'').trim().slice(0,200)||null;
  const startAt=Number(req.body.startAt);
  const endAt=req.body.endAt?Number(req.body.endAt):null;
  if(!Number.isFinite(startAt)||startAt<=0||endAt!==null&&!Number.isFinite(endAt))return res.status(400).json({error:'Data do evento inválida'});
  const e=await queryOne(`INSERT INTO server_events(id,server_id,creator_id,name,description,start_at,end_at,location,type,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[uuidv4(),req.params.serverId,req.user.id,name,description,startAt,endAt,location,String(req.body.type||'other').slice(0,40),String(req.body.status||'scheduled').slice(0,40)]);
  res.json(e);
}catch(e){fail(res,e,'Erro ao criar evento');}});
router.post('/events/:eventId/rsvp',async(req,res)=>{try{const e=await queryOne('SELECT * FROM server_events WHERE id=$1',[req.params.eventId]);if(!e)return res.status(404).json({error:'Evento não encontrado'});await requireMember(e.server_id,req.user.id);await query('INSERT INTO event_attendees(event_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[e.id,req.user.id]);res.json({success:true});}catch(e){fail(res,e,'Erro ao confirmar presença');}});
router.get('/servers/:serverId/moderation',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await query('SELECT m.*,u.username,m2.username AS moderator_name FROM moderation_actions m JOIN users u ON u.id=m.user_id JOIN users m2 ON m2.id=m.moderator_id WHERE m.server_id=$1 ORDER BY m.started_at DESC',[req.params.serverId]));}catch(e){fail(res,e,'Erro ao listar moderação');}});
router.post('/servers/:serverId/moderation',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);await requireModerationTarget(req.params.serverId,req.user.id,req.body.userId);const action=req.body.action;if(!['warning','kick','ban','timeout'].includes(action))return res.status(400).json({error:'Ação inválida'});const reason=String(req.body.reason||'').replace(/[<>]/g,'').trim().slice(0,1000)||null;const expiresAt=req.body.expiresAt?Number(req.body.expiresAt):null;if(expiresAt!==null&&!Number.isFinite(expiresAt))return res.status(400).json({error:'Expiração inválida'});const m=await queryOne(`INSERT INTO moderation_actions(id,server_id,user_id,moderator_id,action,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[uuidv4(),req.params.serverId,req.body.userId,req.user.id,action,reason,expiresAt]);await audit(req.params.serverId,req.user.id,`moderation.${action}`,'user',req.body.userId,{reason:req.body.reason||null},req.body.reason||null);res.json(m);}catch(e){fail(res,e,'Erro ao aplicar moderação');}});
router.get('/servers/:serverId/audit-log',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await query('SELECT a.*,u.username AS actor_name FROM audit_logs a JOIN users u ON u.id=a.actor_id WHERE a.server_id=$1 ORDER BY a.created_at DESC LIMIT 500',[req.params.serverId]));}catch(e){fail(res,e,'Erro ao carregar audit log');}});

// ===== ONBOARDING / AUTOMOD / SERVER SETTINGS =====
router.get('/servers/:serverId/onboarding',async(req,res)=>{try{await requireMember(req.params.serverId,req.user.id);res.json(await queryOne('SELECT * FROM onboarding_configs WHERE server_id=$1',[req.params.serverId]) || {server_id:req.params.serverId,enabled:false,questions:[],default_roles:[],default_channels:[]});}catch(e){fail(res,e,'Erro ao carregar onboarding');}});
router.put('/servers/:serverId/onboarding',async(req,res)=>{try{
  await requireManage(req.params.serverId,req.user.id);
  const questions=Array.isArray(req.body.questions)?req.body.questions.slice(0,25):[];
  const defaultRoles=await validateServerIds(req.params.serverId,'server_roles','id',req.body.defaultRoles,'Cargos padrão');
  const defaultChannels=await validateServerIds(req.params.serverId,'channels','id',req.body.defaultChannels,'Canais padrão');
  const welcomeText=String(req.body.welcomeText||'').replace(/[<>]/g,'').trim().slice(0,1500)||null;
  const questionsJson=boundedJson(questions,32768,'Perguntas do onboarding');
  const rolesJson=boundedJson(defaultRoles,8192,'Cargos padrão');
  const channelsJson=boundedJson(defaultChannels,8192,'Canais padrão');
  const row=await queryOne(`INSERT INTO onboarding_configs(server_id,enabled,welcome_text,questions,default_roles,default_channels,updated_at) VALUES($1,$2,$3,$4,$5,$6,extract(epoch FROM now())::bigint) ON CONFLICT(server_id) DO UPDATE SET enabled=EXCLUDED.enabled,welcome_text=EXCLUDED.welcome_text,questions=EXCLUDED.questions,default_roles=EXCLUDED.default_roles,default_channels=EXCLUDED.default_channels,updated_at=EXCLUDED.updated_at RETURNING *`,[req.params.serverId,!!req.body.enabled,welcomeText,questionsJson,rolesJson,channelsJson]);
  res.json(row);
}catch(e){fail(res,e,'Erro ao salvar onboarding');}});
router.get('/servers/:serverId/automod',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await queryOne('SELECT * FROM automod_configs WHERE server_id=$1',[req.params.serverId]) || {server_id:req.params.serverId,enabled:false,rules:{},keywords:[],actions:{}});}catch(e){fail(res,e,'Erro ao carregar automod');}});
router.put('/servers/:serverId/automod',async(req,res)=>{try{
  await requireManage(req.params.serverId,req.user.id);
  const rules=req.body.rules&&typeof req.body.rules==='object'&&!Array.isArray(req.body.rules)?req.body.rules:{};
  const actions=req.body.actions&&typeof req.body.actions==='object'&&!Array.isArray(req.body.actions)?req.body.actions:{};
  const keywords=(Array.isArray(req.body.keywords)?req.body.keywords:[]).slice(0,200).map(v=>String(v).replace(/[<>]/g,'').trim().slice(0,80)).filter(Boolean);
  const row=await queryOne(`INSERT INTO automod_configs(server_id,enabled,rules,keywords,actions,updated_at) VALUES($1,$2,$3,$4,$5,extract(epoch FROM now())::bigint) ON CONFLICT(server_id) DO UPDATE SET enabled=EXCLUDED.enabled,rules=EXCLUDED.rules,keywords=EXCLUDED.keywords,actions=EXCLUDED.actions,updated_at=EXCLUDED.updated_at RETURNING *`,[req.params.serverId,!!req.body.enabled,boundedJson(rules,32768,'Regras do automod'),boundedJson(keywords,32768,'Palavras do automod'),boundedJson(actions,32768,'Ações do automod')]);
  res.json(row);
}catch(e){fail(res,e,'Erro ao salvar automod');}});

module.exports = router;
