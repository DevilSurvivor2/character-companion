"use strict";
const { Notice } = require("obsidian");
const { ORACLE_PATRON_FALLBACK, ORACLE_SYS_FALLBACK } = require("./registries.js");
const { Bag, choiceRules, commaList, pick, randomInterval, tuning } = require("./toolkit.js");
const { feedSpan } = require("./commentfeed.js");
// Oracle: independent feed mode. Three message types (SYSTEM/ANON/VIP), generated locally. RiTa = grammar+inflection, compromise = lemmatise input, whichx = classify typed line to a VIP. Only VIP consults typing; others are ambient. Desktop-only, self-contained.
class Oracle {
    constructor(view) {
        this.view = view;
        this.plugin = view.plugin;
        this.app = view.app;
        // Engines (lazy): whichx is Oracle's own; RiTa/compromise are read-through getters onto the shared engine (see below). A failed load latches.
        this.WhichX = null;
        this.loaded = false; this.loadFailed = false;
        // Per-type non-repeat bags + per-VIP reaction/aside bags.
        this.sysBag = new Bag(); this.anonBag = new Bag();
        this.reactionBags = {}; this.asideBags = {};
        // Stop-handles for the three independent source timers (filled by mount).
        this.stops = [];
        // Classifier, the enabled-VIP list it was trained against (index alignment), and the freshest typed-text match { vipIndex, symbol, ts }.
        this.clf = null; this.enabledVips = [];
        this.context = null;
        this.editRef = null; this.editTimer = null;
        this.mounted = false;
    }
    get settings() { return this.plugin.settings; }
    // Authored content (templates + VIPs) is owned by the plugin (loaded once, edited in settings, shared by every view), so the Oracle always reads the live model.
    get data() { return this.plugin.oracleData; }
    // RiTa + compromise are owned by the shared RiScript engine — read through, never copied, so there's exactly one loaded instance to reason about.
    get RiTa() { return this.plugin.riscript.RiTa; }
    get nlp() { return this.plugin.riscript.nlp; }
    // Reconcile to whether Oracle should run (oracleEnabled && live). Lazy-loads on first run; a load failure latches so we don't re-prompt every sync.
    async sync(want) {
        if (want) {
            if (this.loadFailed) return;
            if (!this.loaded) {
                const ok = await this.ensure();
                if (!ok || !this.settings.oracleEnabled || !this.view.isLive()) return;
            }
            this.mount();
        }
        else {
            this.unmount();
        }
    }
    // --- lazy engine load (desktop only), the Oracle sibling of riscript.ensure() ---
    async ensure() {
        if (this.loaded) return true;
        try {
            // RiTa + compromise come off the shared engine (loaded once, reused by stream/mail; the getters above read them through); whichx is Oracle's own classifier, required on top.
            if (!(await this.plugin.riscript.ensure()))
                throw new Error("engine unavailable");
            this.WhichX = require("../lib/whichx.js");
            if (!this.WhichX)
                throw new Error("whichx missing");
            this.loaded = true;
            this.rebuild();
            return true;
        }
        catch (e) {
            this.loadFailed = true;
            new Notice("Character Companion: Oracle mode needs its engine files in the plugin's lib/ folder (desktop only) — see lib/README.md. (" + e.message + ")", 8000);
            return false;
        }
    }
    // Rebuild derived state after a content/setting edit: snapshot the enabled VIPs (so the classifier's labels stay index-aligned), retrain whichx on each one's lemmatised topic bank (vars.topic), and precompute the shared constant choice-rules. Cheap — safe to call on every save. A stale typed-context is dropped.
    rebuild() {
        if (!this.loaded) return;
        this.reactionBags = {}; this.asideBags = {};
        this.enabledVips = this.data.vips.filter((v) => v.enabled);
        this.clf = new this.WhichX();
        if (this.enabledVips.length) {
            this.clf.addLabels(this.enabledVips.map((_, i) => "v" + i));
            this.enabledVips.forEach((v, i) => {
                const flat = this.syms(v).join(" ");
                const doc = this.lemma(flat) || flat;
                if (doc.trim()) this.clf.addData("v" + i, doc);
            });
        }
        // The line-invariant half of every template's context: the shared constant choice-rules (fixed until the next rebuild). The verb transforms + generic() are injected by the shared engine's evaluate(), so this is just the constants now.
        this.staticCtx = choiceRules(this.data.constants);
        this.context = null;
    }
    // --- lifecycle ---
    mount() {
        if (this.mounted) return;
        this.mounted = true;
        // Three independent timers — none waits on or blocks the others. SYSTEM and ANON share pushPlain (a bag-drawn template + patron vars); VIP is its own typing-aware beat.
        const beats = [
            ["Sys", () => this.pushPlain(this.sysBag, this.data.sysTemplates, "cc-feed-bubble-sys")],
            ["Anon", () => this.pushPlain(this.anonBag, this.data.anonTemplates, "cc-feed-bubble-anon")],
            ["Vip", () => this.pushVip()],
        ];
        this.stops = beats.map(([kind, fire]) => randomInterval(this.view.containerEl.win, () => this.range(kind), fire));
        // React to typing (debounced); only VIP consults it.
        this.editRef = this.app.workspace.on("editor-change", (editor) => this.onEdit(editor));
    }
    unmount() {
        this.mounted = false;
        this.stops.forEach((stop) => stop());
        this.stops = [];
        if (this.editRef) { this.app.workspace.offref(this.editRef); this.editRef = null; }
        if (this.editTimer != null) { this.view.containerEl.win.clearTimeout(this.editTimer); this.editTimer = null; }
        this.context = null;
    }
    range(kind) {
        return { lo: this.settings["oracle" + kind + "MinMs"], hi: this.settings["oracle" + kind + "MaxMs"] };
    }
    // --- helpers --- Lemmatise to root forms (lower-cased) so Symbols/typed text match across inflections.
    lemma(s) {
        try { const d = this.nlp(s); d.compute("root"); return d.text("root").toLowerCase(); }
        catch { return (s || "").toLowerCase(); }
    }
    // Last salient typed word (>2 letters, alphabetic), base-formed by compromise pipe. Noun or gerund for $topic slot.
    lastTyped(text, pipe) {
        try {
            const out = [];
            for (const ph of pipe(this.nlp(text || "")).out("array"))
                for (const w of String(ph).toLowerCase().split(/\s+/))
                    if (w.length > 2 && /^[a-z]+$/.test(w)) out.push(w);
            return out.length ? out[out.length - 1] : "";
        }
        catch { return ""; }
    }
    // A VIP's match-list: the reserved `topic` variable in its vars map (see VIP_SCHEMA). Feeds classifier training, typed-word matching, and the ambient $topic fallback.
    syms(vip) { return (vip.vars && vip.vars.topic) || []; }
    // Make a word read as a noun for the $topic slot: a bare verb → its gerund ("kill"→"killing", "hunt"→"hunting"), any real noun left untouched. Natural compromise tagging decides (no force-tag), so nouns like "moon" aren't verbed; the auxiliary compromise prepends ("is killing") is stripped. The single choke point for every $topic source — typed word or `topic`-bank pick alike — so verbs echo consistently wherever they live.
    nounify(word) {
        const w = String(word || "").trim();
        try { const g = this.nlp(w).verbs().toGerund().out("array"); if (g.length) return g[0].replace(/^(?:is|are|am)\s+/i, ""); }
        catch { /* tagging failed - fall through to the raw word */ }
        return w;
    }
    // One { singular, plural } patron draw from the comma-separated patron-name field. An optional custom plural comes from "Name (Plural)" brackets, else RiTa derives it; an empty field falls back to ORACLE_PATRON_FALLBACK.
    drawPatron() {
        const pool = commaList(this.settings.oraclePatronName).map((item) => {
            const m = item.match(/^(.*?)\s*\((.+?)\)\s*$/);
            const singular = m ? m[1].trim() : item;
            return { singular, plural: m ? m[2].trim() : this.RiTa.pluralize(singular) };
        });
        return pool.length > 0 ? pick(pool)
            : { singular: ORACLE_PATRON_FALLBACK, plural: this.RiTa.pluralize(ORACLE_PATRON_FALLBACK) };
    }
    // Evaluate one RiScript line through the shared engine (which injects fresh generic fillers + the phrase-head transforms), layering Oracle's precomputed staticCtx (shared constants) and the caller's per-line `extra` (sys/patron/topic, VIP variables) on top.
    evaluate(line, extra) {
        return this.plugin.riscript.evaluate(line, Object.assign({}, this.staticCtx, extra));
    }
    // Push a finished line, guaranteeing terminal punctuation (so templates needn't all end in a period). Leaves an existing . ! ? … (incl. a trailing closing quote/bracket) untouched.
    emit(text, cls) {
        const s = (text || "").trim();
        if (!s) return;
        this.view.feed.push(/[.!?…][)"'”’\]]?$/.test(s) ? s : s + ".", cls);
    }
    // --- generators (the timer entry points) --- SYSTEM and ANON differ only by bag, template list, and bubble class: one bag-drawn template evaluated with the patron + sys vars. (VIP is its own typing-aware beat below.)
    pushPlain(bag, templates, cls) {
        const line = bag.next(templates);
        if (!line) return;
        const p = this.drawPatron();
        this.emit(this.evaluate(line, { system: this.settings.oracleSystemName || ORACLE_SYS_FALLBACK, patron: p.singular, patrons: p.plural }), cls);
    }
    pushVip() {
        if (!this.enabledVips.length) return;
        // Beat-only: react to a fresh typed context (within the react window) if there is one, else an ambient VIP. Either way the VIP's own match-list (vars.topic) fills $topic if the context left it empty, so the echo never runs dry.
        const ctx = this.context && Date.now() - this.context.ts <= tuning().oracleReactWindow ? this.context : null;
        const vip = (ctx && this.enabledVips[ctx.vipIndex]) || pick(this.enabledVips);
        if (!vip.reactions.length) return;
        const topic = this.nounify((ctx && ctx.topic) || pick(this.syms(vip)));
        const patron = vip.origin || this.drawPatron().singular;
        // This VIP's variables ($verb/$manner/…) + per-line vars (frames also reach the shared constants/transforms via evaluate). Reused across sentences — evaluate never mutates it. `topic` is assigned AFTER choiceRules so the beat's chosen echo wins over the raw vars.topic choice-rule (which would otherwise re-pick per reference).
        const vipCtx = Object.assign(choiceRules(vip.vars), { patron, modifier: vip.modifier || vip.name, topic });
        // Sentence 1 carries the prefix; follow-ups are bare asides (per the requested examples). Patron and modifier are already resolved plain strings, so the prefix is built in JS with the quoted modifier wrapped by feedSpan (rendered as .cc-feed-modifier); only the reaction needs the engine. They stay in vipCtx too, so a reaction that references $patron/$modifier still resolves.
        const reaction = this.evaluate((this.reactionBags[vip.name] ??= new Bag()).next(vip.reactions), vipCtx);
        let line = `The ${patron} ${feedSpan(`"${vipCtx.modifier}"`)} ${reaction}.`;
        if (vip.asides.length) {
            const r = Math.random(), t = tuning();
            const aside = () => " " + this.evaluate((this.asideBags[vip.name] ??= new Bag()).next(vip.asides), vipCtx);
            if (r < t.oracleAside2Chance) line += aside();
            if (r < t.oracleAside3Chance) line += aside();
        }
        this.emit(line, "cc-feed-bubble-vip");
    }
    // --- input → VIP context ---
    onEdit(editor) {
        if (!this.settings.oracleVipReactsToTyping) return;
        const win = this.view.containerEl.win;
        if (this.editTimer != null) win.clearTimeout(this.editTimer);
        this.editTimer = win.setTimeout(() => this.classify(editor), tuning().oracleDebounce);
    }
    // Classify the current line to a VIP; store the match only if its confidence clears a multiple of the uniform (1/N) baseline, then pick the topic to echo (see below).
    classify(editor) {
        this.editTimer = null;
        if (!this.clf || !this.enabledVips.length) return;
        let text = "";
        try { text = editor.getLine(editor.getCursor().line) || ""; } catch { text = ""; }
        const lem = this.lemma(text);
        if (!lem.trim()) return;
        let scores;
        try { scores = this.clf.scores(lem); } catch { return; }
        let best = -1, bestKey = null;
        for (const k in scores) if (scores[k] > best) { best = scores[k]; bestKey = k; }
        if (bestKey == null) return;
        const uniform = 1 / this.enabledVips.length;
        if (best < uniform * tuning().oracleMatchFactor) { this.context = null; return; }
        const idx = parseInt(bestKey.slice(1), 10);
        const vip = this.enabledVips[idx];
        if (!vip) return;
        // Echo priority: (1) typed topic-bank word, (2) most recent noun (->singular), (3) most recent verb (->infinitive). nounify() gerundises at emit. Empty -> ambient pick.
        const words = new Set(lem.split(/\s+/));
        const topic = this.syms(vip).find((s) => words.has(this.lemma(s)))
            || this.lastTyped(text, (d) => d.match("#Noun").not("#Pronoun").nouns().toSingular())
            || this.lastTyped(text, (d) => d.verbs().toInfinitive());
        this.context = { vipIndex: idx, topic, ts: Date.now() };
    }
}
module.exports = { Oracle };
