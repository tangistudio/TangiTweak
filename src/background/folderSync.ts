/**
 * Background-side scripts-folder sync — the ONLY code that touches the
 * folder. Owns the directory handle and the polling loop (the background
 * never gets timer-throttled, so external edits apply immediately).
 *
 * Model:
 *  - storage is the source of truth for scripts; `owned` records, per
 *    script id, the file it owns and the hash of the content both sides
 *    last agreed on (the merge base).
 *  - storage → disk: every store change (manager save/rename/delete,
 *    import, popup, folder) schedules reconcileToDisk(), which writes,
 *    renames and deletes files to match.
 *  - disk → storage: the poller diffs file signatures against `known`;
 *    every write of ours records the resulting signature in `known`, so
 *    our own writes are never mistaken for external edits.
 *  - a file that vanished is renamed (not deleted + created) only when a
 *    new file carries its exact last-synced content.
 *  - everything runs one-at-a-time through `serial()`: a poll never
 *    interleaves with a write.
 *  - when both sides changed, the newer one wins and the other copy is kept
 *    in .tangitweak-backup/ (nothing is silently lost).
 *  - the folder is scanned recursively: subfolders are Folders, `.ts` files
 *    scripts (named by their path), `.json`/`.svg` files data files (`ownedData`
 *    is their `owned`). Dot-entries, node_modules and tooling config JSON
 *    are skipped. `known` keys are relative paths; a folder's ends in "/".
 *  - each tweak's data folder (shared/tweakData.ts) mirrors its settings
 *    and saved stores: `dataSigs` tracks those files apart from `known`,
 *    and the scan skips the folder.
 */
import { computeEvents, contentHash, loadSavedHandle, clearSavedHandle, saveHandle, type FileSig } from "../shared/folderSync";
import {
    saveScript, saveScriptsBatch, holdingChanges, deleteScript, newId, listScripts, onScriptsChanged, type Script,
    listDataFiles, saveDataFile, deleteDataFile, newDataFileId, listFolders, createFolder, deleteFolder,
} from "./engine/scriptStore";
import { progressReporter, type ProgressReporter } from "./engine/progress";
import type { DataFile } from "./engine/dataFiles";
import { getSettingsText, applySettingsText, settingsTextParses } from "./settingsFile";
import { applyTweakDataFile, getDataFolder, tweakDataFiles, tweakTargets } from "./tweakDataFiles";
import { DATA_FOLDER_KEY, STORES_DIR, TWEAK_SETTINGS_FILE } from "../shared/tweakData";
import { isBundlePackageJson, MANIFEST_FILE } from "../shared/packageMetadata";
import { storeOwner } from "./engine/stores";
import { jsonEqual } from "../shared/storeOps";
import { SETTINGS_FILE, SCHEMA_FILE } from "../shared/settingsJson";
import { API_DTS_FILE, BUILTIN_TYPINGS_ROOT, ESLINT_CONFIG_FILE, ESLINT_PLUGIN_FILE, GENERATED_NOTE, OLD_TEST_PKG_ROOT, PACKAGE_JSON_FILE, SDK_BUILTIN_TYPINGS, SDK_ROOT, TSCONFIG_FILE, eslintConfigText, eslintPluginText, packageJsonText, tsconfigText } from "../shared/generatedFiles";
import { broadcastToUi } from "./engine/logs";
import { dlogLevel } from "../shared/debugLog";
import { folderPathProblem, isConfigJsonPath, isGitignorePath, isScriptFilePath, scriptFileName, scriptNameFromFile } from "../shared/scriptName";
import { bytesToImageDataUrl, imageDataUrlToBytes, isDataSpec, isImageDataPath } from "../shared/scriptImports";
import { ancestorFolders, isInFolder } from "../shared/folders";
import { PACKAGE_TYPINGS_KEY, TYPINGS_ROOT, type StoredTypings } from "../shared/packageImports";
const POLL_MS = 1000;
export const BACKUP_DIR = ".tangitweak-backup";

/** canonical script file name for a display name */
function canonicalFileName(name: string): string {
    return scriptFileName(name);
}

const isScriptFile = isScriptFilePath;
const isDataFile = (path: string) => (isDataSpec(path) && !isConfigJsonPath(path) && !baseName(path).startsWith(".")) || (isGitignorePath(path) && path.includes("/"));
const isSyncedFile = (path: string) => isScriptFile(path) || isDataFile(path);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** `known` signature of a folder (they only appear and vanish) */
const FOLDER_SIG: FileSig = { lastModified: 0, size: 0 };

/** a script's (data file's) file and the content hash both sides last agreed on */
type Owned = { file: string; hash: string };

let dirHandle: any = null;
/** script files, data files and folders as last seen on disk (or as we just wrote them) */
let known = new Map<string, FileSig>();
/** script id → the file it owns + merge base */
let owned = new Map<string, Owned>();
/** data file id → the file it owns + merge base */
let ownedData = new Map<string, Owned>();
let timer: ReturnType<typeof setInterval> | null = null;
let displayPath = "";
let settingsHooked = false;
/** each tweak's data folder name (the "Tweak data folder" setting) */
let dataFolder = ".tweak";

// ---- one operation at a time ----
let chain: Promise<unknown> = Promise.resolve();
/** run `fn` after every queued sync operation; never await serial() from inside one */
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
}

// What the folder link is doing right now, for the Editor's sync button.
export type SyncActivity = "idle" | "sending" | "receiving";
let activity: SyncActivity = "idle";
let activityTimer: ReturnType<typeof setTimeout> | null = null;
let paused = false;

function broadcastStatus(): void {
    broadcastToUi({ type: "sync", status: getStatus() } as any);
}

/** Flag a write to (sending) or a pull from (receiving) the folder; falls back to idle shortly after. */
function signal(kind: Exclude<SyncActivity, "idle">): void {
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
        activityTimer = null;
        activity = "idle";
        broadcastStatus();
    }, 800);
    if (activity === kind) return;
    activity = kind;
    broadcastStatus();
}

/**
 * What our folder writes count as. A change made in the extension is sent;
 * the follow-up writes of applying a change read from the folder (its
 * settings.json section, the schema, a canonical file name) are part of
 * receiving it — they must not show as an upload of that same change.
 * Only set inside serial() operations, so it can't leak into another one.
 */
let writeKind: Exclude<SyncActivity, "idle"> = "sending";
async function writingAs<T>(kind: Exclude<SyncActivity, "idle">, fn: () => Promise<T>): Promise<T> {
    const prev = writeKind;
    writeKind = kind;
    try {
        return await fn();
    } finally {
        writeKind = prev;
    }
}

function describeHandle(handle: any): Promise<string> {
    return (async () => {
        try {
            if (typeof handle.getPath === "function") {
                return await handle.getPath(); // Chrome 129+: full path
            }
        } catch {}
        return handle.name || "(synced folder)";
    })();
}

async function refreshKnown(): Promise<void> {
    known = await scanFolder();
    await persistState();
}

// ---- persisted sync state ----
// The MV3 service worker can be stopped at any time (idle reaping, browser
// sleep, extension update). Without a persisted snapshot a restarted worker
// would rebuild `known` from the CURRENT folder and silently absorb every
// file added/changed/removed while it was down; without `owned` it would
// lose the merge base and couldn't tell which side changed.
const KNOWN_KEY = "folderSyncKnown";

function storageLocal(): chrome.storage.LocalStorageArea | null {
    return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
}

async function persistState(): Promise<void> {
    const area = storageLocal();
    if (!area) return;
    const state = { files: Object.fromEntries(known), owned: Object.fromEntries(owned), ownedData: Object.fromEntries(ownedData) };
    await new Promise<void>((r) => area.set({ [KNOWN_KEY]: state }, () => r()));
}

async function loadPersistedState(): Promise<{ files: Map<string, FileSig>; owned: Map<string, Owned>; ownedData: Map<string, Owned> } | null> {
    const area = storageLocal();
    if (!area) return null;
    const obj: any = await new Promise((r) => area.get(KNOWN_KEY, r));
    const st = obj?.[KNOWN_KEY];
    if (!st || typeof st !== "object") return null;
    const files = st.files && typeof st.files === "object" ? st.files : {};
    return {
        files: new Map(Object.entries(files) as [string, FileSig][]),
        owned: new Map(Object.entries(st.owned && typeof st.owned === "object" ? st.owned : {}) as [string, Owned][]),
        ownedData: new Map(Object.entries(st.ownedData && typeof st.ownedData === "object" ? st.ownedData : {}) as [string, Owned][]),
    };
}

async function clearPersistedState(): Promise<void> {
    const area = storageLocal();
    if (!area?.remove) return;
    await new Promise<void>((r) => area.remove(KNOWN_KEY, () => r()));
}

