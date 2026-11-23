/**
 * `tweak.siteStore`'s source of truth: one valtio proxy per script and name,
 * living in the site's JavaScript world (the page hook, `hook.ts`, MAIN
 * world) for the life of the document. onSite code reads and writes it
 * directly; the script's onPage and onOverlay code see it through mirrors
 * (`siteStoreMirror.ts`) that connect here over window messages (the bridge
 * relays an overlay's as the `site.up` / `site.down` wire ops). In the
 * Editor preview, which has no page, the Editor hosts the overlay's site
 * stores itself and `tangitweak/test` hosts them in the test.
 *
 * A mirror sends {@link SiteUp} messages and gets {@link SiteDown} ones
 * back: it connects with a subscription id and gets a snapshot, then its
 * writes go up as ops and every change (whoever made it) comes down as ops,
 * batched per microtask, with the ids of the writes it now holds.
 *
 * Only JSON fields are shared. Functions and accessors at the top level of
 * `initial` stay local to each context (they are never sent and writes to
 * them are ignored).
 *
 * Everything here is page data: the site can read and rewrite these
 * proxies, and can post any of these messages itself. Mirrors only ever
 * accept JSON from here, for subscriptions they made.
 *
 * @module
 */

import { proxy, subscribe } from "valtio/vanilla";
import type { Json, StoreOp } from "./wire";
import { applyOps, badPath, badValue, isPlainObject, missingOps, STORE_MAX_BYTES, jsonBytes } from "./storeOps";
import { isLocalField, splitInitial, toJson } from "./storeView";

/**
 * A message from a mirror (onPage or onOverlay code's `tweak.siteStore`) to
 * the site's world, which {@link SiteStoreHost.receive} handles. Strings must
 * be non-empty and shorter than 512 characters; a message that doesn't check
 * out is ignored.
 */
export type SiteUp =
    | {
          /** Subscribes to a store, creating it when it's new; answered with `site.snapshot`. */
          kind: "site.connect";
          /** The script's id. */
          s: string;
          /** The store's name, as passed to `tweak.siteStore`. */
          name: string;
          /**
           * The JSON fields of the mirror's `initial` (a plain object). A new
           * store starts from them; an existing one gets the fields it lacks.
           */
          initial: Json;
          /** The subscription's id, chosen by the mirror; reusing it moves it to this store. */
          sub: string;
      }
    | {
          /** Writes to a store; answered by the next `site.ops`, whose `acks` hold `op`. */
          kind: "site.set";
          /** The script's id. */
          s: string;
          /** The store's name. */
          name: string;
          /**
           * The write's id. A store applies an id once (it remembers the last
           * 64), so a mirror can resend after reconnecting.
           */
          op: string;
          /** The changes, applied in order; invalid ones and writes to local fields are skipped. */
          ops: StoreOp[];
      }
    | {
          /** Ends a subscription (the script or the context went away). */
          kind: "site.disconnect";
          /** The subscription's id. */
          sub: string;
      };

/**
 * A message from the site's world to mirrors, posted through the host's
 * `post`. Anyone on the page can post these too: a mirror reads only those for
 * its own subscriptions and only their JSON.
 */
export type SiteDown =
    | {
          /**
           * The store's JSON fields, answering a `site.connect`. Changes queued
           * before it are posted first, so the snapshot already holds them.
           */
          kind: "site.snapshot";
          /** The subscription it answers. */
          sub: string;
          /** The store's JSON fields (a plain object). */
          value: Json;
      }
    | {
          /**
           * What changed since the last message, sent to every subscriber of the
           * store once per microtask, with the writes it now holds.
           */
          kind: "site.ops";
          /** The subscription it's for. */
          sub: string;
          /** The changes, in order (empty when only `acks` are new). */
          ops: StoreOp[];
          /** The `op` ids of the `site.set` messages (from any subscriber) these changes include. */
          acks: string[];
      }
    | {
          /** The site's world (re)started (the hook posts it once set up): mirrors that connected before it connect again. */
          kind: "site.ready";
      };

