/**
 * Manager-page side of the scripts-folder sync.
 *
 * The actual WATCHING lives in the persistent background page
 * (src/background/folderSync.ts) — page timers in a hidden manager tab
 * are throttled by Chrome, the background page's are not, so external
 * file changes apply immediately regardless of focus.
 *
 * This module handles what needs a visible page: the directory picker
 * (user gesture), the permission re-grant, and the status plumbing.
 */

import { describeHandle, loadSavedHandle, clearSavedHandle, saveHandle } from "../shared/folderSync";
import { scriptFileName } from "../shared/scriptName";

export function isSupported(): boolean {
    return typeof (window as any).showDirectoryPicker === "function";
}

let cachedActive = false;

export function isSyncing(): boolean {
    return cachedActive === true;
}

export function setCachedActive(v: boolean): void {
    cachedActive = v;
}

export async function queryStatus(): Promise<{ active: boolean; path: string }> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "folderSyncStatus" }, (r: any) => resolve(r || { active: false, path: "" }));
    });
}

export function sendRaw(msg: any): Promise<any> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(msg, (r: any) => {
            void chrome.runtime.lastError;
            resolve(r);
        });
    });
}

/** Test/e2e seam: watch an arbitrary handle (e.g. OPFS) — manager-side. */
export async function adoptForWatch(handle: any): Promise<boolean> {
    await saveHandle(handle);
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "folderSyncAdopt", fresh: true }, (r: any) => resolve(!!(r && r.ok)));
    });
}

/** the picked folder being synced (openFolder), until it's synced or cancelled */
let pick: { token: string; cancelled: boolean } | null = null;

function cancelled(): DOMException {
    return new DOMException("folder sync cancelled", "AbortError");
}

/**
 * Pick a folder (user gesture required) and hand it to the background
 * watcher, which runs a two-way initial sync and writes the support files.
 * It replaces the folder synced so far; cancelling the pick, the conflict
 * confirm or (cancelPick) the preview keeps that one. `onPicked` gets the
 * folder as the sync reports it, right after the pick.
 */
export async function openFolder(onPicked?: (path: string) => unknown): Promise<void> {
    const dirHandle = await (window as any).showDirectoryPicker({ mode: "readwrite" } as any);
    const me = (pick = { token: crypto.randomUUID(), cancelled: false });
    try {
        await onPicked?.(await describeHandle(dirHandle));
        await startPicked(dirHandle, me);
    } finally {
        if (pick === me) pick = null;
    }
}

async function startPicked(dirHandle: any, me: { token: string; cancelled: boolean }): Promise<void> {
    // dry run first: say which scripts/files will be overwritten before anything is
    await saveHandle(dirHandle, "pendingFolder");
    const preview = await sendRaw({ type: "folderSyncPreview", token: me.token }).catch(() => null);
    await clearSavedHandle("pendingFolder");
    if (me.cancelled) throw cancelled();
    if (preview?.conflicts?.length) {
        const lines = preview.conflicts.map((c: any) => `• ${c.name} — keeping the ${c.winner === "file" ? "file in the folder" : "script in the extension"}`);
        const ok = confirm(
            `${preview.conflicts.length} script(s) differ between the extension and "${dirHandle.name}":\n\n${lines.join("\n")}\n\n` +
                `The newer copy wins; the other is saved to .tangitweak-backup/ in the folder. Continue?`
        );
        if (!ok) throw cancelled();
    }
    // the old folder (if any) stops only now: a cancelled pick keeps it synced
    if (cachedActive) await sendRaw({ type: "folderSyncStop" });
    await saveHandle(dirHandle);
    const started = await sendRaw({ type: "folderSyncStart", fresh: true, token: me.token });
    // the background forgot the folder already
    if (started?.cancelled) throw cancelled();
    if (!started || !started.ok) {
        await clearSavedHandle();
        throw new Error("folder sync could not start in the background (see the extension logs)");
    }

    // scripts ⇄ files and the support files (typings, tsconfig, schema): the background writes them
}

/** Settings → Cancel: stop the picked folder's preview or first sync. */
export function cancelPick(): void {
    if (!pick) return;
    pick.cancelled = true;
    void sendRaw({ type: "folderSyncCancel", token: pick.token });
}

export function stopSync(): Promise<void> {
    return sendRaw({ type: "folderSyncStop" }).then(() => {
        void clearSavedHandle();
    });
}

/** Injective file name: sanitized display name + .ts */
export function fileNameFor(_id: string, name: string): string {
    return scriptFileName(name);
}

/** Does this script's display name correspond to this file? */
export function matchesFile(scriptName: string, fileName: string): boolean {
    return fileNameFor("", scriptName) === fileName;
}


/**
 * Try to reconnect the saved dedicated folder silently (background).
 * Returns "synced" | "prompt" (needs a permission click) | "none".
 */
export async function autoReconnect(): Promise<"synced" | "prompt" | "none"> {
    const handle = await loadSavedHandle();
    if (!handle) return "none";
    try {
        const perm = await handle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") return "prompt";
        const r = await sendRaw({ type: "folderSyncStart" });
        return !!(r && r.ok) ? "synced" : "none";
    } catch {
        return "prompt";
    }
}

/** User-gesture path: re-grant permission, then hand to the background. */
export async function reconnectClicked(): Promise<boolean> {
    const handle = await loadSavedHandle();
    if (!handle) return false;
    try {
        if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") return false;
        const r = await sendRaw({ type: "folderSyncStart" });
        return !!(r && r.ok);
    } catch {
        return false;
    }
}