/**
 * List script files (every .ts file; .d.ts files are ignored), data files
 * (.json, except tooling config) and folders (key ending in "/"), by path,
 * recursively. Dot-entries and node_modules are skipped.
 */
async function scanFolder(handle: any = dirHandle, prefix = "", seen = new Map<string, FileSig>(), progress?: ProgressReporter): Promise<Map<string, FileSig>> {
    for await (const entry of handle.values()) {
        const path = prefix + entry.name;
        if (entry.kind === "directory") {
            if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__tests__" || folderPathProblem(path)) continue;
            if (entry.name === dataFolder && (await isTweakDir(handle))) continue;
            seen.set(path + "/", FOLDER_SIG);
            await scanFolder(entry, path + "/", seen, progress);
            continue;
        }
        progress?.step("listing", seen.size);
        if (entry.kind !== "file" || !isSyncedFile(path)) continue;
        let f: File;
        try {
            f = await entry.getFile();
        } catch (e: any) {
            // removed/renamed between listing and reading (editor atomic save)
            if (e?.name === "NotFoundError") continue;
            throw e;
        }
        seen.set(path, { lastModified: f.lastModified, size: f.size });
    }
    return seen;
}

/** a folder with a tweak's package.json (its data folder isn't scanned) */
async function isTweakDir(handle: any): Promise<boolean> {
    try {
        return isBundlePackageJson(await (await (await handle.getFileHandle(MANIFEST_FILE)).getFile()).text());
    } catch {
        return false;
    }
}

/** the folder holding `path` (relative to `root`); missing folders are created when `create` */
async function parentDir(path: string, create = false, root: any = dirHandle): Promise<any> {
    let d = root;
    for (const seg of path.split("/").slice(0, -1)) d = await d.getDirectoryHandle(seg, create ? { create: true } : undefined);
    return d;
}

async function fileHandleAt(path: string, create = false, root: any = dirHandle): Promise<any> {
    return (await parentDir(path, create, root)).getFileHandle(baseName(path), create ? { create: true } : undefined);
}

async function readDiskContent(fileName: string, handle: any = dirHandle): Promise<string> {
    const f = await (await fileHandleAt(fileName, false, handle)).getFile();
    if (isImageDataPath(fileName)) {
        const bytes = typeof f.arrayBuffer === "function" ? new Uint8Array(await f.arrayBuffer()) : new TextEncoder().encode(await f.text());
        return bytesToImageDataUrl(fileName, bytes);
    }
    return await f.text();
}

async function readText(fileName: string): Promise<string> {
    return readDiskContent(fileName);
}

/** the file's text, or null when it doesn't exist (any more) */
async function readTextOrNull(fileName: string): Promise<string | null> {
    try {
        return await readText(fileName);
    } catch {
        return null;
    }
}

async function statFile(fileName: string): Promise<FileSig | null> {
    try {
        const f = await (await fileHandleAt(fileName)).getFile();
        return { lastModified: f.lastModified, size: f.size };
    } catch {
        return null;
    }
}

/**
 * Write a file (its missing folders are created). For script and data
 * files the resulting signature (and its folders) go into `known` right
 * away, so the next poll doesn't see our own write as an external edit.
 */
async function writeFile(fileName: string, content: string, track = true): Promise<boolean> {
    if (!dirHandle) return false;
    try {
        const fh = await fileHandleAt(fileName, true);
        const w = await fh.createWritable();
        await w.write(isImageDataPath(fileName) ? (imageDataUrlToBytes(content) as BlobPart) : content);
        await w.close();
        signal(writeKind);
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync: writing "${fileName}" failed: ${e?.message || e}`);
        return false;
    }
    if (track && isSyncedFile(fileName)) {
        const sig = await statFile(fileName);
        if (sig) known.set(fileName, sig);
        for (const f of ancestorFolders(fileName)) known.set(f + "/", FOLDER_SIG);
        noteOwnWrite(fileName, content);
    }
    return true;
}

// Slow or cloud-backed drives can report one of our earlier writes back
// after a newer one (two quick saves). Such a stale echo is not an edit on
// disk: storage keeps its text and the file is rewritten.
const ECHO_MS = 60_000;
const recentWrites = new Map<string, { hash: string; at: number }[]>();
/** script ids whose file must be rewritten even though `owned` says in sync */
const rewrite = new Set<string>();

function noteOwnWrite(file: string, content: string): void {
    const now = Date.now();
    const list = (recentWrites.get(file) ?? []).filter((w) => now - w.at < ECHO_MS).slice(-7);
    list.push({ hash: contentHash(content), at: now });
    recentWrites.set(file, list);
}

function isStaleEcho(file: string, hash: string): boolean {
    const now = Date.now();
    return !!recentWrites.get(file)?.some((w) => w.hash === hash && now - w.at < ECHO_MS);
}

/** remove a script or data file */
async function removeFile(fileName: string): Promise<void> {
    try {
        await (await parentDir(fileName)).removeEntry(baseName(fileName));
        signal(writeKind);
    } catch {}
    known.delete(fileName);
}

async function folderExists(path: string): Promise<boolean> {
    try {
        await parentDir(path + "/x");
        return true;
    } catch {
        return false;
    }
}

/** keep a copy of a version about to be overwritten (both sides had changed) — at the same relative path in the backup folder */
async function backup(fileName: string, content: string, why: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dot = fileName.lastIndexOf(".");
    const name = dot > fileName.lastIndexOf("/") + 1 ? `${fileName.slice(0, dot)} ${stamp}${fileName.slice(dot)}.bak` : `${fileName} ${stamp}.bak`;
    try {
        const d = await parentDir(name, true, await dirHandle.getDirectoryHandle(BACKUP_DIR, { create: true }));
        const w = await (await d.getFileHandle(baseName(name), { create: true })).createWritable();
        await w.write(isImageDataPath(fileName) ? (imageDataUrlToBytes(content) as BlobPart) : content);
        await w.close();
        dlogLevel("sync", "warn", `Folder sync: ${why} — the other version was saved to ${BACKUP_DIR}/${name}`);
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync: ${why} — keeping a backup failed: ${e?.message || e}`);
    }
}

function displayNameFromFile(fileName: string): string {
    return scriptNameFromFile(fileName);
}

/** the script owning a file: by the recorded ownership, else by name */
function ownerOf(file: string, scripts: Script[]): Script | undefined {
    for (const [id, rec] of owned) {
        if (rec.file !== file) continue;
        const s = scripts.find((x) => x.id === id);
        if (s) return s;
    }
    return scripts.find((s) => canonicalFileName(s.meta.name) === file && !owned.has(s.id)) ??
        scripts.find((s) => canonicalFileName(s.meta.name) === file);
}

/** another script's file differs from `file` only by case (a clash on macOS/Windows) */
function caseClash(file: string, scripts: Script[], except?: string): Script | undefined {
    const key = file.toLowerCase();
    return scripts.find((s) => s.id !== except && canonicalFileName(s.meta.name).toLowerCase() === key);
}

// ---- disk → storage ----

type DiskSave = { id: string; code: string; name: string };

/** the script saves of the sync pass running now (see syncPass); null outside one */
let staged: Map<string, DiskSave> | null = null;

/** save a script read from disk: staged in a sync pass, else right away */
async function saveFromDisk(save: DiskSave): Promise<void> {
    if (staged) staged.set(save.id, save);
    else await saveScript(save);
}

/** the stored scripts with the running pass's staged saves applied (their names and code) */
async function scriptsNow(): Promise<Script[]> {
    const list = await listScripts();
    if (!staged?.size) return list;
    const out = list.map((s) => {
        const p = staged!.get(s.id);
        return p ? { ...s, code: p.code, meta: { ...s.meta, name: p.name } } : s;
    });
    const now = Date.now();
    for (const p of staged.values()) {
        if (list.some((s) => s.id === p.id)) continue;
        out.push({ id: p.id, code: p.code, enabled: true, createdAt: now, updatedAt: now, error: null, meta: { name: p.name, active: false, routes: [], match: [] } });
    }
    return out;
}

/**
 * Apply a pass of disk changes as one change: its script saves are staged
 * and compiled together at the end (after the data files and folders they
 * may import), and the store announces the change once, so open tabs only
 * ever get the finished state.
 */
async function syncPass<T>(progress: ProgressReporter, work: () => Promise<T>): Promise<T> {
    if (staged) return work();
    return holdingChanges(async () => {
        staged = new Map();
        try {
            return await work();
        } finally {
            const batch = [...staged.values()];
            staged = null;
            if (batch.length) {
                progress.step("compiling", 0, batch.length);
                await saveScriptsBatch(batch);
            }
        }
    });
}

