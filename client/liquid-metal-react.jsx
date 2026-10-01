import React from "react";
import { createRoot } from "react-dom/client";
import { LiquidMetal, liquidMetalPresets } from "@paper-design/shaders-react";

const mount = document.getElementById("liquidMetalReactRoot");

if (mount) {
  const source = liquidMetalPresets[2];
  const preset = source?.params ? { ...source.params } : { ...source };
  const mobile = window.matchMedia("(max-width: 860px)").matches;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const deviceMemory = Number(navigator.deviceMemory || 8);
  const lowMemory = Number.isFinite(deviceMemory) && deviceMemory <= 4;
  const baseSpeed = Number(preset.speed ?? 1);
  const speed = reducedMotion ? 0 : mobile ? Math.min(baseSpeed, lowMemory ? 0.3 : 0.45) : baseSpeed;

  mount.dataset.shaderState = "loading";

  createRoot(mount).render(
    React.createElement(LiquidMetal, {
      ...preset,
      speed,
      minPixelRatio: mobile ? 1 : 1.5,
      maxPixelCount: mobile ? (lowMemory ? 640 * 960 : 720 * 1280) : 1920 * 1080 * 2,
      webGlContextAttributes: {
        alpha: false,
        antialias: false,
        preserveDrawingBuffer: false,
        powerPreference: mobile ? "low-power" : "high-performance",
      },
      colorBack: "#03050a",
      colorTint: preset.colorTint ?? "#e9f4ff",
      shiftRed: 0.018,
      shiftBlue: 0.018,
      style: {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
      },
    }),
  );

  const attachCanvasGuards = () => {
    const canvas = mount.querySelector("canvas");
    if (!canvas || canvas.dataset.contextGuard === "1") return Boolean(canvas);
    canvas.dataset.contextGuard = "1";
    mount.dataset.shaderState = "ready";
    delete mount.dataset.shaderFailed;

    canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      mount.dataset.shaderFailed = "true";
      mount.dataset.shaderState = "lost";
    });

    canvas.addEventListener("webglcontextrestored", () => {
      delete mount.dataset.shaderFailed;
      mount.dataset.shaderState = "ready";
    });

    return true;
  };

  if (!attachCanvasGuards()) {
    const observer = new MutationObserver(() => {
      if (attachCanvasGuards()) observer.disconnect();
    });
    observer.observe(mount, { childList: true, subtree: true });
    window.setTimeout(() => {
      observer.disconnect();
      if (!mount.querySelector("canvas")) {
        mount.dataset.shaderFailed = "true";
        mount.dataset.shaderState = "fallback";
      }
    }, 4000);
  }
}
