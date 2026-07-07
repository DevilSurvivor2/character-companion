# Stream mode engine libraries

These three self-contained files power the stream comment feed.

| File | Source | Loaded as | Used for |
|------|--------|-----------|----------|
| `compromise.js` | `unpkg.com/compromise/builds/compromise.js` (v14, UMD) | `require()` | tokenize + **lemmatize** (root forms) + POS (Oracle input); **conjugate** the phrase-verb transforms (RiScriptEngine) |
| `rita.min.js` | `unpkg.com/rita/dist/rita.min.js` (v3, browser IIFE) | read text + indirect `eval` → `globalThis.RiTa` | RiScript grammar, inflection, lexicon |
| `whichx.js` | `unpkg.com/whichx/dist/index.js` (v3, UMD) | `require()` | naive-Bayes VIP classifier (`scores()` gives confidence) |

`rita.cjs` / `rita.js` are not vendored: they pull external deps (`@ungap/structured-clone`,
`riscript`). Only the browser build `rita.min.js` bundles everything into one file.

## Updating

Re-download the same three URLs. Versions are pinned loosely; verify with:
`node -e "require('./compromise.js'); require('./whichx.js')"` and that `rita.min.js` ends with `RiTa = iife.RiTa`.
