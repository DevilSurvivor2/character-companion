"use strict";
// Shared free functions: random draws, the timer primitives, CSS tuning access, sprite-path
// resolution, and text utilities. Surface-agnostic — nothing in here may know about a
// specific class; state rides on arguments, never on module state.
// Main-window scoped: the plugin never runs in popout windows, so everything here addresses
// the plugin's own `window`/`document` (or an element's own .win/.doc), never the focused
// `activeWindow`/`activeDocument` — a popout holding focus must not redirect a mount or a measure.
const { TFile, TFolder } = require("obsidian");
// Comma-separated inline text (e.g. "Trickster, Rascal") → a trimmed, non-empty string list.
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
// Uniform random integer in [lo, hi] inclusive (hi floored up to lo, so a reversed range yields lo).
function randInt(lo, hi) {
    return lo + Math.floor(Math.random() * (Math.max(lo, hi) - lo + 1));
}
// One random element of an array (or one random char of a string — both index by .length), or "" when empty. The shared "pick one" primitive behind every random draw.
function pick(a) {
    return a && a.length ? a[Math.floor(Math.random() * a.length)] : "";
}
// A run of n chars drawn independently from pool (a string). Shared by the $num/$let/$mix filler expansion and the blog handle's digit suffix, so "a random digit run" is one implementation.
function randStr(pool, n) {
    let out = "";
    for (let i = 0; i < n; i++) out += pick(pool);
    return out;
}
// Seconds → "HH:MM:SS" (zero-padded), for the stream uptime ticker.
function formatHMS(totalS) {
    const s = Math.max(0, Math.floor(totalS));
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
// Self-rescheduling random timer: waits randRange(lo, hi) ms, fires fn(), repeats. range() is read every cycle so live setting edits apply (hi floored to lo). Returns a stop() handle. The one primitive behind the comment feed and the stream-background cycle.
// `win` is the OWNING window (el.win), captured once by the caller — never `activeWindow` read per call: timer ids are per-window, so a set/clear pair split across two windows would never cancel and the interval would run forever.
function randomInterval(win, range, fn) {
    let timer = null;
    const tick = () => {
        const { lo, hi } = range();
        timer = win.setTimeout(() => { fn(); tick(); }, randRange(lo, Math.max(lo, hi)));
    };
    tick();
    return () => { if (timer != null) win.clearTimeout(timer); };
}
// Reconcile a named self-rescheduling timer to on/off (idempotent — a live timer is left alone). The stop handle lives at host[handle]; range() yields {lo,hi}, fire() runs one tick. The one on/off gate for every randomInterval owner (view feed sources / background cycle, aesthetics tickers).
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
// Resolve a vault-relative path (or bare unique filename) to an image URL, or null. `app` is threaded in from a Component caller — never the discouraged global, and never `this.app`: these are free functions, so under "use strict" `this` is undefined here.
function resolveSpriteUrl(app, path) {
    let file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile))
        file = app.metadataCache.getFirstLinkpathDest(path, "");
    return file instanceof TFile ? app.vault.getResourcePath(file) : null;
}
// Image extensions recognised when a path points at a folder.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const isEmoji = (s) => /^\p{Extended_Pictographic}/u.test(s);

