"use strict";
const { ItemView, Notice, setIcon } = require("obsidian");
const { SPECIAL_EFFECTS } = require("./registries.js");
const { Bag, appActive, buildEffect, choiceRules, commaList, pick, randInt, reconcileTimer, resolvePathList, tuning, whenStyled } = require("./toolkit.js");
const { Walker } = require("./walker.js");
const { CommentFeed, parseNewsLine } = require("./commentfeed.js");
const { Aesthetics } = require("./aesthetics.js");
const { Oracle } = require("./oracle.js");
// Sidebar-panel action buttons (vertical icon column down the right edge). Add a row: `run(view)` is the click, optional `active(view)` lights it as a toggle.
const SIDEBAR_BUTTONS = [
    { icon: "shuffle", label: "Show another character", run: (v) => v.pickAnotherCharacter() },
    { icon: "settings", label: "Open plugin settings", run: (v) => v.openPluginSettings() },
    { icon: "radio", label: "Toggle stream mode", run: (v) => v.toggleMode("stream"), active: (v) => v.plugin.settings.streamEnabled },
    { icon: "sparkles", label: "Toggle oracle mode", run: (v) => v.toggleMode("oracle"), active: (v) => v.plugin.settings.oracleEnabled },
    { icon: "mail", label: "Toggle mail mode", run: (v) => v.toggleMode("mail"), active: (v) => v.plugin.settings.mailEnabled },
    { icon: "at-sign", label: "Toggle blog mode", run: (v) => v.toggleMode("blog"), active: (v) => v.plugin.settings.blogEnabled },
    { icon: "newspaper", label: "Toggle news mode", run: (v) => v.toggleMode("news"), active: (v) => v.plugin.settings.newsEnabled },
];
// Feed sources: one row drives bag/stop/timer/sync. pool = draw list (non-repeat via Bag); push = one beat. RiScript-templated. Naming convention (load-bearing — the view wires each row through it): a source's interval settings are `<key>MinMs`/`<key>MaxMs`, its enable flag `<key>Enabled` (all data.json scalars), and the view auto-creates `<key>Bag`/`<key>Stop` per row.
const FEED_SOURCES = [
    // Stream comments: every enabled set's lines pooled flat (a draw is weighted by line count). Each item carries its OWN set so the beat resolves the right per-set vars — provenance rides the pool, never re-derived by search.
    {
        key: "stream",
        pool: (v) => v.plugin.streamData.commentSets.filter((cs) => cs.enabled)
            .flatMap((cs) => cs.comments.map((text) => ({ id: cs.id + "\u0000" + text, set: cs, text }))),
        push: (v, item) => v.pushComment(item),
    },
    // Mail: every enabled Title/From/To/Content template.
    {
        key: "mail",
        pool: (v) => v.plugin.mailData.mailTemplates.filter((m) => m.enabled),
        push: (v, tpl) => v.pushMail(tpl),
    },
    // Blog: the flat microblog line list — no per-line enable flag, the whole list is the pool.
    {
        key: "blog",
        pool: (v) => v.plugin.blogData.messages,
        push: (v, raw) => v.pushBlog(raw),
    },
    // News: a flat headline list (blog's shape), but evaluated against the character context + news constants (mail's recipe). This ONE timer and ONE bag drive news mode's two mutually exclusive faces — a beat either pushes a single headline bubble or hands the chyron a multi-headline strip drawn from the same rotation; pushNews routes on the face switch (newsToFeed).
    {
        key: "news",
        pool: (v) => v.plugin.newsData.messages,
        push: (v, raw) => v.pushNews(raw),
    },
];
const VIEW_TYPE_COMPANION = "character-companion-view";
// Sidebar panel: a single stage-less Walker drawn from sidebar-enabled characters. Owns icon column, stream background, comment feed, and sprite liveness.
class CompanionView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.walker = null;
        this.observer = null;
        // Fires repositionOverlays when the panel's own box changes (split-divider drag) — the case window "resize" / "layout-change" both miss.
        this.resizeObserver = null;
        // Stream state: chat overlay, background-cycle timer + current image + its bag, plus a bag for the "show another character" button.
        this.feed = new CommentFeed(this);
        // The feed is a passive surface; each FEED_SOURCES row owns its own timer (stop handle) and draws without repeats from its own bag. The Oracle owns three more timers of its own.
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
        // Program state: the minute-boundary scheduler's stop handle, and the currently-airing program (null = none) as { url, lines } — url hijacks the stream bg + hides the sprite (paintBackground), lines play one at a time in the bottom slot (Aesthetics.buildProgram) and their completion ends the airing.
        this.programStop = null;
        this.program = null;
        // The aesthetics overlay (tickers + bottom-bar slot + particle layer) — owns its own DOM, timers, and slot occupant; rebuilt per render.
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
        // Pause the sprite (and stream) when the panel is off screen or the window blurred; resume when it returns.
        this.registerDomEvent(activeDocument, "visibilitychange", () => this.sync());
        this.registerDomEvent(activeWindow, "blur", () => this.sync());
        this.registerDomEvent(activeWindow, "focus", () => this.sync());
        // Re-anchor viewport-positioned overlays after panel moves. Three sources: window resize, layout-change, ResizeObserver.
        this.registerDomEvent(activeWindow, "resize", () => this.repositionOverlays());
        this.registerEvent(this.app.workspace.on("layout-change", () => this.repositionOverlays()));
        this.resizeObserver = new ResizeObserver(() => this.repositionOverlays());
        this.resizeObserver.observe(this.contentEl);
        // The now-playing status re-reads the active file on a switch (and on refocus via sync) — no timer of its own, so it isn't sync-gated.
        this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.aesthetics.updateStatus()));
        this.observer = new IntersectionObserver(() => this.sync());
        this.observer.observe(this.contentEl);
        this.render();
    }
    async onClose() {
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
    // Draw a sidebar character into activeCharacterId and return it (null when none are enabled). `avoid` (the current id) is skipped when more than one is enabled: a kept-active render doesn't draw, so the bag's own `last` can drift from activeCharacterId — this re-draw is what keeps "show another" from ever landing back on the current face.
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
    // Icon-column action: draw a different sidebar character; saveDataFile("characterData", true) persists the new active pointer and re-renders the panel(s).
    pickAnotherCharacter() {
        if (this.drawCharacter(this.plugin.characterData.activeCharacterId))
            void this.plugin.saveDataFile("characterData", true);
    }
    // Icon-column action: open this plugin's settings tab.
    // `app.setting` and its open()/openTabById() are UNDOCUMENTED — absent from obsidian.d.ts, so eslint-plugin-obsidianmd's no-unsupported-api would flag them. They are stable in practice and there is no public equivalent (nothing in the API opens a settings tab), so this is a deliberate exception, kept behind the truthiness guard below: if a future release drops or renames `setting`, the button silently no-ops instead of throwing.
    openPluginSettings() {
        const setting = this.app.setting;
        if (!setting)
            return;
        setting.open();
        setting.openTabById(this.plugin.manifest.id);
    }
    // Icon-column action: flip one feed mode's `<key>Enabled` flag and apply it IN PLACE — every mode is only an overlay/feed source (never the sprite's DOM), so sync() reconciles it and relightIconButtons() re-lights the button; no re-render (which would tear the walker down mid-beat). Stream additionally resets its uptime/viewer counters when going live and wakes the sprite either way (streamEnabled forces no-sleep, read live via isAsleep()).
    toggleMode(key) {
        const on = this.settings[key + "Enabled"] = !this.settings[key + "Enabled"];
        if (key === "stream" && on)
            this.aesthetics.resetCounters();
        void this.plugin.saveSettings();
        this.sync();
        this.relightIconButtons();
        if (key === "stream")
            this.walker?.wake();
    }
    // Reflect each toggle button's `active` predicate onto its lit state (initial paint and after an in-place toggle like stream mode).
    relightIconButtons() {
        for (const { def, btn } of this.iconButtons ?? [])
            if (def.active)
                btn.classList.toggle("cc-icon-active", !!def.active(this));
    }
    // Re-anchor the two viewport-positioned overlays (corner feed + fixed sprite bubble) after the panel moves. Harmless when the bubble is hidden — it re-reads its spot on next speak.
    repositionOverlays() {
        this.feed.reposition();
        this.walker?.positionBubble();
    }
    // Tear down the current sprite's timers before a re-render or close. Its bubble lives on <body>, outside the panel root.empty() clears, so drop it explicitly here too.
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
        // A live program is scheduled (any program with a non-zero minute) — drives the airing check + the RiScript engine (its backdrop is templated).
        const programScheduled = live && this.plugin.programData.programs.some((p) => p.schedule > 0);
        if (this.walker)
            live ? this.walker.resumeRest() : this.walker.pauseRest();
        // The feed is shared: mount it while ANY mode wants it, drop it when none do.
        if (anySource || oracleRunning)
            this.feed.mount();
        else
            this.feed.unmount();
        // Load the shared engine (desktop-only) whenever anything on-screen is RiScript-templated: a live feed source (the news beat covers both its faces) or a scheduled program backdrop. A failure latches with a Notice and only the templated lines drop — plain comments still push. Fire-and-forget.
        const wantEngine = anySource || programScheduled;
        if (wantEngine && !this.plugin.riscript.loaded && !this.plugin.riscript.loadFailed)
            this.plugin.riscript.ensure().catch(() => new Notice("Character Companion: stream comment variables need the RiScript engine in lib/ (desktop only). Plain comments still work."));
        // One reconciled random-interval timer per source row (idempotent — a live timer is left alone, see syncTimer).
        for (const s of FEED_SOURCES)
            this.syncTimer(s.key + "Stop", running[s.key],
                () => ({ lo: this.settings[s.key + "MinMs"], hi: this.settings[s.key + "MaxMs"] }),
                () => s.push(this, this[s.key + "Bag"].next(s.pool(this))));
        // The Oracle reconciles its three sources (and lazy-loads its libs) against liveness.
        void this.oracle.sync(oracleRunning);
        // Background-change cycle: paintBackground owns the image and picks it lazily, so pausing this timer freezes the picture rather than swapping it — a refocus keeps the same backdrop.
        this.syncTimer("bgStop", running.stream,
            () => ({ lo: this.settings.streamBgMinMs, hi: this.settings.streamBgMaxMs }),
            () => { this.bgUrl = this.nextBg(); this.paintBackground(); });
        // Program scheduler: a self-realigning tick at each minute boundary (range() re-reads the ms-to-next-minute every cycle) that airs the program whose scheduled minute matches the clock. Off (and any airing ended) when not live.
        this.syncTimer("programStop", programScheduled,
            () => { const ms = 60000 - (Date.now() % 60000); return { lo: ms, hi: ms }; },
            () => this.checkPrograms());
        if (!programScheduled)
            this.endProgram();
        this.paintBackground();
        this.aesthetics.sync();
    }
    // One stream beat: evaluate the drawn line against the character context + its own set's variables (carried on the pool item — see FEED_SOURCES, no reverse lookup), push. Plain lines pass through; unloaded engine -> skip beat.
    pushComment(item) {
        if (!item) return;
        const R = this.plugin.riscript;
        if (R.pending(item.text)) return;
        const ctx = this.charCtx(item.set.vars);
        const line = R.evalTrim(item.text, ctx);
        if (line) this.feed.push(line);
    }
    // Draw a mail template (non-repeat), evaluate Title/From/To/Content as RiScript, push as structured bubble.
    pushMail(tpl) {
        if (!tpl) return;
        const R = this.plugin.riscript;
        if (R.pending(tpl.title + tpl.from + tpl.to + tpl.content)) return;
        const ctx = this.charCtx(this.plugin.mailData.constants);
        const ev = (line, extra) => R.evalTrim(line, extra ? Object.assign({}, ctx, extra) : ctx);
        const title = ev(tpl.title);
        const from = ev(tpl.from);
        const to = ev(tpl.to);
        // Content sees $to too, so the body can repeat the addressee ("Hey $to, ...").
        const content = ev(tpl.content, { to });
        this.feed.push([
            { cls: "title", text: title },
            { cls: "from", text: from && "From: " + from },
            { cls: "to", text: to && "To: " + to },
            { cls: "content", text: content },
        ], "cc-feed-bubble-mail");
    }
    // Draw a blog line (non-repeat), prepend @$handle if needed, split on author/tags/body structure, evaluate as RiScript (pure-ambient, no streamCtx).
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
    // One news beat, dressed by the face switch. Chyron face (default): hand the slot occupant a lazy strip builder — it runs only when the chyron is free, so a busy pass or a missing occupant (mid-program, not live) skips the beat before anything more is drawn or evaluated. Feed face: split off the headline's optional leading [SECTION] (pushBlog's structural split), evaluate section + body against the news context, push as a two-part bubble (the empty-section part self-drops in feed.push). Plain lines pass through; unloaded engine -> skip beat.
    pushNews(raw) {
        if (!raw) return;
        if (!this.settings.newsToFeed) {
            this.aesthetics.chyronPass?.(() => this.chyronStrip(raw));
            return;
        }
        const R = this.plugin.riscript;
        const { section, body } = parseNewsLine(raw);
        if (R.pending(section + " " + body)) return;
        const ctx = this.charCtx(this.plugin.newsData.constants);
        this.feed.push([
            { cls: "section", text: section && R.evalTrim(section, ctx) },
            { cls: "body", text: R.evalTrim(body, ctx) },
        ], "cc-feed-bubble-news");
    }
    // The chyron's content half (the slot occupant is pure display): one pass's strip — the beat's own draw plus up to --cc-news-chyron-max - 1 more from the SAME news bag, so both faces share one non-repeat rotation. Each line's [SECTION] is dropped (the chyron shows headlines, not labels) and its body evaluated against the news context; a line the unloaded engine can't render is skipped. Returns "" when nothing renders — the chyron skips an empty strip.
    chyronStrip(raw) {
        const R = this.plugin.riscript;
        const pool = this.plugin.newsData.messages;
        const ctx = this.charCtx(this.plugin.newsData.constants);
        // A fresh count per pass: anything from a single headline up to the max (capped by the pool).
        const cap = Math.min(tuning().newsChyronMax, pool.length);
        const count = cap > 0 ? randInt(1, cap) : 0;
        const lines = [];
        for (let i = 0; i < count; i++) {
            const { body } = parseNewsLine(i > 0 ? this.newsBag.next(pool) : raw);
            if (!body || R.pending(body)) continue;
            const line = R.evalTrim(body, ctx);
            if (line) lines.push(line);
        }
        return lines.join("  •  ");
    }
    // A character-context evaluation recipe: the shown character's vars (streamCtx) with a mode's own constants/variables map layered on top as choice rules. The one assembly every character-referencing source uses (stream layers its set's vars, mail and news their constants).
    charCtx(vars) {
        return Object.assign({}, this.streamCtx(), choiceRules(vars));
    }
    // Character template vars with safe defaults. Pronouns: slash-sep -> $they/$them/$their (4th/5th -> $theirs/$themself). Deeds/topics: verb-initial phrases for inflection.
    streamCtx() {
        const c = this.getActiveCharacter();
        const name = (c && c.name && c.name.trim()) || "The streamer";
        const pr = ((c && c.pronouns) || "they/them/their").split("/").map((s) => s.trim());
        const deeds = (c && c.deeds && c.deeds.length) ? c.deeds : ["do amazing things"];
        const topics = (c && c.topics && c.topics.length) ? c.topics : ["the stream"];
        const epithets = commaList(c && c.epithet);
        const roles = commaList(c && c.role);
        const ctx = {
            name,
            they: pr[0] || "they", them: pr[1] || pr[0] || "them", their: pr[2] || pr[1] || "their",
        };
        if (pr[3]) ctx.theirs = pr[3];
        if (pr[4]) ctx.themself = pr[4];
        return Object.assign(ctx, choiceRules({
            deed: deeds, topic: topics,
            epithet: epithets.length ? epithets : [name],
            role: roles.length ? roles : ["legend"],
        }));
    }
    // Reconcile one of this view's named timers (feed sources, background cycle) — see reconcileTimer.
    syncTimer(handle, on, range, fire) {
        reconcileTimer(this, this.containerEl.win, handle, on, range, fire);
    }
    // Draw the next backdrop path from the bag over the configured background paths.
    nextBg() {
        return this.bgBag.next(resolvePathList(this.app, this.settings.streamBackgrounds));
    }
    // Program scheduler tick (one per minute boundary): air a program whose scheduled minute matches the clock (`% 60` folds the ":00"-as-60 step back to minute 0 — see PROGRAM_SCHEMA). Only airable candidates (non-empty content) enter the draw, and a same-minute tie is broken at random. Only one airs at a time — an in-progress airing blocks a new trigger. An airing keeps the raw content lines (it lives as long as they take to play — see Aesthetics.buildProgram) and picks + holds ONE resolved backdrop for the whole run (no mid-program switch). The repaint hijacks the backdrop; the aes sync hands the bottom slot to the program occupant, which drives the sequence and calls endProgram when done.
    checkPrograms() {
        if (this.program)
            return;
        const minute = new Date().getMinutes();
        const due = pick(this.plugin.programData.programs.filter((p) => p.schedule > 0 && p.schedule % 60 === minute && p.content.trim()));
        if (!due)
            return;
        const lines = due.content.split("\n").map((s) => s.trim()).filter(Boolean);
        // Background is a plain stream-bg-style field (no RiScript): resolve to image URLs and draw one, held for the whole airing. Null → no backdrop hijack (content plays over the normal scene).
        const bgUrls = resolvePathList(this.app, due.background);
        this.program = { url: bgUrls.length ? pick(bgUrls) : null, lines };
        this.paintBackground();
        this.aesthetics.sync();
    }
    // End the current airing (last line played, or the panel went not-live / closed): drop the airing and reconcile — restore the backdrop + sprite and hand the bottom slot back to whatever else wants it. Idempotent.
    endProgram() {
        if (!this.program)
            return;
        this.program = null;
        this.paintBackground();
        this.aesthetics.sync();
    }
    // Full stream teardown (panel closing): stop every feed source, drop the feed, the background cycle, and every built effect — the last is why a closed panel leaves no live WAAPI drift.
    teardownStream() {
        for (const { key } of FEED_SOURCES)
            this.syncTimer(key + "Stop", false);
        this.syncTimer("bgStop", false);
        this.syncTimer("programStop", false);
        this.endProgram();
        this.oracle.unmount();
        this.feed.unmount();
        this.teardownEffects();
    }
    // Cancel + remove every built effect (WAAPI drifts included) and forget the set. Shared by teardownStream and paintBackground's anchor-change reset.
    teardownEffects() {
        if (!this.builtFx)
            return;
        for (const teardown of this.builtFx.built.values())
            teardown();
        this.builtFx = null;
    }
    // Paint the stream overlay on the current anchor. The backdrop shows whenever streaming (regardless of liveness, picking its first image lazily); effects are gated on `running` (live), torn down when unseen. A live program hijacks the whole backdrop on top of all this.
    paintBackground() {
        const anchor = this.contentEl.querySelector(".cc-anchor");
        if (!anchor)
            return;
        const streaming = this.settings.streamEnabled;
        // Only the shown image needs the reset — the bag reshuffles itself on a source-list change (Bag.next's signature check).
        if (this.bgSig !== this.settings.streamBackgrounds) {
            this.bgSig = this.settings.streamBackgrounds;
            this.bgUrl = null;
        }
        if (streaming && !this.bgUrl)
            this.bgUrl = this.nextBg();
        const running = streaming && this.isLive();
        // A live airing WITH a background hijacks the backdrop: its held image replaces the stream bg and the sprite hides (cc-program) for the airing. A background-less program plays its content bubble over the normal scene (no hijack). Effects (gated on `running`) and aesthetics are untouched — the program only owns the backdrop layer + the sprite's visibility.
        const program = (this.program && this.program.url && this.isLive()) ? this.program.url : null;
        const bg = program || (streaming && this.bgUrl);
        anchor.classList.toggle("cc-streaming", !!bg);
        anchor.classList.toggle("cc-program", !!program);
        anchor.setCssProps({ "--cc-bg": bg ? `url("${bg}")` : "none" });
        // Reconcile effects: toggle each effect's class, build/teardown DOM to match.
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
        whenStyled(() => this.renderNow());
    }
    renderNow() {
        const root = this.contentEl;
        this.cleanupWalker();
        this.teardownEffects();
        // The aesthetics DOM lives under the about-to-be-emptied root, so tear it down first (timers, slot occupant, stale refs); renderBody rebuilds it when there's a sprite.
        this.aesthetics.teardown();
        root.empty();
        root.addClass("cc-root");
        // The icon column is always present (even in empty states) so settings + stream actions stay reachable.
        this.renderIconColumn(root);
        this.renderBody(root);
        // Common tail (no-op in empty states): reconcile sprite + stream to liveness.
        this.sync();
    }
    // Build the panel body: an empty-state message, a "sprite not found" notice, or the anchor + stage-less Walker (speed 0 — rests/animates/reacts, dozes off-stream).
    renderBody(root) {
        const character = this.getActiveCharacter();
        if (!character) {
            root.createDiv({ cls: "cc-empty", text: this.plugin.characterData.characters.length === 0
                    ? "No characters yet. Add one in the plugin settings."
                    : "No characters enabled for the sidebar. Enable some in the Display settings." });
            return;
        }
        const urls = resolvePathList(this.app, character.spritePath);
        if (urls.length === 0) {
            // A root-level notice (like the empty states), NOT inside an anchor: the anchor is built only when there's a real sprite to house, so paintBackground finds none and never paints a stream backdrop behind the error.
            root.createDiv({ cls: "cc-empty", text: 'Sprite not found: "' + character.spritePath + '". Check the path in settings.' });
            return;
        }
        // Sprite height caps the image and sets the bubble's resting height, so it lives on the root for both to inherit.
        root.setCssProps({ "--cc-sprite-max-height": String(this.settings.sidebarSpriteMaxHeight) });
        // The anchor fills the panel and clips the sprite so an idle stroll can walk off one edge and back without the off-screen jump showing.
        const anchor = root.createDiv({ cls: "cc-anchor" });
        const spriteWrap = anchor.createDiv({ cls: "cc-sprite-wrap" });
        const sprite = spriteWrap.createEl("img", { cls: "cc-sprite" });
        // Bubble lives on <body> (same level as the comment feed), NOT inside the panel, so the workspace-leaf frame can never clip it — it stays fully visible even past the panel edge. Being off-panel, root.empty() can't reap it, so cleanupWalker removes it. The walker positions it against the sprite picture (`sprite`) each time it speaks; the view re-runs that on resize/layout-change while it's up.
        const bubble = activeDocument.body.createDiv({ cls: "cc-bubble" });
        this.walker = new Walker(null, this.plugin, character, { wrapEl: spriteWrap, imgEl: sprite, bubbleEl: bubble, bubbleAnchorEl: sprite }, urls, 0);
        // The aesthetics overlay sits on the anchor, above the sprite (its sync gates every piece).
        this.aesthetics.build(anchor);
    }
    // The vertical icon-button column down the right edge (SIDEBAR_BUTTONS): one action each, lit when its `active` predicate holds.
    renderIconColumn(root) {
        const col = root.createDiv({ cls: "cc-icon-col" });
        // Track the live toggle buttons so toggleMode can relight them without re-rendering.
        this.iconButtons = [];
        for (const def of SIDEBAR_BUTTONS) {
            const btn = col.createEl("button", { cls: "cc-icon-btn", attr: { "aria-label": def.label } });
            setIcon(btn, def.icon);
            btn.addEventListener("click", () => def.run(this));
            this.iconButtons.push({ def, btn });
        }
        this.relightIconButtons();
    }
    // Foreground AND actually on screen: a collapsed sidebar / background tab is display:none, so offsetParent is null. Computed fresh so no stale reading wedges it.
    isLive() {
        const el = this.contentEl;
        return appActive() && !!el && el.offsetParent !== null;
    }
}
module.exports = { CompanionView, VIEW_TYPE_COMPANION };
