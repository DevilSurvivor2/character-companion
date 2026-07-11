"use strict";
const { setIcon } = require("obsidian");
const { AESTHETICS } = require("./registries.js");
const { bubbleHoldMs, formatHMS, pick, randRange, reconcileTimer, tuning } = require("./toolkit.js");
// Bottom-bar slot occupants — the region above the panel's bottom edge holds exactly ONE of these at a time. Row order is the override order: of the rows whose wants(aes) holds, the LAST wins (Stream → Roleplay → News → Program, so an airing Program overrides News overrides Roleplay overrides Stream). build(aes, slotEl) mounts the occupant's DOM and MUST return a teardown that cancels every WAAPI animation/timer it started (the no-drift contract, same as buildEffect). liveOnly rows are additionally torn down while the panel isn't live and rebuilt fresh on return (the not-preserved side of the blur contract); rows without it persist across a blur like the sprite.
const SLOT_OCCUPANTS = [
    // Stream: the fake react bar (comment box + gift/like), gated by its own aesthetics pill. No ambient animation, so it survives a blur (a half-typed comment isn't wiped).
    { key: "stream", wants: (a) => a.settings.streamEnabled && !!a.settings.enabledAesthetics.react, build: (a, slot) => a.buildReactBar(slot), liveOnly: false },
    // (Roleplay/game mode slots in between stream and news when it lands.)
    // News: the headline chyron — news mode's default face (the feed switch stands it down in favour of feed bubbles). Pure display with NO timer and NO content of its own: the news feed beat hands it each pass's finished strip (see chyronPass / the view's chyronStrip). Torn down on blur (its WAAPI scroll must not outlive liveness) and rebuilt hidden on return.
    { key: "news", wants: (a) => a.settings.newsEnabled && !a.settings.newsToFeed, build: (a, slot) => a.buildChyron(slot), liveOnly: true },
    // Program: while an airing is live, its content plays here one line at a time (each held per the speech-bubble rule); the sequence ends the airing. Its timer is torn down on blur (the airing is cleared then too — see the view's sync/endProgram).
    { key: "program", wants: (a) => !!a.view.program, build: (a, slot) => a.buildProgram(slot), liveOnly: true },
];
// The in-panel overlay riding the stream anchor: the four corner tickers, the bottom-bar slot (one SLOT_OCCUPANTS row at a time — react bar / news chyron), and the particle layer. A sibling of CommentFeed: the view owns liveness and calls sync(); this owns its DOM, timers, and slot occupant. Rebuilt per panel render (build/teardown); the two ticker counters live on the instance so they survive a blur.
class Aesthetics {
    constructor(view) {
        this.view = view;
        this.plugin = view.plugin;
        // DOM refs (null while unbuilt): root, slot, fx layer, per-key ticker pills + text spans.
        this.els = null;
        this.win = null;
        // The two sync-gated tickers' stop handles + live counters (uptime seconds, viewer count).
        this.uptimeStop = null;
        this.uptimeS = 0;
        this.viewerStop = null;
        this.viewerCount = 0;
        // The active SLOT_OCCUPANTS row's key + its teardown (null = slot empty).
        this.slotKey = null;
        this.slotTeardown = null;
        // The pass hook the news beat cues with a lazy strip builder (set by buildChyron while the chyron occupies the slot, null otherwise — a beat landing with no chyron is simply skipped).
        this.chyronPass = null;
    }
    get settings() { return this.plugin.settings; }
    // Reconcile one of this overlay's named timers — see reconcileTimer.
    syncTimer(handle, on, range, fire) {
        reconcileTimer(this, this.win, handle, on, range, fire);
    }
    // Build the overlay DOM onto the stream anchor. Visibility (tickers, slot, wrapper) is reconciled by sync(), never here.
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
        // The bottom-bar slot: syncSlot mounts at most one occupant into it.
        els.slot = els.root.createDiv({ cls: "cc-aes-slot" });
        els.fx = els.root.createDiv({ cls: "cc-aes-fx" });
        // Counters need their opening values now; everything else is reconciled by the sync() that always follows a render.
        this.resetCounters();
    }
    // Reconcile each ticker's visibility to streamEnabled + its flag, the slot to its occupant row, and run the two sync-gated tickers only while live + shown. Called from the view's sync() (liveness / mode changes) and applyChange's repaint (a pill toggled in settings).
    sync() {
        const els = this.els;
        if (!els || !els.root.isConnected)
            return;
        els.root.setCssProps({ "--cc-stream-font": this.settings.commentFont || "" });
        const streaming = this.settings.streamEnabled;
        const en = this.settings.enabledAesthetics;
        const show = (key) => streaming && !!en[key];
        // Each ticker's visibility follows its flag; the wrapper shows if any piece (ticker or slot occupant) does.
        let any = false;
        for (const a of AESTHETICS) {
            // A key without its own element ("react") lives in the slot, reconciled below.
            if (!els[a.key])
                continue;
            const on = show(a.key);
            any = any || on;
            els[a.key].classList.toggle("cc-hidden", !on);
        }
        any = this.syncSlot() || any;
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
    // Mount/replace/clear the bottom-bar occupant per SLOT_OCCUPANTS: of the rows that want the slot the last wins; a liveOnly winner renders nothing while the panel isn't live (the slot stays its own — no falling back to an earlier row, which would flicker-swap on every blur). Returns whether the slot is occupied.
    syncSlot() {
        const want = [...SLOT_OCCUPANTS].reverse().find((r) => r.wants(this));
        const active = want && (!want.liveOnly || this.view.isLive()) ? want : null;
        const key = active ? active.key : null;
        if (key !== this.slotKey) {
            if (this.slotTeardown) {
                this.slotTeardown();
                this.slotTeardown = null;
            }
            this.slotKey = key;
            if (active)
                this.slotTeardown = active.build(this, this.els.slot);
        }
        return key !== null;
    }
    // SLOT_OCCUPANTS "stream": the fake react bar — comment box (Enter injects a one-off feed comment), gift + like buttons raining particles into the fx layer. Static DOM with no ambient animation, so the teardown is just removal.
    buildReactBar(slot) {
        const react = slot.createDiv({ cls: "cc-aes-react" });
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
        return () => react.remove();
    }
    // SLOT_OCCUPANTS "news": the headline chyron, mounted hidden and owning NO timer and NO content — each news feed beat hands `chyronPass` a lazy strip builder, so the news interval is the only cadence and the chyron is purely display (the strip's drawing + evaluation live in the view's chyronStrip). A pass still fading/scrolling skips the beat BEFORE the builder runs (a busy chyron wastes no headline draws), and an empty strip (engine loading / empty list) is skipped too; the next beat cues a fresh pass. A pass fades the bar fully in, scrolls the strip right-to-left once via WAAPI, and fades the bar back out to nothing. The scroll's `delay` covers the fade-in (the "both" fill parks the strip off the right edge until the bar is fully in, then holds it off the left edge through the fade-out — nothing ever snaps back into view). The returned teardown cancels the scroll and unhooks the cue (the no-drift contract).
    buildChyron(slot) {
        const el = slot.createDiv({ cls: "cc-aes-chyron" });
        const track = el.createSpan({ cls: "cc-aes-chyron-track" });
        let anim = null;
        this.chyronPass = (strip) => {
            // A pass still fading/scrolling finishes undisturbed; this beat is skipped.
            if (anim && anim.playState === "running")
                return;
            const text = strip();
            if (!text)
                return;
            const t = tuning();
            // Release the previous pass's held fill before the strip is reused.
            if (anim)
                anim.cancel();
            track.setText(text);
            el.addClass("cc-aes-chyron-visible");
            // Enter from the right edge, exit fully left; constant px/sec, so a longer strip takes proportionally longer.
            const travel = el.clientWidth + track.scrollWidth;
            anim = track.animate([
                { transform: `translateX(${el.clientWidth}px)` },
                { transform: `translateX(${-track.scrollWidth}px)` },
            ], {
                delay: t.newsChyronFade,
                duration: (travel / t.newsChyronSpeed) * 1000,
                easing: "linear",
                fill: "both",
            });
            anim.onfinish = () => el.removeClass("cc-aes-chyron-visible");
        };
        return () => {
            this.chyronPass = null;
            if (anim)
                anim.cancel();
            el.remove();
        };
    }
    // SLOT_OCCUPANTS "program": play the airing's content lines one at a time as a bottom bubble. Each line is RiScript-evaluated against the character context (inline choices / $vars), shown, and held for the shared speech-bubble staying time (bubbleHoldMs, the quoteDurationMs setting); a line the not-yet-loaded engine can't render is skipped. After the last line's hold the airing ENDS (the view drops it, which tears this occupant down). The returned teardown cancels the pending step timer (the no-drift contract). Rebuilt fresh if the panel refocuses mid-airing.
    buildProgram(slot) {
        const bubble = slot.createDiv({ cls: "cc-aes-program" });
        const win = this.win;
        const R = this.plugin.riscript;
        const lines = this.view.program ? this.view.program.lines : [];
        // One context per airing — the choice rules are static strings, so the per-line randomness all lives in the RiScript eval.
        const ctx = this.view.streamCtx();
        let timer = null, i = 0;
        // Strictly one pending timer: each step schedules the next or ends the airing, and the teardown cancels it — so a step can never run after teardown.
        const step = () => {
            // Advance to the next renderable line (skip templated lines the engine can't do yet).
            let text = "";
            while (i < lines.length && !text) {
                const raw = lines[i++];
                if (!R.pending(raw))
                    text = R.evalTrim(raw, ctx);
            }
            if (!text) {
                // Nothing left to show → end the airing (which tears this occupant down).
                this.view.endProgram();
                return;
            }
            // Re-run the entry transition for each line so it fades in fresh.
            bubble.removeClass("cc-aes-program-visible");
            bubble.setText(text);
            void bubble.offsetWidth;
            bubble.addClass("cc-aes-program-visible");
            timer = win.setTimeout(step, bubbleHoldMs(bubble, this.settings.quoteDurationMs, text));
        };
        step();
        return () => {
            if (timer != null)
                win.clearTimeout(timer);
            bubble.remove();
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
    // Drop everything this overlay owns (the two ticker timers, the slot occupant, refs) ahead of a re-render or close. The panel root reaps the DOM itself, but the slot teardown must run here so no WAAPI animation or timer outlives it.
    teardown() {
        this.syncTimer("uptimeStop", false);
        this.syncTimer("viewerStop", false);
        if (this.slotTeardown) {
            this.slotTeardown();
            this.slotTeardown = null;
        }
        this.slotKey = null;
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
                    x = dir * randRange(t.aesHeartSway * 0.3, t.aesHeartSway);
                    dir = -dir;
                }
                frames.push({ transform: `translate(${x}px, ${-rise * p}px)`, opacity: i === steps ? 0 : opacity * (1 - p * 0.6) });
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
                "--cc-gift-x": (Math.random() * 90) + "%",
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
