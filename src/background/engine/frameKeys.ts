/**
 * Background side of cross-origin iframe shortcuts (shared/frameKeys.ts):
 * holds each parent frame's offers, checks a claiming child frame really
 * sits under that parent, then relays its key presses back.
 */
import type { Endpoint } from "../../shared/wire";

interface Grant {
    tabId: number;
    /** the parent frame */
    frameId: number;
    parent: Endpoint;
    keys: string;
    priority: "before-page" | "after-page";
    /** Firefox: the child frameId the parent read itself */
    child?: number;
    /** the child bridge watching now */
    claimed?: Endpoint;
}

export interface ChildLink {
    tabId: number;
    frameId: number;
    ep: Endpoint;
}

/** the frame's parentFrameId (-1: top; undefined: unknown) */
export type FrameParent = (tabId: number, frameId: number) => Promise<number | undefined>;

const grants = new Map<string, Grant>();

const chromeFrameParent: FrameParent = async (tabId, frameId) => {
    const wn = (globalThis as any).chrome?.webNavigation;
    if (!wn?.getFrame) return undefined;
    try {
        const f = await wn.getFrame({ tabId, frameId });
        return typeof f?.parentFrameId === "number" ? f.parentFrameId : undefined;
    } catch {
        return undefined;
    }
};

let frameParent: FrameParent = chromeFrameParent;

/** tests: stand in for webNavigation.getFrame */
export function setFrameParent(fn: FrameParent | null): void {
    frameParent = fn ?? chromeFrameParent;
}

function revoke(token: string): void {
    const g = grants.get(token);
    if (!g) return;
    grants.delete(token);
    if (g.claimed && !g.claimed.closed) g.claimed.push("frameKeys.unwatch", { token });
}

async function isUnder(g: Grant, child: number): Promise<boolean> {
    if (g.child !== undefined) return child === g.child;
    let id = child;
    for (let depth = 0; depth < 32; depth++) {
        const p = await frameParent(g.tabId, id);
        if (p === undefined || p < 0) return false;
        if (p === g.frameId) return true;
        id = p;
    }
    return false;
}

/** a link from a frame that runs shortcuts (a bridge, or MV3 isolated onPage code) */
export function serveFrameKeyOffers(ep: Endpoint, tabId: number, frameId: number): void {
    ep.handle("frameKeys.offer", (a) => {
        const { token, keys, priority, child } = a ?? ({} as any);
        if (
            typeof token !== "string" ||
            !/^[0-9a-f]{32}$/.test(token) ||
            typeof keys !== "string" ||
            !keys ||
            keys.length > 200 ||
            (priority !== "before-page" && priority !== "after-page") ||
            (child !== undefined && (typeof child !== "number" || child <= 0))
        )
            throw new Error("frameKeys.offer: refused");
        const old = grants.get(token);
        if (old && old.parent !== ep) throw new Error("frameKeys.offer: refused");
        grants.set(token, { tabId, frameId, parent: ep, keys, priority, child, claimed: old?.claimed });
        return {};
    });
    ep.on("frameKeys.withdraw", (a) => {
        if (grants.get(a?.token)?.parent === ep) revoke(a.token);
    });
    ep.onClose(() => {
        for (const [token, g] of [...grants]) if (g.parent === ep) revoke(token);
    });
}

/** a bridge link: the frame may be a child some parent posted a token to */
export function serveFrameKeyClaims(link: ChildLink): void {
    const { ep } = link;
    ep.on("frameKeys.claim", async (a) => {
        const token = a?.token;
        const g = typeof token === "string" ? grants.get(token) : undefined;
        if (!g || g.tabId !== link.tabId || g.frameId === link.frameId || g.claimed === ep) return;
        if (!(await isUnder(g, link.frameId))) return;
        if (grants.get(token) !== g || ep.closed || g.parent.closed) return;
        if (g.claimed && !g.claimed.closed) g.claimed.push("frameKeys.unwatch", { token });
        g.claimed = ep;
        ep.push("frameKeys.watch", { token, keys: g.keys, priority: g.priority });
    });
    ep.on("frameKeys.hit", (a) => {
        const g = grants.get(a?.token);
        if (g?.claimed === ep && !g.parent.closed) g.parent.push("frameKeys.hit", { token: a.token });
    });
    ep.onClose(() => {
        for (const g of grants.values()) if (g.claimed === ep) g.claimed = undefined;
    });
}

/** tests */
export function frameKeyGrants(): number {
    return grants.size;
}
