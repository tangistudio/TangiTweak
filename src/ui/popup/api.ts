import { send, sendWake } from "../lib/messaging";
import { PACKAGES_KEY } from "../../shared/packageModel";
import type { ParamTree } from "../../shared/scriptDef";
import type { ScriptHealthInput } from "../../shared/scriptHealth";
import type { ScriptRole } from "../../shared/tweakBundle";
import type { TabStatus } from "../../shared/tabStatus";

export interface ScriptInfo {
    id: string;
    enabled: boolean;
    error: string | null;
    runtimeError?: ScriptHealthInput["runtimeError"];
    typeErrors?: string[];
    ruleErrors?: string[];
    meta: { name: string; active?: boolean; description?: string };
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

export interface ScriptParams {
    defs: ParamTree;
    values: Record<string, any>;
}

/** Everything the popup needs from the extension — swapped for a fake in tests. */
export interface PopupApi {
    listScripts(): Promise<ScriptInfo[]>;
    /** ids of the scripts counted in the badge for the current tab (matched the page or one of its requests) */
    activeOnTab(): Promise<string[]>;
    /** is TangiTweak running in the current tab (see tabStatus.ts) */
    tabStatus(): Promise<TabStatus>;
    /** the notice's button: grant site access if that's missing, then reload the tab */
    fixTab(status: TabStatus): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    clearError(id: string): Promise<void>;
    getParams(scriptId: string): Promise<ScriptParams>;
    setParam(scriptId: string, key: string, value: any): Promise<void>;
    openManager(scriptId?: string): void;
    loadSize(): Promise<{ w: number; h: number } | null>;
    saveSize(size: { w: number; h: number }): void;
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
    setEnabled: async (id, enabled) => void (await send({ type: "setEnabled", id, enabled })),
    clearError: async (id) => void (await send({ type: "clearScriptError", scriptId: id })),
    getParams: (scriptId) => send({ type: "getScriptParams", scriptId }),
    setParam: async (scriptId, key, value) => void (await send({ type: "setScriptParam", scriptId, key, value })),
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
    onChange(fn) {
        const l = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === "local" && (c.resScripts || c.resScriptOrder || c.resParams || c.resDataFiles || c[PACKAGES_KEY])) fn();
        };
        chrome.storage.onChanged.addListener(l);
        return () => chrome.storage.onChanged.removeListener(l);
    },
};
