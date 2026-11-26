/**
 * Page-origin storage, cookie, IndexedDB and blob bridge for `tweak.site`.
 * Runs in the content-script bridge (which shares the real website's origin)
 * and answers L3 `origin.*` requests from the custom-site frame.
 */
import type { ReqOf, ResOf } from "./wire";

function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

/** Handle a `localStorage` or `sessionStorage` operation on the real page origin. */
export function handleOriginStorage(req: ReqOf<"origin.storage">): ResOf<"origin.storage"> {
    const store = req.area === "session" ? window.sessionStorage : window.localStorage;
    switch (req.op) {
        case "get":
            return { value: typeof req.key === "string" ? store.getItem(req.key) : null };
        case "set":
            if (typeof req.key === "string") store.setItem(req.key, String(req.value ?? ""));
            return {};
        case "remove":
            if (typeof req.key === "string") store.removeItem(req.key);
            return {};
        case "clear":
            store.clear();
            return {};
        case "keys":
            return { keys: Object.keys(store) };
        default:
            throw new Error(`origin.storage: unknown op "${String((req as any).op)}"`);
    }
}

function parseCookies(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw) return out;
    for (const part of raw.split(";")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        const rawKey = eq < 0 ? trimmed : trimmed.slice(0, eq);
        const rawVal = eq < 0 ? "" : trimmed.slice(eq + 1);
        let key = rawKey;
        let val = rawVal;
        try {
            key = decodeURIComponent(rawKey);
        } catch {}
        try {
            val = decodeURIComponent(rawVal);
        } catch {}
        out[key] = val;
    }
    return out;
}

/** Handle a `document.cookie` operation on the real page origin. */
export function handleOriginCookie(req: ReqOf<"origin.cookie">): ResOf<"origin.cookie"> {
    switch (req.op) {
        case "all":
            return { all: parseCookies(document.cookie || "") };
        case "get": {
            const all = parseCookies(document.cookie || "");
            const key = typeof req.key === "string" ? req.key : "";
            return { value: Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null };
        }
        case "set": {
            if (typeof req.key !== "string" || !req.key) throw new Error("origin.cookie: key required");
            const opts = req.opts || {};
            const parts = [`${encodeURIComponent(req.key)}=${encodeURIComponent(String(req.value ?? ""))}`];
            parts.push(`path=${opts.path || "/"}`);
            if (typeof opts.maxAge === "number" && Number.isFinite(opts.maxAge)) parts.push(`max-age=${Math.trunc(opts.maxAge)}`);
            if (typeof opts.expires === "string" && opts.expires) parts.push(`expires=${opts.expires}`);
            if (typeof opts.domain === "string" && opts.domain) parts.push(`domain=${opts.domain}`);
            if (opts.sameSite) parts.push(`samesite=${opts.sameSite}`);
            if (opts.secure) parts.push("secure");
            document.cookie = parts.join("; ");
            return {};
        }
        case "remove": {
            if (typeof req.key !== "string" || !req.key) throw new Error("origin.cookie: key required");
            const opts = req.opts || {};
            const parts = [`${encodeURIComponent(req.key)}=`, "max-age=0", "expires=Thu, 01 Jan 1970 00:00:00 GMT", `path=${opts.path || "/"}`];
            if (typeof opts.domain === "string" && opts.domain) parts.push(`domain=${opts.domain}`);
            document.cookie = parts.join("; ");
            return {};
        }
        default:
            throw new Error(`origin.cookie: unknown op "${String((req as any).op)}"`);
    }
}

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
}

function openExistingIdb(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error(`IndexedDB open failed for "${name}"`));
        req.onblocked = () => reject(new Error(`IndexedDB open blocked for "${name}"`));
    });
}

/** Handle an IndexedDB operation on the real page origin. */
export async function handleOriginIdb(req: ReqOf<"origin.idb">): Promise<ResOf<"origin.idb">> {
    if (req.op === "databases") {
        if (typeof (indexedDB as any).databases !== "function") return { databases: [] };
        const dbs = (await (indexedDB as any).databases()) as { name?: string; version?: number }[];
        return { databases: dbs.filter((d) => typeof d.name === "string").map((d) => ({ name: d.name!, version: d.version ?? 0 })) };
    }
    if (typeof req.db !== "string" || !req.db) throw new Error("origin.idb: db name required");
    const db = await openExistingIdb(req.db);
    try {
        if (req.op === "stores") {
            return { stores: Array.from(db.objectStoreNames) };
        }
        if (typeof req.store !== "string" || !req.store) throw new Error("origin.idb: store name required");
        const mode: IDBTransactionMode = req.op === "get" || req.op === "getAll" ? "readonly" : "readwrite";
        const tx = db.transaction(req.store, mode);
        const store = tx.objectStore(req.store);
        let value: any;
        switch (req.op) {
            case "get":
                value = await idbReq(store.get(req.key));
                return { value };
            case "getAll":
                value = await idbReq(store.getAll(undefined, typeof req.limit === "number" ? req.limit : undefined));
                return { value };
            case "put":
                await idbReq(req.key !== undefined ? store.put(req.value, req.key) : store.put(req.value));
                return {};
            case "delete":
                await idbReq(store.delete(req.key));
                return {};
            case "clear":
                await idbReq(store.clear());
                return {};
            default:
                throw new Error(`origin.idb: unknown op "${String((req as any).op)}"`);
        }
    } finally {
        db.close();
    }
}

/** Fetch a same-origin or `blob:` resource in the real page context and return base64 bytes. */
export async function handleOriginBlob(req: ReqOf<"origin.blob">): Promise<ResOf<"origin.blob">> {
    if (typeof req.url !== "string" || !req.url) throw new Error("origin.blob: url required");
    const abs = new URL(req.url, location.href).href;
    const res = await fetch(abs, { credentials: "include" });
    if (!res.ok) throw new Error(`origin.blob: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { mime: res.headers.get("content-type") || "application/octet-stream", base64: bytesToBase64(buf) };
}
