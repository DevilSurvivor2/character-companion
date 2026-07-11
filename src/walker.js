"use strict";
const { ANIMS_BY_ROLE, ANIM_BY_NAME, HOLD_SHAKES } = require("./registries.js");
const { Bag, bubbleHoldMs, capturePointer, enabledList, playAnimation, randRange, releasePointer, splitQuote, spriteTopInsetFraction, stopAnimation, tuning } = require("./toolkit.js");
// A walker is in exactly one MODE; every interaction is a transition and the loop reads this field. WALK travelling · REST in the band · HELD carried · DROP landing · ANIM playing. Only WALK and DROP have per-frame bodies; HELD/REST/ANIM are event- or timer-driven.
const MODE = { WALK: "walk", REST: "rest", HELD: "held", DROP: "drop", ANIM: "anim" };
// Independent rest fidgets, each rolled on its own chance (a tuning key) and fired once at a random point in the FIRST part of the rest window (--cc-rest-idle-fraction). They layer. Add one: append a row.
const REST_ACTIVITIES = [
    { chance: "idleChance", play: (w) => w.playIdleBeat() },
    { chance: "flipChance", play: (w) => w.flip() },
];
// Held-sprite activity sequence: an ordered LOOPING list (shake-escalation climb, then an escape attempt) run by the activity runner. Each run(w, done) calls done() when finished.
const HELD_ACTIVITIES = [
    { name: "shake", chance: 1, run: (w, done) => w.holdShake(done) },
    { name: "escape", chance: "escapeChance", run: (w, done) => w.holdEscape(done) },
];
// One sprite's whole life: DOM, state, and every self-contained behaviour (motion, animation, rest fidgets, grab/carry, the activity runner, timers). Cross-walker coordination lives on CompanionStage via `this.stage` (null for a stage-less sprite).
class Walker {
    constructor(stage, plugin, character, els, urls, speed) {
        this.stage = stage;
        this.plugin = plugin;
        this.character = character;
        this.id = character.id;
        this.wrapEl = els.wrapEl;
        this.imgEl = els.imgEl;
        this.bubbleEl = els.bubbleEl;
        // The window this sprite's DOM actually lives in (the popped-out one for a detached sidebar leaf). Captured once, never re-read from `activeWindow`: every timer below is a set/clear pair, and ids don't cross windows.
        this.win = els.wrapEl.win;
        // Set only for a fixed (frame-escaping) sidebar bubble: the element whose head the bubble is JS-positioned over. Null for the floor bubble (an absolute child of its own walker wrap, positioned by CSS).
        this.bubbleAnchorEl = els.bubbleAnchorEl || null;
        // Images/quotes are per-sprite; idle/surprise share one bag each across the troupe (stage cycles them without repeats), falling back to private when stageless.
        this.spriteBag = new Bag();
        this.quoteBag = new Bag();
        this.idleBag = stage ? stage.idleBag : new Bag();
        this.surpriseBag = stage ? stage.surpriseBag : new Bag();
        // Lazy per-role bags for the function-role pulls (flip/bob/tickle/sleep).
        this.roleBags = {};
        this.spriteUrls = urls;
        this.speed = speed;
        // ---- role variables ---- The universal cycle reads ONLY these flags, never `this.stage`, so a surface configures a walker by setting them rather than forking on type.
        this.grabbable = !!stage; // pointer-grab lifts it into HELD/DROP; else a tap just wakes
        this.rootOnly = !!stage;  // exclude off-floor animations the bottom strip would clip
        this.canSleep = !stage;   // may doze when untouched (also gated live by stream mode)
        this.halfWidth = 0;
        const T = tuning();
        // Start inside the rest band so even a standing (0%) walker isn't jammed against an edge. (A stage-less sprite isn't x-positioned.)
        const band = stage ? stage.restBand() : null;
        this.x = band ? randRange(band.lo, band.hi) : 0;
        this.walkDir = 1;
        this.walkDist = 0;
        // The walk's live pace. beginWalk starts it at the walker's own speed; cursor react steers it (and walkDir/walkDist) mid-walk.
        this.walkPace = speed;
        this.mode = MODE.REST;
        this.interruptible = false;
        // Provisional; beginRest (via createWalker / first resume) sets the real one.
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
        // Activity runner state, torn down together by clearActivities (token no-ops stale callbacks).
        this.actTimers = [];
        this.actToken = 0;
        this.actIndex = 0;
        this.actList = null;
        this.actLoop = false;
        this.watchUntil = 0;
        this.easeTimer = null;
        // The single live timer of a speak sequence. A quote types out sentence by sentence, but strictly one step at a time (each typewriter tick / sentence hold schedules the next), so only ever one is pending.
        this.bubbleTimer = null;
        // Sleep clock: time of last interaction.
        this.lastInteraction = Date.now();
        this.imgEl.draggable = false;
        this.imgEl.alt = character.name;
        this.imgEl.addEventListener("pointerdown", (e) => this.onDown(e));
        this.imgEl.addEventListener("pointermove", (e) => this.onMove(e));
        this.imgEl.addEventListener("pointerup", (e) => this.onUp(e));
        this.imgEl.addEventListener("pointercancel", (e) => this.onCancel(e));
        // On each load, cache the half-width (so the walk loop avoids a per-frame reflow) and re-anchor the bubble now that the rendered height is real.
        this.imgEl.addEventListener("load", () => { this.halfWidth = this.imgEl.offsetWidth / 2; this.applyBubbleInset(); });
        this.setSprite(this.spriteBag.next(urls));
        // A cached/data-URL sprite can complete synchronously (no load event guaranteed); setSprite's inset pass already covers it, only the half-width needs seeding.
        if (this.imgEl.complete && this.imgEl.offsetWidth)
            this.halfWidth = this.imgEl.offsetWidth / 2;
    }
    get settings() { return this.plugin.settings; }
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
    // Advance the walk bob by a stride and set the vertical, leaving x untouched: one full step per walkStepLength of travel, so every character shares the same bob cycle and only its speed scales the cadence (a boosted flee steps faster too).
    arc(stride) {
        const T = tuning();
        this.phase += (Math.abs(stride) / T.walkStepLength) * Math.PI;
        this.yOffset = T.walkRestY + (T.walkLiftY - T.walkRestY) * Math.abs(Math.sin(this.phase));
    }
    // One frame. HELD/DROP own the sprite and skip cursor-react; the react only steers walk variables / requests transitions, then the mode table below does all the moving.
    step(dt) {
        if (this.mode !== MODE.HELD && this.mode !== MODE.DROP)
            this.applyCursorReact();
        if (this.mode === MODE.WALK)
            this.walkStep(dt);
        else if (this.mode === MODE.DROP)
            this.dropStep();
    }
    // WALK body — the only mover: travel walkDir × walkPace until the distance is spent, settle when done. Cursor react steers it purely by writing the three walk variables (walkDir, walkPace, walkDist). Travel drives the bob; a parked walk (walkPace 0, the cursor stop gap) breathes it at the walker's own speed instead, so a stopped watcher keeps its own cadence (a 0%-speed character never reaches WALK, so the stride is never zero here).
    walkStep(dt) {
        const advance = Math.min(this.walkPace * dt, this.walkDist);
        this.walkDist -= advance;
        if (this.walkPace > 0)
            this.advanceAlong(this.walkDir * advance, activeWindow.innerWidth);
        else
            this.arc(this.speed * dt);
        this.place();
        if (this.walkDist <= 0)
            this.settle();
    }
    // Glide the image's (maybe mid-animation) transform back to rest: freeze the live pose inline, arm the eased transition, clear it next reflow so it eases to identity. Returns whether there was a pose to settle (caller waits --cc-ease only if so).
    easeImagePose() {
        const img = this.imgEl;
        const current = activeWindow.getComputedStyle(img).transform;
        stopAnimation(img);
        if (!current || current === "none")
            return false;
        img.setCssProps({ transform: current });
        img.classList.add("cc-eased");
        void img.offsetWidth;
        img.setCssProps({ transform: "" });
        return true;
    }
    // The universal ease — the single buffer every cross-mode transition passes through: settle any in-flight image animation back to rest AND glide the wrap's vertical to targetY, then run `then` after --cc-ease (at once if nothing to ease). Caller owns the mode; this also tears down the old mode's activity sequence.
    easeToward(targetY, then) {
        this.clearActivities();
        this.endWatch();
        // A pending ease timer means a previous ease is still in flight: yOffset already holds THAT ease's target, but the rendered position is mid-glide. Count it as movement even when the target matches, so this call re-arms the glide (a live transition retargets smoothly) instead of early-returning — an early return would run `then` mid-glide with cc-eased stranded, and the next setEasing(false) would snap the sprite to the target. (Only the timer is cleared, never endEase: the eased state must survive the retarget.)
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
    // End the ease now — drop any pending ease timer and strip the eased state (both cc-eased classes and the frozen inline pose) so nothing smooths (or later snaps) a value-driven frame. The timer's own tail AND the cut-short for every early exit (full teardown, drop release); a no-op when nothing is easing.
    endEase() {
        if (this.easeTimer) { this.win.clearTimeout(this.easeTimer); this.easeTimer = null; }
        this.imgEl.classList.remove("cc-eased");
        this.imgEl.setCssProps({ transform: "" });
        this.setEasing(false);
    }
    // React to a cursor near the band — pure steering, refreshed every frame while reachable: it only writes the three walk variables (walkDir, walkPace, walkDist) on a live walk, claiming WALK through easeToward first when needed. It never touches the vertical itself — the bob simply rides the walk's stride, so a boosted flee is exactly the plain walk (and its bob) sped up.
    applyCursorReact() {
        const T = tuning();
        const cursor = this.stage.cursor;
        const gap = this.x - cursor.x;
        // Out of reach: end any watch (so the next visit arms a fresh window), restore the walk's own pace, and let it run out on its own (a fled walker calmly finishes its leftover distance and settles).
        if (cursor.x < 0 || cursor.y < this.stage.stageTop() - T.reactRadius || Math.abs(gap) > T.reactRadius) {
            this.endWatch();
            if (this.mode === MODE.WALK)
                this.walkPace = this.speed;
            return;
        }
        if (this.mode === MODE.ANIM && !this.interruptible)
            return;
        const curious = this.character.curious;
        // Curious stop gap: park the travel (walkPace 0 — the walk stays in WALK and keeps breathing its bob) and roll the chatter window.
        if (curious && Math.abs(gap) <= T.curiousGap) {
            if (this.mode === MODE.WALK)
                this.walkPace = 0;
            this.watchTick();
            return;
        }
        // A standing (0%-speed) character can't walk, so it neither flees nor approaches; up close it only chatters (above).
        if (this.speed <= 0)
            return;
        // Steer — one fast biased walk either way, only the direction and target differ: flee = away, running a full radius so it never settles inside one; curious = toward, the gap itself as the distance (the stop gap above parks it on arrival).
        const dir = (gap >= 0 ? 1 : -1) * (curious ? -1 : 1);
        if (this.mode !== MODE.WALK) {
            // Claim WALK through the ease. Non-interruptible ANIM doubles as the latch: until beginWalk lands, every frame bounces off the guard above instead of re-claiming.
            this.mode = MODE.ANIM;
            this.interruptible = false;
            this.easeToward(T.walkRestY, () => this.beginWalk(dir));
            return;
        }
        this.walkDir = dir;
        this.walkPace = this.speed * T.reactSpeedMult;
        this.walkDist = curious ? Math.abs(gap) : T.reactRadius;
    }
    // Curiosity chatter: while watching the cursor, arm a randomised window; each time one elapses, re-arm and roll once to speak a line (skip if a bubble is already up).
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
        // 0% speed never travels, so a "walk" just keeps resting — the single variable that makes a panel sprite and a 0-speed floor sprite behave alike.
        if (this.speed <= 0) {
            this.beginRest();
            return;
        }
        const T = tuning();
        this.clearActivities();
        this.endWatch();
        // The arc drives --cc-y every frame, so the smoothing transition must be off.
        this.setEasing(false);
        // walkDir/walkDist default to random (a walkaside passes an explicit minimum); walkPace starts at the walker's own speed. Cursor react may steer all three mid-walk.
        this.walkDir = dir ?? (Math.random() < 0.5 ? -1 : 1);
        this.walkDist = remaining ?? Math.random() * T.walkMaxDistanceFrac * activeWindow.innerWidth;
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
        // Sync the doze dim to the sleep clock once per cycle, so falling asleep dims promptly (and waking undims) without waiting for a doze beat.
        this.setAsleep(this.isAsleep());
        // Resolve a same-spot overlap before any rest glide; if THIS walker yields it keeps walking (no glide) so the vertical doesn't snap.
        if (this.stage && this.stage.resolveRestOverlap(this))
            return;
        this.restUntil = performance.now() + this.restWindowMs();
        this.phase = 0;
        // Glide down to rest in case the walk ended mid-arc, then schedule the window.
        this.easeToward(T.walkRestY);
        this.scheduleRest();
    }
    // Length of one rest window — the idle min–max delay (the single rest-time source for every walker), stretched by the sleep multiplier while asleep.
    restWindowMs() {
        const T = tuning();
        const base = randRange(T.idleMinDelay, T.idleMaxDelay);
        return this.isAsleep() ? base * T.sleepMultiplier : base;
    }
    // ---- sleep ---- Asleep once a sleep-capable walker has gone untouched for sleepAfterMs. Gated by `canSleep` (off for floor walkers) and forced off live in stream mode.
    isAsleep() {
        const ms = this.settings.sleepAfterMs;
        return this.canSleep && !this.settings.streamEnabled && ms > 0 && Date.now() - this.lastInteraction >= ms;
    }
    // Dim while dozing. On the wrap so the per-beat image animations can't clear it.
    setAsleep(asleep) {
        this.wrapEl.classList.toggle("cc-asleep", asleep);
    }
    // Any interaction resets the sleep clock, undims, and (if resting) re-arms the cycle so the awake cadence takes effect at once.
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
    // Toggle the short bottom-easing transition. On for lift / rest-descent (value-driven); off for walking / the landing bounce (loop-driven).
    setEasing(on) {
        this.wrapEl.classList.toggle("cc-eased", on);
    }
    // Flick friction: bleed |flickVel| toward zero at flickDecel over dt. The one place momentum decays — the in-flight slide and the release both use it.
    brakeFlick(dt) {
        this.flickVel -= Math.sign(this.flickVel) * Math.min(Math.abs(this.flickVel), tuning().flickDecel * dt);
    }
    // Land from a lift: a damped vertical bounce plus any horizontal flick decaying to a stop, both loop-driven. Ends once the bounce time is up AND the slide has stopped.
    dropStep() {
        const T = tuning();
        const durS = T.dropDuration / 1000;
        const now = performance.now();
        const t = (now - this.dropStart) / 1000;
        const frameDt = this.dropLastT ? (now - this.dropLastT) / 1000 : 0;
        this.dropLastT = now;
        if (this.flickVel !== 0 && frameDt > 0) {
            const width = activeWindow.innerWidth;
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
        // A flip animates, so it restarts the rest window (easeToward → beginRest) and re-rolls itself at once — without this cooldown two swaps could land back-to-back. Self-contained: `lastFlip` is owned and read only here (lazily 0 on the first flip).
        const now = performance.now();
        if (now - (this.lastFlip ?? 0) < tuning().flipCooldown)
            return;
        this.lastFlip = now;
        this.playRole("flip", true);
        // Tracked in actTimers (queued AFTER playRole, whose easeToward clears them) so a teardown mid-flip also cancels the swap.
        this.actTimers.push(this.win.setTimeout(() => {
            this.setSprite(this.spriteBag.next(this.spriteUrls));
        }, tuning().flipSwap));
    }
    // Play a random animation of a function-role (flip/bob/tickle/sleep), drawn without repeats from a per-role bag. The single path for every role-named behaviour.
    playRole(role, interruptible = false) {
        const name = (this.roleBags[role] ??= new Bag()).next(ANIMS_BY_ROLE[role]);
        if (name)
            this.beginAnim(ANIM_BY_NAME[name], interruptible);
    }
    // Play an interaction animation (idle move or reaction): enter ANIM, ease any in-flight pose to rest, play this one, settle into rest. `interruptible` = a cursor may cut it short.
    beginAnim(spec, interruptible = false) {
        this.mode = MODE.ANIM;
        this.interruptible = interruptible;
        this.easeToward(tuning().walkRestY, () => {
            playAnimation(this.imgEl, spec, () => this.beginRest());
        });
    }
    // ---- activity runner (shared, mode-scoped) ---- Run an ordered activity list: each row rolled on its chance, passers run in order (next starts when the previous calls done()). loop=true repeats.
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
        // Iterative execution to prevent unbounded synchronous recursion. A full lap of failures terminates the run.
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
    // Tear down the activity sequence: drop pending timers, bump the token so an in-flight runner callback no-ops. The one teardown used by every mode exit.
    clearActivities() {
        this.actToken++;
        for (const id of this.actTimers)
            this.win.clearTimeout(id);
        this.actTimers.length = 0;
    }
    // Full teardown (pause off screen / destroy): every timer, any in-flight image animation, and the bubble. Widest of three scopes (clearActivities = the sequence; endDrag = the carry). The bubble's visible CLASS is dropped too, else a stranded bubble wedges the rest cycle (playIdleBeat won't speak over a visible one).
    clearTimers() {
        this.clearActivities();
        stopAnimation(this.imgEl);
        this.endEase();
        this.clearBubbleTimer();
        if (this.bubbleEl)
            this.bubbleEl.removeClass("cc-bubble-visible");
    }
    // Cancel the in-flight speak sequence (whichever step is pending). Leaves the visible class alone — speak() re-arms it, clearTimers() drops it.
    clearBubbleTimer() {
        if (this.bubbleTimer) { this.win.clearTimeout(this.bubbleTimer); this.bubbleTimer = null; }
    }
    // True while the pointer isn't meaningfully moving the sprite. Shared by the held escape watch and release's set-down-vs-flick decision.
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
            playAnimation(this.imgEl, ANIM_BY_NAME[HOLD_SHAKES[rung]]);
            count++;
            const interval = rung === 0 ? T.holdWiggleInterval : T.holdStruggleInterval;
            this.actTimers.push(this.win.setTimeout(count >= total ? done : bout, interval));
        };
        bout();
    }
    // HELD activity: an escape attempt. Without the escape toggle, hold for the window then loop back to shaking. With it, break free if the pointer is still (one shake, then released to drop); if still dragging, the escape fails.
    holdEscape(done) {
        const T = tuning();
        if (!this.character.escape) {
            this.actTimers.push(this.win.setTimeout(done, T.escapeStillWindow));
            return;
        }
        this.actTimers.push(this.win.setTimeout(() => {
            if (this.mode !== MODE.HELD)
                return;
            // Wriggle free only if the pointer is still (same test release uses).
            if (this.isPointerStill())
                playAnimation(this.imgEl, ANIM_BY_NAME[HOLD_SHAKES[0]], () => {
                    if (this.mode === MODE.HELD)
                        this.release();
                });
            else
                done();
        }, T.escapeStillWindow));
    }
    // Arm one rest window, uniformly for every walker: roll each independent fidget for a random point in the first part of the window (they layer), then plant the window-end timer that re-enters the cycle. (playIdleBeat dozes on its own when asleep.)
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
        // End the window: a mover walks, a 0-speed sprite re-rests. A fidget that animates first cancels this through easeToward; otherwise it fires here.
        this.actTimers.push(this.win.setTimeout(() => this.beginWalk(), windowMs));
    }
    // One rest beat. Asleep → a doze (the dim is synced in beginRest). Awake → a spoken line or an idle move, gated by settings (chatter chance = how often a beat speaks vs moves). The idle pool excludes off-floor strolls for a root-only walker.
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
    // Speak one line through the one bubble — by default one of the character's quotes (drawn without repeats); a caller may pass an explicit `line` (a rolled table result, a fed message) to voice arbitrary text through the identical pipeline. With quoteTypewriter "slow"/"fast", split into sentences typed out consecutively (the CommentFeed "push a part" idea, but sequential — one held at a time, not stacked); "off", the whole line is one chunk shown at once. No-op with no bubble/nothing to say; a blank/punctuation-only line yields no chunks and is skipped.
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
    // Reveal chunk `idx` (typed out when streaming, dropped in whole when not), hold it for its length-scaled duration (bubbleHoldMs — the shared staying-time rule, spending quoteDurationMs over this bubble), then advance to the next chunk or hide after the last. Each chunk holds for its own content, so a multi-sentence stream runs proportionally longer.
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
    // Where the bubble will wrap `text` — the char index each visual line after the first begins at. Measured on the real bubble itself: set to the full text and read synchronously, then emptied by the reveal before the next paint, so the full line never flashes and the breaks are the browser's own by construction. typeOut applies them as hard breaks while revealing, which lets a word sit on its final line from its first character instead of growing on one line and jumping to the next.
    wrapBreaks(text) {
        this.bubbleEl.setText(text);
        const node = this.bubbleEl.firstChild;
        const breaks = [];
        if (node) {
            const range = activeDocument.createRange();
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
    // Paint the first `i` chars of `text` with the pre-measured wraps applied as hard breaks, so the box grows line by line (width within a line, height as a new line opens) with no reserved empty space and no word ever teleporting. A completed line sheds its trailing wrap space.
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
    // Reveal `text` one char at a time (wrapped at the pre-measured `breaks`), calling done() when whole. The gap after a char lengthens on punctuation: end marks (. ! ? and a sentence-final …) add --cc-quote-pause-end, mid marks (, ; — and a mid-sentence …) add --cc-quote-pause-mid (half). A … is sentence-final when only whitespace follows it in this already-split sentence.
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
    // The single path to point the sprite at a URL: swap the image, then re-anchor the bubble to the new artwork. Every src assignment (create, rest flip, url refresh) routes here so the inset stays in sync.
    setSprite(url) {
        this.imgEl.src = url;
        this.applyBubbleInset();
    }
    // Lift the bubble by the current sprite's transparent-top inset (measured async, cached per URL) so it hugs the artwork, not the empty box top. Guards against a sprite swap resolving late; a not-yet-laid-out image reads 0 height here and is corrected by the load-listener re-run. The wrap's --cc-bubble-inset is the single store: styles.css positions the floor bubble off it, positionBubble reads it back for the sidebar bubble.
    applyBubbleInset() {
        const url = this.imgEl.src;
        spriteTopInsetFraction(url).then((frac) => {
            if (this.imgEl.src !== url)
                return;
            this.wrapEl.setCssProps({ "--cc-bubble-inset": frac * this.imgEl.offsetHeight + "px" });
        });
    }
    // Place the body-level sidebar bubble against the sprite. It lives on <body> (like the comment feed) so no panel frame clips it, so coordinates are viewport-relative and set here: centred on the picture, bottom edge floating --cc-bubble-gap above the top-most coloured pixel (picture top + measured inset), tail pointing down. No-op for the floor bubble (no anchor) — CSS positions that one off the same inset + gap.
    positionBubble() {
        if (!this.bubbleAnchorEl)
            return;
        const r = this.bubbleAnchorEl.getBoundingClientRect();
        // Gap is a fraction of this surface's sprite max-height (sidebar-only path — the floor bubble is CSS-positioned), keeping the float proportional across the two heights.
        const gap = tuning().bubbleGap * this.settings.sidebarSpriteMaxHeight;
        const inset = parseFloat(this.wrapEl.style.getPropertyValue("--cc-bubble-inset")) || 0;
        this.bubbleEl.setCssProps({
            left: (r.left + r.width / 2) + "px",
            bottom: (activeWindow.innerHeight - r.top - inset + gap) + "px",
        });
    }
    // Answer a double-tap: a surprise animation or (optionally) a bob plus a spoken line. End the carry first (no bounce); settle to rest if nothing animated. (The sprite image only ever swaps via the chanced flip rest activity, never on a poke.)
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
    // Tear down a pick-up: clear the held sequence + the dragging class. The single place the carry ends — release and react both route here.
    endDrag() {
        this.clearActivities();
        stopAnimation(this.imgEl);
        this.imgEl.classList.remove("cc-dragging");
    }
    // The universal set-down: end the carry, resolve the release velocity, hand the landing bounce (and any flick) to the loop. isPointerStill tells a set-down (zero flickVel) from a flick (flickVel is stale when the pointer is held still).
    release() {
        this.endDrag();
        // DROP takes the wrap loop-driven, so end any in-flight lift glide (a quick flick can release inside grab's ease) instead of leaving its timer pending.
        this.endEase();
        this.phase = 0;
        if (this.isPointerStill())
            this.flickVel = 0;
        this.mode = MODE.DROP;
        this.dropStart = performance.now();
        this.dropLastT = 0;
    }
    // ---- pointer input: grab, carry, drop, double-tap ---- Clamp x to the visible margins and commit the position.
    moveTo(clientX) {
        const width = activeWindow.innerWidth;
        const margin = this.margin();
        this.x = Math.min(width - margin, Math.max(margin, clientX));
        this.place();
    }
    // Pick the sprite straight up at the pointer: ease the lift up, move it under the pointer, arm the held sequence after a delay.
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
        // Grabbable → capture and pick straight up. Non-grabbable → a press just wakes it (a double tap, detected on release, reacts).
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
        // Past the threshold this press is a carry, not a tap: follow the pointer directly, so drop the lift-ease.
        if (!this.pressMoved && Math.hypot(e.clientX - this.pressX, e.clientY - this.pressY) >= T.dragThreshold) {
            this.pressMoved = true;
            this.setEasing(false);
        }
        // Live pointer velocity = the last segment's instantaneous speed (dt floored to reject sub-frame spikes). Instantaneous reads ~0 the moment the pointer stops, so isPointerStill catches a decelerate-then-release that a lagging average would miss.
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
        // A non-grabbable sprite was never carried; a quick double tap reacts.
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
    // Stop every timer and remove the element. Layering eviction is the stage's job.
    destroy() {
        this.clearTimers();
        this.wrapEl.remove();
    }
}
module.exports = { MODE, Walker };