/** a file's new text arrives for script `s` (edit on disk, or a re-added file) */
async function pullChange(file: string, text: string, s: Script): Promise<boolean> {
    const h = contentHash(text);
    const rec = owned.get(s.id);
    const storeHash = contentHash(s.code);
    if (h === storeHash) {
        owned.set(s.id, { file, hash: h }); // a touch, or both sides made the same edit
        return false;
    }
    // disk still holds the last-synced text: storage moved on and its write
    // is queued (or was skipped for this poll) — don't revert storage to the
    // old text; make sure the newer text gets written
    if (rec && rec.file === file && rec.hash === h) {
        scheduleReconcile();
        return false;
    }
    if (rec && rec.file === file && isStaleEcho(file, h)) {
        dlogLevel("sync", "debug", `Folder sync: "${file}" reported an earlier version written by TangiTweak — kept script "${s.meta.name}" and rewrote the file`);
        rewrite.add(s.id);
        scheduleReconcile();
        return false;
    }
    if (rec && rec.hash !== storeHash) {
        await backup(file, s.code, `"${file}" changed on disk while script "${s.meta.name}" also changed in the extension; the file wins`);
    }
    owned.set(s.id, { file, hash: h });
    await saveFromDisk({ id: s.id, code: text, name: s.meta.name });
    dlogLevel("sync", "info", `Folder sync: "${file}" changed on disk — script "${s.meta.name}" updated`);
    return true;
}

async function applyEvents(events: ReturnType<typeof computeEvents>): Promise<void> {
    if (!events.changed.length && !events.added.length && !events.removed.length) return;
    const progress = progressReporter("sync");
    try {
        await writingAs("receiving", async () => {
            if (!(await syncPass(progress, () => applyFolderEvents(events, progress)))) return;
            // the store's settings.json / schema follow the scripts now, as part
            // of receiving — the store-change reconcile then finds nothing to write
            await exportSettings();
        });
    } finally {
        progress.end();
    }
}

/** apply disk changes to the store; true when a script, data file or folder changed */
async function applyFolderEvents(events: ReturnType<typeof computeEvents>, progress: ProgressReporter): Promise<boolean> {
    const changed = events.changed.filter(isScriptFile);
    const added = events.added.filter(isScriptFile);
    const removed = events.removed.filter(isScriptFile);
    let scripts = await scriptsNow();
    const texts = new Map<string, string | null>();
    const read = async (f: string) => {
        if (!texts.has(f)) texts.set(f, await readTextOrNull(f));
        return texts.get(f)!;
    };
    // read every changed or new file first (several at once: a branch switch, a copied folder)
    const toRead = [...events.changed, ...events.added].filter((f) => isScriptFile(f) || isDataFile(f));
    if (toRead.length > 1) {
        for (const [i, f] of toRead.entries()) {
            progress.step("reading", i, toRead.length);
            await read(f);
        }
        progress.step("reading", toRead.length, toRead.length);
    }
    let touched = false;
    const announce = (file?: string) => {
        touched = true;
        signal("receiving");
        broadcastToUi({ type: "scriptsChanged", source: "folder", file } as any);
    };

    // renames: a vanished file whose last-synced content reappears under a
    // new name (several per poll are fine; content edits + rename are not
    // a rename — they become delete + create)
    const newFiles = [...added];
    const gone = new Set(removed);
    for (const old of removed) {
        const s = ownerOf(old, scripts);
        if (!s) continue;
        const base = owned.get(s.id)?.hash ?? contentHash(s.code);
        for (const f of newFiles) {
            const t = await read(f);
            if (t === null || contentHash(t) !== base || ownerOf(f, scripts)) continue;
            newFiles.splice(newFiles.indexOf(f), 1);
            gone.delete(old);
            const name = displayNameFromFile(f);
            const clash = caseClash(canonicalFileName(name), scripts, s.id);
            if (clash) {
                dlogLevel("sync", "warn", `Folder sync: "${old}" was renamed to "${f}", but script "${clash.meta.name}" already uses that name (letter case is ignored on macOS/Windows) — renaming its script skipped`);
                owned.set(s.id, { file: f, hash: base });
                break;
            }
            owned.set(s.id, { file: canonicalFileName(name), hash: contentHash(t) });
            await saveFromDisk({ id: s.id, code: t, name });
            await adoptCanonicalName(f, name, t);
            dlogLevel("sync", "info", `Folder sync: "${old}" renamed to "${f}" — script renamed to "${name}"`);
            announce(f);
            break;
        }
    }
    if (touched) scripts = await scriptsNow();

    for (const file of changed) {
        const s = ownerOf(file, scripts);
        const text = s ? await read(file) : null;
        if (s && text !== null && (await pullChange(file, text, s))) announce(file);
    }

    for (const file of newFiles) {
        const text = await read(file);
        if (text === null) continue;
        const s = ownerOf(file, scripts);
        if (s) {
            // a file for an existing script appeared (re-created, or copied over it)
            if (await pullChange(file, text, s)) announce(file);
            continue;
        }
        const name = displayNameFromFile(file);
        const clash = caseClash(canonicalFileName(name), scripts);
        if (clash) {
            dlogLevel("sync", "warn", `Folder sync: "${file}" not imported — script "${clash.meta.name}" already uses that name (letter case is ignored on macOS/Windows)`);
            continue;
        }
        const id = newId();
        owned.set(id, { file: canonicalFileName(name), hash: contentHash(text) });
        await saveFromDisk({ id, code: text, name });
        await adoptCanonicalName(file, name, text);
        scripts = await scriptsNow();
        dlogLevel("sync", "info", `Folder sync: new file "${file}" imported as script "${name}"`);
        announce(file);
    }

    for (const file of gone) {
        const s = ownerOf(file, scripts);
        if (!s) continue;
        const rec = owned.get(s.id);
        if (rec && rec.hash !== contentHash(s.code)) {
            // the script changed in the extension since the last sync: its
            // edits would be lost — write the file back instead of deleting
            await writingAs("sending", () => writeFile(file, s.code));
            owned.set(s.id, { file, hash: contentHash(s.code) });
            dlogLevel("sync", "warn", `Folder sync: "${file}" was deleted on disk, but script "${s.meta.name}" has newer changes in the extension — the file was written back`);
            continue;
        }
        owned.delete(s.id);
        staged?.delete(s.id);
        await deleteScript(s.id);
        dlogLevel("sync", "info", `Folder sync: "${file}" deleted on disk — script "${s.meta.name}" removed`);
        announce(file);
    }

    if (await applyDataFileEvents(events, read)) announce();

    // folders: new ones appear in the explorer (even empty); a vanished one
    // goes once nothing in it is left (contents with newer extension-side
    // changes were written back, which re-created it)
    for (const key of events.added.filter((k) => k.endsWith("/"))) {
        const path = key.slice(0, -1);
        if ((await listFolders()).includes(path)) continue;
        try {
            await createFolder(path);
            dlogLevel("sync", "info", `Folder sync: new folder "${path}" on disk — added`);
            announce(key);
        } catch (e: any) {
            dlogLevel("sync", "warn", `Folder sync: folder "${path}" not added — ${e?.message || e}`);
        }
    }
    const goneFolders = events.removed.filter((k) => k.endsWith("/")).map((k) => k.slice(0, -1));
    for (const path of goneFolders.sort((a, b) => b.length - a.length)) {
        if (known.has(path + "/") || !(await listFolders()).includes(path)) continue;
        const inside = (p: string) => isInFolder(p, path);
        if ((await scriptsNow()).some((x) => inside(x.meta.name)) || (await listDataFiles()).some((d) => inside(d.path))) continue;
        await deleteFolder(path);
        dlogLevel("sync", "info", `Folder sync: folder "${path}" deleted on disk — removed`);
        announce(path + "/");
    }
    return touched;
}

/** the data file owning a file: by the recorded ownership, else by path */
function dataOwnerOf(file: string, files: DataFile[]): DataFile | undefined {
    for (const [id, rec] of ownedData) {
        if (rec.file !== file) continue;
        const d = files.find((x) => x.id === id);
        if (d) return d;
    }
    return files.find((d) => d.path.toLowerCase() === file.toLowerCase());
}

/** save a data file read from disk; false (and a warning) when the store refuses it (clash, too big) */
async function storeDataFile(partial: { id: string; path?: string; text?: string }, file: string, text: string): Promise<boolean> {
    const prev = ownedData.get(partial.id);
    ownedData.set(partial.id, { file, hash: contentHash(text) });
    try {
        await saveDataFile(partial);
        return true;
    } catch (e: any) {
        if (prev) ownedData.set(partial.id, prev);
        else ownedData.delete(partial.id);
        dlogLevel("sync", "warn", `Folder sync: "${file}" not applied — ${e?.message || e}`);
        return false;
    }
}

