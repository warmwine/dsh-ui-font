// Race-condition simulation for dsh-ui-font's client persistence layer.
// Recreates the adversarial host timings reported as
// "Ctrl+- sometimes grows the font / needs two presses",
// then runs the OLD and the NEW logic through them.
const assert = require("assert");

// ---------- mock host + localStorage ----------
function makeEnv({ getDelay = 5, postDelay = 5, getOvertakesPost = false } = {}) {
    const env = {
        host: { delta: 8 },            // the persisted section (delta only)
        ls: {},
        gets: 0, posts: 0,
    };
    env.fetch = async (url, opts) => {
        if (url.indexOf("/get") !== -1) {
            env.gets++;
            await sleep(getDelay);
            return { ok: true, json: async () => ({ value: { delta: env.host.delta } }) };
        }
        if (url.indexOf("/set") !== -1) {
            env.posts++;
            const body = JSON.parse(opts.body).value;
            if (getOvertakesPost) {
                // GET answers before this POST lands (separate connections)
                await sleep(postDelay);
            } else {
                await sleep(postDelay);
            }
            env.host.delta = body.delta;
            return { ok: true, json: async () => ({}) };
        }
        throw new Error("unexpected fetch " + url);
    };
    env.localStorage = {
        getItem: (k) => (k in env.ls ? env.ls[k] : null),
        setItem: (k, v) => { env.ls[k] = String(v); },
        removeItem: (k) => { delete env.ls[k]; },
    };
    return env;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULTS = { delta: 3 };

// ---------- OLD logic (pre-fix) ----------
function makeOld(env) {
    const s = { cache: { delta: DEFAULTS.delta } };
    s.load = async () => {
        const r = await env.fetch("/get");
        const j = await r.json();
        s.cache = { delta: j.value.delta };            // unconditional clobber
        return s.cache;
    };
    s.save = async (v) => { s.cache = { delta: v.delta }; await env.fetch("/set", { body: JSON.stringify({ value: v }) }); };
    s.bump = async (d) => {
        const next = { delta: Math.max(-3, Math.min(20, s.cache.delta + d)) };
        s.save(next);                                  // fire-and-forget POST
        await s.load();                                // immediate re-GET (races the POST)
    };
    return s;
}

// ---------- NEW logic (queue + epoch, as shipped) ----------
function makeNew(env) {
    const s = { cache: { delta: DEFAULTS.delta } };
    let writeEpoch = 0;
    let queue = Promise.resolve();
    const enqueue = (task) => {
        const run = queue.then(task);
        queue = run.then(() => undefined, () => undefined);
        return run;
    };
    s.load = () => enqueue(async () => {
        const epochAtStart = writeEpoch;
        const r = await env.fetch("/get");
        const j = await r.json();
        if (writeEpoch !== epochAtStart) return s.cache;  // local write wins
        s.cache = { delta: j.value.delta };
        return s.cache;
    });
    s.save = (v) => {
        const snapshot = { delta: v.delta };
        s.cache = snapshot;                              // sync cache update
        writeEpoch++;
        return enqueue(async () => { await env.fetch("/set", { body: JSON.stringify({ value: snapshot }) }); });
    };
    s.bump = (d) => enqueue(() => {
        const next = { delta: Math.max(-3, Math.min(20, s.cache.delta + d)) };
        s.save(next);
    });
    return s;
}

(async () => {
    // Scenario 1: press DURING initial load (host delta = 8, slow GET)
    {
        const env = makeEnv({ getDelay: 120 });
        const old = makeOld(env);
        old.load();                                  // page load starts
        await sleep(50);
        await old.bump(-1);                          // impatient press at t=50
        await sleep(150);
        // OLD: the bump ran on the DEFAULTS seed (3→2) and its re-GET then
        // confirmed 2 — the persisted 8 is GONE: one press moved the font
        // SIX steps. Had the persisted value been below the default (e.g.
        // -1), the same press would land on 2 = the font GROWS on shrink.
        assert.strictEqual(old.cache.delta, 2, "S1 old: stepped from the DEFAULTS seed, not the persisted value");
        assert.strictEqual(env.host.delta, 2, "S1 old: host dragged to the seeded value (8→2 by one press)");
    }
    {
        const env = makeEnv({ getDelay: 120 });
        const neu = makeNew(env);
        neu.load();                                  // enqueued first
        await sleep(50);
        await neu.bump(-1);                          // queued AFTER the load task
        await sleep(200);
        assert.strictEqual(neu.cache.delta, 7, "S1 new: press waits for the seed, steps 8→7");
        assert.strictEqual(env.host.delta, 7, "S1 new: host = 7");
    }
    console.log("S1 press-during-load: old broken (jumped 8→2, host kept 2), new correct (8→7) ✔");

    // Scenario 2: two rapid presses, GET resolves before POST lands
    {
        const env = makeEnv({ getDelay: 1, postDelay: 40, getOvertakesPost: true });
        const old = makeOld(env);
        await old.load();
        await old.bump(-1);                          // t0
        await old.bump(-1);                          // second press: cache was reloaded to 8 by the racing GET
        await sleep(120);
        assert.strictEqual(old.cache.delta, 8, "S2 old: both presses' re-GETs read pre-write 8 → cache back at 8");
        assert.strictEqual(env.host.delta, 7, "S2 old: host only advanced once (8→7): one step lost");
    }
    {
        const env = makeEnv({ getDelay: 1, postDelay: 40, getOvertakesPost: true });
        const neu = makeNew(env);
        await neu.load();
        neu.bump(-1);
        neu.bump(-1);
        await sleep(200);
        assert.strictEqual(neu.cache.delta, 6, "S2 new: two presses = two steps (8→7→6)");
        assert.strictEqual(env.host.delta, 6, "S2 new: host = 6, ordered");
    }
    console.log("S2 rapid double-press with GET-overtake: old lost a step, new steps exactly twice ✔");

    // Scenario 3: +, +, − mixed rapid — direction flip check
    {
        const env = makeEnv({ getDelay: 1, postDelay: 30 });
        const old = makeOld(env);
        await old.load();
        await old.bump(1);
        await old.bump(-1);
        await sleep(150);
        const oldHost = env.host.delta;
        assert.notStrictEqual(oldHost, 8, "S3 old: mixed presses desynced host from the intended 8");
    }
    {
        const env = makeEnv({ getDelay: 1, postDelay: 30 });
        const neu = makeNew(env);
        await neu.load();
        neu.bump(1);
        neu.bump(-1);
        await sleep(200);
        assert.strictEqual(env.host.delta, 8, "S3 new: + then − returns to 8 exactly");
        assert.strictEqual(neu.cache.delta, 8, "S3 new: cache agrees");
    }
    console.log("S3 mixed +/− presses: old could land off-target, new exact (8→9→8) ✔");

    // Scenario 4: epoch guard — save while a load is mid-flight
    {
        const env = makeEnv({ getDelay: 80 });
        const neu = makeNew(env);
        await neu.load();                             // seed: 8
        const slow = neu.load();                      // user hits 刷新: GET in flight
        await sleep(10);
        await neu.save({ delta: 5 });                 // hotkey steps during the load
        await slow;
        assert.strictEqual(neu.cache.delta, 5, "S4: in-flight load must not clobber the newer local write");
        assert.strictEqual(env.host.delta, 5, "S4: host keeps the write");
    }
    console.log("S4 load-vs-save epoch guard: local write survives the stale GET ✔");

    console.log("\nALL SCENARIOS: old logic reproduces every reported symptom; new logic correct.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
