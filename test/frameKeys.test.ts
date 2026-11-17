// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { endpointPair } from "../src/shared/wire";
import { FrameKeyOffers, FrameKeyWatch, claimToken, FRAME_CLAIM } from "../src/shared/frameKeys";
import { FrameShortcuts } from "../src/shared/shortcut";
import { serveFrameKeyClaims, serveFrameKeyOffers, setFrameParent, frameKeyGrants } from "../src/background/engine/frameKeys";

const tick = () => new Promise((r) => setTimeout(r, 30));
const TAB = 7;

/** a frame tree for the background's check: child → parent */
const tree: Record<number, number> = { 0: -1, 3: 0, 4: 3, 5: 4, 9: 0 };
setFrameParent(async (tabId, frameId) => (tabId === TAB ? tree[frameId] : undefined));

/** a frame's link to the background: [frame side, background side] */
function frameLink(frameId: number, child = false) {
    const [ep, bg] = endpointPair();
    serveFrameKeyOffers(bg, TAB, frameId);
    if (child) serveFrameKeyClaims({ tabId: TAB, frameId, ep: bg });
    return ep;
}

const pressIn = (w: Window) => {
    const W = w as any;
    const e = new W.KeyboardEvent("keydown", { key: "k", code: "KeyK", altKey: true, bubbles: true, cancelable: true });
    w.document.body.dispatchEvent(e);
    return e as KeyboardEvent;
};

