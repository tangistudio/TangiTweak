/**
 * settings.json — extension settings as a minimal, sparse JSON document
 * (like VS Code's settings.json). A tweak's own enable switch and params live
 * in its data folder (shared/tweakData.ts), not here.
 *
 * Only non-default values are written (`{}` when everything uses defaults).
 * Omitting a key (or clearing the file to `{}`) resets it to its default:
 *
 *   {
 *     "logLevel": "debug",
 *     "dataFolder": ".data"
 *   }
 */
import { DEFAULT_TEXT_TYPES } from "./bodyKind";
import { DEFAULT_DATA_FOLDER, dataFolderProblem } from "./tweakData";

export const SETTINGS_FILE = "settings.json";
/** written to the synced folder before 0.40.1-alpha; an old one is removed, and never read as a data file */
export const SCHEMA_FILE = "settings.schema.json";
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const DEFAULT_LOG_LEVEL = "info";
export const DEFAULT_LOG_CAP = 500;
/** Network body capture cap in kB (bodyCap) */
export const DEFAULT_BODY_CAP = 2048;
export const BODY_CAP_MIN = 16;
export const BODY_CAP_MAX = 16384;
/** chrome.storage key of bodyCap (absent: DEFAULT_BODY_CAP) */
export const BODY_CAP_KEY = "resBodyCap";
export const isBodyCap = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= BODY_CAP_MIN && v <= BODY_CAP_MAX;
/** chrome.storage key of debuggerFriendlyOverlays (absent or false: off) */
export const DEBUGGER_OVERLAYS_KEY = "resDebuggerOverlays";
export const DEBUGGER_OVERLAYS_DESC =
    "Render every tweak.onOverlay and toast pane in a closed shadow root instead of an extension iframe, so debugger extensions like Playwriter can attach without removing them. The page can see keys typed into them. Chrome MV3 needs user scripts on.";
export const BODY_CAP_DESC = `Network view: kB of each request/response body kept (${BODY_CAP_MIN}..${BODY_CAP_MAX})`;

/** a valid textTypes value: a non-empty list of non-empty strings */
export const isTextTypes = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "");
export const TEXT_TYPES_DESC = "Content-Types onResponseBody gets as text (globs; `*` = anything). Other bodies are binary and reach only handlers with `binary: true` or `binary: both`.";

export interface GlobalSettings {
    logLevel: string;
    logCap: number;
    /** Content-Type globs onResponseBody gets as text; undefined = DEFAULT_TEXT_TYPES */
    textTypes?: string[];
    /** Network body capture cap in kB; undefined = DEFAULT_BODY_CAP */
    bodyCap?: number;
    /** each tweak's data folder name; undefined = DEFAULT_DATA_FOLDER */
    dataFolder?: string;
    /** every onOverlay and toast pane renders in a closed shadow root (no extension iframe); undefined = false */
    debuggerFriendlyOverlays?: boolean;
}

export interface SettingsDoc {
    globals: Partial<GlobalSettings>;
}

export type SettingsPlan = Partial<GlobalSettings>;

export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Build the sparse JSON object representing non-default settings. */
export function buildSettingsObject(g: Partial<GlobalSettings>): Record<string, any> {
    const out: Record<string, any> = {};
    if (g.logLevel !== undefined && g.logLevel !== DEFAULT_LOG_LEVEL) out.logLevel = g.logLevel;
    if (g.logCap !== undefined && g.logCap !== DEFAULT_LOG_CAP) out.logCap = g.logCap;
    if (g.bodyCap !== undefined && g.bodyCap !== DEFAULT_BODY_CAP) out.bodyCap = g.bodyCap;
    if (g.textTypes !== undefined && !same(g.textTypes, DEFAULT_TEXT_TYPES)) out.textTypes = g.textTypes;
    if (g.dataFolder !== undefined && g.dataFolder !== DEFAULT_DATA_FOLDER) out.dataFolder = g.dataFolder;
    if (g.debuggerFriendlyOverlays === true) out.debuggerFriendlyOverlays = true;
    return out;
}

export function renderSettings(g: Partial<GlobalSettings>): string {
    return JSON.stringify(buildSettingsObject(g), null, 2) + "\n";
}

/**
 * Parse `settings.json` text; throws on JSON syntax errors or non-object root.
 * Also accepts `{ settings: { ... } }` objects for compatibility.
 */
export function parseSettings(text: string): SettingsDoc {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(`invalid JSON (${(e as Error).message})`);
    }
    if (!isObj(raw)) throw new Error(`${SETTINGS_FILE} must be a JSON object`);

    const gSrc = isObj(raw.settings) ? { ...raw.settings, ...raw } : raw;
    const globals: Partial<GlobalSettings> = {};
    for (const k of ["logLevel", "logCap", "textTypes", "bodyCap", "dataFolder", "debuggerFriendlyOverlays"] as const) if (k in gSrc) globals[k] = gSrc[k];
    return { globals };
}

/** What must change in `current` for storage to match `doc` (invalid values are skipped). */
export function planSettings(doc: SettingsDoc, current: GlobalSettings): SettingsPlan {
    const globals: SettingsPlan = {};
    const lv = doc.globals.logLevel === undefined ? DEFAULT_LOG_LEVEL : doc.globals.logLevel;
    if (typeof lv === "string" && (LOG_LEVELS as readonly string[]).includes(lv) && lv !== current.logLevel) globals.logLevel = lv;
    const cap = doc.globals.logCap === undefined ? DEFAULT_LOG_CAP : doc.globals.logCap;
    if (typeof cap === "number" && Number.isInteger(cap) && cap >= 100 && cap <= 10000 && cap !== current.logCap) globals.logCap = cap;
    const tt = doc.globals.textTypes === undefined ? [...DEFAULT_TEXT_TYPES] : doc.globals.textTypes;
    if (isTextTypes(tt) && !same(tt, current.textTypes ?? DEFAULT_TEXT_TYPES)) globals.textTypes = tt;
    const bc = doc.globals.bodyCap === undefined ? DEFAULT_BODY_CAP : doc.globals.bodyCap;
    if (isBodyCap(bc) && bc !== (current.bodyCap ?? DEFAULT_BODY_CAP)) globals.bodyCap = bc;
    const df = doc.globals.dataFolder === undefined ? DEFAULT_DATA_FOLDER : doc.globals.dataFolder;
    if (!dataFolderProblem(df) && df !== (current.dataFolder ?? DEFAULT_DATA_FOLDER)) globals.dataFolder = df;
    const dfo = doc.globals.debuggerFriendlyOverlays === undefined ? false : doc.globals.debuggerFriendlyOverlays;
    if (typeof dfo === "boolean" && dfo !== !!current.debuggerFriendlyOverlays) globals.debuggerFriendlyOverlays = dfo;
    return globals;
}
