"use strict";
// Declarative registries, schemas, seeds, and defaults — the pure-data layer every other
// module reads. Behaviour tables whose rows call methods on a class instance live next to
// that class instead (SIDEBAR_BUTTONS/FEED_SOURCES in companionview.js, SLOT_OCCUPANTS in
// aesthetics.js, PILL_GRIDS in companionsettingtab.js).
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
// Stream aesthetics: in-panel livestream overlay. Each key toggles a piece — the four corner tickers plus "react", stream mode's bottom-slot occupant (see SLOT_OCCUPANTS). Numbers in styles.css; motion via WAAPI. Add a ticker: row + DOM in Aesthetics.build + CSS.
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
// Program: a scheduled full-panel "broadcast". Lives in program-data.json. 'label' is the admin-only pill label. 'background' is a plain stream-bg-style image field (comma-separated paths/emojis or a folder; drawn once per airing, no swap, no RiScript) — it hijacks the stream backdrop and hides the sprite. 'content' is a RiScript, multi-line script shown one line at a time as a bottom-slot bubble (SLOT_OCCUPANTS); the airing ENDS when the last line's hold elapses. 'schedule' is the airing slider's raw value: 0 = off, 1..59 = that minute past every hour (while the panel is live), 60 = the ":00" step — the top of the hour, stored as 60 so it can't collide with off. The scheduler matches `schedule % 60` against the clock minute.
const PROGRAM_SCHEMA = [
    { key: "label", coerce: str },
    { key: "background", coerce: str },
    { key: "content", coerce: str },
    { key: "schedule", coerce: num(0) },
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
const SEED_NEWS = {
    constants: { source: ["city officials", "unnamed officials", "eyewitnesses", "police sources"], district: ["downtown", "the harbor district", "the old quarter", "Gateway Bridge"] },
    messages: [
        "[BREAKING] $name spotted $deed.ing() near $district, $source confirm",
        "$name, $epithet, declined to comment on $topic this morning",
        "[POLL] 6 in 10 residents now trust a $role more than city hall",
        "[WEATHER] clear skies over $district, no thanks to anyone in particular",
        "[EXCLUSIVE] $source say $name has been $deed.ing() for months",
        "Experts warn $topic could reshape the city within a year",
        "[TRAFFIC] expect delays around $district while $name is busy $deed.ing()",
        "[OPINION] we need to talk about $topic, and about $name",
        "[MARKETS] closed [up | down | flat] after rumors about $topic",
        "[TONIGHT] an in-depth look at the $role everyone keeps talking about",
    ],
};
const SEED_PROGRAM = {
    programs: [{
        id: "seed-program-1", label: "Evening news", schedule: 0,
        background: "📺, 🌃",
        content: "We interrupt your evening for a special bulletin.\nReports place $name near [downtown | the harbor] tonight.\nMore on this story as it develops. Back to you.",
    }],
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
    {
        // News mirrors blog's file shape (flat headline list + constants map); unlike blog its lines also see the character context (see newsCtx). One pool for both news faces (feed beat / chyron).
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
        // Program is a scheduled backdrop takeover, not a feed source: a pill-edited list of programs (PROGRAM_SCHEMA), each with its own airing minute. afterSave runs the shared light reconcile, which re-times every open panel's airing check in place (a schedule edit must reach the scheduler).
        prop: "programData", file: "program-data.json", create: false, seed: () => SEED_PROGRAM,
        shape: (raw) => {
            raw = raw || {};
            return { programs: (Array.isArray(raw.programs) ? raw.programs : []).map((p) => coerceItem(PROGRAM_SCHEMA, p)) };
        },
        afterSave: (p) => p.applyChange(),
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
    // Stored ms between comment bubbles, picked at random in [min, max]. (Every feed source's interval pair follows the `<key>MinMs`/`<key>MaxMs` convention — loadSettings migrates the old streamComment* names.)
    streamMinMs: 10000,
    streamMaxMs: 20000,
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
    // ---- News mode (sidebar panel) ---- A fifth feed source: one-line headlines RiScript-filled against the shown character's context + news-data.json's constants (the mail recipe on the blog shape). One beat timer (a standard feed-source interval), two mutually exclusive faces: the bottom-slot chyron (default; each beat cues one pass — see SLOT_OCCUPANTS) or single comment-feed bubbles. Bulky content lives in news-data.json.
    newsEnabled: false,
    newsMinMs: 120000, // 2 min
    newsMaxMs: 360000, // 6 min
    // The face switch. Off (default): each news beat cues a chyron pass. On: each beat pushes a headline into the comment feed instead, and the chyron stands down.
    newsToFeed: false,
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
module.exports = {
    AESTHETICS, ANIMS_BY_ROLE, ANIM_BY_NAME, ANIM_POOLS, CHARACTER_SCHEMA, CHARACTER_TOGGLES,
    CLEARABLE, COMMENT_SET_SCHEMA, DATA_FILES, DATA_FILE_BY_PROP, DEFAULT_SETTINGS, FLAG_MAPS,
    HOLD_SHAKES, MAIL_SCHEMA, ORACLE_PATRON_FALLBACK, ORACLE_SYS_FALLBACK, PROGRAM_SCHEMA,
    SPECIAL_EFFECTS, VIP_SCHEMA, boolMap, newItem, shapeIsEmpty,
};
