(() => {
  if (!document.body.classList.contains('room-page')) return;
  if (!matchMedia('(pointer:fine)').matches) return;

  document.querySelectorAll('.channels-sidebar,.members-sidebar,.main-panel').forEach(panel => {
    let raf = 0;
    panel.addEventListener('pointermove', e => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = panel.getBoundingClientRect();
        const x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
        const y = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
        panel.style.setProperty('--srv-x', x.toFixed(1) + '%');
        panel.style.setProperty('--srv-y', y.toFixed(1) + '%');
      });
    }, { passive:true });

    panel.addEventListener('pointerleave', () => {
      panel.style.setProperty('--srv-x', '50%');
      panel.style.setProperty('--srv-y', '50%');
    });
  });
})();