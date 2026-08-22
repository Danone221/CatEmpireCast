(() => {
  'use strict';
  const q=new URLSearchParams(location.search), token=localStorage.getItem('cat_token')||q.get('token')||'', userId=localStorage.getItem('cat_user_id')||q.get('userId')||'', serverId=q.get('serverId')||'';
  const input=document.getElementById('messageInput');
  if(!token||!userId||!input||!serverId)return;
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const headers={Authorization:'Bearer '+token};
  let members=[];
  fetch('/api/v4/servers/'+encodeURIComponent(serverId)+'/full',{headers}).then(r=>r.ok?r.json():null).then(d=>{members=d?.members||[]}).catch(()=>{});
  const wrap=input.parentElement;if(!wrap)return;
  if(getComputedStyle(wrap).position==='static')wrap.style.position='relative';
  const style=document.createElement('style');style.textContent='.cat-v5-mention-box{position:absolute;z-index:950;display:none;max-height:210px;overflow:auto;left:0;right:0;bottom:calc(100% + 6px);background:#120820;border:2px solid #6e36b2;box-shadow:5px 5px #050007}.cat-v5-mention-box.open{display:block}.cat-v5-mention-item{padding:8px 10px;color:#f2ecff;font:9px monospace;cursor:pointer}.cat-v5-mention-item:hover{background:#26123f}.cat-v5-mention-item small{color:#8d7ba9;margin-left:5px}';document.head.appendChild(style);
  const box=document.createElement('div');box.className='cat-v5-mention-box';wrap.appendChild(box);
  function update(){const value=input.value,cursor=input.selectionStart??value.length,left=value.slice(0,cursor),match=left.match(/(?:^|\s)@([\w.-]{0,32})$/);if(!match){box.classList.remove('open');return}const term=match[1].toLowerCase();const list=members.filter(m=>m.id!==userId&&((m.username||'').toLowerCase().includes(term)||(m.display_name||'').toLowerCase().includes(term))).slice(0,8);if(!list.length){box.classList.remove('open');return}box.innerHTML=list.map(m=>'<div class="cat-v5-mention-item" data-u="'+esc(m.username||'')+'">'+esc(m.display_name||m.username)+' <small>@'+esc(m.username||'')+'</small></div>').join('');box.classList.add('open');box.querySelectorAll('[data-u]').forEach(b=>b.onclick=()=>{const before=value.slice(0,cursor),after=value.slice(cursor),replaced=before.replace(/@([\w.-]{0,32})$/,'@'+b.dataset.u+' ');input.value=replaced+after;input.focus();input.setSelectionRange(replaced.length,replaced.length);box.classList.remove('open')})}
  ['input','keyup','click'].forEach(e=>input.addEventListener(e,update));input.addEventListener('blur',()=>setTimeout(()=>box.classList.remove('open'),150));
})();
