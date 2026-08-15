// dsh-ui-font — host half.
//
// Two loopback JSON routes (called only when the settings page opens or the
// user hits Refresh — never at startup):
//   POST /api/dsh-ui-font/descriptions { ids: string[] } -> { descriptions: {} }
//     package.json description per plugin package (README first heading fallback).
//   GET  /api/dsh-ui-font/fonts -> { families: string[] }
//     Installed system font families, read by parsing each font file's sfnt
//     `name` table directly (pure fs — no PowerShell, no child processes,
//     works on Windows/macOS/Linux).
import { open, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const nodeRequire = createRequire(import.meta.url);

/** Required services. */
const inject = ["webServer"];

const ROUTE_DESCRIPTIONS = "/api/dsh-ui-font/descriptions";
const ROUTE_FONTS = "/api/dsh-ui-font/fonts";

/* ===================================================================== *
 * System font family enumeration (sfnt name-table parsing)
 * ===================================================================== */

/** Platform font directories per OS (all optional — failures are skipped). */
function fontDirectories() {
    const home = homedir();
    if (process.platform === "win32") {
        const windir = process.env.SystemRoot !== undefined && process.env.SystemRoot !== "" ? process.env.SystemRoot : "C:\\Windows";
        return [join(windir, "Fonts"), join(home, "AppData", "Local", "Microsoft", "Windows", "Fonts")];
    }
    if (process.platform === "darwin") {
        return ["/System/Library/Fonts", "/Library/Fonts", join(home, "Library", "Fonts")];
    }
    return ["/usr/share/fonts", "/usr/local/share/fonts", join(home, ".fonts"), join(home, ".local", "share", "fonts")];
}

/** Recursively collect font file paths (ttf/otf/ttc), depth- and count-capped. */
async function collectFontFiles(dir, depth, out) {
    if (depth > 4 || out.length > 4000) return;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { await collectFontFiles(full, depth + 1, out); continue; }
        if (/\.(ttf|otf|ttc)$/i.test(e.name)) out.push(full);
    }
}

/**
 * Read the `name` table of one sfnt font and return its family name
 * (nameID 1), preferring the Windows/English record. null when unreadable.
 * Only the header + name-table slices are read — never the whole file.
 */
async function familyOfFontFile(handle, sfntOffset) {
    async function readAt(position, length) {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, position);
        return bytesRead === length ? buf : null;
    }
    const header = await readAt(sfntOffset, 12);
    if (header === null) return null;
    const numTables = header.readUInt16BE(4);
    if (numTables === 0 || numTables > 128) return null;
    const records = await readAt(sfntOffset + 12, numTables * 16);
    if (records === null) return null;
    for (let i = 0; i < numTables; i++) {
        const tag = records.toString("latin1", i * 16, i * 16 + 4);
        if (tag !== "name") continue;
        // table offsets are absolute file offsets — even inside a TTC
        // (the TTC subfont base must NOT be added).
        const tableOffset = records.readUInt32BE(i * 16 + 8);
        const tableLength = records.readUInt32BE(i * 16 + 12);
        if (tableLength === 0 || tableLength > 65536) return null;
        const table = await readAt(tableOffset, tableLength);
        if (table === null) return null;
        const count = table.readUInt16BE(2);
        const storageOffset = table.readUInt16BE(4); // string storage, relative to table start
        let fallback = null;
        for (let r = 0; r < count && r < 256; r++) {
            const base = 6 + r * 12;
            const platformID = table.readUInt16BE(base);
            const languageID = table.readUInt16BE(base + 4);
            const nameID = table.readUInt16BE(base + 6);
            if (nameID !== 1) continue; // 1 = family
            const length = table.readUInt16BE(base + 8);
            const offset = table.readUInt16BE(base + 10); // relative to string storage
            const strPos = storageOffset + offset;
            if (strPos + length > tableLength) continue;
            const raw = table.subarray(strPos, strPos + length);
            let decoded = "";
            if (platformID === 3 || platformID === 0) {
                // UTF-16BE -> UTF-16LE (copy first: subarray is a view)
                try {
                    if (raw.length % 2 === 0) decoded = Buffer.from(raw).swap16().toString("utf16le");
                } catch { /* malformed record */ }
            } else {
                decoded = raw.toString("latin1");
            }
            const trimmed = decoded.trim();
            if (trimmed === "") continue;
            // defense in depth: a real family name never carries control chars
            if (/[\x00-\x08\x0e-\x1f]/.test(trimmed)) continue;
            if (platformID === 3 && languageID === 0x0409) return trimmed; // en-US canonical
            if (fallback === null) fallback = trimmed;
        }
        return fallback;
    }
    return null;
}

