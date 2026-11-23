/**
 * Calls between one script's onSite, onPage and onOverlay code through the
 * handles `tweak.onSite`, `tweak.onPage` and `tweak.onOverlay` return
 * (`await page.highlight("a")`, `overlay.picked(tag)`).
 *
 * Used by the overlay runtime (the overlay frame), the bridge (isolated
 * world, which also routes the overlay's calls), MV3's isolated onPage
 * world (`chrome.userScripts`), the page hook (MAIN world, for onSite code),
 * the Editor preview and `tangitweak/test`. Between contexts the messages
 * travel as the `rpc.call` / `rpc.result` and `iso.call` / `iso.result` wire
 * ops or as window messages between the bridge and the hook.
 *
 * The caller side is an {@link RpcClient}: each handle is a Proxy whose
 * properties are async functions. A handle is named after its handler's
 * registration order (`"onSite:0"` is the script's first `tweak.onSite`
 * call, `"onOverlay:1"` its second `tweak.onOverlay` one). A call sends an
 * {@link RpcCall} and waits, with no time limit, for the {@link RpcResult}
 * with the same `cid`. When the caller's run ends first, the call rejects
 * with {@link AbortError} and a cancel (the same `cid`, `fn` =
 * {@link CANCEL_FN}) goes the same way, so the callee drops it.
 *
 * The callee side is an {@link Exposer}: a handler's return value is what
 * it exposes (a plain object's own functions; anything else exposes
 * nothing). Until the handler has returned, calls queue (at most
 * {@link RPC_QUEUE_MAX} per handle), also across a reload of the script. A
 * handler that won't run here (its route didn't match, it threw) answers
 * {@link NOT_RUNNING}. A call still running when the script reloads rejects
 * with {@link ReloadedError} (call again: the new run answers).
 *
 * Arguments and results must be JSON of at most {@link RPC_MAX_BYTES},
 * checked on both sides. A callee's error crosses as its message only.
 *
 * @module
 */

import type { Json } from "./wire";
import { badValue, isPlainObject, jsonBytes } from "./storeOps";

/**
 * How many calls may wait for one handle before they are refused.
 *
 * Applies to an {@link Exposer}'s queue per handle (until its handler
 * returns), to its queue of calls for handles not registered yet and to the
 * bridge's queue of calls for an overlay that hasn't connected. A call over
 * the limit answers right away with a {@link WtCallError} saying too many
 * calls are waiting.
 */
export const RPC_QUEUE_MAX = 100;
/**
 * The largest a call's arguments or result may be, as the length of their
 * JSON text (UTF-16 code units, so 1 MB of ASCII).
 *
 * Too large arguments throw a `TypeError` at the caller
 * ({@link toJsonArgs}). A too large result answers a {@link WtCallError}.
 * {@link isRpcResult} allows 1024 more for the result's own fields.
 */
export const RPC_MAX_BYTES = 1024 * 1024;

/**
 * The error message of a call whose handler isn't running where the call
 * went: its route didn't match, it threw, the script stopped or there is no
 * overlay, bridge or isolated-world code to answer.
 */
export const NOT_RUNNING = "not running on this page";
/**
 * The start of the error message of a call to a function the handler didn't
 * expose (the message goes on with `: <fn>`).
 */
export const NO_SUCH_FUNCTION = "no such function";
/**
 * The error message of every call on an `onOverlay` handle in a subframe: the
 * overlay lives in the top frame only, so other frames get an inert handle.
 */
export const TOP_FRAME_ONLY = "only the top frame can call the overlay";
/**
 * The error message the Editor preview answers an overlay's calls into
 * onPage or onSite handles with: the preview shows the overlay alone.
 */
export const NO_PAGE_IN_PREVIEW = "there's no page in the Editor preview: onPage code doesn't run there";

/**
 * The `fn` of a message that cancels the call with the same `cid`. No
 * function can have this name (it starts with a NUL character).
 */
export const CANCEL_FN = "\u0000cancel";

/**
 * The caller's run ended (the script reloaded or the page navigated) before
 * the answer came. The callee also answers it when it drops a call because
 * its caller gave up.
 */
export class AbortError extends Error {
    /**
     * Makes the error, named `"AbortError"`.
     *
     * @param message - What ended the call, as `<fn>(): <reason>` when raised at the caller.
     */
    constructor(message: string) {
        super(message);
        this.name = "AbortError";
    }
}

/** The callee's script reloaded while the call ran: call again, the new run answers. */
export class ReloadedError extends Error {
    /**
     * Makes the error, named `"ReloadedError"`.
     *
     * @param message - Why the call ended.
     */
    constructor(message: string) {
        super(message);
        this.name = "ReloadedError";
    }
}

