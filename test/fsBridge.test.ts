import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/folderSync", () => ({
    loadSavedHandle: vi.fn(async () => null),
    clearSavedHandle: vi.fn(async () => {}),
    saveHandle: vi.fn(async () => {}),
    describeHandle: async (h: any) => h.name,
}));

const g = globalThis as any;
let sent: string[];
/** answers a message (default: started, no conflicts) */
let reply: (msg: any) => any;

beforeEach(() => {
    sent = [];
    reply = (msg) => (msg.type === "folderSyncStart" ? { ok: true } : msg.type === "folderSyncPreview" ? { conflicts: [] } : {});
    g.chrome = {
        runtime: {
            sendMessage: (msg: any, cb: (r: any) => void) => {
                sent.push(msg.type);
                cb(reply(msg));
            },
        },
    };
    g.window = g;
});
afterEach(() => {
    delete g.chrome;
    delete g.showDirectoryPicker;
});

describe("fsBridge.openFolder", () => {
    it("a cancelled pick keeps the folder synced so far", async () => {
        const fsBridge = await import("../src/ui/fsBridge");
        fsBridge.setCachedActive(true);
        g.showDirectoryPicker = vi.fn(async () => {
            throw new DOMException("The user aborted a request.", "AbortError");
        });
        await expect(fsBridge.openFolder()).rejects.toMatchObject({ name: "AbortError" });
        expect(sent).toEqual([]);
    });

    it("a picked folder replaces the synced one: the old stops just before the new starts", async () => {
        const fsBridge = await import("../src/ui/fsBridge");
        fsBridge.setCachedActive(true);
        g.showDirectoryPicker = vi.fn(async () => ({ name: "new" }));
        await fsBridge.openFolder();
        expect(sent).toEqual(["folderSyncPreview", "folderSyncStop", "folderSyncStart"]);
    });

    it("nothing synced yet: nothing to stop", async () => {
        const fsBridge = await import("../src/ui/fsBridge");
        fsBridge.setCachedActive(false);
        g.showDirectoryPicker = vi.fn(async () => ({ name: "new" }));
        await fsBridge.openFolder();
        expect(sent).toEqual(["folderSyncPreview", "folderSyncStart"]);
    });

    it("reports the picked folder before its dry run", async () => {
        const fsBridge = await import("../src/ui/fsBridge");
        g.showDirectoryPicker = vi.fn(async () => ({ name: "new" }));
        const picked = vi.fn(() => expect(sent).toEqual([]));
        await fsBridge.openFolder(picked);
        expect(picked).toHaveBeenCalledWith("new");
    });

    it("Cancel during the dry run keeps the folder synced so far", async () => {
        const fsBridge = await import("../src/ui/fsBridge");
        fsBridge.setCachedActive(true);
        g.showDirectoryPicker = vi.fn(async () => ({ name: "new" }));
        const base = reply;
        reply = (msg) => (msg.type === "folderSyncPreview" && fsBridge.cancelPick(), base(msg));
        await expect(fsBridge.openFolder()).rejects.toMatchObject({ name: "AbortError" });
        expect(sent).toEqual(["folderSyncPreview", "folderSyncCancel"]);
    });

    it("Cancel during the first sync: the background forgot the folder", async () => {
        const fsBridge = await import("../src/ui/fsBridge");
        fsBridge.setCachedActive(false);
        g.showDirectoryPicker = vi.fn(async () => ({ name: "new" }));
        const base = reply;
        reply = (msg) => (msg.type === "folderSyncStart" ? { ok: false, cancelled: true } : base(msg));
        await expect(fsBridge.openFolder()).rejects.toMatchObject({ name: "AbortError" });
    });
});
