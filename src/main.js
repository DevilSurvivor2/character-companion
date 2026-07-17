"use strict";
// Entry point: wires the view, ribbon + command, settings tab, the stage, and the generic sibling-data-file load/save.
const { Notice, Plugin } = require("obsidian");
const { DATA_FILES, DATA_FILE_BY_PROP, FLAG_MAPS, SETTINGS_SCHEMA, boolMap } = require("./registries.js");
// Build-injected default seeds, keyed by sibling-file name — one entry per src/data/*.json (see esbuild.config.mjs).
const DATA_SEEDS = require("virtual:seed-data");
const { whenStyled } = require("./toolkit.js");
const { RiScriptEngine } = require("./riscriptengine.js");
const { CompanionStage } = require("./companionstage.js");
const { CompanionView, VIEW_TYPE_COMPANION } = require("./companionview.js");
const { SettingTab } = require("./settingtab.js");
class CharacterCompanionPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
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
        this.addSettingTab(new SettingTab(this.app, this));
        this.stage = new CompanionStage(this);
        this.app.workspace.onLayoutReady(() => {
            this.register(whenStyled(() => this.stage.mount()));
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
    // First-run welcome (no prior data.json): open the panel, point at settings.
    welcome() {
        void this.activateView();
        new Notice("Character Companion is ready — Hero and Villain are walking along the bottom of your window. Open the panel any time from the ribbon (the ghost icon), and add your own in Settings → Character Companion.", 12000);
    }
    // Run fn on every open companion panel.
    eachView(fn) {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMPANION))
            if (leaf.view instanceof CompanionView)
                fn(leaf.view);
    }
    async loadSettings() {
        // No data.json yet = a genuine first run; the welcome nudge keys off this.
        const raw = await this.loadData();
        this.firstRun = raw == null;
        const loaded = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.assign({}, raw) : {};
        const s = Object.fromEntries(SETTINGS_SCHEMA.map(({ key, coerce }) => [key, coerce(loaded[key])]));
        // Re-normalise each enable map: keep known flags, default new names.
        for (const [key, names, def] of FLAG_MAPS)
            s[key] = boolMap(names, loaded[key], def);
        this.settings = s;
        this.dataFileWriteLocks = new Set();
        this.writeQueue = Promise.resolve();
        // The sibling files are independent, so read them in parallel — this sits on the plugin-load critical path.
        await Promise.all(DATA_FILES.map((desc) => this.loadDataFile(desc)));
        // Persist the cleaned shape so anything stale in data.json is dropped.
        await this.persistSettings();
    }
    // Generic sibling-file load: read, shape, and seed the file when genuinely MISSING. Never seed on corrupt — readJsonFile backed it up, and rewriting would overwrite the user's only copy.
    // Seed priority: the row's inline seed, else src/data/<file> (DATA_SEEDS), else ship empty.
    async loadDataFile(desc) {
        const { data, existed, writable } = await this.readJsonFile(this.manifest.dir + "/" + desc.file);
        if (!writable)
            this.dataFileWriteLocks.add(desc.prop);
        else
            this.dataFileWriteLocks.delete(desc.prop);
        let shaped = desc.shape(data);
        if (!existed) {
            const seedRaw = desc.seed ?? DATA_SEEDS[desc.file];
            if (seedRaw)
                shaped = desc.shape(seedRaw);
        }
        this[desc.prop] = shaped;
        if (desc.create && !existed)
            await this.saveDataFile(desc.prop);
    }
    // THE save API for every per-file list: write the in-memory shape, then run the file's afterSave side effects.
    async saveDataFile(prop, rerender = false) {
        const desc = DATA_FILE_BY_PROP[prop];
        if (this.dataFileWriteLocks.has(prop)) {
            new Notice("Character Companion: " + desc.file + " was not loaded safely, so it will not be overwritten. Repair the file and reload the plugin before saving changes.", 12000);
            return false;
        }
        const path = this.manifest.dir + "/" + desc.file;
        await this.queueWrite(() => this.writeJsonFile(path, this[prop]));
        if (desc.afterSave)
            desc.afterSave(this, rerender);
        return true;
    }
    // Read a sibling JSON file; only missing files are safe to seed.
    async readJsonFile(path) {
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(path)))
            return { data: null, existed: false, writable: true };
        let text;
        try {
            text = await adapter.read(path);
        }
        catch {
            new Notice("Character Companion: " + path.split("/").pop() + " couldn't be read. It will not be overwritten; repair it and reload the plugin.", 12000);
            return { data: null, existed: true, writable: false };
        }
        try {
            return { data: JSON.parse(text), existed: true, writable: true };
        }
        catch {
            let backedUp = false;
            try { await adapter.write(path + ".corrupt-" + Date.now() + ".bak", text); backedUp = true; } catch { /* best effort */ }
            const backup = backedUp ? "A .bak copy was saved beside it." : "A backup could not be saved.";
            new Notice("Character Companion: " + path.split("/").pop() + " contains invalid JSON. " + backup + " It will not be overwritten; repair it and reload the plugin.", 12000);
            return { data: null, existed: true, writable: false };
        }
    }
    async writeJsonFile(path, obj) {
        await this.app.vault.adapter.write(path, JSON.stringify(obj, null, 2));
    }
    // Serialize every save; swallowing only the prior failure keeps the next attempt available.
    queueWrite(write) {
        this.writeQueue = this.writeQueue.catch(() => undefined).then(write);
        return this.writeQueue;
    }
    persistSettings() {
        return this.queueWrite(() => this.saveData(this.settings));
    }
    async saveSettings(rerender = false) {
        await this.persistSettings();
        this.applyChange(rerender);
    }
    // Reconcile open UI after a save: full=true re-renders panels, else the panel's own idempotent sync() applies everything in place. Always refreshes the stage.
    applyChange(full = false) {
        this.eachView(full ? (view) => view.render() : (view) => view.sync());
        if (this.stage)
            this.stage.refresh();
    }
}
module.exports = CharacterCompanionPlugin;
