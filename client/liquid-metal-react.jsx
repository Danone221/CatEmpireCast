import React from "react";
import { createRoot } from "react-dom/client";
import { LiquidMetal, liquidMetalPresets } from "@paper-design/shaders-react";

const mount = document.getElementById("liquidMetalReactRoot");

if (mount) {
  const preset = liquidMetalPresets[2];

  createRoot(mount).render(
    React.createElement(LiquidMetal, {
      ...preset,
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