/**
 * The callee threw (its message only), has no such function or isn't
 * running. Inert handles (where calls can't go) reject with it too.
 */
export class WtCallError extends Error {
    /**
     * Makes the error, named `"WtCallError"`.
     *
     * @param message - The callee's error message or why the call couldn't be made.
     */
    constructor(message: string) {
        super(message);
        this.name = "WtCallError";
    }
}

/**
 * The other side went away (the overlay reloaded or closed, a link to the
 * extension dropped) before answering. It's also used when the call
 * couldn't be sent.
 */
export class DisconnectedError extends Error {
    /**
     * Makes the error, named `"DisconnectedError"`.
     *
     * @param message - What went away.
     */
    constructor(message: string) {
        super(message);
        this.name = "DisconnectedError";
    }
}

/**
 * A call on a handle, from an {@link RpcClient} to the {@link Exposer} that
 * holds the handle. Anything may arrive over a message channel: check it with
 * {@link isRpcCall}.
 */
export interface RpcCall {
    /** The call's id ({@link newCid}): its result and a cancel carry the same one. */
    cid: string;
    /**
     * The handle's key: its API and registration index, plus `@<library>` for
     * a handler a library registered, e.g. `"onPage:0"` or `"onPage:0@utils/x"`.
     */
    h: string;
    /** The exposed function's name ({@link CANCEL_FN} cancels the call `cid`). */
    fn: string;
    /** The arguments as JSON ({@link toJsonArgs}: an `undefined` argument becomes `null`). */
    args: Json[];
}

/** The answer to one {@link RpcCall}, from the callee back to the caller. */
export interface RpcResult {
    /** The `cid` of the call it answers. */
    cid: string;
    /** Whether the function returned (`value`) rather than failed (`error`). */
    ok: boolean;
    /** The function's result as JSON; absent when it returned `undefined`. */
    value?: Json;
    /** Why the call failed, when `ok` is `false`. */
    error?: {
        /**
         * The error class the caller rejects with: `"WtCallError"`,
         * `"AbortError"`, `"ReloadedError"` or `"DisconnectedError"`. Any
         * other name becomes a {@link WtCallError} ({@link resultError}).
         */
        name: string;
        /** The error's message only (no stack crosses). */
        message: string;
    };
}

