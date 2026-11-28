/**
 * A toast pane drawn in the page instead of an overlay.html frame (the
 * "Debugger-friendly overlays" setting): debugger extensions like
 * Playwriter remove other extensions' frames before they attach, which
 * took the pane with them.
 *
 * The pane draws into a closed shadow root on an element the bridge made,
 * in an isolated world, and talks to the bridge like a pane frame does
 * (the same `hello` with the granted nonce, then the same calls).
 *
 * The background runs it in the script's user-script world (Chrome) with
 * `__ttPaneBoot = { nonce, token }`; it takes the one element tagged
 * `data-tt-pane="token"`, untags it (the bridge checks) and connects a
 * `tt-pane` port, which the background relays to the bridge.
 */
import { startOverlay } from "./overlayRuntime";
import { portEndpoint, type Endpoint } from "../shared/wire";
import { setBuiltinLoader, sourceLoader } from "../shared/builtins";

async function run(ep: Endpoint, nonce: string, host: Element): Promise<void> {
    let stopped = false;
    let stop = () => {};
    ep.on("pane.stop", () => {
        stopped = true;
        stop();
        ep.close("stopped");
    });
    try {
        const root = host.attachShadow({ mode: "closed" });
        const rt = await startOverlay(ep, await ep.call("hello", { nonce }), { win: window as any, doc: document, paneRoot: root, patchFetch: false, watchRects: false });
        stop = rt.stop;
        if (stopped) rt.stop();
    } catch (e: any) {
        if (!ep.closed) ep.push("pane.failed", { why: `didn't start: ${e?.message || e}` });
    }
}

const g = globalThis as any;
const boot = g.__ttPaneBoot;
delete g.__ttPaneBoot;
const hosts = typeof boot?.token === "string" ? document.querySelectorAll(`tangitweak-pane[data-tt-pane="${CSS.escape(boot.token)}"]`) : [];
if (hosts.length === 1 && typeof boot.nonce === "string") {
    const host = hosts[0];
    host.removeAttribute("data-tt-pane");
    const port = chrome.runtime.connect({ name: "tt-pane" });
    port.postMessage({ ttPane: boot.nonce });
    const ep = portEndpoint(port);
    setBuiltinLoader(sourceLoader(() => ep.call("builtin.react", {})));
    void run(ep, boot.nonce, host);
}