describe("cross-origin iframe shortcuts", () => {
    afterEach(() => (document.body.innerHTML = ""));

    /** parent frame 3 offering into an iframe; child frame `childId` claiming with the posted token */
    async function setup(childId = 4, opts: { frameIdOf?: (el: HTMLIFrameElement) => number } = {}) {
        const el = document.createElement("iframe");
        el.srcdoc = "<body>x</body>";
        document.body.append(el);
        await tick();
        const childWin = el.contentWindow!;
        const posted: string[] = [];
        vi.spyOn(childWin, "postMessage").mockImplementation((m: any) => void posted.push(m[FRAME_CLAIM]));
        const parent = frameLink(3);
        const child = frameLink(childId, true);
        const holds: boolean[] = [];
        const offers = new FrameKeyOffers(async () => parent, opts.frameIdOf, (on) => holds.push(on));
        parent.on("frameKeys.hit", (a) => offers.hit(a.token));
        const watch = new FrameKeyWatch(childWin, (token) => child.push("frameKeys.hit", { token }), { mac: false, trusted: () => true });
        child.on("frameKeys.watch", (a) => watch.add(a.token, a.keys, a.priority));
        child.on("frameKeys.unwatch", (a) => watch.remove(a.token));
        const claim = async () => {
            child.push("frameKeys.claim", { token: posted[posted.length - 1] });
            await tick();
        };
        return { el, childWin, posted, parent, child, offers, watch, holds, claim };
    }

    it("watches the keys in a child the background checked, and runs fn in the parent", async () => {
        const t = await setup();
        let n = 0;
        const off = t.offers.watch(t.el, "Alt+K", "before-page", () => n++);
        await tick();
        expect(t.posted).toHaveLength(1);
        await t.claim();
        const e = pressIn(t.childWin);
        expect(e.defaultPrevented).toBe(true);
        await tick();
        expect(n).toBe(1);
        expect(t.holds).toEqual([true]);
        // gone: the child stops watching, and the grant with it
        off();
        await tick();
        expect(t.watch.size).toBe(0);
        expect(pressIn(t.childWin).defaultPrevented).toBe(false);
        expect(t.holds).toEqual([true, false]);
        expect(frameKeyGrants()).toBe(0);
    });

    it("a nested child counts (the frame tree goes through the parent)", async () => {
        const t = await setup(5);
        t.offers.watch(t.el, "Alt+K", "before-page", () => {});
        await tick();
        await t.claim();
        expect(t.watch.size).toBe(1);
        t.parent.close("done");
        await tick();
    });

    it("refuses a frame outside the parent, an unknown token, and Firefox frame ids that don't match", async () => {
        const t = await setup(9);
        t.offers.watch(t.el, "Alt+K", "before-page", () => {});
        await tick();
        await t.claim();
        expect(t.watch.size).toBe(0);
        t.child.push("frameKeys.claim", { token: "0".repeat(32) });
        await tick();
        expect(t.watch.size).toBe(0);
        t.parent.close("done");

        const ff = await setup(4, { frameIdOf: () => 5 });
        ff.offers.watch(ff.el, "Alt+K", "before-page", () => {});
        await tick();
        await ff.claim();
        expect(ff.watch.size).toBe(0);
        ff.parent.close("done");
        await tick();
    });

    it("offers again on each load, and when the parent's link is new", async () => {
        const t = await setup();
        t.offers.watch(t.el, "Alt+K", "before-page", () => {});
        await tick();
        t.el.dispatchEvent(new Event("load"));
        await tick();
        expect(t.posted).toHaveLength(2);
        t.offers.relink();
        await tick();
        expect(t.posted).toHaveLength(3);
        // the parent's link closing drops its grants: the child stops
        await t.claim();
        expect(t.watch.size).toBe(1);
        t.parent.close("gone");
        await tick();
        expect(t.watch.size).toBe(0);
    });

    it("a hit from a frame that didn't claim the token goes nowhere", async () => {
        const t = await setup();
        let n = 0;
        t.offers.watch(t.el, "Alt+K", "before-page", () => n++);
        await tick();
        const other = frameLink(9, true);
        other.push("frameKeys.hit", { token: t.posted[0] });
        await tick();
        expect(n).toBe(0);
        t.parent.close("done");
        await tick();
    });

    it("ctx.shortcut offers only with crossOrigin, for the iframes the selector picks", async () => {
        const a = document.createElement("iframe");
        a.className = "embed";
        const b = document.createElement("iframe");
        document.body.append(a, b);
        await tick();
        const watched: HTMLIFrameElement[] = [];
        const offers = { watch: (el: HTMLIFrameElement) => (watched.push(el), () => watched.splice(watched.indexOf(el), 1)) } as unknown as FrameKeyOffers;
        const h = new FrameShortcuts(window, { mac: false, name: (s) => s, error: () => {}, warn: () => {}, trusted: () => true, offers });
        const ac = new AbortController();
        h.add("a", "Alt+K", () => {}, { iframes: true }, ac.signal);
        expect(watched).toEqual([]);
        h.add("a", "Alt+J", () => {}, { iframes: { selector: "iframe.embed", crossOrigin: true } }, ac.signal);
        expect(watched).toEqual([a]);
        a.remove();
        await tick();
        expect(watched).toEqual([]);
        ac.abort();
        h.stop();
    });
});

describe("claimToken", () => {
    const msg = (source: any, data: any = { [FRAME_CLAIM]: "t" }) => ({ source, data }) as MessageEvent;

    it("takes a claim from an ancestor of a frame whose parent is cross-origin", () => {
        const top: any = {};
        top.top = top;
        top.parent = top;
        const parent: any = { top, parent: top };
        const crossParent = new Proxy(parent, {
            get: (o, k) => {
                if (k === "document") throw new DOMException("cross-origin", "SecurityError");
                return o[k];
            },
        });
        const win: any = { top, parent: crossParent };
        expect(claimToken(msg(crossParent), win)).toBe("t");
        expect(claimToken(msg(top), win)).toBe("t");
        expect(claimToken(msg({}), win)).toBe(null);
        expect(claimToken(msg(crossParent, { other: 1 }), win)).toBe(null);
        // a same-origin parent listens in this frame itself
        const sameParent: any = { top, parent: top, document: { documentElement: {} } };
        expect(claimToken(msg(sameParent), { top, parent: sameParent } as any)).toBe(null);
        // the top frame has no parent to claim for
        expect(claimToken(msg(top), top)).toBe(null);
    });
});
