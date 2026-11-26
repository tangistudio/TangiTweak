// The toast center: routing, queue, mutes, rate limit, events.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logs: any[] = [];
vi.mock("../src/background/engine/logs", () => ({ log: (...a: any[]) => void logs.push(a) }));

type Link = { tabId: number; frameId: number; ep: any; port: any; pushed: any[]; on: Record<string, (a: any) => void> };
let links: Link[] = [];
let connect: ((l: Link) => void) | undefined;
vi.mock("../src/background/engine/bridgePorts", () => ({
    bridgeLinks: (tabId?: number) => links.filter((l) => tabId === undefined || l.tabId === tabId),
    onBridgeConnect: (fn: any) => void (connect = fn),
}));

import { showToast, startToastCenter, dismissToasts, muteToasts, toastHistory, unreadToastTabs, matchesWhere, cleanPrefs, __resetToastCenter } from "../src/background/engine/toastCenter";

function link(tabId: number): Link {
    const l: Link = {
        tabId,
        frameId: 0,
        pushed: [],
        on: {},
        port: {},
        ep: { closed: false, push: (name: string, a: any) => l.pushed.push([name, a]), on: (name: string, fn: any) => void (l.on[name] = fn) },
    };
    return l;
}

let tabs: chrome.tabs.Tab[];
const created: any[] = [];
const local: Record<string, any> = {};
let scripts: Record<string, { name: string; enabled: boolean; meta: any }>;
const actions: any[] = [];

const tab = (id: number, url: string, active = false): chrome.tabs.Tab => ({ id, url, active, index: id, windowId: 1 }) as any;

beforeEach(() => {
    __resetToastCenter();
    logs.length = created.length = actions.length = 0;
    for (const k of Object.keys(local)) delete local[k];
    tabs = [tab(1, "https://a.example/x", true), tab(2, "https://b.example/y")];
    links = [link(1), link(2)];
    scripts = { s1: { name: "Watcher", enabled: true, meta: { toast: { actions: true, style: { accent: "#e8590c" } } } } };
    const ev = () => ({ addListener: () => {} });
    vi.stubGlobal("chrome", {
        runtime: {},
        tabs: {
            query: async (q: any) => (q.active ? tabs.filter((t) => t.active) : tabs),
            get: async (id: number) => tabs.find((t) => t.id === id) ?? Promise.reject(new Error("no tab")),
            create: async (o: any) => void created.push(o),
            onActivated: ev(),
            onRemoved: ev(),
        },
        windows: { get: async () => ({ focused: true }), update: async () => {} },
        storage: { local: { get: (_k: any, cb: any) => cb({ ...local }), set: (o: any, cb: any) => (Object.assign(local, o), cb?.()) }, onChanged: ev() },
    });
    startToastCenter({ script: async (s) => scripts[s], runAction: async (s, e) => void actions.push([s, e]) });
});
afterEach(() => vi.unstubAllGlobals());

const shows = (l: Link) => l.pushed.filter(([n]) => n === "toast.show").map(([, a]) => a.toast);

