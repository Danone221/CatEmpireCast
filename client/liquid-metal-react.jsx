import React from "react";
import { createRoot } from "react-dom/client";
import { LiquidMetal, liquidMetalPresets } from "@paper-design/shaders-react";

const mount = document.getElementById("liquidMetalReactRoot");

if (mount) {
  const source = liquidMetalPresets[2];
  const preset = source?.params ? { ...source.params } : { ...source };

  createRoot(mount).render(
    React.createElement(LiquidMetal, {
      ...preset,
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
}
