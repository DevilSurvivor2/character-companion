"use strict";
// Shared free functions, surface-agnostic by rule. Main-window scoped: everything here addresses the plugin's own `window`/`document` (or an element's .win/.doc), never the focused `activeWindow`/`activeDocument` — the plugin doesn't run in popouts.
const { TFile, TFolder } = require("obsidian");
// Comma-separated text → trimmed, non-empty string list.
const commaList = (v) => (v || "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
// Fisher-Yates shuffle in place; returns the same array.
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
// Uniform random in [lo, hi).
function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
}
// Uniform random integer in [lo, hi] inclusive (a reversed range yields lo).
function randInt(lo, hi) {
    return lo + Math.floor(Math.random() * (Math.max(lo, hi) - lo + 1));
}
// One random element of an array (or char of a string), or "" when empty.
function pick(a) {
    return a && a.length ? a[Math.floor(Math.random() * a.length)] : "";
}
// A run of n chars drawn independently from pool (a string).
function randStr(pool, n) {
    let out = "";
    for (let i = 0; i < n; i++) out += pick(pool);
    return out;
}
// Seconds → "HH:MM:SS".
function formatHMS(totalS) {
    const s = Math.max(0, Math.floor(totalS));
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
// Self-rescheduling timer whose range is re-read before each beat.
function randomInterval(win, range, fn) {
    let timer = null;
    let stopped = false;
    const tick = () => {
        if (stopped)
            return;
        const { lo, hi } = range();
        timer = win.setTimeout(() => {
            timer = null;
            try { fn(); }
            finally { tick(); }
        }, randRange(lo, Math.max(lo, hi)));
    };
    tick();
    return () => {
        stopped = true;
        if (timer != null) win.clearTimeout(timer);
        timer = null;
    };
}
// Reconcile a named randomInterval at host[handle] to on/off (idempotent — a live timer is left alone).
function reconcileTimer(host, win, handle, on, range, fire) {
    if (on === (host[handle] != null))
        return;
    if (on)
        host[handle] = randomInterval(win, range, fire);
    else {
        host[handle]();
        host[handle] = null;
    }
}
// Resolve a vault-relative path (or bare unique filename) to an image URL, or null.
function resolveSpriteUrl(app, path) {
    let file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile))
        file = app.metadataCache.getFirstLinkpathDest(path, "");
    return file instanceof TFile ? app.vault.getResourcePath(file) : null;
}
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const isEmoji = (s) => /^\p{Extended_Pictographic}/u.test(s);

