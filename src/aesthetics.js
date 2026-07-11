"use strict";
const { setIcon } = require("obsidian");
const { AESTHETICS } = require("./registries.js");
const { bubbleHoldMs, formatHMS, pick, randRange, reconcileTimer, tuning } = require("./toolkit.js");
// Bottom-bar occupants — the bar above the panel's bottom edge shows exactly ONE of these at a time. Later rows HIJACK earlier ones (row order is the override order: Stream → Roleplay → News → Program) and every handover, either direction, runs the one universal hijack fade (cc-hijack / cc-hijack-hidden — see aesthetics.css; the program's scene cover shares the same recipe in panel.css). Each row's element is built ONCE per render into the bar's single grid cell — build(aes, bar) returns { el, start?, stop? } — and a handover only toggles visibility, so nothing is wiped by one: the react bar keeps its half-typed comment through a hijack or a blur. start runs when the row gains the bar; stop when it loses it (teardown included) and MUST leave no running timer/WAAPI animation behind (the no-drift contract, same as buildEffect). A liveOnly row can't hold the bar while the panel isn't live — the bar falls back to the last live-eligible row.
const BOTTOM_OCCUPANTS = [
    // Stream: the fake react bar (comment box + gift/like), gated by its own aesthetics pill. The bar's resting holder — the rows below hijack it and hand it back.
    { key: "stream", wants: (a) => a.settings.streamEnabled && !!a.settings.enabledAesthetics.react, build: (a, bar) => a.buildReactBar(bar) },
    // (Roleplay/game mode slots in between stream and news when it lands.)
    // News: the headline chyron — news mode's default face (the feed switch stands it down in favour of feed bubbles). Pure display with NO timer and NO content of its own; it wants the bar only while a pass is in flight (each news feed beat cues one via chyronPass), so between passes the bar belongs to the react bar again. liveOnly: a blur mid-pass ends the scroll at once.
    { key: "news", wants: (a) => a.chyronOn, build: (a, bar) => a.buildChyron(bar), liveOnly: true },
    // Program: while an airing is live, its content plays here one line at a time (each held per the speech-bubble rule); the sequence ends the airing (a blur ends it too — see the view's sync/endProgram — so liveOnly is only a backstop).
    { key: "program", wants: (a) => !!a.view.program, build: (a, bar) => a.buildProgram(bar), liveOnly: true },
];
// The in-panel overlay riding the stream anchor: the four corner tickers, the bottom bar (one BOTTOM_OCCUPANTS row visible at a time — react bar / news chyron / program), and the particle layer. A sibling of CommentFeed: the view owns liveness and calls sync(); this owns its DOM, timers, and bottom bar. Rebuilt per panel render (build/teardown); the two ticker counters live on the instance so they survive a blur.
class Aesthetics {
    constructor(view) {
        this.view = view;
        this.plugin = view.plugin;
        // DOM refs (null while unbuilt): root, fx layer, chyron track, per-key ticker pills + text spans.
        this.els = null;
        this.win = null;
        // The two sync-gated tickers' stop handles + live counters (uptime seconds, viewer count).
        this.uptimeStop = null;
        this.uptimeS = 0;
        this.viewerStop = null;
        this.viewerCount = 0;
        // The bottom bar: per-row { el, start?, stop? } handles (built once with the overlay) and the row currently holding the bar (null = bar empty).
        this.bottomEls = null;
        this.bottomKey = null;
        // Chyron pass state: chyronOn marks a pass in flight (the news row's wants); chyronAnim is the scroll, kept after finishing — its "both" fill holds the strip off-screen through the bar's fade-out and is released at the next pass.
        this.chyronOn = false;
        this.chyronAnim = null;
    }
    get settings() { return this.plugin.settings; }
    // Reconcile one of this overlay's named timers — see reconcileTimer.
    syncTimer(handle, on, range, fire) {
        reconcileTimer(this, this.win, handle, on, range, fire);
    }
    // Build the overlay DOM onto the stream anchor. Visibility (tickers, bottom bar, wrapper) is reconciled by sync(), never here.
    build(anchor) {
        const els = { root: anchor.createDiv({ cls: "cc-aes" }) };
        this.els = els;
        this.win = anchor.win;
        const top = els.root.createDiv({ cls: "cc-aes-top" });
        const stats = top.createDiv({ cls: "cc-aes-stats" });
        // The four corner tickers differ only by icon + what fills the text, so one helper builds each: an `icon + text` pill registered under its key (the visibility-toggle target), returning the text span. uptime/viewer share the stats row; profile/status each take their own line. Counters/status are filled later; profile's text is the static character name.
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
        // The bottom bar: every occupant's element is built now (hidden); syncBottom hands the bar to one at a time.
        const bar = els.root.createDiv({ cls: "cc-aes-bottom" });
        this.bottomEls = {};
        for (const row of BOTTOM_OCCUPANTS)
            this.bottomEls[row.key] = row.build(this, bar);
        this.bottomKey = null;
        els.fx = els.root.createDiv({ cls: "cc-aes-fx" });
        // Counters need their opening values now; everything else is reconciled by the sync() that always follows a render.
        this.resetCounters();
    }
    // Reconcile each ticker's visibility to streamEnabled + its flag, the bottom bar to its occupant row, and run the two sync-gated tickers only while live + shown. Called from the view's sync() (liveness / mode changes) and applyChange's repaint (a pill toggled in settings).
    sync() {
        const els = this.els;
        if (!els || !els.root.isConnected)
            return;
        els.root.setCssProps({ "--cc-stream-font": this.settings.commentFont || "" });
        const streaming = this.settings.streamEnabled;
        const en = this.settings.enabledAesthetics;
        const show = (key) => streaming && !!en[key];
        // Each ticker's visibility follows its flag; the wrapper shows if any piece (ticker or bottom-bar occupant) does.
        let any = false;
        for (const a of AESTHETICS) {
            // A key without its own element ("react") lives in the bottom bar, reconciled below.
            if (!els[a.key])
                continue;
            const on = show(a.key);
            any = any || on;
            els[a.key].classList.toggle("cc-hidden", !on);
        }
        any = this.syncBottom() || any;
        els.root.classList.toggle("cc-aes-show", any);
        // Only the two tickers own timers: run them while live + shown, freeze them otherwise. Both are fixed-interval, so they ride the shared timer primitive with lo === hi.
        const live = this.view.isLive();
        this.syncTimer("uptimeStop", live && show("uptime"), () => ({ lo: 1000, hi: 1000 }), () => {
            this.uptimeS += 1;
            this.renderCounters();
        });
        this.syncTimer("viewerStop", live && show("viewer"), () => ({ lo: tuning().aesViewerInterval, hi: tuning().aesViewerInterval }), () => {
            // One drift tick: a small +/- wobble, plus an occasional bulk spike; never below the floor.
            const t = tuning();
            let delta = Math.round(randRange(-t.aesViewerDelta, t.aesViewerDelta));
            if (Math.random() < t.aesViewerSpikeChance)
                delta += Math.round(randRange(t.aesViewerSpikeMin, t.aesViewerSpikeMax));
            this.viewerCount = Math.max(Math.round(t.aesViewerFloor), this.viewerCount + delta);
            this.renderCounters();
        });
        if (show("status"))
            this.updateStatus();
    }
    // Hand the bottom bar to the single winning row: the LAST wanting, live-eligible one. A handover stops the loser, then crossfades — every element persists stacked in the bar's one grid cell, so only cc-hijack-hidden toggles and the universal hijack transition does the rest. The winner's start() runs last because it may re-enter this sync (a program whose every line is unrenderable ends the airing synchronously) — by then this pass's state is fully written, so the inner pass wins and the re-read return stays honest. Returns whether any row holds the bar.
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
    // BOTTOM_OCCUPANTS "stream": the fake react bar — comment box (Enter injects a one-off feed comment), gift + like buttons raining particles into the fx layer. Static DOM with no ambient animation, so it needs no start/stop.
    buildReactBar(bar) {
        const react = bar.createDiv({ cls: "cc-aes-react cc-hijack cc-hijack-hidden" });
        const comment = react.createDiv({ cls: "cc-aes-comment" });
        const input = comment.createEl("input", { cls: "cc-aes-input", attr: { type: "text", placeholder: "Comment..." } });
        // Press Enter to inject the typed line into the live feed as a one-off comment; it ages out with the regular ones and never touches their random rotation.
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
    // BOTTOM_OCCUPANTS "news": the chyron's persistent element — pure display, every pass's logic lives in chyronPass. stop only guarantees no scroll outlives the row's tenure: finish() jumps a cut-short pass to its end state (strip held off the left edge, exactly like a natural finish), whose async onfinish then runs the normal pass-over path.
    buildChyron(bar) {
        const el = bar.createDiv({ cls: "cc-aes-chyron cc-hijack cc-hijack-hidden" });
        this.els.chyronTrack = el.createSpan({ cls: "cc-aes-chyron-track" });
        return { el, stop: () => {
            this.chyronOn = false;
            if (this.chyronAnim && this.chyronAnim.playState === "running")
                this.chyronAnim.finish();
        } };
    }
    // One chyron pass, cued by each news feed beat — the chyron owns no timer, so the news interval is the only cadence (the strip's drawing + evaluation live in the view's chyronStrip). `strip` is lazy and runs only once the pass is sure to go out: a beat landing mid-pass or mid-airing is skipped BEFORE it, wasting no headline draws, and an empty strip (engine loading / empty list) is skipped after. A pass hijacks the bottom bar (syncBottom crossfades the react bar out and the chyron in), scrolls the strip right-to-left once via WAAPI, and hands the bar back on finish. The scroll's `delay` covers the fade-in; the "both" fill parks the strip off the right edge until the bar is fully in, then holds it off the left edge through the fade-out — nothing ever snaps back into view.
    chyronPass(strip) {
        if (!this.els || this.chyronOn || this.view.program)
            return;
        const text = strip();
        if (!text)
            return;
        // Release the previous pass's held fill before the strip is reused.
        if (this.chyronAnim)
            this.chyronAnim.cancel();
        const track = this.els.chyronTrack;
        track.setText(text);
        // Take the bar before measuring: the crossfade starts, and on a bare panel the overlay wrapper un-hides (widths are 0 while it's display:none).
        this.chyronOn = true;
        this.sync();
        const t = tuning();
        const el = this.bottomEls.news.el;
        // Enter from the right edge, exit fully left; constant px/sec, so a longer strip takes proportionally longer.
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
    // BOTTOM_OCCUPANTS "program": play the airing's content lines one at a time as a bottom bubble. start() runs the airing: each line is RiScript-evaluated against the character context (inline choices / $vars), shown, and held for the shared speech-bubble staying time (bubbleHoldMs, the quoteDurationMs setting); a line the not-yet-loaded engine can't render is skipped. After the last line's hold the airing ENDS (the view drops it, which hands the bar back). Strictly one pending timer: each step schedules the next or ends the airing, and stop() cancels it — a step can never run after the row loses the bar.
    buildProgram(bar) {
        const bubble = bar.createDiv({ cls: "cc-aes-program cc-hijack cc-hijack-hidden" });
        let timer = null;
        return {
            el: bubble,
            start: () => {
                const R = this.plugin.riscript;
                const lines = this.view.program ? this.view.program.lines : [];
                // One context per airing — the choice rules are static strings, so the per-line randomness all lives in the RiScript eval.
                const ctx = this.view.streamCtx();
                let i = 0;
                const step = () => {
                    // Advance to the next renderable line (skip templated lines the engine can't do yet).
                    let text = "";
                    while (i < lines.length && !text) {
                        const raw = lines[i++];
                        if (!R.pending(raw))
                            text = R.evalTrim(raw, ctx);
                    }
                    if (!text) {
                        // Nothing left to show → end the airing (which hands the bar back).
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
    // Reset both tickers to their opening values (on a fresh stream toggle / rebuild). The viewer count opens on a random draw in [min, max] so each stream starts believably different instead of the same fixed number every time.
    resetCounters() {
        const t = tuning();
        this.uptimeS = 0;
        this.viewerCount = Math.round(randRange(t.aesViewerStartMin, t.aesViewerStartMax));
        this.renderCounters();
    }
    // Paint both ticker readouts from the live counters (the only place either is written out).
    renderCounters() {
        if (!this.els)
            return;
        this.els.uptimeEl.setText(formatHMS(this.uptimeS));
        this.els.viewerEl.setText(this.viewerCount.toLocaleString());
    }
    // Now-playing: the active note's name (re-read on focus + active-leaf-change).
    updateStatus() {
        if (!this.els)
            return;
        const file = this.plugin.app.workspace.getActiveFile();
        this.els.statusEl.setText(file ? file.basename : "Nothing playing");
    }
    // Drop everything this overlay owns (the two ticker timers, the bottom bar, refs) ahead of a re-render or close. The panel root reaps the DOM itself, but the active occupant's stop must run here so no WAAPI animation or timer outlives it.
    teardown() {
        this.syncTimer("uptimeStop", false);
        this.syncTimer("viewerStop", false);
        if (this.bottomKey)
            this.bottomEls[this.bottomKey].stop?.();
        this.bottomKey = null;
        this.bottomEls = null;
        this.els = null;
    }
    // Spawn one WAAPI particle into the fx layer. `build(layer, t)` returns the element plus its { frames, duration (seconds), easing }; the particle self-removes when the animation finishes. The shared scaffold for the gift/like rains below.
    spawnParticle(build) {
        const layer = this.els && this.els.fx;
        if (!layer)
            return;
        const { el, frames, duration, easing } = build(layer, tuning());
        const anim = el.animate(frames, { duration: duration * 1000, easing, fill: "forwards" });
        anim.onfinish = () => el.remove();
    }
    // A "like" heart: rolled size/opacity (mostly grey, some pink), rising on a snaking WAAPI trail (alternating sway waypoints) while fading to transparent.
    spawnHeart() {
        this.spawnParticle((layer, t) => {
            const el = layer.createDiv({ cls: "cc-aes-heart" });
            // Lucide SVG (filled via CSS), not a "♥" glyph — that renders as the ❤️ emoji on many systems, which ignores the grey/pink colour and shows the wrong shape.
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
    // A "gift" emoji: a true-random pick falling from the top edge at a rolled x / size / speed, drifting and fading out.
    spawnEmoji() {
        this.spawnParticle((layer, t) => {
            // The raw gift-emoji text, split on whitespace; empty falls back to a single 🎁.
            const pool = (this.settings.giftEmojis || "").split(/\s+/).filter((s) => s.length > 0);
            const el = layer.createDiv({ cls: "cc-aes-emoji", text: pick(pool.length > 0 ? pool : ["🎁"]) });
            const size = randRange(t.aesEmojiSizeMin, t.aesEmojiSizeMax);
            // Per-particle font/size/x through CSS vars (styles.css owns the properties); an empty font var inherits the default emoji face.
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