/** The `kind`s of {@link SiteUp}, to tell its messages from other window messages. */
export const SITE_UP_KINDS = new Set(["site.connect", "site.set", "site.disconnect"]);
/** The `kind`s of {@link SiteDown}, to tell its messages from other window messages. */
export const SITE_DOWN_KINDS = new Set(["site.snapshot", "site.ops", "site.ready"]);

/**
 * Writes a line to a script's log (the extension's LOG panel), for warnings
 * such as a store value mirrors can't see.
 *
 * @param scriptId - The script the store belongs to.
 */
export type SiteLog = (scriptId: string, msg: string, level: "info" | "warn" | "error") => void;

interface HostStore {
    s: string;
    name: string;
    proxy: Record<string, any>;
    subs: Set<string>;
    batch: StoreOp[];
    acks: string[];
    queued: boolean;
    /** recent op ids applied (a mirror that resends after a reconnect) */
    seen: string[];
    warned: boolean;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 512;

/**
 * The site stores of one document: every script's `tweak.siteStore`s and the
 * mirrors subscribed to them. The page hook (MAIN world) holds one for the
 * document's life; the Editor preview holds one per overlay frame.
 */
export class SiteStoreHost {
    private readonly stores = new Map<string, HostStore>();
    private readonly subs = new Map<string, HostStore>();

    /**
     * Makes an empty host. Call {@link SiteStoreHost.ready} once the world is
     * set up.
     *
     * @param o - Where messages go and where warnings are logged.
     */
    constructor(
        private readonly o: {
            /** Posts a message to the mirrors (the hook: `window.postMessage`). */
            post: (m: SiteDown) => void;
            /** Logs a warning for a script; without it, warnings are dropped. */
            log?: SiteLog;
        }
    ) {}

    /** Posts `site.ready`, so mirrors that connected before this world was ready connect again. */
    ready(): void {
        this.o.post({ kind: "site.ready" });
    }

    /**
     * `tweak.siteStore(name, initial)` in script `s`'s onSite code: the same
     * proxy on every run. When the store exists, the JSON fields `initial` adds
     * are added and its local fields (top-level functions and accessors) are
     * defined again.
     *
     * @throws TypeError when a field of `initial` isn't JSON (and isn't a
     * function or accessor).
     */
    store(s: string, name: string, initial: object): object {
        const t = splitInitial(name, initial, "tweak.siteStore");
        const st = this.get(s, name, t.json);
        for (const [k, d] of t.local) Object.defineProperty(st.proxy, k, { ...d, configurable: true });
        return st.proxy;
    }

    /**
     * Handles a {@link SiteUp} message from a mirror (or from the page: it's
     * page data either way). Malformed messages and `site.set` for a store
     * nobody created are ignored. Values that aren't JSON are skipped. A store
     * past `STORE_MAX_BYTES` of JSON is kept and warned about once.
     */
    receive(m: any): void {
        if (!m || typeof m !== "object") return;
        if (m.kind === "site.connect") {
            if (!str(m.s) || !str(m.name) || !str(m.sub) || !isPlainObject(m.initial) || badValue(m.initial)) return;
            const st = this.get(m.s, m.name, m.initial);
            const was = this.subs.get(m.sub);
            if (was && was !== st) was.subs.delete(m.sub);
            // what's queued goes out first: the snapshot already holds it
            this.flush(st);
            st.subs.add(m.sub);
            this.subs.set(m.sub, st);
            this.o.post({ kind: "site.snapshot", sub: m.sub, value: this.data(st) });
            return;
        }
        if (m.kind === "site.set") {
            if (!str(m.s) || !str(m.name) || !str(m.op) || !Array.isArray(m.ops)) return;
            const st = this.stores.get(keyOf(m.s, m.name));
            if (!st) return;
            if (!st.seen.includes(m.op)) {
                st.seen.push(m.op);
                if (st.seen.length > 64) st.seen.shift();
                const ok = (m.ops as unknown[]).filter((op): op is StoreOp => this.validOp(st, op));
                if (ok.length) applyOps(st.proxy as Json, ok);
                if (jsonBytes(this.data(st)) > STORE_MAX_BYTES) this.warn(st, `over ${STORE_MAX_BYTES / 1024 / 1024} MB`);
            }
            st.acks.push(m.op);
            this.queue(st);
            return;
        }
        if (m.kind === "site.disconnect") {
            if (!str(m.sub)) return;
            this.subs.get(m.sub)?.subs.delete(m.sub);
            this.subs.delete(m.sub);
        }
    }