// Emoji -> inline SVG image URL. Intrinsic size must be large (the sprite is capped by max-height, never upscaled); font-size oversized past the viewBox so ink reaches edges.
function emojiUrl(ch) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100"><text x="50" y="45" font-size="101" text-anchor="middle" dominant-baseline="central">${ch}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
// A path field → resolvable image URLs: no comma = a single folder path (every image inside), else comma-separated file paths; emoji tokens resolve to emoji sprites.
function resolvePathList(app, paths) {
    const raw = (paths || "").trim();
    if (!raw)
        return [];
    // A lone non-folder token falls through to the split branch below.
    if (!raw.includes(",")) {
        const folder = app.vault.getAbstractFileByPath(raw);
        if (folder instanceof TFolder) {
            return folder.children
                .filter((f) => f instanceof TFile && IMAGE_EXTS.has(f.extension.toLowerCase()))
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((f) => app.vault.getResourcePath(f));
        }
    }
    return commaList(raw)
        .map((p) => isEmoji(p) ? emojiUrl(p) : resolveSpriteUrl(app, p))
        .filter((u) => u !== null);
}
// Stable identity for a bag item — object items are rebuilt per pool call, so they must compare by value (id / JSON), never by reference.
const bagKey = (item) => item && typeof item === "object" ? (item.id ?? JSON.stringify(item)) : String(item);
// Non-repeating random picker: draws every item once before repeating; reshuffles when the queue empties or the source list changes.
class Bag {
    constructor() {
        this.queue = [];
        this.signature = null;
        this.last = null;
    }
    next(items) {
        if (!items || items.length === 0)
            return null;
        const signature = items.map(bagKey).join("\u0000");
        if (signature !== this.signature || this.queue.length === 0) {
            this.signature = signature;
            this.queue = shuffle(items.slice());
            // Don't let a fresh shuffle repeat the item we just drew.
            if (this.queue.length > 1 && bagKey(this.queue[0]) === this.last)
                this.queue.push(this.queue.shift());
        }
        const drawn = this.queue.shift();
        this.last = bagKey(drawn);
        return drawn;
    }
}
let _tuning = null;
// Reader over the --cc-* behavioural numbers in styles.css: t.fooBar resolves --cc-foo-bar, cached on first read. Times are ms; callers ÷1000 for seconds.
function tuning() {
    if (_tuning)
        return _tuning;
    const cs = window.getComputedStyle(document.documentElement);
    const read = (k) => parseFloat(cs.getPropertyValue("--cc-" + k.replace(/([A-Z])/g, "-$1").toLowerCase()));
    // Before styles.css lands (hot reload) every var reads NaN: hand back an uncached reader so a later call re-reads once styles apply.
    if (isNaN(read("ease")))
        return new Proxy({}, { get: (_t, k) => (typeof k === "string" ? read(k) : undefined) });
    const cache = {};
    _tuning = new Proxy(cache, {
        get(target, k) {
            if (typeof k !== "string")
                return target[k];
            if (!(k in target))
                target[k] = read(k);
            return target[k];
        },
    });
    return _tuning;
}
// Build an effect from --cc-fx-<key>-* CSS descriptors (-count N, -rand n lo hi per-particle CSS vars, -steps lo hi, -wander dLo dHi xr yr sLo sHi, -layers N). Returns a teardown.
function buildEffect(anchor, key) {
    const cs = anchor.win.getComputedStyle(anchor);
    const prop = (suffix) => cs.getPropertyValue("--cc-fx-" + key + "-" + suffix).trim();
    const floats = (s) => s.split(/[\s,]+/).map(parseFloat).filter((n) => !isNaN(n));
    // -rand → [{name, lo, hi}], each rolled value landing on `--name`.
    const rand = prop("rand").split(",").map((s) => s.trim()).filter(Boolean).map((item) => {
        const [name, lo, hi] = item.split(/\s+/);
        return { name, lo: parseFloat(lo), hi: parseFloat(hi) };
    }).filter((r) => r.name && !isNaN(r.lo) && !isNaN(r.hi));
    const steps = floats(prop("steps")); // [lo, hi]
    const wander = floats(prop("wander")); // [dLo, dHi, xr, yr, sLo, sHi]
    const nodes = [];
    const anims = [];
    // Optional WAAPI random walk; travel is % of the anchor, resolved to px at build time.
    const startWander = (el) => {
        if (steps.length < 2 || wander.length < 6)
            return;
        const [dLo, dHi, xr, yr, sLo, sHi] = wander;
        const w = anchor.clientWidth, h = anchor.clientHeight;
        const stops = Math.round(randRange(steps[0], steps[1]));
        const frames = [];
        for (let i = 0; i <= stops; i++) {
            const x = (Math.random() * 2 - 1) * (xr / 100) * w;
            const y = (Math.random() * 2 - 1) * (yr / 100) * h;
            frames.push({ transform: `translate(${x}px, ${y}px) scale(${randRange(sLo, sHi)})` });
        }
        anims.push(el.animate(frames, {
            duration: randRange(dLo, dHi) * 1000,
            iterations: Infinity,
            direction: "alternate",
            easing: "ease",
        }));
    };
    // Particles: N children, each with its own rolled vars and drift path.
    for (let i = 0, n = parseInt(prop("count"), 10); i < n; i++) {
        const el = anchor.createDiv({ cls: "cc-fx-particle cc-fx-" + key + "-particle" });
        for (const r of rand)
            el.setCssProps({ ["--" + r.name]: String(randRange(r.lo, r.hi)) });
        startWander(el);
        nodes.push(el);
    }
    // Singleton overlay layers, each styled individually. NaN when undeclared → skipped.
    for (let i = 0, n = parseInt(prop("layers"), 10); i < n; i++)
        nodes.push(anchor.createDiv({ cls: "cc-fx-layer cc-fx-" + key + "-layer cc-fx-" + key + "-layer-" + i }));
    return () => {
        for (const a of anims)
            a.cancel();
        for (const n of nodes)
            n.remove();
    };
}
// Run fn once styles.css has landed; returns a cancellation handle for a pending rAF retry.
function whenStyled(fn) {
    let frame = null;
    let stopped = false;
    const cancel = () => {
        stopped = true;
        if (frame !== null)
            window.cancelAnimationFrame(frame);
    };
    const check = () => {
        frame = null;
        if (stopped)
            return;
        if (!isNaN(tuning().ease)) {
            fn();
            return;
        }
        frame = window.requestAnimationFrame(check);
    };
    check();
    return cancel;
}
// True only while the MAIN window is foreground and focused (a focused popout counts as away — the plugin doesn't run in popouts).
function appActive() {
    return document.visibilityState !== "hidden" && document.hasFocus();
}
// Best-effort pointer capture/release (throws if unavailable/already released).
function capturePointer(el, id) {
    try {
        el.setPointerCapture(id);
    }
    catch { /* unavailable or already captured — fine */ }
}
function releasePointer(el, id) {
    try {
        el.releasePointerCapture(id);
    }
    catch { /* already released — fine */ }
}
// Fraction (0–1 of natural height) of transparent rows atop a sprite, measured once per URL on an off-screen canvas and cached (the pending Promise while measuring, then the number); blank/unreadable resolves 0. Lifts the bubble onto the artwork, not the box top.
const _spriteInsetCache = new Map();
function spriteTopInsetFraction(url) {
    if (!url)
        return Promise.resolve(0);
    const cached = _spriteInsetCache.get(url);
    if (cached !== undefined)
        return Promise.resolve(cached);
    const p = new Promise((resolve) => {
        const img = document.createElement("img");
        img.onload = () => {
            let frac = 0;
            try {
                const w = img.naturalWidth, h = img.naturalHeight;
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                ctx.drawImage(img, 0, 0);
                const data = ctx.getImageData(0, 0, w, h).data;
                // `|| 0` guards a pre-styles NaN read (alpha > NaN is always false).
                const minAlpha = (tuning().bubbleInsetAlpha || 0) * 255;
                let row = 0;
                for (; row < h; row++) {
                    let opaque = false;
                    for (let x = 0; x < w; x++) {
                        if (data[(row * w + x) * 4 + 3] > minAlpha) { opaque = true; break; }
                    }
                    if (opaque)
                        break;
                }
                frac = h > 0 ? row / h : 0;
            }
            catch { frac = 0; }
            _spriteInsetCache.set(url, frac);
            resolve(frac);
        };
        img.onerror = () => { _spriteInsetCache.set(url, 0); resolve(0); };
        img.src = url;
    });
    _spriteInsetCache.set(url, p);
    return p;
}
// Bubble staying time, scaled to content: `budget` (quoteDurationMs) is spent over exactly one full line (bubble max-width ÷ avg glyph width), floored at --cc-quote-hold-min.
function bubbleHoldMs(bubbleEl, budget, text) {
    const T = tuning();
    const fontPx = parseFloat(bubbleEl.win.getComputedStyle(bubbleEl).fontSize) || 13;
    const charsPerLine = T.bubbleMaxWidth / (fontPx * T.quoteCharEm);
    const perChar = budget / charsPerLine;
    return Math.max(T.quoteHoldMin, perChar * text.length);
}
// Split a quote into the sentences the typewriter reveals as consecutive bubbles: close a sentence where terminatorBreaks says so, then merge runs shorter than --cc-quote-min-words.
function splitQuote(text) {
    const s = (text || "").replace(/\.{2,}/g, "…").trim();
    if (!s)
        return [];
    const frags = [];
    let start = 0;
    const re = /[.!?…]+/g;
    let m;
    while ((m = re.exec(s))) {
        const end = m.index + m[0].length;
        if (terminatorBreaks(s, m.index, m[0], end)) {
            // Keep a closing quote/bracket on the terminator with its own sentence.
            let e = end;
            while (e < s.length && /['"”’»)\]]/.test(s[e])) e++;
            frags.push(s.slice(start, e).trim());
            start = e;
        }
    }
    if (start < s.length) {
        const tail = s.slice(start).trim();
        if (tail) frags.push(tail);
    }
    return mergeShortSentences(frags, tuning().quoteMinWords);
}
// Does the terminator run at [i, end) close the current sentence? ! ? always; an ellipsis only as a trailing mark before a capital; a period unless it's an abbreviation (internal dot, honorific, or initialism dot).
function terminatorBreaks(s, i, run, end) {
    if (/[!?]/.test(run)) {
        let j = end;
        while (j < s.length && /['"“‘«)\]]/.test(s[j])) j++;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (j < s.length && /\p{Ll}/u.test(s[j])) return false;
        return true;
    }
    if (run.includes("…")) {
        if (i === 0 || /\s/.test(s[i - 1])) return false;
        let j = end;
        while (j < s.length && /\s/.test(s[j])) j++;
        while (j < s.length && s[j] === "…") { j++; while (j < s.length && /\s/.test(s[j])) j++; }
        if (j < s.length && /['"“‘«(]/.test(s[j])) j++;
        return j >= s.length || /\p{Lu}/u.test(s[j]);
    }
    if (/[\p{L}\p{N}]/u.test(s[end] || "")) return false;
    const prevMatch = s.slice(0, i).match(/[\p{L}]+$/u);
    const prevWord = prevMatch ? prevMatch[0] : "";
    const abbreviations = new Set(["mr", "mrs", "ms", "mx", "dr", "prof", "rev", "capt", "gen", "col", "maj", "sgt", "st", "mt", "lt", "cmdr", "gov", "sen", "rep", "jr", "sr", "etc", "vs", "al", "approx", "ave", "blvd", "dept", "est", "inc", "misc"]);
    if (abbreviations.has(prevWord.toLowerCase())) return false;
    if (prevWord.length === 1) {
        let j = end;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (j < s.length && /['"“‘«(]/.test(s[j])) j++;    
        if (/\p{Ll}/u.test(s[j] || "")) return false;
        if (s.slice(j).match(/^\p{Lu}\./u)) return false;
        return true;
    }
    return true;
}
// Fold fragments shorter than `min` words forward into the next; a leftover short tail attaches to the previous fragment. A sentence-final … always flushes on its own.
function mergeShortSentences(frags, min) {
    const out = [];
    let buf = "";
    for (const f of frags) {
        buf = buf ? buf + " " + f : f;
        if (buf.split(/\s+/).filter(Boolean).length >= min || /…["'”’»)\]]*$/.test(buf)) {
            out.push(buf);
            buf = "";
        }
    }
    if (buf)
        out.length ? (out[out.length - 1] += " " + buf) : out.push(buf);
    return out;
}
// {name: [...]} → {name: "[a | b | c]"} RiScript choice rules (skipping empties).
function choiceRules(map) {
    const out = {};
    for (const k of Object.keys(map || {})) {
        const a = (map[k] || []).filter((x) => typeof x === "string" && x.trim());
        if (a.length) out[k] = "[" + a.join(" | ") + "]";
    }
    return out;
}
module.exports = {
    Bag, appActive, bubbleHoldMs, buildEffect, capturePointer, choiceRules, commaList,
    formatHMS, pick, randInt, randRange, randStr, randomInterval, reconcileTimer,
    releasePointer, resolvePathList, shuffle, splitQuote, spriteTopInsetFraction,
    tuning, whenStyled,
};