/** a file's new text arrives for data file `d` (like pullChange) */
async function pullDataChange(file: string, text: string, d: DataFile): Promise<boolean> {
    const h = contentHash(text);
    const rec = ownedData.get(d.id);
    const storeHash = contentHash(d.text);
    if (h === storeHash) {
        ownedData.set(d.id, { file, hash: h });
        return false;
    }
    if (rec && rec.file === file && rec.hash === h) {
        scheduleReconcile();
        return false;
    }
    if (rec && rec.file === file && isStaleEcho(file, h)) {
        rewrite.add(d.id);
        scheduleReconcile();
        return false;
    }
    if (rec && rec.hash !== storeHash) {
        await backup(file, d.text, `"${file}" changed on disk while data file "${d.path}" also changed in the extension; the file wins`);
    }
    if (!(await storeDataFile({ id: d.id, text }, file, text))) return false;
    dlogLevel("sync", "info", `Folder sync: "${file}" changed on disk — data file "${d.path}" updated`);
    return true;
}

/** the data-file part of applyFolderEvents (same rules as for scripts); true when one changed */
async function applyDataFileEvents(events: ReturnType<typeof computeEvents>, read: (f: string) => Promise<string | null>): Promise<boolean> {
    const changed = events.changed.filter(isDataFile);
    const added = events.added.filter(isDataFile);
    const removed = events.removed.filter(isDataFile);
    if (!changed.length && !added.length && !removed.length) return false;
    let files = await listDataFiles();
    let touched = false;
    const newFiles = [...added];
    const gone = new Set(removed);
    for (const old of removed) {
        const d = dataOwnerOf(old, files);
        if (!d) continue;
        const base = ownedData.get(d.id)?.hash ?? contentHash(d.text);
        for (const f of newFiles) {
            const t = await read(f);
            if (t === null || contentHash(t) !== base || dataOwnerOf(f, files)) continue;
            newFiles.splice(newFiles.indexOf(f), 1);
            gone.delete(old);
            if (await storeDataFile({ id: d.id, path: f, text: t }, f, t)) {
                dlogLevel("sync", "info", `Folder sync: "${old}" renamed to "${f}" — data file moved`);
                touched = true;
            }
            break;
        }
    }
    if (touched) files = await listDataFiles();
    for (const file of changed) {
        const d = dataOwnerOf(file, files);
        const text = d ? await read(file) : null;
        if (d && text !== null && (await pullDataChange(file, text, d))) touched = true;
    }
    for (const file of newFiles) {
        const text = await read(file);
        if (text === null) continue;
        const d = dataOwnerOf(file, files);
        if (d) {
            if (await pullDataChange(file, text, d)) touched = true;
            continue;
        }
        if (!(await storeDataFile({ id: newDataFileId(), path: file, text }, file, text))) continue;
        files = await listDataFiles();
        dlogLevel("sync", "info", `Folder sync: new file "${file}" imported as a data file`);
        touched = true;
    }
    for (const file of gone) {
        const d = dataOwnerOf(file, files);
        if (!d) continue;
        const rec = ownedData.get(d.id);
        if (rec && rec.hash !== contentHash(d.text)) {
            await writingAs("sending", () => writeFile(file, d.text));
            ownedData.set(d.id, { file, hash: contentHash(d.text) });
            dlogLevel("sync", "warn", `Folder sync: "${file}" was deleted on disk, but data file "${d.path}" has newer changes in the extension — the file was written back`);
            continue;
        }
        ownedData.delete(d.id);
        await deleteDataFile(d.id);
        dlogLevel("sync", "info", `Folder sync: "${file}" deleted on disk — data file removed`);
        touched = true;
    }
    return touched;
}

/**
 * A file whose name doesn't round-trip through the script name (e.g.
 * "a:b.ts" → script "a:b" → "a_b.ts") would never match its script again,
 * so later edits/deletes of it would be ignored. Rename it on disk to the
 * canonical name the manager also uses.
 */
async function adoptCanonicalName(fileName: string, scriptName: string, code: string): Promise<void> {
    const canonical = canonicalFileName(scriptName);
    if (canonical === fileName) return;
    if (!(await writeFile(canonical, code))) return;
    try {
        await (await parentDir(fileName)).removeEntry(baseName(fileName));
    } catch {}
    known.delete(fileName);
    dlogLevel("sync", "info", `Folder sync: renamed "${fileName}" → "${canonical}" to match its script name`);
}

// ---- storage → disk ----

/** delete a file we no longer own — unless it was edited since we last synced it */
async function removeIfUnchanged(rec: Owned, why: string): Promise<void> {
    const cur = await readTextOrNull(rec.file);
    if (cur === null) {
        known.delete(rec.file);
        return;
    }
    if (contentHash(cur) !== rec.hash) {
        dlogLevel("sync", "warn", `Folder sync: "${rec.file}" was left on disk (${why}) — it has edits that never reached the extension`);
        return;
    }
    await removeFile(rec.file);
}

let clashWarned = new Set<string>();

/**
 * Make the folder match storage: write changed scripts, follow renames,
 * delete files of deleted scripts. A file edited on disk since the last
 * poll is left for the poller (which applies it first; the store change
 * then comes back here).
 */
async function reconcileToDisk(): Promise<void> {
    if (!dirHandle) return;
    const scripts = await listScripts();
    const ids = new Set(scripts.map((s) => s.id));
    let wrote = false;
    for (const [id, rec] of [...owned]) {
        if (ids.has(id)) continue;
        owned.delete(id);
        await removeIfUnchanged(rec, "its script was deleted");
        wrote = true;
    }
    const claimed = new Map<string, Script>();
    for (const s of scripts) {
        const file = canonicalFileName(s.meta.name);
        const key = file.toLowerCase();
        const other = claimed.get(key);
        if (other) {
            if (!clashWarned.has(key)) dlogLevel("sync", "warn", `Folder sync: scripts "${other.meta.name}" and "${s.meta.name}" would share one file on macOS/Windows — "${s.meta.name}" is not written to the folder; rename one of them`);
            clashWarned.add(key);
            continue;
        }
        claimed.set(key, s);
        if (await writeOut(owned, s.id, file, s.code, "script", s.meta.name)) wrote = true;
    }
    const dataFiles = await listDataFiles();
    const dataIds = new Set(dataFiles.map((d) => d.id));
    for (const [id, rec] of [...ownedData]) {
        if (dataIds.has(id)) continue;
        ownedData.delete(id);
        await removeIfUnchanged(rec, "its data file was deleted");
        wrote = true;
    }
    for (const d of dataFiles) if (await writeOut(ownedData, d.id, d.path, d.text, "data file", d.path)) wrote = true;
    if (await reconcileFoldersToDisk()) wrote = true;
    if (wrote) await persistState();
}

/** write one script's (data file's) text to its file, following a rename; true when the folder changed */
async function writeOut(ownedMap: Map<string, Owned>, id: string, file: string, text: string, kind: string, name: string): Promise<boolean> {
    const h = contentHash(text);
    const rec = ownedMap.get(id);
    if (rec && rec.file !== file) {
        // renamed in the extension: move the file. A case-only rename
        // is the SAME file on macOS/Windows — remove first, or the
        // delete would take the freshly written file with it
        const caseOnly = rec.file.toLowerCase() === file.toLowerCase();
        const old = rec;
        if (caseOnly) await removeFile(old.file);
        if (!(await writeFile(file, text))) return false;
        if (!caseOnly) await removeIfUnchanged(old, `${kind} renamed to "${name}"`);
        ownedMap.set(id, { file, hash: h });
        dlogLevel("sync", "info", `Folder sync: "${old.file}" → "${file}" (${kind} renamed)`);
        return true;
    }
    if (rec && rec.hash === h && !rewrite.has(id)) return false; // in sync
    const sig = await statFile(file);
    const seen = known.get(file);
    if (sig && (!seen || seen.lastModified !== sig.lastModified || seen.size !== sig.size)) return false; // unseen external edit: poll first
    const cur = sig ? await readTextOrNull(file) : null;
    if (cur !== null && contentHash(cur) === h) {
        ownedMap.set(id, { file, hash: h });
        rewrite.delete(id);
        return false;
    }
    if (cur !== null && !rec) await backup(file, cur, `"${file}" was replaced by ${kind} "${name}"`);
    if (!(await writeFile(file, text))) return false;
    ownedMap.set(id, { file, hash: h });
    rewrite.delete(id);
    return true;
}

/**
 * Folders follow the explorer: missing ones are created (empty ones too),
 * ones deleted or moved away in the extension are removed — only when
 * empty, so files that aren't TangiTweak's stay. true when `known` changed.
 */
