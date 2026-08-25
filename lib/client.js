// dsh-ui-font v0.2 — runtime font engine + settings page.
//
// Discovery model: the page IS the registry.
//   - every client plugin injects <style data-plugin="..." data-plugin-css="...">
//     tags; we walk document.styleSheets, group hardcoded font rules by plugin,
//     and re-emit them with the user's per-plugin delta.
//   - the shell's own <link> stylesheet is the source of stock --dsw-font-*
//     token values; we read them at runtime and re-emit scaled tokens.
//   - a MutationObserver on <head> re-scans when plugins (de)register styles.
// Settings persist in localStorage (dsh.uiFont.v1) and apply instantly.
//
// Fonts (system-level, no bundled files):
//   "LXGW WenKai" / "LXGW WenKai Mono" — installed for this user.
window.__ModuleLoader__.load({
    id: "dsh-ui-font",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;

        const React = require("react");

        const PLUGIN_ID = "dsh-ui-font";
        const STYLE_TAG_ID = "dsh-ui-font/overrides";
        const LS_KEY = "dsh.uiFont.v1";

        /* ---------------- font stacks ----------------
           The selectable values are real system font family names, enumerated
           by the host half (sfnt name-table parsing) on demand. "" = the
           shell's stock stack. Stacks are built from the chosen family. */
        const UI_FALLBACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
        const CODE_FALLBACK = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

        /** Old settings keys (< 0.4) -> representative family names. */
        const LEGACY_UI = { wenkai: "LXGW WenKai", mono: "LXGW WenKai Mono", yahei: "Microsoft YaHei", system: "" };
        const LEGACY_CODE = { lxgw: "LXGW WenKai Mono", system: "" };

        /** Family names go into CSS unquoted-context strings: keep them to
           sane name characters and a sane length (also CSS-injection proof). */
        function sanitizeFamily(f) {
            if (typeof f !== "string") return "";
            const t = f.trim();
            if (t.length === 0 || t.length > 64) return "";
            // letters (any script), digits, spaces, hyphens, underscores, dots, +, &
            for (const ch of t) {
                const ok = /[A-Za-z0-9_\-.+& ]/u.test(ch) || /[\u00a0-\uffff]/.test(ch);
                if (ok === false) return "";
            }
            return t;
        }
        function uiStack(family) {
            const f = sanitizeFamily(family);
            return f === "" ? UI_FALLBACK : '"' + f + '", ' + UI_FALLBACK;
        }
        function codeStack(family) {
            const f = sanitizeFamily(family);
            return f === "" ? CODE_FALLBACK : '"' + f + '", ' + CODE_FALLBACK;
        }

        /* Fallback stock sizes if the shell :root rule can't be read. */
        const STOCK_FALLBACK = {
            "markdown-base": 16, "markdown-base-strong": 16, "markdown-base-italic": 16, "markdown-base-strong-italic": 16,
            "markdown-h1": 24, "markdown-h2": 22, "markdown-h3": 20, "markdown-h4": 16,
            "markdown-code": 14, "markdown-code-block": 13, "markdown-code-block-small": 12,
            "markdown-small": 12, "markdown-table": 14, "markdown-table-head": 14,
            "xxxs-11": 11, "xxxs-strong-11": 11, "xxs-12": 12, "xxs-strong-12": 12,
            "xs-13": 13, "xs-strong-13": 13, "s-14": 14, "s-strong-14": 14,
            "base-16": 16, "base-strong-16": 16, "m-18": 16, "l-20": 20, "xl-24": 24
        };

        /** Uniform display name for any scanned source id: drop the npm scope,
            keep the package name ("@deepseek-ai/dsh-client-ui-foo" -> "dsh-client-ui-foo").
            The engine holds zero knowledge about other plugins — ids are
            discovered at runtime and rendered as-is. */
        function prettifyId(id) {
            if (id.charCodeAt(0) === 64 /* @ */) {
                const slash = id.indexOf("/");
                if (slash !== -1) return id.slice(slash + 1);
            }
            return id;
        }

        /* ---------------- hotkey combo helpers ---------------- */
        /** code <-> short-name table for non-letter/digit keys (=, -, etc.). */
        const KEY_ALIASES = { "Equal": "=", "Minus": "-", "Plus": "+", "Comma": ",", "Period": ".", "Slash": "/", "Backquote": "`", "BracketLeft": "[", "BracketRight": "]", "Semicolon": ";", "Quote": "'", "Backslash": "\\", "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right" };
        const KEY_ALIASES_REV = {};
        for (const entry of Object.entries(KEY_ALIASES)) KEY_ALIASES_REV[entry[1]] = entry[0];

        /** Canonical label of a keydown combo: modifiers (in fixed order) +
            main key, e.g. "Ctrl+Alt+F" or "Ctrl+=". Empty main key never
            happens (modifier-only presses are filtered by the recorder). */
        function comboOf(e) {
            const parts = [];
            if (e.ctrlKey) parts.push("Ctrl");
            if (e.altKey) parts.push("Alt");
            if (e.shiftKey) parts.push("Shift");
            if (e.metaKey) parts.push("Meta");
            let key = e.code;
            const m = key.match(/^Key([A-Z])$/);
            if (m !== null) key = m[1];
            else {
                const d = key.match(/^Digit(\d)$/);
                if (d !== null) key = d[1];
                else if (KEY_ALIASES[key] !== undefined) key = KEY_ALIASES[key];
            }
            parts.push(key);
            return parts.join("+");
        }

        /** Does a keydown match the stored combo label? "" never matches. */
        function comboMatches(stored, e) {
            if (typeof stored !== "string" || stored === "") return false;
            const parts = stored.split("+");
            const code = parts[parts.length - 1];
            const want = (name) => parts.indexOf(name) !== -1;
            if (e.ctrlKey !== want("Ctrl")) return false;
            if (e.altKey !== want("Alt")) return false;
            if (e.shiftKey !== want("Shift")) return false;
            if (e.metaKey !== want("Meta")) return false;
            let expected = code;
            if (/^[A-Z]$/.test(code)) expected = "Key" + code;
            else if (/^\d$/.test(code)) expected = "Digit" + code;
            else if (KEY_ALIASES_REV[code] !== undefined) expected = KEY_ALIASES_REV[code];
            return e.code === expected;
        }

        /** Modifier-only keys (which the recorder waits through). */
        function isModifierCode(code) {
            return code.startsWith("Control") || code.startsWith("Shift") || code.startsWith("Alt") || code.startsWith("Meta");
        }

        /* ---------------- settings store ----------------
           Persistence lives on the DSH host in two layers:

           * primary:   settings.yaml via `/api/dsh-ui-font/settings/{get,set}`
             (host half owns the schema; per-field validation happens there).
           * fallback:  localStorage under `LS_KEY`, used as a one-shot
             migration source on first load and as an offline cache when the
             host is unreachable. Once a value has round-tripped through the
             host, the localStorage copy is removed — the host is canonical.

           `loadSettings` and `saveSettings` are async; all callers either
           `await` them (the engine path) or fall back to a sync shadow copy
           `localCache` for instant UI updates inside event handlers (the
           picker path). The shadow is updated synchronously before the host
           write, so a click on `-`/`+` never waits on the network. */
        const DEFAULTS = { uiFont: "LXGW WenKai", codeFont: "LXGW WenKai Mono", delta: 3, perPlugin: {}, perRule: {}, perToken: {}, hotkey: "", hotkeyUp: "", hotkeyDown: "" };
        const SETTINGS_NS = "ui-font";
        /** Valid combo-string check (shared by the three hotkey slots). */
        function validCombo(v) {
            return typeof v === "string" && v.length <= 30;
        }
        /* Human labels for the token families the picker can target. Families
           not listed fall back to the raw name. */
        const TOKEN_LABELS = {
            "markdown-base": "聊天正文",
            "markdown-base-strong": "正文加粗",
            "markdown-base-italic": "正文斜体",
            "markdown-h1": "标题一",
            "markdown-h2": "标题二",
            "markdown-h3": "标题三",
            "markdown-h4": "标题四",
            "markdown-small": "小字说明",
            "markdown-code": "行内代码",
            "markdown-code-block": "代码块",
            "markdown-code-block-small": "代码块（小）",
            "markdown-table": "表格",
            "markdown-table-head": "表头",
            "xxxs-11": "界面文字 · 极小",
            "xxs-12": "界面文字 · 更小",
            "xs-13": "界面文字 · 小",
            "s-14": "界面文字 · 中",
            "base-16": "界面文字 · 常规",
            "m-18": "界面文字 · 大",
            "l-20": "界面文字 · 更大",
            "xl-24": "界面文字 · 标题"
        };
        /** Sanitize + fill defaults for any incoming section. Same rules as
           the pre-routes engine: legacy alias map, sanitizeFamily guard,
           range clamp on numeric deltas. Returns a fresh plain object. */
        function validateSettings(s) {
            const fallback = Object.assign({}, DEFAULTS);
            if (s === null || typeof s !== "object") return fallback;
            const legacyUi = typeof s.uiFont === "string" && LEGACY_UI[s.uiFont] !== undefined ? LEGACY_UI[s.uiFont] : undefined;
            const legacyCode = typeof s.codeFont === "string" && LEGACY_CODE[s.codeFont] !== undefined ? LEGACY_CODE[s.codeFont] : undefined;
            return {
                uiFont: legacyUi !== undefined ? legacyUi : sanitizeFamily(s.uiFont) || fallback.uiFont,
                codeFont: legacyCode !== undefined ? legacyCode : sanitizeFamily(s.codeFont) || fallback.codeFont,
                delta: typeof s.delta === "number" && s.delta >= -3 && s.delta <= 20 ? Math.round(s.delta) : fallback.delta,
                perPlugin: (s.perPlugin !== null && typeof s.perPlugin === "object") ? s.perPlugin : {},
                perRule: (s.perRule !== null && typeof s.perRule === "object") ? s.perRule : {},
                perToken: (s.perToken !== null && typeof s.perToken === "object") ? s.perToken : {},
                hotkey: validCombo(s.hotkey) ? s.hotkey : "",
                hotkeyUp: validCombo(s.hotkeyUp) ? s.hotkeyUp : "",
                hotkeyDown: validCombo(s.hotkeyDown) ? s.hotkeyDown : ""
            };
        }
        /** Synchronous shadow of the last-known persisted section. Kept in
           a closure so picker event handlers can read/write without awaiting
           the host round-trip; the engine writes to it before the host write
           so the next `reapply` sees the same value either way. */
        let localCache = validateSettings(null);
        let hostAvailable = false;
        /** Resolve any persisted section: host first, then localStorage. On
           first load, if the host has no value but localStorage does, push
           the local copy up and clear the local copy so subsequent loads
           skip the migration. */
        async function loadSettings() {
            const fromLs = (() => {
                try {
                    const raw = localStorage.getItem(LS_KEY);
                    if (raw === null) return null;
                    return validateSettings(JSON.parse(raw));
                } catch (e) { return null; }
            })();
            try {
                const r = await fetch("/api/dsh-ui-font/settings/get?key=" + encodeURIComponent(SETTINGS_NS), { headers: { "accept": "application/json" } });
                if (!r.ok) throw new Error("http " + r.status);
                const j = await r.json();
                hostAvailable = true;
                if (j.value !== null && j.value !== undefined && typeof j.value === "object") {
                    const validated = validateSettings(j.value);
                    localCache = validated;
                    /* Host is canonical: any localStorage copy is now stale.
                       Leave it on disk so an offline reload still works, but
                       prefer the host on every subsequent load. */
                    return validated;
                }
                /* Host has no value yet: promote the localStorage copy (if
                   any) and stop using localStorage from then on. */
                if (fromLs !== null) {
                    try {
                        await fetch("/api/dsh-ui-font/settings/set", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ key: SETTINGS_NS, value: fromLs })
                        });
                        try { localStorage.removeItem(LS_KEY); } catch { /* */ }
                    } catch (e) { /* migration push failed: keep localStorage */ }
                    localCache = fromLs;
                    return fromLs;
                }
                localCache = validateSettings(null);
                return localCache;
            } catch (e) {
                /* Host unreachable / settings service not composed: fall back
                   to whatever localStorage has. This keeps the plugin usable
                   in profiles that do not wire `settings`. */
                hostAvailable = false;
                localCache = fromLs !== null ? fromLs : validateSettings(null);
                return localCache;
            }
        }
        /** Persist `s` to the host, then mirror to localStorage for offline
           resilience. localStorage is updated on every call (success or not)
           so an offline reopen always finds a recent copy. */
        async function saveSettings(s) {
            localCache = validateSettings(s);
            try {
                await fetch("/api/dsh-ui-font/settings/set", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ key: SETTINGS_NS, value: localCache })
                });
            } catch (e) { /* host down — localStorage still gets the write */ }
            try { localStorage.setItem(LS_KEY, JSON.stringify(localCache)); } catch { /* */ }
        }
        /** Sync read for picker event handlers. Mirrors `localCache` which is
           always updated before the host write fires. */
        function readSettingsSync() { return localCache; }

        /* ---------------- CSSOM scan ---------------- */
        /* Returns { stocks: {family: stockSize}, byPlugin: Map(plugin -> Map(sel -> {size, lh})) }
           NOTE on custom properties: Chromium's CSSStyleDeclaration.item()
           does NOT enumerate custom properties — they are only readable via
           getPropertyValue(). Every place this file reads --dsw-font-* tokens
           must go through cssText parsing instead of the item() loop (this was
           the root cause of the dead token channel: body overrides silently
           empty, so token-driven text — assistant messages, trajectory — never
           scaled while hardcoded-px text did). */
        function scan() {
            const stocks = {};
            const byPlugin = new Map();
            const tokenRules = new Map(); /* selector -> {fam, plugin} for var() font rules */
            const tokenDecls = new Map(); /* "--dsw-font-X" -> stock value text */
            let shellRoot = null;

            function classifySheet(sheet) {
                const node = sheet.ownerNode;
                if (node === null || node === undefined) return null;
                if (node.tagName === "STYLE") {
                    if (node.dataset !== undefined && node.dataset.pluginCss === STYLE_TAG_ID) return "self";
                    if (node.dataset !== undefined && node.dataset.plugin) return node.dataset.plugin;
                    return null;
                }
                if (node.tagName === "LINK" && typeof node.href === "string" && node.href.indexOf("/assets/") !== -1) return "shell";
                return null;
            }

            /* Extract custom-property declarations from a rule via cssText
               (which DOES serialize them). Collects --dsw-font-* tokens AND
               --dsl-* font aliases (which may reference a --dsw family). */
            function readTokenDecls(rule) {
                const text = rule.cssText;
                const open = text.indexOf("{");
                const close = text.lastIndexOf("}");
                if (open === -1 || close <= open) return;
                const body = text.slice(open + 1, close);
                for (const m of body.matchAll(/(--dsw-font-[a-z0-9-]+|--dsl-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
                    tokenDecls.set(m[1], m[2].trim());
                }
            }

            /** Stock size/line-height of a token family, resolved from the
                collected declarations (shorthand first, then -font-size). */
            function stockSizeOf(fam) {
                const sh = tokenDecls.get("--dsw-font-" + fam);
                if (sh !== undefined) {
                    const m = sh.match(/^([\d.]+)px(?:\s*\/\s*([\d.]+)px)?/);
                    if (m !== null) return { size: parseFloat(m[1]), lh: m[2] !== undefined ? parseFloat(m[2]) : null };
                }
                const fs = tokenDecls.get("--dsw-font-" + fam + "-font-size");
                if (fs !== undefined && /^[\d.]+px$/.test(fs)) {
                    let lh = null;
                    const lhv = tokenDecls.get("--dsw-font-" + fam + "-line-height");
                    if (lhv !== undefined && /^[\d.]+px$/.test(lhv)) lh = parseFloat(lhv);
                    return { size: parseFloat(fs), lh: lh };
                }
                if (STOCK_FALLBACK[fam] !== undefined) {
                    let lh = null;
                    const lhv = tokenDecls.get("--dsw-font-" + fam + "-line-height");
                    if (lhv !== undefined && /^[\d.]+px$/.test(lhv)) lh = parseFloat(lhv);
                    return { size: STOCK_FALLBACK[fam], lh: lh };
                }
                return null;
            }

            /* Pre-pass: collect shell token declarations so var()-driven rules
               can be resolved to stock px during the main walk (the body rule
               may appear after its consumers in sheet order). */
            for (const sheet of Array.from(document.styleSheets)) {
                try {
                    if (classifySheet(sheet) !== "shell") continue;
                    const visit = (list) => {
                        for (const r of Array.from(list)) {
                            if (r.type === 1) readTokenDecls(r);
                            else if (r.type === 4 || r.type === 12) { try { visit(r.cssRules); } catch (e) { /* skip */ } }
                        }
                    };
                    visit(sheet.cssRules);
                } catch (e) { /* cross-origin */ }
            }

            function walkRules(rules, plugin) {
                for (let i = 0; i < rules.length; i++) {
                    const r = rules[i];
                    if (r.type === 1) { /* CSSStyleRule */
                        if (plugin === "shell" && r.selectorText === ":root") { shellRoot = r; continue; }
                        const decls = r.style;
                        if (decls === null || decls.length === 0) continue;
                        let size = null, lh = null;
                        const fsRaw = decls.getPropertyValue("font-size").trim();
                        if (/^[\d.]+px$/.test(fsRaw)) {
                            size = parseFloat(fsRaw);
                            const lhRaw = decls.getPropertyValue("line-height").trim();
                            if (/^[\d.]+px$/.test(lhRaw)) lh = parseFloat(lhRaw);
                        } else {
                            const sh = decls.getPropertyValue("font").trim().match(/(?:^|\s)(\d+(?:\.\d+)?)px(?:\s*\/\s*(\d+(?:\.\d+)?)px)?/);
                            if (sh !== null) {
                                size = parseFloat(sh[1]);
                                if (sh[2] !== undefined) lh = parseFloat(sh[2]);
                            }
                        }
                        /* Chromium may RESOLVE font shorthand/size that is written
                           as var(--dsw-font-X) into a concrete px number via
                           getPropertyValue — the rule then looks like a plain px
                           rule and lands in the plugin bucket (stats line bug:
                           token-driven row attributed to conversation). Guard:
                           the rule's own cssText keeps the original var() text,
                           so any font declaration containing var(--dsw-font-*)
                           or a --dsl-* alias is a TOKEN rule regardless of what
                           getPropertyValue reports. */
                        const ruleText = r.cssText;
                        const declaresTokenFont = /font[^;:}]*:\s*[^;}]*var\(--(?:dsw-font|dsl-)[a-z0-9-]+\)/.test(ruleText);
                        if (declaresTokenFont) size = null;
                        const sel = (r.selectorText || "").replace(/\s+/g, " ").trim();
                        if (size === null) {
                            /* token-driven rule (font/font-size: var(...)): register
                               as a TOKEN rule — the family is the tuning target
                               (redefined on body with its own offset), NOT this
                               plugin. Accepts --dsw-font-X directly, and follows
                               --dsl-* aliases (e.g. --dsl-code-block-content-font
                               resolves to var(--dsw-font-markdown-code-block)). */
                            const val = fsRaw !== "" ? fsRaw : decls.getPropertyValue("font").trim();
                            let fam = null;
                            const tm = val.match(/var\(--dsw-font-([a-z0-9-]+)\)/);
                            if (tm !== null) fam = tm[1];
                            else {
                                const am = val.match(/var\((--[a-z0-9-]+)\)/);
                                if (am !== null) {
                                    const aliasVal = tokenDecls.get(am[1]);
                                    if (aliasVal !== undefined) {
                                        const fm2 = aliasVal.match(/var\(--dsw-font-([a-z0-9-]+)\)/);
                                        if (fm2 !== null) fam = fm2[1];
                                    }
                                }
                            }
                            if (fam !== null && sel !== "" && !/xterm/i.test(sel) && !/::(-webkit-)?scrollbar/.test(sel)) {
                                tokenRules.set(sel, { fam: fam, plugin: plugin });
                            }
                            continue;
                        }
                        if (sel === "" || /xterm/i.test(sel) || /::(-webkit-)?scrollbar/.test(sel)) continue;
                        if (!byPlugin.has(plugin)) byPlugin.set(plugin, new Map());
                        const bucket = byPlugin.get(plugin);
                        const prev = bucket.get(sel);
                        if (prev === undefined || prev.size < size) bucket.set(sel, { size: size, lh: lh });
                    } else if (r.type === 4 || r.type === 12) { /* media / supports */
                        try { walkRules(r.cssRules, plugin); } catch (e) { /* skip */ }
                    }
                }
            }

            for (const sheet of Array.from(document.styleSheets)) {
                try {
                    const plugin = classifySheet(sheet);
                    if (plugin === null || plugin === "self") continue;
                    walkRules(sheet.cssRules, plugin);
                } catch (e) { /* cross-origin / detached */ }
            }

            for (const entry of Array.from(tokenDecls.entries())) {
                const m = entry[0].match(/^--dsw-font-(.+)-font-size$/);
                if (m === null) continue;
                if (/^[\d.]+px$/.test(entry[1])) stocks[m[1]] = parseFloat(entry[1]);
            }
            /* shorthand-only families (e.g. m-18 is only declared as a shorthand) */
            for (const entry of Array.from(tokenDecls.entries())) {
                const m = entry[0].match(/^--dsw-font-([a-z0-9-]+)$/);
                if (m === null) continue;
                if (stocks[m[1]] !== undefined) continue;
                const sm = entry[1].match(/^([\d.]+)px/);
                if (sm !== null) stocks[m[1]] = parseFloat(sm[1]);
            }
            if (Object.keys(stocks).length === 0) {
                for (const k of Object.keys(STOCK_FALLBACK)) stocks[k] = STOCK_FALLBACK[k];
            }
            return { stocks: stocks, byPlugin: byPlugin, tokenRules: tokenRules };
        }

        /* ---------------- override generation ---------------- */
        /* Collect EVERY shell-sheet style rule that declares --dsw-font-*
           custom properties. The stock tokens do NOT all live on :root — the
           size/line-height tokens are declared on `body` (found the hard way),
           and any selector carrying them matters. Returns a merged virtual
           declaration map {prop: value} across those rules.
           Extraction goes through cssText: style.item() does not enumerate
           custom properties in Chromium, which silently emptied this map and
           killed the whole token channel. */
        function findShellTokenDecls() {
            const merged = new Map();
            for (const sheet of Array.from(document.styleSheets)) {
                const node = sheet.ownerNode;
                if (node === null || node === undefined || node.tagName !== "LINK") continue;
                if (typeof node.href !== "string" || node.href.indexOf("/assets/") === -1) continue;
                let rules = [];
                try { rules = Array.from(sheet.cssRules); } catch (e) { continue; }
                for (const r of rules) {
                    if (r.type !== 1) continue; /* style rules only (no media nesting here) */
                    const text = r.cssText;
                    if (text.indexOf("--dsw-font-") === -1) continue;
                    const open = text.indexOf("{");
                    const close = text.lastIndexOf("}");
                    if (open === -1 || close <= open) continue;
                    const body = text.slice(open + 1, close);
                    for (const m of body.matchAll(/(--dsw-font-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
                        merged.set(m[1], m[2].trim());
                    }
                }
            }
            return merged;
        }

        /* Rewrite every px-carrying --dsw-font-* property found by
           findShellTokenDecls, scaling sizes (and proportional line-heights /
           shorthands) by delta. Emitted on `body` — the stock tokens are
           declared there, and our later-injected tag wins the cascade. */
        function buildTokenCss(s, decls) {
            if (decls === null || decls.size === 0) return "";
            const famSize = {};
            for (const entry of Array.from(decls.entries())) {
                const m = entry[0].match(/^--dsw-font-(.+)-font-size$/);
                if (m === null) continue;
                if (/^[\d.]+px$/.test(entry[1])) famSize[m[1]] = parseFloat(entry[1]);
            }
            for (const k of Object.keys(STOCK_FALLBACK)) {
                if (famSize[k] === undefined) famSize[k] = STOCK_FALLBACK[k];
            }
            const lines = ["body{"];
            for (const entry of Array.from(decls.entries())) {
                const prop = entry[0];
                const value = entry[1];
                if (value.indexOf("px") === -1) continue;
                const famM = prop.match(/^--dsw-font-(.+?)(?:-font-size|-line-height)?$/);
                if (famM === null) continue;
                const fam = famM[1];
                const stock = famSize[fam];
                if (stock === undefined) continue;
                /* per-family delta: global + this token's own extra */
                const tokExtra = typeof s.perToken[fam] === "number" ? s.perToken[fam] : 0;
                const n = Math.round((stock + s.delta + tokExtra) * 10) / 10;
                const ratio = n / stock;
                if (prop.endsWith("-line-height")) {
                    const lh = parseFloat(value);
                    if (!isNaN(lh)) lines.push(prop + ":" + Math.round(lh * ratio) + "px;");
                } else if (prop.endsWith("-font-size")) {
                    lines.push(prop + ":" + n + "px;");
                } else {
                    const scaled = value.replace(/(\d+(?:\.\d+)?)px(?:\s*\/\s*(\d+(?:\.\d+)?)px)?/, (all, a, b) => {
                        const na = Math.round(parseFloat(a) * ratio * 10) / 10;
                        if (b === undefined) return na + "px";
                        return na + "px/" + (Math.round(parseFloat(b) * ratio * 10) / 10) + "px";
                    });
                    lines.push(prop + ":" + scaled + ";");
                }
            }
            lines.push("}");
            return lines.join("");
        }

        /* Font-family routing + hardcoded per-plugin rules + aionui root. */
        function buildRuleCss(s, data) {
            const out = [":root{--dsw-font-family:" + uiStack(s.uiFont)
                + ";--ds-font-family-code:" + codeStack(s.codeFont)
                + ";--aion-font-sans:var(--dsw-font-family)!important;--aion-font-mono:var(--ds-font-family-code)!important}"];
            const lines = [];
            for (const entry of Array.from(data.byPlugin.entries())) {
                const plugin = entry[0], bucket = entry[1];
                const pluginExtra = typeof s.perPlugin[plugin] === "number" ? s.perPlugin[plugin] : 0;
                for (const selEntry of Array.from(bucket.entries())) {
                    const sel = selEntry[0], info = selEntry[1];
                    /* rule-level extra (from picking a specific component)
                       REPLACES the bucket extra for this one rule */
                    const ruleKey = plugin + "||" + sel;
                    const ruleExtra = typeof s.perRule[ruleKey] === "number" ? s.perRule[ruleKey] : null;
                    const d = s.delta + (ruleExtra !== null ? ruleExtra : pluginExtra);
                    if (d === 0) continue;
                    const n = Math.round((info.size + d) * 10) / 10;
                    const nl = info.lh !== null ? Math.round(info.lh * n / info.size) : null;
                    lines.push(sel + "{font-size:" + n + "px!important;" + (nl !== null ? "line-height:" + nl + "px!important;" : "") + "}");
                }
            }
            out.push("body .aionui-root{font-size:" + (13 + s.delta) + "px}");
            return out.join("\n") + "\n" + lines.join("\n");
        }

        /* ---------------- engine ---------------- */
        /* No polling, no MutationObserver: scan+apply runs exactly once at
           startup (needed for the font styles anyway); afterwards the only
           re-scan is the user pressing 刷新 in the settings page. */
        let engineStyleTag = null;

        function ensureTag() {
            if (engineStyleTag !== null && document.head.contains(engineStyleTag)) return engineStyleTag;
            const tag = document.createElement("style");
            tag.dataset.plugin = PLUGIN_ID;
            tag.dataset.pluginCss = STYLE_TAG_ID;
            document.head.appendChild(tag);
            engineStyleTag = tag;
            return tag;
        }

        async function reapply() {
            try {
                const s = await loadSettings();
                const data = scan();
                const decls = findShellTokenDecls();
                const css = buildTokenCss(s, decls) + "\n" + buildRuleCss(s, data);
                ensureTag().textContent = css;
                /* runtime self-check: visible in devtools as
                   window.__dshUiFontDebug — token count 0 on a live page means
                   the shell stylesheet was not readable at this moment. */
                window.__dshUiFontDebug = {
                    at: new Date().toISOString(),
                    tokenDecls: decls.size,
                    bodyTokenCss: css.indexOf("--dsw-font-markdown-base") !== -1,
                    ruleCount: data.byPlugin.size,
                    delta: s.delta,
                    hostAvailable: hostAvailable
                };
            } catch (e) {
                /* never let one bad pass kill the settle chain */
                window.__dshUiFontDebug = { at: new Date().toISOString(), error: String(e && e.message ? e.message : e) };
            }
        }

        /* Wait until the shell stylesheet is actually parsed (its <link> may
           still be loading when our bundle runs after a refresh), then apply.
           Bounded to ~5s; each successful early exit cancels the fallbacks. */
        function reapplyWhenReady() {
            let tries = 0;
            const tick = () => {
                reapply().catch((e) => {
                    window.__dshUiFontDebug = { at: new Date().toISOString(), error: String(e && e.message ? e.message : e) };
                });
                const dbg = window.__dshUiFontDebug;
                if (dbg !== undefined && dbg.tokenDecls > 0) return; /* good */
                if (++tries > 60) return; /* give up; manual 刷新 remains */
                setTimeout(tick, 100);
            };
            tick();
        }

        /* Fetch display descriptions for discovered plugin ids from the host
           half (reads package.json / README in node_modules). Lazily called —
           never on the startup path. Returns {} on any failure. */
        async function fetchDescriptions(ids) {
            try {
                const r = await fetch("/api/dsh-ui-font/descriptions", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ ids: ids })
                });
                if (r.ok !== true) return {};
                const j = await r.json();
                return (j !== null && typeof j === "object" && j.descriptions && typeof j.descriptions === "object") ? j.descriptions : {};
            } catch (e) {
                return {};
            }
        }

        /* Fetch the system font family list from the host half (sfnt parsing).
           Lazily called — never on the startup path. [] on any failure. */
        async function fetchFontFamilies() {
            try {
                const r = await fetch("/api/dsh-ui-font/fonts");
                if (r.ok !== true) return [];
                const j = await r.json();
                if (j !== null && typeof j === "object" && Array.isArray(j.families)) {
                    return j.families.filter((f) => typeof f === "string" && sanitizeFamily(f) !== "").slice(0, 1000);
                }
                return [];
            } catch (e) {
                return [];
            }
        }

        /* ==================================================================
         * Pick mode — the Spy++-style element picker.
         *
         * While active: a custom crosshair cursor covers the whole page, the
         * hovered block gets an outline + a tooltip (owning plugin · current
         * effective size), and a click pops an in-place mini control
         * (−/+ on that plugin's delta) that applies instantly. ESC / right
         * click cancels. Ownership comes from the same data the engine uses:
         * a prebuilt class-name -> plugin index over every plugin stylesheet.
         * ================================================================== */
        const PICK_Z = 2147483647;
        const CROSSHAIR_SVG = "data:image/svg+xml," + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">' +
            '<circle cx="12" cy="12" r="7" fill="none" stroke="#e11d48" stroke-width="1.5"/>' +
            '<line x1="12" y1="0" x2="12" y2="24" stroke="#e11d48" stroke-width="1.5"/>' +
            '<line x1="0" y1="12" x2="24" y2="12" stroke="#e11d48" stroke-width="1.5"/>' +
            '<circle cx="12" cy="12" r="1.2" fill="#e11d48"/></svg>');

        /** class name -> owning plugin id, built per pick session from every
            plugin stylesheet's parsed selectorText. Sheets may appear lazily
            (first render of a panel injects its <style> late), so the session
            can request incremental rebuilds — buildClassIndex returns both the
            index and a refresh() that rescans freshly-injected sheets. */
        function buildClassIndex() {
            const index = new Map();
            let seenSheets = new Set();
            const scanAll = () => {
                let added = false;
                for (const sheet of Array.from(document.styleSheets)) {
                    if (seenSheets.has(sheet)) continue;
                    const node = sheet.ownerNode;
                    if (node === null || node === undefined || node.tagName !== "STYLE") { seenSheets.add(sheet); continue; }
                    const plugin = node.dataset !== undefined ? node.dataset.plugin : undefined;
                    if (plugin === undefined || plugin === PLUGIN_ID) { seenSheets.add(sheet); continue; }
                    let rules = [];
                    try { rules = Array.from(sheet.cssRules); } catch (e) { seenSheets.add(sheet); continue; }
                    const visit = (list) => {
                        for (const r of list) {
                            if (r.type === 1 && typeof r.selectorText === "string") {
                                for (const part of r.selectorText.split(",")) {
                                    for (const m of part.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
                                        if (!index.has(m[1])) index.set(m[1], plugin);
                                        added = true;
                                    }
                                }
                            } else if (r.type === 4 || r.type === 12) {
                                try { visit(Array.from(r.cssRules)); } catch (e) { /* skip */ }
                            }
                        }
                    };
                    visit(rules);
                    seenSheets.add(sheet);
                }
                return added;
            };
            scanAll();
            return {
                get: (cls) => index.get(cls),
                has: (cls) => index.has(cls),
                refresh: scanAll
            };
        }

        /* Attribution by DECLARATION-POINT — the user's idea, done right:
           walk up from the clicked element to the NEAREST node whose font is
           decided by a rule we know. Two kinds of decision points:
             a) a rule using var(--dsw-font-X)  -> TOKEN target: tune family X
                itself (redefined on body with its own offset). This is exact
                because the rule literally names the variable that sizes this
                text — no fingerprinting, no ownership guessing. Wherever that
                family is used across the GUI, it follows (that is what a
                design-token system means).
             b) a rule with a px font          -> PLUGIN target: that bucket's
                own extra (same as before).
           Priority: a token rule within 3 levels (self or 2 ancestors) beats
           a px rule at the same level — panels commonly wrap token-driven
           content in px-fonted containers (the stats line: px strip around a
           var(--dsw-font-s-strong-14) row), and the var IS the semantic
           decision for the text itself. */
        function tokenHitAt(node, data) {
            for (const entry of Array.from(data.tokenRules.entries())) {
                try { if (node.matches(entry[0]) === true) return entry[1]; } catch (e) { /* bad selector */ }
            }
            return null;
        }
        function pluginHitAt(node, data) {
            for (const entry of Array.from(data.byPlugin.entries())) {
                const plugin = entry[0];
                const bucket = entry[1];
                for (const sel of Array.from(bucket.keys())) {
                    try { if (node.matches(sel) === true) return plugin; } catch (e) { /* bad selector */ }
                }
            }
            return null;
        }
        /** Exact rule hit: plugin AND the specific selector that matched.
            Falls back to plugin-level when the caller only wants ownership. */
        function ruleHitAt(node, data) {
            for (const entry of Array.from(data.byPlugin.entries())) {
                const plugin = entry[0];
                const bucket = entry[1];
                for (const sel of Array.from(bucket.keys())) {
                    try { if (node.matches(sel) === true) return { plugin: plugin, sel: sel }; } catch (e) { /* bad selector */ }
                }
            }
            return null;
        }
        function resolveTarget(el, data) {
            /* near-token pre-pass: within 3 levels, a token declaration wins */
            let n = el;
            for (let d = 0; d < 3 && n !== null; d++) {
                if (n.matches !== undefined) {
                    const th = tokenHitAt(n, data);
                    if (th !== null) return { kind: "token", fam: th.fam };
                }
                n = n.parentElement;
            }
            /* nearest declaration point otherwise; px hits resolve to the
               SPECIFIC rule (rule-level tuning) so co-bucketed components —
               e.g. the stats bar (.FJxK0a_root 12px) vs user bubbles in the
               same conversation bucket — can be tuned independently. */
            let node = el;
            for (let depth = 0; depth < 31 && node !== null; depth++) {
                if (node.matches !== undefined) {
                    const th = tokenHitAt(node, data);
                    if (th !== null) return { kind: "token", fam: th.fam };
                    const rh = ruleHitAt(node, data);
                    if (rh !== null) return { kind: "rule", plugin: rh.plugin, sel: rh.sel };
                }
                node = node.parentElement;
            }
            return { kind: "global" };
        }

        /** Display label for a rule-level target: plugin name + the class-ish
            part of the selector (".FJxK0a_root" -> "FJxK0a_root"). */
        function ruleLabel(target) {
            const cls = (target.sel.match(/\.([A-Za-z_][A-Za-z0-9_-]+)/) || [, target.sel])[1];
            return (target.plugin === "shell" ? "主界面外壳" : prettifyId(target.plugin)) + " · " + cls;
        }
        let pickSession = null;

        /** Enter pick mode — fully self-contained at DOM level (works with the
            settings panel closed; toggled by the settings button or the global
            Ctrl+Shift+F hotkey). Phase 1: crosshair + hover highlight + owner
            tooltip. On click: phase 2 — an in-place −/+ control bound to the
            owning plugin (or the global delta for token-driven areas), applied
            instantly. ESC / right-click / ✕ ends everything. */
        function enterPickMode() {
            if (pickSession !== null) exitPickMode();
            const index = buildClassIndex();

            const cursorTag = document.createElement("style");
            cursorTag.dataset.plugin = PLUGIN_ID;
            cursorTag.textContent = "*{cursor:url(\"" + CROSSHAIR_SVG + "\") 12 12, crosshair !important}";

            const outline = document.createElement("div");
            outline.style.cssText = "position:fixed;z-index:" + PICK_Z + ";pointer-events:none;border:2px solid #e11d48;background:rgba(225,29,72,.08);border-radius:3px;display:none;transition:all .04s linear";
            const tip = document.createElement("div");
            tip.style.cssText = "position:fixed;z-index:" + PICK_Z + ";pointer-events:none;background:#111827;color:#f9fafb;font-size:12px;line-height:1.5;padding:4px 8px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.35);display:none;max-width:340px";
            let control = null; /* phase-2 floating bar */

            document.head.appendChild(cursorTag);
            document.body.appendChild(outline);
            document.body.appendChild(tip);

            let phase = "hover"; /* "hover" -> "control" */

            /* Rule data for attribution + per-element cache: hover fires often,
               resolveTarget sweeps only once per element. */
            let ruleData = scan();
            let targetCache = new WeakMap();
            const resolveCached = (t) => {
                if (targetCache.has(t)) return targetCache.get(t);
                const target = resolveTarget(t, ruleData);
                targetCache.set(t, target);
                return target;
            };

            const targetOf = (e) => {
                const t = e.target;
                return (t !== null && t !== document.documentElement && t !== document.body) ? t : null;
            };

            const onMove = (e) => {
                if (phase !== "hover") return;
                const t = targetOf(e);
                if (t === null) { outline.style.display = "none"; tip.style.display = "none"; return; }
                /* lazily-injected stylesheets: when this element's classes are
                   unknown to the index, refresh both indexes so late panels
                   attribute correctly. */
                let unknown = false;
                if (t.classList !== undefined) {
                    for (const cls of t.classList) {
                        if (cls !== "" && !index.has(cls)) { unknown = true; break; }
                    }
                }
                if (unknown) { index.refresh(); ruleData = scan(); targetCache = new WeakMap(); }
                const rect = t.getBoundingClientRect();
                outline.style.display = "block";
                outline.style.left = (rect.left - 1) + "px";
                outline.style.top = (rect.top - 1) + "px";
                outline.style.width = (rect.width + 2) + "px";
                outline.style.height = (rect.height + 2) + "px";

                const target = resolveCached(t);
                const size = getComputedStyle(t).fontSize;
                const isXterm = t.closest(".xterm") !== null;
                const name = target.kind === "token" ? (TOKEN_LABELS[target.fam] || target.fam) + "（文字类型）"
                    : target.kind === "rule" ? ruleLabel(target)
                    : target.kind === "plugin" ? (target.plugin === "shell" ? "主界面外壳" : prettifyId(target.plugin))
                    : "主界面（全局偏移）";
                tip.style.display = "block";
                tip.textContent = name + " · " + size + (isXterm ? " · 终端字体由 dsh-ssh 内置" : "");
                const tx = Math.min(e.clientX + 14, window.innerWidth - 300);
                const ty = e.clientY + 18 < window.innerHeight - 40 ? e.clientY + 18 : e.clientY - 34;
                tip.style.left = tx + "px";
                tip.style.top = ty + "px";
            };


            /** Adjust and persist one step (±1) for ONE target; returns new value.
                Targets: {kind:'token',fam} | {kind:'rule',plugin,sel} |
                {kind:'plugin',plugin} | {kind:'global'}
                The cache mutation + reapply happens synchronously so the UI
                updates inside the same tick; the host write is fired-and-forgot
                so picker clicks stay snappy even when settings.yaml lives on a
                network share. */
            const bumpOne = (target, d) => {
                const s2 = validateSettings(readSettingsSync());
                let value;
                if (target.kind === "token") {
                    const cur = typeof s2.perToken[target.fam] === "number" ? s2.perToken[target.fam] : 0;
                    value = Math.max(-6, Math.min(20, cur + d));
                    s2.perToken = Object.assign({}, s2.perToken);
                    if (value === 0) delete s2.perToken[target.fam];
                    else s2.perToken[target.fam] = value;
                } else if (target.kind === "rule") {
                    const key = target.plugin + "||" + target.sel;
                    const cur = typeof s2.perRule[key] === "number" ? s2.perRule[key] : 0;
                    value = Math.max(-6, Math.min(20, cur + d));
                    s2.perRule = Object.assign({}, s2.perRule);
                    if (value === 0) delete s2.perRule[key];
                    else s2.perRule[key] = value;
                } else if (target.kind === "plugin") {
                    const plugin = target.plugin;
                    const cur = typeof s2.perPlugin[plugin] === "number" ? s2.perPlugin[plugin] : 0;
                    value = Math.max(-6, Math.min(20, cur + d));
                    s2.perPlugin = Object.assign({}, s2.perPlugin);
                    if (value === 0) delete s2.perPlugin[plugin];
                    else s2.perPlugin[plugin] = value;
                } else {
                    s2.delta = Math.max(-3, Math.min(20, s2.delta + d));
                    value = s2.delta;
                }
                saveSettings(s2).catch((e) => {
                    console.error("[dsh-ui-font] save failed", e);
                });
                return value;
            };
            const bump = (targets, d) => {
                let last = 0;
                for (const target of targets) last = bumpOne(target, d);
                reapply().catch((e) => {
                    window.__dshUiFontDebug = { at: new Date().toISOString(), error: String(e && e.message ? e.message : e) };
                });
                window.dispatchEvent(new Event("dsh-ui-font:changed"));
                return last;
            };

            const showControl = (x, y, targets, sizePx, isXterm) => {
                const primary = targets[0];
                control = document.createElement("div");
                const cx = Math.min(x, window.innerWidth - 280);
                const cy = Math.min(y + 12, window.innerHeight - 90);
                control.style.cssText = "position:fixed;left:" + cx + "px;top:" + cy + "px;z-index:" + PICK_Z
                    + ";background:#111827;color:#f9fafb;border-radius:10px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;align-items:center;gap:10px;font-size:13px";
                const nameDiv = document.createElement("div");
                nameDiv.style.cssText = "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
                const labelOf = (target) => target.kind === "token" ? (TOKEN_LABELS[target.fam] || target.fam)
                    : target.kind === "rule" ? ruleLabel(target)
                    : target.kind === "plugin" ? (target.plugin === "shell" ? "主界面外壳" : prettifyId(target.plugin))
                    : "主界面（全局偏移）";
                nameDiv.textContent = labelOf(primary);
                const sizeDiv = document.createElement("div");
                sizeDiv.style.cssText = "font-size:11px;opacity:.7";
                sizeDiv.textContent = isXterm ? "终端字体由 dsh-ssh 内置，不受控制"
                    : (primary.kind === "token" ? "同类文字一起变（设计令牌）" : "选取时字号 " + sizePx);
                nameDiv.appendChild(document.createElement("br"));
                nameDiv.appendChild(sizeDiv);

                const makeBtn = (label, w) => {
                    const b = document.createElement("button");
                    b.textContent = label;
                    b.style.cssText = "height:30px;width:" + (w || 30) + "px;font-size:16px;cursor:pointer";
                    return b;
                };
                const minus = makeBtn("−");
                const plus = makeBtn("+");
                const done = makeBtn("完成", "auto");
                done.style.padding = "0 8px";
                done.style.fontSize = "13px";
                const valueSpan = document.createElement("span");
                valueSpan.style.cssText = "min-width:34px;text-align:center;font-variant-numeric:tabular-nums";
                const readValue = () => {
                    const st = readSettingsSync();
                    if (primary.kind === "token") return typeof st.perToken[primary.fam] === "number" ? st.perToken[primary.fam] : 0;
                    if (primary.kind === "rule") { const k = primary.plugin + "||" + primary.sel; return typeof st.perRule[k] === "number" ? st.perRule[k] : 0; }
                    if (primary.kind === "plugin") return typeof st.perPlugin[primary.plugin] === "number" ? st.perPlugin[primary.plugin] : 0;
                    return st.delta;
                };
                const paint = (v) => { valueSpan.textContent = (v > 0 ? "+" : "") + v; };
                paint(readValue());
                minus.addEventListener("click", () => paint(bump(targets, -1)));
                plus.addEventListener("click", () => paint(bump(targets, 1)));
                done.addEventListener("click", exitPickMode);

                control.appendChild(nameDiv);
                control.appendChild(minus);
                control.appendChild(valueSpan);
                control.appendChild(plus);
                control.appendChild(done);
                document.body.appendChild(control);
            };

            const onPickClick = (e) => {
                if (phase === "control") {
                    /* the floating bar is up: its own clicks must pass through
                       (a capture-phase swallow here is exactly the bug that
                       made −/+ / 完成 dead and the page unclickable); a click
                       anywhere else ends the session. */
                    if (control !== null && control.contains(e.target)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    exitPickMode();
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                const t = targetOf(e);
                if (t === null) { exitPickMode(); return; }
                /* attribution by declaration point (see resolveTarget): the
                   nearest known font decision up the ancestor chain. Token
                   targets tune the design token itself (all matching text in
                   the GUI follows); px targets tune the owning plugin; neither
                   falls back to the global delta. */
                ruleData = scan();
                targetCache = new WeakMap();
                const target = resolveTarget(t, ruleData);
                const size = getComputedStyle(t).fontSize;
                const isXterm = t.closest(".xterm") !== null;
                /* end hover phase, keep the session alive for the control bar */
                phase = "control";
                cursorTag.remove();
                outline.style.display = "none";
                tip.style.display = "none";
                showControl(e.clientX, e.clientY, [target], size, isXterm);
            };

            const onDown = (e) => {
                /* swallow mousedown so hovered buttons never press */
                if (phase === "hover" && e.button === 0) { e.preventDefault(); e.stopPropagation(); }
            };
            const onContext = (e) => { e.preventDefault(); exitPickMode(); };
            const onKey = (e) => { if (e.key === "Escape") exitPickMode(); };

            document.addEventListener("mousemove", onMove, true);
            document.addEventListener("mousedown", onDown, true);
            document.addEventListener("click", onPickClick, true);
            document.addEventListener("contextmenu", onContext, true);
            document.addEventListener("keydown", onKey, true);

            pickSession = {
                dispose: () => {
                    document.removeEventListener("mousemove", onMove, true);
                    document.removeEventListener("mousedown", onDown, true);
                    document.removeEventListener("click", onPickClick, true);
                    document.removeEventListener("contextmenu", onContext, true);
                    document.removeEventListener("keydown", onKey, true);
                    if (document.head.contains(cursorTag)) cursorTag.remove();
                    outline.remove();
                    tip.remove();
                    if (control !== null) control.remove();
                    control = null;
                    pickSession = null;
                }
            };
        }

        function exitPickMode() {
            if (pickSession !== null) pickSession.dispose();
        }

        /* ---------------- settings page ---------------- */
        /* Design tokens for this page — theme-aware via the shell's CSS
           variables, with graceful fallbacks if a token is missing. */
        const UI = {
            text: "var(--dsw-alias-label-primary, #172a45)",
            text2: "var(--dsw-alias-label-secondary, #5d6b7e)",
            border: "var(--dsw-alias-border-l1, rgba(120,130,150,.25))",
            card: "var(--dsw-alias-bg-layer-1, rgba(125,135,155,.06))",
            accent: "var(--dsw-alias-brand-primary, #2b6cb0)",
            warn: "#d93025",
            radius: 10,
            mono: "var(--ds-font-family-code, monospace)"
        };
        const kbdStyle = {
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            minWidth: 22, height: 22, padding: "0 6px", margin: 0,
            fontFamily: UI.mono, fontSize: 12, lineHeight: 1,
            color: UI.text, background: "var(--dsw-alias-bg-layer-2, rgba(125,135,155,.12))",
            border: "1px solid var(--dsw-alias-border-l2, rgba(120,130,150,.35))",
            borderBottomWidth: 2, borderRadius: 6
        };
        const btnStyle = (variant) => {
            const base = { cursor: "pointer", borderRadius: 8, fontSize: 13, padding: "6px 12px",
                transition: "filter .12s, background .12s", lineHeight: 1.2, whiteSpace: "nowrap" };
            if (variant === "primary") return Object.assign({}, base, { color: "#fff", background: UI.accent, border: "1px solid transparent" });
            if (variant === "danger") return Object.assign({}, base, { color: UI.warn, background: "transparent", border: "1px solid " + UI.warn });
            return Object.assign({}, base, { color: UI.text, background: "var(--dsw-alias-bg-layer-2, rgba(125,135,155,.12))", border: "1px solid " + UI.border });
        };
        const cardStyle = { background: UI.card, border: "1px solid " + UI.border, borderRadius: UI.radius, padding: "4px 16px", margin: "10px 0" };
        const sectionTitle = { margin: "14px 0 2px", fontSize: 13, fontWeight: 600, letterSpacing: ".02em", color: UI.text2, textTransform: "uppercase" };
        const fmt = (v) => (v > 0 ? "+" : "") + v;

        function FontSettingsPage() {
            const [s, setS] = React.useState(readSettingsSync);
            const [scanData, setScanData] = React.useState(null);
            const [descriptions, setDescriptions] = React.useState({});
            const [families, setFamilies] = React.useState(null); // null = loading, [] = unavailable

            /* Settings are loaded from the host on mount; the `localCache`
               shadow starts with defaults so the UI never renders with an
               empty form. `loadSettings` updates `localCache` before it
               resolves, so the caller's `setS(readSettingsSync())` two lines
               later would already see the host value; the explicit setS keeps
               the dependency obvious in case the host is unreachable. */
            React.useEffect(() => {
                loadSettings().then((loaded) => { setS(loaded); refresh(); }).catch(() => { refresh(); });
            }, []);

            /* Manual refresh: rescan the live stylesheets and pull descriptions
               plus the system font list. Runs when the page opens and when the
               user hits 刷新 — nothing polls in the background. */
            const refresh = React.useCallback(() => {
                const data = scan();
                setScanData(data);
                const ids = Array.from(data.byPlugin.keys()).filter((id) => id !== "shell");
                fetchDescriptions(ids).then(setDescriptions);
                fetchFontFamilies().then(setFamilies);
            }, []);

            const update = (patch) => {
                /* Optimistic local update first (the cache + state), then
                   fire-and-forget the host write. A failed write still leaves
                   the UI in the intended state and a follow-up load will
                   resync — the persistence error surfaces via console + the
                   __dshUiFontDebug devtools handle. */
                setS((prev) => {
                    const next = Object.assign({}, prev, patch);
                    saveSettings(next).catch((e) => {
                        console.error("[dsh-ui-font] save failed", e);
                    });
                    reapply().catch((e) => {
                        window.__dshUiFontDebug = { at: new Date().toISOString(), error: String(e && e.message ? e.message : e) };
                    });
                    return next;
                });
            };

            /* Keep this page in sync with changes made outside React state —
               e.g. the pick-mode floating control (session-owned DOM) writes
               settings directly, from anywhere in the page. The cache shadow
               has already been updated by the writer, so we can sync the
               state synchronously without awaiting the host. */
            React.useEffect(() => {
                const onExtern = () => setS(readSettingsSync());
                window.addEventListener("dsh-ui-font:changed", onExtern);
                return () => window.removeEventListener("dsh-ui-font:changed", onExtern);
            }, []);

            const plugins = scanData === null ? [] :
                Array.from(scanData.byPlugin.entries())
                    .map((e) => ({ id: e[0], count: e[1].size }))
                    .sort((a, b) => b.count - a.count);

            const row = (label, control) => React.createElement("div", {
                key: label,
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px solid " + UI.border }
            },
                React.createElement("span", { style: { flex: "0 0 auto", color: UI.text } }, label),
                React.createElement("div", { style: { flex: "1 1 auto", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, minWidth: 0 } }, control));

            /* Font picker over the host-enumerated system families. The stored
               value stays selectable even when the font list is still loading
               or the font has been uninstalled. */
            const selectStyle = { minWidth: 180, maxWidth: 260, padding: "6px 8px", borderRadius: 8, border: "1px solid " + UI.border, background: "var(--dsw-alias-bg-layer-2, transparent)", color: UI.text };
            const fontSelect = (value, onChange) => {
                const list = families === null ? [] : families.slice();
                if (value !== "" && list.indexOf(value) === -1) list.push(value);
                return React.createElement("select", { value: value, onChange: onChange, style: selectStyle },
                    React.createElement("option", { key: "", value: "" }, "系统默认"),
                    list.map((f) => React.createElement("option", {
                        key: f, value: f,
                        style: { fontFamily: '"' + f + '"' }
                    }, families !== null && families.indexOf(f) === -1 ? f + "（未安装）" : f)));
            };

            /* Per-plugin stepper: shows the EXTRA delta plus the effective
               TOTAL (global + extra) — the additive semantics made visible. */
            const stepper = (extra, onExtra) => {
                const total = s.delta + (extra === null ? 0 : extra);
                const stepBtn = (label, d, disabled) => React.createElement("button", {
                    onClick: () => onExtra(Math.max(-6, Math.min(20, (extra === null ? 0 : extra) + d))),
                    disabled: disabled === true,
                    style: Object.assign({}, btnStyle(), { padding: "4px 10px", fontSize: 15, minWidth: 32 })
                }, label);
                return React.createElement(React.Fragment, null,
                    React.createElement("span", {
                        title: "总偏移 = 全局 " + fmt(s.delta) + " + 个体 " + fmt(extra === null ? 0 : extra),
                        style: { fontFamily: UI.mono, fontSize: 12, padding: "3px 8px", borderRadius: 999,
                            background: extra === null ? "transparent" : UI.card,
                            border: "1px solid " + (extra === null ? "transparent" : UI.border),
                            color: extra === null ? UI.text2 : UI.accent }
                    }, "合计 " + fmt(total)),
                    stepBtn("−", -1, extra !== null && extra <= -6),
                    React.createElement("span", { style: { fontFamily: UI.mono, minWidth: 36, textAlign: "center", color: UI.text, fontVariantNumeric: "tabular-nums" } },
                        extra === null ? "·" : fmt(extra)),
                    stepBtn("+", 1, extra !== null && extra >= 20),
                    extra !== null
                        ? React.createElement("button", {
                            onClick: () => onExtra(null), title: "清除个体偏移（回到仅全局）",
                            style: Object.assign({}, btnStyle(), { padding: "4px 8px", fontSize: 12, color: UI.text2, border: "none", background: "transparent" })
                        }, "✕")
                        : null);
            };

            /* Hotkey slot control: record mode captures the next modifier
               combo. Empty (default) = disabled. `presets` = one-click options
               shown as small kbd buttons. */
            const [recordingSlot, setRecordingSlot] = React.useState(null); // "hotkey" | "hotkeyUp" | "hotkeyDown" | null
            React.useEffect(() => {
                if (recordingSlot === null) return;
                const onKey = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "Escape") { setRecordingSlot(null); return; }
                    if (isModifierCode(e.code)) return; /* wait for the main key */
                    if (!e.ctrlKey && !e.altKey && !e.metaKey) return; /* need ≥1 non-Shift modifier, else typing would fire it */
                    const patch = {};
                    patch[recordingSlot] = comboOf(e);
                    update(patch);
                    setRecordingSlot(null);
                };
                window.addEventListener("keydown", onKey, true);
                return () => window.removeEventListener("keydown", onKey, true);
            }, [recordingSlot]);
            const hotkeySlot = (slot, label, presets) => {
                const value = s[slot];
                const recording = recordingSlot === slot;
                return React.createElement(React.Fragment, null,
                    value !== "" && recording !== true
                        ? React.createElement("span", { style: { display: "inline-flex", gap: 4 } },
                            value.split("+").map((k, i) => React.createElement("kbd", { key: i, style: kbdStyle }, k)))
                        : null,
                    value === "" && recording !== true
                        ? React.createElement("span", { style: { color: UI.text2, fontSize: 12 } }, "未设置")
                        : null,
                    recording
                        ? React.createElement("span", { style: Object.assign({}, kbdStyle, { minWidth: 150, color: UI.accent, borderColor: UI.accent }) }, "按下组合键 …")
                        : null,
                    (presets || []).filter(p => p.combo !== value).map(p => React.createElement("button", {
                        key: p.combo,
                        onClick: () => { const patch = {}; patch[slot] = p.combo; update(patch); },
                        title: p.title || ("使用 " + p.combo),
                        style: Object.assign({}, btnStyle(), { padding: "4px 8px", fontSize: 12 })
                    }, p.label)),
                    React.createElement("button", {
                        onClick: () => setRecordingSlot(recording ? null : slot),
                        style: btnStyle(recording ? "danger" : undefined),
                        title: "点击后按下组合键（需含 Ctrl/Alt/Meta 之一；ESC 取消）"
                    }, recording ? "取消" : value === "" ? "录制" : "修改"),
                    value !== "" && recording !== true
                        ? React.createElement("button", {
                            onClick: () => { const patch = {}; patch[slot] = ""; update(patch); },
                            title: "清除快捷键",
                            style: Object.assign({}, btnStyle(), { padding: "6px 10px" })
                        }, "清除")
                        : null);
            };
            const zoomPresetNote = "（接管浏览器同键位的页面缩放）";
            const hotkeyControl = hotkeySlot("hotkey", "UI 捕捉");
            const hotkeyUpControl = hotkeySlot("hotkeyUp", "放大", [
                { combo: "Ctrl+=", label: "Ctrl =", title: "使用 Ctrl+= " + zoomPresetNote }
            ]);
            const hotkeyDownControl = hotkeySlot("hotkeyDown", "缩小", [
                { combo: "Ctrl+-", label: "Ctrl -", title: "使用 Ctrl+- " + zoomPresetNote }
            ]);

            return React.createElement("div", { style: { display: "flex", flexDirection: "column", color: UI.text } },
                React.createElement("div", Object.assign({}, cardStyle, { padding: "2px 16px" }),
                    row("界面字体", fontSelect(s.uiFont, (e) => update({ uiFont: e.target.value }))),
                    row("代码 / 等宽字体", fontSelect(s.codeFont, (e) => update({ codeFont: e.target.value }))),
                    React.createElement("div", { style: { padding: "10px 0", borderBottom: "1px solid " + UI.border, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
                        React.createElement("span", null, "全局字号偏移"),
                        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                            React.createElement("input", { type: "range", min: -3, max: 20, step: 1, value: s.delta, accentColor: undefined,
                                onChange: (e) => update({ delta: Number(e.target.value) }), style: { width: 170, accentColor: UI.accent } }),
                            React.createElement("span", { style: { fontFamily: UI.mono, minWidth: 46, textAlign: "right", fontVariantNumeric: "tabular-nums" } },
                                fmt(s.delta) + " px"))),
                    React.createElement("div", { style: { padding: "10px 0", borderBottom: "1px solid " + UI.border, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
                        React.createElement("span", null, "字号放大快捷键"),
                        hotkeyUpControl),
                    React.createElement("div", { style: { padding: "10px 0", borderBottom: "1px solid " + UI.border, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
                        React.createElement("span", null, "字号缩小快捷键"),
                        hotkeyDownControl),
                    React.createElement("div", { style: { padding: "10px 0", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
                        React.createElement("span", null, "UI 捕捉快捷键"),
                        hotkeyControl)),
                React.createElement("p", { style: { color: UI.text2, margin: "2px 2px 0", fontSize: 12.5 } },
                    "每个区域的实际缩放 = 全局偏移 + 个体偏移（下方逐项叠加）。放大/缩小快捷键随时调全局字号（默认未设置，可用 Ctrl = / Ctrl - 预填——会接管浏览器同键位的页面缩放）。捕捉快捷键召唤「准星选取」：关掉设置面板再按它，选取任意区域，ESC / 右键退出。"),
                React.createElement("div", { style: sectionTitle }, "按界面区域微调 · 总偏移 = 全局 " + fmt(s.delta) + " + 个体"),
                React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 6, margin: "4px 0 2px" } },
                    React.createElement("button", {
                        onClick: () => enterPickMode(),
                        style: btnStyle("primary"),
                        title: "点击后用准星在页面上点选任意区块；快捷键在本页上方设置（默认未设置）"
                    }, "🎯 选取区域"),
                    React.createElement("button", { onClick: refresh, style: btnStyle(), title: "重新扫描页面样式并拉取各插件描述" }, "刷新")),
                React.createElement("div", Object.assign({}, cardStyle, { padding: 0 }),
                    plugins.length === 0
                        ? React.createElement("p", { style: { padding: "10px 16px", color: UI.text2 } }, "（未扫描到界面插件——点“刷新”重试）")
                        : plugins.map((p, i) => React.createElement("div", {
                            key: p.id,
                            style: { padding: "8px 16px", borderBottom: i === plugins.length - 1 ? "none" : "1px solid " + UI.border }
                        },
                            React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
                                React.createElement("div", { style: { flex: "1 1 auto", minWidth: 0 } },
                                    React.createElement("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                                        /* "shell" is this engine's OWN bucket for the non-plugin
                                           dist stylesheet, so naming it is self-knowledge, not
                                           knowledge about other plugins. */
                                        p.id === "shell" ? "主界面外壳" : prettifyId(p.id)),
                                    React.createElement("div", {
                                        title: descriptions[p.id] || "",
                                        style: { color: UI.text2, fontSize: 11.5, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
                                    }, descriptions[p.id] || p.count + " 条字号规则")),
                                stepper(
                                    s.perPlugin[p.id] === undefined ? null : s.perPlugin[p.id],
                                    (v) => {
                                        const next = Object.assign({}, s.perPlugin);
                                        if (v === null) delete next[p.id]; else next[p.id] = v;
                                        update({ perPlugin: next });
                                    }))))),
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 } },
                    React.createElement("span", { style: { color: UI.text2, fontSize: 12 } },
                        "已发现 " + plugins.length + " 个界面插件 · " + plugins.reduce((a, p) => a + p.count, 0) + " 条字号规则"),
                    React.createElement("button", {
                        style: btnStyle(),
                        onClick: () => {
                            const d = { uiFont: DEFAULTS.uiFont, codeFont: DEFAULTS.codeFont, delta: 3, perPlugin: {}, perRule: {}, perToken: {}, hotkey: s.hotkey, hotkeyUp: s.hotkeyUp, hotkeyDown: s.hotkeyDown };
                            saveSettings(d).catch((e) => { console.error("[dsh-ui-font] save failed", e); });
                            reapply().catch((e) => {
                                window.__dshUiFontDebug = { at: new Date().toISOString(), error: String(e && e.message ? e.message : e) };
                            });
                            setS(d);
                            refresh();
                        }
                    }, "重置默认")));
        }

        /* ---------------- plugin entry ---------------- */
        /* Required client services — a cordis inject DECLARATION (array),
           not a function: the runner reads it to wait for services and then
           calls apply(ctx) with ctx.slots available. */
        const inject = ["slots"];
        function apply(ctx) {
            // Settings page: one section ("字体") in the GUI settings panel.
            ctx.slots.inject("settings.section", () => ctx.slots.register(
                { name: "settings.section", id: "ui-font", order: 95, label: "字体" },
                () => React.createElement(FontSettingsPage)
            ));

            if (typeof document === "undefined") return;
            // Startup: apply font styles, retrying every 100ms until the shell
            // stylesheet is parsed (after a refresh our bundle can beat the
            // <link>), then a BOUNDED settle burst for lazily injected plugin
            // styles. After that the engine is static and re-scans only when
            // the settings page opens or the user hits 刷新.
            reapplyWhenReady();
            const settleTimers = [1000, 3000, 8000].map((delay) =>
                setTimeout(() => reapply(), delay));

            // Global hotkeys (user-configurable in this plugin's settings; all
            // default EMPTY = disabled — hardcoded defaults like Ctrl+Shift+F
            // collide with search shortcuts everywhere). Work anywhere,
            // including with the settings panel closed.
            //   hotkey     -> toggle pick mode
            //   hotkeyUp   -> global font delta +1
            //   hotkeyDown -> global font delta -1
            // NOTE: assigning Ctrl+= / Ctrl+- / Ctrl+0 takes over the browser's
            // own page-zoom keys (that is the point — our delta is the
            // finer-grained replacement), so those combos are offered as
            // one-click presets rather than defaults.
            const bumpDelta = (d) => {
                const s2 = validateSettings(readSettingsSync());
                s2.delta = Math.max(-3, Math.min(20, s2.delta + d));
                saveSettings(s2).catch((e) => { console.error("[dsh-ui-font] save failed", e); });
                reapply().catch((e) => {
                    window.__dshUiFontDebug = { at: new Date().toISOString(), error: String(e && e.message ? e.message : e) };
                });
                window.dispatchEvent(new Event("dsh-ui-font:changed"));
            };
            const onHotkey = (e) => {
                /* IME (Chinese input) swallows keys as keyCode 229 — nothing
                   we can do but ignore, else every keystroke looks like 229. */
                if (e.isComposing === true) return;
                if (!e.ctrlKey && !e.altKey && !e.metaKey) return; /* hotkeys always carry one */
                const s = readSettingsSync();
                /* Chromium's browser-level zoom on Ctrl+=/- must be cancelled
                   at the EARLIEST page moment: capture on window, and also
                   match the legacy keyCode forms (187 '=' / 189 '-') because
                   some layouts deliver those without a usable code. */
                const matchesComboOrLegacy = (stored, keyCode) => {
                    if (comboMatches(stored, e)) return true;
                    if (stored === "" || e.code === "") return false;
                    const parts = stored.split("+");
                    const main = parts[parts.length - 1];
                    if (e.ctrlKey !== (parts.indexOf("Ctrl") !== -1)) return false;
                    if (e.altKey !== (parts.indexOf("Alt") !== -1)) return false;
                    if (e.shiftKey !== (parts.indexOf("Shift") !== -1)) return false;
                    if (e.metaKey !== (parts.indexOf("Meta") !== -1)) return false;
                    if (main === "=" && keyCode === 187) return true;
                    if (main === "-" && keyCode === 189) return true;
                    if (main === "+" && keyCode === 187) return true;
                    return false;
                };
                if (matchesComboOrLegacy(s.hotkey, e.keyCode)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (pickSession !== null) exitPickMode();
                    else enterPickMode();
                    return;
                }
                if (matchesComboOrLegacy(s.hotkeyUp, e.keyCode)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    bumpDelta(1);
                    return;
                }
                if (matchesComboOrLegacy(s.hotkeyDown, e.keyCode)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    bumpDelta(-1);
                    return;
                }
            };
            /* window capture = earliest the page can see a key; document as a
               second registration costs nothing and covers focus quirks. */
            window.addEventListener("keydown", onHotkey, true);
            document.addEventListener("keydown", onHotkey, true);

            ctx.effect(() => () => {
                window.removeEventListener("keydown", onHotkey, true);
                document.removeEventListener("keydown", onHotkey, true);
                exitPickMode();
                for (const t of settleTimers) clearTimeout(t);
                if (engineStyleTag !== null) { engineStyleTag.remove(); engineStyleTag = null; }
            }, "dsh-ui-font: runtime font engine");
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
