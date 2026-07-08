"use strict";
/* global __ccLoadRita -- defined by the build banner (esbuild.config.mjs): the lazy wrapper around the vendored RiTa script */
const { ItemView, Menu, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, setIcon } = require("obsidian");
const DEFAULT_ORACLE = require("../default-oracle-data.json");
// Animation registry: one row = one animation class (keyframes in styles.css). role: surprise/idle (toggleable), sleep/flip/bob/tickle (playRole functions), effect (internal). directional: keyframe reads --cc-dir for L/R flip. root: false excludes bottom-of-window walkers.
const ANIMATIONS = [
    // surprise — click reactions; grid order is this order.
    { name: "shudder", role: "surprise" },
    { name: "glitch", role: "surprise" },
    { name: "pulse", role: "surprise", directional: true },
    { name: "heartbeat", role: "surprise" },
    { name: "squish", role: "surprise" },
    { name: "stretch", role: "surprise" },
    { name: "wobble", role: "surprise", directional: true },
    { name: "nod", role: "surprise" },
    { name: "dizzy", role: "surprise", directional: true },
    { name: "doubletake", role: "surprise", label: "Double Take" },
    { name: "jump", role: "surprise" },
    { name: "hop", role: "surprise", directional: true },
    { name: "stomp", role: "surprise", directional: true },
    { name: "slide", role: "surprise", directional: true },
    { name: "sprint", role: "surprise", directional: true },
    { name: "dance", role: "surprise", directional: true },
    { name: "grayscale", role: "surprise", label: "Grey" },
    { name: "fade", role: "surprise" },
    { name: "sink", role: "surprise" },
    { name: "soul", role: "surprise" },
    { name: "ponder", role: "surprise" },
    { name: "glow", role: "surprise" },
    { name: "blink", role: "surprise" },
    { name: "ninja", role: "surprise", directional: true },
    // idle — ambient self-motion.
    { name: "rock", role: "idle", directional: true },
    { name: "wiggle", role: "idle", directional: true },
    { name: "shuffle", role: "idle", directional: true },
    { name: "twitch", role: "idle", directional: true },
    { name: "shimmy", role: "idle", directional: true },
    { name: "groove", role: "idle", directional: true },
    { name: "tap", role: "idle" },
    { name: "glance", role: "idle" },
    { name: "perk", role: "idle" },
    { name: "pace", role: "idle", directional: true },
    { name: "stroll", role: "idle", directional: true, root: false },
    { name: "zoom", role: "idle", directional: true, root: false },
    { name: "skip", role: "idle", directional: true },
    { name: "tiptoe", role: "idle", directional: true },
    { name: "weave", role: "idle", directional: true },
    { name: "duck", role: "idle" },
    { name: "wind", role: "idle", directional: true },
    { name: "breathe", role: "sleep" },
    { name: "doze", role: "sleep", directional: true },
    // function-roles — pulled by the Walker method of the same name via playRole.
    { name: "flip", role: "flip" },
    { name: "bob", role: "bob" },
    { name: "tickle", role: "tickle", directional: true },
    // effect — internal (held-shake ladder), named directly, never pooled.
    { name: "shake-small", role: "effect", directional: true },
    { name: "shake-large", role: "effect", directional: true },
];
const ANIM_BY_NAME = Object.fromEntries(ANIMATIONS.map((a) => [a.name, a]));
// Animation names grouped by role: grids draw from surprise/idle, playRole pulls the rest.
const ANIMS_BY_ROLE = {};
for (const a of ANIMATIONS)
    (ANIMS_BY_ROLE[a.role] ??= []).push(a.name);
// Animation pools by role: the settings flag toggling each + the full list — the single source pairing a toggleable role with its enable map. enabledList and the settings grids read it, and FLAG_MAPS derives its animation rows from it.
const ANIM_POOLS = {
    surprise: { flag: "enabledSurprises", all: ANIMS_BY_ROLE.surprise },
    idle: { flag: "enabledIdles", all: ANIMS_BY_ROLE.idle },
};
// Held-fidget escalation ladder: a carried sprite climbs these "effect" shakes, one rung every N bouts (random 1..--cc-hold-wiggle-bouts), holding on the last.
const HOLD_SHAKES = ["shake-small", "shake-large"];
// Every anim class, cleared before a new one so they can't stack.
const CLEARABLE = ANIMATIONS.map((a) => "cc-anim-" + a.name);
// Per-character boolean toggles, shown as icon buttons in the editor's Name row. Add one: append a row (key, lucide icon, tooltip) — editor + loadSettings derive from it.
const CHARACTER_TOGGLES = [
    { key: "curious", icon: "goal", label: "Curious: walk toward the cursor instead of fleeing" },
    { key: "assert", icon: "crown", label: "Assert: push a resting character aside instead of yielding" },
    { key: "escape", icon: "door-open", label: "Escape: wriggle free when held still" },
];
// Sidebar-panel action buttons (vertical icon column down the right edge). Add a row: `run(view)` is the click, optional `active(view)` lights it as a toggle.
const SIDEBAR_BUTTONS = [
    { icon: "shuffle", label: "Show another character", run: (v) => v.pickAnotherCharacter() },
    { icon: "settings", label: "Open plugin settings", run: (v) => v.openPluginSettings() },
    { icon: "radio", label: "Toggle stream mode", run: (v) => v.toggleMode("stream"), active: (v) => v.plugin.settings.streamEnabled },
    { icon: "sparkles", label: "Toggle oracle mode", run: (v) => v.toggleMode("oracle"), active: (v) => v.plugin.settings.oracleEnabled },
    { icon: "mail", label: "Toggle mail mode", run: (v) => v.toggleMode("mail"), active: (v) => v.plugin.settings.mailEnabled },
    { icon: "at-sign", label: "Toggle blog mode", run: (v) => v.toggleMode("blog"), active: (v) => v.plugin.settings.blogEnabled },
];
// Feed sources: one row drives bag/stop/timer/sync. pool = draw list (non-repeat via Bag); push = one beat. RiScript-templated.
const FEED_SOURCES = [
    // Stream comments: every enabled set's lines pooled flat (a draw is weighted by line count).
    {
        key: "stream", minKey: "streamCommentMinMs", maxKey: "streamCommentMaxMs",
        pool: (v) => v.plugin.streamData.commentSets.filter((cs) => cs.enabled).flatMap((cs) => cs.comments),
        push: (v, item) => v.pushComment(item),
    },
    // Mail: every enabled Title/From/To/Content template.
    {
        key: "mail", minKey: "mailMinMs", maxKey: "mailMaxMs",
        pool: (v) => v.plugin.mailData.mailTemplates.filter((m) => m.enabled),
        push: (v, tpl) => v.pushMail(tpl),
    },
    // Blog: the flat microblog line list — no per-line enable flag, the whole list is the pool.
    {
        key: "blog", minKey: "blogMinMs", maxKey: "blogMaxMs",
        pool: (v) => v.plugin.blogData.messages,
        push: (v, raw) => v.pushBlog(raw),
    },
];
// Stream special effects: each enabled key adds a class to .cc-anchor. Numbers + descriptors live in styles.css; buildEffect reads them to inject particle/layer nodes.
const SPECIAL_EFFECTS = [
    { key: "retro", label: "Retro" },
    { key: "gradient", label: "Gradient" },
    { key: "frame", label: "Frame" },
    { key: "firefly", label: "Fireflies" },
    { key: "square", label: "Squares" },
    { key: "rain", label: "Rain" },
];
const SPECIAL_EFFECT_KEYS = SPECIAL_EFFECTS.map((e) => e.key);
// Stream aesthetics: in-panel livestream overlay. Each key toggles a piece (tickers, status, react bar). Numbers in styles.css; motion via WAAPI. Add: row + DOM in buildAesthetics + CSS.
const AESTHETICS = [
    { key: "uptime", label: "Uptime" },
    { key: "viewer", label: "Viewer" },
    { key: "profile", label: "Profile" },
    { key: "status", label: "Status" },
    { key: "react", label: "React" },
];
const AESTHETIC_KEYS = AESTHETICS.map((a) => a.key);
// {name: bool} map over `names`, each from `src` if a boolean there, else `def`.
const boolMap = (names, src = {}, def = true) => Object.fromEntries(names.map((n) => [n, typeof src[n] === "boolean" ? src[n] : def]));
// A string list: keep the string items, drop everything else.
const strList = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
// Comma-separated inline text (e.g. "Trickster, Rascal") → a trimmed, non-empty string list.
const commaList = (v) => (v || "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
// A {name: string[]} map (variables / constants): keep object-valued string lists, drop empties. Each name becomes a RiScript choice rule the templates can reference as $name.
const strMap = (v) => {
    const out = {};
    if (v && typeof v === "object" && !Array.isArray(v))
        for (const k of Object.keys(v)) {
            const a = strList(v[k]);
            if (a.length) out[k] = a;
        }
    return out;
};
// Scalar coercers for schema rows (siblings of strList/strMap): `str` keeps a string else "". `bool(def)`/`num(def)` are factories returning a coercer that keeps a boolean/number else the given default.
const str = (v) => typeof v === "string" ? v : "";
const bool = (def) => (v) => typeof v === "boolean" ? v : def;
const num = (def) => (v) => typeof v === "number" ? v : def;
// Per-list-item schemas: rows of { key, coerce }, coerce validates a loaded value or returns the default (coerce(undefined) → default). Single source for both load (coerceItem) and create (newItem), so a field is one row. `id` is implicit.
const CHARACTER_SCHEMA = [
    { key: "name", coerce: str },
    { key: "spritePath", coerce: str },
    { key: "quotes", coerce: strList },
    { key: "walkSpeedPct", coerce: num(100) },
    { key: "rootEnabled", coerce: bool(false) },
    // Default on so existing vaults keep every character in the sidebar bag.
    { key: "sidebarEnabled", coerce: bool(true) },
    // Stream template vars. Pronouns: slash-sep -> $they/$them/$their. Epithet/role: comma-sep -> $epithet/$role. Deeds/topics: verb-initial phrases for $deed.ing()/.ed()/.s(). All optional; streamCtx() provides safe defaults.
    { key: "epithet", coerce: str },
    { key: "role", coerce: str },
    { key: "pronouns", coerce: str },
    { key: "deeds", coerce: strList },
    { key: "topics", coerce: strList },
    // Per-character toggles (curious/assert/escape …), defaulted off, from the registry.
    ...CHARACTER_TOGGLES.map((t) => ({ key: t.key, coerce: bool(false) })),
];
const COMMENT_SET_SCHEMA = [
    { key: "name", coerce: str },
    { key: "comments", coerce: strList },
    { key: "enabled", coerce: bool(true) },
    // Per-set variables {name: [...]} — each a $name choice rule usable in this set's comments ($time greetings, $hype, any custom var). Per-set scope: only this set's lines see them.
    { key: "vars", coerce: strMap },
];
// Oracle VIP (named patron). Lives in oracle-data.json. Reserved var 'topic' = VIP's match-list: feeds classifier training + typed-word matching + $topic fallback. Other vars keys are $name choice pools.
const VIP_SCHEMA = [
    // Identifier + pill label (e.g. "Artemis"); also the future reference handle.
    { key: "name", coerce: str },
    // In-feed epithet shown in quotes (e.g. "Pure Moonlight Hunter"); falls back to name.
    { key: "modifier", coerce: str },
    // Optional patron origin word ("constellation"); empty → random from the pool.
    { key: "origin", coerce: str },
    { key: "enabled", coerce: bool(true) },
    // Output: sentence-1 frames ("$verb.s() $manner" or a plain "roars with approval") and standalone follow-ups. Both are RiScript — they may reference this VIP's variables, the shared constants, $topic, and transforms (.s/.ed/.ing).
    { key: "reactions", coerce: strList },
    { key: "asides", coerce: strList },
    // Per-VIP variables {name: [...]} — each usable as $name (a random pick) inside frames. The reserved key `topic` doubles as the VIP's match-list (see above); it never needs an explicit $topic reference since the echo injects that per beat.
    { key: "vars", coerce: strMap },
];
// Mail template: Title/From/To/Content are RiScript lines, evaluated against streamCtx() + shared mail constants. Lives in mail-data.json. 'name' is admin-only pill label.
const MAIL_SCHEMA = [
    { key: "name", coerce: str },
    { key: "title", coerce: str },
    { key: "from", coerce: str },
    { key: "to", coerce: str },
    { key: "content", coerce: str },
    { key: "enabled", coerce: bool(true) },
];
// Normalise a loaded object to exactly its schema fields (drop unknowns), keep/mint its id. newItem is the inverse: a fresh item from the same defaults, with optional overrides.
function coerceItem(schema, raw) {
    const out = { id: typeof raw.id === "string" ? raw.id : genId() };
    for (const f of schema)
        out[f.key] = f.coerce(raw[f.key]);
    return out;
}
function newItem(schema, overrides) {
    const out = { id: genId() };
    for (const f of schema)
        out[f.key] = f.coerce(undefined);
    return Object.assign(out, overrides);
}
// A shaped data-file object is "empty" when it holds no list content (every array value is empty). The first-run seed trigger — non-list values (activeCharacterId, the constants maps) don't count, so a file that only carries constants still seeds its lists.
const shapeIsEmpty = (o) => Object.values(o).every((v) => !Array.isArray(v) || v.length === 0);
// Shipped starter content for first-run seeding. Bulky defaults ship as default-*.json, not inline.
const SEED_CHARACTERS = {
    activeCharacterId: "seed-hero",
    characters: [
        {
            id: "seed-hero", name: "Hero", spritePath: "🦸", rootEnabled: true, sidebarEnabled: true,
            quotes: ["Everyone gets home safe.", "Trust me.", "Get out of there!", "This is the part where I say I'm not your mother...", "Sorry to drop in unannounced.", "Whoa! Whoa! Whoa!", "Let's go get some ice cream.", "I'm very much not dead.", "Sorry, no autograph right now.", "Can I help you?"],
            epithet: "the Guardian of Gateway, the Champion", role: "superhero",
            pronouns: "he/him/his",
            deeds: ["save the world", "rescue kittens", "protect people", "be a good role model"],
            topics: ["justice", "love and peace", "heroism", "helping those in need", "the greater good", "children"],
        },
        {
            id: "seed-villain", name: "Villain", spritePath: "🦹", rootEnabled: true, sidebarEnabled: true,
            quotes: ["Soon, the whole city will bow to me.", "I have my plans.", "I've waited too long for this!", "Speaking from experience, I can't really recommend that path.", "What's this? I don't remember ordering takeout.", "I don't know if you've realized it, but I'm kind of a big deal...", "I don't like being interrupted.", "You're just like the rest of them.", "I have no idea what you're talking about, officer. I'm a very busy man, so let's get on with this, shall we?"],
            epithet: "the Mad Scientist, the Nemesis", role: "supervillain, schemer",
            pronouns: "he/him/his",
            deeds: ["take over the world", "get revenge", "cause chaos", "make lots of money"],
            topics: ["power", "fear", "chaos", "the good ol' days", "evil schemes"],
        },
    ],
};
// Sample comment set exercising all stream vars.
const SEED_STREAM = {
    commentSets: [{
        id: "seed-sample", name: "Sample", enabled: true,
        comments: [
            "$name is out here $deed.ing() again, chat",
            "not $epithet showing up just to $deed",
            "the way $they talks about $topic is everything",
            "someone give $them the crown already",
            "that one was all $theirs",
            "$name never second-guesses $themself",
            "chat we [love | stan] $name, best $role [here | on this timeline]",
            "$name is genuinely $hype at $topic",
            "good $time guys",
        ],
        vars: { hype: ["goated", "unreal", "elite", "cracked"], time: ["morning", "evening"] },
    }],
};
const SEED_MAIL = {
    constants: { npc: ["The Metro Times", "City Hall", "an anonymous admirer", "YOUR EDITOR"] },
    mailTemplates: [{
        id: "seed-mail-1", name: "Fan letter", enabled: true,
        title: "[Heard good things about you... | Regarding recent events]",
        from: "$npc",
        to: "$name, $epithet",
        content: "Word around town is that $name has been $deed.ing(). Nobody can stop talking about $topic. Keep it up and maybe something will actually change for once. Hope to catch you in action!",
    }],
};
const SEED_BLOG = {
    constants: { celebrity: ["dailyplanet", "themayor", "channel7news", "nightlyshow"], city: ["Metro City", "downtown", "the harbor district", "the old quarter"] },
    messages: [
        "@$celebrity @$celebrity i think about your last post more than i think about my own life",
        "does anyone in $city actually know how the streetlamps work?",
        "#RealTalk we have to choose between (1) mass poverty and economic collapse, (2) government overreach, and (3) alien space parasites. discuss.",
        "I AM IN THE CENTRAL BANK AND I AM 100% CERTAIN THAT NOBODY IS GOING TO ROB THIS BANK TODAY",
        "We have to understand. They used to think dragons wasn't a real thing.",
        "@$handle @CentralBank if nobody's going to rob the bank, who am I even supposed to shoot?",
        "#RiotAlert #Tonight I can't believe they would even consider closing the soup kitchen.",
        "they've been promising us aliens for decades what do i keep paying taxes for",
        "@$handle @$celebrity I know you're saying the police are overworked and underpaid but consider: so am I",
        "about to see my cousin's wedding!!!",
    ],
};
// Sibling data files (kept out of data.json). One row per file drives generic load/save. Fields: prop (plugin field); file (sibling filename); shape (raw)=>in-memory object; create (write when genuinely MISSING, never on corrupt); seed (starter content on first run — small defaults inline, bulky via default-*.json); afterSave (side effects: char save -> repaint views+stage; Oracle save -> retrain classifiers).
const DATA_FILES = [
    {
        prop: "characterData", file: "character-data.json", create: true, seed: () => SEED_CHARACTERS,
        shape: (raw) => {
            const src = raw && Array.isArray(raw.characters) ? raw.characters : [];
            const characters = src.map((c) => coerceItem(CHARACTER_SCHEMA, c));
            // Active id must point at a surviving character.
            let activeId = raw && typeof raw.activeCharacterId === "string" ? raw.activeCharacterId : null;
            if (!characters.some((c) => c.id === activeId))
                activeId = characters.length > 0 ? characters[0].id : null;
            return { characters, activeCharacterId: activeId };
        },
        // The shown sprite (or its enabled set) may have changed → the shared reconcile, full-render when asked.
        afterSave: (p, rerender) => p.applyChange(rerender),
    },
    {
        prop: "streamData", file: "stream-data.json", create: true, seed: () => SEED_STREAM,
        shape: (raw) => {
            const src = raw && Array.isArray(raw.commentSets) ? raw.commentSets : [];
            return { commentSets: src.map((cs) => coerceItem(COMMENT_SET_SCHEMA, cs)) };
        },
    },
    {
        // Seed reads the shipped default-oracle-data.json release asset to keep main.js lean. If absent, the oracle starts empty.
        prop: "oracleData", file: "oracle-data.json", create: false,
        seed: () => DEFAULT_ORACLE,
        shape: (raw) => {
            raw = raw || {};
            return {
                sysTemplates: strList(raw.sysTemplates),
                anonTemplates: strList(raw.anonTemplates),
                vips: (Array.isArray(raw.vips) ? raw.vips : []).map((v) => coerceItem(VIP_SCHEMA, v)),
                // Shared, troupe-wide choice pools any template can reference as $name.
                constants: strMap(raw.constants),
            };
        },
        afterSave: (p) => p.eachView((view) => view.oracle.rebuild()),
    },
    {
        prop: "mailData", file: "mail-data.json", create: false, seed: () => SEED_MAIL,
        shape: (raw) => {
            raw = raw || {};
            return {
                mailTemplates: (Array.isArray(raw.mailTemplates) ? raw.mailTemplates : []).map((m) => coerceItem(MAIL_SCHEMA, m)),
                constants: strMap(raw.constants),
            };
        },
    },
    {
        // Blog has no per-item list (no pills / ListEditor): just a flat line-list of raw microblog strings + a shared constants map. Each line is parsed at push time (see pushBlog) — no schema table needed.
        prop: "blogData", file: "blog-data.json", create: false, seed: () => SEED_BLOG,
        shape: (raw) => {
            raw = raw || {};
            return {
                messages: strList(raw.messages),
                constants: strMap(raw.constants),
            };
        },
    },
];
const DATA_FILE_BY_PROP = Object.fromEntries(DATA_FILES.map((d) => [d.prop, d]));
const DEFAULT_SETTINGS = {
    // Characters (the bulky array) + the active-character pointer live in character-data.json, not here — see the DATA_FILES table. data.json holds only the light "bones": scalars + the animation/effect/aesthetic enable maps.
    sidebarSpriteMaxHeight: 300,
    rootSpriteMaxHeight: 150,
    rootWalkSpeed: 20,
    quoteDurationMs: 3000,
    quoteTypewriter: "off",   // "off": whole line at once; "slow"/"fast": reveal sentence-by-sentence, typewriter-style, at the matching --cc-quote-type-speed-* gap
    surpriseChance: 20,
    animateOnQuote: true,
    idleEnabled: true,
    chatterChance: 25,
    sleepAfterMs: 120000,
    // ---- stream mode (sidebar panel) ----
    streamEnabled: false,
    // Vault paths or emojis (like a character's sprite field), cycled at a random interval (ms). Seeded with 🌃 so a fresh install has a backdrop the moment stream mode is toggled on.
    streamBackgrounds: "🌃",
    streamBgMinMs: 600000,
    streamBgMaxMs: 1200000,
    // Stored ms between comment bubbles, picked at random in [min, max].
    streamCommentMinMs: 10000,
    streamCommentMaxMs: 20000,
    // Comment bubbles kept on screen before the oldest drops.
    streamHistoryCount: 6,
    // ---- Oracle mode (sidebar panel) ---- A second feed mode: three message types (SYSTEM / ANON / VIP) generated locally with RiTa + compromise + whichx. Bulky content lives in oracle-data.json; only scalars here.
    oracleEnabled: false,
    // The two configurable name tokens. Patron is a pool: comma-separated, each optionally "Name (Plural)" — drawn at random per message. Blank falls back to ORACLE_SYS_FALLBACK / ORACLE_PATRON_FALLBACK (also the settings placeholders — one source for both).
    oracleSystemName: "",
    oraclePatronName: "",
    // Independent interval ranges per type (authored seconds, stored ms; like streamComment).
    oracleSysMinMs: 20000,
    oracleSysMaxMs: 45000,
    oracleAnonMinMs: 15000,
    oracleAnonMaxMs: 30000,
    oracleVipMinMs: 12000,
    oracleVipMaxMs: 25000,
    // VIP beats consult what you're typing when fresh; off = always ambient topics.
    oracleVipReactsToTyping: true,
    // ---- Mail mode (sidebar panel) ---- A third feed source: one randomly-drawn Title/From/To/Content template, RiScript-filled, on its own interval. Bulky content (templates + constants) lives in mail-data.json.
    mailEnabled: false,
    mailMinMs: 900000, // 15 min
    mailMaxMs: 2400000, // 40 min
    // ---- Blog mode (sidebar panel) ---- A fourth feed source: microblog posts (@handle / body / #tags) drawn one per beat on a random interval in [min, max], RiScript-filled against blog-data.json's constants. A post with no @handle gets a randomly generated one; content is pure-ambient (never references the shown character). Bulky content lives in blog-data.json.
    blogEnabled: false,
    blogMinMs: 60000, // 1 min
    blogMaxMs: 180000, // 3 min
    // ---- Miscellaneous (stream overlay fonts + gift emojis) ---- CSS font-family strings (used verbatim), empty = keep the styles.css defaults.
    commentFont: "",       // overrides --cc-stream-font on the comment feed bubbles
    giftEmojiFont: "",     // font-family for the rained gift emojis
    // Whitespace/newline-separated emojis the gift button rains; each token is one gift option. Empty = a single 🎁. Stored as raw text (multi-line for easier organising); split on whitespace at spawn time.
    giftEmojis: "",
};
// Oracle name fallbacks: what $system and the patron pool resolve to when the field is left blank. One source, reused as the settings placeholders so the hint always matches the actual fallback.
const ORACLE_SYS_FALLBACK = "Star Stream";
const ORACLE_PATRON_FALLBACK = "Constellation";
// The enable maps (flag-per-name): [settings key, names, default]. One row drives both the defaults (filled into DEFAULT_SETTINGS below) and loadSettings' re-normalisation — keep known flags, default any newly added name to the row's default. The animation rows spread from ANIM_POOLS so the role↔flag pairing lives in one place. Effects start OFF (each is an opt-in overlay); the rest ON.
const FLAG_MAPS = [
    ...Object.values(ANIM_POOLS).map((p) => [p.flag, p.all, true]),
    ["enabledEffects", SPECIAL_EFFECT_KEYS, false],
    ["enabledAesthetics", AESTHETIC_KEYS, true],
];
for (const [key, names, def] of FLAG_MAPS)
    DEFAULT_SETTINGS[key] = boolMap(names, {}, def);
function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
// Fisher-Yates shuffle in place; returns the same array.
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
// Uniform random in [lo, hi).
function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
}
// Uniform random integer in [lo, hi] inclusive (hi floored up to lo, so a reversed range yields lo).
function randInt(lo, hi) {
    return lo + Math.floor(Math.random() * (Math.max(lo, hi) - lo + 1));
}
// One random element of an array (or one random char of a string — both index by .length), or "" when empty. The shared "pick one" primitive behind every random draw.
function pick(a) {
    return a && a.length ? a[Math.floor(Math.random() * a.length)] : "";
}
// A run of n chars drawn independently from pool (a string). Shared by the $num/$let/$mix filler expansion and the blog handle's digit suffix, so "a random digit run" is one implementation.
function randStr(pool, n) {
    let out = "";
    for (let i = 0; i < n; i++) out += pick(pool);
    return out;
}
// Seconds → "HH:MM:SS" (zero-padded), for the stream uptime ticker.
function formatHMS(totalS) {
    const s = Math.max(0, Math.floor(totalS));
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
// Self-rescheduling random timer: waits randRange(lo, hi) ms, fires fn(), repeats. range() is read every cycle so live setting edits apply (hi floored to lo). Returns a stop() handle. The one primitive behind the comment feed and the stream-background cycle.
function randomInterval(range, fn) {
    let timer = null;
    const tick = () => {
        const { lo, hi } = range();
        timer = window.setTimeout(() => { fn(); tick(); }, randRange(lo, Math.max(lo, hi)));
    };
    tick();
    return () => { if (timer != null) window.clearTimeout(timer); };
}
// Resolve a vault-relative path (or bare unique filename) to an image URL, or null.
function resolveSpriteUrl(app, path) {
    let file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile))
        file = app.metadataCache.getFirstLinkpathDest(path, "");
    return file instanceof TFile ? app.vault.getResourcePath(file) : null;
}
// Image extensions recognised when a path points at a folder.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const isEmoji = (s) => /^\p{Extended_Pictographic}/u.test(s);

