"use strict";
const { ItemView, Notice, setIcon } = require("obsidian");
const { SPECIAL_EFFECTS } = require("./registries.js");
const { Bag, appActive, buildEffect, choiceRules, commaList, pick, randInt, reconcileTimer, resolvePathList, tuning, whenStyled } = require("./toolkit.js");
const { Walker } = require("./walker.js");
const { CommentFeed } = require("./commentfeed.js");
const { Aesthetics } = require("./aesthetics.js");
const { Oracle } = require("./oracle.js");
// Sidebar-panel action buttons: run(view) is the click, active(view) lights it as a toggle. A row with `children` renders as a group collapsed to its first child; hovering slides it open leftward showing every child (panel.css).
const SIDEBAR_BUTTONS = [
    { icon: "shuffle", label: "Show another character", run: (v) => v.pickAnotherCharacter() },
    { icon: "settings", label: "Open plugin settings", run: (v) => v.openPluginSettings() },
    { children: [
        { icon: "radio", label: "Toggle stream mode", run: (v) => v.toggleMode("stream"), active: (v) => v.plugin.settings.streamEnabled },
        { icon: "sparkles", label: "Toggle oracle mode", run: (v) => v.toggleMode("oracle"), active: (v) => v.plugin.settings.oracleEnabled },
        { icon: "mail", label: "Toggle mail mode", run: (v) => v.toggleMode("mail"), active: (v) => v.plugin.settings.mailEnabled },
        { icon: "at-sign", label: "Toggle blog mode", run: (v) => v.toggleMode("blog"), active: (v) => v.plugin.settings.blogEnabled },
        { icon: "newspaper", label: "Toggle news mode", run: (v) => v.toggleMode("news"), active: (v) => v.plugin.settings.newsEnabled },
    ] },
    { icon: "dices", label: "Toggle roleplay mode", run: (v) => v.toggleMode("roleplay"), active: (v) => v.plugin.settings.roleplayEnabled },
];
// Feed sources: one row drives bag/stop/timer/sync. pool = draw list, push = one beat. Naming convention is load-bearing: interval settings are `<key>MinMs`/`<key>MaxMs`, the enable flag `<key>Enabled`, and the view auto-creates `<key>Bag`/`<key>Stop`.
const FEED_SOURCES = [
    // Stream comments: enabled sets pooled flat; each item carries its own set so the beat resolves the right per-set vars.
    {
        key: "stream",
        pool: (v) => v.plugin.streamData.commentSets.filter((cs) => cs.enabled)
            .flatMap((cs) => cs.comments.map((text) => ({ id: cs.id + "\u0000" + text, set: cs, text }))),
        push: (v, item) => v.pushComment(item),
    },
    {
        key: "mail",
        pool: (v) => v.plugin.mailData.mailTemplates.filter((m) => m.enabled),
        push: (v, tpl) => v.pushMail(tpl),
    },
    {
        key: "blog",
        pool: (v) => v.plugin.blogData.messages,
        push: (v, raw) => v.pushBlog(raw),
    },
    // News: this ONE timer and bag drive both mutually exclusive faces — pushNews routes a beat to a feed bubble or a chyron pass on the newsToFeed switch.
    {
        key: "news",
        pool: (v) => v.plugin.newsData.messages,
        push: (v, raw) => v.pushNews(raw),
    },
];
const VIEW_TYPE_COMPANION = "character-companion-view";
// Sidebar panel: a single stage-less Walker drawn from sidebar-enabled characters. Owns the icon column, stream background, comment feed, and sprite liveness.
class CompanionView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.walker = null;
        this.observer = null;
        // Catches panel-box changes (split-divider drag) that resize/layout-change miss.
        this.resizeObserver = null;
        // The window the panel was last rendered in; onLayoutChange re-renders when the leaf crosses a window boundary.
        this.renderWin = null;
        this.styledStop = null;
        this.feed = new CommentFeed(this);
        // Each FEED_SOURCES row owns its own timer (stop handle) and non-repeat bag.
        for (const { key } of FEED_SOURCES) {
            this[key + "Bag"] = new Bag();
            this[key + "Stop"] = null;
        }
        this.oracle = new Oracle(this);
        this.bgStop = null;
        this.bgUrl = null;
        this.bgSig = "";
        this.bgBag = new Bag();
        this.sidebarBag = new Bag();
        // Show state: the minute-boundary scheduler's stop handle and the airing show (null = none) as { url, lines }.
        this.showStop = null;
        this.show = null;
        // The aesthetics overlay; owns its own DOM and timers, rebuilt per render.
        this.aesthetics = new Aesthetics(this);
    }
    get settings() { return this.plugin.settings; }
    getViewType() {
        return VIEW_TYPE_COMPANION;
    }
    getDisplayText() {
        return "Character companion";
    }
    getIcon() {
        return "ghost";
    }
    async onOpen() {
        // Liveness listeners pin to the MAIN window — the panel only runs there.
        this.registerDomEvent(document, "visibilitychange", () => this.sync());
        this.registerDomEvent(window, "blur", () => this.sync());
        this.registerDomEvent(window, "focus", () => this.sync());
        // Re-anchor viewport-positioned overlays after panel moves.
        this.registerDomEvent(window, "resize", () => this.repositionOverlays());
        this.registerEvent(this.app.workspace.on("layout-change", () => this.onLayoutChange()));
        this.resizeObserver = new ResizeObserver(() => this.repositionOverlays());
        this.resizeObserver.observe(this.contentEl);
        // The now-playing status re-reads the active file on a switch; no timer of its own.
        this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.aesthetics.updateStatus()));
        this.observer = new IntersectionObserver(() => this.sync());
        this.observer.observe(this.contentEl);
        this.render();
    }
    async onClose() {
        if (this.styledStop)
            this.styledStop();
        this.cleanupWalker();
        this.aesthetics.teardown();
        this.teardownStream();
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }
    // The characters eligible for the sidebar (the "Display in sidebar" pills).
    sidebarCharacters() {
        return this.plugin.characterData.characters.filter((c) => c.sidebarEnabled);
    }
    // Draw a sidebar character into activeCharacterId and return it (null when none are enabled). `avoid` is re-drawn past: the bag's own `last` can drift from activeCharacterId, so "show another" must skip the current face explicitly.
    drawCharacter(avoid) {
        const list = this.sidebarCharacters();
        if (list.length === 0)
            return null;
        const ids = list.map((c) => c.id);
        let id = this.sidebarBag.next(ids);
        if (ids.length > 1 && id === avoid)
            id = this.sidebarBag.next(ids);
        this.plugin.characterData.activeCharacterId = id;
        return list.find((c) => c.id === id);
    }
    // The character to show: the active one if still sidebar-enabled, else a fresh draw.
    getActiveCharacter() {
        return this.sidebarCharacters().find((c) => c.id === this.plugin.characterData.activeCharacterId)
            ?? this.drawCharacter(null);
    }
    // Icon-column action: draw a different sidebar character, persist + re-render.
    pickAnotherCharacter() {
        if (this.drawCharacter(this.plugin.characterData.activeCharacterId))
            void this.plugin.saveDataFile("characterData", true);
    }
    // `app.setting` is UNDOCUMENTED but stable, with no public equivalent — a deliberate exception kept behind the truthiness guard so a future removal no-ops, not throws.
    openPluginSettings() {
        const setting = this.app.setting;
        if (!setting)
            return;
        setting.open();
        setting.openTabById(this.plugin.manifest.id);
    }
    // Flip one feed mode's `<key>Enabled` flag and apply it IN PLACE via sync() — no re-render, which would tear the walker down mid-beat. Persists via bare saveData: the immediate sync of every open panel owns the reconcile, and saveSettings' applyChange tail would reconcile the same panels a second time.
    toggleMode(key) {
        const on = this.settings[key + "Enabled"] = !this.settings[key + "Enabled"];
        this.plugin.eachView((view) => {
            if (key === "stream" && on)
                view.aesthetics.resetCounters();
            view.sync();
            if (key === "stream")
                view.walker?.wake();
        });
        void this.plugin.persistSettings();
    }
    // Reflect each toggle button's `active` predicate onto its lit state, on every panel.
    relightIconButtons() {
        for (const { def, btn } of this.iconButtons ?? [])
            if (def.active)
                btn.classList.toggle("cc-icon-active", !!def.active(this));
    }
    // Re-anchor the two viewport-positioned overlays (corner feed + sprite bubble).
    repositionOverlays() {
        this.feed.reposition();
        this.walker?.positionBubble();
    }
    // Re-render only when the leaf crossed a window boundary (renderBody swaps between the real panel and the popout notice); otherwise just re-anchor the overlays.
    onLayoutChange() {
        if (this.contentEl.win !== this.renderWin)
            this.render();
        else
            this.repositionOverlays();
    }
    // The bubble lives on <body>, outside what root.empty() clears, so drop it explicitly.
    cleanupWalker() {
        if (this.walker) {
            this.walker.clearTimers();
            this.walker.bubbleEl.remove();
            this.walker = null;
        }
    }
    // Liveness gate for the panel. Preserved across blur: sprite + background. Torn down: feed + effects.
    sync() {
        const live = this.isLive();
        // Each FEED_SOURCES row reconciles to its `<key>Enabled` flag && live; the Oracle does the same inside its own sync.
        const running = {};
        for (const s of FEED_SOURCES)
            running[s.key] = this.settings[s.key + "Enabled"] && live;
        const anySource = FEED_SOURCES.some((s) => running[s.key]);
        const oracleRunning = this.settings.oracleEnabled && live;
        const showScheduled = live && this.plugin.showData.shows.some((s) => s.schedule > 0);
        if (this.walker)
            live ? this.walker.resumeRest() : this.walker.pauseRest();
        // The feed is shared: mount it while ANY mode wants it, drop it when none do.
        if (anySource || oracleRunning)
            this.feed.mount();
        else
            this.feed.unmount();
        // Load the shared engine (desktop-only) whenever anything on-screen is templated. A failure latches with a Notice; only templated lines drop, plain ones still push.
        const wantEngine = anySource || showScheduled || (this.settings.roleplayEnabled && live);
        if (wantEngine && !this.plugin.riscript.loaded && !this.plugin.riscript.loadFailed)
            this.plugin.riscript.ensure().catch(() => new Notice("Character Companion: templated content needs the RiScript engine in lib/ (desktop only). Plain content still works."));
        // One reconciled random-interval timer per source row.
        for (const s of FEED_SOURCES)
            this.syncTimer(s.key + "Stop", running[s.key],
                () => ({ lo: this.settings[s.key + "MinMs"], hi: this.settings[s.key + "MaxMs"] }),
                () => s.push(this, this[s.key + "Bag"].next(s.pool(this))));
        void this.oracle.sync(oracleRunning);
        // Background cycle: paintBackground picks the image lazily, so pausing this timer freezes the picture — a refocus keeps the same backdrop.
        this.syncTimer("bgStop", running.stream,
            () => ({ lo: this.settings.streamBgMinMs, hi: this.settings.streamBgMaxMs }),
            () => { this.bgUrl = this.nextBg(); this.paintBackground(); });
        // Show scheduler: a self-realigning tick at each minute boundary.
        this.syncTimer("showStop", showScheduled,
            () => { const ms = 60000 - (Date.now() % 60000); return { lo: ms, hi: ms }; },
            () => this.checkShows());
        // A blur (or the last schedule going off) ends any airing; this sync's own tail reconciles the cover + bar — no second pass.
        if (!showScheduled)
            this.show = null;
        this.feed.applyFont();
        this.paintBackground();
        this.aesthetics.sync();
        this.relightIconButtons();
    }
    // One stream beat: evaluate the drawn line against the character context + its own set's variables, push. Unloaded engine -> skip beat.
    pushComment(item) {
        if (!item) return;
        const ctx = this.charCtx(item.set.vars);
        const line = this.plugin.riscript.evalTrim(item.text, ctx);
        if (line) this.feed.push(line);
    }
    // Evaluate a mail template's header plus one blank-line-delimited content episode, push as a structured bubble.
    pushMail(tpl) {
        if (!tpl) return;
        const R = this.plugin.riscript;
        const contentTemplate = pick(tpl.content.split(/\n[ \t]*\n/).map((episode) => episode.trim()).filter(Boolean));
        if (!contentTemplate || R.pending(tpl.title + tpl.from + tpl.to + contentTemplate)) return;
        const ctx = this.charCtx(this.plugin.mailData.constants);
        const ev = (line, extra) => R.evalTrim(line, extra ? Object.assign({}, ctx, extra) : ctx);
        const title = ev(tpl.title);
        const from = ev(tpl.from);
        const to = ev(tpl.to);
        // Content sees $to too, so the body can repeat the addressee ("Hey $to, ...").
        const content = ev(contentTemplate, { to });
        this.feed.push([
            { cls: "title", text: title },
            { cls: "from", text: from && "From: " + from },
            { cls: "to", text: to && "To: " + to },
            { cls: "content", text: content },
        ], "cc-feed-bubble-mail");
    }
    // Prepend @$handle if the line names no author, split on author/tags/body structure, evaluate each part (pure-ambient — no character context).
    pushBlog(raw) {
        if (!raw) return;
        const R = this.plugin.riscript;
        let line = raw.trim();
        if (line[0] !== "@") line = "@$handle " + line;
        if (R.pending(line)) return;
        const toks = line.split(/\s+/);
        let i = 1;
        while (toks[i] && toks[i][0] === "#") i++;
        const ctx = choiceRules(this.plugin.blogData.constants);
        const ev = (s) => R.evalTrim(s, ctx);
        this.feed.push([
            { cls: "handle", text: ev(toks[0]) },
            { cls: "body", text: ev(toks.slice(i).join(" ")) },
            { cls: "tags", text: ev(toks.slice(1, i).join(" ")) },
        ], "cc-feed-bubble-blog");
    }
    // One news beat. Chyron face: when a pass can go out, build a strip and cue it — a beat landing mid-pass or mid-airing is dropped BEFORE any extra draws. Feed face: push the evaluated headline as a two-part bubble.
    pushNews(raw) {
        if (!raw) return;
        if (!this.settings.newsToFeed) {
            if (this.aesthetics.chyronReady())
                this.aesthetics.chyronPass(this.chyronStrip(raw));
            return;
        }
        const h = this.evalNewsLine(raw, this.charCtx(this.plugin.newsData.constants));
        if (h)
            this.feed.push([
                { cls: "section", text: h.section },
                { cls: "body", text: h.body },
            ], "cc-feed-bubble-news");
    }
    // One chyron pass's strip: the beat's own draw plus up to --cc-news-chyron-max - 1 more from the SAME news bag, sections dropped. Returns "" when nothing renders.
    chyronStrip(raw) {
        const pool = this.plugin.newsData.messages;
        const ctx = this.charCtx(this.plugin.newsData.constants);
        const cap = Math.min(tuning().newsChyronMax, pool.length);
        const count = cap > 0 ? randInt(1, cap) : 0;
        const lines = [];
        for (let i = 0; i < count; i++) {
            const h = this.evalNewsLine(i > 0 ? this.newsBag.next(pool) : raw, ctx);
            if (h && h.body) lines.push(h.body);
        }
        return lines.join("  •  ");
    }
    // Evaluate one headline for either face: split the optional leading [SECTION] (a later [a | b] stays a RiScript choice), evaluate each part. Null while a templated line waits on the engine.
    evalNewsLine(raw, ctx) {
        const R = this.plugin.riscript;
        const m = /^\s*\[([^\]]*)\]\s*/.exec(raw);
        const section = m ? m[1].trim() : "";
        const body = (m ? raw.slice(m[0].length) : raw).trim();
        if (!body || R.pending(section + " " + body)) return null;
        return { section: section && R.evalTrim(section, ctx), body: R.evalTrim(body, ctx) };
    }
    // The shown character's vars with a mode's own constants layered on top as choice rules.
    charCtx(vars, character) {
        return Object.assign({}, this.streamCtx(character), choiceRules(vars));
    }
    // Character template vars with safe defaults. Pronouns are slash-separated in subject/object/possessive forms.
    streamCtx(c = this.getActiveCharacter()) {
        const name = (c && c.name && c.name.trim()) || "The streamer";
        const pr = ((c && c.pronouns) || "they/them/their").split("/").map((s) => s.trim());
        const deeds = (c && c.deeds && c.deeds.length) ? c.deeds : ["do amazing things"];
        const topics = (c && c.topics && c.topics.length) ? c.topics : ["the stream"];
        const epithets = commaList(c && c.epithet);
        const roles = commaList(c && c.role);
        const they = pr[0] || "they", them = pr[1] || they || "them", their = pr[2] || them || "their";
        const ctx = {
            name, they, them, their,
            theirs: pr[3] || (their === "his" ? "his" : their + "s"),
            themself: pr[4] || them + "self",
        };
        return Object.assign(ctx, choiceRules({
            deed: deeds, topic: topics,
            epithet: epithets.length ? epithets : [name],
            role: roles.length ? roles : ["legend"],
        }));
    }
    // Reconcile one of this view's named timers — see reconcileTimer.
    syncTimer(handle, on, range, fire) {
        reconcileTimer(this, this.containerEl.win, handle, on, range, fire);
    }
    nextBg() {
        return this.bgBag.next(resolvePathList(this.app, this.settings.streamBackgrounds));
    }
    // Scheduler tick (one per minute boundary): air a show whose minute matches the clock (`% 60` folds the ":00"-as-60 step back to 0), ties broken at random. One airing at a time; it holds ONE backdrop for the whole run, and the show bottom-bar occupant drives the lines and calls endShow when done.
    checkShows() {
        if (this.show)
            return;
        const minute = new Date().getMinutes();
        const due = pick(this.plugin.showData.shows.filter((s) => s.schedule > 0 && s.schedule % 60 === minute && s.content.trim()));
        if (!due)
            return;
        // A blank line separates episodes; one is drawn per airing. Within an episode a single newline separates lines.
        const episode = pick(due.content.split(/\n[ \t]*\n/).map((e) => e.trim()).filter(Boolean));
        if (!episode)
            return;
        const lines = episode.split("\n").map((s) => s.trim()).filter(Boolean);
        // Null url → no backdrop hijack; content plays over the normal scene.
        const bgUrls = resolvePathList(this.app, due.background);
        this.show = { url: bgUrls.length ? pick(bgUrls) : null, lines };
        this.paintBackground();
        this.aesthetics.sync();
    }
    // End the current airing and reconcile the cover layer + bottom bar. Idempotent.
    endShow() {
        if (!this.show)
            return;
        this.show = null;
        this.paintBackground();
        this.aesthetics.sync();
    }
    // Full stream teardown (panel closing) — a closed panel leaves no live WAAPI drift.
    teardownStream() {
        for (const { key } of FEED_SOURCES)
            this.syncTimer(key + "Stop", false);
        this.syncTimer("bgStop", false);
        this.syncTimer("showStop", false);
        this.show = null;
        this.oracle.unmount();
        this.feed.unmount();
        this.teardownEffects();
    }
    // Cancel + remove every built effect (WAAPI drifts included) and forget the set.
    teardownEffects() {
        if (!this.builtFx)
            return;
        for (const teardown of this.builtFx.built.values())
            teardown();
        this.builtFx = null;
    }
    // Paint the stream overlay on the current anchor. The backdrop shows whenever streaming (regardless of liveness); effects are gated on `running` (live). A live airing with a background hijacks the whole scene on top.
    paintBackground() {
        const anchor = this.contentEl.querySelector(".cc-anchor");
        if (!anchor)
            return;
        const streaming = this.settings.streamEnabled;
        // Only the shown image needs the reset — the bag reshuffles itself on a list change.
        if (this.bgSig !== this.settings.streamBackgrounds) {
            this.bgSig = this.settings.streamBackgrounds;
            this.bgUrl = null;
        }
        if (streaming && !this.bgUrl)
            this.bgUrl = this.nextBg();
        const running = streaming && this.isLive();
        const show = (this.show && this.show.url && this.isLive()) ? this.show.url : null;
        anchor.classList.toggle("cc-streaming", !!(streaming && this.bgUrl));
        anchor.setCssProps({ "--cc-bg": streaming && this.bgUrl ? `url("${this.bgUrl}")` : "none" });
        // --cc-show-bg is only ever written, never cleared, so the image survives the cover's own fade-out (the universal hijack transition).
        const cover = anchor.querySelector(".cc-show-cover");
        cover.classList.toggle("cc-hijack-hidden", !show);
        if (show)
            cover.setCssProps({ "--cc-show-bg": `url("${show}")` });
        // Reconcile effects: toggle each class, build/teardown DOM to match.
        if (!this.builtFx || this.builtFx.anchor !== anchor) {
            this.teardownEffects();
            this.builtFx = { anchor, built: new Map() };
        }
        const built = this.builtFx.built;
        for (const fx of SPECIAL_EFFECTS) {
            const want = running && !!this.settings.enabledEffects[fx.key];
            anchor.classList.toggle("cc-fx-" + fx.key, want);
            if (want && !built.has(fx.key))
                built.set(fx.key, buildEffect(anchor, fx.key));
            else if (!want && built.has(fx.key)) {
                built.get(fx.key)();
                built.delete(fx.key);
            }
        }
    }
    render() {
        if (this.styledStop)
            this.styledStop();
        this.styledStop = whenStyled(() => this.renderNow());
    }
    renderNow() {
        const root = this.contentEl;
        this.renderWin = root.win;
        this.cleanupWalker();
        this.teardownEffects();
        // The aesthetics DOM lives under the about-to-be-emptied root; tear it down first.
        this.aesthetics.teardown();
        root.empty();
        root.addClass("cc-root");
        // The icon column is always present so settings + mode actions stay reachable.
        this.renderIconColumn(root);
        this.renderBody(root);
        // Common tail (no-op in empty states): reconcile sprite + stream to liveness.
        this.sync();
    }
    // Build the panel body: an empty-state message, a "sprite not found" notice, or the anchor + stage-less Walker.
    renderBody(root) {
        // A popped-out leaf gets a notice: the bubble and feed live on the main window's <body>, and isLive is false there anyway.
        if (root.win !== window) {
            root.createDiv({ cls: "cc-empty", text: "The companion panel doesn't run in a popout window. Move it back into the main window." });
            return;
        }
        const character = this.getActiveCharacter();
        if (!character) {
            root.createDiv({ cls: "cc-empty", text: this.plugin.characterData.characters.length === 0
                    ? "No characters yet. Add one in the plugin settings."
                    : "No characters enabled for the sidebar. Enable some in the Display settings." });
            return;
        }
        const urls = resolvePathList(this.app, character.spritePath);
        if (urls.length === 0) {
            // Root-level notice, NOT inside an anchor, so paintBackground never paints a stream backdrop behind the error.
            root.createDiv({ cls: "cc-empty", text: "Sprite not found: \"" + character.spritePath + "\". Check the path in settings." });
            return;
        }
        // On the root so both the image cap and the bubble's resting height inherit it.
        root.setCssProps({ "--cc-sprite-max-height": String(this.settings.sidebarSpriteMaxHeight) });
        // The anchor clips the sprite so an idle stroll can walk off one edge and back.
        const anchor = root.createDiv({ cls: "cc-anchor" });
        const spriteWrap = anchor.createDiv({ cls: "cc-sprite-wrap" });
        const sprite = spriteWrap.createEl("img", { cls: "cc-sprite" });
        // Show cover layer, created hidden AFTER the sprite wrap (same z-index — DOM order puts it on top); paintBackground fades it in over sprite + backdrop during an airing.
        anchor.createDiv({ cls: "cc-show-cover cc-hijack cc-hijack-hidden" });
        // Bubble lives on the panel's own <body> so the leaf frame can never clip it; being off-panel, root.empty() can't reap it — cleanupWalker removes it.
        const bubble = root.doc.body.createDiv({ cls: "cc-bubble" });
        this.walker = new Walker(null, this.plugin, character, { wrapEl: spriteWrap, imgEl: sprite, bubbleEl: bubble, bubbleAnchorEl: sprite }, urls, 0);
        this.aesthetics.build(anchor);
    }
    renderIconColumn(root) {
        const col = root.createDiv({ cls: "cc-icon-col" });
        // Track the toggle buttons so sync() can relight them without re-rendering.
        this.iconButtons = [];
        const addButton = (parent, def) => {
            const btn = parent.createEl("button", { cls: "cc-icon-btn", attr: { "aria-label": def.label } });
            setIcon(btn, def.icon);
            btn.addEventListener("click", () => def.run(this));
            this.iconButtons.push({ def, btn });
        };
        for (const def of SIDEBAR_BUTTONS) {
            if (def.children) {
                const group = col.createDiv({ cls: "cc-icon-group" });
                for (const child of def.children)
                    addButton(group, child);
            }
            else
                addButton(col, def);
        }
    }
    // Foreground AND on screen AND in the main window (a collapsed sidebar / background tab is display:none, so offsetParent is null). Computed fresh, never cached.
    isLive() {
        const el = this.contentEl;
        return appActive() && !!el && el.win === window && el.offsetParent !== null;
    }
}
module.exports = { CompanionView, VIEW_TYPE_COMPANION };
