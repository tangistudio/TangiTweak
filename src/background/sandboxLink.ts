/**
 * How the background reaches the sandbox (src/background/sandboxCore.ts),
 * the only context that may eval:
 *
 *   Chrome:  background ⇄ chrome.runtime ⇄ offscreen.ts ⇄ postMessage ⇄ sandbox.ts
 *   Firefox: the same, with offscreen.html framed by the event page
 *            (there's no chrome.offscreen)
 *
 * Unit tests run the sandbox in-process instead (test/inProcessSandbox.ts):
 * `globalThis.__ttSandboxLink` makes the link.
 */
import { packBytes, unpackBytes } from "../shared/bytesPack";
import { watchCall } from "../shared/callWatch";

export interface SandboxLink {
    /** one call into the sandbox: its result, or a rejection when the call is lost */
    call(payload: any): Promise<any>;
    /** the host exists and answers (`force`: a fresh one) */
    ensure(force?: boolean): Promise<void>;
    /** tear the host down */
    close(): Promise<void>;
    /** an L1 wire message to the sandbox's store hub */
    wire(msg: any): void;
}

/** what the background answers the sandbox with */
export interface SandboxServer {
    /** an L1 wire message from the sandbox's store hub */
    wire?(msg: any): void;
    /** a reverse call: storage, logging, param writes */
    reverse?(payload: any): Promise<any>;
}

const server: SandboxServer = {};
let current: SandboxLink | null = null;

export function sandboxLink(): SandboxLink {
    return (current ??= (globalThis as any).__ttSandboxLink?.(server) ?? offscreenLink(server));
}

/** Answer the sandbox's wire messages or reverse calls. */
export function serveSandbox(part: SandboxServer): void {
    Object.assign(server, part);
}

/** Firefox: no chrome.offscreen, so the event page frames the sandbox host itself */
const HOST_FRAME_ID = "tt-sandbox-host";

function offscreenLink(server: SandboxServer): SandboxLink {
    chrome.runtime.onMessage.addListener((msg: any, _s, sendResponse) => {
        if (msg?.type === "__resWire") {
            server.wire?.(unpackBytes(msg.msg));
            return false;
        }
        if (msg?.type !== "__resReverse" || !server.reverse) return false;
        server.reverse(msg.payload || {}).then(
            (r) => sendResponse(r ?? {}),
            () => sendResponse({})
        );
        return true;
    });

    let seq = 0;
    // unique across background restarts: the offscreen document may outlive us
    const epoch = Math.random().toString(36).slice(2, 10);

    const call = (payload: any): Promise<any> =>
        new Promise((resolve, reject) => {
            const reqId = `sw_${epoch}_${++seq}`;
            // no time limit while the offscreen document says the call is still
            // running (a handler may wait for the user): only lost calls fail
            const watch = watchCall({
                checkMs: 20000,
                graceMs: 5000,
                ask: () =>
                    chrome.runtime.sendMessage({ type: "__resSandboxAlive?", reqId }, (r: any) => {
                        if (!chrome.runtime.lastError && r?.alive) watch.alive();
                    }),
                onLost: () => reject(new Error("sandbox RPC timeout")),
            });
            // chrome.runtime messaging is JSON: body bytes travel packed (offscreen.ts unpacks them)
            const packed = payload?.args ? { ...payload, args: packBytes(payload.args) } : payload;
            chrome.runtime.sendMessage({ type: "__resSandbox", reqId, extId: chrome.runtime.id, payload: packed }, (resp: any) => {
                watch.stop();
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                resolve(unpackBytes(resp));
            });
        });

    let readyPromise: Promise<void> | null = null;

    /** the offscreen document (the sandbox host) exists AND its listener answers */
    const ensure = (force = false): Promise<void> => {
        const runtime = chrome.runtime as any;
        if (!force && readyPromise) return readyPromise;
        readyPromise = (async () => {
            if (__FIREFOX__) {
                if (force || !document.getElementById(HOST_FRAME_ID)) {
                    document.getElementById(HOST_FRAME_ID)?.remove();
                    const frame = document.createElement("iframe");
                    frame.id = HOST_FRAME_ID;
                    frame.src = "offscreen.html";
                    document.body.appendChild(frame);
                }
            } else {
                if (!force && runtime.getContexts) {
                    const ctx = await runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
                    if (ctx && ctx.length) return;
                }
                await new Promise<void>((resolve) => {
                    (chrome as any).offscreen.createDocument(
                        {
                            url: "offscreen.html",
                            reasons: ["IFRAME_SCRIPTING"],
                            justification: "Compile and run user scripts in the MV3 sandbox (eval is forbidden in service workers)",
                        },
                        () => {
                            void chrome.runtime.lastError;
                            resolve();
                        }
                    );
                });
            }
            // readiness ping: the offscreen listener must actually answer (the
            // document loads html + script + a sandbox iframe; a blind fixed
            // sleep raced it and corrupted first saves)
            for (let i = 0; i < 25; i++) {
                try {
                    await call({ op: "ping" });
                    return;
                } catch {
                    await new Promise((r) => setTimeout(r, 200));
                }
            }
            throw new Error("sandbox host not ready");
        })().finally(() => {
            readyPromise = null;
        });
        return readyPromise;
    };

    const close = async (): Promise<void> => {
        if (__FIREFOX__) document.getElementById(HOST_FRAME_ID)?.remove();
        else
            await new Promise<void>((resolve) => {
                (chrome as any).offscreen.closeDocument(() => {
                    void chrome.runtime.lastError;
                    resolve();
                });
            });
    };

    const wire = (msg: any): void => {
        chrome.runtime.sendMessage({ type: "__resSandboxWire", msg: packBytes(msg) }, () => void chrome.runtime.lastError);
    };

    return { call, ensure, close, wire };
}
