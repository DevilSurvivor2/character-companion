"use strict";
// Declarative registries, schemas, seeds, and defaults — the pure-data layer. Behaviour tables whose rows call methods on a class instance live next to that class instead.
// One row = one cc-anim-<name> class in animations.css. role: surprise/idle (toggleable), sleep/flip/bob/tickle (playRole), effect (internal). directional: keyframes read --cc-dir. root:false excludes it from bottom-of-window walkers.
const ANIMATIONS = [
    // surprise — click reactions.
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
    // function-roles — pulled by name via playRole.
    { name: "flip", role: "flip" },
    { name: "bob", role: "bob" },
    { name: "tickle", role: "tickle", directional: true },
    // effect — internal (held-shake ladder), never pooled.
    { name: "shake-small", role: "effect", directional: true },
    { name: "shake-large", role: "effect", directional: true },
];
const ANIM_BY_NAME = Object.fromEntries(ANIMATIONS.map((a) => [a.name, a]));
const ANIMS_BY_ROLE = {};
for (const a of ANIMATIONS)
    (ANIMS_BY_ROLE[a.role] ??= []).push(a.name);
// Toggleable roles paired with their settings enable-map flag.
const ANIM_POOLS = {
    surprise: { flag: "enabledSurprises", all: ANIMS_BY_ROLE.surprise },
    idle: { flag: "enabledIdles", all: ANIMS_BY_ROLE.idle },
};
// Held-fidget escalation ladder, climbed rung by rung while carried.
const HOLD_SHAKES = ["shake-small", "shake-large"];
// Every anim class, cleared before a new one so they can't stack.
const CLEARABLE = ANIMATIONS.map((a) => "cc-anim-" + a.name);
// Per-character boolean toggles, shown as icon buttons in the editor's Name row.
const CHARACTER_TOGGLES = [
    { key: "curious", icon: "goal", label: "Curious: walk toward the cursor instead of fleeing" },
    { key: "assert", icon: "crown", label: "Assert: push a resting character aside instead of yielding" },
    { key: "escape", icon: "door-open", label: "Escape: wriggle free when held still" },
];
// Stream special effects: each enabled key adds a cc-fx-<key> class to the anchor; buildEffect reads its CSS descriptors to inject particle/layer nodes.
const SPECIAL_EFFECTS = [
    { key: "retro", label: "Retro" },
    { key: "gradient", label: "Gradient" },
    { key: "frame", label: "Frame" },
    { key: "firefly", label: "Fireflies" },
    { key: "square", label: "Squares" },
    { key: "rain", label: "Rain" },
];
const SPECIAL_EFFECT_KEYS = SPECIAL_EFFECTS.map((e) => e.key);
// Stream-overlay pieces: the four corner tickers plus "react" (the bottom-bar occupant).
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
const strList = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
// {name: string[]} map (variables / constants): keep string lists, drop empties.
const strMap = (v) => {
    const out = {};
    if (v && typeof v === "object" && !Array.isArray(v))
        for (const k of Object.keys(v)) {
            const a = strList(v[k]);
            if (a.length) out[k] = a;
        }
    return out;
};
const str = (v) => typeof v === "string" ? v : "";
const bool = (def) => (v) => typeof v === "boolean" ? v : def;
const bounded = (def, min = -Infinity, max = Infinity) => (v) => Math.min(max, Math.max(min, typeof v === "number" && Number.isFinite(v) ? v : def));
const integer = (def, min, max) => (v) => Math.round(bounded(def, min, max)(v));
const oneOf = (def, values) => (v) => values.includes(v) ? v : def;
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Per-list-item schemas: rows of { key, coerce }; coerce(undefined) yields the default. One source for both load (coerceItem) and create (newItem). `id` is implicit.
const CHARACTER_SCHEMA = [
    { key: "name", coerce: str },
    { key: "spritePath", coerce: str },
    { key: "quotes", coerce: strList },
    { key: "walkSpeedPct", coerce: bounded(100, 0, 200) },
    { key: "rootEnabled", coerce: bool(false) },
    { key: "sidebarEnabled", coerce: bool(true) },
    // Stream template vars; all optional, streamCtx() provides safe defaults.
    { key: "epithet", coerce: str },
    { key: "role", coerce: str },
    { key: "pronouns", coerce: str },
    { key: "deeds", coerce: strList },
    { key: "topics", coerce: strList },
    ...CHARACTER_TOGGLES.map((t) => ({ key: t.key, coerce: bool(false) })),
];
const COMMENT_SET_SCHEMA = [
    { key: "name", coerce: str },
    { key: "comments", coerce: strList },
    { key: "enabled", coerce: bool(true) },
    // Per-set variables {name: [...]} — $name choice rules visible only to this set's lines.
    { key: "vars", coerce: strMap },
];
// Oracle VIP (named patron). The reserved var 'topic' is the VIP's match-list: it feeds classifier training, typed-word matching, and the ambient $topic fallback.
const VIP_SCHEMA = [
    { key: "name", coerce: str },
    // In-feed epithet shown in quotes; falls back to name.
    { key: "modifier", coerce: str },
    // Optional patron origin word; empty → random from the pool.
    { key: "origin", coerce: str },
    { key: "enabled", coerce: bool(true) },
    // RiScript: sentence-1 frames + standalone follow-ups.
    { key: "reactions", coerce: strList },
    { key: "asides", coerce: strList },
    // Per-VIP variables {name: [...]}, usable as $name inside frames.
    { key: "vars", coerce: strMap },
];
// Mail template: Title/From/To/Content are RiScript lines. 'name' is the admin pill label.
const MAIL_SCHEMA = [
    { key: "name", coerce: str },
    { key: "title", coerce: str },
    { key: "from", coerce: str },
    { key: "to", coerce: str },
    { key: "content", coerce: str },
    { key: "enabled", coerce: bool(true) },
];
// Program: a scheduled full-panel broadcast. 'background' is a plain stream-bg-style image field (no RiScript, drawn once per airing); 'content' is a multi-line RiScript script. 'schedule': 0 = off, 1..59 = that minute past every hour, 60 = the ":00" step (stored as 60 so it can't collide with off; the scheduler matches `schedule % 60`).
const PROGRAM_SCHEMA = [
    { key: "label", coerce: str },
    { key: "background", coerce: str },
    { key: "content", coerce: str },
    { key: "schedule", coerce: integer(0, 0, 60) },
];
// Normalise a loaded object to exactly its schema fields (drop unknowns), keep/mint its id.
function coerceItem(schema, raw) {
    raw = isRecord(raw) ? raw : {};
    const out = { id: typeof raw.id === "string" ? raw.id : genId() };
    for (const f of schema)
        out[f.key] = f.coerce(raw[f.key]);
    return out;
}
const coerceList = (schema, value) => Array.isArray(value) ? value.filter(isRecord).map((item) => coerceItem(schema, item)) : [];
function newItem(schema, overrides) {
    const out = { id: genId() };
    for (const f of schema)
        out[f.key] = f.coerce(undefined);
    return Object.assign(out, overrides);
}
// First-run seed trigger: a shaped file is "empty" when every array value is empty (non-list values like activeCharacterId or constants don't count).
const shapeIsEmpty = (o) => Object.values(o).every((v) => !Array.isArray(v) || v.length === 0);
// Shipped starter content for first-run seeding.
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
const SEED_NEWS = {
    constants: {
        source: ["leaked document", "press release", "police report", "eyewitness", "unnamed official", "social media post", "rumor", "conspiracy theory", "urban legend"],
        villain: ["mastermind", "ringleader", "gangster", "mobster", "assassin", "murderer", "drug dealer", "pimp", "felon", "perpetrator", "offender", "robber", "burglar", "mugger", "thief", "crook", "hoodlum", "thug", "goon", "lackey"],
        civilian: ["resident", "citizen", "denizen", "bystander", "onlooker", "office worker", "laborer"],
        district: ["northside", "southside", "eastside", "westside", "uptown", "midtown", "downtown", "oldtown", "newtown", "heights", "flats", "waterfront", "riverside", "bayside", "quayside", "suburbs", "outskirts", "estates", "enclave", "commune", "tenements", "projects", "slums", "bazaar", "supermarket", "mall", "promenade", "theater district", "red-light district", "campus", "library", "museum", "park", "zoo", "stadium", "temple", "graveyard", "embassy", "precinct", "garrison", "citadel", "factories", "foundry", "refinery", "powerplant", "warehouses", "docks", "shipyard", "trainyard", "airport", "metro", "sewers", "crossroads"],
    },
    messages: [
        "[BREAKING] $name [seen | spotted] $deed.ing() [near | around] $district",
        "[EXCLUSIVE] $source.pluralize() say $name has been $deed.ing() for [days | months | years]",
        "[UPDATE] $name's whereabouts still unknown",
        "$name, $epithet, declined to comment on $topic this [morning | afternoon | evening]",
        "[POLL] [6 | 7 | 8 | 9] in 10 $civilian.pluralize() now [agree with | approve of | trust | endorse] $role.pluralize() more than [city hall | the police]",
        "\"Never [thought | believed | considered] $name would be the one to help us,\" one $civilian commented",
        "Authorities are investigating $name's alleged involvement in a [string of | spate of] $rndAdj [crimes | scandals], but no [evidence | proof | wrongdoing] has [come to light | surfaced | turned up] [yet | thus far | so far | to date]",
        "[CRIME] police [now brand | have labelled | openly call] $name the $rndAdj $villain [behind | at the heart of | pulling the strings on] [last night's | this morning's] [break-ins | disappearances | disturbances] [near | around | across] $district",
        "[WEATHER] [fog over $district through the evening, with visibility low | clear skies over $district | storm clouds gathering on the horizon | expect $num<1-2>°C today, with a [high | low] chance of [rain | snow | sleet | hail | sunshine | moonshine] tonight]",
        "[MARKETS] $name futures [up | down | flat] on rumors of [$topic | $deed.ing()]",
        "Experts warn $topic could reshape $district within a [day | month | year]",
        "[TRAFFIC] expect delays around $district while $name is busy $deed.ing()",
        "[TALK SHOW] an in-depth look at the $role everyone keeps talking about, tonight at [8 | 9 | 10 | 11] PM on Channel $num<1>",
        "[BEST-SELLING] $name's new biography, \"$epithet in the Age of $topic\", hits shelves this weekend to [mixed | rave] reviews",
        "our local $role is [making headlines | trending | going viral] [once | yet] again after [recent | the latest] [events | incidents | accidents]",
        "$epithet has sparked [debate | outrage | support] on social media",
        "[STATS] $num<1-2>% rise in $role sightings",
    ],
};
const SEED_PROGRAM = {
    programs: [{
        id: "seed-program-1", label: "Evening news", schedule: 0,
        background: "📺, 🌃",
        content: "We interrupt your evening for a special bulletin.\nReports place $name near [downtown | the harbor] tonight.\nMore on this story as it develops. Back to you.",
    }],
};
// Sibling data files (kept out of data.json); one row drives the generic load/save. Fields: prop (plugin field), file, shape (raw)=>in-memory object, create (write when genuinely MISSING, never on corrupt), seed (inline first-run content; omit to fall back to src/data/<file>, else ship empty), afterSave (side effects).
const DATA_FILES = [
    {
        prop: "characterData", file: "character-data.json", create: true, seed: () => SEED_CHARACTERS,
        shape: (raw) => {
            const characters = coerceList(CHARACTER_SCHEMA, raw && raw.characters);
            // Active id must point at a surviving character.
            let activeId = raw && typeof raw.activeCharacterId === "string" ? raw.activeCharacterId : null;
            if (!characters.some((c) => c.id === activeId))
                activeId = characters.length > 0 ? characters[0].id : null;
            return { characters, activeCharacterId: activeId };
        },
        afterSave: (p, rerender) => p.applyChange(rerender),
    },
    {
        prop: "streamData", file: "stream-data.json", create: true, seed: () => SEED_STREAM,
        shape: (raw) => {
            return { commentSets: coerceList(COMMENT_SET_SCHEMA, raw && raw.commentSets) };
        },
    },
    {
        // No inline seed: the bulky default lives in src/data/oracle-data.json and is resolved by the loader's DATA_SEEDS fallback.
        prop: "oracleData", file: "oracle-data.json", create: false,
        shape: (raw) => {
            raw = raw || {};
            return {
                sysTemplates: strList(raw.sysTemplates),
                anonTemplates: strList(raw.anonTemplates),
                vips: coerceList(VIP_SCHEMA, raw.vips),
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
                mailTemplates: coerceList(MAIL_SCHEMA, raw.mailTemplates),
                constants: strMap(raw.constants),
            };
        },
    },
    {
        // Blog is a flat line list + constants map — no per-item schema.
        prop: "blogData", file: "blog-data.json", create: false, seed: () => SEED_BLOG,
        shape: (raw) => {
            raw = raw || {};
            return {
                messages: strList(raw.messages),
                constants: strMap(raw.constants),
            };
        },
    },
    {
        // News mirrors blog's shape; one pool serves both news faces (feed beat / chyron).
        prop: "newsData", file: "news-data.json", create: false, seed: () => SEED_NEWS,
        shape: (raw) => {
            raw = raw || {};
            return {
                messages: strList(raw.messages),
                constants: strMap(raw.constants),
            };
        },
    },
    {
        // afterSave reconciles the open panels so a schedule edit reaches the scheduler.
        prop: "programData", file: "program-data.json", create: false, seed: () => SEED_PROGRAM,
        shape: (raw) => {
            raw = raw || {};
            return { programs: coerceList(PROGRAM_SCHEMA, raw.programs) };
        },
        afterSave: (p) => p.applyChange(),
    },
];
const DATA_FILE_BY_PROP = Object.fromEntries(DATA_FILES.map((d) => [d.prop, d]));
// data.json holds only scalars + the enable maps; bulky content lives in the DATA_FILES.
// Scalar settings: one row owns its default and persisted-data coercion.
const SETTINGS_SCHEMA = [
    { key: "sidebarSpriteMaxHeight", coerce: bounded(300, 100, 500) },
    { key: "rootSpriteMaxHeight", coerce: bounded(150, 100, 500) },
    { key: "rootWalkSpeed", coerce: bounded(20, 10, 50) },
    { key: "quoteDurationMs", coerce: bounded(3000, 1000, 5000) },
    { key: "quoteTypewriter", coerce: oneOf("off", ["off", "slow", "fast"]) },
    { key: "surpriseChance", coerce: bounded(20, 0, 100) },
    { key: "animateOnQuote", coerce: bool(true) },
    { key: "idleEnabled", coerce: bool(true) },
    { key: "chatterChance", coerce: bounded(25, 0, 100) },
    { key: "sleepAfterMs", coerce: bounded(120000, 60000, 3600000) },
    { key: "streamEnabled", coerce: bool(false) },
    { key: "streamBackgrounds", coerce: (v) => typeof v === "string" ? v : "🌃" },
    { key: "streamBgMinMs", coerce: bounded(600000, 60000, 3600000) },
    { key: "streamBgMaxMs", coerce: bounded(1200000, 60000, 3600000) },
    { key: "streamMinMs", coerce: bounded(10000, 5000, 30000) },
    { key: "streamMaxMs", coerce: bounded(20000, 5000, 30000) },
    { key: "streamHistoryCount", coerce: integer(6, 1, 15) },
    { key: "oracleEnabled", coerce: bool(false) },
    { key: "oracleSystemName", coerce: str },
    { key: "oraclePatronName", coerce: str },
    { key: "oracleSysMinMs", coerce: bounded(20000, 5000, 180000) },
    { key: "oracleSysMaxMs", coerce: bounded(45000, 5000, 180000) },
    { key: "oracleAnonMinMs", coerce: bounded(15000, 5000, 180000) },
    { key: "oracleAnonMaxMs", coerce: bounded(30000, 5000, 180000) },
    { key: "oracleVipMinMs", coerce: bounded(12000, 5000, 180000) },
    { key: "oracleVipMaxMs", coerce: bounded(25000, 5000, 180000) },
    { key: "oracleVipReactsToTyping", coerce: bool(true) },
    { key: "mailEnabled", coerce: bool(false) },
    { key: "mailMinMs", coerce: bounded(900000, 60000, 3600000) },
    { key: "mailMaxMs", coerce: bounded(2400000, 60000, 3600000) },
    { key: "blogEnabled", coerce: bool(false) },
    { key: "blogMinMs", coerce: bounded(60000, 30000, 1800000) },
    { key: "blogMaxMs", coerce: bounded(180000, 30000, 1800000) },
    { key: "newsEnabled", coerce: bool(false) },
    { key: "newsMinMs", coerce: bounded(120000, 30000, 1800000) },
    { key: "newsMaxMs", coerce: bounded(360000, 30000, 1800000) },
    { key: "newsToFeed", coerce: bool(false) },
    { key: "commentFont", coerce: str },
    { key: "giftEmojiFont", coerce: str },
    { key: "giftEmojis", coerce: str },
];
// Oracle name fallbacks, doubling as the settings placeholders.
const ORACLE_SYS_FALLBACK = "Star Stream";
const ORACLE_PATRON_FALLBACK = "Constellation";
// The enable maps: [settings key, names, default]. One row drives both the defaults and loadSettings' re-normalisation (keep known flags, default newly added names).
const FLAG_MAPS = [
    ...Object.values(ANIM_POOLS).map((p) => [p.flag, p.all, true]),
    ["enabledEffects", SPECIAL_EFFECT_KEYS, false],
    ["enabledAesthetics", AESTHETIC_KEYS, true],
];
function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
module.exports = {
    AESTHETICS, ANIMS_BY_ROLE, ANIM_BY_NAME, ANIM_POOLS, CHARACTER_SCHEMA, CHARACTER_TOGGLES,
    CLEARABLE, COMMENT_SET_SCHEMA, DATA_FILES, DATA_FILE_BY_PROP, FLAG_MAPS, SETTINGS_SCHEMA,
    HOLD_SHAKES, MAIL_SCHEMA, ORACLE_PATRON_FALLBACK, ORACLE_SYS_FALLBACK, PROGRAM_SCHEMA,
    SPECIAL_EFFECTS, VIP_SCHEMA, boolMap, newItem, shapeIsEmpty,
};
