import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LiquidMetal, liquidMetalPresets } from "@paper-design/shaders-react";

const mount = document.getElementById("liquidMetalReactRoot");

function MovingLiquidMetal() {
  const preset = useMemo(() => {
    const source = liquidMetalPresets[2];
    return source?.params ? { ...source.params } : { ...source };
  }, []);

  const stateRef = useRef({
    x: typeof preset.offsetX === "number" ? preset.offsetX : -0.25,
    y: typeof preset.offsetY === "number" ? preset.offsetY : -0.12,
    vx: 0.004,
    vy: 0.002,
    tx: 0.72,
    ty: 0.52,
    nextTarget: 0,
    last: performance.now(),
    lastPaint: 0,
  });

  const [dynamic, setDynamic] = useState(() => ({
    offsetX: stateRef.current.x,
    offsetY: stateRef.current.y,
    rotation: typeof preset.rotation === "number" ? preset.rotation : 0,
    scale: typeof preset.scale === "number" ? preset.scale : 0.7,
    distortion: typeof preset.distortion === "number" ? preset.distortion : 0.12,
    contour: typeof preset.contour === "number" ? preset.contour : 0.45,
    speed: typeof preset.speed === "number" ? preset.speed : 1,
  }));

  useEffect(() => {
    let raf = 0;
    const s = stateRef.current;
    const rand = (a, b) => Math.random() * (b - a) + a;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    const chooseTarget = (now) => {
      const left = s.x < 0;
      const top = s.y < 0;

      // Bias most targets to the opposite half so the liquid travels across the screen.
      s.tx = Math.random() < 0.82
        ? (left ? rand(0.28, 0.90) : rand(-0.90, -0.28))
        : rand(-0.92, 0.92);

      s.ty = Math.random() < 0.64
        ? (top ? rand(0.18, 0.82) : rand(-0.82, -0.18))
        : rand(-0.84, 0.84);

      s.nextTarget = now + rand(1500, 3100);
    };

    chooseTarget(performance.now());

    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) {
        s.last = now;
        return;
      }

      const dt = Math.min(45, now - s.last || 16.67);
      s.last = now;
      const step = dt / 16.667;

      if (now >= s.nextTarget || Math.hypot(s.tx - s.x, s.ty - s.y) < 0.11) {
        chooseTarget(now);
      }

      // Spring + damping = smooth continuous movement with inertia.
      const ax = (s.tx - s.x) * 0.00165;
      const ay = (s.ty - s.y) * 0.00165;
      const wanderX = Math.sin(now * 0.00073) * 0.00011 + Math.sin(now * 0.00131 + 1.8) * 0.00006;
      const wanderY = Math.cos(now * 0.00067 + 2.1) * 0.00010 + Math.sin(now * 0.00109) * 0.00006;

      s.vx = (s.vx + (ax + wanderX) * step) * Math.pow(0.987, step);
      s.vy = (s.vy + (ay + wanderY) * step) * Math.pow(0.987, step);

      const maxSpeed = 0.015;
      let mag = Math.hypot(s.vx, s.vy);

      if (mag < 0.0013) {
        s.vx += Math.cos(now * 0.0012) * 0.0007;
        s.vy += Math.sin(now * 0.0011) * 0.0007;
        mag = Math.hypot(s.vx, s.vy);
      }

      if (mag > maxSpeed) {
        s.vx = (s.vx / mag) * maxSpeed;
        s.vy = (s.vy / mag) * maxSpeed;
        mag = maxSpeed;
      }

      s.x += s.vx * step;
      s.y += s.vy * step;

      if (s.x < -0.98) { s.x = -0.98; s.vx = Math.abs(s.vx) * 0.82; chooseTarget(now); }
      if (s.x >  0.98) { s.x =  0.98; s.vx = -Math.abs(s.vx) * 0.82; chooseTarget(now); }
      if (s.y < -0.92) { s.y = -0.92; s.vy = Math.abs(s.vy) * 0.82; chooseTarget(now); }
      if (s.y >  0.92) { s.y =  0.92; s.vy = -Math.abs(s.vy) * 0.82; chooseTarget(now); }

      // ~30fps React prop updates. Shader itself remains smooth internally.
      if (now - s.lastPaint < 32) return;
      s.lastPaint = now;

      const speedNorm = clamp(mag / maxSpeed, 0, 1);
      const angle = (Math.atan2(s.vy, s.vx) * 180 / Math.PI + 360) % 360;

      setDynamic({
        offsetX: s.x,
        offsetY: s.y,
        rotation: angle,
        // Slight zooming follows acceleration, like a droplet stretching in motion.
        scale: clamp((preset.scale ?? 0.72) * (1.0 + speedNorm * 0.22), 0.34, 1.55),
        // Faster movement produces stronger edge deformation and internal turbulence.
        distortion: clamp((preset.distortion ?? 0.10) + speedNorm * 0.34 + Math.sin(now * 0.0015) * 0.035, 0.06, 0.62),
        contour: clamp((preset.contour ?? 0.40) + speedNorm * 0.40 + Math.sin(now * 0.0011 + 1.7) * 0.07, 0.22, 0.92),
        speed: clamp((preset.speed ?? 1) * (0.72 + speedNorm * 0.92), 0.35, 2.2),
      });
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [preset]);

  return React.createElement(LiquidMetal, {
    ...preset,
    ...dynamic,
    // Paper's organic mask makes the surface read as liquid rather than a fixed diamond.
    shape: "metaballs",
    colorBack: "#050712",
    colorTint: preset.colorTint ?? "#ffffff",
    softness: Math.max(0.16, preset.softness ?? 0.16),
    fit: "cover",
    minPixelRatio: 1,
    maxPixelCount: 1500000,
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      display: "block",
    },
  });
}

if (mount) {
  createRoot(mount).render(React.createElement(MovingLiquidMetal));
}
