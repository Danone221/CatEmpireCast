(() => {
  'use strict';
  const q=new URLSearchParams(location.search),token=localStorage.getItem('cat_token')||q.get('token')||'',userId=localStorage.getItem('cat_user_id')||q.get('userId')||'';
  const modal=document.getElementById('viewProfileModal');
  if(!token||!userId||!modal)return;
  const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  async function openOwnProfile(){
    try{
      const r=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}});const p=await r.json();if(!r.ok)throw Error(p.error||'Erro ao carregar perfil');
      $('viewProfileAvatar').src=p.avatar||'/logo.svg';$('viewProfileName').textContent=p.display_name||p.username||'Membro';$('viewProfileUsername').textContent='@'+(p.username||'usuario');$('viewProfileBio').textContent=p.bio||'Sem bio.';
      const b=$('viewProfileBanner'),banner=p.banner||p.banner_color;if(b){if(banner&&/^(data:|https?:)/.test(banner)){b.style.backgroundImage=`url("${banner}")`;b.style.backgroundColor='';}else{b.style.backgroundImage='none';b.style.backgroundColor=banner||'#120820';}}
      const actions=modal.querySelector('.modal-actions');if(actions){actions.innerHTML='<button type="button" class="btn" id="catOwnClose">Fechar</button>';actions.querySelector('#catOwnClose').onclick=()=>modal.classList.remove('open');}
      modal.classList.add('open');
    }catch(e){if(typeof window.toast==='function')window.toast(e.message,'error');}
  }
  ['myAvatarBtn','myInfoBtn'].forEach(id=>{const el=$(id);if(!el)return;el.addEventListener('click',e=>{e.preventDefault();e.stopImmediatePropagation();openOwnProfile();},true);});
})();
