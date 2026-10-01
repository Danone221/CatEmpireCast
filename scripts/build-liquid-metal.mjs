import { build } from "esbuild";
await build({
  entryPoints: ["client/liquid-metal-react.jsx"],
  outfile: "client/liquid-metal-react.bundle.js",
  bundle: true,
  minify: true,
  sourcemap: false,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  define: {
    "process.env.NODE_ENV": '"production"'
  },
  logLevel: "info"
});