async function reconcileFoldersToDisk(): Promise<boolean> {
    const folders = await listFolders();
    let changed = false;
    for (const f of folders) {
        if (known.has(f + "/")) continue;
        if (!(await folderExists(f))) {
            try {
                await parentDir(f + "/x", true);
                signal(writeKind);
            } catch (e: any) {
                dlogLevel("sync", "warn", `Folder sync: creating folder "${f}" failed: ${e?.message || e}`);
                continue;
            }
        }
        for (const a of [...ancestorFolders(f), f]) known.set(a + "/", FOLDER_SIG);
        changed = true;
    }
    const want = new Set(folders.map((f) => f.toLowerCase()));
    const stale = [...known.keys()].filter((k) => k.endsWith("/") && !want.has(k.slice(0, -1).toLowerCase()));
    for (const key of stale.sort((a, b) => b.length - a.length)) {
        const path = key.slice(0, -1);
        try {
            await (await parentDir(path)).removeEntry(baseName(path));
            signal(writeKind);
        } catch (e: any) {
            // not empty (files TangiTweak doesn't sync, or edits it left on disk)
            if (e?.name !== "NotFoundError") continue;
        }
        known.delete(key);
        changed = true;
    }
    return changed;
}

export interface FolderPreview {
    /** files that become new scripts */
    imported: string[];
    /** scripts written out as new files */
    written: string[];
    /** both exist and differ: the newer side wins, the other is backed up */
    conflicts: { name: string; winner: "file" | "script" }[];
}

/**
 * Two-way reconcile when a folder is picked or (re)connected. Files with no
 * script are imported, scripts with no file are written out. When both
 * exist but differ: with a merge base (resume) the side that changed wins;
 * otherwise — or when both changed — the newer one wins and the other copy
 * is kept in the backup folder. `dry`: only report what would happen.
 */
async function initialSync(opts: { dry?: boolean; handle?: any; base?: Map<string, Owned> } = {}): Promise<FolderPreview> {
    const progress = progressReporter("sync");
    try {
        if (opts.dry) return await reconcile(opts, progress);
        const out = await syncPass(progress, () => reconcile(opts, progress));
        known = new Map([...known].filter(([k]) => !k.endsWith("/")));
        await reconcileFoldersToDisk();
        const live = new Set((await listScripts()).map((s) => s.id));
        for (const id of [...owned.keys()]) if (!live.has(id)) owned.delete(id);
        const liveData = new Set((await listDataFiles()).map((d) => d.id));
        for (const id of [...ownedData.keys()]) if (!liveData.has(id)) ownedData.delete(id);
        dlogLevel("sync", "info", `Folder sync: reconciled — ${out.imported.length} file(s) imported, ${out.written.length} file(s) written from scripts, ${out.conflicts.length} conflict(s)`);
        if (out.imported.length || out.conflicts.some((c) => c.winner === "file")) broadcastToUi({ type: "scriptsChanged", source: "folder" } as any);
        return out;
    } finally {
        progress.end();
    }
}

/**
 * initialSync's reconcile, in steps: list everything in the folder, read
 * every file, then apply them (data files and folders first; the scripts
 * are staged and compile together when the pass ends).
 */
async function reconcile(opts: { dry?: boolean; handle?: any; base?: Map<string, Owned> }, progress: ProgressReporter): Promise<FolderPreview> {
    const dry = !!opts.dry;
    const handle = opts.handle ?? dirHandle;
    const all = await scanFolder(handle, "", undefined, progress);
    const files = [...all.keys()].filter((f) => isScriptFile(f) || isDataFile(f));
    const texts = new Map<string, string>();
    for (const [i, f] of files.entries()) {
        progress.step("reading", i, files.length);
        texts.set(f, await readDiskContent(f, handle));
    }
    progress.step("reading", files.length, files.length);
    const seen = new Map([...all].filter(([f]) => isScriptFile(f)));
    const scripts = await listScripts();
    const byFile = new Map(scripts.map((s) => [canonicalFileName(s.meta.name), s]));
    const out: FolderPreview = { imported: [], written: [], conflicts: [] };
    const readFrom = async (name: string) => texts.get(name) ?? readDiskContent(name, handle);
    /** files of scripts renamed while the folder wasn't watched (unchanged on disk since): script id → old file */
    const movedFrom = new Map<string, string>();
    for (const [fileName, sig] of seen) {
        const text = await readFrom(fileName);
        const s = byFile.get(fileName);
        byFile.delete(fileName);
        if (!s) {
            const hd = contentHash(text);
            const renamed = [...(opts.base ?? owned)].find(([id, r]) => r.file === fileName && r.hash === hd && scripts.some((x) => x.id === id && canonicalFileName(x.meta.name) !== fileName));
            if (renamed) {
                movedFrom.set(renamed[0], fileName);
                continue;
            }
            const name = displayNameFromFile(fileName);
            const clash = caseClash(canonicalFileName(name), scripts);
            if (clash) {
                if (!dry) dlogLevel("sync", "warn", `Folder sync: "${fileName}" not imported — script "${clash.meta.name}" already uses that name (letter case is ignored on macOS/Windows)`);
                continue;
            }
            out.imported.push(fileName);
            if (dry) continue;
            const id = newId();
            owned.set(id, { file: canonicalFileName(name), hash: contentHash(text) });
            await saveFromDisk({ id, code: text, name });
            await adoptCanonicalName(fileName, name, text);
            continue;
        }
        const hd = contentHash(text);
        const hs = contentHash(s.code);
        if (hd === hs) {
            if (!dry) owned.set(s.id, { file: fileName, hash: hd });
            continue;
        }
        const rec = (opts.base ?? owned).get(s.id);
        const base = rec && rec.file === fileName ? rec.hash : null;
        let pull: boolean;
        let conflict = false;
        if (base === hs) pull = true; // only the file changed
        else if (base === hd) pull = false; // only the script changed
        else {
            pull = sig.lastModified > s.updatedAt;
            conflict = true;
            out.conflicts.push({ name: s.meta.name, winner: pull ? "file" : "script" });
        }
        if (dry) continue;
        if (pull) {
            if (conflict) await backup(fileName, s.code, `script "${s.meta.name}" and "${fileName}" both changed; the newer file wins`);
            owned.set(s.id, { file: fileName, hash: hd });
            await saveFromDisk({ id: s.id, code: text, name: s.meta.name });
        } else {
            if (conflict) await backup(fileName, text, `script "${s.meta.name}" and "${fileName}" both changed; the newer script wins`);
            await writeFile(fileName, s.code);
            owned.set(s.id, { file: fileName, hash: hs });
        }
    }
    for (const [fileName, s] of byFile) {
        if (caseClash(fileName, scripts, s.id) && [...seen.keys()].some((f) => f.toLowerCase() === fileName.toLowerCase())) continue;
        out.written.push(fileName);
        if (dry) continue;
        if (!(await writeFile(fileName, s.code))) continue;
        owned.set(s.id, { file: fileName, hash: contentHash(s.code) });
        const old = movedFrom.get(s.id);
        if (old && old.toLowerCase() !== fileName.toLowerCase()) {
            await removeFile(old);
            known.delete(old);
            dlogLevel("sync", "info", `Folder sync: "${old}" → "${fileName}" (script renamed while the folder wasn't watched)`);
        }
    }
    await initialSyncData(all, readFrom, out, dry, opts.base ? new Map() : ownedData);
    if (dry) return out;
    // folders: both sides get every folder (empty ones too)
    const folders = await listFolders();
    for (const key of all.keys()) {
        const path = key.slice(0, -1);
        if (!key.endsWith("/") || folders.some((f) => f.toLowerCase() === path.toLowerCase())) continue;
        try {
            await createFolder(path);
        } catch (e: any) {
            dlogLevel("sync", "warn", `Folder sync: folder "${path}" not added — ${e?.message || e}`);
        }
    }
    return out;
}

/** the data-file part of initialSync (same rules as for scripts) */
async function initialSyncData(all: Map<string, FileSig>, readFrom: (f: string) => Promise<string>, out: FolderPreview, dry: boolean, base: Map<string, Owned>): Promise<void> {
    const files = await listDataFiles();
    const byFile = new Map(files.map((d) => [d.path.toLowerCase(), d]));
    for (const [fileName, sig] of all) {
        if (!isDataFile(fileName)) continue;
        const text = await readFrom(fileName);
        const d = byFile.get(fileName.toLowerCase());
        byFile.delete(fileName.toLowerCase());
        if (!d) {
            out.imported.push(fileName);
            if (!dry) await storeDataFile({ id: newDataFileId(), path: fileName, text }, fileName, text);
            continue;
        }
        const hd = contentHash(text);
        const hs = contentHash(d.text);
        if (hd === hs) {
            if (!dry) ownedData.set(d.id, { file: fileName, hash: hd });
            continue;
        }
        const rec = base.get(d.id);
        const merge = rec && rec.file === fileName ? rec.hash : null;
        let pull: boolean;
        let conflict = false;
        if (merge === hs) pull = true;
        else if (merge === hd) pull = false;
        else {
            pull = sig.lastModified > d.savedAt;
            conflict = true;
            out.conflicts.push({ name: d.path, winner: pull ? "file" : "script" });
        }
        if (dry) continue;
        if (pull) {
            if (conflict) await backup(fileName, d.text, `data file "${d.path}" and "${fileName}" both changed; the newer file wins`);
            await storeDataFile({ id: d.id, text }, fileName, text);
        } else {
            if (conflict) await backup(fileName, text, `data file "${d.path}" and "${fileName}" both changed; the newer data file wins`);
            await writeFile(d.path, d.text);
            ownedData.set(d.id, { file: d.path, hash: hs });
        }
    }
    for (const d of byFile.values()) {
        out.written.push(d.path);
        if (dry) continue;
        await writeFile(d.path, d.text);
        ownedData.set(d.id, { file: d.path, hash: contentHash(d.text) });
    }
}

