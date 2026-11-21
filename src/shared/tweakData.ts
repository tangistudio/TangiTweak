/**
 * A tweak's data folder (`.tweak` by default; the "Tweak data folder"
 * setting): its enable switch and params, and its persisted global stores,
 * as files next to its code. TangiTweak's storage stays the source of
 * truth; the files mirror it both ways through Folder Sync, and the
 * Explorer shows them in each bundle without one.
 *
 *   <tweak>/.tweak/settings.json        { "enabled": true, "params": { …non-default values } }
 *   <tweak>/.tweak/stores/<id>.json     a `tweak.globalStore("<id>", …)` store's data
 *
 * They're never scripts, modules or data files, and tests never read them.
 */
import { isParamDef, isParamGroup, isValidParamValue, paramDefault, resolveParamValues, type ParamTree } from "./scriptDef";
import { badValue, isPlainObject, STORE_MAX_BYTES } from "./storeOps";
import { STORE_ID } from "./tweakApi";

export const DEFAULT_DATA_FOLDER = ".tweak";
/** chrome.storage key of the data folder's name (absent: DEFAULT_DATA_FOLDER) */
export const DATA_FOLDER_KEY = "resDataFolder";
export const TWEAK_SETTINGS_FILE = "settings.json";
export const STORES_DIR = "stores";
export const DATA_FOLDER_DESC = "The folder inside each tweak that holds its settings and saved data (one name, like .tweak)";

/** why `name` can't be the data folder's name, or null */
export function dataFolderProblem(name: unknown): string | null {
    if (typeof name !== "string" || !name) return "the data folder needs a name";
    if (/[/\\]/.test(name)) return "the data folder is one folder name, without slashes";
    if (name === "." || name === "..") return `"${name}" isn't a folder name`;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return "the data folder's name is letters, digits, “.”, “-” and “_”";
    if (name.length > 64) return "the data folder's name is at most 64 characters";
    const low = name.toLowerCase();
    if (low === "node_modules" || low === "__tests__" || low.startsWith(".tangitweak") || low === ".git") return `"${name}" is taken`;
    return null;
}

/** the data folder's name from storage (an invalid one: the default) */
export const dataFolderName = (stored: unknown): string => (typeof stored === "string" && !dataFolderProblem(stored) ? stored : DEFAULT_DATA_FOLDER);

export const tweakSettingsPath = (root: string, df: string): string => `${root}${df}/${TWEAK_SETTINGS_FILE}`;
export const storeFilePath = (root: string, df: string, id: string): string => `${root}${df}/${STORES_DIR}/${id}.json`;

/** where a path is in one of the bundles' data folders (`roots`: bundle folders with a trailing "/"): its settings.json or a store file */
export function dataFileTarget(path: string, df: string, roots: Iterable<string>): { root: string; settings: true } | { root: string; store: string } | { root: string; error: string } | null {
    let best: string | null = null;
    for (const r of roots) if (path.startsWith(`${r}${df}/`) && (best === null || r.length > best.length)) best = r;
    if (best === null) return null;
    const rest = path.slice(best.length + df.length + 1);
    if (rest === TWEAK_SETTINGS_FILE) return { root: best, settings: true };
    const m = new RegExp(`^${STORES_DIR}/([^/]+)\\.json$`).exec(rest);
    if (m && STORE_ID.test(m[1])) return { root: best, store: m[1] };
    return { root: best, error: m ? `"${m[1]}" isn't a store ID (lowercase letters, digits, "-", "_" and "." not first)` : `TangiTweak keeps only ${TWEAK_SETTINGS_FILE} and ${STORES_DIR}/<id>.json here` };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** the params that differ from their defaults, nested like the param tree */
export function nonDefaultParams(defs: ParamTree, vals: Record<string, any> | undefined, skipEnabled = true): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, node] of Object.entries(defs)) {
        if (skipEnabled && k === "enabled") continue;
        if (isParamDef(node)) {
            const v = vals?.[k];
            if (v !== undefined && !same(v, paramDefault(node))) out[k] = v;
        } else if (isParamGroup(node)) {
            const sub = nonDefaultParams(node, vals?.[k], false);
            if (Object.keys(sub).length) out[k] = sub;
        }
    }
    return out;
}

/** a tweak's settings.json: its enable switch and its non-default params */
export function renderTweakSettings(enabled: boolean, defs: ParamTree | undefined, values: Record<string, any> | undefined): string {
    const params = defs ? nonDefaultParams(defs, resolveParamValues(defs, values)) : {};
    return JSON.stringify({ enabled, ...(Object.keys(params).length ? { params } : {}) }, null, 2) + "\n";
}

export interface TweakSettingsPlan {
    enabled?: boolean;
    /** dotted param key → value to store */
    params: Record<string, any>;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`invalid JSON (${(e as Error).message})`);
    }
}

/**
 * What must change for storage to match a tweak's settings.json; throws
 * (nothing applies) when anything in it is invalid. A param it leaves out
 * goes back to its default.
 */
export function planTweakSettings(text: string, cur: { enabled: boolean; defs?: ParamTree; values?: Record<string, any> }): TweakSettingsPlan {
    const doc = parseJson(text);
    if (!isPlainObject(doc)) throw new Error(`${TWEAK_SETTINGS_FILE} must be a JSON object`);
    for (const k of Object.keys(doc)) if (k !== "enabled" && k !== "params" && k !== "$schema") throw new Error(`unknown key "${k}" (it holds "enabled" and "params")`);
    if (doc.enabled !== undefined && typeof doc.enabled !== "boolean") throw new Error(`"enabled" must be true or false`);
    if (doc.params !== undefined && !isPlainObject(doc.params)) throw new Error(`"params" must be an object`);
    const plan: TweakSettingsPlan = { params: {} };
    const enabled = doc.enabled ?? true;
    if (enabled !== cur.enabled) plan.enabled = enabled;
    const defs = cur.defs ?? {};
    const resolved = resolveParamValues(defs, cur.values);
    const walk = (tree: ParamTree, given: Record<string, any>, now: Record<string, any> | undefined, prefix: string, top: boolean) => {
        if (Object.keys(defs).length)
            for (const k of Object.keys(given)) if (!(k in tree) || (top && k === "enabled")) throw new Error(`"params" has no "${prefix}${k}"`);
        for (const [k, node] of Object.entries(tree)) {
            if (top && k === "enabled") continue;
            const key = prefix + k;
            if (isParamDef(node)) {
                const v = given[k] === undefined ? paramDefault(node) : given[k];
                if (!isValidParamValue(node, v)) throw new Error(`"params.${key}": ${JSON.stringify(v)} isn't a valid value`);
                if (!same(v, now?.[k])) plan.params[key] = v;
            } else if (isParamGroup(node)) {
                const sub = given[k] ?? {};
                if (!isPlainObject(sub)) throw new Error(`"params.${key}" must be an object`);
                walk(node, sub, now?.[k], `${key}.`, false);
            }
        }
    };
    walk(defs, doc.params ?? {}, resolved, "", true);
    return plan;
}

/** a store file's data; throws when it isn't a JSON object a store can hold */
export function parseStoreFile(text: string): Record<string, any> {
    const data = parseJson(text);
    if (!isPlainObject(data)) throw new Error("a store file holds a JSON object");
    const bad = badValue(data);
    if (bad) throw new Error(bad);
    if (text.length > STORE_MAX_BYTES * 2) throw new Error(`a store holds at most ${STORE_MAX_BYTES / 1024} kB`);
    return data;
}

export const renderStoreFile = (data: Record<string, any>): string => JSON.stringify(data, null, 2) + "\n";
