/**
 * Export…/Import… zip: laid out like the synced scripts folder, so a zip
 * and a synced folder look the same:
 *
 *   settings.json                   extension settings
 *   atlas/package.json              a tweak: its data files and scripts, by path
 *   atlas/index.tsx
 *   atlas/.tweak/settings.json      its data folder, only when "Include my settings and saved data" is ticked
 *   atlas/.tweak/stores/seen.json
 *   mock/empty/                     an empty folder (a folder entry)
 *
 * Import also takes a zip of the synced folder itself (one top folder
 * holding settings.json, tsconfig.json or tt-api.d.ts is unwrapped); the
 * support files folder sync writes, dot entries and node_modules are skipped.
 */
import { readZipEntries, writeZip } from "./zip";
import { SETTINGS_FILE, SCHEMA_FILE, parseSettings } from "./settingsJson";
import { API_DTS_FILE, PACKAGE_JSON_FILE, TSCONFIG_FILE } from "./generatedFiles";
import { bytesToImageDataUrl, imageDataUrlToBytes, isImageDataPath } from "./scriptImports";
import { dataFilePathProblem, folderPathProblem, isScriptFilePath, scriptFileName, scriptNameFromFile, scriptNameProblem } from "./scriptName";
import { isInFolder } from "./folders";
import { isBundlePackageJson } from "./packageMetadata";
import { dataFileTarget, dataFolderName, dataFolderProblem, DEFAULT_DATA_FOLDER } from "./tweakData";

export const EXPORT_ZIP_NAME = "tangitweak-export.zip";

const MANIFEST = "package.json";

/**
 * The package folders an Import… zip brings a version of: each folder with
 * a package.json, and the zip's one folder when everything is in it (what
 * Export Package… makes).
 */
export function packageRoots(zip: Pick<ExportContents, "settings" | "scripts" | "dataFiles" | "folders">): string[] {
    const roots = new Map<string, string>();
    const add = (f: string) => void (f && !roots.has(f.toLowerCase()) && roots.set(f.toLowerCase(), f));
    for (const d of zip.dataFiles) if (d.path.toLowerCase().endsWith("/" + MANIFEST)) add(d.path.slice(0, -MANIFEST.length - 1));
    const paths = [...zip.scripts.map((s) => s.file), ...zip.dataFiles.map((d) => d.path), ...zip.folders];
    const top = paths.length ? paths[0].split("/")[0] : "";
    if (zip.settings === null && top && paths.every((p) => p.includes("/") && p.split("/")[0].toLowerCase() === top.toLowerCase())) add(top);
    // a package inside another is part of it
    return [...roots.values()].filter((r, _, all) => !all.some((o) => o !== r && isInFolder(r, o)));
}

/** of `existing` paths, those inside the zip's package folders that the zip doesn't have: the imported version deleted them */
export function filesGoneFrom(zip: Pick<ExportContents, "settings" | "scripts" | "dataFiles" | "folders">, existing: string[]): string[] {
    const roots = packageRoots(zip);
    const has = new Set([...zip.scripts.map((s) => s.file), ...zip.dataFiles.map((d) => d.path)].map((p) => p.toLowerCase()));
    return existing.filter((p) => roots.some((r) => isInFolder(p, r)) && !has.has(p.toLowerCase()));
}

export interface ExportContents {
    /** settings.json text; null when the zip has none */
    settings: string | null;
    /** the tweaks' data folder files: `root` is the tweak's folder ("atlas/"), `file` the path in its data folder ("stores/seen.json") */
    tweakData: { root: string; file: string; text: string }[];
    /** `file`: the path in the zip (`mock/helpers.ts`) */
    scripts: { name: string; file: string; code: string }[];
    dataFiles: { path: string; text: string }[];
    /** empty folders */
    folders: string[];
    /** files that are none of the above (not counting folder sync's support files) */
    ignored: string[];
}

const GENERATED = new Set([API_DTS_FILE, TSCONFIG_FILE, PACKAGE_JSON_FILE, SCHEMA_FILE]);
const isScriptFile = isScriptFilePath;

/** the folders with nothing in them: no path and no other folder inside */
export function emptyFolders(folders: string[], paths: string[]): string[] {
    const seen = new Set<string>();
    return folders.filter((f) => {
        const k = f.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return !paths.some((p) => isInFolder(p, f)) && !folders.some((o) => isInFolder(o, f));
    });
}

