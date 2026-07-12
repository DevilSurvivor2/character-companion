import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";

// Universal seed resolution: `require("virtual:seed-data")` becomes a map keyed by sibling-file name,
// one entry per src/data/*.json. A DATA_FILES row with no inline seed falls back to its entry here;
// no file means no entry means the list ships empty. Drop a <sibling>.json in src/data to ship a default.
const SEED_DATA_DIR = "src/data";
const seedDataPlugin = {
  name: "seed-data",
  setup(build) {
    build.onResolve({ filter: /^virtual:seed-data$/ }, () => ({ path: "seed-data", namespace: "seed-data" }));
    build.onLoad({ filter: /.*/, namespace: "seed-data" }, () => {
      const files = fs.existsSync(SEED_DATA_DIR) ? fs.readdirSync(SEED_DATA_DIR).filter((f) => f.endsWith(".json")) : [];
      const entries = files.map((f) => `  ${JSON.stringify(f)}: require(${JSON.stringify("./" + f)})`);
      return {
        contents: `module.exports = {\n${entries.join(",\n")}\n};\n`,
        resolveDir: path.resolve(SEED_DATA_DIR),
        watchFiles: files.map((f) => path.resolve(SEED_DATA_DIR, f)),
      };
    });
  },
};

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
  plugins: [seedDataPlugin],
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
  // watchFiles covers edits to existing seeds; watch the dir so adding/removing one rebuilds too.
  if (fs.existsSync(SEED_DATA_DIR))
    fs.watch(SEED_DATA_DIR, () => ctx.rebuild().catch((e) => console.error("seed-data rebuild failed:", e.message)));
  await ctx.watch();
}