/**
 * The toast center: every `tweak.toast` ends up here, from background code
 * (the MV3 sandbox over L1, MV2 in process) and from page, overlay and
 * preview code (overlayLinks.ts). It checks the toast again (a page could
 * send anything), applies the user's mutes and the per-tweak rate limits,
 * picks the tab (`where`), and pushes it to that tab's top-frame bridge
 * (`toast.show`), which draws it (hook/toastLayer.ts). A toast with no tab
 * to show it waits in a queue until one connects or becomes active, or its
 * `ttl` runs out.
 *
 * What the user does to a toast comes back as `toast.event`: links open in
 * a new tab, and the tweak's `tweak.onToastAction` handlers run through
 * {@link ToastCenterHost.runAction}.
 *
 * @module
 */
import { matchAny } from "../../shared/matcher";
import { mergeToastStyle, normalizeToast, resolveToastPosition, TOAST_BURST, TOAST_MAX_PER_TAB, TOAST_PER_HOUR, TOAST_POSITIONS, type ToastEvent, type ToastPosition, type ToastResult, type ToastSpec, type ToastStyle, type ToastView } from "../../shared/toast";
import type { ResMeta } from "../../shared/metaParser";
import { bridgeLinks, onBridgeConnect, type BridgeLink } from "./bridgePorts";
import { log } from "./logs";

/** Where a `tweak.toast` call came from. */
export interface ToastFrom {
    /** The script's id. */
    s: string;
    /** The tab of the calling page or overlay (`where: "this"`). */
    tabId?: number;
    /** From the Editor's preview: `"this"` means the active tab. */
    preview?: boolean;
}

/** The user's toast settings (chrome.storage.local {@link TOAST_PREFS_KEY}). */
export interface ToastPrefs {
    /** Mute every tweak's toasts. */
    muteAll?: boolean;
    /** The ids of tweaks whose toasts are muted. */
    muted?: string[];
    /** The corner for all toasts; absent: each tweak chooses. */
    corner?: ToastPosition;
    /** Corners the user dragged stacks to, by host. */
    sites?: Record<string, ToastPosition>;
    /** Same look for all toasts: tweaks keep only their accent color. */
    sameLook?: boolean;
    /** Flash the tab title while a toast waits (default on). */
    titleFlash?: boolean;
    /** Dot on the tab icon while a toast waits (default on). */
    iconDot?: boolean;
    /** Flash the window for `attention: "window"` toasts (default off). */
    flashWindow?: boolean;
}

export const TOAST_PREFS_KEY = "ttToastPrefs";
/** chrome.storage.session (MV3): the queue, so a restarted service worker keeps it */
const QUEUE_KEY = "ttToastQueue";
/** Toasts kept per tweak for the popup. */
export const TOAST_HISTORY = 20;

/** A toast in the popup's history. */
export interface ToastHistoryEntry {
    id: string;
    title?: string;
    message?: string;
    kind: ToastSpec["kind"];
    url?: string;
    /** When it was made (ms since epoch). */
    at: number;
    /** What happened: shown, queued (still waiting), expired, dropped (with why). */
    status: "shown" | "queued" | "expired" | "dropped";
    reason?: string;
}

/** What the toast center needs from the rest of the background. */
export interface ToastCenterHost {
    /** The script's name, whether it's on, and its meta (undefined when it's gone). */
    script(s: string): Promise<{ name: string; enabled: boolean; meta: ResMeta } | undefined>;
    /** Runs the script's `tweak.onToastAction` handlers. */
    runAction(s: string, event: ToastEvent): Promise<void>;
}

interface Waiting {
    s: string;
    view: ToastView;
    /** The tab it must show in (`"this"`), if any. */
    tabId?: number;
    /** When it stops waiting. */
    expires: number;
}

interface Shown {
    s: string;
    view: ToastView;
    tabId: number;
}

let host: ToastCenterHost | null = null;
let prefs: ToastPrefs = {};
let prefsLoaded: Promise<void> | null = null;
let queue: Waiting[] = [];
/** Toasts on screen, by tab, then key. */
const shown = new Map<number, Map<string, Shown>>();
/** When each tweak showed its recent toasts (rate limit). */
const sent = new Map<string, number[]>();
const history = new Map<string, ToastHistoryEntry[]>();
/** Tabs with a toast the user hasn't seen (the toolbar badge's dot). */
const unread = new Map<number, string>();
const unreadFns = new Set<() => void>();

