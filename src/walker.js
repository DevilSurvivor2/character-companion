"use strict";
const { ANIMS_BY_ROLE, ANIM_BY_NAME, ANIM_POOLS, CLEARABLE, HOLD_SHAKES } = require("./registries.js");
const { Bag, bubbleHoldMs, capturePointer, randRange, releasePointer, splitQuote, spriteTopInsetFraction, tuning } = require("./toolkit.js");
// A walker is in exactly one MODE; every interaction is a transition. Only WALK and DROP have per-frame bodies; HELD/REST/ANIM are event- or timer-driven.
const MODE = { WALK: "walk", REST: "rest", HELD: "held", DROP: "drop", ANIM: "anim" };
// Independent rest fidgets, each rolled on its own chance and fired once at a random point in the first --cc-rest-idle-fraction of the rest window. They layer.
const REST_ACTIVITIES = [
    { chance: "idleChance", play: (w) => w.playIdleBeat() },
    { chance: "flipChance", play: (w) => w.flip() },
];
// Held-sprite activity sequence, looped by the activity runner; run(w, done) calls done().
const HELD_ACTIVITIES = [
    { name: "shake", chance: 1, run: (w, done) => w.holdShake(done) },
    { name: "escape", chance: "escapeChance", run: (w, done) => w.holdEscape(done) },
];
// Total run time (ms) of the element's CSS animation: duration × iteration count. Relies on the animations.css rule that every cc-anim class declares exactly ONE animation.
function animationDurationMs(el) {
    const cs = el.win.getComputedStyle(el);
    const longest = (cs.animationDuration || "0s")
        .split(",")
        .reduce((max, part) => Math.max(max, parseFloat(part) || 0), 0) * 1000;
    const iterRaw = (cs.animationIterationCount || "1").split(",")[0].trim();
    const iter = iterRaw === "infinite" ? 1 : parseFloat(iterRaw) || 1;
    return longest * iter;
}
// A role's enabled animations; rootOnly excludes root:false moves.
function enabledList(settings, role, rootOnly) {
    const pool = ANIM_POOLS[role];
    return pool.all.filter((a) => (!rootOnly || ANIM_BY_NAME[a].root !== false) && settings[pool.flag][a]);
}
// One sprite's whole life: DOM, state, and every self-contained behaviour. Cross-walker coordination lives on CompanionStage via `this.stage` (null for a stage-less sprite).
class Walker {
    constructor(stage, plugin, character, els, urls, speed) {
        this.stage = stage;
        this.plugin = plugin;
        this.character = character;
        this.id = character.id;
        this.wrapEl = els.wrapEl;
        this.imgEl = els.imgEl;
        this.bubbleEl = els.bubbleEl;
        // The owning window, captured once for every timer and geometry read (never `activeWindow` — timer ids don't cross windows).
        this.win = els.wrapEl.win;
        // Set only for the sidebar's JS-positioned bubble; null for the CSS-positioned floor bubble.
        this.bubbleAnchorEl = els.bubbleAnchorEl || null;
        // Images/quotes are per-sprite; idle/surprise share one bag each across the troupe.
        this.spriteBag = new Bag();
        this.quoteBag = new Bag();
        this.idleBag = stage ? stage.idleBag : new Bag();
        this.surpriseBag = stage ? stage.surpriseBag : new Bag();
        // Lazy per-role bags for the function-role pulls (flip/bob/tickle/sleep).
        this.roleBags = {};
        this.spriteUrls = urls;
        this.speed = speed;
        // ---- role variables ---- The cycle branches only on these flags, never on `this.stage`: a surface configures a walker by setting them.
        this.grabbable = !!stage; // pointer-grab lifts it into HELD/DROP; else a tap just wakes
        this.rootOnly = !!stage;  // exclude off-floor animations the bottom strip would clip
        this.canSleep = !stage;   // may doze when untouched (also gated live by stream mode)
        this.halfWidth = 0;
        const T = tuning();
        // Start inside the rest band; a stage-less sprite isn't x-positioned.
        const band = stage ? stage.restBand() : null;
        this.x = band ? randRange(band.lo, band.hi) : 0;
        this.walkDir = 1;
        this.walkDist = 0;
        // The walk's live pace; cursor react steers it mid-walk.
        this.walkPace = speed;
        this.mode = MODE.REST;
        this.interruptible = false;
        // Provisional; beginRest sets the real one.
        this.restUntil = performance.now();
        this.phase = 0;
        this.yOffset = T.walkRestY;
        this.z = 0;
        this.pointerId = null;
        this.pressX = 0;
        this.pressY = 0;
        this.pressMoved = false;
        this.lastTapT = 0;
        this.dropStart = 0;
        this.dropLastT = 0;
        this.lastMoveX = 0;
        this.lastMoveT = 0;
        this.flickVel = 0;
        // Activity runner state, torn down together by clearActivities.
        this.actTimers = [];
        this.actToken = 0;
        this.actIndex = 0;
        this.actList = null;
        this.actLoop = false;
        this.watchUntil = 0;
        this.easeTimer = null;
        // The single live timer of a speak sequence (each step schedules the next).
        this.bubbleTimer = null;
        // The pending end timer of the sprite's image animation.
        this.animTimer = null;
        // Sleep clock: time of last interaction.
        this.lastInteraction = Date.now();
        this.imgEl.draggable = false;
        this.imgEl.alt = character.name;
        this.imgEl.addEventListener("pointerdown", (e) => this.onDown(e));
        this.imgEl.addEventListener("pointermove", (e) => this.onMove(e));
        this.imgEl.addEventListener("pointerup", (e) => this.onUp(e));
        this.imgEl.addEventListener("pointercancel", (e) => this.onCancel(e));
        // On each load, cache the half-width (no per-frame reflow) and re-anchor the bubble.
        this.imgEl.addEventListener("load", () => this.measure());
        this.setSprite(this.spriteBag.next(urls));
        // A cached/data-URL sprite can complete synchronously with no load event.
        if (this.imgEl.complete && this.imgEl.offsetWidth)
            this.measure();
    }
    get settings() { return this.plugin.settings; }
    measure() {
        this.halfWidth = this.imgEl.offsetWidth / 2;
        this.applyBubbleInset();
    }
    place() {
        this.wrapEl.setCssProps({ "--cc-x": this.x + "px", "--cc-y": this.yOffset + "%" });
    }
    // Off-screen hand-off distance: cached half-width plus the edge margin.
    margin() {
        return this.halfWidth + tuning().walkEdgeMargin;
    }
    // Advance x along the looping floor (wrapping edge to edge) and update the walk bob.
    advanceAlong(dx, width) {
        const margin = this.margin();
        this.x += dx;
        if (this.x > width + margin)
            this.x = -margin;
        else if (this.x < -margin)
            this.x = width + margin;
        this.arc(dx);
    }
    // Advance the walk bob by a stride, leaving x untouched: one full step per walkStepLength of travel, so speed alone scales the cadence.
    arc(stride) {
        const T = tuning();
        this.phase += (Math.abs(stride) / T.walkStepLength) * Math.PI;
        this.yOffset = T.walkRestY + (T.walkLiftY - T.walkRestY) * Math.abs(Math.sin(this.phase));
    }
    // One frame. HELD/DROP own the sprite and skip cursor-react.
    step(dt) {
        if (this.mode !== MODE.HELD && this.mode !== MODE.DROP)
            this.applyCursorReact();
        if (this.mode === MODE.WALK)
            this.walkStep(dt);
        else if (this.mode === MODE.DROP)
            this.dropStep();
    }
    // WALK body — the only mover: travel walkDir × walkPace until the distance is spent, settle when done. A parked walk (walkPace 0, the cursor stop gap) breathes the bob at the walker's own speed instead.
    walkStep(dt) {
        const advance = Math.min(this.walkPace * dt, this.walkDist);
        this.walkDist -= advance;
        if (this.walkPace > 0)
            this.advanceAlong(this.walkDir * advance, this.win.innerWidth);
        else
            this.arc(this.speed * dt);
        this.place();
        if (this.walkDist <= 0)
            this.settle();
    }
    // Glide the image's (maybe mid-animation) transform back to rest: freeze the live pose inline, arm the eased transition, clear it so it eases to identity. Returns whether there was a pose to settle.
    easeImagePose() {
        const img = this.imgEl;
        const current = this.win.getComputedStyle(img).transform;
        this.stopAnimation();
        if (!current || current === "none")
            return false;
        img.setCssProps({ transform: current });
        img.classList.add("cc-eased");
        void img.offsetWidth;
        img.setCssProps({ transform: "" });
        return true;
    }
    // The universal ease every cross-mode transition passes through: settle any in-flight image animation AND glide the wrap's vertical to targetY, then run `then` after --cc-ease (at once if nothing to ease). Caller owns the mode; this also tears down the old mode's activity sequence.
    easeToward(targetY, then) {
        this.clearActivities();
        this.endWatch();
        // A previous ease still in flight must count as movement even when the target matches (yOffset already holds that ease's target but the render is mid-glide), so the glide re-arms instead of running `then` mid-glide with cc-eased stranded. Only the timer is cleared, never endEase: the eased state survives the retarget.
        const gliding = this.easeTimer !== null;
        if (gliding) { this.win.clearTimeout(this.easeTimer); this.easeTimer = null; }
        const easingImg = this.easeImagePose();
        const needY = gliding || this.yOffset !== targetY;
        if (needY) {
            this.setEasing(true);
            void this.wrapEl.offsetWidth;
            this.yOffset = targetY;
            this.place();
        }
        if (!easingImg && !needY) {
            if (then)
                then();
            return;
        }
        this.easeTimer = this.win.setTimeout(() => {
            this.endEase();
            if (then)
                then();
        }, tuning().ease);
    }
    // End the ease now: drop the pending timer and strip the eased state so nothing smooths (or later snaps) a value-driven frame. No-op when nothing is easing.
    endEase() {
        if (this.easeTimer) { this.win.clearTimeout(this.easeTimer); this.easeTimer = null; }
        this.imgEl.classList.remove("cc-eased");
        this.imgEl.setCssProps({ transform: "" });
        this.setEasing(false);
    }
    // React to a cursor near the band — pure steering, refreshed every frame: it only writes the three walk variables (walkDir, walkPace, walkDist), claiming WALK through easeToward first when needed. The bob simply rides the walk's stride.
    applyCursorReact() {
        const T = tuning();
        const cursor = this.stage.cursor;
        const gap = this.x - cursor.x;
        // Out of reach: restore the walk's own pace and let it run out on its own.
        if (cursor.x < 0 || cursor.y < this.stage.stageTop() - T.reactRadius || Math.abs(gap) > T.reactRadius) {
            this.endWatch();
            if (this.mode === MODE.WALK)
                this.walkPace = this.speed;
            return;
        }
        if (this.mode === MODE.ANIM && !this.interruptible)
            return;
        const curious = this.character.curious;
        // Curious stop gap: park the travel (walkPace 0) and roll the chatter window.
        if (curious && Math.abs(gap) <= T.curiousGap) {
            if (this.mode === MODE.WALK)
                this.walkPace = 0;
            this.watchTick();
            return;
        }
        // A standing (0%-speed) character neither flees nor approaches.
        if (this.speed <= 0)
            return;
        // Steer: flee = away for a full radius; curious = toward, the gap as the distance.
        const dir = (gap >= 0 ? 1 : -1) * (curious ? -1 : 1);
        if (this.mode !== MODE.WALK) {
            // Claim WALK through the ease. Non-interruptible ANIM is the latch: until beginWalk lands, every frame bounces off the guard above.
            this.mode = MODE.ANIM;
            this.interruptible = false;
            this.easeToward(T.walkRestY, () => this.beginWalk(dir));
            return;
        }
        this.walkDir = dir;
        this.walkPace = this.speed * T.reactSpeedMult;
        this.walkDist = curious ? Math.abs(gap) : T.reactRadius;
    }
    // Curiosity chatter: each elapsed watch window re-arms and rolls once to speak a line.
    watchTick() {
        const T = tuning();
        const now = performance.now();
        if (this.watchUntil === 0) {
            this.watchUntil = now + randRange(T.curiousWatchMin, T.curiousWatchMax);
            return;
        }
        if (now < this.watchUntil)
            return;
        this.watchUntil = now + randRange(T.curiousWatchMin, T.curiousWatchMax);
        const bubbleShowing = this.bubbleEl && this.bubbleEl.hasClass("cc-bubble-visible");
        if (!bubbleShowing && Math.random() < T.curiousChatterChance)
            this.speak();
    }
    endWatch() {
        this.watchUntil = 0;
    }
    beginWalk(dir, remaining) {
        // 0% speed never travels: a "walk" just keeps resting.
        if (this.speed <= 0) {
            this.beginRest();
            return;
        }
        const T = tuning();
        this.clearActivities();
        this.endWatch();
        // The arc drives --cc-y every frame, so the smoothing transition must be off.
        this.setEasing(false);
        // dir/remaining default to random (a walkaside passes an explicit minimum).
        this.walkDir = dir ?? (Math.random() < 0.5 ? -1 : 1);
        this.walkDist = remaining ?? Math.random() * T.walkMaxDistanceFrac * this.win.innerWidth;
        this.walkPace = this.speed;
        this.mode = MODE.WALK;
    }
    // End of a walk: rest only if inside the band; else walk again until visible.
    settle() {
        const { lo, hi } = this.stage.restBand();
        if (this.x < lo || this.x > hi)
            this.beginWalk();
        else
            this.beginRest();
    }
    beginRest() {
        const T = tuning();
        this.mode = MODE.REST;
        // Sync the doze dim to the sleep clock once per cycle.
        this.setAsleep(this.isAsleep());
        // Resolve a same-spot overlap before any rest glide; a yielding walker keeps walking (no glide) so the vertical doesn't snap.
        if (this.stage && this.stage.resolveRestOverlap(this))
            return;
        this.restUntil = performance.now() + this.restWindowMs();
        this.phase = 0;
        // Glide down to rest in case the walk ended mid-arc, then schedule the window.
        this.easeToward(T.walkRestY);
        this.scheduleRest();
    }
    // One rest window: the idle min–max delay, stretched by the sleep multiplier.
    restWindowMs() {
        const T = tuning();
        const base = randRange(T.idleMinDelay, T.idleMaxDelay);
        return this.isAsleep() ? base * T.sleepMultiplier : base;
    }
    // Asleep once untouched for sleepAfterMs; gated by canSleep, forced off in stream mode.
    isAsleep() {
        const ms = this.settings.sleepAfterMs;
        return this.canSleep && !this.settings.streamEnabled && ms > 0 && Date.now() - this.lastInteraction >= ms;
    }
    // Dim while dozing. On the wrap so the per-beat image animations can't clear it.
    setAsleep(asleep) {
        this.wrapEl.classList.toggle("cc-asleep", asleep);
    }
    // Any interaction resets the sleep clock, undims, and (if resting) re-arms the cycle.
    wake() {
        this.lastInteraction = Date.now();
        this.setAsleep(false);
        if (this.mode === MODE.REST)
            this.beginRest();
    }
    // Freeze the rest cycle (panel hidden / window blurred); resume re-arms it.
    pauseRest() {
        this.clearTimers();
        this.imgEl.classList.remove("cc-dragging");
        this.pointerId = null;
        this.pressMoved = false;
        this.mode = MODE.REST;
    }
    resumeRest() {
        if (this.mode === MODE.REST && this.actTimers.length === 0)
            this.beginRest();
    }
    // Toggle the eased transition: on for value-driven moves, off for loop-driven ones.
    setEasing(on) {
        this.wrapEl.classList.toggle("cc-eased", on);
    }
    // Flick friction: bleed |flickVel| toward zero at flickDecel over dt.
    brakeFlick(dt) {
        this.flickVel -= Math.sign(this.flickVel) * Math.min(Math.abs(this.flickVel), tuning().flickDecel * dt);
    }
    // Land from a lift: a damped vertical bounce plus any horizontal flick decaying to a stop. Ends once the bounce time is up AND the slide has stopped.
    dropStep() {
        const T = tuning();
        const durS = T.dropDuration / 1000;
        const now = performance.now();
        const t = (now - this.dropStart) / 1000;
        const frameDt = this.dropLastT ? (now - this.dropLastT) / 1000 : 0;
        this.dropLastT = now;
        if (this.flickVel !== 0 && frameDt > 0) {
            const width = this.win.innerWidth;
            const margin = this.margin();
            this.x += this.flickVel * frameDt;
            this.brakeFlick(frameDt);
            if (this.x < margin) {
                this.x = margin;
                this.flickVel = 0;
            }
            else if (this.x > width - margin) {
                this.x = width - margin;
                this.flickVel = 0;
            }
        }
        if (t >= durS && this.flickVel === 0) {
            this.yOffset = T.walkRestY;
            this.place();
            this.settle();
            return;
        }
        const lift = T.walkLiftY - T.walkRestY;
        const omega = (T.dropBounceCount * Math.PI) / durS;
        const above = t < durS
            ? lift * Math.exp(-T.dropDecay * t) * Math.abs(Math.cos(omega * t))
            : 0;
        this.yOffset = T.walkRestY + above;
        this.place();
    }
    // Rest activity: turn edge-on and, while hidden mid-flip, swap to another image.
    flip() {
        if (this.mode !== MODE.REST || this.spriteUrls.length < 2)
            return;
        // A flip restarts the rest window and re-rolls itself at once; the cooldown stops two swaps landing back-to-back.
        const now = performance.now();
        if (now - (this.lastFlip ?? 0) < tuning().flipCooldown)
            return;
        this.lastFlip = now;
        this.playRole("flip", true);
        // Queued AFTER playRole (whose easeToward clears actTimers) so a teardown mid-flip also cancels the swap.
        this.actTimers.push(this.win.setTimeout(() => {
            this.setSprite(this.spriteBag.next(this.spriteUrls));
        }, tuning().flipSwap));
    }
    // Stop the sprite's animation: cancel the pending end timer, strip the behaviour class.
    stopAnimation() {
        if (this.animTimer != null) {
            this.win.clearTimeout(this.animTimer);
            this.animTimer = null;
        }
        this.imgEl.classList.remove(...CLEARABLE);
    }
    // Play an animation spec on the sprite's image. onEnd fires off a timer sized from the CSS duration (animationend is unreliable for custom-property animations).
    playAnimation(spec, onEnd) {
        this.stopAnimation();
        // Reflow so re-adding the same class restarts its animation.
        void this.imgEl.offsetWidth;
        // --cc-dir negates horizontal movement only, never mirrors artwork.
        if (spec.directional)
            this.imgEl.setCssProps({ "--cc-dir": Math.random() < 0.5 ? "-1" : "1" });
        this.imgEl.classList.add("cc-anim-" + spec.name);
        this.animTimer = this.win.setTimeout(() => {
            this.animTimer = null;
            this.stopAnimation();
            if (onEnd)
                onEnd();
        }, animationDurationMs(this.imgEl));
    }
    // Play a random animation of a function-role (flip/bob/tickle/sleep), without repeats.
    playRole(role, interruptible = false) {
        const name = (this.roleBags[role] ??= new Bag()).next(ANIMS_BY_ROLE[role]);
        if (name)
            this.beginAnim(ANIM_BY_NAME[name], interruptible);
    }
    // Enter ANIM, ease any in-flight pose to rest, play, then settle into rest. `interruptible` = a cursor may cut it short.
    beginAnim(spec, interruptible = false) {
        this.mode = MODE.ANIM;
        this.interruptible = interruptible;
        this.easeToward(tuning().walkRestY, () => {
            this.playAnimation(spec, () => this.beginRest());
        });
    }
    // ---- activity runner ---- Run an ordered activity list: each row rolled on its chance, the next starting when the previous calls done(). loop=true repeats.
    runActivities(list, loop) {
        this.clearActivities();
        this.actList = list;
        this.actLoop = loop;
        this.actIndex = 0;
        this.nextActivity(this.actToken);
    }
    nextActivity(token) {
        // A torn-down run bumped the token, so a stale callback no-ops.
        if (token !== this.actToken)
            return;
        // Iterative so failed rolls can't recurse; a full lap of failures ends the run.
        for (let tries = this.actList.length; tries > 0; tries--) {
            if (this.actIndex >= this.actList.length) {
                if (!this.actLoop)
                    return;
                this.actIndex = 0;
            }
            const act = this.actList[this.actIndex++];
            const chance = typeof act.chance === "string" ? tuning()[act.chance] : act.chance;
            if (Math.random() < chance) {
                act.run(this, () => this.nextActivity(token));
                return;
            }
        }
    }
    // Tear down the activity sequence: drop pending timers, bump the token.
    clearActivities() {
        this.actToken++;
        for (const id of this.actTimers)
            this.win.clearTimeout(id);
        this.actTimers.length = 0;
    }
    // Full teardown (pause off screen / destroy): every timer, any in-flight image animation, and the bubble — a stranded visible bubble would wedge the rest cycle.
    clearTimers() {
        this.clearActivities();
        this.stopAnimation();
        this.endEase();
        this.clearBubbleTimer();
        if (this.bubbleEl)
            this.bubbleEl.removeClass("cc-bubble-visible");
    }
    // Cancel the in-flight speak sequence; leaves the visible class alone.
    clearBubbleTimer() {
        if (this.bubbleTimer) { this.win.clearTimeout(this.bubbleTimer); this.bubbleTimer = null; }
    }
    // True while the pointer isn't meaningfully moving the sprite.
    isPointerStill() {
        const T = tuning();
        return (performance.now() - this.lastMoveT > T.walkMaxFrame)
            || (Math.abs(this.flickVel) < T.flickMinVelocity);
    }
    // HELD activity: one full climb of the shake-escalation ladder, then done().
    holdShake(done) {
        const T = tuning();
        let count = 0;
        const bouts = 1 + Math.floor(Math.random() * T.holdWiggleBouts);
        const total = HOLD_SHAKES.length * bouts;
        const bout = () => {
            if (this.mode !== MODE.HELD)
                return;
            const rung = Math.min(Math.floor(count / bouts), HOLD_SHAKES.length - 1);
            this.playAnimation(ANIM_BY_NAME[HOLD_SHAKES[rung]]);
            count++;
            const interval = rung === 0 ? T.holdWiggleInterval : T.holdStruggleInterval;
            this.actTimers.push(this.win.setTimeout(count >= total ? done : bout, interval));
        };
        bout();
    }
    // HELD activity: an escape attempt. Without the escape toggle, just hold for the window; with it, break free if the pointer is still.
    holdEscape(done) {
        const T = tuning();
        if (!this.character.escape) {
            this.actTimers.push(this.win.setTimeout(done, T.escapeStillWindow));
            return;
        }
        this.actTimers.push(this.win.setTimeout(() => {
            if (this.mode !== MODE.HELD)
                return;
            if (this.isPointerStill())
                this.playAnimation(ANIM_BY_NAME[HOLD_SHAKES[0]], () => {
                    if (this.mode === MODE.HELD)
                        this.release();
                });
            else
                done();
        }, T.escapeStillWindow));
    }
    // Arm one rest window: roll each fidget for a random point in its first part, then plant the window-end timer that re-enters the cycle.
    scheduleRest() {
        this.clearActivities();
        const windowMs = this.restUntil - performance.now();
        if (windowMs <= 0)
            return;
        const T = tuning();
        for (const act of REST_ACTIVITIES) {
            if (Math.random() >= T[act.chance])
                continue;
            const delay = Math.random() * windowMs * T.restIdleFraction;
            this.actTimers.push(this.win.setTimeout(() => act.play(this), delay));
        }
        // End the window: a mover walks, a 0-speed sprite re-rests. A fidget that animates first cancels this through easeToward.
        this.actTimers.push(this.win.setTimeout(() => this.beginWalk(), windowMs));
    }
    // One rest beat: asleep → a doze; awake → a spoken line or an idle move, per settings.
    playIdleBeat() {
        if (this.mode !== MODE.REST)
            return;
        if (this.bubbleEl && this.bubbleEl.hasClass("cc-bubble-visible"))
            return;
        if (this.isAsleep()) {
            this.playRole("sleep", true);
            return;
        }
        const s = this.settings;
        const canSpeak = this.character.quotes.length > 0 && s.chatterChance > 0;
        const canMove = s.idleEnabled;
        if (!canSpeak && !canMove)
            return;
        if (canSpeak && (!canMove || Math.random() * 100 < s.chatterChance)) {
            this.speak();
            return;
        }
        const name = this.idleBag.next(enabledList(s, "idle", this.rootOnly));
        if (name)
            this.beginAnim(ANIM_BY_NAME[name], true);
    }
    // Speak one line through the bubble — by default a non-repeating quote draw; a caller may pass an explicit `line`. Typewriter modes split it into sentences typed out consecutively; "off" shows the whole line at once.
    speak(line = this.quoteBag.next(this.character.quotes)) {
        if (!this.bubbleEl || !line)
            return;
        this.clearBubbleTimer();
        const chunks = this.settings.quoteTypewriter !== "off" ? splitQuote(line) : [line.trim()].filter(Boolean);
        if (chunks.length === 0)
            return;
        this.positionBubble();
        this.bubbleEl.addClass("cc-bubble-visible");
        this.playChunk(chunks, 0);
    }
    // Reveal chunk `idx`, hold it for its length-scaled duration (bubbleHoldMs), then advance to the next chunk or hide after the last.
    playChunk(chunks, idx) {
        const hold = () => {
            this.bubbleTimer = this.win.setTimeout(() => {
                if (idx + 1 < chunks.length)
                    this.playChunk(chunks, idx + 1);
                else
                    this.bubbleEl.removeClass("cc-bubble-visible");
            }, bubbleHoldMs(this.bubbleEl, this.settings.quoteDurationMs, chunks[idx]));
        };
        if (this.settings.quoteTypewriter !== "off")
            this.typeOut(chunks[idx], this.wrapBreaks(chunks[idx]), 0, hold);
        else { this.bubbleEl.setText(chunks[idx]); hold(); }
    }
    // Where the bubble will wrap `text` — the char index each visual line after the first begins at. Measured synchronously on the real bubble (emptied by the reveal before the next paint, so the full line never flashes); typeOut applies them as hard breaks so a word sits on its final line from its first character.
    wrapBreaks(text) {
        this.bubbleEl.setText(text);
        const node = this.bubbleEl.firstChild;
        const breaks = [];
        if (node) {
            const range = this.bubbleEl.doc.createRange();
            let lineTop = null;
            for (let k = 0; k < text.length; k++) {
                range.setStart(node, k);
                range.setEnd(node, k + 1);
                const top = range.getBoundingClientRect().top;
                if (lineTop === null)
                    lineTop = top;
                else if (top - lineTop > 1) { breaks.push(k); lineTop = top; }
            }
        }
        return breaks;
    }
    // Paint the first `i` chars of `text` with the pre-measured wraps as hard breaks; a completed line sheds its trailing wrap space.
    renderReveal(text, breaks, i) {
        this.bubbleEl.empty();
        const bounds = [...breaks, text.length];
        let start = 0;
        for (let b = 0; b < bounds.length && start < i; b++) {
            const end = bounds[b];
            let seg = text.slice(start, Math.min(i, end));
            if (i >= end)
                seg = seg.replace(/\s+$/, "");
            if (b > 0)
                this.bubbleEl.createEl("br");
            this.bubbleEl.appendText(seg);
            start = end;
        }
    }
    // Reveal `text` one char at a time, calling done() when whole. Punctuation lengthens the next gap: end marks add --cc-quote-pause-end, mid marks --cc-quote-pause-mid.
    typeOut(text, breaks, i, done) {
        this.renderReveal(text, breaks, i);
        if (i >= text.length) { done(); return; }
        const T = tuning();
        let delay = this.settings.quoteTypewriter === "fast" ? T.quoteTypeSpeedFast : T.quoteTypeSpeedSlow;
        const c = i > 0 ? text[i - 1] : "";
        if (/[.!?]/.test(c))
            delay += T.quotePauseEnd;
        else if (c === "…")
            delay += (text.slice(i).trim() === "" ? T.quotePauseEnd : T.quotePauseMid);
        else if (c === "," || c === ";" || c === "—")
            delay += T.quotePauseMid;
        this.bubbleTimer = this.win.setTimeout(() => this.typeOut(text, breaks, i + 1, done), delay);
    }
    // The single path to point the sprite at a URL — keeps the bubble inset in sync.
    setSprite(url) {
        this.imgEl.src = url;
        this.applyBubbleInset();
    }
    // Lift the bubble by the sprite's transparent-top inset. Guards against a sprite swap resolving late; a not-yet-laid-out image reads 0 and is corrected by the load re-run. The wrap's --cc-bubble-inset is the single store for both bubble flavours.
    applyBubbleInset() {
        const url = this.imgEl.src;
        spriteTopInsetFraction(url).then((frac) => {
            if (this.imgEl.src !== url)
                return;
            this.wrapEl.setCssProps({ "--cc-bubble-inset": frac * this.imgEl.offsetHeight + "px" });
        });
    }
    // Place the body-level sidebar bubble against the sprite (viewport coordinates — it lives on <body> so no panel frame clips it). No-op for the CSS-positioned floor bubble.
    positionBubble() {
        if (!this.bubbleAnchorEl)
            return;
        const r = this.bubbleAnchorEl.getBoundingClientRect();
        // Gap is a fraction of this surface's sprite max-height.
        const gap = tuning().bubbleGap * this.settings.sidebarSpriteMaxHeight;
        const inset = parseFloat(this.wrapEl.style.getPropertyValue("--cc-bubble-inset")) || 0;
        this.bubbleEl.setCssProps({
            left: (r.left + r.width / 2) + "px",
            bottom: (this.win.innerHeight - r.top - inset + gap) + "px",
        });
    }
    // Answer a double-tap: a surprise animation, or a bob plus a spoken line. Ends the carry first (no bounce); settles to rest if nothing animated.
    react() {
        this.endDrag();
        this.mode = MODE.REST;
        const s = this.settings;
        const surprises = enabledList(s, "surprise", this.rootOnly);
        if (surprises.length > 0 && Math.random() * 100 < s.surpriseChance) {
            this.beginAnim(ANIM_BY_NAME[this.surpriseBag.next(surprises)]);
        }
        else {
            if (s.animateOnQuote)
                this.playRole("bob");
            this.speak();
        }
        if (this.mode === MODE.REST)
            this.beginRest();
    }
    // Tear down a pick-up — the single place the carry ends.
    endDrag() {
        this.clearActivities();
        this.stopAnimation();
        this.imgEl.classList.remove("cc-dragging");
    }
    // The universal set-down: end the carry, resolve the release velocity, hand the landing bounce (and any flick) to the loop. isPointerStill tells a set-down from a flick (flickVel is stale when the pointer is held still).
    release() {
        this.endDrag();
        // DROP is loop-driven, so end any in-flight lift glide (a quick flick can release inside grab's ease).
        this.endEase();
        this.phase = 0;
        if (this.isPointerStill())
            this.flickVel = 0;
        this.mode = MODE.DROP;
        this.dropStart = performance.now();
        this.dropLastT = 0;
    }
    // ---- pointer input ---- Clamp x to the visible margins and commit the position.
    moveTo(clientX) {
        const width = this.win.innerWidth;
        const margin = this.margin();
        this.x = Math.min(width - margin, Math.max(margin, clientX));
        this.place();
    }
    // Pick the sprite straight up at the pointer; arm the held sequence after a delay.
    grab(clientX) {
        const T = tuning();
        this.mode = MODE.HELD;
        this.imgEl.classList.add("cc-dragging");
        this.stage.bringToFront(this);
        this.easeToward(T.walkLiftY);
        this.moveTo(clientX);
        this.flickVel = 0;
        this.lastMoveX = clientX;
        this.lastMoveT = performance.now();
        // Queued AFTER easeToward, whose clearActivities would otherwise drop it.
        this.actTimers.push(this.win.setTimeout(() => this.runActivities(HELD_ACTIVITIES, true), T.holdStart));
    }
    onDown(e) {
        if (e.button !== 0)
            return;
        this.pointerId = e.pointerId;
        this.pressX = e.clientX;
        this.pressY = e.clientY;
        this.pressMoved = false;
        // Grabbable → capture and pick straight up; non-grabbable → a press just wakes it.
        if (this.grabbable) {
            capturePointer(this.imgEl, e.pointerId);
            this.grab(e.clientX);
        }
        else {
            this.wake();
        }
    }
    onMove(e) {
        if (this.pointerId === null || e.pointerId !== this.pointerId || this.mode !== MODE.HELD)
            return;
        const T = tuning();
        // Past the threshold this press is a carry, not a tap: follow the pointer directly.
        if (!this.pressMoved && Math.hypot(e.clientX - this.pressX, e.clientY - this.pressY) >= T.dragThreshold) {
            this.pressMoved = true;
            this.setEasing(false);
        }
        // Instantaneous pointer velocity (dt floored to reject sub-frame spikes): reads ~0 the moment the pointer stops, so a decelerate-then-release counts as a set-down.
        const now = performance.now();
        const dtv = Math.max((now - this.lastMoveT) / 1000, T.flickSampleFloor / 1000);
        this.flickVel = (e.clientX - this.lastMoveX) / dtv;
        this.lastMoveX = e.clientX;
        this.lastMoveT = now;
        this.yOffset = T.walkLiftY;
        this.moveTo(e.clientX);
    }
    onUp(e) {
        if (this.pointerId === null || e.pointerId !== this.pointerId)
            return;
        releasePointer(this.imgEl, e.pointerId);
        const moved = this.pressMoved;
        this.pointerId = null;
        this.pressMoved = false;
        if (!this.grabbable) {
            this.tapOrReact();
            return;
        }
        if (this.mode !== MODE.HELD)
            return;
        if (moved) {
            this.release();
            return;
        }
        this.tapOrReact();
    }
    // A quick second tap reacts; the first just sets a grabbed sprite back down.
    tapOrReact() {
        const now = performance.now();
        if (now - this.lastTapT < tuning().doubleClick) {
            this.lastTapT = 0;
            this.react();
        }
        else {
            this.lastTapT = now;
            if (this.grabbable)
                this.release();
        }
    }
    onCancel(e) {
        if (this.pointerId === null || e.pointerId !== this.pointerId)
            return;
        releasePointer(this.imgEl, e.pointerId);
        this.pointerId = null;
        this.pressMoved = false;
        if (this.mode === MODE.HELD)
            this.release();
    }
    // Stop every timer and remove the element; layering eviction is the stage's job.
    destroy() {
        this.clearTimers();
        this.wrapEl.remove();
    }
}
module.exports = { MODE, Walker };
