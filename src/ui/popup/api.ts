import { send, sendWake } from "../lib/messaging";
import { PACKAGES_KEY } from "../../shared/packageModel";
import type { ParamTree } from "../../shared/scriptDef";
import type { ScriptHealthInput } from "../../shared/scriptHealth";
import type { ScriptRole } from "../../shared/tweakBundle";
import type { TabStatus } from "../../shared/tabStatus";
import { toastsApi, type ScheduleRow, type ToastHistoryEntry } from "../lib/toastsApi";

/** A tweak's toasts and schedules, for its row. */
export interface ToastActivity {
    muted: boolean;
    /** Newest first. */
    history: ToastHistoryEntry[];
    schedules: ScheduleRow[];
}
import type { UserScriptsStatus } from "../../shared/userScriptsStatus";

export interface ScriptInfo {
    id: string;
    enabled: boolean;
    error: string | null;
    runtimeError?: ScriptHealthInput["runtimeError"];
    typeErrors?: string[];
    ruleErrors?: string[];
    meta: { name: string; active?: boolean; description?: string; routes?: { kind: string }[] };
    /** in its tweak bundle: the entry (a tweak: it has the switch), a module of `entry`, or a file outside any bundle */
    role: ScriptRole["role"];
    entry?: string;
    /** an entry's bundle display name */
    bundleName?: string;
    bundleDescription?: string;
    /** resolved `<img src>` URL from script or bundle metadata `icon` */
    iconUrl?: string;
    paramDefs?: ParamTree;
}

/** A tweak's layer setting: the user's choice (unset: automatic) and what automatic gives. */
export interface ScriptLayer {
    layer?: "base" | "site" | "override";
    /** e.g. "Automatic (site)"; plain "Automatic" when the tweak has no network handlers */
    auto: string;
}

export interface ScriptParams {
    defs: ParamTree;
    values: Record<string, any>;
}

/** Active `tweak.site` takeover state on the current tab. */
export interface SiteTabState {
    scriptId: string;
    scriptName: string;
    mode: "custom" | "original";
    defaultMode: "custom" | "original";
    debuggerSafe: boolean;
}

/** Everything the popup needs from the extension — swapped for a fake in tests. */
export interface PopupApi {
    listScripts(): Promise<ScriptInfo[]>;
    /** ids of the scripts counted in the badge for the current tab (matched the page or one of its requests) */
    activeOnTab(): Promise<string[]>;
    /** is TangiTweak running in the current tab (see tabStatus.ts) */
    tabStatus(): Promise<TabStatus>;
    /** active `tweak.site` state for the current tab, if one matches its URL */
    siteTabState?(): Promise<SiteTabState | null>;
    /** switch the current tab between the custom site and the original site, then reload */
    toggleSiteTab?(mode: "custom" | "original"): Promise<void>;
    /** the notice's button: grant site access if that's missing, then reload the tab */
    fixTab(status: TabStatus): Promise<void>;
    /** Chrome MV3: can onPage and onSite code run (a fresh check) */
    userScripts(): Promise<UserScriptsStatus>;
    /** the notice's button: request the permission, or open TangiTweak's details for "Allow User Scripts" */
    fixUserScripts(status: UserScriptsStatus): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    clearError(id: string): Promise<void>;
    getParams(scriptId: string): Promise<ScriptParams>;
    setParam(scriptId: string, key: string, value: any): Promise<void>;
    getLayer?(scriptId: string): Promise<ScriptLayer>;
    /** undefined: automatic */
    setLayer?(scriptId: string, layer: ScriptLayer["layer"]): Promise<void>;
    openManager(scriptId?: string): void;
    loadSize(): Promise<{ w: number; h: number } | null>;
    saveSize(size: { w: number; h: number }): void;
    /** each tweak's toasts and schedules, by script id (tweaks with none are left out) */
    toastActivity?(): Promise<Record<string, ToastActivity>>;
    muteToasts?(scriptId: string, muted: boolean): Promise<void>;
    /** pauses or resumes all of a tweak's schedules */
    pauseSchedules?(scriptId: string, paused: boolean): Promise<void>;
    /** scripts or params changed elsewhere (manager, import, folder sync) — returns an unsubscribe */
    onChange?(fn: () => void): () => void;
}

// the tab tabStatus() looked at, for fixTab()
let noticeTab: chrome.tabs.Tab | undefined;