const hasSession = () => typeof chrome !== "undefined" && !!chrome.storage?.session;

function loadPrefs(): Promise<void> {
    return (prefsLoaded ??= new Promise<void>((resolve) => {
        try {
            chrome.storage.local.get([TOAST_PREFS_KEY], (d) => {
                void chrome.runtime?.lastError;
                prefs = cleanPrefs(d?.[TOAST_PREFS_KEY]);
                resolve();
            });
        } catch {
            resolve();
        }
    }));
}

/** Keeps the well-formed settings only. */
export function cleanPrefs(v: unknown): ToastPrefs {
    const o: Record<string, any> = v && typeof v === "object" ? v : {};
    const out: ToastPrefs = {};
    for (const k of ["muteAll", "sameLook", "titleFlash", "iconDot", "flashWindow"] as const) if (typeof o[k] === "boolean") out[k] = o[k];
    if (Array.isArray(o.muted)) out.muted = o.muted.filter((x: unknown) => typeof x === "string");
    if (TOAST_POSITIONS.includes(o.corner)) out.corner = o.corner;
    if (o.sites && typeof o.sites === "object") {
        out.sites = {};
        for (const [h, p] of Object.entries(o.sites)) if (TOAST_POSITIONS.includes(p as ToastPosition)) out.sites[h] = p as ToastPosition;
    }
    return out;
}

/** The user's toast settings. */
export async function getToastPrefs(): Promise<ToastPrefs> {
    await loadPrefs();
    return { ...prefs };
}

/** Changes the user's toast settings; muting a tweak takes its toasts down. */
export async function setToastPrefs(patch: Partial<ToastPrefs>): Promise<ToastPrefs> {
    await loadPrefs();
    prefs = cleanPrefs({ ...prefs, ...patch });
    await new Promise<void>((r) => chrome.storage.local.set({ [TOAST_PREFS_KEY]: prefs }, () => (void chrome.runtime?.lastError, r())));
    if (prefs.muteAll) for (const s of new Set([...queue.map((w) => w.s), ...[...shown.values()].flatMap((m) => [...m.values()].map((x) => x.s))])) dismissToasts(s);
    else for (const s of prefs.muted ?? []) dismissToasts(s);
    return { ...prefs };
}

/** Mutes or unmutes one tweak's toasts. */
export async function muteToasts(s: string, muted: boolean): Promise<void> {
    await loadPrefs();
    const set = new Set(prefs.muted ?? []);
    if (muted) set.add(s);
    else set.delete(s);
    await setToastPrefs({ muted: [...set] });
}

/** Sets up the toast center (once, at startup). */
export function startToastCenter(h: ToastCenterHost): void {
    const first = !host;
    host = h;
    if (!first) return;
    void loadPrefs();
    if (hasSession())
        chrome.storage.session.get([QUEUE_KEY], (d) => {
            void chrome.runtime?.lastError;
            const saved: Waiting[] = Array.isArray(d?.[QUEUE_KEY]) ? d[QUEUE_KEY] : [];
            queue = [...saved.filter((w) => w?.view?.key && w.expires > Date.now()), ...queue];
            void flush();
        });
    onBridgeConnect(serveBridge);
    for (const link of bridgeLinks()) serveBridge(link);
    chrome.tabs?.onActivated?.addListener(({ tabId }) => {
        if (unread.delete(tabId)) notifyUnread();
        void flush();
    });
    chrome.tabs?.onRemoved?.addListener((tabId) => {
        shown.delete(tabId);
        if (unread.delete(tabId)) notifyUnread();
        queue = queue.filter((w) => w.tabId !== tabId);
    });
    chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area === "local" && changes[TOAST_PREFS_KEY]) prefs = cleanPrefs(changes[TOAST_PREFS_KEY].newValue);
    });
}

function serveBridge(link: BridgeLink): void {
    if (link.frameId !== 0) return;
    // a new document: what the old one showed is gone
    shown.delete(link.tabId);
    link.ep.on("toast.event", (a) => void onEvent(link.tabId, a));
    link.ep.on("toast.corner", (a) => {
        if (typeof a?.host !== "string" || !a.host) return;
        const sites = { ...(prefs.sites ?? {}) };
        if (a.position === null) delete sites[a.host];
        else if (TOAST_POSITIONS.includes(a.position)) sites[a.host] = a.position;
        else return;
        void setToastPrefs({ sites });
    });
    void flush(link.tabId);
}

