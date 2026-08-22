(() => {
  const q=new URLSearchParams(location.search), sid=q.get('serverId'), token=localStorage.getItem('cat_token')||q.get('token')||'';
  if(!sid||!token)return;
  const apply=(el,b)=>{if(!el||!b)return;if(/^(data:|https?:)/.test(b)){el.style.backgroundImage=`url("${b}")`;el.style.backgroundSize='cover';el.style.backgroundPosition='center';el.style.backgroundColor='';}else{el.style.backgroundImage='none';el.style.backgroundColor=b;}};
  fetch('/api/servers/'+encodeURIComponent(sid),{headers:{Authorization:'Bearer '+token}})
    .then(r=>r.ok?r.json():null)
    .then(s=>{if(!s)return;const banner=s.banner||s.banner_color;apply(document.getElementById('serverHead'),banner);const v=document.getElementById('viewProfileBanner');if(v&&banner)apply(v,banner);})
    .catch(()=>{});
})();