export const chromePopupApi: PopupApi = {
    // sendWake: the first message may race the SW's wake-up (MV3)
    listScripts: async () => (await sendWake<ScriptInfo[]>({ type: "listScripts" })) || [],
    activeOnTab: async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined) return [];
        return (await send<string[]>({ type: "activeScripts", tabId: tab.id })) || [];
    },
    tabStatus: async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        noticeTab = tab;
        if (tab?.id === undefined) return "ok";
        return (await sendWake<TabStatus>({ type: "tabStatus", tabId: tab.id })) || "ok";
    },
    siteTabState: async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined || !tab.url) return null;
        const res = await sendWake<(SiteTabState & { matched?: boolean }) | null>({ type: "siteTabState", tabId: tab.id, url: tab.url });
        return res && res.matched !== false && res.scriptId ? res : null;
    },
    toggleSiteTab: async (mode) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined) return;
        await send({ type: "toggleSiteTab", tabId: tab.id, mode });
    },
    fixTab: async (status) => {
        const tab = noticeTab;
        if (tab?.id === undefined) return;
        if (status === "no-access" && tab.url) {
            // first thing in the click: the request needs its user gesture
            const origins = [new URL(tab.url).origin + "/*"];
            const granted = await new Promise<boolean>((resolve) => chrome.permissions.request({ origins }, (ok) => resolve(!chrome.runtime.lastError && !!ok)));
            if (!granted) return;
        }
        chrome.tabs.reload(tab.id);
        window.close();
    },
    userScripts: async () => (__MV3__ && (await sendWake<{ status: UserScriptsStatus }>({ type: "userScriptsStatus" }))?.status) || "ok",
    fixUserScripts: async (status) => {
        if (status === "no-permission") {
            // first thing in the click: the request needs its user gesture
            await new Promise<void>((resolve) => chrome.permissions.request({ permissions: ["userScripts" as any] }, () => resolve(void chrome.runtime.lastError)));
            return;
        }
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }, () => void chrome.runtime.lastError);
        window.close();
    },
    setEnabled: async (id, enabled) => void (await send({ type: "setEnabled", id, enabled })),
    clearError: async (id) => void (await send({ type: "clearScriptError", scriptId: id })),
    getParams: (scriptId) => send({ type: "getScriptParams", scriptId }),
    setParam: async (scriptId, key, value) => void (await send({ type: "setScriptParam", scriptId, key, value })),
    getLayer: async (scriptId) => (await send<ScriptLayer>({ type: "getScriptLayer", scriptId })) || { auto: "Automatic" },
    setLayer: async (scriptId, layer) => void (await send({ type: "setScriptLayer", scriptId, layer })),
    openManager(scriptId) {
        const url = chrome.runtime.getURL("editor.html") + (scriptId ? `?script=${encodeURIComponent(scriptId)}` : "");
        chrome.tabs.create({ url });
        window.close();
    },
    loadSize: () =>
        new Promise((resolve) =>
            chrome.storage.local.get("resPopupSize", (d) => {
                const s = d?.resPopupSize;
                resolve(s && s.w && s.h ? s : null);
            })
        ),
    saveSize: (size) => void chrome.storage.local.set({ resPopupSize: size }),
    toastActivity: async () => {
        const [prefs, history, rows] = await Promise.all([toastsApi.prefs(), toastsApi.history(), toastsApi.schedules()]);
        const out: Record<string, ToastActivity> = {};
        const at = (s: string) => (out[s] ??= { muted: false, history: [], schedules: [] });
        for (const s of prefs.muted ?? []) at(s).muted = true;
        for (const [s, list] of Object.entries(history)) if (list.length) at(s).history = [...list].sort((a, b) => b.at - a.at);
        for (const r of rows) at(r.scriptId).schedules.push(r);
        return out;
    },
    muteToasts: (scriptId, muted) => toastsApi.mute(scriptId, muted),
    pauseSchedules: (scriptId, paused) => toastsApi.pause(scriptId, undefined, paused),
    onChange(fn) {
        const l = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === "local" && (c.resScripts || c.resScriptOrder || c.resParams || c.resScriptLayers || c.resDataFiles || c[PACKAGES_KEY])) fn();
        };
        chrome.storage.onChanged.addListener(l);
        return () => chrome.storage.onChanged.removeListener(l);
    },
};
