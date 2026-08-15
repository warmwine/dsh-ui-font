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
        /** Canonical label of a keydown combo: modifiers (in fixed order) +
            main key, e.g. "Ctrl+Alt+F". Empty main key never happens (modifier-
            only presses are filtered by the recorder). */
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
            return e.code === expected;
        }

        /** Modifier-only keys (which the recorder waits through). */
        function isModifierCode(code) {
            return code.startsWith("Control") || code.startsWith("Shift") || code.startsWith("Alt") || code.startsWith("Meta");
        }

        /* ---------------- settings store ---------------- */
        const DEFAULTS = { uiFont: "LXGW WenKai", codeFont: "LXGW WenKai Mono", delta: 3, perPlugin: {}, hotkey: "" };
        function loadSettings() {
            try {
                const raw = localStorage.getItem(LS_KEY);
                if (raw === null) return { uiFont: DEFAULTS.uiFont, codeFont: DEFAULTS.codeFont, delta: 3, perPlugin: {}, hotkey: "" };
                const s = JSON.parse(raw);
                const legacyUi = typeof s.uiFont === "string" && LEGACY_UI[s.uiFont] !== undefined ? LEGACY_UI[s.uiFont] : undefined;
                const legacyCode = typeof s.codeFont === "string" && LEGACY_CODE[s.codeFont] !== undefined ? LEGACY_CODE[s.codeFont] : undefined;
                return {
                    uiFont: legacyUi !== undefined ? legacyUi : sanitizeFamily(s.uiFont) || DEFAULTS.uiFont,
                    codeFont: legacyCode !== undefined ? legacyCode : sanitizeFamily(s.codeFont) || DEFAULTS.codeFont,
                    delta: typeof s.delta === "number" && s.delta >= -3 && s.delta <= 20 ? Math.round(s.delta) : 3,
                    perPlugin: (s.perPlugin !== null && typeof s.perPlugin === "object") ? s.perPlugin : {},
                    hotkey: typeof s.hotkey === "string" && s.hotkey.length <= 30 ? s.hotkey : ""
                };
            } catch (e) {
                return { uiFont: DEFAULTS.uiFont, codeFont: DEFAULTS.codeFont, delta: 3, perPlugin: {}, hotkey: "" };
            }
        }
        function saveSettings(s) {
            try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ }
        }

        /* ---------------- CSSOM scan ---------------- */
        /* Returns { stocks: {family: stockSize}, byPlugin: Map(plugin -> Map(sel -> {size, lh})) } */
        function scan() {
            const stocks = {};
            const byPlugin = new Map();
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
                        if (size === null) continue;
                        const sel = (r.selectorText || "").replace(/\s+/g, " ").trim();
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

            if (shellRoot !== null) {
                const st = shellRoot.style;
                for (let i = 0; i < st.length; i++) {
                    const prop = st.item(i);
                    const m = prop.match(/^--dsw-font-(.+)-font-size$/);
                    if (m === null) continue;
                    const v = st.getPropertyValue(prop).trim();
                    if (/^[\d.]+px$/.test(v)) stocks[m[1]] = parseFloat(v);
                }
            }
            if (Object.keys(stocks).length === 0) {
                for (const k of Object.keys(STOCK_FALLBACK)) stocks[k] = STOCK_FALLBACK[k];
            }
            return { stocks: stocks, byPlugin: byPlugin };
        }

        /* ---------------- override generation ---------------- */
        /* Collect EVERY shell-sheet style rule that declares --dsw-font-*
           custom properties. The stock tokens do NOT all live on :root — the
           size/line-height tokens are declared on `body` (found the hard way),
           and any selector carrying them matters. Returns a merged virtual
           declaration map {prop: value} across those rules. */
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
                    const st = r.style;
                    if (st === null) continue;
                    let has = false;
                    for (let i = 0; i < st.length; i++) {
                        if (st.item(i).indexOf("--dsw-font-") === 0) { has = true; break; }
                    }
                    if (has === false) continue;
                    for (let i = 0; i < st.length; i++) {
                        const prop = st.item(i);
                        if (prop.indexOf("--dsw-font-") === 0) merged.set(prop, st.getPropertyValue(prop).trim());
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
                const stock = famSize[famM[1]];
                if (stock === undefined) continue;
                const n = Math.round((stock + s.delta) * 10) / 10;
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
                const extra = typeof s.perPlugin[plugin] === "number" ? s.perPlugin[plugin] : 0;
                const d = s.delta + extra;
                if (d === 0) continue;
                for (const selEntry of Array.from(bucket.entries())) {
                    const sel = selEntry[0], info = selEntry[1];
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

        function reapply() {
            const s = loadSettings();
            const data = scan();
            const css = buildTokenCss(s, findShellTokenDecls()) + "\n" + buildRuleCss(s, data);
            ensureTag().textContent = css;
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

        /** class name -> owning plugin id, built once per pick session from
            every plugin stylesheet's parsed selectorText. */
        function buildClassIndex() {
            const index = new Map();
            for (const sheet of Array.from(document.styleSheets)) {
                const node = sheet.ownerNode;
                if (node === null || node === undefined || node.tagName !== "STYLE") continue;
                const plugin = node.dataset !== undefined ? node.dataset.plugin : undefined;
                if (plugin === undefined || plugin === PLUGIN_ID) continue;
                let rules = [];
                try { rules = Array.from(sheet.cssRules); } catch (e) { continue; }
                const visit = (list) => {
                    for (const r of list) {
                        if (r.type === 1 && typeof r.selectorText === "string") {
                            for (const part of r.selectorText.split(",")) {
                                for (const m of part.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
                                    if (!index.has(m[1])) index.set(m[1], plugin);
                                }
                            }
                        } else if (r.type === 4 || r.type === 12) {
                            try { visit(Array.from(r.cssRules)); } catch (e) { /* skip */ }
                        }
                    }
                };
                visit(rules);
            }
            return index;
        }

        /** Which plugin styles the element (or its near ancestor)? null = the
            element is token-driven (shell), no plugin class nearby. */
        function pluginForElement(el, index) {
            const check = (node) => {
                if (node === null || node.classList === undefined) return null;
                for (const cls of node.classList) {
                    if (index.has(cls)) return index.get(cls);
                }
                return null;
            };
            let hit = check(el);
            if (hit !== null) return hit;
            let p = el.parentElement;
            for (let i = 0; i < 3 && p !== null; i++) {
                hit = check(p);
                if (hit !== null) return hit;
                p = p.parentElement;
            }
            return null;
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

            const targetOf = (e) => {
                const t = e.target;
                return (t !== null && t !== document.documentElement && t !== document.body) ? t : null;
            };

            const onMove = (e) => {
                if (phase !== "hover") return;
                const t = targetOf(e);
                if (t === null) { outline.style.display = "none"; tip.style.display = "none"; return; }
                const rect = t.getBoundingClientRect();
                outline.style.display = "block";
                outline.style.left = (rect.left - 1) + "px";
                outline.style.top = (rect.top - 1) + "px";
                outline.style.width = (rect.width + 2) + "px";
                outline.style.height = (rect.height + 2) + "px";

                const plugin = pluginForElement(t, index);
                const size = getComputedStyle(t).fontSize;
                const isXterm = t.closest(".xterm") !== null;
                const name = plugin === null ? "主界面（令牌驱动 · 全局偏移）"
                    : plugin === "shell" ? "主界面外壳"
                    : prettifyId(plugin);
                tip.style.display = "block";
                tip.textContent = name + " · " + size + (isXterm ? " · 终端字体由 dsh-ssh 内置" : "");
                const tx = Math.min(e.clientX + 14, window.innerWidth - 300);
                const ty = e.clientY + 18 < window.innerHeight - 40 ? e.clientY + 18 : e.clientY - 34;
                tip.style.left = tx + "px";
                tip.style.top = ty + "px";
            };

            /** Adjust and persist one step (±1); returns the new value. */
            const bump = (plugin, d) => {
                const s2 = loadSettings();
                let value;
                if (plugin === null) {
                    s2.delta = Math.max(-3, Math.min(20, s2.delta + d));
                    value = s2.delta;
                } else {
                    const cur = typeof s2.perPlugin[plugin] === "number" ? s2.perPlugin[plugin] : 0;
                    value = Math.max(-6, Math.min(20, cur + d));
                    s2.perPlugin = Object.assign({}, s2.perPlugin);
                    if (value === 0) delete s2.perPlugin[plugin];
                    else s2.perPlugin[plugin] = value;
                }
                saveSettings(s2);
                reapply();
                window.dispatchEvent(new Event("dsh-ui-font:changed"));
                return value;
            };

            const showControl = (x, y, plugin, sizePx, isXterm) => {
                control = document.createElement("div");
                const cx = Math.min(x, window.innerWidth - 280);
                const cy = Math.min(y + 12, window.innerHeight - 90);
                control.style.cssText = "position:fixed;left:" + cx + "px;top:" + cy + "px;z-index:" + PICK_Z
                    + ";background:#111827;color:#f9fafb;border-radius:10px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;align-items:center;gap:10px;font-size:13px";
                const nameDiv = document.createElement("div");
                nameDiv.style.cssText = "max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
                nameDiv.textContent = plugin === null ? "主界面（全局偏移）"
                    : plugin === "shell" ? "主界面外壳"
                    : prettifyId(plugin);
                const sizeDiv = document.createElement("div");
                sizeDiv.style.cssText = "font-size:11px;opacity:.7";
                sizeDiv.textContent = isXterm ? "终端字体由 dsh-ssh 内置，不受控制" : "选取时字号 " + sizePx;
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
                    const st = loadSettings();
                    if (plugin === null) return st.delta;
                    return typeof st.perPlugin[plugin] === "number" ? st.perPlugin[plugin] : 0;
                };
                const paint = (v) => { valueSpan.textContent = (v > 0 ? "+" : "") + v; };
                paint(readValue());
                minus.addEventListener("click", () => paint(bump(plugin, -1)));
                plus.addEventListener("click", () => paint(bump(plugin, 1)));
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
                const plugin = pluginForElement(t, index);
                const size = getComputedStyle(t).fontSize;
                const isXterm = t.closest(".xterm") !== null;
                /* end hover phase, keep the session alive for the control bar */
                phase = "control";
                cursorTag.remove();
                outline.style.display = "none";
                tip.style.display = "none";
                showControl(e.clientX, e.clientY, plugin, size, isXterm);
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
        function FontSettingsPage() {
            const [s, setS] = React.useState(loadSettings);
            const [scanData, setScanData] = React.useState(null);
            const [descriptions, setDescriptions] = React.useState({});
            const [families, setFamilies] = React.useState(null); // null = loading, [] = unavailable

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
            React.useEffect(() => { refresh(); }, [refresh]);

            const update = (patch) => setS((prev) => {
                const next = Object.assign({}, prev, patch);
                saveSettings(next);
                reapply();
                return next;
            });

            /* Keep this page in sync with changes made outside React state —
               e.g. the pick-mode floating control (session-owned DOM) writes
               settings directly, from anywhere in the page. */
            React.useEffect(() => {
                const onExtern = () => setS(loadSettings());
                window.addEventListener("dsh-ui-font:changed", onExtern);
                return () => window.removeEventListener("dsh-ui-font:changed", onExtern);
            }, []);

            const plugins = scanData === null ? [] :
                Array.from(scanData.byPlugin.entries())
                    .map((e) => ({ id: e[0], count: e[1].size }))
                    .sort((a, b) => b.count - a.count);

            const row = (label, control) => React.createElement("div", {
                key: label,
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,.15)" }
            },
                React.createElement("span", { style: { flex: "0 0 auto" } }, label),
                React.createElement("div", { style: { flex: "1 1 auto", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, minWidth: 0 } }, control));

            /* Font picker over the host-enumerated system families. The stored
               value stays selectable even when the font list is still loading
               or the font has been uninstalled. */
            const fontSelect = (value, onChange) => {
                const list = families === null ? [] : families.slice();
                if (value !== "" && list.indexOf(value) === -1) list.push(value);
                return React.createElement("select", { value: value, onChange: onChange, style: { minWidth: 180, maxWidth: 260 } },
                    React.createElement("option", { key: "", value: "" }, "系统默认"),
                    list.map((f) => React.createElement("option", {
                        key: f, value: f,
                        style: { fontFamily: '"' + f + '"' }
                    }, families !== null && families.indexOf(f) === -1 ? f + "（未安装）" : f)));
            };

            const numberInput = (value, onChange, min, max) => React.createElement("input", {
                type: "number", min: min, max: max, step: 1,
                value: value === null || value === undefined ? "" : value,
                placeholder: "全局",
                onChange: (e) => {
                    const v = e.target.value;
                    onChange(v === "" ? null : Math.max(min, Math.min(max, Number(v))));
                },
                style: { width: 64 }
            });

            /* Hotkey row: record mode captures the next modifier combo.
               Empty (default) = disabled, flagged in red so users set it. */
            const [recording, setRecording] = React.useState(false);
            React.useEffect(() => {
                if (recording !== true) return;
                const onKey = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "Escape") { setRecording(false); return; }
                    if (isModifierCode(e.code)) return; /* wait for the main key */
                    if (!e.ctrlKey && !e.altKey && !e.metaKey) return; /* need ≥1 non-Shift modifier, else typing would fire it */
                    update({ hotkey: comboOf(e) });
                    setRecording(false);
                };
                window.addEventListener("keydown", onKey, true);
                return () => window.removeEventListener("keydown", onKey, true);
            }, [recording]);
            const hotkeyControl = React.createElement(React.Fragment, null,
                React.createElement("button", {
                    onClick: () => setRecording(recording !== true),
                    style: recording
                        ? { minWidth: 150, outline: "2px solid #e11d48" }
                        : (s.hotkey === "" ? { minWidth: 150, color: "#e11d48", borderColor: "#e11d48" } : { minWidth: 150 }),
                    title: "点击后按下组合键（需含 Ctrl/Alt/Meta 之一；ESC 取消）"
                },
                    recording ? "按下组合键…（ESC 取消）"
                        : s.hotkey === "" ? "⚠ 未设置 — 点击录制" : s.hotkey),
                s.hotkey === "" && recording !== true
                    ? React.createElement("span", { style: { color: "#e11d48", fontSize: 12 } }, "必须设置后才能用快捷键")
                    : null,
                s.hotkey !== "" && recording !== true
                    ? React.createElement("button", {
                        onClick: () => update({ hotkey: "" }),
                        title: "清除快捷键",
                        style: { height: 30, width: 30 }
                    }, "✕")
                    : null);

            return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                React.createElement("h3", { style: { margin: "4px 0 8px" } }, "字体与字号"),
                row("界面字体", fontSelect(s.uiFont, (e) => update({ uiFont: e.target.value }))),
                row("代码 / 等宽字体", fontSelect(s.codeFont, (e) => update({ codeFont: e.target.value }))),
                row("全局字号偏移",
                    React.createElement(React.Fragment, null,
                        React.createElement("input", { type: "range", min: -3, max: 20, step: 1, value: s.delta,
                            onChange: (e) => update({ delta: Number(e.target.value) }), style: { width: 160 } }),
                        React.createElement("span", { style: { minWidth: 44, textAlign: "right", fontVariantNumeric: "tabular-nums" } },
                            (s.delta >= 0 ? "+" : "") + s.delta + " px"))),
                row("UI 捕捉快捷键", hotkeyControl),
                React.createElement("p", { style: { color: "rgba(128,128,128,.9)", margin: "4px 0 8px" } },
                    "快捷键随时召唤「准星选取」（设置面板会挡住界面——关掉设置再按它选取任意区域，ESC/右键退出）；也可以直接用下面的「选取区域」按钮。"),
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0 4px", gap: 8 } },
                    React.createElement("h4", { style: { margin: 0 } }, "按界面区域微调"),
                    React.createElement("div", { style: { display: "flex", gap: 6 } },
                        React.createElement("button", {
                            onClick: () => enterPickMode(),
                            title: "点击后用准星在页面上点选任意区块；快捷键在本页上方设置（默认未设置）"
                        }, "🎯 选取区域"),
                        React.createElement("button", { onClick: refresh, title: "重新扫描页面样式并拉取各插件描述" }, "刷新"))),
                plugins.length === 0
                    ? React.createElement("p", null, "（未扫描到界面插件——点“刷新”重试）")
                    : plugins.map((p) => React.createElement("div", {
                        key: p.id,
                        style: { padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,.15)" }
                    },
                        React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
                            React.createElement("span", { style: { flex: "0 0 auto" } },
                                /* "shell" is this engine's OWN bucket for the non-plugin
                                   dist stylesheet, so naming it is self-knowledge, not
                                   knowledge about other plugins. */
                                p.id === "shell" ? "主界面外壳" : prettifyId(p.id)),
                            React.createElement("div", { style: { flex: "1 1 auto", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, minWidth: 0 } },
                                React.createElement("span", { style: { color: "rgba(128,128,128,.9)", fontSize: 12, marginRight: 6 } }, p.count + " 条"),
                                numberInput(
                                    s.perPlugin[p.id] === undefined ? null : s.perPlugin[p.id],
                                    (v) => {
                                        const next = Object.assign({}, s.perPlugin);
                                        if (v === null) delete next[p.id]; else next[p.id] = v;
                                        update({ perPlugin: next });
                                    }, -6, 20))),
                        React.createElement("div", {
                            title: descriptions[p.id] || "",
                            style: { color: "rgba(128,128,128,.9)", fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
                        }, descriptions[p.id] || "—"))),
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 } },
                    React.createElement("span", { style: { color: "rgba(128,128,128,.9)", fontSize: 12 } },
                        "已发现 " + plugins.length + " 个界面插件 · " + plugins.reduce((a, p) => a + p.count, 0) + " 条字号规则"),
                    React.createElement("button", {
                        onClick: () => {
                            const d = { uiFont: DEFAULTS.uiFont, codeFont: DEFAULTS.codeFont, delta: 3, perPlugin: {}, hotkey: s.hotkey };
                            saveSettings(d);
                            reapply();
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
            // Startup: apply font styles (one synchronous scan), then a BOUNDED
            // settle burst — some plugins inject their <style> tags lazily when
            // their UI first renders, after this scan. Three extra re-scans
            // (1s/3s/8s) cover them; after that the engine is fully static and
            // re-scans only when the settings page opens or the user hits 刷新.
            reapply();
            const settleTimers = [1000, 3000, 8000].map((delay) =>
                setTimeout(() => reapply(), delay));

            // Global pick-mode hotkey (user-configurable in this plugin's
            // settings; default EMPTY = disabled — a hardcoded default like
            // Ctrl+Shift+F collides with search shortcuts everywhere). Works
            // anywhere, including with the settings panel closed — that is the
            // point, since the panel covers the UI being tuned.
            const onHotkey = (e) => {
                if (!e.ctrlKey && !e.altKey && !e.metaKey) return; /* hotkeys always carry one */
                if (!comboMatches(loadSettings().hotkey, e)) return;
                e.preventDefault();
                if (pickSession !== null) exitPickMode();
                else enterPickMode();
            };
            document.addEventListener("keydown", onHotkey, true);

            ctx.effect(() => () => {
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
