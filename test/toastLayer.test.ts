// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createToastLayer, foldOrder, lookVars, nearestCorner, stackOf, type ToastLayer } from "../src/hook/toastLayer";
import type { ToastView } from "../src/shared/toast";

const view = (o: Partial<ToastView> = {}): ToastView => ({
    id: "a",
    key: "s1:a",
    kind: "info",
    title: "Price dropped",
    message: "Now 12 €",
    duration: 6000,
    where: "active",
    ttl: 3_600_000,
    attention: "tab",
    source: "Price watch",
    look: {},
    position: "bottom-right",
    userCorner: false,
    signals: { titleFlash: true, iconDot: true },
    createdAt: Date.now(),
    ...o,
} as ToastView);

let root: HTMLElement;
let sent: { op: string; a: any }[];
let layer: ToastLayer;
let hidden = false;

beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    root = document.createElement("div");
    document.body.appendChild(root);
    sent = [];
    layer = createToastLayer({ root: () => root, send: (op: string, a: any) => void sent.push({ op, a }) } as any);
});
afterEach(() => {
    layer.destroy();
    root.remove();
    vi.useRealTimers();
});

const slots = () => [...root.querySelectorAll<HTMLElement>(".slot")];
const inside = (slot: HTMLElement) => (slot as any).__tt as ShadowRoot;
const partOf = (slot: HTMLElement, name: string) => inside(slot).querySelector<HTMLElement>(`[part=${name}]`);

describe("toast layer", () => {
    it("draws the parts as text", () => {
        layer.show(view({ title: "<b>hi</b>", actions: [{ id: "open", label: "Open" }] }));
        const [s] = slots();
        expect(partOf(s, "title")!.textContent).toBe("<b>hi</b>");
        expect(partOf(s, "title")!.children.length).toBe(0);
        expect(partOf(s, "message")!.textContent).toBe("Now 12 €");
        expect(partOf(s, "source")!.textContent).toBe("from Price watch");
        expect(partOf(s, "action")!.textContent).toBe("Open");
        expect(root.querySelector('.stack[data-pos="bottom-right"]')).not.toBeNull();
    });

    it("puts the tweak's css before its own rules", () => {
        layer.show(view({ look: { css: "[part=toast]{margin:40px}" } }));
        const css = inside(slots()[0]).querySelector("style")!.textContent!;
        expect(css.indexOf("margin:40px")).toBeLessThan(css.indexOf("margin:0!important"));
    });

    it("replaces a toast with the same key in place", () => {
        layer.show(view());
        const first = slots()[0];
        layer.show(view({ title: "Again" }));
        expect(slots()).toEqual([first]);
        expect(partOf(first, "title")!.textContent).toBe("Again");
    });

    it("folds past three into a pill and opens it", () => {
        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(1);
            layer.show(view({ key: `s1:${i}`, id: `${i}` }));
        }
        expect(slots().length).toBe(3);
        const pill = root.querySelector<HTMLButtonElement>(".pill")!;
        expect(pill.textContent).toBe("+2 more");
        pill.click();
        expect(slots().length).toBe(5);
        expect(root.querySelector(".pill")!.textContent).toBe("Show less");
    });

    it("keeps errors and sticky toasts when folding", () => {
        const mk = (n: number, o: Partial<ToastView> = {}) => ({ view: view({ key: `k${n}`, ...o }), at: n });
        const { shown, folded } = foldOrder([mk(1, { kind: "error" }), mk(2, { duration: "sticky" }), mk(3), mk(4), mk(5)]);
        expect(shown.map((t) => t.view.key)).toEqual(["k5", "k2", "k1"]);
        expect(folded.map((t) => t.view.key)).toEqual(["k4", "k3"]);
    });

    it("sends close and Esc with closed: true and removes the toast", () => {
        layer.show(view());
        partOf(slots()[0], "close")!.click();
        expect(sent).toEqual([{ op: "toast.event", a: { key: "s1:a", actionId: "close", closed: true } }]);
        expect(layer.keys()).toEqual([]);
        layer.show(view({ key: "s1:b" }));
        partOf(slots()[0], "toast")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(sent[1].a).toEqual({ key: "s1:b", actionId: "close", closed: true });
    });

    it("sends an action's id and a click on a link toast", () => {
        layer.show(view({ actions: [{ id: "buy", label: "Buy" }] }));
        partOf(slots()[0], "action")!.click();
        expect(sent[0].a).toEqual({ key: "s1:a", actionId: "buy", closed: true });
        layer.show(view({ key: "s1:u", url: "https://example.com/" }));
        partOf(slots()[0], "toast")!.click();
        expect(sent[1].a).toEqual({ key: "s1:u", actionId: "click", closed: true });
    });

    it("times out into the pill and pauses on hover", () => {
        layer.show(view({ duration: 1000 }));
        const s = slots()[0];
        vi.advanceTimersByTime(500);
        s.dispatchEvent(new Event("pointerenter"));
        vi.advanceTimersByTime(5000);
        expect(sent).toEqual([]);
        s.dispatchEvent(new Event("pointerleave"));
        vi.advanceTimersByTime(499);
        expect(sent).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(sent).toEqual([{ op: "toast.event", a: { key: "s1:a", actionId: "timeout" } }]);
        expect(slots().length).toBe(0);
        expect(root.querySelector(".pill")!.textContent).toBe("+1 more");
        expect(layer.keys()).toEqual(["s1:a"]);
    });

    it("waits while the tab is hidden and flashes the title until it's back", () => {
        document.title = "Shop";
        hidden = true;
        layer.show(view({ duration: 1000 }));
        expect(document.title).toBe("● New from Price watch");
        vi.advanceTimersByTime(1500);
        expect(document.title).toBe("(1) Shop");
        vi.advanceTimersByTime(10_000);
        expect(sent).toEqual([]);
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
        expect(document.title).toBe("Shop");
        vi.advanceTimersByTime(1000);
        expect(sent[0].a.actionId).toBe("timeout");
    });

    it("doesn't flash for attention: none", () => {
        document.title = "Shop";
        hidden = true;
        layer.show(view({ attention: "none" }));
        expect(document.title).toBe("Shop");
    });
});

