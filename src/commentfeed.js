"use strict";
// Inline-span protocol: carries "this run is a styled <span>" through the plain-string pipeline (RiScript eval + emit's punctuation pass), which is why it's control chars in the text rather than a {cls,text} node — a wrapped run is FEED_SPAN cls FEED_SPAN_SEP text FEED_SPAN, both chars non-whitespace so emit's trim/regex leave them intact. feedSpan is the single producer, renderInline the single consumer; plain text splits to one verbatim run. Only the Oracle VIP beat wraps a run today (its quoted modifier).
const FEED_SPAN = String.fromCharCode(0x1f);      // toggles a plain ↔ span run
const FEED_SPAN_SEP = String.fromCharCode(0x1e);  // separates a run's class from its text
// Wrap text so renderInline emits it inline as <span class=cls>; cls defaults to the emphasis modifier style.
function feedSpan(text, cls = "cc-feed-modifier") {
    return FEED_SPAN + cls + FEED_SPAN_SEP + text + FEED_SPAN;
}
function renderInline(el, text) {
    String(text).split(FEED_SPAN).forEach((seg, i) => {
        if (!seg) return;
        if (!(i % 2)) return void el.appendText(seg);   // even segments are plain text
        const sep = seg.indexOf(FEED_SPAN_SEP);
        el.createSpan({ cls: seg.slice(0, sep), text: seg.slice(sep + 1) });
    });
}
// Split a news headline on its one authored structural token: an optional leading [SECTION] label (the bracketed group may hold spaces), the rest is the body. Only that leading group is structural — a later [a | b] stays an ordinary RiScript choice in the body — so the parse mirrors pushBlog's author/tags split. Shared by the feed beat (which styles the section) and the chyron (body only, section dropped). Returns { section, body }; section "" when the line has no leading bracket group.
function parseNewsLine(raw) {
    const m = /^\s*\[([^\]]*)\]\s*/.exec(raw || "");
    return m
        ? { section: m[1].trim(), body: raw.slice(m[0].length).trim() }
        : { section: "", body: (raw || "").trim() };
}
// Chat overlay: fixed element pinned to root-split corner nearest the panel. Owns no timer/content — exposes push() for independent sources. Newest at corner, older bump away.
class CommentFeed {
    constructor(view) {
        this.view = view;
        this.plugin = view.plugin;
        this.el = null;
    }
    get settings() { return this.plugin.settings; }
    // The feed exists only while a source wants it; torn down (not preserved) when the panel goes away, rebuilt fresh on return. It lives on the PANEL'S own <body> (never `activeDocument` — a focused popout must not adopt it; in practice always the main window, since the panel isn't live elsewhere).
    mount() {
        if (this.el)
            return;
        this.el = this.view.contentEl.doc.body.createDiv({ cls: "cc-feed" });
        this.applyFont();
        this.reposition();
    }
    // Override the shared --cc-stream-font on the bubbles when the user set a comment font (verbatim CSS font-family); empty clears back to the styles.css default. Bubbles inherit the property from the feed root. Applied on mount and re-run by every sync(), so a font edit lands live.
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
    // Pin the overlay to the root-split corner nearest the panel (left/right by the panel's side, top/bottom by its half); the stacking direction follows.
    reposition() {
        if (!this.el)
            return;
        // All geometry in the panel's own window, matching the body the feed is mounted on.
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
    // Add a bubble at the anchored corner. parts: plain string or [{cls, text}] array. Named parts get cc-feed-part-X classes, joined by <br>.
    push(parts, extraCls) {
        const list = Array.isArray(parts) ? parts : [{ text: parts }];
        if (!list.some((p) => p.text) || !this.el)
            return;
        const top = this.el.classList.contains("cc-feed-top");
        const bubble = this.el.createDiv({ cls: "cc-feed-bubble" });
        let first = true;
        for (const p of list) {
            if (!p.text)
                continue;
            if (!first)
                bubble.createEl("br");
            first = false;
            renderInline(p.cls ? bubble.createSpan({ cls: "cc-feed-part-" + p.cls }) : bubble, p.text);
        }
        if (extraCls)
            bubble.classList.add(extraCls);
        // createDiv appends; for a top anchor the newest belongs at the front.
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
module.exports = { CommentFeed, feedSpan, parseNewsLine };
