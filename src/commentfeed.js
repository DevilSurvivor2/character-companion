"use strict";
function renderRuns(el, runs) {
    for (const run of runs)
        run.cls ? el.createSpan({ cls: run.cls, text: run.text }) : el.appendText(run.text);
}
// Chat overlay pinned to the root-split corner nearest the panel. Owns no timer/content — exposes push() for independent sources. Newest at corner, older bump away.
class CommentFeed {
    constructor(view) {
        this.view = view;
        this.plugin = view.plugin;
        this.el = null;
    }
    get settings() { return this.plugin.settings; }
    // Exists only while a source wants it; torn down when the panel goes away, rebuilt on return. Lives on the panel's own <body>.
    mount() {
        if (this.el)
            return;
        this.el = this.view.contentEl.doc.body.createDiv({ cls: "cc-feed" });
        this.applyFont();
        this.reposition();
    }
    // Override --cc-stream-font on the bubbles when a comment font is set; empty clears back to the styles.css default. Re-run by every sync() so a font edit lands live.
    applyFont() {
        if (this.el)
            this.el.setCssProps({ "--cc-stream-font": this.settings.commentFont || "" });
    }
    unmount() {
        if (this.el) {
            this.el.remove();
            this.el = null;
        }
    }
    // Pin the overlay to the root-split corner nearest the panel; stacking direction follows.
    reposition() {
        if (!this.el)
            return;
        const { doc, win } = this.view.contentEl;
        const root = doc.querySelector(".workspace-split.mod-root");
        const rect = (root ?? doc.body).getBoundingClientRect();
        const panel = this.view.contentEl.getBoundingClientRect();
        const left = panel.left + panel.width / 2 < win.innerWidth / 2;
        const top = panel.top + panel.height / 2 < win.innerHeight / 2;
        this.el.classList.toggle("cc-feed-left", left);
        this.el.classList.toggle("cc-feed-right", !left);
        this.el.classList.toggle("cc-feed-top", top);
        this.el.classList.toggle("cc-feed-bottom", !top);
        this.el.setCssProps({
            "--cc-feed-x": (left ? rect.left : win.innerWidth - rect.right) + "px",
            "--cc-feed-y": (top ? rect.top : win.innerHeight - rect.bottom) + "px",
        });
    }
    // Add a bubble at the anchored corner. parts: plain string or [{cls, text|runs}] array. Named parts get cc-feed-part-X classes, joined by <br>.
    push(parts, extraCls) {
        const list = Array.isArray(parts) ? parts : [{ text: parts }];
        if (!list.some((p) => p.text || p.runs?.some((run) => run.text)) || !this.el)
            return;
        const top = this.el.classList.contains("cc-feed-top");
        const bubble = this.el.createDiv({ cls: "cc-feed-bubble" });
        let first = true;
        for (const p of list) {
            if (!p.text && !p.runs?.some((run) => run.text))
                continue;
            if (!first)
                bubble.createEl("br");
            first = false;
            const el = p.cls ? bubble.createSpan({ cls: "cc-feed-part-" + p.cls }) : bubble;
            p.runs ? renderRuns(el, p.runs) : el.appendText(p.text);
        }
        if (extraCls)
            bubble.classList.add(extraCls);
        // For a top anchor the newest belongs at the front.
        if (top)
            this.el.prepend(bubble);
        // Reflow so the entry transition runs from its hidden start state.
        void bubble.offsetWidth;
        bubble.classList.add("cc-feed-bubble-visible");
        const limit = Math.max(1, this.settings.streamHistoryCount);
        while (this.el.childElementCount > limit)
            (top ? this.el.lastElementChild : this.el.firstElementChild).remove();
    }
}
module.exports = { CommentFeed };