/** What picking the saved folder would do (the manager confirms conflicts first). */
export async function previewStoredHandle(): Promise<FolderPreview | null> {
    const handle = await loadSavedHandle("pendingFolder");
    if (!handle) return null;
    // a newly picked folder has no merge base
    return serial(() => initialSync({ dry: true, handle, base: new Map() }));
}

// ---- settings.json: canonical text generated from storage ----

let settingsSig: FileSig | null = null;
let settingsBroken = false;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

async function readSettingsFile(): Promise<{ text: string; sig: FileSig } | null> {
    try {
        const f = await (await dirHandle.getFileHandle(SETTINGS_FILE)).getFile();
        return { text: await f.text(), sig: { lastModified: f.lastModified, size: f.size } };
    } catch {
        return null;
    }
}

// ---- tweak data folders: rendered from storage, mirrored both ways ----

/** data folder files as we last wrote or read them */
let dataSigs = new Map<string, FileSig>();
/** data folder files on disk that are invalid: not applied, and not overwritten until fixed */
let dataBroken = new Set<string>();
let dataTimer: ReturnType<typeof setTimeout> | null = null;
let applyingDiskData = false;

const sameSig = (a: FileSig | null | undefined, b: FileSig | null | undefined): boolean => !!a && !!b && a.lastModified === b.lastModified && a.size === b.size;

/** the settings.json and stores/*.json files in each bundle's data folder on disk */
async function scanDataFolders(roots: readonly string[]): Promise<Map<string, FileSig>> {
    const out = new Map<string, FileSig>();
    for (const root of roots) {
        let dir: any;
        try {
            dir = await parentDir(`${root}${dataFolder}/x`);
        } catch {
            continue;
        }
        const add = async (path: string, fh: any) => {
            try {
                const f = await fh.getFile();
                out.set(path, { lastModified: f.lastModified, size: f.size });
            } catch {}
        };
        try {
            await add(`${root}${dataFolder}/${TWEAK_SETTINGS_FILE}`, await dir.getFileHandle(TWEAK_SETTINGS_FILE));
        } catch {}
        try {
            for await (const e of (await dir.getDirectoryHandle(STORES_DIR)).values())
                if (e.kind === "file" && e.name.endsWith(".json")) await add(`${root}${dataFolder}/${STORES_DIR}/${e.name}`, e);
        } catch {}
    }
    return out;
}

/** apply a data folder file read from disk (null: deleted there) */
async function applyDiskData(path: string, text: string | null): Promise<boolean> {
    applyingDiskData = true;
    let error: string | undefined;
    try {
        ({ error } = await applyTweakDataFile(path, text));
    } finally {
        applyingDiskData = false;
    }
    if (error) {
        if (!dataBroken.has(path)) dlogLevel("sync", "warn", `Folder sync: ${path} has an error and was not applied: ${error}`);
        dataBroken.add(path);
        return false;
    }
    dataBroken.delete(path);
    signal("receiving");
    dlogLevel("sync", "info", text === null ? `Folder sync: ${path} was deleted — back to its defaults` : `Folder sync: ${path} changed on disk — applied`);
    return true;
}

/** data folder files on disk → storage: new and edited files apply, a deleted one resets what it held */
async function pollTweakData(): Promise<void> {
    if (!dirHandle) return;
    const roots = (await tweakTargets()).map((t) => t.root);
    const inTweak = (p: string) => roots.some((r) => p.startsWith(`${r}${dataFolder}/`));
    const seen = await scanDataFolders(roots);
    let applied = false;
    for (const [path, sig] of seen) {
        if (sameSig(dataSigs.get(path), sig)) continue;
        dataSigs.set(path, sig);
        const text = await readTextOrNull(path);
        if (text !== null && (await applyDiskData(path, text))) applied = true;
    }
    for (const path of [...dataSigs.keys()]) {
        if (seen.has(path)) continue;
        dataSigs.delete(path);
        dataBroken.delete(path);
        // its tweak is gone or moved: nothing to reset
        if (inTweak(path) && (await applyDiskData(path, null))) applied = true;
    }
    if (applied) await writingAs("receiving", () => exportTweakDataNow());
}

/**
 * storage → each tweak's data folder. A file edited on disk since we last
 * saw it is left for the poll; an invalid one isn't overwritten until it's
 * fixed (or `force`: saved in the Editor). Files of stores no longer saved
 * (or of tweaks gone) are removed.
 */
/** the same JSON, whatever the key order: another browser syncing the folder may hold the keys in another order */
function sameData(disk: string | null, text: string): boolean {
    if (disk === text) return true;
    if (disk === null) return false;
    try {
        return jsonEqual(JSON.parse(disk), JSON.parse(text));
    } catch {
        return false;
    }
}

async function exportTweakDataNow(force = false): Promise<void> {
    if (!dirHandle) return;
    try {
        const want = new Map((await tweakDataFiles()).map((f) => [f.path, f.text]));
        for (const [path, text] of want) {
            const sig = await statFile(path);
            const tracked = dataSigs.get(path);
            if (!force && ((sig && !sameSig(sig, tracked)) || dataBroken.has(path))) continue;
            if (!sig || !sameData(await readTextOrNull(path), text)) {
                if (!(await writeFile(path, text, false))) continue;
            }
            dataBroken.delete(path);
            const now = await statFile(path);
            if (now) dataSigs.set(path, now);
        }
        const dirs = new Set<string>();
        for (const [path, tracked] of [...dataSigs]) {
            if (want.has(path)) continue;
            if (sameSig(await statFile(path), tracked)) await removeFile(path);
            dataSigs.delete(path);
            dataBroken.delete(path);
            dirs.add(path.slice(0, path.lastIndexOf("/")));
        }
        // emptied stores/ and data folders go (removeEntry refuses one that isn't empty)
        for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
            for (const dir of d.endsWith(`/${STORES_DIR}`) ? [d, d.slice(0, -STORES_DIR.length - 1)] : [d]) {
                try {
                    await (await parentDir(dir)).removeEntry(baseName(dir));
                } catch {}
            }
        }
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync: writing the tweaks' ${dataFolder} folders failed: ${e?.message || e}`);
    }
}

/** a data folder file was saved in the Editor: write the data folders now */
export function exportTweakData(): Promise<void> {
    return serial(() => exportTweakDataNow(true));
}

function scheduleDataExport(): void {
    if (!dirHandle || applyingDiskData) return;
    if (dataTimer) clearTimeout(dataTimer);
    dataTimer = setTimeout(() => {
        dataTimer = null;
        void serial(() => exportTweakDataNow());
    }, 500);
}

/** the "Tweak data folder" setting changed: move every tweak's data folder on disk */
async function renameDataFolders(to: string): Promise<void> {
    const from = dataFolder;
    if (!dirHandle || from === to) {
        dataFolder = to;
        return;
    }
    const copy = async (src: any, dst: any) => {
        for await (const e of src.values()) {
            if (e.kind === "directory") await copy(e, await dst.getDirectoryHandle(e.name, { create: true }));
            else {
                const w = await (await dst.getFileHandle(e.name, { create: true })).createWritable();
                await w.write(await (await e.getFile()).arrayBuffer());
                await w.close();
            }
        }
    };
    for (const { root } of await tweakTargets()) {
        let src: any;
        try {
            src = await parentDir(`${root}${from}/x`);
        } catch {
            continue;
        }
        if (await folderExists(`${root}${to}`)) {
            dlogLevel("sync", "warn", `Folder sync: ${root}${to} already exists — ${root}${from} stays where it is (move its files yourself)`);
            continue;
        }
        try {
            await copy(src, await parentDir(`${root}${to}/x`, true));
            await (await parentDir(`${root}${from}`)).removeEntry(from, { recursive: true });
            signal(writeKind);
        } catch (e: any) {
            dlogLevel("sync", "warn", `Folder sync: moving ${root}${from} to ${root}${to} failed: ${e?.message || e}`);
        }
    }
    dataFolder = to;
    dataSigs = new Map();
    dataBroken = new Set();
    await pollTweakData();
    await exportTweakDataNow();
}

