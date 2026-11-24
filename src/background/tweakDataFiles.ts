/**
 * Tweak data folders ⇄ storage (shared/tweakData.ts). The files are
 * rendered from storage, never stored: each bundle's entry owns its
 * folder's settings.json (enable switch, layer setting, non-default params) and one
 * stores/<id>.json per persisted global store. A file edited in the Editor
 * or on disk applies only when all of it is valid.
 */
import { listDataFiles, listFolders, listScripts, loadAllParamValues, loadScriptLayers, setEnabled, setParamValue, setScriptLayer, type Script } from "./engine/scriptStore";
import { storeOwner } from "./engine/stores";
import { bundleOf, dataReader, entryName } from "../shared/tweakBundle";
import { STORE_ID } from "../shared/tweakApi";
import {
    DATA_FOLDER_KEY,
    dataFileTarget,
    dataFolderName,
    dataFolderProblem,
    parseStoreFile,
    planTweakSettings,
    renderStoreFile,
    renderTweakSettings,
    storeFilePath,
    tweakSettingsPath,
} from "../shared/tweakData";

/** a bundle whose entry owns a data folder */
export interface TweakTarget {
    /** the bundle's folder, with a trailing "/" */
    root: string;
    script: Script;
}

/** the bundles' entries, by bundle folder */
export async function tweakTargets(): Promise<TweakTarget[]> {
    const [scripts, dataFiles] = await Promise.all([listScripts(), listDataFiles()]);
    const read = dataReader(dataFiles);
    const names = new Set(scripts.map((s) => s.meta.name));
    const out: TweakTarget[] = [];
    for (const s of scripts) {
        const b = bundleOf(s.meta.name, read);
        if (b && entryName(b, (n) => names.has(n)) === s.meta.name) out.push({ root: b.root, script: s });
    }
    return out;
}

export async function getDataFolder(): Promise<string> {
    const d = await new Promise<Record<string, any>>((r) => chrome.storage.local.get([DATA_FOLDER_KEY], (x) => r(x || {})));
    return dataFolderName(d[DATA_FOLDER_KEY]);
}

/** rename every bundle's data folder (Folder Sync moves them on disk); refused when a bundle has files at the new name */
export async function setDataFolder(name: unknown): Promise<{ error?: string }> {
    const problem = dataFolderProblem(name);
    if (problem) return { error: problem };
    const df = name as string;
    if (df === (await getDataFolder())) return {};
    const [targets, scripts, dataFiles, folders] = await Promise.all([tweakTargets(), listScripts(), listDataFiles(), listFolders()]);
    const paths = [...scripts.map((s) => s.meta.name), ...dataFiles.map((d) => d.path), ...folders].map((p) => p.toLowerCase());
    for (const t of targets) {
        const at = `${t.root}${df}`.toLowerCase();
        if (paths.some((p) => p === at || p.startsWith(at + "/"))) return { error: `${t.root}${df} already exists — pick another name` };
    }
    await new Promise<void>((r) => chrome.storage.local.set({ [DATA_FOLDER_KEY]: df }, () => r()));
    return {};
}

/** a data folder file: `path` in full; `root` the tweak's folder; `scriptId` its entry's */
export interface TweakDataFile {
    path: string;
    text: string;
    root: string;
    scriptId: string;
}

/** each bundle's data folder files */
export async function tweakDataFiles(only?: TweakTarget[]): Promise<TweakDataFile[]> {
    const [df, targets, values, layers] = await Promise.all([getDataFolder(), only ? Promise.resolve(only) : tweakTargets(), loadAllParamValues(), loadScriptLayers()]);
    const out: TweakDataFile[] = [];
    for (const { root, script } of targets) {
        const at = { root, scriptId: script.id };
        out.push({ path: tweakSettingsPath(root, df), text: renderTweakSettings(script.enabled, script.paramDefs, values[script.id], layers[script.id]), ...at });
        const stores = (await storeOwner.exportPersisted([{ id: script.id, name: "s" }])).s ?? {};
        for (const id of Object.keys(stores).sort()) if (STORE_ID.test(id)) out.push({ path: storeFilePath(root, df, id), text: renderStoreFile(stores[id] as Record<string, any>), ...at });
    }
    return out;
}

/**
 * Apply a data folder file's text (null: it was deleted — the setting or
 * store goes back to its default). Nothing applies when it's invalid.
 */
export async function applyTweakDataFile(path: string, text: string | null): Promise<{ error?: string }> {
    const [df, targets] = await Promise.all([getDataFolder(), tweakTargets()]);
    const where = dataFileTarget(path, df, targets.map((t) => t.root));
    const target = where && targets.find((t) => t.root === where.root);
    if (!where || !target) return { error: `${path} isn't in a tweak's ${df} folder` };
    if ("error" in where) return { error: where.error };
    const { script } = target;
    try {
        if ("settings" in where) {
            const plan = planTweakSettings(text ?? "{}", { enabled: script.enabled, layer: (await loadScriptLayers())[script.id], defs: script.paramDefs, values: (await loadAllParamValues())[script.id] });
            for (const [k, v] of Object.entries(plan.params)) await setParamValue(script.id, k, v);
            if (plan.layer !== undefined) await setScriptLayer(script.id, plan.layer ?? undefined);
            if (plan.enabled !== undefined) await setEnabled(script.id, plan.enabled);
        } else if (text === null) await storeOwner.deleteStore(script.id, where.store);
        else await storeOwner.replace(script.id, where.store, parseStoreFile(text));
    } catch (e: any) {
        return { error: String(e?.message ?? e).split("\n")[0] };
    }
    return {};
}