const pushHistory = (s: string, view: ToastSpec & { createdAt?: number }, status: ToastHistoryEntry["status"], reason?: string) => {
    const list = history.get(s) ?? [];
    const at = view.createdAt ?? Date.now();
    const i = list.findIndex((e) => e.id === view.id && e.at === at);
    const entry: ToastHistoryEntry = { id: view.id, kind: view.kind, at, status, ...(view.title ? { title: view.title } : {}), ...(view.message ? { message: view.message } : {}), ...(view.url ? { url: view.url } : {}), ...(reason ? { reason } : {}) };
    if (i >= 0) list[i] = entry;
    else list.unshift(entry);
    history.set(s, list.slice(0, TOAST_HISTORY));
};

/** The last toasts of one tweak, or of every tweak, newest first. */
export function toastHistory(s?: string): Record<string, ToastHistoryEntry[]> {
    if (s !== undefined) return { [s]: [...(history.get(s) ?? [])] };
    return Object.fromEntries([...history].map(([k, v]) => [k, [...v]]));
}

/** Whether `s` may show a new toast now (rate limit); records it when it may. */
function allowRate(s: string, now: number): string | undefined {
    const times = (sent.get(s) ?? []).filter((t) => now - t < 3_600_000);
    if (times.filter((t) => now - t < 10_000).length >= TOAST_BURST) return `more than ${TOAST_BURST} toast in 10 s`;
    if (times.length >= TOAST_PER_HOUR) return `more than ${TOAST_PER_HOUR} toasts in an hour`;
    times.push(now);
    sent.set(s, times);
    return undefined;
}

const isUpdate = (s: string, id: string): boolean => queue.some((w) => w.s === s && w.view.id === id) || [...shown.values()].some((m) => m.has(`${s}:${id}`));

const dropped = (s: string, spec: ToastSpec, reason: string, tabId = -1): ToastResult => {
    pushHistory(s, spec, "dropped", reason);
    log(tabId, `toast "${spec.title ?? spec.message ?? spec.id}" dropped: ${reason}`, "warn", s);
    return { id: spec.id, status: "dropped", reason };
};

/** `tweak.toast`: check, mute, rate-limit, route and show or queue. */
export async function showToast(from: ToastFrom, raw: unknown): Promise<ToastResult> {
    if (!host) throw new Error("tweak.toast isn't available here");
    // the caller's shim checked it, but a page could send anything
    const spec = normalizeToast(raw as any);
    const tabId = spec.where === "this" && !from.preview ? from.tabId : undefined;
    if (spec.where === "this" && !from.preview && tabId === undefined) throw new Error(`tweak.toast: where: "this" works in page and overlay code only; use "active" or a URL pattern`);
    const script = await host.script(from.s);
    if (!script) throw new Error("tweak.toast: this tweak is gone");
    if (!script.enabled) return dropped(from.s, spec, "the tweak is off");
    await loadPrefs();
    if (prefs.muteAll) return dropped(from.s, spec, "all toasts are muted");
    if (prefs.muted?.includes(from.s)) return dropped(from.s, spec, "this tweak's toasts are muted");
    const now = Date.now();
    if (!isUpdate(from.s, spec.id)) {
        const why = allowRate(from.s, now);
        if (why) return dropped(from.s, spec, why);
    }
    if (spec.pane && !script.meta.toast?.panes?.includes(spec.pane)) {
        log(from.tabId ?? -1, `tweak.toast: no tweak.toastPane named "${spec.pane}"; showing the default toast`, "warn", from.s);
        delete spec.pane;
        if (!spec.title && !spec.message) spec.message = "";
    }
    const tweakStyle = script.meta.toast?.style;
    const look = prefs.sameLook ? pickAccent(mergeToastStyle(tweakStyle, spec.style)) : mergeToastStyle(tweakStyle, spec.style);
    const view: ToastView = {
        ...spec,
        key: `${from.s}:${spec.id}`,
        source: script.name,
        look,
        position: "bottom-right",
        userCorner: false,
        signals: spec.attention === "none" ? { titleFlash: false, iconDot: false } : { titleFlash: look.titleFlash ?? prefs.titleFlash ?? true, iconDot: look.iconDot ?? prefs.iconDot ?? true },
        createdAt: now,
    };
    // replace a queued copy
    queue = queue.filter((w) => w.view.key !== view.key);
    const w: Waiting = { s: from.s, view, ...(tabId !== undefined ? { tabId } : {}), expires: now + spec.ttl };
    const at = await deliver(w);
    if (at !== undefined) {
        pushHistory(from.s, view, "shown");
        log(at, `toast "${spec.title ?? spec.message ?? spec.id}"`, "info", from.s);
        return { id: spec.id, status: "shown" };
    }
    queue.push(w);
    saveQueue();
    pushHistory(from.s, view, "queued");
    log(-1, `toast "${spec.title ?? spec.message ?? spec.id}" waits for a tab (${spec.where})`, "info", from.s);
    return { id: spec.id, status: "queued" };
}

