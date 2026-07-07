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

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}