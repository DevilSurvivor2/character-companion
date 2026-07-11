"use strict";
const { PluginSettingTab, Setting, setIcon } = require("obsidian");
const { AESTHETICS, ANIM_BY_NAME, ANIM_POOLS, CHARACTER_SCHEMA, CHARACTER_TOGGLES, COMMENT_SET_SCHEMA, MAIL_SCHEMA, ORACLE_PATRON_FALLBACK, ORACLE_SYS_FALLBACK, PROGRAM_SCHEMA, SPECIAL_EFFECTS, VIP_SCHEMA, newItem } = require("./registries.js");
const { capturePointer, releasePointer } = require("./toolkit.js");
const { ListEditor } = require("./listeditor.js");
// Enable-pill grids: one row each. entries(t) builds pills; save(t) overrides default saveSettings for per-file lists.
const PILL_GRIDS = {
    root: {
        grid: "rootGridEl", empty: "No characters yet. Add one in the Cast tab.",
        entries: (t) => t.charPills((c) => c.rootEnabled, (c, v) => { c.rootEnabled = v; }),
        save: (t) => t.plugin.saveDataFile("characterData"),
    },
    sidebar: {
        grid: "sidebarGridEl", empty: "No characters yet. Add one in the Cast tab.",
        entries: (t) => t.charPills((c) => c.sidebarEnabled, (c, v) => { c.sidebarEnabled = v; }),
        // Rerender so the open panel reflects a newly included / excluded character at once.
        save: (t) => t.plugin.saveDataFile("characterData", true),
    },
    commentSet: {
        grid: "commentSetGridEl", empty: "No comment sets yet. Add one in the Chat tab.",
        entries: (t) => t.enablePills(t.plugin.streamData.commentSets),
        save: (t) => t.plugin.saveDataFile("streamData"),
    },
    vip: {
        grid: "vipGridEl", empty: "No patrons yet. Add one in the VIP tab.",
        entries: (t) => t.enablePills(t.plugin.oracleData.vips),
        save: (t) => t.plugin.saveDataFile("oracleData"), // the oracle-data save retrains every open view's classifier
    },
    mail: {
        grid: "mailGridEl", empty: "No mail templates yet. Add one in the Inbox tab.",
        entries: (t) => t.enablePills(t.plugin.mailData.mailTemplates),
        save: (t) => t.plugin.saveDataFile("mailData"),
    },
    // Effects + aesthetics: no empty state, no explicit save. Their flag maps live in data.json, so the default saveSettings persists them — and that repaints the open panels' stream overlay IN PLACE (effects rebuild just the toggled fx; aesthetics through the overlay's own sync), never tearing down the sprite's rest cycle.
    effect: {
        grid: "effectGridEl",
        entries: (t) => t.flagPills(SPECIAL_EFFECTS, t.plugin.settings.enabledEffects),
    },
    aesthetic: {
        grid: "aestheticGridEl",
        entries: (t) => t.flagPills(AESTHETICS, t.plugin.settings.enabledAesthetics),
    },
};
// A slider/range labelled in a time unit ("sec"/"min") edits an ms-STORED setting. ONE
// convention for both helpers: the <input> runs in the stored unit (ms) — min/max/step are
// authored in the readable unit and scaled to ms bounds through this map, and only the
// readout divides back for display. Any other unit ("%", "px") is label-only (factor 1).
const MS_PER_UNIT = { sec: 1000, min: 60000 };
// The settings tab: a tab bar over pages, each page a row in the tab table (this.tabs) below.
class CompanionSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.activeTab = "behavior";
        this.bodyEl = null;
        // Paint-grid references — one field per PILL_GRIDS row, assigned on mount (mountPillGrid) and rebuilt live; the isConnected guard makes a cross-tab rebuild harmless while a grid is off-screen.
        for (const g of Object.values(PILL_GRIDS))
            this[g.grid] = null;
        // The two name-pill lists. Character edits reflect into the display + sidebar pills; comment sets stand alone.
        this.charEditor = new ListEditor(this, {
            pickName: "Pick a character to edit",
            pickDesc: "Click a name below to edit it, drag to reorder. Right-click to delete.",
            addText: "Add character",
            emptyText: 'No characters yet. Click "Add character".',
            save: () => this.plugin.saveDataFile("characterData", true),
            items: () => this.plugin.characterData.characters,
            labelOf: (c) => c.name || "(unnamed)",
            makeItem: () => newItem(CHARACTER_SCHEMA, { name: "New character" }),
            onAdd: (c) => { if (!this.plugin.characterData.activeCharacterId)
                this.plugin.characterData.activeCharacterId = c.id; },
            onDelete: (id) => {
                if (this.plugin.characterData.activeCharacterId === id)
                    this.plugin.characterData.activeCharacterId = this.plugin.characterData.characters[0]?.id ?? null;
            },
            onMutate: () => { this.rebuildPillGrid("root"); this.rebuildPillGrid("sidebar"); },
            renderBody: (host, c, ed) => this.renderCharacterBody(host, c, ed),
        });
        this.commentEditor = new ListEditor(this, {
            pickName: "Pick a comment set to edit",
            pickDesc: "Click a name below to edit it, drag to reorder. Right-click to delete.",
            addText: "Add comment set",
            emptyText: 'No comment sets yet. Click "Add comment set".',
            save: () => this.plugin.saveDataFile("streamData"),
            items: () => this.plugin.streamData.commentSets,
            labelOf: (cs) => cs.name || "(unnamed)",
            makeItem: () => newItem(COMMENT_SET_SCHEMA, { name: "New comment set" }),
            onMutate: () => this.rebuildPillGrid("commentSet"),
            renderBody: (host, cs, ed) => this.renderCommentSetBody(host, cs, ed),
        });
        // The Oracle VIP list is backed by oracle-data.json, so it overrides `save` to persist there (which also re-trains every open view's classifier) instead of into data.json.
        this.vipEditor = new ListEditor(this, {
            pickName: "Pick a patron to edit",
            pickDesc: "Click a name below to edit it, drag to reorder. Right-click to delete.",
            addText: "Add patron",
            emptyText: 'No patrons yet. Click "Add patron".',
            save: () => this.plugin.saveDataFile("oracleData"),
            items: () => this.plugin.oracleData.vips,
            labelOf: (v) => v.name || "(unnamed)",
            makeItem: () => newItem(VIP_SCHEMA, { name: "New patron" }),
            onMutate: () => this.rebuildPillGrid("vip"),
            renderBody: (host, v, ed) => this.renderVipBody(host, v, ed),
        });
        // The mail template list is backed by mail-data.json, same as the VIP list is backed by oracle-data.json — save persists there, not into data.json.
        this.mailEditor = new ListEditor(this, {
            pickName: "Pick a mail template to edit",
            pickDesc: "Click a name below to edit it, drag to reorder. Right-click to delete.",
            addText: "Add mail template",
            emptyText: 'No mail templates yet. Click "Add mail template".',
            save: () => this.plugin.saveDataFile("mailData"),
            items: () => this.plugin.mailData.mailTemplates,
            labelOf: (m) => m.name || "(unnamed)",
            makeItem: () => newItem(MAIL_SCHEMA, { name: "New mail template" }),
            onMutate: () => this.rebuildPillGrid("mail"),
            renderBody: (host, m, ed) => this.renderMailBody(host, m, ed),
        });
        // The program list is backed by program-data.json. Unlike mail there's no enable pill grid — a program self-gates on its own schedule (0 = off) — so onMutate has nothing to rebuild; the file's afterSave reconciles the scheduler.
        this.programEditor = new ListEditor(this, {
            pickName: "Pick a program to edit",
            pickDesc: "Click a name below to edit it, drag to reorder. Right-click to delete.",
            addText: "Add program",
            emptyText: 'No programs yet. Click "Add program".',
            save: () => this.plugin.saveDataFile("programData"),
            items: () => this.plugin.programData.programs,
            labelOf: (p) => p.label || "(unnamed)",
            makeItem: () => newItem(PROGRAM_SCHEMA, { label: "New program" }),
            onMutate: () => { },
            renderBody: (host, p, ed) => this.renderProgramBody(host, p, ed),
        });
        // Tab table — the single source for both the tab bar (display) and the body dispatch (renderBody); add a page = add a row. An `icon` marks a list-editor page (Character/Comment/Patron/Inbox): the tab bar renders it icon-only, expanding to icon+label only while active (see display()).
        this.tabs = [
            { id: "behavior", label: "Behavior", render: (c) => this.renderBehaviorTab(c) },
            { id: "character", label: "Cast", icon: "user-round", render: (c) => this.renderCastTab(c) },
            { id: "display", label: "Display", render: (c) => this.renderDisplayTab(c) },
            { id: "stream", label: "Stream", render: (c) => this.renderStreamTab(c) },
            { id: "comment", label: "Chat", icon: "message-circle-more", render: (c) => this.renderCommentTab(c) },
            { id: "oracle", label: "Oracle", render: (c) => this.renderOracleTab(c) },
            { id: "patron", label: "VIP", icon: "star", render: (c) => this.renderPatronTab(c) },
            { id: "mail", label: "Mail", render: (c) => this.renderMailTab(c) },
            { id: "inbox", label: "Inbox", icon: "mails", render: (c) => this.renderInboxTab(c) },
            { id: "blog", label: "Blog", render: (c) => this.renderBlogTab(c) },
            { id: "news", label: "News", render: (c) => this.renderNewsTab(c) },
            { id: "program", label: "Program", icon: "tv", render: (c) => this.renderProgramTab(c) },
        ];
    }
    // The shared persist tail every control's onChange ends in: the field's own save() when given (per-file lists persist to their own file), else the settings save with the control's rerender flag.
    commit(save, rerender = false) {
        return save ? save() : this.plugin.saveSettings(rerender);
    }
    // One slider setting: a native ".slider" over [min, max] stepped by step, with the live value shown to its LEFT (mirrors the dual-range row) and the unit carried in the name's brackets. The value is read/written through get()/set(), or `key` names a plugin-settings scalar directly. Same convention as addRangeSetting: the slider runs in the STORED unit — a "sec"/"min" unit means ms (MS_PER_UNIT), so min/max/step are authored in the display unit and scaled to ms here, and only the readout divides back. format/parse remap a non-numeric stored value onto the slider scale (the typewriter's string↔index map); readout overrides the display.
    addSliderSetting(container, { name, desc, unit, key, get, set, min, max, step = 1, save, rerender = false, format = (v) => v, parse = (v) => v, readout }) {
        const div = MS_PER_UNIT[unit] ?? 1;
        get = get ?? (() => this.plugin.settings[key]);
        set = set ?? ((v) => (this.plugin.settings[key] = v));
        readout = readout ?? ((v) => String(v / div));
        const setting = new Setting(container).setName(unit ? name + " (" + unit + ")" : name);
        if (desc)
            setting.setDesc(desc);
        const wrap = setting.controlEl.createDiv({ cls: "cc-range" });
        const label = wrap.createSpan({ cls: "cc-range-label" });
        const attr = { type: "range", min: String(min * div), max: String(max * div), step: String(step * div), "data-ignore-swipe": "true" };
        const slider = wrap.createEl("input", { cls: "slider cc-single-slider", attr });
        const paint = () => label.setText(readout(Number(slider.value)));
        slider.value = String(format(get()));
        paint();
        // Live-paint the readout per tick; persist (and possibly re-render the open panel) only when the drag ends — same rationale as addTextSetting's change-not-keystroke commit.
        slider.addEventListener("input", () => paint());
        slider.addEventListener("change", async () => { set(parse(Number(slider.value))); await this.commit(save, rerender); });
    }
    // One toggle setting: a boolean read through get()/set() (or `key` naming a plugin-settings flag), persisted on flip.
    addToggleSetting(container, { name, desc, key, get, set, save, rerender = false }) {
        get = get ?? (() => this.plugin.settings[key]);
        set = set ?? ((v) => (this.plugin.settings[key] = v));
        new Setting(container)
            .setName(name)
            .setDesc(desc)
            .addToggle((tg) => tg
            .setValue(get())
            .onChange(async (v) => {
            set(v);
            await this.commit(save, rerender);
        }));
    }
    // One text-input setting: a string read through get()/set() and persisted. set() owns any trimming and side effects (a pill relabel, a pill-grid rebuild); `configure(setting)` may decorate the row before the input lands (the character Name row adds its toggle icons). Commits on the native "change" (click away / Enter), NOT per keystroke — a save can re-render the open panel, which mustn't fire mid-typing.
    addTextSetting(container, { name, desc, placeholder, key, get, set, save, rerender = false, configure }) {
        get = get ?? (() => this.plugin.settings[key]);
        set = set ?? ((v) => (this.plugin.settings[key] = v));
        const setting = new Setting(container).setName(name);
        if (desc)
            setting.setDesc(desc);
        if (configure)
            configure(setting);
        setting.addText((t) => {
            if (placeholder != null)
                t.setPlaceholder(placeholder);
            t.setValue(get());
            t.inputEl.addEventListener("change", async () => {
                set(t.inputEl.value);
                await this.commit(save, rerender);
            });
        });
    }
    // A dual-thumb range setting: two native ".slider" inputs stacked (both full-width, pointer ignored except on each thumb). The pair is read/written through getMin/setMin/getMax/setMax, or `minKey`/`maxKey` name two plugin-settings scalars directly. A "sec"/"min" unit means the stored pair is ms (MS_PER_UNIT): min/max/step are authored in the display unit and scaled to ms bounds here — the slider steps and commits in ms, only the readout divides back.
    addRangeSetting(container, { name, desc, min, max, step = 1, unit, minKey, maxKey, getMin, setMin, getMax, setMax }) {
        const div = MS_PER_UNIT[unit] ?? 1;
        const s = this.plugin.settings;
        getMin = getMin ?? (() => s[minKey]);
        setMin = setMin ?? ((v) => (s[minKey] = v));
        getMax = getMax ?? (() => s[maxKey]);
        setMax = setMax ?? ((v) => (s[maxKey] = v));
        const setting = new Setting(container).setName(unit ? name + " (" + unit + ")" : name);
        if (desc)
            setting.setDesc(desc);
        const wrap = setting.controlEl.createDiv({ cls: "cc-range" });
        const label = wrap.createSpan({ cls: "cc-range-label" });
        const sliders = wrap.createDiv({ cls: "cc-range-sliders" });
        const attr = { type: "range", min: String(min * div), max: String(max * div), step: String(step * div), "data-ignore-swipe": "true" };
        const lo = sliders.createEl("input", { cls: "slider cc-range-lo", attr });
        const hi = sliders.createEl("input", { cls: "slider cc-range-hi", attr });
        lo.value = String(getMin());
        hi.value = String(getMax());
        const paint = () => {
            label.setText((Number(lo.value) / div) + "–" + (Number(hi.value) / div));
        };
        // Clamp the dragged thumb against the other so they never cross, commit the value, repaint live; persist once on release ("change"), like the single slider.
        const onInput = (self, other, isLo, commit) => () => {
            let v = Number(self.value);
            const limit = Number(other.value);
            if (isLo ? v > limit : v < limit) { v = limit; self.value = String(v); }
            commit(v);
            paint();
        };
        lo.addEventListener("input", onInput(lo, hi, true, setMin));
        hi.addEventListener("input", onInput(hi, lo, false, setMax));
        const persist = () => void this.commit();
        lo.addEventListener("change", persist);
        hi.addEventListener("change", persist);
        paint();
    }
    // The one textarea scaffold: raw text by default (value stored verbatim — gift emojis, mail bodies); the `format`/`parse` overrides below turn it into the line-list and map flavours.
    addTextarea(container, { get, set, save, rows = 8, format = (v) => v, parse = (v) => v }) {
        const area = container.createEl("textarea", { cls: "cc-textarea" });
        area.value = format(get());
        area.rows = rows;
        area.addEventListener("change", async () => {
            set(parse(area.value));
            await this.commit(save);
        });
    }
    // A bulk line-list textarea: one trimmed item per non-blank line. Shared by the character-quotes, comment-set, and Oracle editors.
    addBulkTextarea(container, opts) {
        this.addTextarea(container, Object.assign({
            format: (list) => list.join("\n"),
            parse: (v) => v.split("\n").map((s) => s.trim()).filter((s) => s.length > 0),
        }, opts));
    }
    // A {name: [...]} map editor: one "name: a, b, c" line per variable/constant, comma-separated values. Backs the Oracle/mail constants and per-set/per-VIP variables.
    addMapTextarea(container, opts) {
        this.addTextarea(container, Object.assign({
            format: (obj) => Object.keys(obj || {}).map((k) => k + ": " + obj[k].join(", ")).join("\n"),
            parse: (v) => {
                const out = {};
                for (const line of v.split("\n")) {
                    const i = line.indexOf(":");
                    if (i < 0) continue;
                    const key = line.slice(0, i).trim();
                    const vals = line.slice(i + 1).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
                    if (key && vals.length) out[key] = vals;
                }
                return out;
            },
        }, opts));
    }
    // The shared "Message variety → Constants" section closing the Oracle/mail/blog tabs: a heading + a map textarea over that mode's constants map. Only the desc phrasing is per-mode.
    addConstantsSection(container, opts) {
        new Setting(container).setName("Message variety").setHeading();
        new Setting(container).setName("Constants").setDesc(opts.desc);
        this.addMapTextarea(container, opts);
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        const bar = containerEl.createDiv({ cls: "cc-tabbar" });
        for (const tab of this.tabs) {
            const btn = bar.createEl("button", { cls: "cc-tab" });
            // Iconed (list-editor) tabs show the icon always and the label only while active — CSS collapses the label; text-only tabs just carry the label.
            if (tab.icon) {
                btn.classList.add("cc-tab-iconed");
                setIcon(btn.createSpan({ cls: "cc-tab-icon" }), tab.icon);
            }
            btn.createSpan({ cls: "cc-tab-label", text: tab.label });
            btn.classList.toggle("cc-tab-active", tab.id === this.activeTab);
            btn.addEventListener("click", () => {
                this.activeTab = tab.id;
                bar.querySelectorAll(".cc-tab").forEach((el, i) => el.classList.toggle("cc-tab-active", this.tabs[i].id === this.activeTab));
                this.renderBody();
            });
        }
        this.bodyEl = containerEl.createDiv();
        this.renderBody();
    }
    renderBody() {
        const c = this.bodyEl;
        if (!c)
            return;
        c.empty();
        this.tabs.find((t) => t.id === this.activeTab)?.render(c);
    }
    // A muted one-line intro at the top of a tab, above its first heading — one flat sentence saying what the tab is for.
    tabIntro(container, text) {
        container.createDiv({ cls: "cc-tab-intro", text });
    }
    renderBehaviorTab(c) {
        this.tabIntro(c, "How the character acts on its own and when you click it.");
        new Setting(c).setName("Idle behavior").setHeading();
        this.addToggleSetting(c, {
            name: "Wander when idle",
            desc: "When left alone, the character idles on its own: shifting weight, pacing, looking around, stretching, dozing off, fidgeting, and occasionally wandering off one side and back.",
            key: "idleEnabled",
        });
        this.addSliderSetting(c, {
            name: "Chatter chance", unit: "%",
            desc: "How often an idle moment triggers a quote instead of a movement. 0 = never speak on its own.",
            min: 0, max: 100, step: 5,
            key: "chatterChance",
        });
        this.addSliderSetting(c, {
            name: "Sleep after",
            desc: "How long the character waits until it dozes off and dims. Click to wake the character. Will not sleep while streaming.",
            unit: "min", min: 1, max: 60,
            key: "sleepAfterMs",
        });
        new Setting(c)
            .setName("Allowed idle animations")
            .setDesc("Click to enable or disable. Dimmed means off.");
        this.renderAnimToggles(c.createDiv(), "idle");
        new Setting(c).setName("Click behavior").setHeading();
        this.addSliderSetting(c, {
            name: "Surprise chance", unit: "%",
            desc: "How often a click triggers an animation instead of a quote. 0 = always quote. 100 = always animate.",
            min: 0, max: 100, step: 5,
            key: "surpriseChance",
        });
        this.addToggleSetting(c, {
            name: "Small bob on quote",
            desc: "Whether the character bobs on a normal (quote) click.",
            key: "animateOnQuote",
        });
        new Setting(c)
            .setName("Allowed surprise animations")
            .setDesc("Click to enable or disable. Dimmed means off.");
        this.renderAnimToggles(c.createDiv(), "surprise");
    }
    renderDisplayTab(c) {
        this.tabIntro(c, "Where the characters appear, how big they are, and how fast they move.");
        new Setting(c).setName("Display in sidebar").setHeading();
        this.addSliderSetting(c, {
            name: "Sprite max height", unit: "px",
            desc: "Width scales to match.",
            min: 100, max: 500, step: 20,
            key: "sidebarSpriteMaxHeight",
            rerender: true,
        });
        this.addSliderSetting(c, {
            name: "Quote duration",
            desc: "Visible time for a full line of speech. Scaled to the bubble width, so shorter quotes clear sooner, and longer ones linger.",
            unit: "sec", min: 1, max: 5,
            key: "quoteDurationMs",
        });
        // Off / Slow / Fast three-step slider. Stored as the "off"/"slow"/"fast" string; the slider works in 0–2 indices, so format/parse map the string↔index and readout shows the label.
        const typewriterSteps = ["off", "slow", "fast"];
        const typewriterLabels = ["Off", "Slow", "Fast"];
        this.addSliderSetting(c, {
            name: "Quote typewriter",
            desc: "Off shows the whole line at once. Slow and Fast reveal it sentence by sentence, typewriter-style, at their own per-character speed.",
            min: 0, max: 2, step: 1,
            key: "quoteTypewriter",
            format: (v) => Math.max(0, typewriterSteps.indexOf(v)),
            parse: (n) => typewriterSteps[n],
            readout: (n) => typewriterLabels[n],
        });
        new Setting(c)
            .setName("Characters in sidebar")
            .setDesc("Click a character to include or exclude it in the sidebar panel. Dimmed means off. Use the \"show another character\" button to draw from those left on.");
        this.mountPillGrid(c, "sidebar");
        new Setting(c).setName("Display in root").setHeading();
        this.addSliderSetting(c, {
            name: "Sprite max height", unit: "px",
            desc: "Width scales to match.",
            min: 100, max: 500, step: 20,
            key: "rootSpriteMaxHeight",
        });
        this.addSliderSetting(c, {
            name: "Walking speed", unit: "px/sec",
            desc: "Base speed for walking along the bottom. Each character scales this with its own walking speed.",
            min: 10, max: 50, step: 2,
            key: "rootWalkSpeed",
        });
        new Setting(c)
            .setName("Characters in root")
            .setDesc("Click a name to show or hide it walking along the bottom of the window. Dimmed means off. Hide them all to disable this feature entirely.");
        this.mountPillGrid(c, "root");
    }
    renderCastTab(c) {
        new Setting(c).setName("Character list").setHeading();
        this.charEditor.mount(c);
    }
    renderStreamTab(c) {
        this.tabIntro(c, "The livestreaming that comes with scrolling comments.");
        new Setting(c).setName("Stream mode").setHeading();
        this.addRangeSetting(c, {
            name: "Background change interval",
            desc: "The background switches after a random time in this range.",
            unit: "min", min: 1, max: 60,
            minKey: "streamBgMinMs", maxKey: "streamBgMaxMs",
        });
        this.addTextSetting(c, {
            name: "Background images",
            desc: "Vault-relative (e.g. \"Attach/bg1.png\"). Either separate multiple image paths by commas, or leave a single folder path to use all images inside it; the two methods can't be mixed. A bare filename works if unique. A single emoji (e.g. \"🌃\") works too.",
            placeholder: "Attach/bg1.png, Attach/bg2.png",
            get: () => this.plugin.settings.streamBackgrounds,
            set: (v) => (this.plugin.settings.streamBackgrounds = v.trim()),
            rerender: true,
        });
        new Setting(c)
            .setName("Special effects")
            .setDesc("Click an effect to turn it on or off. Dimmed means off. Can overlay the stream bg and layer on top of each other.");
        this.mountPillGrid(c, "effect");
        new Setting(c)
            .setName("Aesthetics")
            .setDesc("Click an element to turn it on or off. Dimmed means off. Can overlay the stream bg.");
        this.mountPillGrid(c, "aesthetic");
        this.addRangeSetting(c, {
            name: "Comment interval",
            desc: "A new comment appears after a random time in this range.",
            unit: "sec", min: 5, max: 30, step: 5,
            minKey: "streamMinMs", maxKey: "streamMaxMs",
        });
        this.addSliderSetting(c, {
            name: "Visible comment history",
            desc: "How many comment bubbles stay on screen.",
            min: 1, max: 15, step: 1,
            key: "streamHistoryCount",
        });
        new Setting(c)
            .setName("Comment sets")
            .setDesc("Click a comment set to include or exclude it. Dimmed means off. Edit comment sets in the Chat tab.");
        this.mountPillGrid(c, "commentSet");
        new Setting(c).setName("Miscellaneous").setHeading();
        this.addTextSetting(c, {
            name: "Comment font",
            desc: 'Font for the chat bubbles. Comma-separate.',
            placeholder: '"Font Name A", "Font Name B"',
            get: () => this.plugin.settings.commentFont,
            set: (v) => (this.plugin.settings.commentFont = v.trim()),
        });
        this.addTextSetting(c, {
            name: "Gift emoji font",
            desc: 'Font for the emojis spawned by the gift button. Comma-separate.',
            placeholder: '"Noto Color Emoji"',
            get: () => this.plugin.settings.giftEmojiFont,
            set: (v) => (this.plugin.settings.giftEmojiFont = v.trim()),
        });
        new Setting(c)
            .setName("Gifts")
            .setDesc("Emojis spawned by the gift button. Space-separate. Falls back to 🎁.");
        this.addTextarea(c, {
            get: () => this.plugin.settings.giftEmojis,
            set: (v) => (this.plugin.settings.giftEmojis = v),
        });
    }
    renderCommentTab(c) {
        new Setting(c).setName("Comment list").setHeading();
        this.commentEditor.mount(c);
    }
    renderOracleTab(c) {
        this.tabIntro(c, "The divine broadcasting that sometimes reacts to what you've just typed.");
        new Setting(c).setName("Oracle mode").setHeading();
        this.addTextSetting(c, {
            name: "System title",
            desc: 'The channel brand, used as $system. Blank falls back to "' + ORACLE_SYS_FALLBACK + '".',
            placeholder: ORACLE_SYS_FALLBACK,
            key: "oracleSystemName",
        });
        this.addTextSetting(c, {
            name: "Patron origin",
            desc: 'The audience species or status, used as $patron. Comma-separate several to draw one at random each time (e.g. "Demon, Angel"). Give a custom plural in brackets (e.g. "Persona (Personae)"). Blank falls back to "' + ORACLE_PATRON_FALLBACK + '".',
            placeholder: ORACLE_PATRON_FALLBACK,
            key: "oraclePatronName",
        });
        // Three fully independent interval ranges (authored seconds, stored ms).
        const interval = (name, kind) => this.addRangeSetting(c, {
            name, desc: "A new message of this type appears after a random time in this range.",
            unit: "sec", min: 5, max: 180, step: 5,
            minKey: "oracle" + kind + "MinMs", maxKey: "oracle" + kind + "MaxMs",
        });
        interval("System interval", "Sys");
        interval("Anonymous interval", "Anon");
        interval("VIP interval", "Vip");
        this.addToggleSetting(c, {
            name: "VIP reacts to typing",
            desc: "When on, a VIP beat reacts to what you've just typed, if matching its topic; otherwise raises one of its own topics. When off, VIPs are always ambient.",
            key: "oracleVipReactsToTyping",
        });
        const saveOracle = () => this.plugin.saveDataFile("oracleData");
        new Setting(c)
            .setName("Patrons in oracle")
            .setDesc("Click a patron to enable or disable it. Dimmed means off. Edit patrons in the VIP tab.");
        this.mountPillGrid(c, "vip");
        new Setting(c).setName("Message list").setHeading();
        new Setting(c)
            .setName("System messages")
            .setDesc("One message per line. RiScript: entity = $system / $patron / $patrons, inline choices = [a | b].");
        this.addBulkTextarea(c, {
            get: () => this.plugin.oracleData.sysTemplates,
            set: (lines) => (this.plugin.oracleData.sysTemplates = lines),
            save: saveOracle,
        });
        new Setting(c)
            .setName("Anonymous messages")
            .setDesc("One message per line. RiScript: entity = $system / $patron / $patrons, inline choices = [a | b].");
        this.addBulkTextarea(c, {
            get: () => this.plugin.oracleData.anonTemplates,
            set: (lines) => (this.plugin.oracleData.anonTemplates = lines),
            save: saveOracle,
        });
        this.addConstantsSection(c, {
            desc: "One constant per line. Format = \"constant: a, b, c\". Shared across Sys / Anon / VIP messages.",
            get: () => this.plugin.oracleData.constants,
            set: (m) => (this.plugin.oracleData.constants = m),
            save: saveOracle,
        });
    }
    renderPatronTab(c) {
        new Setting(c).setName("Patron list").setHeading();
        this.vipEditor.mount(c);
    }
    // Per-VIP editor body: name (+ type), its variables (choice pools — the reserved `topic` bank is its typed-match list), and reaction / aside lines. All persist to oracle-data.json. Enabling and deleting are done from the patron pills (Oracle tab) and pill right-click.
    renderVipBody(containerEl, vip, editor) {
        const box = containerEl.createDiv({ cls: "cc-settings-box" });
        const save = () => this.plugin.saveDataFile("oracleData");
        this.addTextSetting(box, {
            name: "Name",
            placeholder: "(unnamed)",
            get: () => vip.name,
            set: (v) => { vip.name = v; editor.refreshPillLabel(vip.id, v || "(unnamed)"); },
            save,
        });
        this.addTextSetting(box, {
            name: "Modifier",
            desc: "Shown. Falls back to \"Name\" if left empty.",
            placeholder: vip.name || "Hunter Knight",
            get: () => vip.modifier,
            set: (v) => (vip.modifier = v.trim()),
            save,
        });
        this.addTextSetting(box, {
            name: "Origin",
            desc: "Optional. Draws from patron origins if left empty.",
            placeholder: "Constellation",
            get: () => vip.origin,
            set: (v) => (vip.origin = v.trim()),
            save,
        });
        new Setting(box)
            .setName("Variables")
            .setDesc("One variable per line. Format = \"variable: a, b, c\". $topic decides what this patron will react to when you're typing; allows both verbs and nouns; matches inflections automatically. Exclusive to this patron.");
        this.addMapTextarea(box, { get: () => vip.vars, set: (m) => (vip.vars = m), save });
        new Setting(box)
            .setName("Reactions")
            .setDesc("One reaction per line. Render = \"The Patron 'Modifier' reacts somehow\" (e.g. \"The Constellation 'Crawling Chaos' applauds this madness\").");
        this.addBulkTextarea(box, { get: () => vip.reactions, set: (lines) => (vip.reactions = lines), save });
        new Setting(box)
            .setName("Asides")
            .setDesc("One aside per line. Render = \"The Patron's reaction + The Patron's follow-up comments\".");
        this.addBulkTextarea(box, { get: () => vip.asides, set: (lines) => (vip.asides = lines), save });
    }
    // Mail mode's settings: the interval, which templates are enabled, and the shared constants any template can draw from. The templates themselves are edited on the Inbox tab.
    renderMailTab(c) {
        this.tabIntro(c, "The period emailing that directly address the character.");
        new Setting(c).setName("Mail mode").setHeading();
        this.addRangeSetting(c, {
            name: "Mail interval",
            desc: "A new mail appears after a random time in this range.",
            unit: "min", min: 1, max: 60,
            minKey: "mailMinMs", maxKey: "mailMaxMs",
        });
        new Setting(c)
            .setName("Mail templates")
            .setDesc("Click a mail template to include or exclude it. Dimmed means off. Edit mail templates in the Inbox tab.");
        this.mountPillGrid(c, "mail");
        this.addConstantsSection(c, {
            desc: "One constant per line. Format = \"constant: a, b, c\". Shared across all mail templates.",
            get: () => this.plugin.mailData.constants,
            set: (m) => (this.plugin.mailData.constants = m),
            save: () => this.plugin.saveDataFile("mailData"),
        });
    }
    renderInboxTab(c) {
        new Setting(c).setName("Mail list").setHeading();
        this.mailEditor.mount(c);
    }
    // Blog mode's settings: the interval range, the flat microblog list (one post per line, no pills), and the shared constants any post can draw from. The list + constants persist to blog-data.json; the interval is a data.json scalar.
    renderBlogTab(c) {
        this.tabIntro(c, "The ambient microblogging that never mentions the character.");
        new Setting(c).setName("Blog mode").setHeading();
        this.addRangeSetting(c, {
            name: "Blog interval",
            desc: "A new blog appears after a random time in this range.",
            unit: "min", min: 0.5, max: 30, step: 0.5,
            minKey: "blogMinMs", maxKey: "blogMaxMs",
        });
        new Setting(c).setName("Message list").setHeading();
        new Setting(c)
            .setName("Microblogs")
            .setDesc("One blog per line. Format = \"@handle #tags blog content\". @handle and #tags are optional. RiScript: random user = $handle, named user = $celebrity, inline choices = [a | b], lexicon = $rndNoun / $rndVerb / $rndAdj.");
        this.addBulkTextarea(c, {
            get: () => this.plugin.blogData.messages,
            set: (lines) => (this.plugin.blogData.messages = lines),
            save: () => this.plugin.saveDataFile("blogData"),
        });
        this.addConstantsSection(c, {
            desc: "One constant per line. Format = \"constant: a, b, c\".",
            get: () => this.plugin.blogData.constants,
            set: (m) => (this.plugin.blogData.constants = m),
            save: () => this.plugin.saveDataFile("blogData"),
        });
    }
    // News mode's settings: the shared interval range (one cadence for whichever face runs), the face switch (chyron vs feed), the flat headline list (one per line, no pills — blog's tab shape), and the shared constants any headline can draw from. Unlike blog, the lines also see the character vars (mail's context); both faces draw from the same list. The list + constants persist to news-data.json; the interval + switch are data.json scalars.
    renderNewsTab(c) {
        this.tabIntro(c, "The rolling news that reports on the character.");
        new Setting(c).setName("News mode").setHeading();
        this.addRangeSetting(c, {
            name: "News interval",
            desc: "The next news beat — a chyron pass or a feed bubble, whichever face runs — comes after a random time in this range.",
            unit: "min", min: 0.5, max: 30, step: 0.5,
            minKey: "newsMinMs", maxKey: "newsMaxMs",
        });
        this.addToggleSetting(c, {
            name: "Feed instead of chyron",
            desc: "Off: headlines scroll across the bottom-bar chyron, several per pass. On: each beat drops one headline into the comment feed as a bubble instead.",
            key: "newsToFeed",
        });
        new Setting(c).setName("Message list").setHeading();
        new Setting(c)
            .setName("Headlines")
            .setDesc("One headline per line. Format = \"[Section] headline content\". A leading [Section] is optional; it shows as a label in the feed and is dropped from the chyron. RiScript: character vars = $name / $epithet / $role / $deed / $topic, character pronouns = $they / $them / $their, inflections = $deed.ing() / .ed() / .s(), inline choices = [a | b], lexicon = $rndAdj / $rndNoun / $rndVerb.");
        this.addBulkTextarea(c, {
            get: () => this.plugin.newsData.messages,
            set: (lines) => (this.plugin.newsData.messages = lines),
            save: () => this.plugin.saveDataFile("newsData"),
        });
        this.addConstantsSection(c, {
            desc: "One constant per line. Format = \"constant: a, b, c\". Shared across all headlines.",
            get: () => this.plugin.newsData.constants,
            set: (m) => (this.plugin.newsData.constants = m),
            save: () => this.plugin.saveDataFile("newsData"),
        });
    }
    // Per-template editor body: an admin-only name (pill label, never shown in-feed), then the four RiScript fields actually drawn into the feed. All persist to mail-data.json.
    renderMailBody(containerEl, mail, editor) {
        const box = containerEl.createDiv({ cls: "cc-settings-box" });
        const save = () => this.plugin.saveDataFile("mailData");
        this.addTextSetting(box, {
            name: "Label",
            placeholder: "(unnamed)",
            get: () => mail.name,
            set: (v) => { mail.name = v; editor.refreshPillLabel(mail.id, v || "(unnamed)"); },
            save,
        });
        this.addTextSetting(box, {
            name: "Title",
            desc: 'The subject. RiScript: random strings ($num/$let/$mix<lo-hi>), character vars ($name/$epithet/...), mail constants ($npc/...), lexicon fillers ($rndNoun/$rndVerb/$rndAdj).',
            placeholder: "A $rndAdj offer for $name",
            get: () => mail.title,
            set: (v) => (mail.title = v),
            save,
        });
        this.addTextSetting(box, {
            name: "From",
            desc: 'Who sent it. Use $constant pools (e.g. "npc: your friend, secret, just a fan"), or inline choices (e.g. "[chad | loser | a nameless someone]").',
            placeholder: "someone",
            get: () => mail.from,
            set: (v) => (mail.from = v),
            save,
        });
        this.addTextSetting(box, {
            name: "To",
            desc: 'Who receives it. Use $name (or $epithet) to land on the shown character.',
            placeholder: "[$name | dear customer]",
            get: () => mail.to,
            set: (v) => (mail.to = v),
            save,
        });
        new Setting(box)
            .setName("Content")
            .setDesc("Multi-line. RiScript: Same as Title, plus $to for mail content to repeat the addressee.");
        this.addTextarea(box, { get: () => mail.content, set: (v) => (mail.content = v), save, rows: 6 });
    }
    // Program mode's settings: a pill-edited list of scheduled backdrop takeovers (mirrors the Inbox tab). The list persists to program-data.json; there's no interval or constants section — each program carries its own schedule.
    renderProgramTab(c) {
        this.tabIntro(c, "The scheduled broadcasts that take over the panel backdrop.");
        new Setting(c).setName("Program list").setHeading();
        this.programEditor.mount(c);
    }
    // Per-program editor body: an admin-only label (pill label), the stream-bg-style backdrop, the airing minute, and the RiScript content script. All persist to program-data.json.
    renderProgramBody(containerEl, program, editor) {
        const box = containerEl.createDiv({ cls: "cc-settings-box" });
        const save = () => this.plugin.saveDataFile("programData");
        this.addTextSetting(box, {
            name: "Label",
            placeholder: "(unnamed)",
            get: () => program.label,
            set: (v) => { program.label = v; editor.refreshPillLabel(program.id, v || "(unnamed)"); },
            save,
        });
        this.addTextSetting(box, {
            name: "Background",
            desc: "The full-panel image while the program airs. Same format as the stream background (comma-separated image paths, a single folder path, or an emoji), drawn at random and held for the whole airing — no timed swap. Hijacks the stream background and hides the sprite; effects and overlays keep running. Not RiScript.",
            placeholder: "Attach/bg1.png, Attach/bg2.png",
            get: () => program.background,
            set: (v) => (program.background = v.trim()),
            save,
        });
        // Slider steps: Off → :01 … :59 → :00. The last step (":00", the top of the hour) is stored as 60 so it can't collide with 0 = off; the scheduler folds it back with % 60.
        this.addSliderSetting(box, {
            name: "Schedule",
            desc: "The program airs at this minute past every hour (e.g. :35 → 0:35, 1:35, … 23:35) while the sidebar panel is active. The first step disables it; the last step (:00) is the top of the hour.",
            min: 0, max: 60, step: 1,
            get: () => program.schedule,
            set: (v) => (program.schedule = v),
            save,
            readout: (v) => v === 0 ? "Off" : ":" + String(v % 60).padStart(2, "0"),
        });
        new Setting(box)
            .setName("Content")
            .setDesc("The script that plays while the program airs — one line at a time as a bubble at the bottom, each held like a speech bubble, then the airing ends. Multi-line (one line per beat). RiScript: character vars = $name / $epithet / $role / $deed / $topic, character pronouns = $they / $them / $their, inflections = $deed.ing() / .ed() / .s(), inline choices = [a | b], lexicon = $rndAdj / $rndNoun / $rndVerb.");
        this.addTextarea(box, { get: () => program.content, set: (v) => (program.content = v), save, rows: 6 });
    }
    // Render an on/off pill per animation of a role, wired to its settings flag map and drag-paintable. Shared by the idle and surprise grids.
    renderAnimToggles(host, role) {
        const pool = ANIM_POOLS[role];
        const flags = this.plugin.settings[pool.flag];
        this.paintGrid(host, pool.all.map((name) => ({
            // Display label: explicit row label, else the capitalised name.
            label: ANIM_BY_NAME[name].label ?? name[0].toUpperCase() + name.slice(1),
            get: () => flags[name],
            set: (v) => { flags[name] = v; },
        })));
    }
    // A grid of toggle pills with drag-paint bulk select: pressing a pill flips it, and that value paints onto every pill the pointer slides across. entries = [{ label, get, set }]; the stroke saves once on release. Builds a FRESH grid element into `host` each call, so the gesture listeners and pill lookup never outlive one paint.
    paintGrid(host, entries, save = null) {
        const grid = host.createDiv({ cls: "cc-pill-grid" });
        const byPill = new Map();
        for (const e of entries) {
            const pill = grid.createEl("button", { cls: "cc-pill", text: e.label });
            pill.classList.toggle("cc-pill-active", e.get());
            byPill.set(pill, e);
        }
        let pointerId = null, value = false;
        const paint = (pill) => {
            const e = pill && byPill.get(pill);
            if (!e || e.get() === value)
                return;
            e.set(value);
            pill.classList.toggle("cc-pill-active", value);
        };
        grid.addEventListener("pointerdown", (e) => {
            const pill = e.target instanceof Element ? e.target.closest(".cc-pill") : null;
            if (e.button !== 0 || !pill || !byPill.has(pill))
                return;
            pointerId = e.pointerId;
            value = !byPill.get(pill).get();
            capturePointer(grid, e.pointerId);
            paint(pill);
        });
        grid.addEventListener("pointermove", (e) => {
            if (e.pointerId !== pointerId)
                return;
            const under = grid.doc.elementFromPoint(e.clientX, e.clientY);
            const pill = under ? under.closest(".cc-pill") : null;
            if (pill && grid.contains(pill))
                paint(pill);
        });
        const end = (e) => {
            if (e.pointerId !== pointerId)
                return;
            releasePointer(grid, pointerId);
            pointerId = null;
            // A press always flips the pressed pill, so a finished stroke always changed something — persist it (to a list's own file when `save` is given).
            void this.commit(save);
        };
        grid.addEventListener("pointerup", end);
        grid.addEventListener("pointercancel", end);
    }
    // Pill entries over the character list for a given enable field (root/sidebar each read/write their own boolean).
    charPills(get, set) {
        return this.plugin.characterData.characters.map((c) => ({
            label: c.name || "(unnamed)",
            get: () => get(c),
            set: (v) => set(c, v),
        }));
    }
    // Pill entries over a named list carrying its own `enabled` flag (comment sets, VIPs, mail templates).
    enablePills(list) {
        return list.map((it) => ({ label: it.name || "(unnamed)", get: () => it.enabled, set: (v) => { it.enabled = v; } }));
    }
    // Pill entries over a registry (effects, aesthetics) whose on/off lives in a shared flag map keyed by row.
    flagPills(registry, flags) {
        return registry.map((r) => ({ label: r.label, get: () => flags[r.key], set: (v) => { flags[r.key] = v; } }));
    }
    // Mount one enable-pill grid on the tab being rendered: create its host div, store the ref its PILL_GRIDS row names, and paint it. The render tabs call this instead of repeating the div + ref + rebuild by hand.
    mountPillGrid(container, id) {
        this[PILL_GRIDS[id].grid] = container.createDiv();
        this.rebuildPillGrid(id);
    }
    // Repaint one enable-pill grid from its PILL_GRIDS descriptor into its host, fresh (paintGrid rebuilds the grid element, so nothing stale survives): skip an off-screen host (isConnected — a rebuild triggered from another tab is harmless), show the row's empty-state message when it has one and there are no entries, else drag-paint the pills.
    rebuildPillGrid(id) {
        const g = PILL_GRIDS[id];
        const host = this[g.grid];
        if (!host || !host.isConnected)
            return;
        host.empty();
        const entries = g.entries(this);
        if (g.empty && entries.length === 0) {
            host.createDiv({ cls: "cc-pill-grid" }).createDiv({ cls: "cc-empty", text: g.empty });
            return;
        }
        this.paintGrid(host, entries, g.save ? () => g.save(this) : null);
    }
    // Render the per-character toggle icons (CHARACTER_TOGGLES) into a Setting row: one extra button each, flipping its boolean and reflecting state via "cc-toggle-active".
    addCharacterToggles(setting, character) {
        for (const t of CHARACTER_TOGGLES) {
            setting.addExtraButton((b) => {
                b.setIcon(t.icon).setTooltip(t.label);
                b.extraSettingsEl.classList.toggle("cc-toggle-active", !!character[t.key]);
                b.onClick(async () => {
                    character[t.key] = !character[t.key];
                    b.extraSettingsEl.classList.toggle("cc-toggle-active", character[t.key]);
                    await this.plugin.saveDataFile("characterData");
                });
            });
        }
    }
    // Per-character editor body (the ListEditor renders this for the selected char).
    renderCharacterBody(containerEl, character, editor) {
        const box = containerEl.createDiv({ cls: "cc-settings-box" });
        // Characters live in character-data.json now, so every field persists there (not via saveSettings). A rerender is only needed when the change alters which/what sprite shows (name in pills, sprite path).
        const save = () => this.plugin.saveDataFile("characterData");
        const saveRender = () => this.plugin.saveDataFile("characterData", true);
        this.addTextSetting(box, {
            name: "Name",
            placeholder: "(unnamed)",
            configure: (s) => this.addCharacterToggles(s, character),
            get: () => character.name,
            set: (v) => {
                character.name = v;
                editor.refreshPillLabel(character.id, v || "(unnamed)");
                this.rebuildPillGrid("root");
                this.rebuildPillGrid("sidebar");
            },
            save: saveRender,
        });
        this.addTextSetting(box, {
            name: "Sprite path",
            desc: "Vault-relative (e.g. \"Attach/hero.png\"). Either separate multiple image paths by commas, or leave a single folder path to use all images inside it; the two methods can't be mixed. A bare filename works if unique. A single emoji (e.g. \"🦸\") works too.",
            placeholder: "Attach/happy.png, Attach/angry.png",
            get: () => character.spritePath,
            set: (v) => (character.spritePath = v.trim()),
            save: saveRender,
        });
        this.addSliderSetting(box, {
            name: "Sprite speed", unit: "%",
            desc: "Compared to the base speed. 0 = stands still, 100 = default, 200 = double.",
            min: 0, max: 200, step: 10,
            get: () => character.walkSpeedPct,
            set: (v) => (character.walkSpeedPct = v),
            save,
        });
        // Stream template vars — the crowd's comments reference these about the shown character. All optional; blanks fall back to a generic default so no comment ever breaks.
        this.addTextSetting(box, {
            name: "Epithet",
            desc: "Their nickname, used as $epithet. Comma-separate several to draw one at random each time (e.g. \"the Demon Lord, the Tyrant\"). Falls back to \"Name\".",
            placeholder: "the Great Guardian",
            get: () => character.epithet,
            set: (v) => (character.epithet = v.trim()),
            save,
        });
        this.addTextSetting(box, {
            name: "Role",
            desc: "Their occupation, used as $role. Comma-separate several to draw one at random each time (e.g. \"detective, phantom thief\"). Falls back to \"legend\".",
            placeholder: "superhero",
            get: () => character.role,
            set: (v) => (character.role = v.trim()),
            save,
        });
        this.addTextSetting(box, {
            name: "Pronouns",
            desc: "Their pronouns, mapping to $they/$them/$their; optional 4th/5th to $theirs/$themself. Slash-separate (e.g. \"she/her/her\" or \"xe/xem/xyr\"). Falls back to \"they/them/their\".",
            placeholder: "they/them/their",
            get: () => character.pronouns,
            set: (v) => (character.pronouns = v.trim()),
            save,
        });
        new Setting(box)
            .setName("Quotes")
            .setDesc("One quote per line. RiScript ignored.");
        this.addBulkTextarea(box, {
            get: () => character.quotes,
            set: (lines) => (character.quotes = lines),
            save,
        });
        new Setting(box)
            .setName("Deeds")
            .setDesc("What they've done. One verb phrase per line, used as $deed. Append .ing() / .ed() / .s() to inflect (e.g., $deed.ing() = \"conquer the world\" → \"conquering the world\"). Write non-actions with auxiliary verbs (e.g., \"be a master of disguise\").");
        this.addBulkTextarea(box, {
            get: () => character.deeds,
            set: (lines) => (character.deeds = lines),
            save,
        });
        new Setting(box)
            .setName("Topics")
            .setDesc("What they're associated with. One noun phrase per line, used as $topic. Write actions with gerunds (e.g., \"programming and hacking\").");
        this.addBulkTextarea(box, {
            get: () => character.topics,
            set: (lines) => (character.topics = lines),
            save,
        });
    }
    // Per-comment-set editor body: a name and the comment lines (delete via pill right-click).
    renderCommentSetBody(containerEl, set, editor) {
        const box = containerEl.createDiv({ cls: "cc-settings-box" });
        const save = () => this.plugin.saveDataFile("streamData");
        this.addTextSetting(box, {
            name: "Label",
            placeholder: "(unnamed)",
            get: () => set.name,
            set: (v) => {
                set.name = v;
                editor.refreshPillLabel(set.id, v || "(unnamed)");
                this.rebuildPillGrid("commentSet");
            },
            save,
        });
        new Setting(box)
            .setName("Comments")
            .setDesc("One comment per line. RiScript: character vars = $name / $epithet / $role / $deed / $topic, character pronouns = $they / $them / $their, inflections = $deed.ing() / .ed() / .s(), inline choices = [a | b], weighted choices = [a(n) | b], lexicon = $rndAdj / $rndNoun / $rndVerb, string = $num<1-9> / $let<5-7> / $mix<2-6> (also $let-lower / $let-upper / $mix-lower / $mix-upper). Any plain line works as-is.");
        this.addBulkTextarea(box, {
            get: () => set.comments,
            set: (lines) => (set.comments = lines),
            save,
        });
        new Setting(box)
            .setName("Variables")
            .setDesc("One variable per line. Format = \"variable: a, b, c\".");
        this.addMapTextarea(box, {
            get: () => set.vars,
            set: (m) => (set.vars = m),
            save,
        });
    }
}
module.exports = { CompanionSettingTab };