/** Same look for all toasts: only the accent (and its dark one) stays. */
function pickAccent(s: ToastView["look"]): ToastView["look"] {
    const out: ToastView["look"] = {};
    if (s.accent) out.accent = s.accent;
    if (s.dark?.accent) out.dark = { accent: s.dark.accent };
    if (s.position) out.position = s.position;
    if (s.titleFlash !== undefined) out.titleFlash = s.titleFlash;
    if (s.iconDot !== undefined) out.iconDot = s.iconDot;
    return out;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
    try {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return t;
    } catch {
        return undefined;
    }
}

async function tabOf(id: number): Promise<chrome.tabs.Tab | undefined> {
    try {
        return await chrome.tabs.get(id);
    } catch {
        return undefined;
    }
}

const topLink = (tabId: number): BridgeLink | undefined => bridgeLinks(tabId).find((l) => l.frameId === 0 && !l.ep.closed);

/** The tabs a waiting toast goes to now: one for `"this"` and `"active"`, every matching tab for a URL pattern. */
async function targetsOf(w: Waiting): Promise<chrome.tabs.Tab[]> {
    const one = (t: chrome.tabs.Tab | undefined) => (t ? [t] : []);
    if (w.tabId !== undefined) return one(await tabOf(w.tabId));
    const where = w.view.where;
    if (where === "active" || where === "this") return one(await activeTab());
    let tabs: chrome.tabs.Tab[] = [];
    try {
        tabs = await chrome.tabs.query({});
    } catch {}
    return tabs.filter((t) => !!t.url && matchesWhere(where, t.url));
}

/** Whether a tab's URL matches a toast's `where` pattern. */
export function matchesWhere(where: string, url: string): boolean {
    try {
        return matchAny([where], url);
    } catch {
        return false;
    }
}

const hostOf = (url?: string): string => {
    try {
        return url ? new URL(url).host : "";
    } catch {
        return "";
    }
};

/** Shows a waiting toast on every tab it goes to that can show it; returns the first such tab. */
async function deliver(w: Waiting): Promise<number | undefined> {
    let first: number | undefined;
    for (const tab of await targetsOf(w)) {
        if (tab.id !== undefined && (await showOn(w, tab))) first ??= tab.id;
    }
    return first;
}

async function showOn(w: Waiting, tab: chrome.tabs.Tab): Promise<boolean> {
    const link = topLink(tab.id!);
    if (!link) return false;
    const pos = resolveToastPosition({ site: prefs.sites?.[hostOf(tab.url)], global: prefs.corner, toast: w.view.style?.position, tweak: w.view.look.position });
    const view: ToastView = { ...w.view, ...pos };
    let mine = shown.get(tab.id!);
    if (!mine) shown.set(tab.id!, (mine = new Map()));
    mine.delete(view.key);
    // the tab keeps at most TOAST_MAX_PER_TAB: the oldest non-sticky one goes first
    while (mine.size >= TOAST_MAX_PER_TAB) {
        const all = [...mine.values()];
        const old = all.find((x) => x.view.duration !== "sticky" && x.view.kind !== "error") ?? all[0];
        mine.delete(old.view.key);
        link.ep.push("toast.dismiss", { key: old.view.key });
    }
    mine.set(view.key, { s: w.s, view, tabId: tab.id! });
    link.ep.push("toast.show", { toast: view });
    if (!tab.active) {
        unread.set(tab.id!, view.look.accent ?? "#0b6bcb");
        notifyUnread();
    }
    if (w.view.attention === "window" && prefs.flashWindow && tab.windowId !== undefined) {
        try {
            const win = await chrome.windows.get(tab.windowId);
            if (!win.focused) await chrome.windows.update(tab.windowId, { drawAttention: true });
        } catch {}
    }
    return true;
}

