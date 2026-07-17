"use strict";
/* global __ccLoadRita -- defined by the build banner (esbuild.config.mjs): the lazy wrapper around the vendored RiTa script */
const { pick, randInt, randStr, tuning } = require("./toolkit.js");
// Shared RiScript evaluator: lazy-loads RiTa + compromise, owns the verb transforms + lexicon fillers. One engine for every feed mode. Desktop-only.
const _lc = "abcdefghijklmnopqrstuvwxyz", _uc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", _dg = "0123456789";
// 'mix' repeats _dg to give digits ~28% weight.
const RAND_CHARS = {
    num: _dg,
    let: _lc + _uc, "let-lower": _lc, "let-upper": _uc,
    mix: _lc + _uc + _dg + _dg, "mix-lower": _lc + _dg, "mix-upper": _uc + _dg,
};
// $kind<lo> or $kind<lo-hi>, kind = num | let | mix, each letter kind with an optional -lower/-upper suffix.
const RAND_TOKEN = /\$((?:let|mix)(?:-lower|-upper)?|num)<\s*(\d+)\s*(?:-\s*(\d+)\s*)?>/gi;
const TEMPLATE_SYNTAX = /(^|[^A-Za-z0-9_])\$[A-Za-z_][\w-]*|\[[^\]\r\n]*\|/;
const UNRESOLVED_SYMBOL = /(^|[^A-Za-z0-9_])\$[A-Za-z_][\w-]*/;
const LITERAL_TILDE = "\uE000", LITERAL_CARET = "\uE001", LITERAL_DOLLAR = "\uE002";
const maskDollar = (line) => line.replaceAll("\\$", LITERAL_DOLLAR);
const restoreLiterals = (line) => line.replaceAll(LITERAL_TILDE, "~").replaceAll(LITERAL_CARET, "^").replaceAll(LITERAL_DOLLAR, "$");
class RiScriptEngine {
    constructor() {
        this.RiTa = null;
        this.nlp = null;
        this.loaded = false;
        this.loadFailed = false;
        this.transforms = null;
    }
    // Load RiTa + compromise once. The FIRST failing call throws so the caller can Notice in its own wording; once latched, later calls just return false.
    async ensure() {
        if (this.loaded) return true;
        if (this.loadFailed) return false;
        try {
            // __ccLoadRita is the build's lazy wrapper (see esbuild.config.mjs): RiTa's 1.5 MB parses+runs HERE, on first engine use, never at plugin load. The typeof guard keeps the unbundled source loadable in headless smoke tests.
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
    // RiScript transforms over a verb-initial phrase: compromise conjugates the HEAD verb and keeps the tail ("catch a pokemon" → "caught a pokemon"). The head is force-tagged as a verb (the tagger misses bare imperatives); a non-verb / missing form returns the phrase unchanged. .ed() past .ing() gerund .s() 3rd-person .fut() future
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
    // One random lexicon word matching `opts` (RiTa.randomWord options), or `def` when randomWord returns falsy or throws.
    lexWord(opts, def) {
        try { return this.RiTa.randomWord(opts) || def; }
        catch { return def; }
    }
    // Generic lexicon fillers, evaluated fresh per line.
    generic() {
        return {
            rndAdj: this.lexWord({ pos: "jj" }, "strange"),
            rndNoun: this.lexWord({ pos: "nn" }, "thing"),
            rndVerb: this.lexWord({ pos: "vb" }, "stir"),
            rnd: this.lexWord({}, "thing"),
            rndGrand: this.lexWord({ pos: "jj", syllables: 3 }, "magnificent"),
        };
    }
    // Random microblog @handle, returned WITHOUT the "@": one of four word patterns joined PascalCase, then two independent rolls — an all-lowercase pass and a trailing digit run — so "ferriswheel", "FerrisWheel42", and "ferriswheel7" are all reachable.
    randomHandle() {
        const t = tuning();
        const cap = (s) => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
        const word = (pos, def) => this.lexWord(pos ? { pos, maxLength: t.blogHandleMaxLen } : { maxLength: t.blogHandleMaxLen }, def);
        const patterns = [
            () => [word("vb", "stir"), word("nn", "thing")],
            () => [word("jj", "strange"), word("nn", "thing")],
            () => [word("nn", "thing"), word("nn", "stuff")],
            () => [word(null, "someone")],
        ];
        let name = pick(patterns)().map(cap).join("");
        if (Math.random() < t.blogHandleLowerChance) name = name.toLowerCase();
        if (Math.random() < t.blogHandleDigitChance)
            name += randStr(RAND_CHARS.num, randInt(t.blogHandleDigitMin, t.blogHandleDigitMax));
        return name || "someone";
    }
    // True = "skip this beat": a templated line can't render until RiTa loads.
    pending(line) {
        return TEMPLATE_SYNTAX.test(maskDollar(String(line ?? ""))) && !this.loaded;
    }
    // Pre-pass before the RiScript grammar: expand every $num/$let/$mix<lo-hi> filler (a missing hi means exact length), and every $handle into a fresh random username.
    expandRandom(line) {
        line = line.replace(/\$handle\b/g, () => this.randomHandle());
        return line.replace(RAND_TOKEN, (_, kind, loStr, hiStr) => {
            const lo = parseInt(loStr, 10), hi = hiStr != null ? parseInt(hiStr, 10) : lo;
            return randStr(RAND_CHARS[kind.toLowerCase()], randInt(lo, hi));
        });
    }
    // Policy: plain text and numeric currency bypass RiTa; \$ escapes a literal symbol; reserved punctuation survives mixed templates; parse errors and unresolved symbols skip the line.
    evaluate(line, extra) {
        const source = String(line ?? "");
        const masked = maskDollar(source);
        if (!TEMPLATE_SYNTAX.test(masked)) return restoreLiterals(masked);
        if (!this.RiTa) return "";
        const expanded = this.expandRandom(masked).replaceAll("~", LITERAL_TILDE).replaceAll("^", LITERAL_CARET);
        try {
            const evaluated = maskDollar(String(this.RiTa.evaluate(expanded, Object.assign({}, this.generic(), this.transforms, extra)) ?? ""));
            return UNRESOLVED_SYMBOL.test(evaluated) ? "" : restoreLiterals(evaluated);
        }
        catch { return ""; }
    }
    // evaluate() coerced to a trimmed string ("" on a null/blank result).
    evalTrim(line, extra) {
        return (this.evaluate(line, extra) || "").trim();
    }
}
module.exports = { RiScriptEngine };