/**
 * storage → settings.json. An up-to-date file is never rewritten; a broken
 * file on disk is left untouched until the user fixes its JSON syntax.
 */
async function exportSettings(force = false): Promise<void> {
    if (!dirHandle) return;
    try {
        const existing = await readSettingsFile();
        if (!force && existing && !settingsTextParses(existing.text)) {
            if (!settingsBroken) dlogLevel("sync", "warn", `Folder sync: ${SETTINGS_FILE} on disk has a JSON error — it is not overwritten until it is fixed (changes made meanwhile are written then)`);
            settingsBroken = true;
            return;
        }
        settingsBroken = false;
        const text = await getSettingsText();
        if (existing?.text !== text) {
            await writeFile(SETTINGS_FILE, text);
            settingsSig = (await readSettingsFile())?.sig ?? null;
        }
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync: writing ${SETTINGS_FILE} failed: ${e?.message || e}`);
    }
}

/** write a TangiTweak-owned file unless it already has exactly this content */
async function ensureFile(fileName: string, content: string): Promise<void> {
    if (!dirHandle) return;
    try {
        const f = await (await dirHandle.getFileHandle(fileName)).getFile();
        if ((await f.text()) === content) return;
    } catch {
        // missing → write below
    }
    await writeFile(fileName, content);
}

/** a file TangiTweak no longer writes (settings.schema.json, tt-api.d.ts): the one it wrote goes, a user's own stays */
async function removeOldGeneratedFile(fileName: string): Promise<void> {
    const text = await readTextOrNull(fileName);
    if (text?.includes(GENERATED_NOTE)) await removeFile(fileName);
}

async function ensurePackageJsonFile(): Promise<void> {
    if (!dirHandle) return;
    const raw = await readTextOrNull(PACKAGE_JSON_FILE);
    let existing: Record<string, any> | undefined;
    if (raw && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                dlogLevel("sync", "warn", `Folder sync: ${PACKAGE_JSON_FILE} on disk is not a JSON object — leaving it untouched`);
                return;
            }
            existing = parsed;
        } catch {
            dlogLevel("sync", "warn", `Folder sync: ${PACKAGE_JSON_FILE} on disk has a JSON error — leaving it untouched until fixed`);
            return;
        }
    }
    const next = packageJsonText(existing);
    if (raw !== next) await writeFile(PACKAGE_JSON_FILE, next);
}

/** the SDK this build ships (lib/tangitweak-sdk.json), read once */
let sdkBundle: Promise<Record<string, string>> | null = null;
function sdkBundleFiles(): Promise<Record<string, string>> {
    if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return Promise.resolve({});
    sdkBundle ??= Promise.resolve()
        .then(() => fetch(chrome.runtime.getURL("lib/tangitweak-sdk.json")))
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .catch((e: any) => {
            sdkBundle = null;
            dlogLevel("sync", "warn", `Folder sync: could not read the SDK's files: ${e?.message || e}`);
            return {};
        });
    return sdkBundle;
}

/**
 * The SDK under SDK_ROOT, the same files as the npm package `tangitweak`
 * (its typings of the built-ins come from lib/builtin-types.json). The
 * `@tangitweak/test` harness that came before it goes.
 */
async function ensureSdkFiles(): Promise<void> {
    if (!dirHandle) return;
    const files = Object.entries(await sdkBundleFiles());
    if (!files.length) return;
    for (const [p, text] of Object.entries(await builtinTypingFiles())) files.push([`${SDK_BUILTIN_TYPINGS}/${p}`, text]);
    for (const [p, text] of files) {
        const path = `${SDK_ROOT}/${p}`;
        if ((await readTextOrNull(path)) !== text) await writeFile(path, text);
    }
    try {
        await (await parentDir(OLD_TEST_PKG_ROOT)).removeEntry(baseName(OLD_TEST_PKG_ROOT), { recursive: true });
    } catch {
        // not there
    }
}

/**
 * tsconfig + the SDK (with the API typings) for VS Code, refreshed on every
 * start — so an extension update (new APIs) reaches an already-synced folder.
 */
async function ensureSupportFiles(): Promise<void> {
    await ensureFile(TSCONFIG_FILE, tsconfigText());
    await ensurePackageJsonFile();
    await ensureFile(ESLINT_CONFIG_FILE, eslintConfigText());
    await ensureEslintPlugin();
    await removeOldGeneratedFile(SCHEMA_FILE);
    await removeOldGeneratedFile(API_DTS_FILE);
    await ensureSdkFiles();
    await ensurePackageTypingsFiles();
}

/** scriptLint's rules as an ESLint plugin, for external editors (in .tangitweak/, so ensureFile's top-level read doesn't reach it) */
async function ensureEslintPlugin(): Promise<void> {
    try {
        const text = eslintPluginText();
        if ((await readTextOrNull(ESLINT_PLUGIN_FILE)) !== text) await writeFile(ESLINT_PLUGIN_FILE, text);
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync: could not write ${ESLINT_PLUGIN_FILE}: ${e?.message || e}`);
    }
}

/** what ensurePackageTypingsFiles last wrote or found in this folder (path → text) */
let typingsOnDisk: { dir: any; files: Map<string, string> } = { dir: null, files: new Map() };

/** the built-in modules' typings (lib/builtin-types.json), read once */
let builtinTypings: Promise<Record<string, string>> | null = null;
function builtinTypingFiles(): Promise<Record<string, string>> {
    builtinTypings ??= Promise.resolve()
        .then(() => fetch(chrome.runtime.getURL("lib/builtin-types.json")))
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .catch((e: any) => {
            builtinTypings = null;
            dlogLevel("sync", "warn", `Folder sync: could not read the built-in modules' typings: ${e?.message || e}`);
            return {};
        });
    return builtinTypings;
}

/**
 * The package imports' typings under .tangitweak/types/ (the tsconfig maps
 * package URLs there), as stored, and the built-ins' (valtio, React) under
 * .tangitweak/types/builtin/; package typings no script needs any more go.
 * Dot folders aren't scanned, so these never come back as scripts or data.
 */
