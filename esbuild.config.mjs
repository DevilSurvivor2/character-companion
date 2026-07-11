import esbuild from "esbuild";
import process from "process";
import fs from "fs";

const prod = process.argv[2] === "production";

// RiTa is a global-style browser script (it defines a global `RiTa` instead of
// exporting itself). Bundling it as a module breaks that, so we prepend it verbatim —
// but wrapped in a function so its 1.5 MB parses/executes on the FIRST ENGINE USE, not
// at plugin load (V8 only pre-parses an uncalled function body, which keeps Obsidian's
// startup fast). RiScriptEngine.ensure() calls __ccLoadRita() when a feed mode needs it.
// The wrapper must stay the first thing in the output file: rita's tail assigns the bare
// global `RiTa = ...`, which only works while the file is sloppy-mode — with the banner
// first, the bundle's later "use strict" is a plain statement, not a directive.
const ritaGlobal = fs.readFileSync("lib/rita.min.js", "utf8");
const ritaLazy = `var __ccLoadRita = function () {
${ritaGlobal}
;return (typeof RiTa !== "undefined" ? RiTa : globalThis.RiTa);
};
`;

// styles.css is likewise a build artifact: a plain byte-for-byte concatenation of the
// src/styles/ parts in this order (no CSS parser touches it, so the tuning comments and
// custom-property values ship exactly as authored). Edit the parts, never root styles.css.
const STYLE_PARTS = [
  "tuning.css",     // the :root behavioural-constants block tuning() reads
  "panel.css",      // sidebar panel shell: cc-root, icon column, anchor + backdrop
  "effects.css",    // stream special effects (cc-fx-*)
  "sprite.css",     // sprite wrap, root-stage walker, speech bubble, vertical model
  "settings.css",   // pills, tab bar, range sliders, textareas
  "feed.css",       // comment-feed overlay + per-mode bubble styles
  "animations.css", // one block per animation: its class line + its keyframes
  "aesthetics.css", // stream overlay tickers, bottom-bar slot, particles
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
  // minAppVersion 1.4.0 ships Electron 25 (Chrome 114), so es2022 is safe — keeps
  // ??=/?. native instead of transpiled.
  target: "es2022",
  platform: "browser",
  loader: { ".json": "json" },
  banner: { js: ritaLazy },
  outfile: "main.js",
  treeShaking: true,
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