"use strict";
const { setIcon } = require("obsidian");
const { AESTHETICS } = require("./registries.js");
const { bubbleHoldMs, formatHMS, pick, randRange, reconcileTimer, tuning } = require("./toolkit.js");
// Bottom-bar occupants — the bar shows exactly ONE at a time; the LAST wanting row wins (row order is the override order: Stream → Roleplay → News → Program). Every handover runs the one universal hijack fade (cc-hijack / cc-hijack-hidden). Each row's element is built ONCE per render into the bar's single grid cell — build(aes, bar) returns { el, start?, stop? } — and a handover only toggles visibility, so nothing is wiped (the react bar keeps its half-typed comment). stop MUST leave no running timer/WAAPI animation behind; a liveOnly row can't hold the bar while the panel isn't live.
const BOTTOM_OCCUPANTS = [
    // Stream: the fake react bar — the bar's resting holder.
    { key: "stream", wants: (a) => a.settings.streamEnabled && !!a.settings.enabledAesthetics.react, build: (a, bar) => a.buildReactBar(bar) },
    // (Roleplay/game mode slots in between stream and news when it lands.) News: the chyron — pure display, no timer; wants the bar only while a pass is in flight.
    { key: "news", wants: (a) => a.settings.streamEnabled && a.settings.newsEnabled && !a.settings.newsToFeed && a.chyronOn, build: (a, bar) => a.buildChyron(bar), liveOnly: true },
    // Program: an airing's content, one line at a time; the sequence ends the airing.
    { key: "program", wants: (a) => !!a.view.program, build: (a, bar) => a.buildProgram(bar), liveOnly: true },
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
        this.viewerCount = 0;
        // Per-row occupant handles and the row currently holding the bar (null = empty).
        this.bottomEls = null;
        this.bottomKey = null;
        // chyronOn marks a pass in flight; chyronAnim is the scroll, kept after finishing — its "both" fill holds the strip off-screen through the bar's fade-out.
        this.chyronOn = false;
        this.chyronAnim = null;
        this.particles = new Set();
    }
    get settings() { return this.plugin.settings; }
    syncTimer(handle, on, range, fire) {
        reconcileTimer(this, this.win, handle, on, range, fire);
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
        els.root.classList.toggle("cc-aes-show", any);
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
    // Hand the bottom bar to the LAST wanting, live-eligible row: stop the loser, toggle cc-hijack-hidden, then run the winner's start() — last, because it may re-enter this sync (a program whose every line is unrenderable ends the airing synchronously). Returns whether any row holds the bar.
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
    // "news" occupant: the chyron's persistent element — pass logic lives in chyronPass. stop jumps a cut-short pass to its end state via finish(), whose async onfinish then runs the normal pass-over path.
    buildChyron(bar) {
        const el = bar.createDiv({ cls: "cc-aes-chyron cc-hijack cc-hijack-hidden" });
        this.els.chyronTrack = el.createSpan({ cls: "cc-aes-chyron-track" });
        return { el, stop: () => {
            this.chyronOn = false;
            if (this.chyronAnim && this.chyronAnim.playState === "running")
                this.chyronAnim.finish();
        } };
    }
    // One chyron pass, cued by each news feed beat (the news interval is the only cadence). `strip` is lazy: a beat landing mid-pass or mid-airing is skipped before it runs. The pass hijacks the bar, scrolls once via WAAPI, hands the bar back on finish; the scroll's delay covers the fade-in, and the "both" fill parks the strip off-screen on both sides of the run so nothing snaps back into view.
    chyronPass(strip) {
        if (!this.els || !this.view.isLive() || !this.settings.streamEnabled || !this.settings.newsEnabled || this.settings.newsToFeed || this.chyronOn || this.view.program)
            return;
        const text = strip();
        if (!text)
            return;
        // Release the previous pass's held fill before the strip is reused.
        if (this.chyronAnim)
            this.chyronAnim.cancel();
        const track = this.els.chyronTrack;
        track.setText(text);
        // Take the bar BEFORE measuring — widths are 0 while the wrapper is display:none.
        this.chyronOn = true;
        this.sync();
        const t = tuning();
        const el = this.bottomEls.news.el;
        // Enter from the right edge, exit fully left, at constant px/sec.
        const travel = el.clientWidth + track.scrollWidth;
        this.chyronAnim = track.animate([
            { transform: `translateX(${el.clientWidth}px)` },
            { transform: `translateX(${-track.scrollWidth}px)` },
        ], {
            delay: t.hijackFade,
            duration: (travel / t.newsChyronSpeed) * 1000,
            easing: "linear",
            fill: "both",
        });
        this.chyronAnim.onfinish = () => {
            this.chyronOn = false;
            this.sync();
        };
    }
    // "program" occupant: play the airing's lines one at a time, each held per the shared speech-bubble staying time; after the last hold the airing ENDS (handing the bar back). Strictly one pending timer, cancelled by stop() — a step can never run after the row loses the bar.
    buildProgram(bar) {
        const bubble = bar.createDiv({ cls: "cc-aes-program cc-hijack cc-hijack-hidden" });
        let timer = null;
        return {
            el: bubble,
            start: () => {
                const R = this.plugin.riscript;
                const lines = this.view.program ? this.view.program.lines : [];
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
                        this.view.endProgram();
                        return;
                    }
                    // Re-run the entry transition for each line so it fades in fresh.
                    bubble.addClass("cc-hijack-hidden");
                    bubble.setText(text);
                    void bubble.offsetWidth;
                    bubble.removeClass("cc-hijack-hidden");
                    timer = this.win.setTimeout(step, bubbleHoldMs(bubble, this.settings.quoteDurationMs, text));
                };
                step();
            },
            stop: () => {
                if (timer != null) {
                    this.win.clearTimeout(timer);
                    timer = null;
                }
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