async function ensurePackageTypingsFiles(): Promise<void> {
    const area = storageLocal();
    if (!dirHandle || !area) return;
    if (typingsOnDisk.dir !== dirHandle) typingsOnDisk = { dir: dirHandle, files: new Map() };
    const seen = typingsOnDisk.files;
    const stored: StoredTypings | undefined = (await new Promise<any>((r) => area.get(PACKAGE_TYPINGS_KEY, r)))?.[PACKAGE_TYPINGS_KEY];
    const want = new Map(Object.entries(stored?.files ?? {}).map(([p, text]) => [`${TYPINGS_ROOT}/${p}`, text]));
    for (const [p, text] of Object.entries(await builtinTypingFiles())) want.set(`${BUILTIN_TYPINGS_ROOT}/${p}`, text);
    try {
        for (const [path, text] of want) {
            if (seen.get(path) === text) continue;
            if ((await readTextOrNull(path)) === text || (await writeFile(path, text))) seen.set(path, text);
        }
        let root: any;
        try {
            root = await parentDir(`${TYPINGS_ROOT}/x`);
        } catch {
            return;
        }
        const prune = async (dir: any, prefix: string): Promise<boolean> => {
            const entries: any[] = [];
            for await (const e of dir.values()) entries.push(e);
            let kept = false;
            for (const e of entries) {
                const path = prefix + e.name;
                if (e.kind === "directory" ? await prune(await dir.getDirectoryHandle(e.name), path + "/") : want.has(path)) kept = true;
                else {
                    await dir.removeEntry(e.name, e.kind === "directory" ? { recursive: true } : undefined);
                    seen.delete(path);
                    signal(writeKind);
                }
            }
            return kept;
        };
        if (await prune(root, `${TYPINGS_ROOT}/`)) return;
        // no typings left: drop the folder, and .tangitweak too when that empties it
        const owner = await parentDir(TYPINGS_ROOT);
        await owner.removeEntry(baseName(TYPINGS_ROOT), { recursive: true });
        if (owner !== dirHandle && (await owner.values().next()).done) await (await parentDir(TYPINGS_ROOT.slice(0, TYPINGS_ROOT.lastIndexOf("/")))).removeEntry(owner.name);
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync: could not update the package typings in ${TYPINGS_ROOT}/: ${e?.message || e}`);
    }
}

/** settings.json was saved in the Editor: export canonical settings to disk */
export function exportSettingsFrom(_text?: string): Promise<void> {
    return serial(() => exportSettings(true));
}

function scheduleReconcile(): void {
    if (!dirHandle) return;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void serial(async () => {
            // first: a tweak deleted or moved takes its data folder files along, so its old folder can go
            await exportTweakDataNow();
            await reconcileToDisk();
            await exportSettings();
        });
    }, 300);
}

/** Test seam: run pending storage → disk work and one poll now. */
export async function flush(): Promise<void> {
    if (reconcileTimer || dataTimer) {
        if (reconcileTimer) clearTimeout(reconcileTimer);
        if (dataTimer) clearTimeout(dataTimer);
        reconcileTimer = null;
        dataTimer = null;
        await serial(async () => {
            await exportTweakDataNow();
            await reconcileToDisk();
            await exportSettings();
        });
    }
    await pollOnce();
}

/** file → storage, when settings.json changed on disk; then re-canonicalize */
async function pollSettings(): Promise<void> {
    const f = await readSettingsFile();
    if (!f) return;
    if (settingsSig && settingsSig.lastModified === f.sig.lastModified && settingsSig.size === f.sig.size) return;
    settingsSig = f.sig;
    const { error } = await applySettingsText(f.text);
    if (error) {
        dlogLevel("sync", "warn", `Folder sync: ${SETTINGS_FILE} has an error and was not applied: ${error}`);
        return;
    }
    signal("receiving");
    dlogLevel("sync", "info", `Folder sync: ${SETTINGS_FILE} changed on disk — reloaded the whole file`);
    await writingAs("receiving", () => exportSettings());
}

let pollQueued = false;
let lastPollError = "";

/** one poll (skipped when one is already waiting in the queue) */
function pollOnce(): Promise<void> {
    if (!dirHandle || pollQueued) return Promise.resolve();
    pollQueued = true;
    return serial(async () => {
        pollQueued = false;
        await pollNow();
    });
}

async function pollNow(): Promise<void> {
    if (!dirHandle) return;
    try {
        await pollSettings();
        const seen = await scanFolder();
        const events = computeEvents(known, seen);
        known = seen;
        await applyEvents(events);
        if (events.changed.length || events.added.length || events.removed.length) await persistState();
        // after the scan: a tweak folder moved on disk has its scripts moved by now, and its data folder with it
        await pollTweakData();
        lastPollError = "";
    } catch (e: any) {
        if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
            pause(`Folder sync paused: lost access to "${displayPath}" — open the Editor and click the folder button to re-grant`);
        } else {
            const msg = String(e?.message || e);
            // the same failure repeats every second; report it once
            if (msg !== lastPollError) dlogLevel("sync", "warn", `Folder sync: scanning "${displayPath}" failed: ${msg}`);
            lastPollError = msg;
        }
    }
}

/** stop watching but keep the saved handle so the manager can re-grant */
function pause(reason: string): void {
    paused = true;
    if (timer) clearInterval(timer);
    timer = null;
    dirHandle = null;
    stopKeepAlive();
    const alarms = alarmsApi();
    if (__MV3__ && alarms) alarms.clear(SYNC_ALARM);
    broadcastStatus();
    dlogLevel("sync", "warn", reason);
}

function startPolling(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void pollOnce(), POLL_MS);
}

// ---- MV3 SW liveness ----
// The MV3 service worker idles out after ~30s, which would kill the poller.
// Any extension API call resets that idle timer, so a 25s keep-alive ping
// holds the SW open while folder sync is active; a 30s alarm is the fallback
// that wakes the SW for a catch-up poll if it is reaped anyway.
const SYNC_ALARM = "folderSyncPoll";
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

function alarmsApi(): typeof chrome.alarms | null {
    return typeof chrome !== "undefined" && (chrome as any).alarms ? chrome.alarms : null;
}

function startKeepAlive(): void {
    if (!__MV3__ || keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
        chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    }, 25_000);
}

function stopKeepAlive(): void {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
}

if (__MV3__) {
    // registered at module scope so the alarm wakes/dispatches even into a
    // freshly started SW (vitest defines __MV3__ as false and skips this)
    const alarms = alarmsApi();
    if (alarms) {
        alarms.onAlarm.addListener((a) => {
            if (a.name === SYNC_ALARM && dirHandle) void pollOnce();
        });
    }
}

async function ensureSyncAlarm(): Promise<void> {
    const alarms = alarmsApi();
    if (!__MV3__ || !alarms) return;
    alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
}

/**
 * Start watching the handle stored in IDB.
 * fresh: the user just picked this folder — two-way initial sync. Otherwise
 * this is a resume (worker restart, permission re-grant): diff against the
 * persisted snapshot so changes made while not watching are applied.
 */
export function startFromStoredHandle(opts: { fresh?: boolean } = {}): Promise<boolean> {
    return serial(() => start(opts));
}

async function start(opts: { fresh?: boolean }): Promise<boolean> {
    const handle = await loadSavedHandle();
    if (!handle) return false;
    const resumingSame = !opts.fresh && dirHandle !== null && timer !== null;
    dirHandle = handle;
    paused = false;
    displayPath = await describeHandle(handle);
    lastPollError = "";
    clashWarned = new Set();
    if (opts.fresh) {
        owned = new Map(); // a different folder: no merge base
        ownedData = new Map();
        await initialSync();
        await refreshKnown();
    } else if (!resumingSame) {
        const persisted = await loadPersistedState();
        if (persisted) {
            known = persisted.files;
            owned = persisted.owned;
            ownedData = persisted.ownedData;
            await pollNow(); // catch up on changes made while not watching
        }
        // reconcile what the snapshot can't see: files whose script is gone
        // (or never existed in this profile) and scripts with no file
        await initialSync();
        await refreshKnown();
    }
    startPolling();
    startKeepAlive();
    void ensureSyncAlarm();
    if (!settingsHooked) {
        settingsHooked = true;
        onScriptsChanged(scheduleReconcile);
        storeOwner.onChange((_s, _name, page) => {
            if (!page) scheduleDataExport();
        });
        chrome.storage.onChanged.addListener((c) => {
            if (c.resLogLevel || c.resLogCap || c.resTextTypes || c.resBodyCap || c.resDebuggerOverlays || c[DATA_FOLDER_KEY]) scheduleReconcile();
            if (c[DATA_FOLDER_KEY] && dirHandle) void serial(async () => renameDataFolders(await getDataFolder()));
            if (c[PACKAGE_TYPINGS_KEY] && dirHandle) void serial(ensurePackageTypingsFiles);
        });
    }
    settingsSig = null;
    settingsBroken = false;
    dataFolder = await getDataFolder();
    dataSigs = new Map();
    dataBroken = new Set();
    if (await readSettingsFile()) await pollSettings();
    else await exportSettings();
    // the data folders on disk win; then the missing files are written
    await pollTweakData();
    await exportTweakDataNow();
    await ensureSupportFiles();
    broadcastStatus();
    dlogLevel("sync", "info", `Folder sync: watching "${displayPath}"`);
    return true;
}

/** Stop timers and detach handle, keeping persisted state — as when the worker dies (test seam). */
export function halt(): void {
    dirHandle = null;
    if (timer) clearInterval(timer);
    timer = null;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    if (dataTimer) clearTimeout(dataTimer);
    dataTimer = null;
    stopKeepAlive();
}

export function stop(): Promise<void> {
    return serial(stopNow);
}

async function stopNow(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = null;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    if (dataTimer) clearTimeout(dataTimer);
    dataTimer = null;
    dirHandle = null;
    paused = false;
    displayPath = "";
    settingsSig = null;
    dataSigs = new Map();
    dataBroken = new Set();
    known = new Map();
    owned = new Map();
    ownedData = new Map();
    recentWrites.clear();
    rewrite.clear();
    await clearPersistedState();
    stopKeepAlive();
    const alarms = alarmsApi();
    if (__MV3__ && alarms) alarms.clear(SYNC_ALARM);
    await clearSavedHandle();
    broadcastStatus();
}

export function getStatus(): { active: boolean; path: string; paused: boolean; activity: SyncActivity } {
    return { active: !!dirHandle, path: displayPath, paused: !dirHandle && paused, activity: dirHandle ? activity : "idle" };
}

/** On background start: reconnect silently if the grant is still valid. */
export async function initFromStorage(): Promise<void> {
    const handle = await loadSavedHandle();
    if (!handle) return;
    try {
        const perm = await handle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") {
            dlogLevel("sync", "warn", `Folder sync paused: the browser needs permission for "${handle.name}" again — open the Editor and click the folder button to re-grant`);
            paused = true;
            broadcastStatus();
            return;
        }
        await startFromStoredHandle();
    } catch (e: any) {
        dlogLevel("sync", "warn", `Folder sync could not resume: ${e?.message || e}`);
    }
}

/** Test/e2e seam: adopt an arbitrary directory handle (e.g. OPFS). */
export async function adoptHandle(handle: any): Promise<void> {
    await saveHandle(handle);
    await startFromStoredHandle({ fresh: true });
}
