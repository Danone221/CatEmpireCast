(() => {
  const modal = document.getElementById("viewProfileModal");
  const card = modal?.querySelector(".profile-x-card");
  if (!modal || !card) return;
  if (matchMedia("(pointer:fine)").matches) {
    let raf = 0;
    card.addEventListener("pointermove", (event) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = card.getBoundingClientRect();
        const x = Math.max(0, Math.min(100, (event.clientX - r.left) / r.width * 100));
        const y = Math.max(0, Math.min(100, (event.clientY - r.top) / r.height * 100));
        card.style.setProperty("--profile-x", x.toFixed(1) + "%");
        card.style.setProperty("--profile-y", y.toFixed(1) + "%");
      });
    }, { passive: true });
    card.addEventListener("pointerleave", () => {
      card.style.setProperty("--profile-x", "50%");
      card.style.setProperty("--profile-y", "38%");
    });
  }
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      modal.classList.remove("open");
    }
  });
})();