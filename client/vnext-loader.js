(function () {
  function load() {
    if (window.__catEmpireV4Loaded || window.__catEmpireV4Loading || document.querySelector('script[data-cat-empire-v4]')) return;
    window.__catEmpireV4Loading = true;
    var s = document.createElement('script');
    s.src = '/features-v4-final.js?v=20260822-v4';
    s.async = false;
    s.dataset.catEmpireV4 = '1';
    s.onload = function () { window.__catEmpireV4Loaded = true; window.__catEmpireV4Loading = false; };
    s.onerror = function () { window.__catEmpireV4Loading = false; console.error('CAT EMPIRE V4 não pôde ser carregado.'); };
    document.body.appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