/** Makes a random 128-bit call id, as 32 hex digits. */
export function newCid(): string {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Whether `c` is a well-formed {@link RpcCall} (anything may arrive over `postMessage`). It doesn't check the size. */
export function isRpcCall(c: any): c is RpcCall {
    return !!c && typeof c === "object" && typeof c.cid === "string" && typeof c.h === "string" && typeof c.fn === "string" && Array.isArray(c.args);
}

/**
 * Whether `r` is a well-formed {@link RpcResult} within the size limit
 * ({@link RPC_MAX_BYTES} plus 1024 for its own fields). A failed result
 * needs an `error` with a string `message`.
 */
export function isRpcResult(r: any): r is RpcResult {
    if (!r || typeof r !== "object" || typeof r.cid !== "string" || typeof r.ok !== "boolean") return false;
    if (!r.ok && (!r.error || typeof r.error.message !== "string")) return false;
    return jsonBytes(r) <= RPC_MAX_BYTES + 1024;
}

/**
 * Copies a call's arguments as plain JSON, ready to post (a store's object
 * is a Proxy, which can't be posted). An `undefined` argument becomes `null`.
 *
 * @param fn - The called function's name, for the error message.
 * @throws TypeError when an argument isn't JSON or the arguments' JSON is
 * longer than {@link RPC_MAX_BYTES}.
 */
export function toJsonArgs(fn: string, args: unknown[]): Json[] {
    const out = args.map((a) => (a === undefined ? null : a)) as Json[];
    const bad = badValue(out);
    if (bad) throw new TypeError(`${fn}(): arguments must be JSON — ${bad}`);
    const json = JSON.stringify(out);
    if (json.length > RPC_MAX_BYTES) throw new TypeError(`${fn}(): arguments are larger than 1 MB`);
    // a plain copy: a store's object (a Proxy) can't be posted
    return JSON.parse(json);
}

const callError = (message: string): RpcResult["error"] => ({ name: "WtCallError", message });

/**
 * The error a caller rejects with for a failed result: the class its `name`
 * says or a {@link WtCallError} for any other name. A missing message
 * becomes `"error"`.
 */
export function resultError(e: RpcResult["error"]): Error {
    const msg = String(e?.message ?? "error");
    if (e?.name === "DisconnectedError") return new DisconnectedError(msg);
    if (e?.name === "AbortError") return new AbortError(msg);
    if (e?.name === "ReloadedError") return new ReloadedError(msg);
    return new WtCallError(msg);
}

type Pending = { h: string; fn: string; resolve: (v: any) => void; reject: (e: Error) => void; unlisten?: () => void };

/**
 * `e` with the stack of the call that `at` was made at: an error built when
 * a result arrives (a message event) has no frames of the caller's code.
 */
function atCall(e: Error, at: Error): Error {
    const frames = String(at.stack || "").split("\n").slice(1).join("\n");
    if (frames) e.stack = `${e.name}: ${e.message}\n${frames}`;
    return e;
}

/**
 * The caller side of one script's handles in one context: makes handles and
 * keeps the calls waiting for an answer.
 */
export class RpcClient {
    private readonly pending = new Map<string, Pending>();

    /**
     * Makes a client with no calls pending.
     *
     * @param send - Posts a call (or a cancel) toward the callee. When it
     * throws, the call rejects with a {@link DisconnectedError}. Its answer
     * must come back through {@link RpcClient.receive}.
     */
    constructor(private readonly send: (call: RpcCall) => void) {}

    /**
     * Makes the handle for `h`: every string property is a function that
     * calls {@link RpcClient.call}. `then` and `toJSON` are `undefined` (so
     * `await handle` doesn't hang) and setting a property fails.
     *
     * @param h - The handle's key ({@link RpcCall.h}).
     * @param signal - Read at each call: the calling run's signal, whose
     * abort rejects the call with {@link AbortError} and cancels it.
     */
    remote(h: string, signal?: () => AbortSignal | undefined): any {
        return new Proxy(Object.create(null), {
            get: (_t, prop) => {
                // not a thenable (`await handle` must not hang), no symbol methods
                if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
                return (...args: unknown[]) => this.call(h, prop, args, signal?.());
            },
            set: () => false,
        });
    }

    /**
     * Calls `fn` on handle `h` and resolves with its result. It waits with no
     * time limit.
     *
     * The promise rejects with a {@link WtCallError} (the callee failed),
     * {@link AbortError} (`signal` aborted, already or later, which also
     * cancels the call), {@link ReloadedError} or {@link DisconnectedError}
     * (also when `send` throws). The error carries the stack of this call.
     *
     * @throws TypeError right here when the arguments aren't JSON or are too
     * large ({@link toJsonArgs}).
     */
    call(h: string, fn: string, args: unknown[], signal?: AbortSignal): Promise<any> {
        const json = toJsonArgs(fn, args);
        if (signal?.aborted) return Promise.reject(new AbortError(`${fn}(): ${abortReason(signal)}`));
        const cid = newCid();
        const at = new Error();
        return new Promise((resolve, reject) => {
            const p: Pending = { h, fn, resolve, reject: (e) => reject(atCall(e, at)) };
            if (signal) {
                const onAbort = () => this.cancel(cid, abortReason(signal));
                signal.addEventListener("abort", onAbort);
                p.unlisten = () => signal.removeEventListener("abort", onAbort);
            }
            this.pending.set(cid, p);
            try {
                this.send({ cid, h, fn, args: json });
            } catch (e: any) {
                this.pending.delete(cid);
                p.unlisten?.();
                reject(new DisconnectedError(`${fn}(): ${e?.message || e}`));
            }
        });
    }

    /**
     * The caller's run ended: rejects the pending calls (all or those whose
     * handle `which` accepts) with {@link AbortError} and sends a cancel for
     * each.
     *
     * @param reason - Ends each error's message, after `<fn>(): `.
     */
    abort(reason: string, which?: (h: string) => boolean): void {
        for (const [cid, p] of [...this.pending]) if (!which || which(p.h)) this.cancel(cid, reason);
    }

    private cancel(cid: string, reason: string): void {
        const p = this.pending.get(cid);
        if (!p) return;
        this.pending.delete(cid);
        p.unlisten?.();
        p.reject(new AbortError(`${p.fn}(): ${reason}`));
        try {
            this.send({ cid, h: p.h, fn: CANCEL_FN, args: [] });
        } catch {}
    }

    /**
     * Settles the call a result answers. Malformed results and unknown or
     * already settled `cid`s are ignored.
     *
     * @returns Whether the result settled one of this client's calls.
     */
    receive(r: unknown): boolean {
        if (!isRpcResult(r)) return false;
        const p = this.pending.get(r.cid);
        if (!p) return false;
        this.pending.delete(r.cid);
        p.unlisten?.();
        if (r.ok) p.resolve(r.value);
        else p.reject(resultError(r.error));
        return true;
    }

    /**
     * Rejects the pending calls (all or those whose handle `which` accepts)
     * with a {@link DisconnectedError} whose message is `reason`. No cancel is
     * sent: the other side is gone.
     */
    disconnect(reason: string, which?: (h: string) => boolean): void {
        for (const [cid, p] of this.pending) {
            if (which && !which(p.h)) continue;
            this.pending.delete(cid);
            p.unlisten?.();
            p.reject(new DisconnectedError(reason));
        }
    }
}

function abortReason(signal: AbortSignal): string {
    const r = signal.reason;
    return typeof r === "string" ? r : r instanceof Error && r.name !== "AbortError" ? r.message : "the calling run ended";
}

/** the call whose function is running right now (synchronously): its signal aborts on cancel or reload */
let running: AbortSignal | undefined;
/**
 * The signal of the call whose exposed function is running, read in that
 * function's synchronous part (`undefined` elsewhere). It aborts when the
 * caller gives up (cancels) or the callee's script reloads.
 */
export function callSignal(): AbortSignal | undefined {
    return running;
}

/** Sends the result of one call back toward its caller. */
type Reply = (r: RpcResult) => void;
type Slot = { state: "pending"; queue: [RpcCall, Reply][] } | { state: "ready"; obj: Record<string, any> | null } | { state: "not-running"; why: string };

/**
 * The callee side: one script's handles in one context, which answers the
 * calls made on them. Its owner registers each handler, then reports what it
 * returned ({@link Exposer.expose}) or that it won't run
 * ({@link Exposer.fail}).
 */
export class Exposer {
    private readonly slots = new Map<string, Slot>();
    /** the ready handles before the last `reset` (a failed reload goes back to them) */
    private prev = new Map<string, Slot>();
    /** calls for handles not registered yet (the script hasn't compiled) */
    private early: [RpcCall, Reply][] = [];
    private settled = false;
    /** calls whose function is running (its promise pending) */
    private readonly inflight = new Map<string, { reply: Reply; ctl: AbortController }>();

    /** A handler registered `h`: its calls queue until {@link Exposer.expose} or {@link Exposer.fail} (a waiting queue is kept). */
    register(h: string): void {
        const old = this.slots.get(h);
        this.slots.set(h, { state: "pending", queue: old?.state === "pending" ? old.queue : [] });
    }

    /**
     * The handler of `h` returned `value` (awaited when it's a thenable; a
     * rejection counts as {@link Exposer.fail}). A plain object exposes its
     * own functions; anything else exposes nothing. Waiting calls are
     * answered now.
     */
    expose(h: string, value: unknown): void {
        if (value && typeof (value as any).then === "function") {
            (value as Promise<unknown>).then(
                (v) => this.expose(h, v),
                () => this.fail(h)
            );
            return;
        }
        const obj = isPlainObject(value) ? (value as Record<string, any>) : null;
        this.settle(h, { state: "ready", obj });
    }

    /** The handler of `h` won't answer here (it didn't match, it threw): its calls answer `why`. */
    fail(h: string, why = NOT_RUNNING): void {
        this.settle(h, { state: "not-running", why });
    }

    /**
     * The reload of `h` failed (its handler threw; no `h`: the script didn't
     * compile). Each handle answers from the run that's still alive, when it
     * had one and {@link NOT_RUNNING} otherwise.
     */
    revert(h?: string): void {
        for (const k of h === undefined ? new Set([...this.slots.keys(), ...this.prev.keys()]) : [h]) {
            const p = this.prev.get(k);
            if (p) this.settle(k, p);
            else this.fail(k);
        }
    }

    /** Every handle is registered: calls for unknown handles (waiting or later) answer {@link NOT_RUNNING}. */
    done(): void {
        this.settled = true;
        const early = this.early;
        this.early = [];
        for (const [c, reply] of early) this.answer(c, reply);
    }

    /**
     * The script is recompiling (hot reload): handles register again. Waiting
     * calls wait for the new run; running ones abort their
     * {@link callSignal} and answer {@link ReloadedError}. The ready handles
     * are kept for {@link Exposer.revert}.
     */
    reset(): void {
        this.prev = new Map([...this.slots].filter(([, s]) => s.state === "ready"));
        for (const s of this.slots.values()) if (s.state === "pending") this.early.push(...s.queue);
        this.slots.clear();
        this.settled = false;
        for (const [cid, f] of [...this.inflight]) {
            this.inflight.delete(cid);
            f.ctl.abort("the script reloaded");
            f.reply({ cid, ok: false, error: { name: "ReloadedError", message: "the script reloaded while the call ran: call again" } });
        }
    }

    /**
     * The script stopped here (disabled, deleted, the page went away): running
     * calls answer {@link ReloadedError}; waiting and later ones answer `why`.
     */
    close(why = NOT_RUNNING): void {
        this.reset();
        this.prev.clear();
        for (const [c, reply] of this.early.splice(0)) reply({ cid: c.cid, ok: false, error: callError(why) });
        this.settled = true;
    }

    /** Whether `h` is registered here (in any state). */
    has(h: string): boolean {
        return this.slots.has(h);
    }

    /**
     * Answers a call through `reply`, now or once its handler has returned. A
     * {@link CANCEL_FN} call drops the call it names (waiting or running) and
     * answers {@link AbortError} in its place.
     */
    answer(c: RpcCall, reply: Reply): void {
        if (c.fn === CANCEL_FN) return this.cancel(c, reply);
        const slot = this.slots.get(c.h);
        if (!slot) {
            if (this.settled) return reply({ cid: c.cid, ok: false, error: callError(NOT_RUNNING) });
            if (this.early.length >= RPC_QUEUE_MAX) return reply({ cid: c.cid, ok: false, error: callError(`${c.fn}(): too many calls waiting for the page`) });
            this.early.push([c, reply]);
            return;
        }
        if (slot.state === "not-running") return reply({ cid: c.cid, ok: false, error: callError(slot.why) });
        if (slot.state === "pending") {
            if (slot.queue.length >= RPC_QUEUE_MAX) return reply({ cid: c.cid, ok: false, error: callError(`${c.fn}(): too many calls waiting for the handler to return`) });
            slot.queue.push([c, reply]);
            return;
        }
        const obj = slot.obj;
        const fn = obj && Object.prototype.hasOwnProperty.call(obj, c.fn) ? obj[c.fn] : undefined;
        if (typeof fn !== "function") return reply({ cid: c.cid, ok: false, error: callError(`${NO_SUCH_FUNCTION}: ${c.fn}`) });
        const ctl = new AbortController();
        let out: unknown;
        const outer = running;
        running = ctl.signal;
        try {
            out = fn.apply(obj, c.args);
        } catch (e: any) {
            return reply({ cid: c.cid, ok: false, error: callError(errorMessage(e)) });
        } finally {
            running = outer;
        }
        const f = { reply, ctl };
        this.inflight.set(c.cid, f);
        const done = (r: RpcResult) => {
            if (this.inflight.get(c.cid) !== f) return;
            this.inflight.delete(c.cid);
            reply(r);
        };
        Promise.resolve(out).then(
            (v) => done(okResult(c, v)),
            (e) => done({ cid: c.cid, ok: false, error: callError(errorMessage(e)) })
        );
    }

    /** the caller gave up on call `c.cid`: drop it (queued or running) and answer AbortError, which also clears relays */
    private cancel(c: RpcCall, reply: Reply): void {
        const drop = (q: [RpcCall, Reply][]) => {
            const i = q.findIndex(([x]) => x.cid === c.cid);
            if (i >= 0) q.splice(i, 1);
        };
        drop(this.early);
        for (const s of this.slots.values()) if (s.state === "pending") drop(s.queue);
        const f = this.inflight.get(c.cid);
        if (f) {
            this.inflight.delete(c.cid);
            f.ctl.abort("the caller gave up");
        }
        reply({ cid: c.cid, ok: false, error: { name: "AbortError", message: "the caller gave up" } });
    }

    private settle(h: string, next: Slot): void {
        const old = this.slots.get(h);
        this.slots.set(h, next);
        if (old?.state === "pending") for (const [c, reply] of old.queue) this.answer(c, reply);
    }
}

function errorMessage(e: any): string {
    return String(e && typeof e === "object" && "message" in e ? e.message : e);
}

function okResult(c: RpcCall, v: unknown): RpcResult {
    if (v === undefined) return { cid: c.cid, ok: true };
    const bad = badValue(v);
    if (bad) return { cid: c.cid, ok: false, error: callError(`${c.fn}(): the result must be JSON — ${bad}`) };
    const json = JSON.stringify(v);
    if (json.length > RPC_MAX_BYTES) return { cid: c.cid, ok: false, error: callError(`${c.fn}(): the result is larger than 1 MB`) };
    return { cid: c.cid, ok: true, value: JSON.parse(json) };
}
