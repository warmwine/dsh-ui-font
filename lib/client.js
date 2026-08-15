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

        /* ---------------- settings store ---------------- */
        const DEFAULTS = { uiFont: "LXGW WenKai", codeFont: "LXGW WenKai Mono", delta: 3, perPlugin: {} };
        function loadSettings() {
            try {
                const raw = localStorage.getItem(LS_KEY);
                if (raw === null) return { uiFont: DEFAULTS.uiFont, codeFont: DEFAULTS.codeFont, delta: 3, perPlugin: {} };
                const s = JSON.parse(raw);
                const legacyUi = typeof s.uiFont === "string" && LEGACY_UI[s.uiFont] !== undefined ? LEGACY_UI[s.uiFont] : undefined;
                const legacyCode = typeof s.codeFont === "string" && LEGACY_CODE[s.codeFont] !== undefined ? LEGACY_CODE[s.codeFont] : undefined;
                return {
                    uiFont: legacyUi !== undefined ? legacyUi : sanitizeFamily(s.uiFont) || DEFAULTS.uiFont,
                    codeFont: legacyCode !== undefined ? legacyCode : sanitizeFamily(s.codeFont) || DEFAULTS.codeFont,
                    delta: typeof s.delta === "number" && s.delta >= -3 && s.delta <= 20 ? Math.round(s.delta) : 3,
                    perPlugin: (s.perPlugin !== null && typeof s.perPlugin === "object") ? s.perPlugin : {}
                };
            } catch (e) {
                return { uiFont: DEFAULTS.uiFont, codeFont: DEFAULTS.codeFont, delta: 3, perPlugin: {} };
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
        function findShellRoot() {
            for (const sheet of Array.from(document.styleSheets)) {
                const node = sheet.ownerNode;
                if (node === null || node === undefined || node.tagName !== "LINK") continue;
                if (typeof node.href !== "string" || node.href.indexOf("/assets/") === -1) continue;
                try {
                    for (const r of Array.from(sheet.cssRules)) {
                        if (r.type === 1 && r.selectorText === ":root") return r;
                    }
                } catch (e) { /* ignore */ }
            }
            return null;
        }

        /* Rewrite every px-carrying --dsw-font-* property of the shell :root,
           scaling sizes (and proportional line-heights / shorthands) by delta. */
        function buildTokenCss(s, rootRule) {
            if (rootRule === null) return "";
            const st = rootRule.style;
            const famSize = {};
            for (let i = 0; i < st.length; i++) {
                const prop = st.item(i);
                const m = prop.match(/^--dsw-font-(.+)-font-size$/);
                if (m === null) continue;
                const v = st.getPropertyValue(prop).trim();
                if (/^[\d.]+px$/.test(v)) famSize[m[1]] = parseFloat(v);
            }
            for (const k of Object.keys(STOCK_FALLBACK)) {
                if (famSize[k] === undefined) famSize[k] = STOCK_FALLBACK[k];
            }
            const lines = [":root{"];
            for (let i = 0; i < st.length; i++) {
                const prop = st.item(i);
                if (prop.indexOf("--dsw-font-") !== 0) continue;
                const value = st.getPropertyValue(prop).trim();
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
            const css = buildTokenCss(s, findShellRoot()) + "\n" + buildRuleCss(s, data);
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
                React.createElement("p", { style: { color: "rgba(128,128,128,.9)", margin: "4px 0 8px" } },
                    "全局偏移作用于聊天正文、标题、代码块与全部界面插件；下面可按界面区域在此基础上单独微调。"),
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0 4px" } },
                    React.createElement("h4", { style: { margin: 0 } }, "按界面区域微调"),
                    React.createElement("button", { onClick: refresh, title: "重新扫描页面样式并拉取各插件描述" }, "刷新")),
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
                                    }, -6, 8))),
                        React.createElement("div", {
                            title: descriptions[p.id] || "",
                            style: { color: "rgba(128,128,128,.9)", fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
                        }, descriptions[p.id] || "—"))),
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 } },
                    React.createElement("span", { style: { color: "rgba(128,128,128,.9)", fontSize: 12 } },
                        "已发现 " + plugins.length + " 个界面插件 · " + plugins.reduce((a, p) => a + p.count, 0) + " 条字号规则"),
                    React.createElement("button", {
                        onClick: () => {
                            const d = { uiFont: DEFAULTS.uiFont, codeFont: DEFAULTS.codeFont, delta: 3, perPlugin: {} };
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
            ctx.effect(() => () => {
                for (const t of settleTimers) clearTimeout(t);
                if (engineStyleTag !== null) { engineStyleTag.remove(); engineStyleTag = null; }
            }, "dsh-ui-font: runtime font engine");
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