// Emoji -> inline SVG image URL. width/height = intrinsic size (must be large; sprite capped by max-height, never upscaled). font-size vs viewBox: oversized past the box so ink reaches edges.
function emojiUrl(ch) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100"><text x="50" y="45" font-size="101" text-anchor="middle" dominant-baseline="central">${ch}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
// A path field → resolvable image URLs. Comma tells the two forms apart: no comma = a single folder path (every image inside); else comma-separated file paths. An emoji token in either form resolves to an emoji sprite.
function resolvePathList(app, paths) {
    const raw = (paths || "").trim();
    if (!raw)
        return [];
    // No comma = a single folder path (every image inside); an emoji or file path isn't a folder, so it falls through to the split branch below, which resolves the lone token.
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
// Stable identity for a bag item: an object by its id (falling back to its JSON), anything else by string value. Drives both the reshuffle signature and the don't-repeat-the-last-draw check, so object items (rebuilt fresh on every pool call) compare by value, never by reference.
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
        // Reshuffle on a list change or an empty queue; else keep draining.
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
// All behavioural numbers live in styles.css as custom properties (the single source of truth); this reads them. Times are authored in ms; callers divide by 1000 for seconds.
let _tuning = null;
// tuning() returns a Proxy: t.fooBar resolves --cc-foo-bar (camelCase->kebab), cached on first read. CSS-only edit — no JS mirror to keep in sync.
function tuning() {
    if (_tuning)
        return _tuning;
    const cs = window.getComputedStyle(document.documentElement);
    const read = (k) => parseFloat(cs.getPropertyValue("--cc-" + k.replace(/([A-Z])/g, "-$1").toLowerCase()));
    // A hot reload can run this before styles.css is applied (every var reads NaN). Probe one known var; until styles land, hand back a live (uncached) reader so the next call re-reads once they do.
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
// Build an effect from --cc-fx-<key>-* CSS descriptors (-count N, -rand n lo hi per-particle CSS vars, -steps lo hi, -wander dLo dHi xr yr sLo sHi, -layers N). Returns teardown function.
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
    // Optional WAAPI random walk — a unique waypoint count per particle. Travel is % of the anchor, resolved to px at build time.
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
    // Teardown (effects rebuild fresh on refocus, so this suffices).
    return () => {
        for (const a of anims)
            a.cancel();
        for (const n of nodes)
            n.remove();
    };
}
// Run fn as soon as styles.css has landed (tuning() resolves a real number), retrying on rAF until then. Every surface that reads --cc-* numbers at build time (panel render, stage mount) waits behind this, or a hot reload builds it unstyled and it animates into place as the rules arrive.
function whenStyled(fn) {
    if (!isNaN(tuning().ease)) {
        fn();
        return;
    }
    // `window`, not `activeWindow`: a bare one-shot poll with nothing to cancel, and obsidianmd/prefer-window-timers wants timer calls addressed to `window`.
    window.requestAnimationFrame(() => whenStyled(fn));
}
// True only while the MAIN window is foreground and focused — when the loops should run.
// Deliberately the plugin's own `document`, not `activeDocument`: a focused popout counts
// as away (the plugin doesn't run in popouts), so everything pauses while one holds focus.
function appActive() {
    return document.visibilityState !== "hidden" && document.hasFocus();
}
// Best-effort pointer capture (throws if unavailable/already released); swallow so every grab/drag site stays a one-liner.
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
// Fraction (0–1 of natural height) of transparent rows atop a sprite — the gap from image top down to the first coloured pixel. Measured once per URL on an off-screen canvas (vault sprites are same-origin app:// resources, so untainted) and cached (holds the pending Promise while measuring, then the number); blank/unreadable resolves 0. A walker scales it by rendered height to lift the bubble onto the artwork, not the empty box top.
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
                // `|| 0` guards a pre-styles NaN read: without it every `alpha > NaN` is false, every row reads transparent, and frac would be a pathological 1. Threshold 0 (first row with any non-zero alpha) is a sane fallback.
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
// How long a fully-revealed bubble of `text` holds, scaled to its content so short lines clear sooner and long (wrapped) ones linger. `budget` (quoteDurationMs) is spent over exactly one full line: chars-per-full-line = bubble max-width ÷ avg glyph width (--cc-quote-char-em × the bubble's own font-size, so it tracks max-width and theme scale), and the per-char rate falls out as budget ÷ that. Floored at --cc-quote-hold-min so a one-word burst still registers. The one staying-time rule, shared by the walker's speech bubble and the program's bottom-bar bubble.
function bubbleHoldMs(bubbleEl, budget, text) {
    const T = tuning();
    const fontPx = parseFloat(bubbleEl.win.getComputedStyle(bubbleEl).fontSize) || 13;
    const charsPerLine = T.bubbleMaxWidth / (fontPx * T.quoteCharEm);
    const perChar = budget / charsPerLine;
    return Math.max(T.quoteHoldMin, perChar * text.length);
}
// Split a quote into the sentences a walker reveals as consecutive bubbles (quoteTypewriter only). Scans runs of terminators and closes a sentence only where terminatorBreaks says so. A merge pass folds runs shorter than --cc-quote-min-words words together, so a burst like "Whoa! Whoa! Whoa!" reads as one. Pure/static: unit-testable headless (pass an explicit min via mergeShortSentences).
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
            // Keep a closing quote/bracket sitting right on the terminator with its own sentence, so "hi." doesn't strand the " onto the next bubble.
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
// Does the terminator run `run` at [i, end) close the current sentence? ! and ? always do. An ellipsis closes only as a *trailing* mark before a capitalised word. A lone period closes unless it is an abbreviation: an internal dot ("3.5", "google.com"), a known honorific ("Dr.", "Mr."), or an internal initialism dot ("U.S."). Sentence-ending initialisms ("U.F.O.") are allowed to break if followed by a new sentence.
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
// Fold fragments shorter than `min` words forward into the next, so no bubble is a stray one- or two-word burst; a leftover short tail attaches to the previous fragment. Exception: a fragment that trails off with a sentence-final … ("Hey…") is a deliberate beat, not a stray burst, so it always flushes on its own even when short.
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
// {name: [...]} → {name: "[a | b | c]"} RiScript choice rules (skipping empties). One single-item list stays a literal "[a]", which RiScript handles fine. Shared by Oracle (constants / VIP variables) and stream (per-set variables + the $deed/$topic character lists).
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
