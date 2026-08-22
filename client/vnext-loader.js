(function () {
  function loadScript(src, dataAttr) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[' + dataAttr + ']')) return resolve();
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.setAttribute(dataAttr, '1');
      document.body.appendChild(s);
      s.onload = resolve;
      s.onerror = reject;
    });
  }

  function load() {
    if (window.__catEmpireVNextLoaded || window.__catEmpireVNextLoading) return;
    window.__catEmpireVNextLoading = true;

    // Only the canonical layers are loaded. The former features-v4-final layer
    // duplicated interaction handlers and was responsible for TDZ/runtime
    // failures around invite and profile actions.
    loadScript('/platform-api.js?v=20260822-v6', 'data-cat-empire-platform')
      .then(function () {
        return loadScript('/runtime-v6.js?v=20260822-v7', 'data-cat-empire-v6');
      })
      .then(function () {
        window.__catEmpireVNextLoaded = true;
        window.__catEmpireVNextLoading = false;
      })
      .catch(function (error) {
        window.__catEmpireVNextLoading = false;
        console.error('CAT EMPIRE: camada funcional não pôde ser carregada.', error);
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
