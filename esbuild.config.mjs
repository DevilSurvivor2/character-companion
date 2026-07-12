import esbuild from "esbuild";
import process from "process";
import fs from "fs";

const prod = process.argv[2] === "production";

// RiTa (a global-assigning browser script) is prepended wrapped in a function, so its
// 1.5 MB parses/runs on first engine use (__ccLoadRita), not at plugin load. The wrapper
// must stay FIRST in the output: rita's tail assigns the bare global `RiTa =`, which needs
// sloppy mode — with the banner first, the bundle's "use strict" is no longer a directive.
const ritaGlobal = fs.readFileSync("lib/rita.min.js", "utf8");
const ritaLazy = `var __ccLoadRita = function () {
${ritaGlobal}
;return (typeof RiTa !== "undefined" ? RiTa : globalThis.RiTa);
};
`;

// styles.css is a byte-for-byte concatenation of these parts, in this order.
const STYLE_PARTS = [
  "tuning.css",
  "panel.css",
  "effects.css",
  "sprite.css",
  "settings.css",
  "feed.css",
  "animations.css",
  "aesthetics.css",
];
function buildStyles() {
  const banner = "/* GENERATED FILE — built from src/styles/ by esbuild.config.mjs. Edit the parts there, never this file. */\n\n";
  const css = STYLE_PARTS.map((f) => fs.readFileSync("src/styles/" + f, "utf8")).join("");
  fs.writeFileSync("styles.css", banner + css);
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.js"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  // minAppVersion 1.4.0 ships Electron 25 (Chrome 114), so es2022 is safe.
  target: "es2022",
  platform: "browser",
  banner: { js: ritaLazy },
  outfile: "main.js",
  minify: prod,
  sourcemap: prod ? false : "inline",
  logLevel: "info",
});

buildStyles();
if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  // esbuild's watcher only covers the JS module graph; watch the style parts ourselves.
  fs.watch("src/styles", () => {
    try { buildStyles(); console.log("styles.css rebuilt"); }
    catch (e) { console.error("styles.css rebuild failed:", e.message); }
  });
  await ctx.watch();
}