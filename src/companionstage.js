"use strict";
const { Bag, appActive, resolvePathList, shuffle, tuning } = require("./toolkit.js");
const { Cursor } = require("./cursor.js");
const { MODE, Walker } = require("./walker.js");
// One overlay pinned to the bottom of the window, a Walker per root-enabled character. Owns the frame loop, the shared cursor, and every walker-to-walker relation.
class CompanionStage {
    constructor(plugin) {
        this.plugin = plugin;
        this.stageEl = null;
        // Set by mount(); nothing schedules a frame before then.
        this.win = null;
        this.walkers = new Map();
        this.raf = null;
        this.lastFrame = null;
        this.cursor = new Cursor((x, y) => this.tickleWalkerAt(x, y));
        // One idle + one surprise bag shared by the troupe; images/quotes stay per-walker.
        this.idleBag = new Bag();
        this.surpriseBag = new Bag();
        // Overlapping walker pairs already z-ordered; an isolated crossing re-rolls a pair.
        this.layered = new Set();
        this.tick = this.tick.bind(this);
    }
    mount() {
        if (this.stageEl)
            return;
        // Pinned to the MAIN window's body (never `activeDocument`); every listener below addresses the same window, so pause() can always cancel tick()'s rAF.
        this.stageEl = document.body.createDiv({ cls: "cc-root-stage" });
        this.win = this.stageEl.win;
        const doc = this.stageEl.doc;
        this.plugin.registerDomEvent(this.win, "resize", () => this.onResize());
        this.plugin.registerDomEvent(this.win, "pointermove", (e) => this.cursor.move(e));
        this.plugin.registerDomEvent(doc.documentElement, "pointerleave", () => this.cursor.leave());
        this.refresh();
        this.plugin.registerDomEvent(this.win, "blur", () => this.sync());
        this.plugin.registerDomEvent(this.win, "focus", () => this.sync());
        this.plugin.registerDomEvent(doc, "visibilitychange", () => this.sync());
        this.sync();
    }
    unmount() {
        this.pause();
        for (const w of this.walkers.values())
            this.destroyWalker(w);
        this.walkers.clear();
        if (this.stageEl) {
            this.stageEl.remove();
            this.stageEl = null;
        }
    }
    // Stop the frame loop and clear every walker's pending timer.
    pause() {
        if (this.raf !== null) {
            this.win.cancelAnimationFrame(this.raf);
            this.raf = null;
        }
        this.lastFrame = null;
        for (const w of this.walkers.values())
            w.pauseRest();
    }
    // Restart the loop (lastFrame stays null so tick skips the first dt — no jump after a long pause) and re-arm any resting walker, whose window timer pause cleared.
    resume() {
        if (this.walkers.size === 0) {
            this.pause();
            return;
        }
        if (this.raf !== null)
            return;
        this.raf = this.win.requestAnimationFrame(this.tick);
        for (const w of this.walkers.values())
            w.resumeRest();
    }
    sync() {
        if (appActive())
            this.resume();
        else
            this.pause();
    }
    // Remove a walker: stop its timers and drop any layering pair naming it.
    destroyWalker(w) {
        w.destroy();
        for (const o of this.walkers.values())
            this.layered.delete(this.pairKey(w, o));
    }
    // Reconcile walkers against current settings without disturbing the ones that stay.
    refresh() {
        const stage = this.stageEl;
        if (!stage)
            return;
        const settings = this.plugin.settings;
        stage.setCssProps({
            "--cc-sprite-max-height": String(settings.rootSpriteMaxHeight),
        });
        const base = settings.rootWalkSpeed;
        const enabled = this.plugin.characterData.characters.filter((c) => c.rootEnabled);
        const wanted = new Set(enabled.map((c) => c.id));
        let changed = false;
        for (const [id, w] of this.walkers) {
            if (!wanted.has(id)) {
                this.destroyWalker(w);
                this.walkers.delete(id);
                changed = true;
            }
        }
        for (const c of enabled) {
            const urls = resolvePathList(this.plugin.app, c.spritePath);
            // Per-character speed scales the global base: 0% stands, 100% = base.
            const speed = base * (c.walkSpeedPct / 100);
            let w = this.walkers.get(c.id);
            if (!w) {
                if (urls.length === 0)
                    continue;
                this.walkers.set(c.id, this.createWalker(c, urls, speed));
                changed = true;
                continue;
            }
            w.character = c;
            w.imgEl.alt = c.name;
            w.speed = speed;
            if (urls.length === 0) {
                this.destroyWalker(w);
                this.walkers.delete(c.id);
                changed = true;
                continue;
            }
            w.spriteUrls = urls;
            // Re-pick only when the current picture left the list.
            if (!urls.includes(w.imgEl.src))
                w.setSprite(w.spriteBag.next(urls));
        }
        // Re-deal stacking depth only on a cast change.
        if (changed)
            this.shuffleLayers();
        for (const w of this.walkers.values())
            w.measure();
        this.sync();
    }
    createWalker(character, urls, speed) {
        const wrap = this.stageEl.createDiv({ cls: "cc-walker" });
        const img = wrap.createEl("img", { cls: "cc-sprite" });
        const bubble = wrap.createDiv({ cls: "cc-bubble" });
        const w = new Walker(this, this.plugin, character, { wrapEl: wrap, imgEl: img, bubbleEl: bubble }, urls, speed);
        // Provisional top rank; shuffleLayers re-deals on refresh.
        this.bringToFront(w);
        w.place();
        // Rest ends on a window timer, so a fresh walker needs one planted.
        w.beginRest();
        return w;
    }
    tick(now) {
        if (this.walkers.size === 0) {
            this.raf = null;
            this.lastFrame = null;
            return;
        }
        this.raf = this.win.requestAnimationFrame(this.tick);
        if (this.lastFrame === null) {
            this.lastFrame = now;
            return;
        }
        let dt = (now - this.lastFrame) / 1000;
        this.lastFrame = now;
        if (dt <= 0)
            return;
        const maxFrame = tuning().walkMaxFrame / 1000;
        if (dt > maxFrame)
            dt = maxFrame;
        for (const w of this.walkers.values())
            w.step(dt);
        this.updateLayering();
    }
    // True when two walkers intersect within `frac` of their combined half-widths.
    overlap(a, b, frac) {
        return Math.abs(a.x - b.x) < (a.halfWidth + b.halfWidth) * frac;
    }
    // Canonical key for an unordered walker pair.
    pairKey(a, b) {
        return a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
    }
    // Re-roll stacking order once per crossing, and only if the pair is alone (no third walker touching either); the pair is forgotten when they part.
    updateLayering() {
        const frac = tuning().layerOverlapFrac;
        const ws = [...this.walkers.values()];
        for (let i = 0; i < ws.length; i++) {
            for (let j = i + 1; j < ws.length; j++) {
                const a = ws[i], b = ws[j];
                // A carried sprite owns the top; leave its order to grab.
                if (a.mode === MODE.HELD || b.mode === MODE.HELD)
                    continue;
                const key = this.pairKey(a, b);
                if (!this.overlap(a, b, frac)) {
                    this.layered.delete(key);
                    continue;
                }
                if (this.layered.has(key))
                    continue;
                this.layered.add(key);
                if (this.isolatedPair(a, b, ws, frac))
                    this.bringToFront(Math.random() < 0.5 ? a : b);
            }
        }
    }
    // True when no walker other than a/b overlaps either of them.
    isolatedPair(a, b, ws, frac) {
        for (const c of ws) {
            if (c === a || c === b)
                continue;
            if (this.overlap(c, a, frac) || this.overlap(c, b, frac))
                return false;
        }
        return true;
    }
    // Assign a stacking rank (compact 1..N) and mirror it to the DOM.
    setZ(w, z) {
        w.z = z;
        w.wrapEl.setCssProps({ "--cc-z": String(z) });
    }
    // Raise a walker to the top, others keeping their relative order.
    bringToFront(w) {
        const others = [...this.walkers.values()]
            .filter((o) => o !== w)
            .sort((a, b) => a.z - b.z);
        others.forEach((o, i) => this.setZ(o, i + 1));
        this.setZ(w, others.length + 1);
    }
    // Deal every walker a fresh rank in random order on a cast change.
    shuffleLayers() {
        shuffle([...this.walkers.values()]).forEach((w, i) => this.setZ(w, i + 1));
    }
    // Play the tickle giggle on the walker under the point, if any.
    tickleWalkerAt(x, y) {
        if (y < this.stageTop())
            return;
        for (const w of this.walkers.values()) {
            if (w.mode === MODE.HELD || w.mode === MODE.DROP)
                continue;
            if (w.mode === MODE.ANIM && !w.interruptible)
                continue;
            if (Math.abs(x - w.x) > w.halfWidth)
                continue;
            w.playRole("tickle");
            return;
        }
    }
    // Two resting walkers in the same spot: one steps aside (the newcomer, or with "assert" the occupant), walking the minimum to clear. Returns whether `w` moves.
    resolveRestOverlap(w) {
        const T = tuning();
        let occ = null, best = Infinity;
        for (const o of this.walkers.values()) {
            if (o === w || o.mode !== MODE.REST)
                continue;
            const d = Math.abs(o.x - w.x);
            if (d < best && this.overlap(w, o, T.restOverlapFrac)) {
                best = d;
                occ = o;
            }
        }
        if (!occ)
            return false;
        const mover = w.character.assert ? occ : w;
        const anchor = mover === w ? occ : w;
        if (mover.speed <= 0)
            return false;
        const gap = (mover.halfWidth + anchor.halfWidth) * T.restOverlapFrac;
        const dir = mover.x >= anchor.x ? 1 : -1;
        mover.beginWalk(dir, gap - Math.abs(mover.x - anchor.x));
        return mover === w;
    }
    // Top of the floor strip the walkers occupy.
    stageTop() {
        return this.win.innerHeight - this.plugin.settings.rootSpriteMaxHeight;
    }
    // The horizontal band (px) a walker may rest within.
    restBand() {
        const T = tuning();
        const width = this.win.innerWidth;
        return { lo: T.restBandLo * width, hi: T.restBandHi * width };
    }
    // A shrunk window can strand a walker off-screen; pull any such back inside the band.
    onResize() {
        const { lo, hi } = this.restBand();
        for (const w of this.walkers.values()) {
            w.measure();
            if (w.mode === MODE.HELD)
                continue;
            if (w.x < lo)
                w.x = lo;
            else if (w.x > hi)
                w.x = hi;
            w.place();
        }
    }
}
module.exports = { CompanionStage };
