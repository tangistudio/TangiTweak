/**
 * The sandbox page: the only extension context where Manifest V3 allows
 * eval. It hosts src/background/sandboxCore.ts in a hidden iframe inside the
 * offscreen document (Firefox: inside the event page) and talks to it with
 * postMessage only (sandboxed pages have no chrome.* APIs).
 */
import { connectSandbox, receiveInSandbox } from "./sandboxCore";

/**
 * Environment parity with the MV2 background page: sandboxed pages get NO
 * chrome.* APIs, but MV2 scripts compile in a page where chrome exists.
 * A script touching chrome before registering its handlers would die
 * inside its own try/catch and silently compile with no handlers — so
 * the sandbox provides a minimal chrome/browser shim (metadata + in-memory
 * storage; reverse-channel ops like tweak.storage still go over postMessage
 * via the tweak shim, NOT this one).
 */
const EXT_ID = new URLSearchParams(location.search).get("extId") || "sandboxed-extension";
const chromeShim: any = {
    runtime: {
        id: EXT_ID,
        lastError: undefined,
        getManifest: () => ({ version: "0.41.1", version_name: "0.41.1-alpha", manifest_version: 3, name: "TangiTweak" }),
        getURL: (p: string) => `chrome-extension://${EXT_ID}/${p}`,
        sendMessage: (...a: any[]) => {
            const cb = a[a.length - 1];
            if (typeof cb === "function") cb(undefined);
        },
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        onConnect: { addListener() {} },
    },
    storage: {
        local: {
            get: (k: any, cb?: any) => {
                const out: any = {};
                cb?.(out);
                return Promise.resolve(out);
            },
            set: (_o: any, cb?: any) => {
                cb?.();
                return Promise.resolve();
            },
        },
    },
    tabs: { create() {}, query() {} },
};
(window as any).chrome = chromeShim;
(window as any).browser = chromeShim; // firefox-style alias some scripts use

connectSandbox((msg) => (window.parent as any).postMessage(msg, "*"));

window.addEventListener("message", (event) => {
    // only the host page (the offscreen document embedding this iframe) talks to us
    if (event.source !== window.parent) return;
    void receiveInSandbox(event.data);
});
