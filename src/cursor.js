"use strict";
const { tuning } = require("./toolkit.js");
// Shared window-cursor tracker: latest pointer position (x = -1 outside the window) plus the tickle detector (quick horizontal reversals of a free cursor).
class Cursor {
    constructor(onTickle) {
        this.x = -1;
        this.y = -1;
        this.onTickle = onTickle;
        this.dir = 0;
        this.count = 0;
        this.t = 0;
    }
    move(e) {
        const dx = this.x < 0 ? 0 : e.clientX - this.x;
        this.x = e.clientX;
        this.y = e.clientY;
        if (e.buttons === 0)
            this.detectTickle(dx);
    }
    leave() {
        this.x = -1;
        this.y = -1;
    }
    detectTickle(dx) {
        const T = tuning();
        const now = performance.now();
        if (now - this.t > T.tickleWindow)
            this.count = 0;
        if (Math.abs(dx) < T.tickleMinStep)
            return;
        const dir = dx > 0 ? 1 : -1;
        if (dir === this.dir)
            return;
        this.dir = dir;
        this.t = now;
        if (++this.count >= T.tickleReversals) {
            this.count = 0;
            this.onTickle(this.x, this.y);
        }
    }
}
module.exports = { Cursor };