// Emoji -> inline SVG image URL. width/height = intrinsic size (must be large; sprite capped by max-height, never upscaled). font-size vs viewBox: oversized past the box so ink reaches edges.
function emojiUrl(ch) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100"><text x="50" y="45" font-size="101" text-anchor="middle" dominant-baseline="central">${ch}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
// A path field → resolvable image URLs. Comma tells the two forms apart: no comma = a single folder path (every image inside); else comma-separated file paths. An emoji token in either form resolves to an emoji sprite.
function resolvePathList(app, paths) {
    const raw = (paths || "").trim();
    if (!raw)
        return [];
    // No comma = a single folder path (every image inside); an emoji or file path isn't a folder, so it falls through to the split branch below, which resolves the lone token.
    if (!raw.includes(",")) {
        const folder = app.vault.getAbstractFileByPath(raw);
        if (folder instanceof TFolder) {
            return folder.children
                .filter((f) => f instanceof TFile && IMAGE_EXTS.has(f.extension.toLowerCase()))
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((f) => app.vault.getResourcePath(f));
        }
    }
    return commaList(raw)
        .map((p) => isEmoji(p) ? emojiUrl(p) : resolveSpriteUrl(app, p))
        .filter((u) => u !== null);
}
// Non-repeating random picker: draws every item once before repeating; reshuffles when the queue empties or the source list changes.
class Bag {
    constructor() {
        this.queue = [];
        this.signature = null;
        this.last = null;
    }
    next(items) {
        if (!items || items.length === 0)
            return null;
        const signature = items.map((item) =>
    item && typeof item === "object" ? (item.id ?? JSON.stringify(item)) : String(item)
).join("\u0000");
        // Reshuffle on a list change or an empty queue; else keep draining.
        if (signature !== this.signature || this.queue.length === 0) {
            this.signature = signature;
            this.queue = shuffle(items.slice());
            // Don't let a fresh shuffle repeat the item we just drew.
            if (this.queue.length > 1 && this.queue[0] === this.last)
                this.queue.push(this.queue.shift());
        }
        this.last = this.queue.shift();
        return this.last;
    }
}
const VIEW_TYPE_COMPANION = "character-companion-view";
// All behavioural numbers live in styles.css as custom properties (the single source of truth); this reads them. Times are authored in ms; callers divide by 1000 for seconds.
let _tuning = null;
// tuning() returns a Proxy: t.fooBar resolves --cc-foo-bar (camelCase->kebab), cached on first read. CSS-only edit — no JS mirror to keep in sync.
function tuning() {
    if (_tuning)
        return _tuning;
    const cs = activeWindow.getComputedStyle(activeDocument.documentElement);
    const read = (k) => parseFloat(cs.getPropertyValue("--cc-" + k.replace(/([A-Z])/g, "-$1").toLowerCase()));
    // A hot reload can run this before styles.css is applied (every var reads NaN). Probe one known var; until styles land, hand back a live (uncached) reader so the next call re-reads once they do.
    if (isNaN(read("ease")))
        return new Proxy({}, { get: (_t, k) => (typeof k === "string" ? read(k) : undefined) });
    const cache = {};
    _tuning = new Proxy(cache, {
        get(target, k) {
            if (typeof k !== "string")
                return target[k];
            if (!(k in target))
                target[k] = read(k);
            return target[k];
        },
    });
    return _tuning;
}
// Total run time (ms) of the CSS animation on an element: longest duration × iteration count, read from the stylesheet. Computed duration is in seconds; a list takes the max.
function animationDurationMs(el) {
    if (!el)
        return 0;
    const cs = activeWindow.getComputedStyle(el);
    const longest = (cs.animationDuration || "0s")
        .split(",")
        .reduce((max, part) => Math.max(max, parseFloat(part) || 0), 0) * 1000;
    const iterRaw = (cs.animationIterationCount || "1").split(",")[0].trim();
    const iter = iterRaw === "infinite" ? 1 : parseFloat(iterRaw) || 1;
    return longest * iter;
}
// Build an effect from --cc-fx-<key>-* CSS descriptors (-count N, -rand n lo hi per-particle CSS vars, -steps lo hi, -wander dLo dHi xr yr sLo sHi, -layers N). Returns teardown function.
function buildEffect(anchor, key) {
    const cs = activeWindow.getComputedStyle(anchor);
    const prop = (suffix) => cs.getPropertyValue("--cc-fx-" + key + "-" + suffix).trim();
    const floats = (s) => s.split(/[\s,]+/).map(parseFloat).filter((n) => !isNaN(n));
    // -rand → [{name, lo, hi}], each rolled value landing on `--name`.
    const rand = prop("rand").split(",").map((s) => s.trim()).filter(Boolean).map((item) => {
        const [name, lo, hi] = item.split(/\s+/);
        return { name, lo: parseFloat(lo), hi: parseFloat(hi) };
    }).filter((r) => r.name && !isNaN(r.lo) && !isNaN(r.hi));
    const steps = floats(prop("steps")); // [lo, hi]
    const wander = floats(prop("wander")); // [dLo, dHi, xr, yr, sLo, sHi]
    const nodes = [];
    const anims = [];
    // Optional WAAPI random walk — a unique waypoint count per particle. Travel is % of the anchor, resolved to px at build time.
    const startWander = (el) => {
        if (steps.length < 2 || wander.length < 6)
            return;
        const [dLo, dHi, xr, yr, sLo, sHi] = wander;
        const w = anchor.clientWidth, h = anchor.clientHeight;
        const stops = Math.round(randRange(steps[0], steps[1]));
        const frames = [];
        for (let i = 0; i <= stops; i++) {
            const x = (Math.random() * 2 - 1) * (xr / 100) * w;
            const y = (Math.random() * 2 - 1) * (yr / 100) * h;
            frames.push({ transform: `translate(${x}px, ${y}px) scale(${randRange(sLo, sHi)})` });
        }
        anims.push(el.animate(frames, {
            duration: randRange(dLo, dHi) * 1000,
            iterations: Infinity,
            direction: "alternate",
            easing: "ease",
        }));
    };
    // Particles: N children, each with its own rolled vars and drift path.
    for (let i = 0, n = parseInt(prop("count"), 10); i < n; i++) {
        const el = anchor.createDiv({ cls: "cc-fx-particle cc-fx-" + key + "-particle" });
        for (const r of rand)
            el.setCssProps({ ["--" + r.name]: String(randRange(r.lo, r.hi)) });
        startWander(el);
        nodes.push(el);
    }
    // Singleton overlay layers, each styled individually. NaN when undeclared → skipped.
    for (let i = 0, n = parseInt(prop("layers"), 10); i < n; i++)
        nodes.push(anchor.createDiv({ cls: "cc-fx-layer cc-fx-" + key + "-layer cc-fx-" + key + "-layer-" + i }));
    // Teardown (effects rebuild fresh on refocus, so this suffices).
    return () => {
        for (const a of anims)
            a.cancel();
        for (const n of nodes)
            n.remove();
    };
}
// Stop a sprite's animation: cancel the pending end timer and strip the behaviour class (which drops the sprite back to its transform rest — see styles.css).
function stopAnimation(imgEl) {
    if (!imgEl)
        return;
    if (imgEl.__ccAnimTimer != null) {
        window.clearTimeout(imgEl.__ccAnimTimer);
        imgEl.__ccAnimTimer = null;
    }
    imgEl.classList.remove(...CLEARABLE);
}
// Play an animation spec (an ANIMATIONS row or { name }) on a sprite's image: stop any in-flight one first, apply `cc-anim-<spec.name>`. onEnd fires off a timer sized from the CSS duration (animationend is unreliable for custom-property animations).
function playAnimation(imgEl, spec, onEnd) {
    if (!imgEl) {
        if (onEnd)
            onEnd();
        return;
    }
    stopAnimation(imgEl);
    // Reflow so re-adding the same class restarts its animation.
    void imgEl.offsetWidth;
    // Maybe reverse this round's horizontal motion via --cc-dir (negates movement only, never mirrors artwork).
    if (spec.directional)
        imgEl.setCssProps({ "--cc-dir": Math.random() < 0.5 ? "-1" : "1" });
    imgEl.classList.add("cc-anim-" + spec.name);
    imgEl.__ccAnimTimer = window.setTimeout(() => {
        imgEl.__ccAnimTimer = null;
        stopAnimation(imgEl);
        if (onEnd)
            onEnd();
    }, animationDurationMs(imgEl));
}
// A role's enabled animations, optionally limited to the walker-safe subset (root:false keeps a move off the floor).
function enabledList(settings, role, rootOnly) {
    const pool = ANIM_POOLS[role];
    return pool.all.filter((a) => (!rootOnly || ANIM_BY_NAME[a].root !== false) && settings[pool.flag][a]);
}
// Run fn as soon as styles.css has landed (tuning() resolves a real number), retrying on rAF until then. Every surface that reads --cc-* numbers at build time (panel render, stage mount) waits behind this, or a hot reload builds it unstyled and it animates into place as the rules arrive.
function whenStyled(fn) {
    if (!isNaN(tuning().ease)) {
        fn();
        return;
    }
    window.requestAnimationFrame(() => whenStyled(fn));
}
// True only while this app window is foreground and focused — when the loops should run.
function appActive() {
    return activeDocument.visibilityState !== "hidden" && activeDocument.hasFocus();
}
// Best-effort pointer capture (throws if unavailable/already released); swallow so every grab/drag site stays a one-liner.
function capturePointer(el, id) {
    try {
        el.setPointerCapture(id);
    }
    catch { /* unavailable or already captured — fine */ }
}
function releasePointer(el, id) {
    try {
        el.releasePointerCapture(id);
    }
    catch { /* already released — fine */ }
}
// Fraction (0–1 of natural height) of transparent rows atop a sprite — the gap from image top down to the first coloured pixel. Measured once per URL on an off-screen canvas (vault sprites are same-origin app:// resources, so untainted) and cached (holds the pending Promise while measuring, then the number); blank/unreadable resolves 0. A walker scales it by rendered height to lift the bubble onto the artwork, not the empty box top.
const _spriteInsetCache = new Map();
function spriteTopInsetFraction(url) {
    if (!url)
        return Promise.resolve(0);
    const cached = _spriteInsetCache.get(url);
    if (cached !== undefined)
        return Promise.resolve(cached);
    const p = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let frac = 0;
            try {
                const w = img.naturalWidth, h = img.naturalHeight;
                const canvas = activeDocument.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                ctx.drawImage(img, 0, 0);
                const data = ctx.getImageData(0, 0, w, h).data;
                // `|| 0` guards a pre-styles NaN read: without it every `alpha > NaN` is false, every row reads transparent, and frac would be a pathological 1. Threshold 0 (first row with any non-zero alpha) is a sane fallback.
                const minAlpha = (tuning().bubbleInsetAlpha || 0) * 255;
                let row = 0;
                for (; row < h; row++) {
                    let opaque = false;
                    for (let x = 0; x < w; x++) {
                        if (data[(row * w + x) * 4 + 3] > minAlpha) { opaque = true; break; }
                    }
                    if (opaque)
                        break;
                }
                frac = h > 0 ? row / h : 0;
            }
            catch { frac = 0; }
            _spriteInsetCache.set(url, frac);
            resolve(frac);
        };
        img.onerror = () => { _spriteInsetCache.set(url, 0); resolve(0); };
        img.src = url;
    });
    _spriteInsetCache.set(url, p);
    return p;
}
// Split a quote into the sentences a walker reveals as consecutive bubbles (quoteTypewriter only). Scans runs of terminators and closes a sentence only where terminatorBreaks says so. A merge pass folds runs shorter than --cc-quote-min-words words together, so a burst like "Whoa! Whoa! Whoa!" reads as one. Pure/static: unit-testable headless (pass an explicit min via mergeShortSentences).
function splitQuote(text) {
    const s = (text || "").replace(/\.{2,}/g, "…").trim();
    if (!s)
        return [];
    const frags = [];
    let start = 0;
    const re = /[.!?…]+/g;
    let m;
    while ((m = re.exec(s))) {
        const end = m.index + m[0].length;
        if (terminatorBreaks(s, m.index, m[0], end)) {
            // Keep a closing quote/bracket sitting right on the terminator with its own sentence, so "hi." doesn't strand the " onto the next bubble.
            let e = end;
            while (e < s.length && /['"”’»)\]]/.test(s[e])) e++;
            frags.push(s.slice(start, e).trim());
            start = e;
        }
    }
    if (start < s.length) {
        const tail = s.slice(start).trim();
        if (tail) frags.push(tail);
    }
    return mergeShortSentences(frags, tuning().quoteMinWords);
}
// Does the terminator run `run` at [i, end) close the current sentence? ! and ? always do. An ellipsis closes only as a *trailing* mark before a capitalised word. A lone period closes unless it is an abbreviation: an internal dot ("3.5", "google.com"), a known honorific ("Dr.", "Mr."), or an internal initialism dot ("U.S."). Sentence-ending initialisms ("U.F.O.") are allowed to break if followed by a new sentence.
function terminatorBreaks(s, i, run, end) {
    if (/[!?]/.test(run)) {
        let j = end;
        while (j < s.length && /['"“‘«)\]]/.test(s[j])) j++;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (j < s.length && /\p{Ll}/u.test(s[j])) return false;
        return true;
    }
    if (run.includes("…")) {
        if (i === 0 || /\s/.test(s[i - 1])) return false;
        let j = end;
        while (j < s.length && /\s/.test(s[j])) j++;
        while (j < s.length && s[j] === "…") { j++; while (j < s.length && /\s/.test(s[j])) j++; }
        if (j < s.length && /['"“‘«(]/.test(s[j])) j++;
        return j >= s.length || /\p{Lu}/u.test(s[j]);
    }
    if (/[\p{L}\p{N}]/u.test(s[end] || "")) return false;
    const prevMatch = s.slice(0, i).match(/[\p{L}]+$/u);
    const prevWord = prevMatch ? prevMatch[0] : "";
    const abbreviations = new Set(["mr", "mrs", "ms", "mx", "dr", "prof", "rev", "capt", "gen", "col", "maj", "sgt", "st", "mt", "lt", "cmdr", "gov", "sen", "rep", "jr", "sr", "etc", "vs", "al", "approx", "ave", "blvd", "dept", "est", "inc", "misc"]);
    if (abbreviations.has(prevWord.toLowerCase())) return false;
    if (prevWord.length === 1) {
        let j = end;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (j < s.length && /['"“‘«(]/.test(s[j])) j++;    
        if (/\p{Ll}/u.test(s[j] || "")) return false;
        if (s.slice(j).match(/^\p{Lu}\./u)) return false;
        return true;
    }
    return true;
}
// Fold fragments shorter than `min` words forward into the next, so no bubble is a stray one- or two-word burst; a leftover short tail attaches to the previous fragment. Exception: a fragment that trails off with a sentence-final … ("Hey…") is a deliberate beat, not a stray burst, so it always flushes on its own even when short.
function mergeShortSentences(frags, min) {
    const out = [];
    let buf = "";
    for (const f of frags) {
        buf = buf ? buf + " " + f : f;
        if (buf.split(/\s+/).filter(Boolean).length >= min || /…["'”’»)\]]*$/.test(buf)) {
            out.push(buf);
            buf = "";
        }
    }
    if (buf)
        out.length ? (out[out.length - 1] += " " + buf) : out.push(buf);
    return out;
}
/* ---------------- root stage: walker + stage ---------------- */
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
// Shared window-cursor tracker: latest pointer position (x = -1 outside the window) plus the tickle detector (quick horizontal reversals of a free cursor). Self-contained.
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
        if (gliding) { window.clearTimeout(this.easeTimer); this.easeTimer = null; }
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
        this.easeTimer = window.setTimeout(() => {
            this.endEase();
            if (then)
                then();
        }, tuning().ease);
    }
    // End the ease now — drop any pending ease timer and strip the eased state (both cc-eased classes and the frozen inline pose) so nothing smooths (or later snaps) a value-driven frame. The timer's own tail AND the cut-short for every early exit (full teardown, drop release); a no-op when nothing is easing.
    endEase() {
        if (this.easeTimer) { window.clearTimeout(this.easeTimer); this.easeTimer = null; }
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
        this.actTimers.push(window.setTimeout(() => {
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
            window.clearTimeout(id);
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
        if (this.bubbleTimer) { window.clearTimeout(this.bubbleTimer); this.bubbleTimer = null; }
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
            this.actTimers.push(window.setTimeout(count >= total ? done : bout, interval));
        };
        bout();
    }
    // HELD activity: an escape attempt. Without the escape toggle, hold for the window then loop back to shaking. With it, break free if the pointer is still (one shake, then released to drop); if still dragging, the escape fails.
    holdEscape(done) {
        const T = tuning();
        if (!this.character.escape) {
            this.actTimers.push(window.setTimeout(done, T.escapeStillWindow));
            return;
        }
        this.actTimers.push(window.setTimeout(() => {
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
            this.actTimers.push(window.setTimeout(() => act.play(this), delay));
        }
        // End the window: a mover walks, a 0-speed sprite re-rests. A fidget that animates first cancels this through easeToward; otherwise it fires here.
        this.actTimers.push(window.setTimeout(() => this.beginWalk(), windowMs));
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
    // Speak one of the character's lines through the one bubble. With quoteTypewriter "slow"/"fast", split into sentences typed out consecutively (the CommentFeed "push a part" idea, but sequential — one held at a time, not stacked); "off", the whole line is one chunk shown at once. No-op with no bubble/nothing to say; a blank/punctuation-only line yields no chunks and is skipped.
    speak() {
        const quotes = this.character.quotes;
        if (!this.bubbleEl || quotes.length === 0)
            return;
        this.clearBubbleTimer();
        const line = this.quoteBag.next(quotes);
        const chunks = this.settings.quoteTypewriter !== "off" ? splitQuote(line) : [line.trim()].filter(Boolean);
        if (chunks.length === 0)
            return;
        this.positionBubble();
        this.bubbleEl.addClass("cc-bubble-visible");
        this.playChunk(chunks, 0);
    }
    // Reveal chunk `idx` (typed out when streaming, dropped in whole when not), hold it for its length-scaled duration (see quoteHoldMs), then advance to the next chunk or hide after the last. Each chunk holds for its own content, so a multi-sentence stream runs proportionally longer.
    playChunk(chunks, idx) {
        const hold = () => {
            this.bubbleTimer = window.setTimeout(() => {
                if (idx + 1 < chunks.length)
                    this.playChunk(chunks, idx + 1);
                else
                    this.bubbleEl.removeClass("cc-bubble-visible");
            }, this.quoteHoldMs(chunks[idx]));
        };
        if (this.settings.quoteTypewriter !== "off")
            this.typeOut(chunks[idx], this.wrapBreaks(chunks[idx]), 0, hold);
        else { this.bubbleEl.setText(chunks[idx]); hold(); }
    }
    // How long a fully-revealed bubble holds, scaled to its content so short lines clear sooner and long (wrapped) ones linger. The quoteDurationMs SETTING is spent over exactly one full line: chars-per-full-line = bubble max-width ÷ avg glyph width (--cc-quote-char-em × the bubble's own font-size, so it tracks max-width and theme scale), and the per-char rate falls out as setting ÷ that. Floored at --cc-quote-hold-min so a one-word burst still registers. Shared by both surfaces and both typewriter states.
    quoteHoldMs(text) {
        const T = tuning();
        const fontPx = parseFloat(activeWindow.getComputedStyle(this.bubbleEl).fontSize) || 13;
        const charsPerLine = T.bubbleMaxWidth / (fontPx * T.quoteCharEm);
        const perChar = this.settings.quoteDurationMs / charsPerLine;
        return Math.max(T.quoteHoldMin, perChar * text.length);
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
        this.bubbleTimer = window.setTimeout(() => this.typeOut(text, breaks, i + 1, done), delay);
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
        this.bubbleEl.style.left = (r.left + r.width / 2) + "px";
        // Gap is a fraction of this surface's sprite max-height (sidebar-only path — the floor bubble is CSS-positioned), keeping the float proportional across the two heights.
        const gap = tuning().bubbleGap * this.settings.sidebarSpriteMaxHeight;
        const inset = parseFloat(this.wrapEl.style.getPropertyValue("--cc-bubble-inset")) || 0;
        this.bubbleEl.style.bottom = (activeWindow.innerHeight - r.top - inset + gap) + "px";
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
        this.actTimers.push(window.setTimeout(() => this.runActivities(HELD_ACTIVITIES, true), T.holdStart));
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
// One overlay pinned to the bottom of the window, holding a Walker per root-enabled character. Owns the collection, the frame loop, the shared cursor, and everything relating walkers to each other (z-layering, rest-overlap, cursor band).
class CompanionStage {
    constructor(plugin) {
        this.plugin = plugin;
        this.stageEl = null;
        this.walkers = new Map();
        this.raf = null;
        this.lastFrame = null;
        this.cursor = new Cursor((x, y) => this.tickleWalkerAt(x, y));
        // One idle + one surprise bag shared by the troupe (cycles each pool without repeats); images and quotes stay per-walker.
        this.idleBag = new Bag();
        this.surpriseBag = new Bag();
        // Overlapping walker pairs already z-ordered; an isolated crossing re-rolls a pair.
        this.layered = new Set();
        this.tick = this.tick.bind(this);
    }
    mount() {
        if (this.stageEl)
            return;
        this.stageEl = activeDocument.body.createDiv({ cls: "cc-root-stage" });
        this.plugin.registerDomEvent(activeWindow, "resize", () => this.onResize());
        this.plugin.registerDomEvent(activeWindow, "pointermove", (e) => this.cursor.move(e));
        this.plugin.registerDomEvent(activeDocument.documentElement, "pointerleave", () => this.cursor.leave());
        this.refresh();
        // Run only while Obsidian is the focused, visible app.
        this.plugin.registerDomEvent(activeWindow, "blur", () => this.sync());
        this.plugin.registerDomEvent(activeWindow, "focus", () => this.sync());
        this.plugin.registerDomEvent(activeDocument, "visibilitychange", () => this.sync());
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
    // Stop the frame loop and clear every walker's pending timer; in-flight CSS animations finish on their own, nothing new starts.
    pause() {
        if (this.raf !== null) {
            window.cancelAnimationFrame(this.raf);
            this.raf = null;
        }
        this.lastFrame = null;
        for (const w of this.walkers.values())
            w.pauseRest();
    }
    // Restart the loop (lastFrame null, so tick re-seeds and skips the first dt — no jump after a long pause). Re-arm any resting walker, whose window timer pause cleared.
    resume() {
        if (this.raf === null)
            this.raf = window.requestAnimationFrame(this.tick);
        for (const w of this.walkers.values())
            if (w.mode === MODE.REST)
                w.beginRest();
    }
    sync() {
        if (appActive())
            this.resume();
        else
            this.pause();
    }
    // Remove a walker: stop its timers and drop any layering pair naming it, so a future id can't match a stale crossing.
    destroyWalker(w) {
        w.destroy();
        for (const o of this.walkers.values())
            this.layered.delete(this.pairKey(w, o));
    }
    // Reconcile walkers against current settings without disturbing the ones that stay, so an unrelated edit never resets positions.
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
            w.speed = speed;
            if (urls.length === 0) {
                this.destroyWalker(w);
                this.walkers.delete(c.id);
                changed = true;
                continue;
            }
            w.spriteUrls = urls;
            // An unchanged path list keeps the current picture (its src is in the list); a changed one re-picks only when it must.
            if (!urls.includes(w.imgEl.src))
                w.setSprite(w.spriteBag.next(urls));
        }
        // Re-deal stacking depth only on a cast change, so a slider tweak doesn't reshuffle who's in front.
        if (changed)
            this.shuffleLayers();
    }
    createWalker(character, urls, speed) {
        const wrap = this.stageEl.createDiv({ cls: "cc-walker" });
        const img = wrap.createEl("img", { cls: "cc-sprite" });
        // Bubble rides above the sprite's head; positioned in styles.css.
        const bubble = wrap.createDiv({ cls: "cc-bubble" });
        const w = new Walker(this, this.plugin, character, { wrapEl: wrap, imgEl: img, bubbleEl: bubble }, urls, speed);
        // Provisional top rank; shuffleLayers re-deals on refresh, crossings re-roll.
        this.bringToFront(w);
        w.place();
        // Arm its rest cycle: rest ends on a window timer, so a fresh walker needs one planted (resume() does this after a pause; this is the create path).
        w.beginRest();
        return w;
    }
    tick(now) {
        this.raf = window.requestAnimationFrame(this.tick);
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
    // True when two walkers' bodies intersect within `frac` of their combined half-widths. Shared by rest-overlap resolution and z-order layering.
    overlap(a, b, frac) {
        return Math.abs(a.x - b.x) < (a.halfWidth + b.halfWidth) * frac;
    }
    // Canonical key for an unordered walker pair (id order); reused for stale eviction.
    pairKey(a, b) {
        return a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
    }
    // Decide stacking order when two walkers begin to overlap, so neither is permanently in front. Once per crossing (the frame they first meet), re-roll only if the pair is alone (no third walker touching either); the pair is forgotten when they part.
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
    // Assign a walker a stacking rank and mirror it to the DOM (--cc-z, consumed by .cc-walker's z-index). Ranks are a compact 1..N.
    setZ(w, z) {
        w.z = z;
        w.wrapEl.setCssProps({ "--cc-z": String(z) });
    }
    // Raise a walker to the top, others keeping their relative order (renumbered 1..n-1 by current rank, this one takes rank n). A fresh walker isn't in the map yet → lands on top.
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
    // Play the quick tickle giggle on the walker under the point, if any (skip one held, dropping, or mid committed reaction).
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
    // Two resting walkers in the same spot: one steps aside (default the newcomer; with its "assert" toggle the occupant is shoved). The mover walks the minimum to clear the overlap. Returns whether `w` is the mover.
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
    // Top of the floor strip the walkers occupy. Shared by cursor-react and tickle.
    stageTop() {
        return activeWindow.innerHeight - this.plugin.settings.rootSpriteMaxHeight;
    }
    // The horizontal band (px) a walker may rest within. Shared by settle, resize, placement.
    restBand() {
        const T = tuning();
        const width = activeWindow.innerWidth;
        return { lo: T.restBandLo * width, hi: T.restBandHi * width };
    }
    // A shrunk window can strand a walker off-screen; pull any such back inside the band.
    onResize() {
        const { lo, hi } = this.restBand();
        for (const w of this.walkers.values()) {
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
/* ---------------- comment feed ---------------- */
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
// Chat overlay: fixed element pinned to root-split corner nearest the panel. Owns no timer/content — exposes push() for independent sources. Newest at corner, older bump away.
class CommentFeed {
    constructor(view) {
        this.view = view;
        this.plugin = view.plugin;
        this.el = null;
    }
    get settings() { return this.plugin.settings; }
    // The feed exists only while a source wants it; torn down (not preserved) when the panel goes away, rebuilt fresh on return.
    mount() {
        if (this.el)
            return;
        this.el = activeDocument.body.createDiv({ cls: "cc-feed" });
        this.applyFont();
        this.reposition();
    }
    // Override the shared --cc-stream-font on the bubbles when the user set a comment font (verbatim CSS font-family); empty clears back to the styles.css default. Bubbles inherit the property from the feed root. Re-run live from applyChange's repaint on a settings edit.
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
        const root = activeDocument.querySelector(".workspace-split.mod-root");
        const rect = (root ?? activeDocument.body).getBoundingClientRect();
        const panel = this.view.contentEl.getBoundingClientRect();
        const left = panel.left + panel.width / 2 < activeWindow.innerWidth / 2;
        const top = panel.top + panel.height / 2 < activeWindow.innerHeight / 2;
        this.el.classList.toggle("cc-feed-left", left);
        this.el.classList.toggle("cc-feed-right", !left);
        this.el.classList.toggle("cc-feed-top", top);
        this.el.classList.toggle("cc-feed-bottom", !top);
        this.el.setCssProps({
            "--cc-feed-x": (left ? rect.left : activeWindow.innerWidth - rect.right) + "px",
            "--cc-feed-y": (top ? rect.top : activeWindow.innerHeight - rect.bottom) + "px",
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
/* ---------------- RiScript engine (shared) ---------------- */
// {name: [...]} → {name: "[a | b | c]"} RiScript choice rules (skipping empties). One single-item list stays a literal "[a]", which RiScript handles fine. Shared by Oracle (constants / VIP variables) and stream (per-set variables + the $deed/$topic character lists).
function choiceRules(map) {
    const out = {};
    for (const k of Object.keys(map || {})) {
        const a = (map[k] || []).filter((x) => typeof x === "string" && x.trim());
        if (a.length) out[k] = "[" + a.join(" | ") + "]";
    }
    return out;
}
// Shared RiScript evaluator: lazy-loads RiTa + compromise, owns verb transforms + lexicon fillers. One engine for both Oracle and stream. Desktop-only.
// Pre-pass random-string fillers for codenames/handles (e.g. $<kind><lo-hi>). Case and distribution are baked into the character pools to avoid per-letter calculations.
const _lc = "abcdefghijklmnopqrstuvwxyz", _uc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", _dg = "0123456789";
// 'mix' repeats _dg to give digits ~28% weight (tune by repeating _dg more/fewer times).
const RAND_CHARS = {
    num: _dg,
    let: _lc + _uc, "let-lower": _lc, "let-upper": _uc,
    mix: _lc + _uc + _dg + _dg, "mix-lower": _lc + _dg, "mix-upper": _uc + _dg,
};
// $kind<lo> or $kind<lo-hi>, kind = num | let | mix, each letter kind with an optional -lower/-upper suffix.
const RAND_TOKEN = /\$((?:let|mix)(?:-lower|-upper)?|num)<\s*(\d+)\s*(?:-\s*(\d+)\s*)?>/gi;
class RiScriptEngine {
    constructor(plugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        this.RiTa = null;
        this.nlp = null;
        this.loaded = false;
        this.loadFailed = false;
        this.transforms = null;
    }
    // Load RiTa + compromise once (latches on failure). The FIRST failing call throws so the caller can Notice in its own wording (Oracle vs stream); once latched it just returns false. RiTa powers RiScript-the-grammar + the generic() lexicon fillers; compromise backs the inflection transforms. require() caches, so Oracle's own compromise load shares this module instance at no extra cost.
    async ensure() {
        if (this.loaded) return true;
        if (this.loadFailed) return false;
        try {
            // RiTa's vendored build is a browser IIFE assigning the bare global `RiTa`; the build wraps it in `__ccLoadRita` (see esbuild.config.mjs) so its 1.5 MB only parses+runs HERE, on first engine use, never at plugin load. compromise/whichx are require()d, which esbuild likewise defers to the first call. The typeof guard keeps the unbundled source loadable in headless smoke tests.
            this.RiTa = window.RiTa || (typeof __ccLoadRita === "function" ? __ccLoadRita() : null);
            this.nlp = require("../lib/compromise.js");
            if (!this.RiTa) throw new Error("RiTa missing");
            if (!this.nlp) throw new Error("compromise missing");
            this.transforms = this.buildTransforms();
            this.loaded = true;
            return true;
        }
        catch (e) { this.loadFailed = true; throw e; }
    }
    // Custom RiScript transforms every template can call on a verb-initial phrase. compromise conjugates the HEAD verb and keeps the tail, whole-phrase and irregular-aware ("catch a pokemon" → "caught a pokemon", "see the past" → "saw the past"). It locates + swaps the head itself (no manual string splitting); one .conjugate() call exposes every tense, so a single word is just the tailless case. We force-tag the head as a verb first because compromise's tagger misses bare imperatives ("free all X") without sentence context; a non-verb / missing form returns the phrase unchanged. .ed() → simple past  .ing() → gerund  .s() → 3rd-person sg  .fut() → future
    buildTransforms() {
        const nlp = this.nlp;
        const conj = (phrase, form) => {
            const s = String(phrase).trim();
            if (!s) return s;
            const doc = nlp(s);
            doc.match("^.").tag("Verb");            // force the head to a verb (fixes bare imperatives)
            const forms = doc.verbs().conjugate()[0];
            const w = forms && forms[form];
            if (!w) return doc.text();              // non-verb / no such form → unchanged
            doc.match("^.").replaceWith(w);
            return doc.text();
        };
        return {
            ed: (w) => conj(w, "PastTense"),
            ing: (w) => conj(w, "Gerund"),
            s: (w) => conj(w, "PresentTense"),
            fut: (w) => conj(w, "FutureTense"),
        };
    }
    // One random lexicon word matching `opts` (RiTa.randomWord options: pos / syllables / …), or `def` when randomWord returns falsy or throws (so a caller never gets an empty word). The shared per-draw primitive behind generic()'s fillers and randomHandle()'s word patterns — each call is an independent draw.
    lexWord(opts, def) {
        try { return this.RiTa.randomWord(opts) || def; }
        catch { return def; }
    }
    // Generic lexicon fillers, evaluated per line. $rndGrand is constrained to a 3-syllable adjective for varied vocabulary.
    generic() {
        return {
            rndAdj: this.lexWord({ pos: "jj" }, "strange"),
            rndNoun: this.lexWord({ pos: "nn" }, "thing"),
            rndVerb: this.lexWord({ pos: "vb" }, "stir"),
            rnd: this.lexWord({}, "thing"),
            rndGrand: this.lexWord({ pos: "jj", syllables: 3 }, "magnificent"),
        };
    }
    // Generate a random microblog @handle (used when a blog line names no author), returned WITHOUT the leading "@". One of four word patterns — verb+noun, adj+noun, noun+noun, or a single word — each part an independent capped draw, joined PascalCase ("FerrisWheel"). Then two INDEPENDENT rolls (both CSS tuning knobs): an all-lowercase pass and a trailing 1–N digit run, so "ferriswheel", "FerrisWheel42", and "ferriswheel7" are all reachable. Needs the lexicon loaded for variety; callers skip a handle-less beat until it is.
    randomHandle() {
        const t = tuning();
        const cap = (s) => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
        // Every part is length-capped (maxLength).
        const word = (pos, def) => this.lexWord(pos ? { pos, maxLength: t.blogHandleMaxLen } : { maxLength: t.blogHandleMaxLen }, def);
        const patterns = [
            () => [word("vb", "stir"), word("nn", "thing")],
            () => [word("jj", "strange"), word("nn", "thing")],
            () => [word("nn", "thing"), word("nn", "stuff")],
            () => [word(null, "someone")],
        ];
        let name = pick(patterns)().map(cap).join("");
        if (Math.random() < t.blogHandleLowerChance) name = name.toLowerCase();
        // Trailing digit run shares the $num filler's pool (RAND_CHARS.num) and draw, so "a random digit suffix" is one implementation.
        if (Math.random() < t.blogHandleDigitChance)
            name += randStr(RAND_CHARS.num, randInt(t.blogHandleDigitMin, t.blogHandleDigitMax));
        return name || "someone";
    }
    // A line that references RiScript syntax ([ choices ] or $vars) can't render until RiTa loads: true means "skip this beat" so a source waits for the next rather than pushing raw $vars. A plain line (no [ or $) is always safe. Shared by the stream + mail feed sources.
    pending(line) {
        return /[[$]/.test(line) && !this.loaded;
    }
    // Expand every random-string filler ($num/$let/$mix<…>) in place — a pre-pass before the RiScript grammar (see RAND_CHARS). Each match draws lo..hi chars uniformly from its pool (case is the pool's); a missing hi means an exact length, a reversed lo-hi is swapped. $handle rides the same pre-pass: each occurrence becomes a fresh random username (two $handle = two users), resolving to the bare name — write "@$handle" for a mention — the microblog sibling of these fillers.
    expandRandom(line) {
        line = line.replace(/\$handle\b/g, () => this.randomHandle());
        return line.replace(RAND_TOKEN, (_, kind, loStr, hiStr) => {
            const lo = parseInt(loStr, 10), hi = hiStr != null ? parseInt(hiStr, 10) : lo;
            return randStr(RAND_CHARS[kind.toLowerCase()], randInt(lo, hi));
        });
    }
    // Evaluate one RiScript line against fresh generics + the shared transforms + the caller's context. Returns the raw line unchanged if RiTa isn't loaded or on a parse error, so a bad template (or a pre-load beat) can never throw out of a timer.
    evaluate(line, extra) {
        if (!this.RiTa) return line;
        const expanded = this.expandRandom(line);
        try { return this.RiTa.evaluate(expanded, Object.assign({}, this.generic(), this.transforms, extra)); }
        catch { return line; }
    }
    // evaluate() coerced to a trimmed string ("" on a null/blank result) — the shape every feed source wants for a bubble part.
    evalTrim(line, extra) {
        return (this.evaluate(line, extra) || "").trim();
    }
}
/* ---------------- Oracle mode ---------------- */
// Oracle: independent feed mode. Three message types (SYSTEM/ANON/VIP), generated locally. RiTa = grammar+inflection, compromise = lemmatise input, whichx = classify typed line to a VIP. Only VIP consults typing; others are ambient. Desktop-only, self-contained.
class Oracle {
    constructor(view) {
        this.view = view;
        this.plugin = view.plugin;
        this.app = view.app;
        // Engines (lazy): whichx is Oracle's own; RiTa/compromise are read-through getters onto the shared engine (see below). A failed load latches.
        this.WhichX = null;
        this.loaded = false; this.loadFailed = false;
        // Per-type non-repeat bags + per-VIP reaction/aside bags.
        this.sysBag = new Bag(); this.anonBag = new Bag();
        this.reactionBags = {}; this.asideBags = {};
        // Stop-handles for the three independent source timers (filled by mount).
        this.stops = [];
        // Classifier, the enabled-VIP list it was trained against (index alignment), and the freshest typed-text match { vipIndex, symbol, ts }.
        this.clf = null; this.enabledVips = [];
        this.context = null;
        this.editRef = null; this.editTimer = null;
        this.mounted = false;
    }
    get settings() { return this.plugin.settings; }
    // Authored content (templates + VIPs) is owned by the plugin (loaded once, edited in settings, shared by every view), so the Oracle always reads the live model.
    get data() { return this.plugin.oracleData; }
    // RiTa + compromise are owned by the shared RiScript engine — read through, never copied, so there's exactly one loaded instance to reason about.
    get RiTa() { return this.plugin.riscript.RiTa; }
    get nlp() { return this.plugin.riscript.nlp; }
    // Reconcile to whether Oracle should run (oracleEnabled && live). Lazy-loads on first run; a load failure latches so we don't re-prompt every sync.
    async sync(want) {
        if (want) {
            if (this.loadFailed) return;
            if (!this.loaded) {
                const ok = await this.ensure();
                if (!ok || !this.settings.oracleEnabled || !this.view.isLive()) return;
            }
            this.mount();
        }
        else {
            this.unmount();
        }
    }
    // --- lazy engine load (desktop only), the Oracle sibling of riscript.ensure() ---
    async ensure() {
        if (this.loaded) return true;
        try {
            // RiTa + compromise come off the shared engine (loaded once, reused by stream/mail; the getters above read them through); whichx is Oracle's own classifier, required on top.
            if (!(await this.plugin.riscript.ensure()))
                throw new Error("engine unavailable");
            this.WhichX = require("../lib/whichx.js");
            if (!this.WhichX)
                throw new Error("whichx missing");
            this.loaded = true;
            this.rebuild();
            return true;
        }
        catch (e) {
            this.loadFailed = true;
            new Notice("Character Companion: Oracle mode needs its engine files in the plugin's lib/ folder (desktop only) — see lib/README.md. (" + e.message + ")", 8000);
            return false;
        }
    }
    // Rebuild derived state after a content/setting edit: snapshot the enabled VIPs (so the classifier's labels stay index-aligned), retrain whichx on each one's lemmatised topic bank (vars.topic), and precompute the shared constant choice-rules. Cheap — safe to call on every save. A stale typed-context is dropped.
    rebuild() {
        if (!this.loaded) return;
        this.reactionBags = {}; this.asideBags = {};
        this.enabledVips = this.data.vips.filter((v) => v.enabled);
        this.clf = new this.WhichX();
        if (this.enabledVips.length) {
            this.clf.addLabels(this.enabledVips.map((_, i) => "v" + i));
            this.enabledVips.forEach((v, i) => {
                const flat = this.syms(v).join(" ");
                const doc = this.lemma(flat) || flat;
                if (doc.trim()) this.clf.addData("v" + i, doc);
            });
        }
        // The line-invariant half of every template's context: the shared constant choice-rules (fixed until the next rebuild). The verb transforms + generic() are injected by the shared engine's evaluate(), so this is just the constants now.
        this.staticCtx = choiceRules(this.data.constants);
        this.context = null;
    }
    // --- lifecycle ---
    mount() {
        if (this.mounted) return;
        this.mounted = true;
        // Three independent timers — none waits on or blocks the others. SYSTEM and ANON share pushPlain (a bag-drawn template + patron vars); VIP is its own typing-aware beat.
        const beats = [
            ["Sys", () => this.pushPlain(this.sysBag, this.data.sysTemplates, "cc-feed-bubble-sys")],
            ["Anon", () => this.pushPlain(this.anonBag, this.data.anonTemplates, "cc-feed-bubble-anon")],
            ["Vip", () => this.pushVip()],
        ];
        this.stops = beats.map(([kind, fire]) => randomInterval(() => this.range(kind), fire));
        // React to typing (debounced); only VIP consults it.
        this.editRef = this.app.workspace.on("editor-change", (editor) => this.onEdit(editor));
    }
    unmount() {
        this.mounted = false;
        this.stops.forEach((stop) => stop());
        this.stops = [];
        if (this.editRef) { this.app.workspace.offref(this.editRef); this.editRef = null; }
        if (this.editTimer != null) { window.clearTimeout(this.editTimer); this.editTimer = null; }
        this.context = null;
    }
    range(kind) {
        return { lo: this.settings["oracle" + kind + "MinMs"], hi: this.settings["oracle" + kind + "MaxMs"] };
    }
    // --- helpers --- Lemmatise to root forms (lower-cased) so Symbols/typed text match across inflections.
    lemma(s) {
        try { const d = this.nlp(s); d.compute("root"); return d.text("root").toLowerCase(); }
        catch { return (s || "").toLowerCase(); }
    }
    // Last salient typed word (>2 letters, alphabetic), base-formed by compromise pipe. Noun or gerund for $topic slot.
    lastTyped(text, pipe) {
        try {
            const out = [];
            for (const ph of pipe(this.nlp(text || "")).out("array"))
                for (const w of String(ph).toLowerCase().split(/\s+/))
                    if (w.length > 2 && /^[a-z]+$/.test(w)) out.push(w);
            return out.length ? out[out.length - 1] : "";
        }
        catch { return ""; }
    }
    // A VIP's match-list: the reserved `topic` variable in its vars map (see VIP_SCHEMA). Feeds classifier training, typed-word matching, and the ambient $topic fallback.
    syms(vip) { return (vip.vars && vip.vars.topic) || []; }
    // Make a word read as a noun for the $topic slot: a bare verb → its gerund ("kill"→"killing", "hunt"→"hunting"), any real noun left untouched. Natural compromise tagging decides (no force-tag), so nouns like "moon" aren't verbed; the auxiliary compromise prepends ("is killing") is stripped. The single choke point for every $topic source — typed word or `topic`-bank pick alike — so verbs echo consistently wherever they live.
    nounify(word) {
        const w = String(word || "").trim();
        try { const g = this.nlp(w).verbs().toGerund().out("array"); if (g.length) return g[0].replace(/^(?:is|are|am)\s+/i, ""); }
        catch { /* tagging failed - fall through to the raw word */ }
        return w;
    }
    // One { singular, plural } patron draw from the comma-separated patron-name field. An optional custom plural comes from "Name (Plural)" brackets, else RiTa derives it; an empty field falls back to ORACLE_PATRON_FALLBACK.
    drawPatron() {
        const pool = commaList(this.settings.oraclePatronName).map((item) => {
            const m = item.match(/^(.*?)\s*\((.+?)\)\s*$/);
            const singular = m ? m[1].trim() : item;
            return { singular, plural: m ? m[2].trim() : this.RiTa.pluralize(singular) };
        });
        return pool.length > 0 ? pick(pool)
            : { singular: ORACLE_PATRON_FALLBACK, plural: this.RiTa.pluralize(ORACLE_PATRON_FALLBACK) };
    }
    // Evaluate one RiScript line through the shared engine (which injects fresh generic fillers + the phrase-head transforms), layering Oracle's precomputed staticCtx (shared constants) and the caller's per-line `extra` (sys/patron/topic, VIP variables) on top.
    evaluate(line, extra) {
        return this.plugin.riscript.evaluate(line, Object.assign({}, this.staticCtx, extra));
    }
    // Push a finished line, guaranteeing terminal punctuation (so templates needn't all end in a period). Leaves an existing . ! ? … (incl. a trailing closing quote/bracket) untouched.
    emit(text, cls) {
        const s = (text || "").trim();
        if (!s) return;
        this.view.feed.push(/[.!?…][)"'”’\]]?$/.test(s) ? s : s + ".", cls);
    }
    // --- generators (the timer entry points) --- SYSTEM and ANON differ only by bag, template list, and bubble class: one bag-drawn template evaluated with the patron + sys vars. (VIP is its own typing-aware beat below.)
    pushPlain(bag, templates, cls) {
        const line = bag.next(templates);
        if (!line) return;
        const p = this.drawPatron();
        this.emit(this.evaluate(line, { system: this.settings.oracleSystemName || ORACLE_SYS_FALLBACK, patron: p.singular, patrons: p.plural }), cls);
    }
    pushVip() {
        if (!this.enabledVips.length) return;
        // Beat-only: react to a fresh typed context (within the react window) if there is one, else an ambient VIP. Either way the VIP's own match-list (vars.topic) fills $topic if the context left it empty, so the echo never runs dry.
        const ctx = this.context && Date.now() - this.context.ts <= tuning().oracleReactWindow ? this.context : null;
        const vip = (ctx && this.enabledVips[ctx.vipIndex]) || pick(this.enabledVips);
        if (!vip.reactions.length) return;
        const topic = this.nounify((ctx && ctx.topic) || pick(this.syms(vip)));
        const patron = vip.origin || this.drawPatron().singular;
        // This VIP's variables ($verb/$manner/…) + per-line vars (frames also reach the shared constants/transforms via evaluate). Reused across sentences — evaluate never mutates it. `topic` is assigned AFTER choiceRules so the beat's chosen echo wins over the raw vars.topic choice-rule (which would otherwise re-pick per reference).
        const vipCtx = Object.assign(choiceRules(vip.vars), { patron, modifier: vip.modifier || vip.name, topic });
        // Sentence 1 carries the prefix; follow-ups are bare asides (per the requested examples). Patron and modifier are already resolved plain strings, so the prefix is built in JS with the quoted modifier wrapped by feedSpan (rendered as .cc-feed-modifier); only the reaction needs the engine. They stay in vipCtx too, so a reaction that references $patron/$modifier still resolves.
        const reaction = this.evaluate((this.reactionBags[vip.name] ??= new Bag()).next(vip.reactions), vipCtx);
        let line = `The ${patron} ${feedSpan(`"${vipCtx.modifier}"`)} ${reaction}.`;
        if (vip.asides.length) {
            const r = Math.random(), t = tuning();
            const aside = () => " " + this.evaluate((this.asideBags[vip.name] ??= new Bag()).next(vip.asides), vipCtx);
            if (r < t.oracleAside2Chance) line += aside();
            if (r < t.oracleAside3Chance) line += aside();
        }
        this.emit(line, "cc-feed-bubble-vip");
    }
    // --- input → VIP context ---
    onEdit(editor) {
        if (!this.settings.oracleVipReactsToTyping) return;
        if (this.editTimer != null) window.clearTimeout(this.editTimer);
        this.editTimer = window.setTimeout(() => this.classify(editor), tuning().oracleDebounce);
    }
    // Classify the current line to a VIP; store the match only if its confidence clears a multiple of the uniform (1/N) baseline, then pick the topic to echo (see below).
    classify(editor) {
        this.editTimer = null;
        if (!this.clf || !this.enabledVips.length) return;
        let text = "";
        try { text = editor.getLine(editor.getCursor().line) || ""; } catch { text = ""; }
        const lem = this.lemma(text);
        if (!lem.trim()) return;
        let scores;
        try { scores = this.clf.scores(lem); } catch { return; }
        let best = -1, bestKey = null;
        for (const k in scores) if (scores[k] > best) { best = scores[k]; bestKey = k; }
        if (bestKey == null) return;
        const uniform = 1 / this.enabledVips.length;
        if (best < uniform * tuning().oracleMatchFactor) { this.context = null; return; }
        const idx = parseInt(bestKey.slice(1), 10);
        const vip = this.enabledVips[idx];
        if (!vip) return;
        // Echo priority: (1) typed topic-bank word, (2) most recent noun (->singular), (3) most recent verb (->infinitive). nounify() gerundises at emit. Empty -> ambient pick.
        const words = new Set(lem.split(/\s+/));
        const topic = this.syms(vip).find((s) => words.has(this.lemma(s)))
            || this.lastTyped(text, (d) => d.match("#Noun").not("#Pronoun").nouns().toSingular())
            || this.lastTyped(text, (d) => d.verbs().toInfinitive());
        this.context = { vipIndex: idx, topic, ts: Date.now() };
    }
}
/* ---------------- sidebar view ---------------- */
// Sidebar panel: a single stage-less Walker drawn from sidebar-enabled characters. Owns icon column, stream background, comment feed, and sprite liveness.
class CompanionView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.walker = null;
        this.observer = null;
        // Fires repositionOverlays when the panel's own box changes (split-divider drag) — the case window "resize" / "layout-change" both miss.
        this.resizeObserver = null;
        // Stream state: chat overlay, background-cycle timer + current image + its bag, plus a bag for the "show another character" button.
        this.feed = new CommentFeed(this);
        // The feed is a passive surface; each FEED_SOURCES row owns its own timer (stop handle) and draws without repeats from its own bag. The Oracle owns three more timers of its own.
        for (const { key } of FEED_SOURCES) {
            this[key + "Bag"] = new Bag();
            this[key + "Stop"] = null;
        }
        this.oracle = new Oracle(this);
        this.bgStop = null;
        this.bgUrl = null;
        this.bgSig = "";
        this.bgBag = new Bag();
        this.sidebarBag = new Bag();
        // Aesthetics overlay: DOM refs (null off-sprite), the two sync-gated tickers' timers and live counters (uptime seconds, viewer count).
        this.aes = null;
        this.uptimeStop = null;
        this.uptimeS = 0;
        this.viewerStop = null;
        this.viewerCount = 0;
    }
    get settings() { return this.plugin.settings; }
    getViewType() {
        return VIEW_TYPE_COMPANION;
    }
    getDisplayText() {
        return "Character companion";
    }
    getIcon() {
        return "ghost";
    }
    async onOpen() {
        // Pause the sprite (and stream) when the panel is off screen or the window blurred; resume when it returns.
        this.registerDomEvent(activeDocument, "visibilitychange", () => this.sync());
        this.registerDomEvent(activeWindow, "blur", () => this.sync());
        this.registerDomEvent(activeWindow, "focus", () => this.sync());
        // Re-anchor viewport-positioned overlays after panel moves. Three sources: window resize, layout-change, ResizeObserver.
        this.registerDomEvent(activeWindow, "resize", () => this.repositionOverlays());
        this.registerEvent(this.app.workspace.on("layout-change", () => this.repositionOverlays()));
        this.resizeObserver = new ResizeObserver(() => this.repositionOverlays());
        this.resizeObserver.observe(this.contentEl);
        // The now-playing status re-reads the active file on a switch (and on refocus via sync) — no timer of its own, so it isn't sync-gated.
        this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateAesStatus()));
        this.observer = new IntersectionObserver(() => this.sync());
        this.observer.observe(this.contentEl);
        this.render();
    }
    async onClose() {
        this.cleanupWalker();
        this.stopAesTimers();
        this.teardownStream();
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }
    // The characters eligible for the sidebar (the "Display in sidebar" pills).
    sidebarCharacters() {
        return this.plugin.characterData.characters.filter((c) => c.sidebarEnabled);
    }
    // Draw a sidebar character into activeCharacterId and return it (null when none are enabled). `avoid` (the current id) is skipped when more than one is enabled: a kept-active render doesn't draw, so the bag's own `last` can drift from activeCharacterId — this re-draw is what keeps "show another" from ever landing back on the current face.
    drawCharacter(avoid) {
        const list = this.sidebarCharacters();
        if (list.length === 0)
            return null;
        const ids = list.map((c) => c.id);
        let id = this.sidebarBag.next(ids);
        if (ids.length > 1 && id === avoid)
            id = this.sidebarBag.next(ids);
        this.plugin.characterData.activeCharacterId = id;
        return list.find((c) => c.id === id);
    }
    // The character to show: the active one if still sidebar-enabled, else a fresh draw.
    getActiveCharacter() {
        return this.sidebarCharacters().find((c) => c.id === this.plugin.characterData.activeCharacterId)
            ?? this.drawCharacter(null);
    }
    // Icon-column action: draw a different sidebar character; saveDataFile("characterData", true) persists the new active pointer and re-renders the panel(s).
    pickAnotherCharacter() {
        if (this.drawCharacter(this.plugin.characterData.activeCharacterId))
            void this.plugin.saveDataFile("characterData", true);
    }
    // Icon-column action: open this plugin's settings tab.
    openPluginSettings() {
        const setting = this.app.setting;
        if (!setting)
            return;
        setting.open();
        setting.openTabById(this.plugin.manifest.id);
    }
    // Icon-column action: flip one feed mode's `<key>Enabled` flag and apply it IN PLACE — every mode is only an overlay/feed source (never the sprite's DOM), so sync() reconciles it and relightIconButtons() re-lights the button; no re-render (which would tear the walker down mid-beat). Stream additionally resets its uptime/viewer counters when going live and wakes the sprite either way (streamEnabled forces no-sleep, read live via isAsleep()).
    toggleMode(key) {
        const on = this.settings[key + "Enabled"] = !this.settings[key + "Enabled"];
        if (key === "stream" && on)
            this.resetAesCounters();
        void this.plugin.saveSettings();
        this.sync();
        this.relightIconButtons();
        if (key === "stream")
            this.walker?.wake();
    }
    // Reflect each toggle button's `active` predicate onto its lit state (initial paint and after an in-place toggle like stream mode).
    relightIconButtons() {
        for (const { def, btn } of this.iconButtons ?? [])
            if (def.active)
                btn.classList.toggle("cc-icon-active", !!def.active(this));
    }
    // Re-anchor the two viewport-positioned overlays (corner feed + fixed sprite bubble) after the panel moves. Harmless when the bubble is hidden — it re-reads its spot on next speak.
    repositionOverlays() {
        this.feed.reposition();
        this.walker?.positionBubble();
    }
    // Tear down the current sprite's timers before a re-render or close. Its bubble lives on <body>, outside the panel root.empty() clears, so drop it explicitly here too.
    cleanupWalker() {
        if (this.walker) {
            this.walker.clearTimers();
            this.walker.bubbleEl.remove();
            this.walker = null;
        }
    }
    // Liveness gate for the panel. Preserved across blur: sprite + background. Torn down: feed + effects.
    sync() {
        const live = this.isLive();
        // Each FEED_SOURCES row reconciles to its `<key>Enabled` flag && live; the Oracle does the same inside its own sync.
        const running = {};
        for (const s of FEED_SOURCES)
            running[s.key] = this.settings[s.key + "Enabled"] && live;
        const anySource = FEED_SOURCES.some((s) => running[s.key]);
        const oracleRunning = this.settings.oracleEnabled && live;
        if (this.walker)
            live ? this.walker.resumeRest() : this.walker.pauseRest();
        // The feed is shared: mount it while ANY mode wants it, drop it when none do.
        if (anySource || oracleRunning)
            this.feed.mount();
        else
            this.feed.unmount();
        // Every FEED_SOURCES row is RiScript-templated (blog also needs the lexicon for generated handles), so make sure the shared engine (desktop-only) is loading; a failure latches with a Notice and only the templated lines drop — plain comments still push. Fire-and-forget.
        if (anySource && !this.plugin.riscript.loaded && !this.plugin.riscript.loadFailed)
            this.plugin.riscript.ensure().catch(() => new Notice("Character Companion: stream comment variables need the RiScript engine in lib/ (desktop only). Plain comments still work."));
        // One reconciled random-interval timer per source row (idempotent — a live timer is left alone, see syncTimer).
        for (const s of FEED_SOURCES)
            this.syncTimer(s.key + "Stop", running[s.key],
                () => ({ lo: this.settings[s.minKey], hi: this.settings[s.maxKey] }),
                () => s.push(this, this[s.key + "Bag"].next(s.pool(this))));
        // The Oracle reconciles its three sources (and lazy-loads its libs) against liveness.
        void this.oracle.sync(oracleRunning);
        // Background-change cycle: paintBackground owns the image and picks it lazily, so pausing this timer freezes the picture rather than swapping it — a refocus keeps the same backdrop.
        this.syncTimer("bgStop", running.stream,
            () => ({ lo: this.settings.streamBgMinMs, hi: this.settings.streamBgMaxMs }),
            () => { this.bgUrl = this.nextBg(); this.paintBackground(); });
        this.paintBackground();
        this.syncAesthetics();
    }
    // Draw a line (non-repeat), evaluate as RiScript against character+set vars, push. Plain lines pass through; unloaded engine -> skip beat.
    pushComment(text) {
        if (!text) return;
        const R = this.plugin.riscript;
        if (R.pending(text)) return;
        // Duplicate lines across sets resolve to the first enabled set's variables (var-bearing lines aren't realistically duplicated, and plain duplicates carry no vars to differ on).
        const set = this.plugin.streamData.commentSets.find((cs) => cs.enabled && cs.comments.includes(text));
        const ctx = Object.assign({}, this.streamCtx(), choiceRules(set ? set.vars : {}));
        const line = R.evalTrim(text, ctx);
        if (line) this.feed.push(line);
    }
    // Draw a mail template (non-repeat), evaluate Title/From/To/Content as RiScript, push as structured bubble.
    pushMail(tpl) {
        if (!tpl) return;
        const R = this.plugin.riscript;
        if (R.pending(tpl.title + tpl.from + tpl.to + tpl.content)) return;
        const ctx = Object.assign({}, this.streamCtx(), choiceRules(this.plugin.mailData.constants));
        const ev = (line, extra) => R.evalTrim(line, extra ? Object.assign({}, ctx, extra) : ctx);
        const title = ev(tpl.title);
        const from = ev(tpl.from);
        const to = ev(tpl.to);
        // Content sees $to too, so the body can repeat the addressee ("Hey $to, ...").
        const content = ev(tpl.content, { to });
        this.feed.push([
            { cls: "title", text: title },
            { cls: "from", text: from && "From: " + from },
            { cls: "to", text: to && "To: " + to },
            { cls: "content", text: content },
        ], "cc-feed-bubble-mail");
    }
    // Draw a blog line (non-repeat), prepend @$handle if needed, split on author/tags/body structure, evaluate as RiScript (pure-ambient, no streamCtx).
    pushBlog(raw) {
        if (!raw) return;
        const R = this.plugin.riscript;
        let line = raw.trim();
        if (line[0] !== "@") line = "@$handle " + line;
        if (R.pending(line)) return;
        const toks = line.split(/\s+/);
        let i = 1;
        while (toks[i] && toks[i][0] === "#") i++;
        const ctx = choiceRules(this.plugin.blogData.constants);
        const ev = (s) => R.evalTrim(s, ctx);
        this.feed.push([
            { cls: "handle", text: ev(toks[0]) },
            { cls: "body", text: ev(toks.slice(i).join(" ")) },
            { cls: "tags", text: ev(toks.slice(1, i).join(" ")) },
        ], "cc-feed-bubble-blog");
    }
    // Character template vars with safe defaults. Pronouns: slash-sep -> $they/$them/$their (4th/5th -> $theirs/$themself). Deeds/topics: verb-initial phrases for inflection.
    streamCtx() {
        const c = this.getActiveCharacter();
        const name = (c && c.name && c.name.trim()) || "The streamer";
        const pr = ((c && c.pronouns) || "they/them/their").split("/").map((s) => s.trim());
        const deeds = (c && c.deeds && c.deeds.length) ? c.deeds : ["do amazing things"];
        const topics = (c && c.topics && c.topics.length) ? c.topics : ["the stream"];
        const epithets = commaList(c && c.epithet);
        const roles = commaList(c && c.role);
        const ctx = {
            name,
            they: pr[0] || "they", them: pr[1] || pr[0] || "them", their: pr[2] || pr[1] || "their",
        };
        if (pr[3]) ctx.theirs = pr[3];
        if (pr[4]) ctx.themself = pr[4];
        return Object.assign(ctx, choiceRules({
            deed: deeds, topic: topics,
            epithet: epithets.length ? epithets : [name],
            role: roles.length ? roles : ["legend"],
        }));
    }
    // Reconcile a named self-rescheduling timer to on/off (idempotent). range() yields {lo,hi}; fire() runs one tick.
    syncTimer(handle, on, range, fire) {
        if (on === (this[handle] != null))
            return;
        if (on)
            this[handle] = randomInterval(range, fire);
        else {
            this[handle]();
            this[handle] = null;
        }
    }
    // Draw the next backdrop path from the bag over the configured background paths.
    nextBg() {
        return this.bgBag.next(resolvePathList(this.app, this.settings.streamBackgrounds));
    }
    // Full stream teardown (panel closing): stop every feed source, drop the feed, the background cycle, and every built effect — the last is why a closed panel leaves no live WAAPI drift.
    teardownStream() {
        for (const { key } of FEED_SOURCES)
            this.syncTimer(key + "Stop", false);
        this.syncTimer("bgStop", false);
        this.oracle.unmount();
        this.feed.unmount();
        this.teardownEffects();
    }
    // Cancel + remove every built effect (WAAPI drifts included) and forget the set. Shared by teardownStream and paintBackground's anchor-change reset.
    teardownEffects() {
        if (!this.builtFx)
            return;
        for (const teardown of this.builtFx.built.values())
            teardown();
        this.builtFx = null;
    }
    // Paint the stream overlay on the current anchor. The backdrop shows whenever streaming (regardless of liveness, picking its first image lazily); effects are gated on `running` (live), torn down when unseen.
    paintBackground() {
        const anchor = this.contentEl.querySelector(".cc-anchor");
        if (!anchor)
            return;
        const streaming = this.settings.streamEnabled;
        // Only the shown image needs the reset — the bag reshuffles itself on a source-list change (Bag.next's signature check).
        if (this.bgSig !== this.settings.streamBackgrounds) {
            this.bgSig = this.settings.streamBackgrounds;
            this.bgUrl = null;
        }
        if (streaming && !this.bgUrl)
            this.bgUrl = this.nextBg();
        const running = streaming && this.isLive();
        const bg = streaming && this.bgUrl;
        anchor.classList.toggle("cc-streaming", !!bg);
        anchor.setCssProps({ "--cc-bg": bg ? `url("${bg}")` : "none" });
        // Reconcile effects: toggle each effect's class, build/teardown DOM to match.
        if (!this.builtFx || this.builtFx.anchor !== anchor) {
            this.teardownEffects();
            this.builtFx = { anchor, built: new Map() };
        }
        const built = this.builtFx.built;
        for (const fx of SPECIAL_EFFECTS) {
            const want = running && !!this.settings.enabledEffects[fx.key];
            anchor.classList.toggle("cc-fx-" + fx.key, want);
            if (want && !built.has(fx.key))
                built.set(fx.key, buildEffect(anchor, fx.key));
            else if (!want && built.has(fx.key)) {
                built.get(fx.key)();
                built.delete(fx.key);
            }
        }
    }
    // Build aesthetics overlay DOM: top-left tickers + bottom react bar + particle layer. Visibility reconciled by syncAesthetics.
    buildAesthetics(anchor) {
        const aes = anchor.createDiv({ cls: "cc-aes" });
        const top = aes.createDiv({ cls: "cc-aes-top" });
        const stats = top.createDiv({ cls: "cc-aes-stats" });
        this.aes = { root: aes };
        // The four corner tickers differ only by icon + what fills the text, so one helper builds each: an `icon + text` pill registered under its key (the visibility-toggle target), returning the text span. uptime/viewer share the stats row; profile/status each take their own line. Counters/status are filled later; profile's text is the static character name.
        const ticker = (parent, key, icon) => {
            const pill = parent.createDiv({ cls: "cc-aes-ticker cc-aes-" + key });
            setIcon(pill.createSpan({ cls: "cc-aes-ticker-icon" }), icon);
            this.aes[key] = pill;
            return pill.createSpan({ cls: "cc-aes-ticker-text" });
        };
        this.aes.uptimeEl = ticker(stats, "uptime", "clock");
        this.aes.viewerEl = ticker(stats, "viewer", "drama");
        ticker(top, "profile", "user-round").setText(this.walker?.character?.name ?? "");
        this.aes.statusText = ticker(top, "status", "music");
        const react = aes.createDiv({ cls: "cc-aes-react" });
        const comment = react.createDiv({ cls: "cc-aes-comment" });
        const input = comment.createEl("input", { cls: "cc-aes-input", attr: { type: "text", placeholder: "Comment..." } });
        // Press Enter to inject the typed line into the live feed as a one-off comment; it ages out with the regular ones and never touches their random rotation.
        input.addEventListener("keydown", (e) => {
            if (e.key !== "Enter")
                return;
            const text = input.value.trim();
            input.value = "";
            if (text)
                this.feed.push(text, "cc-feed-bubble-self");
        });
        const gift = react.createEl("button", { cls: "cc-aes-btn cc-aes-gift", attr: { "aria-label": "Send a gift" } });
        setIcon(gift, "gift");
        const like = react.createEl("button", { cls: "cc-aes-btn cc-aes-like", attr: { "aria-label": "Like" } });
        setIcon(like, "heart-plus");
        const fx = aes.createDiv({ cls: "cc-aes-fx" });
        gift.addEventListener("click", () => this.spawnEmoji());
        like.addEventListener("click", () => this.spawnHeart());
        this.aes.react = react;
        this.aes.fx = fx;
        // Counters need their opening values now; the now-playing status is reconciled by the sync() that always follows a render (syncAesthetics → updateAesStatus when shown).
        this.resetAesCounters();
    }
    // Reconcile each piece's visibility to streamEnabled + its flag, and run the two sync-gated tickers (uptime, viewer) only while live. Called from sync() (liveness / stream changes) and applyChange's repaint (an Aesthetics pill toggled in settings).
    syncAesthetics() {
        const aes = this.aes;
        if (!aes || !aes.root.isConnected)
            return;
        aes.root.setCssProps({ "--cc-stream-font": this.settings.commentFont || "" });
        const streaming = this.settings.streamEnabled;
        const en = this.settings.enabledAesthetics;
        const show = (key) => streaming && !!en[key];
        // Each piece's visibility follows its flag; the wrapper shows if any piece does.
        let any = false;
        for (const a of AESTHETICS) {
            const on = show(a.key);
            any = any || on;
            aes[a.key].classList.toggle("cc-hidden", !on);
        }
        aes.root.classList.toggle("cc-aes-show", any);
        // Only the two tickers own timers: run them while live + shown, freeze them otherwise. Both are fixed-interval, so they ride the shared syncTimer primitive with lo === hi.
        const live = this.isLive();
        this.syncTimer("uptimeStop", live && show("uptime"), () => ({ lo: 1000, hi: 1000 }), () => {
            this.uptimeS += 1;
            this.renderAesCounters();
        });
        this.syncTimer("viewerStop", live && show("viewer"), () => ({ lo: tuning().aesViewerInterval, hi: tuning().aesViewerInterval }), () => {
            // One drift tick: a small +/- wobble, plus an occasional bulk spike; never below the floor.
            const t = tuning();
            let delta = Math.round(randRange(-t.aesViewerDelta, t.aesViewerDelta));
            if (Math.random() < t.aesViewerSpikeChance)
                delta += Math.round(randRange(t.aesViewerSpikeMin, t.aesViewerSpikeMax));
            this.viewerCount = Math.max(Math.round(t.aesViewerFloor), this.viewerCount + delta);
            this.renderAesCounters();
        });
        if (show("status"))
            this.updateAesStatus();
    }
    // Reset both tickers to their opening values (on a fresh stream toggle / render). The viewer count opens on a random draw in [min, max] so each stream starts believably different instead of the same fixed number every time.
    resetAesCounters() {
        const t = tuning();
        this.uptimeS = 0;
        this.viewerCount = Math.round(randRange(t.aesViewerStartMin, t.aesViewerStartMax));
        this.renderAesCounters();
    }
    stopAesTimers() {
        this.syncTimer("uptimeStop", false);
        this.syncTimer("viewerStop", false);
    }
    // Paint both ticker readouts from the live counters (the only place either is written out).
    renderAesCounters() {
        if (!this.aes)
            return;
        this.aes.uptimeEl.setText(formatHMS(this.uptimeS));
        this.aes.viewerEl.setText(this.viewerCount.toLocaleString());
    }
    // Now-playing: the active note's name (re-read on focus + active-leaf-change).
    updateAesStatus() {
        if (!this.aes)
            return;
        const file = this.app.workspace.getActiveFile();
        this.aes.statusText.setText(file ? file.basename : "Nothing playing");
    }
    // Spawn one WAAPI particle into the react bar's fx layer. `build(layer, t)` returns the element plus its { frames, duration (seconds), easing }; the particle self-removes when the animation finishes. The shared scaffold for the gift/like rains below.
    spawnParticle(build) {
        const layer = this.aes && this.aes.fx;
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
    render() {
        whenStyled(() => this.renderNow());
    }
    renderNow() {
        const root = this.contentEl;
        this.cleanupWalker();
        this.teardownEffects();
        // The aesthetics DOM lives under the about-to-be-emptied root, so drop its timers and stale refs first (buildAesthetics rebuilds them when there's a sprite).
        this.stopAesTimers();
        this.aes = null;
        root.empty();
        root.addClass("cc-root");
        // The icon column is always present (even in empty states) so settings + stream actions stay reachable.
        this.renderIconColumn(root);
        this.renderBody(root);
        // Common tail (no-op in empty states): reconcile sprite + stream to liveness.
        this.sync();
    }
    // Build the panel body: an empty-state message, a "sprite not found" notice, or the anchor + stage-less Walker (speed 0 — rests/animates/reacts, dozes off-stream).
    renderBody(root) {
        const character = this.getActiveCharacter();
        if (!character) {
            root.createDiv({ cls: "cc-empty", text: this.plugin.characterData.characters.length === 0
                    ? "No characters yet. Add one in the plugin settings."
                    : "No characters enabled for the sidebar. Enable some in the Display settings." });
            return;
        }
        const urls = resolvePathList(this.app, character.spritePath);
        if (urls.length === 0) {
            // A root-level notice (like the empty states), NOT inside an anchor: the anchor is built only when there's a real sprite to house, so paintBackground finds none and never paints a stream backdrop behind the error.
            root.createDiv({ cls: "cc-empty", text: 'Sprite not found: "' + character.spritePath + '". Check the path in settings.' });
            return;
        }
        // Sprite height caps the image and sets the bubble's resting height, so it lives on the root for both to inherit.
        root.setCssProps({ "--cc-sprite-max-height": String(this.settings.sidebarSpriteMaxHeight) });
        // The anchor fills the panel and clips the sprite so an idle stroll can walk off one edge and back without the off-screen jump showing.
        const anchor = root.createDiv({ cls: "cc-anchor" });
        const spriteWrap = anchor.createDiv({ cls: "cc-sprite-wrap" });
        const sprite = spriteWrap.createEl("img", { cls: "cc-sprite" });
        // Bubble lives on <body> (same level as the comment feed), NOT inside the panel, so the workspace-leaf frame can never clip it — it stays fully visible even past the panel edge. Being off-panel, root.empty() can't reap it, so cleanupWalker removes it. The walker positions it against the sprite picture (`sprite`) each time it speaks; the view re-runs that on resize/layout-change while it's up.
        const bubble = activeDocument.body.createDiv({ cls: "cc-bubble" });
        this.walker = new Walker(null, this.plugin, character, { wrapEl: spriteWrap, imgEl: sprite, bubbleEl: bubble, bubbleAnchorEl: sprite }, urls, 0);
        // The livestream overlay sits on the anchor, above the sprite (syncAesthetics gates it).
        this.buildAesthetics(anchor);
    }
    // The vertical icon-button column down the right edge (SIDEBAR_BUTTONS): one action each, lit when its `active` predicate holds, greyed when `disabled`.
    renderIconColumn(root) {
        const col = root.createDiv({ cls: "cc-icon-col" });
        // Track the live toggle buttons so toggleMode can relight them without re-rendering.
        this.iconButtons = [];
        for (const def of SIDEBAR_BUTTONS) {
            const btn = col.createEl("button", { cls: "cc-icon-btn", attr: { "aria-label": def.label } });
            setIcon(btn, def.icon);
            btn.addEventListener("click", () => def.run(this));
            this.iconButtons.push({ def, btn });
        }
        this.relightIconButtons();
    }
    // Foreground AND actually on screen: a collapsed sidebar / background tab is display:none, so offsetParent is null. Computed fresh so no stale reading wedges it.
    isLive() {
        const el = this.contentEl;
        return appActive() && !!el && el.offsetParent !== null;
    }
}
/* ---------------- settings tab ---------------- */
// Reusable name-pill list + editor (pill grid with click-to-select + drag-reorder, Add button, per-item editor). cfg: { items, makeItem, labelOf, addText, pickName, pickDesc, emptyText, renderBody, onMutate, save, onAdd?, onDelete? }.
class ListEditor {
    constructor(tab, cfg) {
        this.tab = tab;
        this.cfg = cfg;
        this.editingId = null;
        this.gridEl = null;
        this.editorEl = null;
        this.pillEls = new Map();
        // Pointer-drag reorder state: the dragged pill, its pointer, the press origin (for the drag threshold), and whether it has passed it.
        this.reorderPill = null;
        this.reorderPointerId = null;
        this.reorderStartX = 0;
        this.reorderStartY = 0;
        this.reorderMoved = false;
        this.suppressNextClick = false;
    }
    get plugin() { return this.tab.plugin; }
    // Persist a list mutation through the tab's shared commit tail. Every list is backed by its own data file, so cfg.save always points there.
    persist() { return this.tab.commit(this.cfg.save); }
    // Build the Add button, the pill grid, and the editor host into containerEl.
    mount(containerEl) {
        new Setting(containerEl)
            .setName(this.cfg.pickName)
            .setDesc(this.cfg.pickDesc)
            .addButton((b) => b
            .setButtonText(this.cfg.addText)
            .setCta()
            .onClick(async () => {
            const item = this.cfg.makeItem();
            this.cfg.items().push(item);
            if (this.cfg.onAdd)
                this.cfg.onAdd(item);
            this.editingId = item.id;
            await this.persist();
            this.cfg.onMutate();
            this.rebuildPills();
            this.renderEditor();
        }));
        this.gridEl = containerEl.createDiv({ cls: "cc-pill-grid" });
        this.editorEl = containerEl.createDiv();
        this.rebuildPills();
        this.renderEditor();
    }
    rebuildPills() {
        const grid = this.gridEl;
        if (!grid)
            return;
        grid.empty();
        this.pillEls.clear();
        const items = this.cfg.items();
        if (this.editingId && !items.some((c) => c.id === this.editingId))
            this.editingId = null;
        if (!this.editingId && items.length > 0)
            this.editingId = items[0].id;
        for (const it of items) {
            const pill = this.createPill(grid, this.cfg.labelOf(it) || "(unnamed)", it.id === this.editingId, () => this.select(it.id));
            this.makeReorderable(pill, it.id);
            this.pillEls.set(it.id, pill);
        }
    }
    // Create a pill button. A click that concluded a reorder drag is swallowed so the dragged pill isn't also selected.
    createPill(grid, text, active, onClick) {
        const pill = grid.createEl("button", { cls: "cc-pill", text });
        if (active)
            pill.classList.add("cc-pill-active");
        pill.addEventListener("click", () => {
            if (this.suppressNextClick) {
                this.suppressNextClick = false;
                return;
            }
            void onClick(pill);
        });
        return pill;
    }
    // Make an edit pill a drag handle that reorders the list: it slides through the grid in the DOM as it's dragged (live layout IS the preview); on drop we read DOM order back.
    makeReorderable(pill, id) {
        pill.dataset.ccId = id;
        pill.addEventListener("pointerdown", (e) => this.onReorderDown(pill, e));
        pill.addEventListener("pointermove", (e) => this.onReorderMove(e));
        pill.addEventListener("pointerup", (e) => this.onReorderUp(e));
        pill.addEventListener("pointercancel", (e) => this.onReorderUp(e));
        // Right-click a pill to delete its item (the only delete path — there's no in-editor delete button).
        pill.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const menu = new Menu();
            menu.addItem((i) => i.setTitle("Delete").setIcon("trash").onClick(() => { void this.deleteItem(id); }));
            menu.showAtMouseEvent(e);
        });
    }
    onReorderDown(pill, e) {
        if (e.button !== 0)
            return;
        this.reorderPill = pill;
        this.reorderPointerId = e.pointerId;
        this.reorderStartX = e.clientX;
        this.reorderStartY = e.clientY;
        this.reorderMoved = false;
        capturePointer(pill, e.pointerId);
    }
    onReorderMove(e) {
        if (this.reorderPointerId === null || e.pointerId !== this.reorderPointerId)
            return;
        if (!this.reorderMoved) {
            if (Math.hypot(e.clientX - this.reorderStartX, e.clientY - this.reorderStartY) < tuning().dragThreshold)
                return;
            this.reorderMoved = true;
            this.reorderPill.classList.add("cc-pill-dragging");
        }
        // Find the pill under the pointer (hiding the dragged pill from the hit test for the lookup), then move the dragged pill to its near/far side — the grid reflows.
        this.reorderPill.classList.add("cc-no-hit");
        const under = activeDocument.elementFromPoint(e.clientX, e.clientY);
        this.reorderPill.classList.remove("cc-no-hit");
        const target = under ? under.closest(".cc-pill") : null;
        if (!target || target === this.reorderPill || !this.gridEl.contains(target))
            return;
        const rect = target.getBoundingClientRect();
        if (e.clientX > rect.left + rect.width / 2)
            target.after(this.reorderPill);
        else
            target.before(this.reorderPill);
    }
    async onReorderUp(e) {
        if (this.reorderPointerId === null || e.pointerId !== this.reorderPointerId)
            return;
        releasePointer(this.reorderPill, e.pointerId);
        this.reorderPill.classList.remove("cc-pill-dragging");
        const moved = this.reorderMoved;
        this.reorderPill = null;
        this.reorderPointerId = null;
        this.reorderMoved = false;
        if (!moved)
            return;
        // Swallow the click this pointer-up also fires on the pill.
        this.suppressNextClick = true;
        // Mirror the pills' new DOM order into the list.
        const order = [...this.gridEl.querySelectorAll(".cc-pill")].map((el) => el.dataset.ccId);
        this.cfg.items().sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        await this.persist();
        this.cfg.onMutate();
    }
    select(id) {
        this.editingId = id;
        this.pillEls.forEach((pill, cid) => pill.classList.toggle("cc-pill-active", cid === id));
        this.renderEditor();
    }
    // Update one pill's label in place (a rename, without rebuilding the grid).
    refreshPillLabel(id, text) {
        const pill = this.pillEls.get(id);
        if (pill)
            pill.setText(text);
    }
    renderEditor() {
        const host = this.editorEl;
        if (!host)
            return;
        host.empty();
        const editing = this.cfg.items().find((c) => c.id === this.editingId);
        if (editing)
            this.cfg.renderBody(host, editing, this);
        else
            host.createDiv({ cls: "cc-empty", text: this.cfg.emptyText });
    }
    // Remove an item (the pill right-click menu routes here — the only delete path): drop it, let the owner patch up dependent state, persist, refresh dependent UI, rebuild.
    async deleteItem(id) {
        const items = this.cfg.items();
        const i = items.findIndex((c) => c.id === id);
        if (i < 0)
            return;
        items.splice(i, 1);
        if (this.cfg.onDelete)
            this.cfg.onDelete(id);
        this.editingId = null;
        await this.persist();
        this.cfg.onMutate();
        this.rebuildPills();
        this.renderEditor();
    }
}
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
    // Effects + aesthetics: no empty state, no explicit save. Their flag maps live in data.json, so the default saveSettings persists them — and that repaints the open panels' stream overlay IN PLACE (effects rebuild just the toggled fx; aesthetics via syncAesthetics), never tearing down the sprite's rest cycle.
    effect: {
        grid: "effectGridEl",
        entries: (t) => t.flagPills(SPECIAL_EFFECTS, t.plugin.settings.enabledEffects),
    },
    aesthetic: {
        grid: "aestheticGridEl",
        entries: (t) => t.flagPills(AESTHETICS, t.plugin.settings.enabledAesthetics),
    },
};
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
        ];
    }
    // The shared persist tail every control's onChange ends in: the field's own save() when given (per-file lists persist to their own file), else the settings save with the control's rerender flag.
    commit(save, rerender = false) {
        return save ? save() : this.plugin.saveSettings(rerender);
    }
    // One slider setting: a native ".slider" over [min, max] stepped by step, with the live value shown to its LEFT (mirrors the dual-range row) and the unit carried in the name's brackets. get()/set() read/write the stored value; the ms sibling passes format/parse for the stored↔display conversion (identity here).
    addSliderSetting(container, { name, desc, unit, get, set, min, max, step, save, rerender = false, format = (v) => v, parse = (v) => v, readout = (v) => String(v) }) {
        const setting = new Setting(container).setName(unit ? name + " (" + unit + ")" : name);
        if (desc)
            setting.setDesc(desc);
        const wrap = setting.controlEl.createDiv({ cls: "cc-range" });
        const label = wrap.createSpan({ cls: "cc-range-label" });
        const attr = { type: "range", min: String(min), max: String(max), step: String(step), "data-ignore-swipe": "true" };
        const slider = wrap.createEl("input", { cls: "slider cc-single-slider", attr });
        const paint = () => label.setText(readout(Number(slider.value)));
        slider.value = String(format(get()));
        paint();
        // Live-paint the readout per tick; persist (and possibly re-render the open panel) only when the drag ends — same rationale as addTextSetting's change-not-keystroke commit.
        slider.addEventListener("input", () => paint());
        slider.addEventListener("change", async () => { set(parse(Number(slider.value))); await this.commit(save, rerender); });
    }
    // One toggle setting: a boolean read through get()/set(), persisted on flip.
    addToggleSetting(container, { name, desc, get, set, save, rerender = false }) {
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
    // One text-input setting: a string read through get()/set() and persisted. set() owns any trimming and side effects (a pill relabel, a pill-grid rebuild). Commits on the native "change" (click away / Enter), NOT per keystroke — a save can re-render the open panel, which mustn't fire mid-typing.
    addTextSetting(container, { name, desc, placeholder, get, set, save, rerender = false }) {
        const setting = new Setting(container).setName(name);
        if (desc)
            setting.setDesc(desc);
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
    // A dual-thumb range setting: two native ".slider" inputs stacked (both full-width, pointer ignored except on each thumb). get/set/min/max/step are all in ONE unit (the slider steps in it, values commit in it); `divisor` only scales the readout, so a slider that steps in ms can still show minutes (see addMsRangeSetting).
    addRangeSetting(container, { name, desc, min, max, step, unit, divisor = 1, getMin, setMin, getMax, setMax }) {
        const setting = new Setting(container).setName(unit ? name + " (" + unit + ")" : name);
        if (desc)
            setting.setDesc(desc);
        const wrap = setting.controlEl.createDiv({ cls: "cc-range" });
        const label = wrap.createSpan({ cls: "cc-range-label" });
        const sliders = wrap.createDiv({ cls: "cc-range-sliders" });
        const attr = { type: "range", min: String(min), max: String(max), step: String(step), "data-ignore-swipe": "true" };
        const lo = sliders.createEl("input", { cls: "slider cc-range-lo", attr });
        const hi = sliders.createEl("input", { cls: "slider cc-range-hi", attr });
        lo.value = String(getMin());
        hi.value = String(getMax());
        const paint = () => {
            label.setText((Number(lo.value) / divisor) + "–" + (Number(hi.value) / divisor));
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
    // A time-interval dual-range for a setting stored in ms. The slider steps and commits in ms — get/set are raw passthroughs to the two ms keys, no per-value arithmetic — and only the readout divides by the unit (min→60000, sec→1000). min/max/step are authored in that display unit (readable: 1–60 min) and scaled to ms bounds once, here: the single point ms↔unit conversion lives.
    addMsRangeSetting(container, { name, desc, unit, min, max, step = 1, minKey, maxKey }) {
        const div = unit === "sec" ? 1000 : 60000;
        const s = this.plugin.settings;
        this.addRangeSetting(container, {
            name, desc, unit, divisor: div,
            min: min * div, max: max * div, step: step * div,
            getMin: () => s[minKey], setMin: (v) => (s[minKey] = v),
            getMax: () => s[maxKey], setMax: (v) => (s[maxKey] = v),
        });
    }
    // Single-thumb time slider for an ms-stored setting, authored + shown in minutes/seconds — the value-of-one sibling of addMsRangeSetting. Delegates to addSliderSetting with format/parse doing the single-point ms↔unit conversion (div = 1000 sec / 60000 min); the unit rides in the name's brackets.
    addMsSliderSetting(container, { name, desc, unit, min, max, step = 1, key }) {
        const div = unit === "sec" ? 1000 : 60000;
        const s = this.plugin.settings;
        this.addSliderSetting(container, {
            name, desc, unit, min, max, step,
            get: () => s[key], set: (v) => (s[key] = v),
            format: (v) => v / div, parse: (v) => v * div,
        });
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
            get: () => this.plugin.settings.idleEnabled,
            set: (v) => (this.plugin.settings.idleEnabled = v),
        });
        this.addSliderSetting(c, {
            name: "Chatter chance", unit: "%",
            desc: "How often an idle moment triggers a quote instead of a movement. 0 = never speak on its own.",
            min: 0, max: 100, step: 5,
            get: () => this.plugin.settings.chatterChance,
            set: (v) => (this.plugin.settings.chatterChance = v),
        });
        this.addMsSliderSetting(c, {
            name: "Sleep after",
            desc: "How long the character waits until it dozes off and dims. Click to wake the character. Will not sleep while streaming.",
            unit: "min", min: 1, max: 60,
            key: "sleepAfterMs",
        });
        new Setting(c)
            .setName("Allowed idle animations")
            .setDesc("Click to enable or disable. Dimmed means off.");
        this.renderAnimToggles(c.createDiv({ cls: "cc-pill-grid" }), "idle");
        new Setting(c).setName("Click behavior").setHeading();
        this.addSliderSetting(c, {
            name: "Surprise chance", unit: "%",
            desc: "How often a click triggers an animation instead of a quote. 0 = always quote. 100 = always animate.",
            min: 0, max: 100, step: 5,
            get: () => this.plugin.settings.surpriseChance,
            set: (v) => (this.plugin.settings.surpriseChance = v),
        });
        this.addToggleSetting(c, {
            name: "Small bob on quote",
            desc: "Whether the character bobs on a normal (quote) click.",
            get: () => this.plugin.settings.animateOnQuote,
            set: (v) => (this.plugin.settings.animateOnQuote = v),
        });
        new Setting(c)
            .setName("Allowed surprise animations")
            .setDesc("Click to enable or disable. Dimmed means off.");
        this.renderAnimToggles(c.createDiv({ cls: "cc-pill-grid" }), "surprise");
    }
    renderDisplayTab(c) {
        this.tabIntro(c, "Where the characters appear, how big they are, and how fast they move.");
        new Setting(c).setName("Display in sidebar").setHeading();
        this.addSliderSetting(c, {
            name: "Sprite max height", unit: "px",
            desc: "Width scales to match.",
            min: 100, max: 500, step: 20,
            get: () => this.plugin.settings.sidebarSpriteMaxHeight,
            set: (v) => (this.plugin.settings.sidebarSpriteMaxHeight = v),
            rerender: true,
        });
        this.addMsSliderSetting(c, {
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
            get: () => this.plugin.settings.quoteTypewriter,
            set: (v) => (this.plugin.settings.quoteTypewriter = v),
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
            get: () => this.plugin.settings.rootSpriteMaxHeight,
            set: (v) => (this.plugin.settings.rootSpriteMaxHeight = v),
        });
        this.addSliderSetting(c, {
            name: "Walking speed", unit: "px/sec",
            desc: "Base speed for walking along the bottom. Each character scales this with its own walking speed.",
            min: 10, max: 50, step: 2,
            get: () => this.plugin.settings.rootWalkSpeed,
            set: (v) => (this.plugin.settings.rootWalkSpeed = v),
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
        this.addMsRangeSetting(c, {
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
        this.addMsRangeSetting(c, {
            name: "Comment interval",
            desc: "A new comment appears after a random time in this range.",
            unit: "sec", min: 5, max: 30, step: 5,
            minKey: "streamCommentMinMs", maxKey: "streamCommentMaxMs",
        });
        this.addSliderSetting(c, {
            name: "Visible comment history",
            desc: "How many comment bubbles stay on screen.",
            min: 1, max: 15, step: 1,
            get: () => this.plugin.settings.streamHistoryCount,
            set: (v) => (this.plugin.settings.streamHistoryCount = v),
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
            get: () => this.plugin.settings.oracleSystemName,
            set: (v) => (this.plugin.settings.oracleSystemName = v),
        });
        this.addTextSetting(c, {
            name: "Patron origin",
            desc: 'The audience species or status, used as $patron. Comma-separate several to draw one at random each time (e.g. "Demon, Angel"). Give a custom plural in brackets (e.g. "Persona (Personae)"). Blank falls back to "' + ORACLE_PATRON_FALLBACK + '".',
            placeholder: ORACLE_PATRON_FALLBACK,
            get: () => this.plugin.settings.oraclePatronName,
            set: (v) => (this.plugin.settings.oraclePatronName = v),
        });
        // Three fully independent interval ranges (authored seconds, stored ms).
        const interval = (name, kind) => this.addMsRangeSetting(c, {
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
            get: () => this.plugin.settings.oracleVipReactsToTyping,
            set: (v) => (this.plugin.settings.oracleVipReactsToTyping = v),
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
        this.addMsRangeSetting(c, {
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
        this.addMsRangeSetting(c, {
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
    // News mode — placeholder feed source.
    renderNewsTab(c) {
        this.tabIntro(c, "Planned for later.");
        new Setting(c).setName("News mode").setHeading();
        new Setting(c).setName("There's nothing here.");
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
    // Render an on/off pill per animation of a role, wired to its settings flag map and drag-paintable. Shared by the idle and surprise grids.
    renderAnimToggles(grid, role) {
        const pool = ANIM_POOLS[role];
        const flags = this.plugin.settings[pool.flag];
        this.paintGrid(grid, pool.all.map((name) => ({
            // Display label: explicit row label, else the capitalised name.
            label: ANIM_BY_NAME[name].label ?? name[0].toUpperCase() + name.slice(1),
            get: () => flags[name],
            set: (v) => { flags[name] = v; },
        })));
    }
    // A grid of toggle pills with drag-paint bulk select: pressing a pill flips it, and that value paints onto every pill the pointer slides across. entries = [{ label, get, set }]; the stroke saves once on release.
    paintGrid(grid, entries, save = null) {
        grid.empty();
        const byPill = new Map();
        for (const e of entries) {
            const pill = grid.createEl("button", { cls: "cc-pill", text: e.label });
            pill.classList.toggle("cc-pill-active", e.get());
            byPill.set(pill, e);
        }
        // The pill lookup AND the save target are refreshed on every rebuild; the gesture is wired once. Storing save on the grid keeps the once-wired `end` closure from capturing the first rebuild's save forever.
        grid.__ccPills = byPill;
        grid.__ccSave = save;
        if (grid.__ccPainted)
            return;
        grid.__ccPainted = true;
        let pointerId = null, value = false;
        const paint = (pill) => {
            const e = pill && grid.__ccPills.get(pill);
            if (!e || e.get() === value)
                return;
            e.set(value);
            pill.classList.toggle("cc-pill-active", value);
        };
        grid.addEventListener("pointerdown", (e) => {
            const pill = e.target instanceof Element ? e.target.closest(".cc-pill") : null;
            if (e.button !== 0 || !pill || !grid.__ccPills.has(pill))
                return;
            pointerId = e.pointerId;
            value = !grid.__ccPills.get(pill).get();
            capturePointer(grid, e.pointerId);
            paint(pill);
        });
        grid.addEventListener("pointermove", (e) => {
            if (e.pointerId !== pointerId)
                return;
            const under = activeDocument.elementFromPoint(e.clientX, e.clientY);
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
            void this.commit(grid.__ccSave);
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
    // Mount one enable-pill grid on the tab being rendered: create its div, store the ref its PILL_GRIDS row names, and paint it. The render tabs call this instead of repeating the div + ref + rebuild by hand.
    mountPillGrid(container, id) {
        this[PILL_GRIDS[id].grid] = container.createDiv({ cls: "cc-pill-grid" });
        this.rebuildPillGrid(id);
    }
    // Repaint one enable-pill grid from its PILL_GRIDS descriptor: skip an off-screen grid (isConnected — a rebuild triggered from another tab is harmless), show the row's empty-state message when it has one and there are no entries, else drag-paint the pills.
    rebuildPillGrid(id) {
        const g = PILL_GRIDS[id];
        const grid = this[g.grid];
        if (!grid || !grid.isConnected)
            return;
        const entries = g.entries(this);
        if (g.empty && entries.length === 0) {
            grid.empty();
            grid.createDiv({ cls: "cc-empty", text: g.empty });
            return;
        }
        this.paintGrid(grid, entries, g.save ? () => g.save(this) : null);
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
        new Setting(box)
            .setName("Name")
            .then((s) => this.addCharacterToggles(s, character))
            .addText((t) => {
            t.setPlaceholder("(unnamed)");
            t.setValue(character.name);
            // Commit on click-away like addTextSetting — the save re-renders the open panel.
            t.inputEl.addEventListener("change", async () => {
                character.name = t.inputEl.value;
                editor.refreshPillLabel(character.id, character.name || "(unnamed)");
                this.rebuildPillGrid("root");
                this.rebuildPillGrid("sidebar");
                await saveRender();
            });
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
        this.addTextSetting(box, {
            name: "Label",
            placeholder: "(unnamed)",
            get: () => set.name,
            set: (v) => {
                set.name = v;
                editor.refreshPillLabel(set.id, v || "(unnamed)");
                this.rebuildPillGrid("commentSet");
            },
            save: () => this.plugin.saveDataFile("streamData"),
        });
        new Setting(box)
            .setName("Comments")
            .setDesc("One comment per line. RiScript: character vars = $name / $epithet / $role / $deed / $topic, character pronouns = $they / $them / $their, inflections = $deed.ing() / .ed() / .s(), inline choices = [a | b], weighted choices = [a(n) | b], lexicon = $rndAdj / $rndNoun / $rndVerb, string = $num<1-9> / $let<5-7> / $mix<2-6> (also $let-lower / $let-upper / $mix-lower / $mix-upper). Any plain line works as-is.");
        this.addBulkTextarea(box, {
            get: () => set.comments,
            set: (lines) => (set.comments = lines),
            save: () => this.plugin.saveDataFile("streamData"),
        });
        new Setting(box)
            .setName("Variables")
            .setDesc("One variable per line. Format = \"variable: a, b, c\".");
        this.addMapTextarea(box, {
            get: () => set.vars,
            set: (m) => (set.vars = m),
            save: () => this.plugin.saveDataFile("streamData"),
        });
    }
}
/* ---------------- plugin ---------------- */
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
    // Reconcile open UI after a save. full=true -> re-render panels. Light repaint otherwise (stream settings apply live). Always reconciles stage.
    applyChange(full = false) {
        this.eachView(full ? (view) => view.render() : (view) => {
            view.paintBackground();
            view.syncAesthetics();
            view.feed.applyFont();
        });
        if (this.stage)
            this.stage.refresh();
    }
}
module.exports = CharacterCompanionPlugin;