/** the export zip: scripts at their file paths, data files, empty folders, settings.json and the tweaks' data folder files (full paths) */
export function buildExportZip(
    c: { settings?: string | null; scripts: { name: string; code: string }[]; dataFiles: { path: string; text: string }[]; folders?: string[]; tweakData?: { path: string; text: string }[] },
    date?: Date
): Uint8Array {
    const files: Record<string, string | Uint8Array> = {};
    if (c.settings != null) files[SETTINGS_FILE] = c.settings;
    for (const f of c.folders ?? []) files[f + "/"] = "";
    for (const s of c.scripts) files[scriptFileName(s.name)] = s.code;
    for (const d of c.dataFiles) files[d.path] = isImageDataPath(d.path) ? imageDataUrlToBytes(d.text) : d.text;
    for (const d of c.tweakData ?? []) files[d.path] = d.text;
    return writeZip(files, date);
}

/** the data folder name a zip's settings.json gives (else `fallback`) */
function zipDataFolder(settings: Uint8Array | undefined, fallback: string): string {
    if (!settings) return fallback;
    try {
        const df = parseSettings(new TextDecoder().decode(settings)).globals.dataFolder;
        return df === undefined ? DEFAULT_DATA_FOLDER : dataFolderName(df);
    } catch {
        return fallback;
    }
}

/**
 * What an export zip (or a zipped scripts folder) holds. The tweaks' data
 * folders are named by the zip's settings.json, else `dataFolder`.
 */
export async function readExportZip(buf: ArrayBuffer, dataFolder = DEFAULT_DATA_FOLDER): Promise<ExportContents> {
    const skipSeg = (s: string, i: number, all: string[]) => (s.startsWith(".") && !(i === all.length - 1 && s === ".gitignore")) || s === "__MACOSX" || s === "node_modules" || s === "__tests__";
    // dot folders are skipped, except what may be a tweak's data folder (sorted out below)
    const maybeDataFolder = (s: string, i: number, all: string[]) => i < all.length - 1 && s.startsWith(".") && !dataFolderProblem(s);
    const raw = await readZipEntries(buf, (p) => !p.split("/").some((s, i, all) => skipSeg(s, i, all) && !maybeDataFolder(s, i, all)));
    let files = raw.files;
    let dirs = raw.folders.filter((d) => !d.split("/").some(skipSeg));
    const all = [...Object.keys(files), ...dirs];
    const top = all.length ? all[0].split("/")[0] : "";
    if (top && all.every((p) => p === top || p.startsWith(top + "/")) && [SETTINGS_FILE, TSCONFIG_FILE, API_DTS_FILE].some((f) => files[`${top}/${f}`])) {
        const cut = top.length + 1;
        files = Object.fromEntries(Object.entries(files).map(([p, b]) => [p.slice(cut), b]));
        dirs = dirs.filter((d) => d !== top).map((d) => d.slice(cut));
    }
    const utf8 = new TextDecoder();
    const df = zipDataFolder(files[SETTINGS_FILE], dataFolder);
    const roots = Object.entries(files)
        .filter(([p, b]) => (p === MANIFEST || p.endsWith("/" + MANIFEST)) && !p.split("/").some(skipSeg) && isBundlePackageJson(utf8.decode(b)))
        .map(([p]) => p.slice(0, -MANIFEST.length));
    const out: ExportContents = { settings: null, scripts: [], dataFiles: [], folders: [], ignored: [], tweakData: [] };
    for (const [p, bytes] of Object.entries(files)) {
        const inData = dataFileTarget(p, df, roots);
        if (inData) {
            if ("error" in inData) out.ignored.push(p);
            else out.tweakData.push({ root: inData.root, file: p.slice(inData.root.length + df.length + 1), text: utf8.decode(bytes) });
        } else if (p.split("/").some(skipSeg)) continue;
        else if (p === SETTINGS_FILE) out.settings = utf8.decode(bytes);
        else if (GENERATED.has(p)) continue;
        else if (isScriptFile(p) && !scriptNameProblem(scriptNameFromFile(p))) out.scripts.push({ name: scriptNameFromFile(p), file: p, code: utf8.decode(bytes) });
        else if (!dataFilePathProblem(p)) out.dataFiles.push({ path: p, text: isImageDataPath(p) ? bytesToImageDataUrl(p, bytes) : utf8.decode(bytes) });
        else out.ignored.push(p);
    }
    const paths = [...out.scripts.map((s) => s.file), ...out.dataFiles.map((d) => d.path)];
    out.folders = emptyFolders(dirs.filter((d) => d && !folderPathProblem(d)), paths);
    return out;
}
