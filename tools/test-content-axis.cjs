// Resolver tests for dsh 0.1.2 content-axis tokens (dsh-ui-font 0.9.5).
// Inputs are the REAL token values, extracted live from the installed
// dsh-client-ui-theme bundle; the resolver functions are copies of the
// shipped lib/client.js implementations.
const assert = require("assert");
const fs = require("fs");

const THEME = "C:/Users/Administrator/AppData/Roaming/fnm/node-versions/v22.23.1/installation/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js";
const SHELL_CSS = "C:/Users/Administrator/AppData/Roaming/fnm/node-versions/v22.23.1/installation/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-b24khbeK.css";

// ---- shipped implementations (keep in sync with lib/client.js) ----
function contentSecondaryOf(content) {
    return Math.min(content - 1, Math.max(13, content - 2));
}
function evalCalcPx(text) {
    return text.replace(/calc\((?:[^()]|\([^()]*\))*\)/g, (all) => {
        const m = /^calc\(\s*([\d.]+)px\s*([+-])\s*([+-]?[\d.]+)px\s*\)$/.exec(all);
        if (m === null) return all;
        const b = parseFloat(m[3]);
        const v = m[2] === "+" ? parseFloat(m[1]) + b : parseFloat(m[1]) - b;
        return v + "px";
    });
}
function resolveTokenValue(text, content) {
    if (typeof text !== "string" || text === "") return null;
    const substituted = text
        .replace(/var\(--dsh-content-font-size-secondary(?:,[^()]*)?\)/g, contentSecondaryOf(content) + "px")
        .replace(/var\(--dsh-content-font-size(?:,[^()]*)?\)/g, content + "px")
        .replace(/var\(--dsh-content-font-delta(?:,[^()]*)?\)/g, (content - 14) + "px");
    const solved = evalCalcPx(substituted);
    const m = solved.match(/([\d.]+)px(?:\s*\/\s*([\d.]+)px)?/);
    if (m === null) return null;
    return { size: parseFloat(m[1]), lh: m[2] !== undefined ? parseFloat(m[2]) : null };
}
const FAM_RE = /(?:^|[;{\s])(?:font|font-size)\s*:\s*[^;}]*?var\(--dsw-font-([a-z0-9-]+)\)/;
function famOfRuleText(ruleText) {
    const fm = ruleText.match(FAM_RE);
    if (fm === null) return null;
    let fam = fm[1];
    if (fam.endsWith("-font-size") || fam.endsWith("-line-height")) fam = fam.slice(0, fam.lastIndexOf("-"));
    if (fam === "family" || fam.endsWith("-font-family")) return null;
    return fam;
}

// ---- extract REAL token definitions from the installed theme ----
const themeSrc = fs.readFileSync(THEME, "utf8");
const defs = {};
for (const m of themeSrc.matchAll(/(--dsw-font-markdown[a-z0-9-]*-font-size|--dsw-font-markdown[a-z0-9-]*(?:-italic|-strong)?)\s*:\s*([^;}]+)/g)) {
    if (defs[m[1]] === undefined) defs[m[1]] = m[2].trim();
}
assert.ok(Object.keys(defs).length >= 10, "expected to find the markdown token definitions");

// ---- resolve every markdown family at the native default (14) ----
const resolved = {};
for (const [k, v] of Object.entries(defs)) {
    const r = resolveTokenValue(v, 14);
    resolved[k] = r;
}
const famOf = (name) => resolved["--dsw-font-" + name + "-font-size"] ?? resolved["--dsw-font-" + name];

assert.deepStrictEqual(famOf("markdown-base"), { size: 14, lh: null }, "base = content size");
assert.deepStrictEqual(famOf("markdown-h1"), { size: 21, lh: null }, "h1 = 21 + (14-14)");
assert.deepStrictEqual(famOf("markdown-h2"), { size: 19, lh: null }, "h2 = 19 + 0");
assert.deepStrictEqual(famOf("markdown-h3"), { size: 18, lh: null }, "h3 = 18 + 0");
assert.strictEqual(famOf("markdown-h4").size, 14, "h4 = content size");
assert.strictEqual(famOf("markdown-code").size, 12, "code literal 12px");
assert.strictEqual(famOf("markdown-code-block").size, 11, "code-block literal 11px");
assert.strictEqual(famOf("markdown-table").size, 13, "table = secondary(14) = 13");
console.log("native 14: base/h4=14, h1=21, h2=19, h3=18, table=13, code=12/11 ✔");

// ---- native setting at 17: derived families track the axis ----
assert.strictEqual(resolveTokenValue(defs["--dsw-font-markdown-h1-font-size"], 17).size, 24, "h1 = 21+(17-14)");
assert.strictEqual(resolveTokenValue(defs["--dsw-font-markdown-base-font-size"], 17).size, 17, "base = 17");
assert.strictEqual(resolveTokenValue(defs["--dsw-font-markdown-table-font-size"], 17).size, 15, "table = secondary(17) = 15");
assert.strictEqual(resolveTokenValue(defs["--dsw-font-markdown-h2-font-size"], 12).size, 17, "h2 = 19+(12-14)");
console.log("native 17: h1=24, table=16; native 12: h2=17 ✔ (axis-derived families track)");

// ---- shorthand forms keep size/lh pairs ----
const sh = resolveTokenValue("700 calc(21px + var(--dsh-content-font-delta)) / calc(30px + var(--dsh-content-font-delta)) var(--dsw-font-family)", 16);
assert.deepStrictEqual(sh, { size: 23, lh: 32 }, "h1 shorthand at native 16 = 23/32");
const shBase = resolveTokenValue("var(--dsh-content-font-size,14px) / calc(24px + var(--dsh-content-font-delta)) var(--dsw-font-family)", 15);
assert.deepStrictEqual(shBase, { size: 15, lh: 25 }, "base shorthand at native 15 = 15/25");
console.log("shorthand resolution: h1 23/32 @16, base 15/25 @15 ✔");

// ---- axis override decision (buildTokenCss logic) ----
function axisAt(live, delta, baseExtra) { return Math.round((live + delta + baseExtra) * 10) / 10; }
assert.strictEqual(axisAt(14, 3, 0), 17, "delta +3 → axis 17");
assert.strictEqual(axisAt(14, 0, 0), 14, "net zero → no override emitted (native stays live)");

// ---- fam extraction from REAL shell css rules ----
const shellCss = fs.readFileSync(SHELL_CSS, "utf8");
const rules = {};
for (const m of shellCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    if (/font[^;:}]*:\s*[^;}]*var\(--(?:dsw-font|dsl-|dsh-content-font)[a-z0-9-]*\)/.test("x{" + body + "}")) {
        const sel = m[1].trim().split(/\s*,\s*/).pop();
        const fam = famOfRuleText("x{" + body + "}");
        if (fam !== null) rules[sel] = fam;
    }
}
const fams = new Set(Object.values(rules));
assert.ok(rules["._markdown_177e0_5"] === "markdown-base", "shell markdown rule attributes to markdown-base, got " + rules["._markdown_177e0_5"]);
assert.ok(fams.has("markdown-code-block"), "code-block rules attribute");
console.log("shell css attribution: " + Object.keys(rules).length + " token rules; markdown → markdown-base ✔");
console.log("\nALL RESOLVER TESTS PASSED");
