/**
 * Unit tests run the sandbox (src/background/sandboxCore.ts) in-process:
 * the same messages offscreen.ts relays, structured-cloned as postMessage
 * does and delivered on microtasks (tests may fake the timers).
 *
 * One sandbox per link: `vi.resetModules()` gives the background a fresh
 * sandboxLink module, and its link imports a fresh sandbox.
 */
import type { SandboxLink, SandboxServer } from "../src/background/sandboxLink";

function inProcessLink(server: SandboxServer): SandboxLink {
    const pending = new Map<string, (r: any) => void>();
    let seq = 0;
    const later = (f: () => void) => queueMicrotask(f);

    const core = import("../src/background/sandboxCore").then((m) => {
        m.connectSandbox((raw) => {
            const data = structuredClone(raw);
            later(() => {
                if (data.kind === "sandboxResult") {
                    pending.get(data.reqId)?.(data.result);
                    pending.delete(data.reqId);
                } else if (data.kind === "wire") {
                    server.wire?.(data.msg);
                } else if (data.kind === "reverse") {
                    void (server.reverse?.(data) ?? Promise.resolve({})).then(
                        (r) => toSandbox({ kind: "reverseResult", reqId: data.reqId, result: r || null }),
                        () => toSandbox({ kind: "reverseResult", reqId: data.reqId, result: null })
                    );
                }
            });
        });
        return m;
    });

    const toSandbox = (msg: any) => {
        const data = structuredClone(msg);
        void core.then((m) => later(() => void m.receiveInSandbox(data)));
    };

    return {
        call: (payload) =>
            new Promise((resolve) => {
                const reqId = `t_${++seq}`;
                pending.set(reqId, resolve);
                toSandbox({ kind: "sandboxCall", reqId, payload });
            }),
        ensure: async () => {
            await core;
        },
        close: async () => {},
        wire: (msg) => toSandbox({ kind: "wire", msg }),
    };
}

(globalThis as any).__ttSandboxLink = inProcessLink;
