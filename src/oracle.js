"use strict";
const { Notice } = require("obsidian");
const { ORACLE_PATRON_FALLBACK, ORACLE_SYS_FALLBACK } = require("./registries.js");
const { Bag, choiceRules, commaList, pick, randomInterval, tuning } = require("./toolkit.js");
const { feedSpan } = require("./commentfeed.js");
// Oracle: independent feed mode, three message types (SYSTEM/ANON/VIP) generated locally. RiTa = grammar+inflection, compromise = lemmatise input, whichx = classify typed text to a VIP. Only VIP consults typing. Desktop-only.
class Oracle {
    constructor(view) {
        this.view = view;
        this.plugin = view.plugin;
        this.app = view.app;
        // whichx is Oracle's own; RiTa/compromise read through to the shared engine.
        this.WhichX = null;
        this.loaded = false; this.loadFailed = false;
        this.sysBag = new Bag(); this.anonBag = new Bag();
        this.reactionBags = {}; this.asideBags = {};
        // Stop-handles for the three independent source timers.
        this.stops = [];
        // Classifier, the enabled-VIP list it was trained against (index alignment), and the freshest typed-text match { vipIndex, topic, ts }.
        this.clf = null; this.enabledVips = [];
        this.context = null;
        this.editRef = null; this.editTimer = null;
        this.mounted = false;
    }
    get settings() { return this.plugin.settings; }
    get data() { return this.plugin.oracleData; }
    get RiTa() { return this.plugin.riscript.RiTa; }
    get nlp() { return this.plugin.riscript.nlp; }
    // Reconcile to whether Oracle should run; lazy-loads on first run, failure latches.
    async sync(want) {
        if (!this.settings.oracleVipReactsToTyping)
            this.clearTyping();
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
    // --- lazy engine load (desktop only) ---
    async ensure() {
        if (this.loaded) return true;
        try {
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
            new Notice("Character Companion: Oracle mode needs its engine files in the plugin's lib/ folder (desktop only) — see lib/UPDATE.md. (" + e.message + ")", 8000);
            return false;
        }
    }
    // Rebuild derived state after a content edit: snapshot the enabled VIPs (index-aligned classifier labels), retrain whichx on each one's lemmatised topic bank, precompute the shared constant choice-rules. Cheap — safe on every save.
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
        this.staticCtx = choiceRules(this.data.constants);
        this.context = null;
    }
    // --- lifecycle ---
    mount() {
        if (this.mounted) return;
        this.mounted = true;
        // Three independent timers — none waits on or blocks the others.
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
        this.clearTyping();
    }
    clearTyping() {
        if (this.editTimer != null) { this.view.containerEl.win.clearTimeout(this.editTimer); this.editTimer = null; }
        this.context = null;
    }
    range(kind) {
        return { lo: this.settings["oracle" + kind + "MinMs"], hi: this.settings["oracle" + kind + "MaxMs"] };
    }
    // Lemmatise to lower-cased root forms so topics/typed text match across inflections.
    lemma(s) {
        try { const d = this.nlp(s); d.compute("root"); return d.text("root").toLowerCase(); }
        catch { return (s || "").toLowerCase(); }
    }
    // Last salient typed word (>2 letters, alphabetic), base-formed by the compromise pipe.
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
    // A VIP's match-list: the reserved `topic` variable in its vars map.
    syms(vip) { return (vip.vars && vip.vars.topic) || []; }
    // Return the first whole topic-bank phrase present in lemmatised input.
    matchedTopic(vip, text) {
        const words = " " + String(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
        return this.syms(vip).find((topic) => {
            const term = this.lemma(topic).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
            return term && words.includes(" " + term + " ");
        }) || "";
    }
    // Make a word read as a noun for the $topic slot: a bare verb → its gerund, a real noun untouched (natural tagging, no force-tag); the auxiliary compromise prepends ("is killing") is stripped. The single choke point for every $topic source.
    nounify(word) {
        const w = String(word || "").trim();
        try { const g = this.nlp(w).verbs().toGerund().out("array"); if (g.length) return g[0].replace(/^(?:is|are|am)\s+/i, ""); }
        catch { /* tagging failed - fall through to the raw word */ }
        return w;
    }
    // One { singular, plural } patron draw; "Name (Plural)" brackets give a custom plural, else RiTa derives it.
    drawPatron() {
        const pool = commaList(this.settings.oraclePatronName).map((item) => {
            const m = item.match(/^(.*?)\s*\((.+?)\)\s*$/);
            const singular = m ? m[1].trim() : item;
            return { singular, plural: m ? m[2].trim() : this.RiTa.pluralize(singular) };
        });
        return pool.length > 0 ? pick(pool)
            : { singular: ORACLE_PATRON_FALLBACK, plural: this.RiTa.pluralize(ORACLE_PATRON_FALLBACK) };
    }
    // Evaluate one line through the shared engine, layering staticCtx + per-line `extra`.
    evaluate(line, extra) {
        return this.plugin.riscript.evaluate(line, Object.assign({}, this.staticCtx, extra));
    }
    // Push a finished line, guaranteeing terminal punctuation.
    emit(text, cls) {
        const s = (text || "").trim();
        if (!s) return;
        this.view.feed.push(/[.!?…][)"'”’\]]?$/.test(s) ? s : s + ".", cls);
    }
    // SYSTEM and ANON differ only by bag, template list, and bubble class.
    pushPlain(bag, templates, cls) {
        const line = bag.next(templates);
        if (!line) return;
        const p = this.drawPatron();
        this.emit(this.evaluate(line, { system: this.settings.oracleSystemName || ORACLE_SYS_FALLBACK, patron: p.singular, patrons: p.plural }), cls);
    }
    pushVip() {
        if (!this.enabledVips.length) return;
        // React to a fresh typed context if there is one, else an ambient VIP; the VIP's own match-list fills $topic when the context left it empty.
        const ctx = this.settings.oracleVipReactsToTyping && this.context && Date.now() - this.context.ts <= tuning().oracleReactWindow ? this.context : null;
        const vip = (ctx && this.enabledVips[ctx.vipIndex]) || pick(this.enabledVips);
        if (!vip.reactions.length) return;
        const topic = this.nounify((ctx && ctx.topic) || pick(this.syms(vip)));
        const patron = vip.origin || this.drawPatron().singular;
        // `topic` is assigned AFTER choiceRules so the beat's chosen echo wins over the raw vars.topic choice-rule (which would re-pick per reference).
        const vipCtx = Object.assign(choiceRules(vip.vars), { patron, modifier: vip.modifier || vip.name, topic });
        // Sentence 1 carries the JS-built prefix (quoted modifier via feedSpan); follow-ups are bare asides. Only the reaction needs the engine.
        const reaction = this.evaluate((this.reactionBags[vip.name] ??= new Bag()).next(vip.reactions), vipCtx);
        if (!reaction)
            return;
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
    // Match one VIP directly; with several, keep only a classifier result clearing the uniform-confidence baseline.
    classify(editor) {
        this.editTimer = null;
        if (!this.clf || !this.enabledVips.length) return;
        let text = "";
        try { text = editor.getLine(editor.getCursor().line) || ""; } catch { text = ""; }
        const lem = this.lemma(text);
        if (!lem.trim()) return;
        if (this.enabledVips.length === 1) {
            const topic = this.matchedTopic(this.enabledVips[0], lem);
            this.context = topic ? { vipIndex: 0, topic, ts: Date.now() } : null;
            return;
        }
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
        // Echo priority: typed topic-bank word → most recent noun → most recent verb.
        const topic = this.matchedTopic(vip, lem)
            || this.lastTyped(text, (d) => d.match("#Noun").not("#Pronoun").nouns().toSingular())
            || this.lastTyped(text, (d) => d.verbs().toInfinitive());
        this.context = { vipIndex: idx, topic, ts: Date.now() };
    }
}
module.exports = { Oracle };