describe("toast panes", () => {
    let panes: { key: string; el: HTMLElement }[];
    let updates: ToastView[];
    let removed: string[];
    beforeEach(() => {
        layer.destroy();
        panes = [];
        updates = [];
        removed = [];
        layer = createToastLayer({
            root: () => root,
            send: (op: string, a: any) => void sent.push({ op, a }),
            pane: (v: ToastView) => {
                const el = document.createElement("div");
                panes.push({ key: v.key, el });
                return el;
            },
            paneUpdate: (v: ToastView) => void updates.push(v),
            paneRemoved: (key: string) => void removed.push(key),
        } as any);
    });

    it("keeps the pane's frame when the toast shows again, and draws the new data in it", () => {
        layer.show(view({ pane: "price", data: { p: 1 } }));
        layer.show(view({ id: "b", key: "s1:b" }));
        layer.show(view({ pane: "price", data: { p: 2 } }));
        expect(panes.length).toBe(1);
        expect(panes[0].el.isConnected).toBe(true);
        expect(updates.map((v) => v.data)).toEqual([{ p: 2 }]);
        expect(removed).toEqual([]);
    });

    it("falls back to the default toast when the pane fails, and stays default", () => {
        layer.show(view({ pane: "price" }));
        layer.paneFailed("s1:a");
        const [s] = slots();
        expect(removed).toEqual(["s1:a"]);
        expect(partOf(s, "title")!.textContent).toBe("Price dropped");
        layer.show(view({ pane: "price" }));
        expect(panes.length).toBe(1);
    });

    it("pane actions leave the toast open; close and keepOpen work", () => {
        layer.show(view({ pane: "price" }));
        layer.paneAction("s1:a", "buy", 3);
        expect(sent).toContainEqual({ op: "toast.event", a: { key: "s1:a", actionId: "buy", value: 3 } });
        layer.paneKeepOpen("s1:a");
        vi.advanceTimersByTime(60_000);
        expect(sent.some((x) => x.a.actionId === "timeout")).toBe(false);
        layer.paneClose("s1:a");
        expect(layer.keys()).toEqual([]);
        expect(removed).toEqual(["s1:a"]);
    });
});

describe("toast placement", () => {
    it("stacks by width", () => {
        expect(stackOf("top-left", 500)).toBe("bottom-center");
        expect(stackOf("top-center", 900)).toBe("top-right");
        expect(stackOf("bottom-center", 1600)).toBe("bottom-center");
        expect(stackOf("top-left", 900)).toBe("top-left");
    });
    it("finds the nearest corner", () => {
        expect(nearestCorner(10, 10, 1200, 800)).toBe("top-left");
        expect(nearestCorner(600, 700, 1200, 800)).toBe("bottom-center");
        expect(nearestCorner(1100, 500, 1200, 800)).toBe("bottom-right");
    });
    it("derives dark colors from a light-only look", () => {
        const v = lookVars({ background: "#fef", radius: 4 }, "success");
        expect(v.light).toContain("--tt-bg:#fef");
        expect(v.light).toContain("--tt-radius:4px");
        expect(v.dark).toContain("--tt-bg:#fef");
        expect(v.dark).toContain("--tt-accent:#3fb950");
        expect(lookVars({ background: "#fff", dark: { background: "#000" } }, "info").dark).toContain("--tt-bg:#000");
    });
});
