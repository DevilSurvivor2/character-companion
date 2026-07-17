"use strict";
const { setIcon } = require("obsidian");
const { AESTHETICS } = require("./registries.js");
const { bubbleHoldMs, formatHMS, pick, randRange, reconcileTimer, shuffle, tuning } = require("./toolkit.js");
// Parse one source-stamped roleplay graph snapshot; valid means it has a reachable root level.
function parseRoleplayGraph(text) {
    const source = String(text || "");
    const children = new Map();
    const isChild = new Set();
    const order = [];
    for (const line of source.split("\n")) {
        const sets = line.split(">").map((part) => {
            part = part.trim();
            const inner = part.startsWith("{") && part.endsWith("}") ? part.slice(1, -1).split(",") : [part];
            return inner.map((s) => s.trim()).filter(Boolean);
        }).filter((set) => set.length > 0);
        for (const set of sets)
            for (const name of set)
                if (!order.includes(name))
                    order.push(name);
        for (let i = 0; i + 1 < sets.length; i++)
            for (const parent of sets[i]) {
                const kids = children.get(parent) ?? [];
                children.set(parent, kids);
                for (const kid of sets[i + 1]) {
                    isChild.add(kid);
                    if (!kids.includes(kid))
                        kids.push(kid);
                }
            }
    }
    const roots = order.filter((n) => !isChild.has(n));
    return { source, valid: roots.length > 0, roots, children };
}
// Bottom-bar occupants — the bar shows exactly ONE at a time; the LAST wanting row wins (row order is the override order: Stream → Roleplay → News → Show). Every handover runs the one universal hijack fade (cc-hijack / cc-hijack-hidden). Each row's element is built ONCE per render into the bar's single grid cell — build(aes, bar) returns { el, start?, sync?, stop? } — and a handover only toggles visibility, so nothing is wiped (the react bar keeps its half-typed comment). stop MUST leave no running timer/WAAPI animation behind; a liveOnly row can't hold the bar while the panel isn't live.
const BOTTOM_OCCUPANTS = [
    // Stream: the fake react bar — the bar's resting holder.
    { key: "stream", wants: (a) => a.settings.streamEnabled && !!a.settings.enabledAesthetics.react, build: (a, bar) => a.buildReactBar(bar) },
    // Roleplay: the GM option row — holds the live bar while the mode has a valid root level.
    { key: "roleplay", wants: (a) => a.settings.roleplayEnabled && a.getRoleplayGraph().valid, build: (a, bar) => a.buildRoleplay(bar), liveOnly: true },
    // News: the chyron — pure display, no timer; wants the bar only while a pass is in flight.
    { key: "news", wants: (a) => a.chyronMode() && a.chyronOn, build: (a, bar) => a.buildChyron(bar), liveOnly: true },
    // Show: an airing's content, one line at a time; the sequence ends the airing.
    { key: "show", wants: (a) => !!a.view.show, build: (a, bar) => a.buildShow(bar), liveOnly: true },
];
// The in-panel overlay riding the stream anchor: corner tickers, bottom bar, particle layer. The view owns liveness and calls sync(); this owns its DOM and timers. Rebuilt per render; the ticker counters live on the instance so they survive a blur.
class Aesthetics {
    constructor(view) {
        this.view = view;
        this.plugin = view.plugin;
        // DOM refs (null while unbuilt).
        this.els = null;
        this.win = null;
        // The two sync-gated tickers' stop handles + live counters.
        this.uptimeStop = null;
        this.uptimeS = 0;
        this.viewerStop = null;
        this.viewerCount = null;
        // Per-row occupant handles and the row currently holding the bar (null = empty).
        this.bottomEls = null;
        this.bottomKey = null;
        // wants() and the occupant share this single validated snapshot.
        this.roleplayGraph = parseRoleplayGraph(this.plugin.roleplayData.structure);
        // chyronOn marks a pass in flight (read by the news row's wants); the scroll anim and track live in the occupant's handle.
        this.chyronOn = false;
        this.particles = new Set();
    }
    get settings() { return this.plugin.settings; }
    syncTimer(handle, on, range, fire) {
        reconcileTimer(this, this.win, handle, on, range, fire);
    }
    getRoleplayGraph() {
        const source = String(this.plugin.roleplayData.structure || "");
        if (source !== this.roleplayGraph.source)
            this.roleplayGraph = parseRoleplayGraph(source);
        return this.roleplayGraph;
    }
    // Build the overlay DOM onto the stream anchor. Visibility is reconciled by sync().
    build(anchor) {
        const els = { root: anchor.createDiv({ cls: "cc-aes" }) };
        this.els = els;
        this.win = anchor.win;
        const top = els.root.createDiv({ cls: "cc-aes-top" });
        const stats = top.createDiv({ cls: "cc-aes-stats" });
        // One ticker = an icon + text pill registered under its key; returns the text span.
        const ticker = (parent, key, icon) => {
            const pill = parent.createDiv({ cls: "cc-aes-ticker cc-aes-" + key });
            setIcon(pill.createSpan({ cls: "cc-aes-ticker-icon" }), icon);
            els[key] = pill;
            return pill.createSpan({ cls: "cc-aes-ticker-text" });
        };
        els.uptimeEl = ticker(stats, "uptime", "clock");
        els.viewerEl = ticker(stats, "viewer", "drama");
        ticker(top, "profile", "user-round").setText(this.view.walker?.character?.name ?? "");
        els.statusEl = ticker(top, "status", "music");
        // Every occupant's element is built now (hidden); syncBottom hands the bar around.
        const bar = els.root.createDiv({ cls: "cc-aes-bottom" });
        this.bottomEls = {};
        for (const row of BOTTOM_OCCUPANTS)
            this.bottomEls[row.key] = row.build(this, bar);
        this.bottomKey = null;
        els.fx = els.root.createDiv({ cls: "cc-aes-fx" });
        if (this.viewerCount === null)
            this.resetCounters();
        else
            this.renderCounters();
    }
    // Reconcile ticker visibility, the bottom bar, and the two sync-gated ticker timers.
    sync() {
        const els = this.els;
        if (!els || !els.root.isConnected)
            return;
        els.root.setCssProps({ "--cc-stream-font": this.settings.commentFont || "" });
        const streaming = this.settings.streamEnabled;
        const en = this.settings.enabledAesthetics;
        const live = this.view.isLive();
        const show = (key) => streaming && !!en[key];
        // The wrapper shows if any piece (ticker or bottom-bar occupant) does.
        let any = false;
        for (const a of AESTHETICS) {
            // A key without its own element ("react") lives in the bottom bar.
            if (!els[a.key])
                continue;
            const on = show(a.key);
            any = any || on;
            els[a.key].classList.toggle("cc-hidden", !on);
        }
        any = this.syncBottom() || any;
        els.root.classList.toggle("cc-aes-on", any);
        // Run the two ticker timers while live + shown, freeze otherwise (fixed-interval, so lo === hi).
        this.syncTimer("uptimeStop", live && show("uptime"), () => ({ lo: 1000, hi: 1000 }), () => {
            this.uptimeS += 1;
            this.renderCounters();
        });
        this.syncTimer("viewerStop", live && show("viewer"), () => ({ lo: tuning().aesViewerInterval, hi: tuning().aesViewerInterval }), () => {
            // One drift tick: a small wobble plus an occasional spike; never below the floor.
            const t = tuning();
            let delta = Math.round(randRange(-t.aesViewerDelta, t.aesViewerDelta));
            if (Math.random() < t.aesViewerSpikeChance)
                delta += Math.round(randRange(t.aesViewerSpikeMin, t.aesViewerSpikeMax));
            this.viewerCount = Math.max(Math.round(t.aesViewerFloor), this.viewerCount + delta);
            this.renderCounters();
        });
        if (show("status"))
            this.updateStatus();
        if (!live || !show("react"))
            this.clearParticles();
    }
    // Hand the bottom bar to the LAST wanting, live-eligible row: stop the loser, toggle cc-hijack-hidden, then run the winner's start(). Returns whether any row holds the bar.
    syncBottom() {
        const live = this.view.isLive();
        const winner = [...BOTTOM_OCCUPANTS].reverse().find((r) => r.wants(this) && (!r.liveOnly || live));
        const key = winner ? winner.key : null;
        if (key !== this.bottomKey) {
            if (this.bottomKey)
                this.bottomEls[this.bottomKey].stop?.();
            this.bottomKey = key;
            for (const row of BOTTOM_OCCUPANTS)
                this.bottomEls[row.key].el.classList.toggle("cc-hijack-hidden", row.key !== key);
            if (key)
                this.bottomEls[key].start?.();
        }
        else if (key)
            this.bottomEls[key].sync?.();
        return this.bottomKey !== null;
    }
    // "stream" occupant: the fake react bar — comment box + gift/like buttons. Static DOM with no ambient animation, so it needs no start/stop.
    buildReactBar(bar) {
        const react = bar.createDiv({ cls: "cc-aes-react cc-hijack cc-hijack-hidden" });
        const comment = react.createDiv({ cls: "cc-aes-comment" });
        const input = comment.createEl("input", { cls: "cc-aes-input", attr: { type: "text", placeholder: "Comment..." } });
        // Enter injects the typed line as a one-off feed comment.
        input.addEventListener("keydown", (e) => {
            if (e.key !== "Enter")
                return;
            const text = input.value.trim();
            input.value = "";
            if (text)
                this.view.feed.push(text, "cc-feed-bubble-self");
        });
        const gift = react.createEl("button", { cls: "cc-aes-btn cc-aes-gift", attr: { "aria-label": "Send a gift" } });
        setIcon(gift, "gift");
        const like = react.createEl("button", { cls: "cc-aes-btn cc-aes-like", attr: { "aria-label": "Like" } });
        setIcon(like, "heart-plus");
        gift.addEventListener("click", () => this.spawnEmoji());
        like.addEventListener("click", () => this.spawnHeart());
        return { el: react };
    }
    // "roleplay" occupant: one row over the current graph level; a saved structure refresh resets it to the new roots. Clicking a pooled node makes the GM speak and descends when children exist; double-clicking a leaf rolls once per floor character. Pointer activity re-arms the idle return home.
    buildRoleplay(bar) {
        const el = bar.createDiv({ cls: "cc-aes-roleplay cc-hijack cc-hijack-hidden" });
        // Current level as node names (null = the roots), the idle-reset timer, and the pending leaf click awaiting its double-click window.
        let level = null;
        let idleTimer = null;
        let clickTimer = null;
        let clickName = null;
        let appliedGraph = this.getRoleplayGraph();
        // Evaluate one drawn entry against the character context with every table layered as a choice rule, so entries can nest other tables via $table. "" = nothing drawn / engine pending.
        const evalEntry = (line, character) => {
            if (!line)
                return "";
            const R = this.plugin.riscript;
            return R.pending(line) ? "" : R.evalTrim(line, this.view.charCtx(this.plugin.roleplayData.tables, character));
        };
        // One roll: a fresh draw from the table.
        const roll = (name, character) => {
            const entries = this.plugin.roleplayData.tables[name];
            return evalEntry(entries ? pick(entries) : "", character);
        };
        const gmRoll = (name) => {
            const text = roll(name);
            if (text)
                this.view.walker?.speak(text);
        };
        // Party roll: shared deals the table out of ONE shuffled bag, so no two walkers land the same entry (wrapping only once walkers outnumber entries); independent lets each walker draw with replacement.
        const partyRoll = (name) => {
            const entries = this.plugin.roleplayData.tables[name] ?? [];
            if (entries.length === 0)
                return;
            const bag = this.settings.roleplayShared ? shuffle([...entries]) : null;
            let i = 0;
            for (const w of this.plugin.stage.walkers.values())
                w.speak(bag ? evalEntry(bag[i++ % bag.length], w.character) : roll(name, w.character));
        };
        const cancelIdle = () => { if (idleTimer != null) { this.win.clearTimeout(idleTimer); idleTimer = null; } };
        const cancelClick = () => { if (clickTimer != null) { this.win.clearTimeout(clickTimer); clickTimer = null; } };
        const render = () => {
            const names = level ?? this.getRoleplayGraph().roots;
            el.empty();
            el.setCssProps({ "--cc-roleplay-cols": String(Math.max(1, names.length)) });
            for (const name of names) {
                const btn = el.createEl("button", { cls: "cc-aes-roleplay-btn", text: name });
                btn.addEventListener("click", () => onClick(name));
            }
        };
        // Return to the roots through the hijack recipe (the show occupant's per-line pattern: snap out, fade back in). Only the armed idle timer calls this, and stop() cancels it, so it can never fire while another row holds the bar.
        const goHome = () => {
            idleTimer = null;
            level = null;
            el.addClass("cc-hijack-hidden");
            render();
            void el.offsetWidth;
            el.removeClass("cc-hijack-hidden");
        };
        // Deeper than the roots, pointer activity (re-)arms the reset; at the roots there is nothing to reset.
        const armIdle = () => {
            cancelIdle();
            if (level)
                idleTimer = this.win.setTimeout(goHome, tuning().roleplayIdleReset);
        };
        const reconcile = () => {
            const graph = this.getRoleplayGraph();
            if (graph !== appliedGraph) {
                appliedGraph = graph;
                level = null;
                cancelClick();
                render();
            }
            armIdle();
        };
        const onClick = (name) => {
            const kids = this.getRoleplayGraph().children.get(name) ?? [];
            // A pending leaf click resolves first: doubled on the same name it becomes the party's roll, else it fires as its own single click.
            const doubled = clickTimer != null && clickName === name && kids.length === 0;
            if (clickTimer != null) {
                const prev = clickName;
                cancelClick();
                if (!doubled)
                    gmRoll(prev);
            }
            if (doubled)
                partyRoll(name);
            else if (kids.length > 0) {
                // Branch: narrate when pooled and descend at once — double-click semantics are leaf-only.
                gmRoll(name);
                level = kids;
                render();
            }
            else if (this.plugin.roleplayData.tables[name]) {
                // Leaf: hold the GM roll for one double-click window so a second click can claim it. A pool-less leaf is a clickable no-op.
                clickName = name;
                clickTimer = this.win.setTimeout(() => { clickTimer = null; gmRoll(name); }, tuning().doubleClick);
            }
            armIdle();
        };
        el.addEventListener("pointermove", armIdle);
        render();
        return {
            el,
            // Regaining the bar preserves its level unless saved data replaced the graph.
            start: reconcile,
            sync: reconcile,
            stop: () => { cancelIdle(); cancelClick(); },
        };
    }
    // News mode's chyron face is selected (the bar face; the newsToFeed switch picks feed bubbles instead).
    chyronMode() {
        return this.settings.streamEnabled && this.settings.newsEnabled && !this.settings.newsToFeed;
    }
    // A fresh pass can go out: the chyron face is live and nothing (a pass in flight, an airing) is ahead of it. pushNews gates each news beat on this BEFORE building its strip, so a dropped beat draws no extra headlines.
    chyronReady() {
        return !!this.els && this.view.isLive() && this.chyronMode() && !this.chyronOn && !this.view.show;
    }
    // Cue one chyron pass with a built strip ("" = nothing renderable, skip).
    chyronPass(text) {
        if (text)
            this.bottomEls.news.pass(text);
    }
    // "news" occupant: the chyron. pass runs one strip; stop jumps a cut-short pass to its end state via finish(), whose async onfinish then runs the normal pass-over path.
    buildChyron(bar) {
        const el = bar.createDiv({ cls: "cc-aes-chyron cc-hijack cc-hijack-hidden" });
        const track = el.createSpan({ cls: "cc-aes-chyron-track" });
        // The scroll anim is kept after finishing — its "both" fill holds the strip off-screen through the bar's fade-out; the next pass releases it.
        let anim = null;
        return {
            el,
            // One pass: hijack the bar, scroll once via WAAPI, hand the bar back on finish; the scroll's delay covers the fade-in, and the "both" fill parks the strip off-screen on both sides of the run so nothing snaps back into view.
            pass: (text) => {
                if (anim)
                    anim.cancel();
                track.setText(text);
                // Take the bar BEFORE measuring — widths are 0 while the wrapper is display:none.
                this.chyronOn = true;
                this.sync();
                const t = tuning();
                // Enter from the right edge, exit fully left, at constant px/sec.
                const travel = el.clientWidth + track.scrollWidth;
                anim = track.animate([
                    { transform: `translateX(${el.clientWidth}px)` },
                    { transform: `translateX(${-track.scrollWidth}px)` },
                ], {
                    delay: t.hijackFade,
                    duration: (travel / t.newsChyronSpeed) * 1000,
                    easing: "linear",
                    fill: "both",
                });
                anim.onfinish = () => {
                    this.chyronOn = false;
                    this.sync();
                };
            },
            stop: () => {
                this.chyronOn = false;
                if (anim && anim.playState === "running")
                    anim.finish();
            },
        };
    }
    // "show" occupant: play the airing's lines one at a time, each held per the shared speech-bubble staying time; after the last hold the airing ENDS (handing the bar back). Strictly one pending timer, cancelled by stop() — a step can never run after the row loses the bar. A mid-airing rebuild restarts the script from the top.
    buildShow(bar) {
        const bubble = bar.createDiv({ cls: "cc-aes-show cc-hijack cc-hijack-hidden" });
        let timer = null;
        return {
            el: bubble,
            start: () => {
                const R = this.plugin.riscript;
                const { lines } = this.view.show;
                const ctx = this.view.streamCtx();
                let i = 0;
                const step = () => {
                    // Advance to the next renderable line.
                    let text = "";
                    while (i < lines.length && !text) {
                        const raw = lines[i++];
                        if (!R.pending(raw))
                            text = R.evalTrim(raw, ctx);
                    }
                    if (!text) {
                        this.view.endShow();
                        return;
                    }
                    // Re-run the entry transition for each line so it fades in fresh.
                    bubble.addClass("cc-hijack-hidden");
                    bubble.setText(text);
                    void bubble.offsetWidth;
                    bubble.removeClass("cc-hijack-hidden");
                    timer = this.win.setTimeout(step, bubbleHoldMs(bubble, this.settings.quoteDurationMs, text));
                };
                // The first step is deferred so an all-unrenderable script ends the airing OUTSIDE the sync that started it — no re-entrant handover.
                timer = this.win.setTimeout(step, 0);
            },
            stop: () => {
                if (timer != null) {
                    this.win.clearTimeout(timer);
                    timer = null;
                }
                // Drop the last line so the hidden (but still laid-out) subtitle stops inflating the shared bar row.
                bubble.setText("");
            },
        };
    }
    // Reset both tickers to their opening values; the viewer count opens on a random draw so each stream starts different.
    resetCounters() {
        const t = tuning();
        this.uptimeS = 0;
        this.viewerCount = Math.round(randRange(t.aesViewerStartMin, t.aesViewerStartMax));
        this.renderCounters();
    }
    // Paint both ticker readouts from the live counters.
    renderCounters() {
        if (!this.els)
            return;
        this.els.uptimeEl.setText(formatHMS(this.uptimeS));
        this.els.viewerEl.setText(this.viewerCount.toLocaleString());
    }
    // Now-playing: the active note's name.
    updateStatus() {
        if (!this.els)
            return;
        const file = this.plugin.app.workspace.getActiveFile();
        this.els.statusEl.setText(file ? file.basename : "Nothing playing");
    }
    // Drop everything this overlay owns ahead of a re-render or close. The panel root reaps the DOM; the active occupant's stop must run here so nothing outlives it.
    teardown() {
        this.syncTimer("uptimeStop", false);
        this.syncTimer("viewerStop", false);
        this.clearParticles();
        if (this.bottomKey)
            this.bottomEls[this.bottomKey].stop?.();
        this.bottomKey = null;
        this.bottomEls = null;
        this.els = null;
    }
    // Cancel and remove every live particle.
    clearParticles() {
        for (const particle of this.particles) {
            particle.anim.onfinish = null;
            particle.anim.oncancel = null;
            particle.anim.cancel();
            particle.el.remove();
        }
        this.particles.clear();
    }
    // Spawn one tracked WAAPI particle into the fx layer. build(layer, t) returns { el, frames, duration (seconds), easing }.
    spawnParticle(build) {
        const layer = this.els && this.els.fx;
        if (!layer || !this.view.isLive() || !this.settings.streamEnabled || !this.settings.enabledAesthetics.react)
            return;
        const { el, frames, duration, easing } = build(layer, tuning());
        const anim = el.animate(frames, { duration: duration * 1000, easing, fill: "forwards" });
        const particle = { anim, el };
        const done = () => {
            this.particles.delete(particle);
            el.remove();
        };
        this.particles.add(particle);
        anim.onfinish = done;
        anim.oncancel = done;
    }
    // A "like" heart: rolled size/opacity (mostly grey, some pink), rising on a snaking trail while fading out.
    spawnHeart() {
        this.spawnParticle((layer, t) => {
            const el = layer.createDiv({ cls: "cc-aes-heart" });
            // Lucide SVG, not a "♥" glyph — that renders as the ❤️ emoji on many systems.
            setIcon(el, "heart");
            if (Math.random() < t.aesHeartPinkChance)
                el.classList.add("cc-aes-heart-pink");
            const opacity = randRange(t.aesHeartOpacityMin, t.aesHeartOpacityMax);
            el.setCssProps({ "--cc-aes-heart-px": randRange(t.aesHeartSizeMin, t.aesHeartSizeMax) + "px" });
            const rise = randRange(t.aesHeartRiseMin, t.aesHeartRiseMax);
            const steps = Math.max(2, Math.round(randRange(t.aesHeartStepsMin, t.aesHeartStepsMax)));
            let dir = Math.random() < 0.5 ? 1 : -1;
            const frames = [];
            for (let i = 0; i <= steps; i++) {
                const p = i / steps;
                let x = 0;
                if (i > 0 && i < steps) {
                    x = dir * randRange(t.aesHeartSwayMin, t.aesHeartSwayMax);
                    dir = -dir;
                }
                frames.push({ transform: `translate(${x}px, ${-rise * p}px)`, opacity: i === steps ? 0 : opacity * (1 - p * t.aesHeartFade) });
            }
            return { el, frames, duration: randRange(t.aesHeartDurationMin, t.aesHeartDurationMax), easing: "ease-out" };
        });
    }
    // A "gift" emoji falling from the top edge at a rolled x / size / speed.
    spawnEmoji() {
        this.spawnParticle((layer, t) => {
            const pool = (this.settings.giftEmojis || "").split(/\s+/).filter((s) => s.length > 0);
            const el = layer.createDiv({ cls: "cc-aes-emoji", text: pick(pool.length > 0 ? pool : ["🎁"]) });
            const size = randRange(t.aesEmojiSizeMin, t.aesEmojiSizeMax);
            el.setCssProps({
                "--cc-gift-font": this.settings.giftEmojiFont || "",
                "--cc-gift-size": size + "px",
                "--cc-gift-x": (Math.random() * t.aesEmojiXMax) + "%",
            });
            const fall = layer.clientHeight + size * 2;
            const drift = randRange(-t.aesEmojiDrift, t.aesEmojiDrift);
            const frames = [
                { transform: `translate(0px, ${-size}px)`, opacity: 1 },
                { transform: `translate(${drift}px, ${fall}px)`, opacity: 0 },
            ];
            return { el, frames, duration: randRange(t.aesEmojiDurationMin, t.aesEmojiDurationMax), easing: "linear" };
        });
    }
}
module.exports = { Aesthetics };
