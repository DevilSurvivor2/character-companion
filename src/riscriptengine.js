"use strict";
/* global __ccLoadRita -- defined by the build banner (esbuild.config.mjs): the lazy wrapper around the vendored RiTa script */
const { pick, randInt, randStr, tuning } = require("./toolkit.js");
// Shared RiScript evaluator: lazy-loads RiTa + compromise, owns verb transforms + lexicon fillers. One engine for both Oracle and stream. Desktop-only.
// Pre-pass random-string fillers for codenames/handles (e.g. $<kind><lo-hi>). Case and distribution are baked into the character pools to avoid per-letter calculations.
const _lc = "abcdefghijklmnopqrstuvwxyz", _uc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", _dg = "0123456789";
// 'mix' repeats _dg to give digits ~28% weight (tune by repeating _dg more/fewer times).
const RAND_CHARS = {
    num: _dg,
    let: _lc + _uc, "let-lower": _lc, "let-upper": _uc,
    mix: _lc + _uc + _dg + _dg, "mix-lower": _lc + _dg, "mix-upper": _uc + _dg,
};
// $kind<lo> or $kind<lo-hi>, kind = num | let | mix, each letter kind with an optional -lower/-upper suffix.
const RAND_TOKEN = /\$((?:let|mix)(?:-lower|-upper)?|num)<\s*(\d+)\s*(?:-\s*(\d+)\s*)?>/gi;
class RiScriptEngine {
    constructor(plugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        this.RiTa = null;
        this.nlp = null;
        this.loaded = false;
        this.loadFailed = false;
        this.transforms = null;
    }
    // Load RiTa + compromise once (latches on failure). The FIRST failing call throws so the caller can Notice in its own wording (Oracle vs stream); once latched it just returns false. RiTa powers RiScript-the-grammar + the generic() lexicon fillers; compromise backs the inflection transforms. require() caches, so Oracle's own compromise load shares this module instance at no extra cost.
    async ensure() {
        if (this.loaded) return true;
        if (this.loadFailed) return false;
        try {
            // RiTa's vendored build is a browser IIFE assigning the bare global `RiTa`; the build wraps it in `__ccLoadRita` (see esbuild.config.mjs) so its 1.5 MB only parses+runs HERE, on first engine use, never at plugin load. compromise/whichx are require()d, which esbuild likewise defers to the first call. The typeof guard keeps the unbundled source loadable in headless smoke tests.
            // `window`, never `activeWindow`: rita.min.js's tail assigns the bare global `RiTa` into the plugin's own realm (the main window), which a popout would not see.
            this.RiTa = window.RiTa || (typeof __ccLoadRita === "function" ? __ccLoadRita() : null);
            this.nlp = require("../lib/compromise.js");
            if (!this.RiTa) throw new Error("RiTa missing");
            if (!this.nlp) throw new Error("compromise missing");
            this.transforms = this.buildTransforms();
            this.loaded = true;
            return true;
        }
        catch (e) { this.loadFailed = true; throw e; }
    }
    // Custom RiScript transforms every template can call on a verb-initial phrase. compromise conjugates the HEAD verb and keeps the tail, whole-phrase and irregular-aware ("catch a pokemon" → "caught a pokemon", "see the past" → "saw the past"). It locates + swaps the head itself (no manual string splitting); one .conjugate() call exposes every tense, so a single word is just the tailless case. We force-tag the head as a verb first because compromise's tagger misses bare imperatives ("free all X") without sentence context; a non-verb / missing form returns the phrase unchanged. .ed() → simple past  .ing() → gerund  .s() → 3rd-person sg  .fut() → future
    buildTransforms() {
        const nlp = this.nlp;
        const conj = (phrase, form) => {
            const s = String(phrase).trim();
            if (!s) return s;
            const doc = nlp(s);
            doc.match("^.").tag("Verb");            // force the head to a verb (fixes bare imperatives)
            const forms = doc.verbs().conjugate()[0];
            const w = forms && forms[form];
            if (!w) return doc.text();              // non-verb / no such form → unchanged
            doc.match("^.").replaceWith(w);
            return doc.text();
        };
        return {
            ed: (w) => conj(w, "PastTense"),
            ing: (w) => conj(w, "Gerund"),
            s: (w) => conj(w, "PresentTense"),
            fut: (w) => conj(w, "FutureTense"),
        };
    }
    // One random lexicon word matching `opts` (RiTa.randomWord options: pos / syllables / …), or `def` when randomWord returns falsy or throws (so a caller never gets an empty word). The shared per-draw primitive behind generic()'s fillers and randomHandle()'s word patterns — each call is an independent draw.
    lexWord(opts, def) {
        try { return this.RiTa.randomWord(opts) || def; }
        catch { return def; }
    }
    // Generic lexicon fillers, evaluated per line. $rndGrand is constrained to a 3-syllable adjective for varied vocabulary.
    generic() {
        return {
            rndAdj: this.lexWord({ pos: "jj" }, "strange"),
            rndNoun: this.lexWord({ pos: "nn" }, "thing"),
            rndVerb: this.lexWord({ pos: "vb" }, "stir"),
            rnd: this.lexWord({}, "thing"),
            rndGrand: this.lexWord({ pos: "jj", syllables: 3 }, "magnificent"),
        };
    }
    // Generate a random microblog @handle (used when a blog line names no author), returned WITHOUT the leading "@". One of four word patterns — verb+noun, adj+noun, noun+noun, or a single word — each part an independent capped draw, joined PascalCase ("FerrisWheel"). Then two INDEPENDENT rolls (both CSS tuning knobs): an all-lowercase pass and a trailing 1–N digit run, so "ferriswheel", "FerrisWheel42", and "ferriswheel7" are all reachable. Needs the lexicon loaded for variety; callers skip a handle-less beat until it is.
    randomHandle() {
        const t = tuning();
        const cap = (s) => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
        // Every part is length-capped (maxLength).
        const word = (pos, def) => this.lexWord(pos ? { pos, maxLength: t.blogHandleMaxLen } : { maxLength: t.blogHandleMaxLen }, def);
        const patterns = [
            () => [word("vb", "stir"), word("nn", "thing")],
            () => [word("jj", "strange"), word("nn", "thing")],
            () => [word("nn", "thing"), word("nn", "stuff")],
            () => [word(null, "someone")],
        ];
        let name = pick(patterns)().map(cap).join("");
        if (Math.random() < t.blogHandleLowerChance) name = name.toLowerCase();
        // Trailing digit run shares the $num filler's pool (RAND_CHARS.num) and draw, so "a random digit suffix" is one implementation.
        if (Math.random() < t.blogHandleDigitChance)
            name += randStr(RAND_CHARS.num, randInt(t.blogHandleDigitMin, t.blogHandleDigitMax));
        return name || "someone";
    }
    // A line that references RiScript syntax ([ choices ] or $vars) can't render until RiTa loads: true means "skip this beat" so a source waits for the next rather than pushing raw $vars. A plain line (no [ or $) is always safe. Shared by the stream + mail feed sources.
    pending(line) {
        return /[[$]/.test(line) && !this.loaded;
    }
    // Expand every random-string filler ($num/$let/$mix<…>) in place — a pre-pass before the RiScript grammar (see RAND_CHARS). Each match draws lo..hi chars uniformly from its pool (case is the pool's); a missing hi means an exact length, a reversed lo-hi is swapped. $handle rides the same pre-pass: each occurrence becomes a fresh random username (two $handle = two users), resolving to the bare name — write "@$handle" for a mention — the microblog sibling of these fillers.
    expandRandom(line) {
        line = line.replace(/\$handle\b/g, () => this.randomHandle());
        return line.replace(RAND_TOKEN, (_, kind, loStr, hiStr) => {
            const lo = parseInt(loStr, 10), hi = hiStr != null ? parseInt(hiStr, 10) : lo;
            return randStr(RAND_CHARS[kind.toLowerCase()], randInt(lo, hi));
        });
    }
    // Evaluate one RiScript line against fresh generics + the shared transforms + the caller's context. Returns the raw line unchanged if RiTa isn't loaded or on a parse error, so a bad template (or a pre-load beat) can never throw out of a timer.
    evaluate(line, extra) {
        if (!this.RiTa) return line;
        const expanded = this.expandRandom(line);
        try { return this.RiTa.evaluate(expanded, Object.assign({}, this.generic(), this.transforms, extra)); }
        catch { return line; }
    }
    // evaluate() coerced to a trimmed string ("" on a null/blank result) — the shape every feed source wants for a bubble part.
    evalTrim(line, extra) {
        return (this.evaluate(line, extra) || "").trim();
    }
}
module.exports = { RiScriptEngine };
