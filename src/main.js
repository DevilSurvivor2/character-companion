"use strict";
// Entry point: the plugin class that wires everything — view, ribbon + command, settings
// tab, the bottom-of-window stage, and the generic sibling-data-file load/save.
const { Notice, Plugin } = require("obsidian");
const { DATA_FILES, DATA_FILE_BY_PROP, DEFAULT_SETTINGS, FLAG_MAPS, boolMap, shapeIsEmpty } = require("./registries.js");
const { whenStyled } = require("./toolkit.js");
const { RiScriptEngine } = require("./riscriptengine.js");
const { CompanionStage } = require("./companionstage.js");
const { CompanionView, VIEW_TYPE_COMPANION } = require("./companionview.js");
const { CompanionSettingTab } = require("./companionsettingtab.js");
class CharacterCompanionPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        // One shared RiScript evaluator for both feed modes (Oracle + stream); RiTa loads once.
        this.riscript = new RiScriptEngine(this);
        this.registerView(VIEW_TYPE_COMPANION, (leaf) => new CompanionView(leaf, this));
        this.addRibbonIcon("ghost", "Open character companion", () => {
            void this.activateView();
        });
        this.addCommand({
            id: "open-panel",
            name: "Open panel",
            callback: () => {
                void this.activateView();
            },
        });
        this.addSettingTab(new CompanionSettingTab(this.app, this));
        this.stage = new CompanionStage(this);
        this.app.workspace.onLayoutReady(() => {
            whenStyled(() => this.stage.mount());
            if (this.firstRun)
                this.welcome();
        });
        this.register(() => {
            if (this.stage)
                this.stage.unmount();
        });
    }
    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_COMPANION)[0] ?? null;
        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            if (!leaf)
                return;
            await leaf.setViewState({
                type: VIEW_TYPE_COMPANION,
                active: true,
            });
        }
        await workspace.revealLeaf(leaf);
    }
    // First-run welcome: the two seeded sample characters are already walking along the bottom; open the panel so a new user meets one up close, and point them at settings. Fires once (no prior data.json).
    welcome() {
        void this.activateView();
        new Notice("Character Companion is ready — Hero and Villain are walking along the bottom of your window. Open the panel any time from the ribbon (the ghost icon), and add your own in Settings → Character Companion.", 12000);
    }
    // Run fn on every open companion panel. The one place view leaves are gathered and type-checked.
    eachView(fn) {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMPANION))
            if (leaf.view instanceof CompanionView)
                fn(leaf.view);
    }
    async loadSettings() {
        // No data.json yet = a genuine first run; the welcome nudge (onLayoutReady) keys off this.
        const raw = await this.loadData();
        this.firstRun = raw == null;
        const loaded = raw ?? {};
        const s = Object.assign({}, DEFAULT_SETTINGS);
        // Copy the scalar settings; the only object-typed defaults left are the enable maps, rebuilt below per FLAG_MAPS — skip them by type. Drop unknowns.
        for (const k of Object.keys(DEFAULT_SETTINGS)) {
            const def = DEFAULT_SETTINGS[k];
            if (def !== null && typeof def === "object")
                continue;
            if (loaded[k] !== undefined)
                s[k] = loaded[k];
        }
        // Migrate the pre-tri-state quoteTypewriter boolean (true=typed, false=whole line) to the "off"/"slow"/"fast" string.
        if (typeof s.quoteTypewriter === "boolean")
            s.quoteTypewriter = s.quoteTypewriter ? "slow" : "off";
        // Migrate the pre-rename stream interval keys (streamCommentMin/MaxMs) to the `<key>MinMs`/`<key>MaxMs` convention every feed source now shares.
        if (typeof loaded.streamCommentMinMs === "number")
            s.streamMinMs = loaded.streamCommentMinMs;
        if (typeof loaded.streamCommentMaxMs === "number")
            s.streamMaxMs = loaded.streamCommentMaxMs;
        // Re-normalise each enable map per its FLAG_MAPS row: keep known flags, default new names.
        for (const [key, names, def] of FLAG_MAPS)
            s[key] = boolMap(names, loaded[key], def);
        this.settings = s;
        // The bulky content lives in its own file (keeps data.json small): the character list, Oracle's templates/VIPs, Stream's comment sets, and Mail's templates — see the DATA_FILES table. The files are independent, so read them in parallel — this sits on the plugin-load critical path.
        await Promise.all(DATA_FILES.map((desc) => this.loadDataFile(desc)));
        // Persist the cleaned shape so anything stale in data.json is dropped.
        await this.saveData(this.settings);
    }
    // Generic sibling-file load (driven by a DATA_FILES row): read the file, build its in-memory shape, and seed the file when genuinely MISSING (first run / post-migration). Never on corrupt — readJsonFile has already backed it up + warned, and rewriting would overwrite the user's only copy.
    async loadDataFile(desc) {
        const { data, existed } = await this.readJsonFile(this.manifest.dir + "/" + desc.file);
        let shaped = desc.shape(data);
        // Seed shipped starter content on genuine first run. Corrupt files return existed:true to prevent overwriting the user's data.
        if (desc.seed && !existed && shapeIsEmpty(shaped)) {
            const seedRaw = await desc.seed(this);
            if (seedRaw)
                shaped = desc.shape(seedRaw);
        }
        this[desc.prop] = shaped;
        if (desc.create && !existed)
            await this.saveDataFile(desc.prop);
    }
    // Generic sibling-file save — THE save API for every per-file list (settings editors + views call it with the DATA_FILES prop name): write the in-memory shape, then run this file's save-time side effects (see DATA_FILES `afterSave`).
    async saveDataFile(prop, rerender = false) {
        const desc = DATA_FILE_BY_PROP[prop];
        await this.writeJsonFile(this.manifest.dir + "/" + desc.file, this[prop]);
        if (desc.afterSave)
            desc.afterSave(this, rerender);
    }
    // Read a sibling JSON file. Returns { data, existed }: missing -> {null, false} (safe to seed); corrupt -> {null, true} (backed up as .bak, never overwritten); ok -> {parsed, true}.
    async readJsonFile(path) {
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(path)))
            return { data: null, existed: false };
        let text = null;
        try {
            text = await adapter.read(path);
            return { data: JSON.parse(text), existed: true };
        }
        catch {
            // Existing file we couldn't read/parse: back up what we have (best effort), warn, and never signal "missing" — clobbering it would destroy the only copy.
            if (text != null)
                try { await adapter.write(path + ".corrupt-" + Date.now() + ".bak", text); } catch { /* best effort */ }
            new Notice("Character Companion: " + path.split("/").pop() + " couldn't be read (corrupt JSON). A .bak copy was saved beside it; that list stays empty until the file is repaired or you re-add its items.", 12000);
            return { data: null, existed: true };
        }
    }
    async writeJsonFile(path, obj) {
        await this.app.vault.adapter.write(path, JSON.stringify(obj, null, 2));
    }
    async saveSettings(rerender = false) {
        await this.saveData(this.settings);
        this.applyChange(rerender);
    }
    // Reconcile open UI after a save. full=true -> re-render panels. Otherwise the panel's own idempotent sync() reconciles everything in place (timers, bottom-bar occupant, backdrop, effects, fonts, button lights — every setting applies live without tearing the sprite down). Always reconciles stage.
    applyChange(full = false) {
        this.eachView(full ? (view) => view.render() : (view) => view.sync());
        if (this.stage)
            this.stage.refresh();
    }
}
module.exports = CharacterCompanionPlugin;