    private get(s: string, name: string, json: Json): HostStore {
        const key = keyOf(s, name);
        const have = this.stores.get(key);
        if (have) {
            // a newer `initial` (the script was saved): its new fields are added
            const add = missingOps(this.data(have), json);
            if (add.length) applyOps(have.proxy as Json, add);
            return have;
        }
        const p = proxy(isPlainObject(json) ? JSON.parse(JSON.stringify(json)) : {}) as Record<string, any>;
        const st: HostStore = { s, name, proxy: p, subs: new Set(), batch: [], acks: [], queued: false, seen: [], warned: false };
        subscribe(p, (ops) => this.onOps(st, ops as any[]), true);
        this.stores.set(key, st);
        return st;
    }

    private validOp(st: HostStore, op: unknown): boolean {
        if (!Array.isArray(op) || (op[0] !== "set" && op[0] !== "del") || badPath(op[1])) return false;
        if (op[1].length === 1 && isLocalField(st.proxy, String(op[1][0]))) return false;
        return op[0] === "del" || (op.length === 3 && badValue(op[2]) === null);
    }

    /** the store's JSON fields (what mirrors see) */
    private data(st: HostStore): Json {
        const out: Record<string, Json> = {};
        for (const k of Object.keys(st.proxy)) {
            if (isLocalField(st.proxy, k)) continue;
            const v = st.proxy[k];
            if (v === undefined) continue;
            try {
                out[k] = toJson(v);
            } catch (why) {
                this.warn(st, `${k}: ${why}`);
            }
        }
        return out;
    }

    private onOps(st: HostStore, ops: any[]): void {
        for (const op of ops) {
            const [kind, path] = op as [string, PropertyKey[]];
            if (!Array.isArray(path) || path.some((k) => typeof k === "symbol")) continue;
            const keys = path as string[];
            if (keys.length === 1 && isLocalField(st.proxy, keys[0])) continue;
            const v = op[2];
            if (kind === "delete" || (kind === "set" && v === undefined)) {
                if (!(typeof v === "function" && keys.length === 1)) st.batch.push(["del", keys]);
            } else if (kind === "set" && !(typeof v === "function" && keys.length === 1)) {
                try {
                    st.batch.push(["set", keys, toJson(v)]);
                } catch (why) {
                    this.warn(st, `${keys.join(".")}: ${why}`);
                }
            }
        }
        this.queue(st);
    }

    private queue(st: HostStore): void {
        if (st.queued) return;
        st.queued = true;
        queueMicrotask(() => this.flush(st));
    }

    private flush(st: HostStore): void {
        st.queued = false;
        const ops = st.batch;
        const acks = st.acks;
        st.batch = [];
        st.acks = [];
        if (!ops.length && !acks.length) return;
        for (const sub of st.subs) this.o.post({ kind: "site.ops", sub, ops, acks });
    }

    private warn(st: HostStore, why: string): void {
        if (st.warned) return;
        st.warned = true;
        this.o.log?.(st.s, `tweak.siteStore() ${st.name}: ${why} — onPage and onOverlay code only see JSON values (plain objects, arrays, strings, numbers, booleans, null)`, "warn");
    }
}

const keyOf = (s: string, name: string) => `${s}\u0000${name}`;