/** Families of one font file; TTC containers contribute each subfont. */
async function familiesOfFile(path) {
    let handle = null;
    try {
        handle = await open(path, "r");
        const head = Buffer.alloc(4);
        const { bytesRead } = await handle.read(head, 0, 4, 0);
        if (bytesRead !== 4) return [];
        const tag = head.toString("latin1");
        if (tag === "ttcf") {
            const ttcHeader = Buffer.alloc(12);
            const r2 = await handle.read(ttcHeader, 0, 12, 0);
            if (r2.bytesRead !== 12) return [];
            const numFonts = Math.min(ttcHeader.readUInt32BE(8), 8);
            const offsetsBuf = Buffer.alloc(numFonts * 4);
            const r3 = await handle.read(offsetsBuf, 0, numFonts * 4, 12);
            if (r3.bytesRead !== numFonts * 4) return [];
            const out = [];
            for (let i = 0; i < numFonts; i++) {
                const fam = await familyOfFontFile(handle, offsetsBuf.readUInt32BE(i * 4));
                if (fam !== null) out.push(fam);
            }
            return out;
        }
        if (tag.charCodeAt(0) !== 0) { // ttf/otf: first uint32 is 0x00010000 or 'OTTO'
            if (tag !== "OTTO" && head.readUInt16BE(0) !== 1) return [];
        }
        const fam = await familyOfFontFile(handle, 0);
        return fam !== null ? [fam] : [];
    } catch {
        return [];
    } finally {
        if (handle !== null) { try { await handle.close(); } catch { /* closing */ } }
    }
}

let fontCache = { at: 0, families: null };

/** All installed font family names, sorted. Cached briefly (30s). */
async function enumerateFontFamilies() {
    if (fontCache.families !== null && Date.now() - fontCache.at < 30000) return fontCache.families;
    const files = [];
    for (const dir of fontDirectories()) await collectFontFiles(dir, 0, files);
    const set = new Set();
    const CHUNK = 32;
    for (let i = 0; i < files.length; i += CHUNK) {
        const results = await Promise.all(files.slice(i, i + CHUNK).map(familiesOfFile));
        for (const families of results) for (const f of families) set.add(f);
    }
    const families = Array.from(set).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    fontCache = { at: Date.now(), families };
    return families;
}

/* ===================================================================== *
 * Plugin package descriptions
 * ===================================================================== */

/** Every dsh profile's node_modules directory (~/.dsh/profiles/<name>/node_modules).
    Profiles carry all installed plugins — official and community alike. */
async function profileNodeModulesDirs() {
    const root = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ""
        ? process.env.DSH_HOME
        : join(homedir(), ".dsh");
    const profilesDir = join(root, "profiles");
    let entries = [];
    try { entries = await readdir(profilesDir, { withFileTypes: true }); } catch { /* no profiles */ }
    return entries.filter((e) => e.isDirectory()).map((e) => join(profilesDir, e.name, "node_modules"));
}

/** Locate a package's package.json: resolver first (works when our own file
    sits inside a real node_modules), then every profile's node_modules. */
async function resolveManifestPath(id) {
    if (typeof id !== "string" || id === "" || id === "shell") return null;
    try {
        return nodeRequire.resolve(id + "/package.json");
    } catch { /* not reachable from this file's location — try profile roots */ }
    for (const nm of await profileNodeModulesDirs()) {
        const candidate = join(nm, id, "package.json");
        try { await readFile(candidate, "utf8"); return candidate; } catch { /* next */ }
    }
    return null;
}

/** One plugin's display description: package.json description, else the
    README's first `#` heading. null when nothing found. */
async function describePackage(id) {
    const manifestPath = await resolveManifestPath(id);
    if (manifestPath === null) return null;
    try {
        const pkg = JSON.parse(await readFile(manifestPath, "utf8"));
        if (typeof pkg.description === "string" && pkg.description !== "") return pkg.description;
    } catch { /* malformed manifest */ }
    try {
        const readme = await readFile(join(dirname(manifestPath), "README.md"), "utf8");
        const heading = readme.match(/^#\s+(.+)$/m);
        if (heading !== null) return heading[1].trim().slice(0, 160);
    } catch { /* no readme */ }
    return null;
}

/* ===================================================================== *
 * Routes
 * ===================================================================== */

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body)
    });
    res.end(body);
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
            if (data.length > 65536) { req.destroy(); resolve(undefined); }
        });
        req.on("end", () => {
            try { resolve(JSON.parse(data === "" ? "{}" : data)); } catch { resolve(undefined); }
        });
        req.on("error", () => resolve(undefined));
    });
}

function apply(ctx) {
    ctx.effect(() => {
        const disposeDescriptions = ctx.webServer.register({
            kind: "exact",
            path: ROUTE_DESCRIPTIONS,
            handler: async (req, res) => {
                if (req.method !== "POST") {
                    sendJson(res, 405, { error: "method not allowed: " + req.method });
                    return;
                }
                const body = await readJsonBody(req);
                const ids = body !== undefined && Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
                const descriptions = {};
                await Promise.all(ids.map(async (id) => {
                    const d = await describePackage(id);
                    if (d !== null) descriptions[id] = d;
                }));
                sendJson(res, 200, { descriptions });
            }
        });
        const disposeFonts = ctx.webServer.register({
            kind: "exact",
            path: ROUTE_FONTS,
            handler: async (req, res) => {
                if (req.method !== "GET" && req.method !== "HEAD") {
                    sendJson(res, 405, { error: "method not allowed: " + req.method });
                    return;
                }
                try {
                    const families = await enumerateFontFamilies();
                    sendJson(res, 200, { families });
                } catch (e) {
                    sendJson(res, 200, { families: [] });
                }
            }
        });
        return () => { disposeDescriptions(); disposeFonts(); };
    }, "dsh-ui-font: descriptions + fonts routes");
}

export { apply, inject, enumerateFontFamilies, familiesOfFile };
