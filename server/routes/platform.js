const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { query, queryOne } = require('../database');
const Server = require('../database/models/Server');
const User = require('../database/models/User');
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
    const name = String(req.body.name || 'Novo cargo').trim().slice(0, 32);
    if (!name) throw new Error('Nome do cargo inválido');
    const max = await queryOne('SELECT COALESCE(MAX(position),0) AS p FROM server_roles WHERE server_id=$1', [req.params.serverId]);
    const role = await queryOne(`INSERT INTO server_roles (id,server_id,name,color,icon,position,permissions,mentionable)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [uuidv4(), req.params.serverId, name, req.body.color || null, req.body.icon || null, Number(max.p) + 1, JSON.stringify(req.body.permissions || {}), !!req.body.mentionable]);
    await audit(req.params.serverId, req.user.id, 'role.create', 'role', role.id, { name });
    res.json(role);
  } catch (e) { fail(res, e, 'Erro ao criar cargo'); }
});

router.put('/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const fields = [];
    const values = [];
    const add = (sql, value) => { values.push(value); fields.push(sql.replace('?', `$${values.length}`)); };
    if (typeof req.body.name === 'string') add('name=?', req.body.name.trim().slice(0,32));
    if (typeof req.body.color === 'string' || req.body.color === null) add('color=?', req.body.color || null);
    if (typeof req.body.icon === 'string' || req.body.icon === null) add('icon=?', req.body.icon || null);
    if (req.body.permissions && typeof req.body.permissions === 'object') add('permissions=?', JSON.stringify(req.body.permissions));
    if (typeof req.body.mentionable === 'boolean') add('mentionable=?', req.body.mentionable);
    if (req.body.position !== undefined) add('position=?', Math.max(0, Number(req.body.position) || 0));
    if (!fields.length) return res.status(400).json({ error: 'Nenhuma alteração informada' });
    values.push(req.params.serverId, req.params.roleId);
    const role = await queryOne(`UPDATE server_roles SET ${fields.join(', ')} WHERE server_id=$${values.length-1} AND id=$${values.length} RETURNING *`, values);
    if (!role) return res.status(404).json({ error: 'Cargo não encontrado' });
    await audit(req.params.serverId, req.user.id, 'role.update', 'role', role.id, req.body);
    res.json(role);
  } catch (e) { fail(res, e, 'Erro ao editar cargo'); }
});

router.delete('/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    if (req.params.roleId.endsWith(':everyone')) return res.status(400).json({ error: 'O cargo padrão não pode ser removido' });
    const deleted = await queryOne('DELETE FROM server_roles WHERE server_id=$1 AND id=$2 RETURNING id', [req.params.serverId, req.params.roleId]);
    if (!deleted) return res.status(404).json({ error: 'Cargo não encontrado' });
    await audit(req.params.serverId, req.user.id, 'role.delete', 'role', deleted.id);
    res.json({ success: true });
  } catch (e) { fail(res, e, 'Erro ao excluir cargo'); }
});

router.put('/servers/:serverId/members/:userId/roles', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const roleIds = Array.isArray(req.body.roleIds) ? req.body.roleIds.slice(0, 50) : [];
    await query('DELETE FROM server_role_members WHERE server_id=$1 AND user_id=$2', [req.params.serverId, req.params.userId]);
    for (const roleId of roleIds) {
      await query(`INSERT INTO server_role_members(role_id,server_id,user_id) SELECT id,server_id,$2 FROM server_roles WHERE id=$1 AND server_id=$3 ON CONFLICT DO NOTHING`, [roleId, req.params.userId, req.params.serverId]);
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
router.post('/servers/:serverId/events',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);const e=await queryOne(`INSERT INTO server_events(id,server_id,creator_id,name,description,start_at,end_at,location,type,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[uuidv4(),req.params.serverId,req.user.id,String(req.body.name||'Evento').slice(0,100),String(req.body.description||'').slice(0,2000),Number(req.body.startAt),req.body.endAt?Number(req.body.endAt):null,req.body.location||null,req.body.type||'other',req.body.status||'scheduled']);res.json(e);}catch(e){fail(res,e,'Erro ao criar evento');}});
router.post('/events/:eventId/rsvp',async(req,res)=>{try{const e=await queryOne('SELECT * FROM server_events WHERE id=$1',[req.params.eventId]);if(!e)return res.status(404).json({error:'Evento não encontrado'});await requireMember(e.server_id,req.user.id);await query('INSERT INTO event_attendees(event_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[e.id,req.user.id]);res.json({success:true});}catch(e){fail(res,e,'Erro ao confirmar presença');}});
router.get('/servers/:serverId/moderation',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await query('SELECT m.*,u.username,m2.username AS moderator_name FROM moderation_actions m JOIN users u ON u.id=m.user_id JOIN users m2 ON m2.id=m.moderator_id WHERE m.server_id=$1 ORDER BY m.started_at DESC',[req.params.serverId]));}catch(e){fail(res,e,'Erro ao listar moderação');}});
router.post('/servers/:serverId/moderation',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);const action=req.body.action;if(!['warning','kick','ban','timeout'].includes(action))return res.status(400).json({error:'Ação inválida'});const m=await queryOne(`INSERT INTO moderation_actions(id,server_id,user_id,moderator_id,action,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[uuidv4(),req.params.serverId,req.body.userId,req.user.id,action,req.body.reason||null,req.body.expiresAt?Number(req.body.expiresAt):null]);await audit(req.params.serverId,req.user.id,`moderation.${action}`,'user',req.body.userId,{reason:req.body.reason||null},req.body.reason||null);res.json(m);}catch(e){fail(res,e,'Erro ao aplicar moderação');}});
router.get('/servers/:serverId/audit-log',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await query('SELECT a.*,u.username AS actor_name FROM audit_logs a JOIN users u ON u.id=a.actor_id WHERE a.server_id=$1 ORDER BY a.created_at DESC LIMIT 500',[req.params.serverId]));}catch(e){fail(res,e,'Erro ao carregar audit log');}});

// ===== ONBOARDING / AUTOMOD / SERVER SETTINGS =====
router.get('/servers/:serverId/onboarding',async(req,res)=>{try{await requireMember(req.params.serverId,req.user.id);res.json(await queryOne('SELECT * FROM onboarding_configs WHERE server_id=$1',[req.params.serverId]) || {server_id:req.params.serverId,enabled:false,questions:[],default_roles:[],default_channels:[]});}catch(e){fail(res,e,'Erro ao carregar onboarding');}});
router.put('/servers/:serverId/onboarding',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);const row=await queryOne(`INSERT INTO onboarding_configs(server_id,enabled,welcome_text,questions,default_roles,default_channels,updated_at) VALUES($1,$2,$3,$4,$5,$6,extract(epoch FROM now())::bigint) ON CONFLICT(server_id) DO UPDATE SET enabled=EXCLUDED.enabled,welcome_text=EXCLUDED.welcome_text,questions=EXCLUDED.questions,default_roles=EXCLUDED.default_roles,default_channels=EXCLUDED.default_channels,updated_at=EXCLUDED.updated_at RETURNING *`,[req.params.serverId,!!req.body.enabled,req.body.welcomeText||null,JSON.stringify(req.body.questions||[]),JSON.stringify(req.body.defaultRoles||[]),JSON.stringify(req.body.defaultChannels||[])]);res.json(row);}catch(e){fail(res,e,'Erro ao salvar onboarding');}});
router.get('/servers/:serverId/automod',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);res.json(await queryOne('SELECT * FROM automod_configs WHERE server_id=$1',[req.params.serverId]) || {server_id:req.params.serverId,enabled:false,rules:{},keywords:[],actions:{}});}catch(e){fail(res,e,'Erro ao carregar automod');}});
router.put('/servers/:serverId/automod',async(req,res)=>{try{await requireManage(req.params.serverId,req.user.id);const row=await queryOne(`INSERT INTO automod_configs(server_id,enabled,rules,keywords,actions,updated_at) VALUES($1,$2,$3,$4,$5,extract(epoch FROM now())::bigint) ON CONFLICT(server_id) DO UPDATE SET enabled=EXCLUDED.enabled,rules=EXCLUDED.rules,keywords=EXCLUDED.keywords,actions=EXCLUDED.actions,updated_at=EXCLUDED.updated_at RETURNING *`,[req.params.serverId,!!req.body.enabled,JSON.stringify(req.body.rules||{}),JSON.stringify(req.body.keywords||[]),JSON.stringify(req.body.actions||{})]);res.json(row);}catch(e){fail(res,e,'Erro ao salvar automod');}});

module.exports = router;