describe("toast center", () => {
    it("shows a background toast on the active tab with the tweak's look and the source name", async () => {
        await expect(showToast({ s: "s1" }, { title: "Price dropped", where: "active" })).resolves.toMatchObject({ status: "shown" });
        const [t] = shows(links[0]);
        expect(t).toMatchObject({ title: "Price dropped", source: "Watcher", key: expect.stringMatching(/^s1:/), position: "bottom-right", look: { accent: "#e8590c" } });
        expect(shows(links[1])).toHaveLength(0);
    });

    it("a URL pattern reaches every matching tab and marks the background ones unread", async () => {
        tabs.push(tab(3, "https://b.example/z"));
        links.push(link(3));
        await showToast({ s: "s1" }, { title: "x", where: "https://b.example/*" });
        expect(shows(links[1])).toHaveLength(1);
        expect(shows(links[2])).toHaveLength(1);
        expect(shows(links[0])).toHaveLength(0);
        expect([...unreadToastTabs().keys()].sort()).toEqual([2, 3]);
    });

    it("queues until a matching tab's bridge connects, then shows it", async () => {
        await expect(showToast({ s: "s1" }, { title: "later", where: "https://c.example/*" })).resolves.toMatchObject({ status: "queued" });
        tabs.push(tab(9, "https://c.example/"));
        const l = link(9);
        links.push(l);
        connect!(l);
        await vi.waitFor(() => expect(shows(l)).toHaveLength(1));
        expect(toastHistory("s1").s1[0].status).toBe("shown");
    });

    it("where: \"this\" needs a tab", async () => {
        await expect(showToast({ s: "s1" }, { title: "x", where: "this" })).rejects.toThrow(/page and overlay code/);
        await expect(showToast({ s: "s1", tabId: 2 }, { title: "x", where: "this" })).resolves.toMatchObject({ status: "shown" });
        expect(shows(links[1])).toHaveLength(1);
    });

    it("drops toasts of a muted or turned off tweak and rate-limits new ones (updates of the same id pass)", async () => {
        await muteToasts("s1", true);
        await expect(showToast({ s: "s1" }, { title: "x" })).resolves.toMatchObject({ status: "dropped", reason: expect.stringMatching(/muted/) });
        await muteToasts("s1", false);
        await expect(showToast({ s: "s1" }, { id: "a", title: "1" })).resolves.toMatchObject({ status: "shown" });
        await expect(showToast({ s: "s1" }, { id: "a", title: "2" })).resolves.toMatchObject({ status: "shown" });
        await expect(showToast({ s: "s1" }, { id: "b", title: "3" })).resolves.toMatchObject({ status: "dropped", reason: expect.stringMatching(/10 s/) });
        scripts.s1.enabled = false;
        await expect(showToast({ s: "s1" }, { id: "a", title: "x" })).resolves.toMatchObject({ status: "dropped", reason: expect.stringMatching(/off/) });
    });

    it("attention: \"none\" turns both waiting signals off", async () => {
        await showToast({ s: "s1" }, { title: "quiet", attention: "none" });
        expect(shows(links[0])[0].signals).toEqual({ titleFlash: false, iconDot: false });
    });

    it("an unknown pane falls back to the default toast with a warning", async () => {
        await showToast({ s: "s1" }, { title: "x", pane: "card" });
        expect(shows(links[0])[0].pane).toBeUndefined();
        expect(logs.some((a) => /no tweak.toastPane named "card"/.test(a[1]))).toBe(true);
    });

    it("a click opens the url next to the tab and runs onToastAction; a timeout does nothing", async () => {
        await showToast({ s: "s1" }, { id: "p", title: "x", url: "https://shop.example/item" });
        const key = shows(links[0])[0].key;
        await links[0].on["toast.event"]({ key, actionId: "timeout" });
        expect(created).toHaveLength(0);
        expect(actions).toHaveLength(0);
        links[0].on["toast.event"]({ key, actionId: "click" });
        await vi.waitFor(() => expect(actions).toEqual([["s1", { toastId: "p", actionId: "click" }]]));
        expect(created[0]).toMatchObject({ url: "https://shop.example/item", index: 2, openerTabId: 1 });
    });

    it("dismissToasts takes a tweak's toasts down", async () => {
        await showToast({ s: "s1" }, { id: "a", title: "x" });
        dismissToasts("s1");
        expect(links[0].pushed[links[0].pushed.length - 1]).toEqual(["toast.dismiss", { key: "s1:a" }]);
    });

    it("a dragged corner is saved per site", async () => {
        links[0].on["toast.corner"]({ host: "a.example", position: "top-left" });
        await vi.waitFor(() => expect(local.ttToastPrefs).toEqual({ sites: { "a.example": "top-left" } }));
        await showToast({ s: "s1" }, { title: "x" });
        expect(shows(links[0])[0]).toMatchObject({ position: "top-left", userCorner: true });
    });
});

describe("toast helpers", () => {
    it("matchesWhere and cleanPrefs", () => {
        expect(matchesWhere("https://*.example/*", "https://a.example/x")).toBe(true);
        expect(matchesWhere("https://*.example/*", "https://a.other/x")).toBe(false);
        expect(cleanPrefs({ muteAll: "yes", muted: ["a", 3], corner: "middle", sites: { h: "top-left", g: "nope" } })).toEqual({ muted: ["a"], sites: { h: "top-left" } });
    });
});