let flushing: Promise<void> | null = null;

/** Tries every waiting toast again (or only `tabId`'s and the routed ones). */
async function flush(_tabId?: number): Promise<void> {
    if (flushing) return flushing.then(() => flush(_tabId));
    flushing = (async () => {
        const now = Date.now();
        const keep: Waiting[] = [];
        for (const w of queue) {
            if (w.expires <= now) {
                pushHistory(w.s, w.view, "expired");
                log(-1, `toast "${w.view.title ?? w.view.message ?? w.view.id}" expired: no tab showed it within its ttl`, "info", w.s);
                continue;
            }
            const at = await deliver(w).catch(() => undefined);
            if (at === undefined) keep.push(w);
            else pushHistory(w.s, w.view, "shown");
        }
        queue = keep;
        saveQueue();
    })();
    try {
        await flushing;
    } finally {
        flushing = null;
    }
}

function saveQueue(): void {
    if (!hasSession()) return;
    try {
        chrome.storage.session.set({ [QUEUE_KEY]: queue }, () => void chrome.runtime?.lastError);
    } catch {}
}

/** The user did something to a toast (`toast.event` from a bridge). */
async function onEvent(tabId: number, a: { key?: unknown; actionId?: unknown; value?: unknown; closed?: unknown }): Promise<void> {
    if (typeof a?.key !== "string" || typeof a.actionId !== "string") return;
    const mine = shown.get(tabId);
    const t = mine?.get(a.key);
    if (!t) return;
    if (a.closed) mine!.delete(a.key);
    if (unread.delete(tabId)) notifyUnread();
    if (a.actionId === "timeout") return;
    const action = t.view.actions?.find((x) => x.id === a.actionId);
    const url = a.actionId === "click" ? t.view.url : action?.url;
    if (url) {
        try {
            const tab = await tabOf(tabId);
            await chrome.tabs.create({ url, ...(tab ? { index: tab.index + 1, openerTabId: tabId } : {}) });
        } catch {}
    }
    const script = await host?.script(t.s);
    if (!script?.enabled || !script.meta.toast?.actions) return;
    const event: ToastEvent = { toastId: t.view.id, actionId: a.actionId, ...(a.value !== undefined ? { value: a.value } : {}) };
    try {
        await host!.runAction(t.s, event);
    } catch (e) {
        log(tabId, `tweak.onToastAction: ${e instanceof Error ? e.message : String(e)}`, "error", t.s);
    }
}

/** Takes down one tweak's toasts and drops its queue (it was turned off, muted or deleted). */
export function dismissToasts(s: string): void {
    const before = queue.length;
    queue = queue.filter((w) => w.s !== s);
    if (queue.length !== before) saveQueue();
    for (const [tabId, mine] of shown)
        for (const [key, t] of [...mine])
            if (t.s === s) {
                mine.delete(key);
                topLink(tabId)?.ep.push("toast.dismiss", { key });
            }
}

/** A tweak's toast style changed (a save): its toasts on screen take the new look. */
export function restyleToasts(s: string, style: ToastStyle | undefined): void {
    for (const [tabId, mine] of shown)
        for (const t of mine.values())
            if (t.s === s) {
                const look = prefs.sameLook ? pickAccent(mergeToastStyle(style, t.view.style)) : mergeToastStyle(style, t.view.style);
                if (JSON.stringify(look) === JSON.stringify(t.view.look)) continue;
                t.view = { ...t.view, look };
                topLink(tabId)?.ep.push("toast.show", { toast: t.view });
            }
}

/** The tabs with a toast the user hasn't seen, with its accent color. */
export function unreadToastTabs(): Map<number, string> {
    return new Map(unread);
}

/** Calls `fn` when {@link unreadToastTabs} changes. */
export function onUnreadToastsChanged(fn: () => void): () => void {
    unreadFns.add(fn);
    return () => unreadFns.delete(fn);
}

function notifyUnread(): void {
    for (const fn of unreadFns) fn();
}

/** Tests: forget everything. */
export function __resetToastCenter(): void {
    host = null;
    prefs = {};
    prefsLoaded = null;
    queue = [];
    shown.clear();
    sent.clear();
    history.clear();
    unread.clear();
    unreadFns.clear();
}
