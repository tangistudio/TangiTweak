/**
 * settings.json ⇄ storage. Text is rendered deterministically from storage
 * (sparse overrides only; `{}` when everything uses defaults), so the Editor,
 * popup and synced folder always converge without patching shadow text.
 */
import {
    renderSettings,
    parseSettings,
    planSettings,
    DEFAULT_LOG_CAP,
    DEFAULT_LOG_LEVEL,
    DEFAULT_BODY_CAP,
    BODY_CAP_KEY,
    isTextTypes,
    isBodyCap,
    type GlobalSettings,
    type SettingsDoc,
    type SettingsPlan,
} from "../shared/settingsJson";
import { DEFAULT_TEXT_TYPES } from "../shared/bodyKind";
import { DATA_FOLDER_KEY, dataFolderName, dataFolderProblem } from "../shared/tweakData";
import { setDataFolder } from "./tweakDataFiles";

function storageGet(keys: string[]): Promise<Record<string, any>> {
    return new Promise((r) => chrome.storage.local.get(keys, (d) => r(d || {})));
}

function storageSet(items: Record<string, any>): Promise<void> {
    return new Promise((r) => chrome.storage.local.set(items, () => r()));
}

function storageRemove(key: string): Promise<void> {
    return new Promise((r) => {
        if (typeof chrome.storage.local.remove === "function") chrome.storage.local.remove(key, () => r());
        else chrome.storage.local.set({ [key]: undefined }, () => r());
    });
}

export async function currentSettings(): Promise<GlobalSettings> {
    const g = await storageGet(["resLogLevel", "resLogCap", TEXT_TYPES_KEY, BODY_CAP_KEY, DATA_FOLDER_KEY]);
    const globals: GlobalSettings = { logLevel: g.resLogLevel ?? DEFAULT_LOG_LEVEL, logCap: g.resLogCap ?? DEFAULT_LOG_CAP, dataFolder: dataFolderName(g[DATA_FOLDER_KEY]) };
    if (isTextTypes(g[TEXT_TYPES_KEY])) globals.textTypes = g[TEXT_TYPES_KEY];
    if (isBodyCap(g[BODY_CAP_KEY])) globals.bodyCap = g[BODY_CAP_KEY];
    return globals;
}

/** chrome.storage key of textTypes (absent: DEFAULT_TEXT_TYPES) */
export const TEXT_TYPES_KEY = "resTextTypes";

export function settingsTextParses(text: string): boolean {
    try {
        parseSettings(text);
        return true;
    } catch {
        return false;
    }
}

export async function getSettingsText(): Promise<string> {
    return renderSettings(await currentSettings());
}

async function applyPlan(plan: SettingsPlan): Promise<{ error?: string }> {
    const patch: Record<string, any> = {};
    if (plan.logLevel) patch.resLogLevel = plan.logLevel;
    if (plan.logCap) patch.resLogCap = plan.logCap;
    if (Object.keys(patch).length) await storageSet(patch);
    if (plan.textTypes) {
        if (JSON.stringify(plan.textTypes) === JSON.stringify(DEFAULT_TEXT_TYPES)) await storageRemove(TEXT_TYPES_KEY);
        else await storageSet({ [TEXT_TYPES_KEY]: plan.textTypes });
    }
    if (plan.bodyCap) {
        if (plan.bodyCap === DEFAULT_BODY_CAP) await storageRemove(BODY_CAP_KEY);
        else await storageSet({ [BODY_CAP_KEY]: plan.bodyCap });
    }
    return plan.dataFolder ? setDataFolder(plan.dataFolder) : {};
}

/** Apply settings.json text to storage (a full-file edit: omitted entries reset to defaults). */
export async function applySettingsText(text: string): Promise<{ error?: string }> {
    let doc: SettingsDoc;
    try {
        doc = parseSettings(text);
    } catch (e: any) {
        return { error: String(e?.message || e).split("\n")[0] };
    }
    return applySettingsDoc(doc);
}

/** Apply a structured settings document (Import… of a zip's settings.json). */
export async function applySettingsDoc(doc: SettingsDoc): Promise<{ error?: string }> {
    const df = doc.globals.dataFolder;
    const problem = df === undefined ? null : dataFolderProblem(df);
    if (problem) return { error: `"dataFolder": ${problem}` };
    return applyPlan(planSettings(doc, await currentSettings()));
}
