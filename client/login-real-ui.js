(() => {
  const scene = document.querySelector(".real-scene");
  setTimeout(() => scene?.classList.add("real-login-ready"), 1300);
  if (matchMedia("(pointer:fine)").matches) {
    document.querySelectorAll(".real-visual-pane,.real-form-pane").forEach((card) => {
      let raf = 0;
      card.addEventListener("pointermove", (e) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const r = card.getBoundingClientRect();
          const px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
          const py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
          card.style.setProperty("--card-x", (px * 100).toFixed(1) + "%");
          card.style.setProperty("--card-y", (py * 100).toFixed(1) + "%");
          card.style.setProperty("--tilt-x", ((px - 0.5) * 5).toFixed(2) + "deg");
          card.style.setProperty("--tilt-y", ((0.5 - py) * 4).toFixed(2) + "deg");
        });
      }, { passive: true });
      card.addEventListener("pointerleave", () => {
        card.style.setProperty("--card-x", "50%");
        card.style.setProperty("--card-y", "50%");
        card.style.setProperty("--tilt-x", "0deg");
        card.style.setProperty("--tilt-y", "0deg");
      });
    });
  }
  const footerSvg = document.querySelector(".real-footer-hover-svg");
  const reveal = document.getElementById("realFooterReveal");
  if (footerSvg && reveal) {
    footerSvg.addEventListener("pointermove", (e) => {
      const r = footerSvg.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100));
      const y = Math.max(0, Math.min(100, (e.clientY - r.top) / r.height * 100));
      reveal.setAttribute("cx", x.toFixed(1) + "%");
      reveal.setAttribute("cy", y.toFixed(1) + "%");
    }, { passive: true });
  }
})();