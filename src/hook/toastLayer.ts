/**
 * The toasts in a page: one stack per corner, shared by every tweak, in the
 * bridge's closed shadow root. Plain DOM, no React, so the bridge stays light.
 *
 * - Each toast sits in a slot TangiTweak lays out (gap, order, slide, edge);
 *   its inside is in a shadow root of its own, so a tweak's `css` styles only
 *   its own toasts and nothing in the page.
 * - Text goes in with `textContent` only.
 * - A toast's timer runs while the tab is visible and the pointer isn't on it
 *   (`attention: "none"` toasts time out hidden too). Timed out or folded
 *   toasts wait in the "+N more" pill.
 * - While the tab is hidden, a new toast flashes the tab title and puts a dot
 *   on the tab icon, until the user comes back.
 *
 * @module
 */
import { TOAST_DEFAULT_DURATION_MS, TOAST_MAX_VISIBLE, TOAST_POSITIONS, TOAST_WIDTH, type ToastKind, type ToastPosition, type ToastStyle, type ToastView } from "../shared/toast";

/** What the layer needs from the bridge. */
export interface ToastLayerHost {
    /** Where the layer goes (the bridge's shadow root). */
    root(): ShadowRoot | HTMLElement;
    /** Tells the background (`toast.event`, `toast.corner`). */
    send(op: "toast.event", a: { key: string; actionId: string; value?: unknown; closed?: boolean }): void;
    send(op: "toast.corner", a: { host: string; position: ToastPosition | null }): void;
    /** Draws a pane toast's inside, or null to show the default toast. */
    pane?(view: ToastView, slot: HTMLElement): HTMLElement | null;
}

export interface ToastLayer {
    show(view: ToastView): void;
    dismiss(key: string): void;
    /** Toasts on screen or waiting in a pill. */
    keys(): string[];
    destroy(): void;
}

const KIND_ACCENT: Record<ToastKind, { light: string; dark: string }> = {
    info: { light: "#0b6bcb", dark: "#4493f8" },
    success: { light: "#1a7f37", dark: "#3fb950" },
    warning: { light: "#9a6700", dark: "#d29922" },
    error: { light: "#c62828", dark: "#f85149" },
};
const KIND_ICON: Record<ToastKind, string> = { info: "i", success: "✓", warning: "!", error: "×" };
const NARROW = 600;
const EDGE = 16;
const GAP = 8;
const FLASH_MS = 1500;

const LAYER_CSS = `
.layer{position:fixed;inset:0;pointer-events:none;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.layer[hidden]{display:none}
.stack{position:absolute;display:flex;gap:${GAP}px;max-height:60vh;pointer-events:none}
.stack[data-v=top]{top:${EDGE}px;flex-direction:column}
.stack[data-v=bottom]{bottom:${EDGE}px;flex-direction:column-reverse}
.stack[data-h=left]{left:${EDGE}px;align-items:flex-start}
.stack[data-h=right]{right:${EDGE}px;align-items:flex-end}
.stack[data-h=center]{left:50%;transform:translateX(-50%);align-items:center}
.stack.narrow{left:${EDGE}px;right:${EDGE}px;transform:none;align-items:stretch}
.stack.open{overflow-y:auto;pointer-events:auto}
.slot{position:relative;pointer-events:auto;overflow:hidden;contain:paint;max-width:calc(100vw - ${2 * EDGE}px);transition:opacity .15s,transform .15s}
.slot.in{opacity:0;transform:translateY(6px)}
.stack[data-v=top] .slot.in{transform:translateY(-6px)}
.pill{pointer-events:auto;align-self:inherit;border:1px solid #d0d7de;background:#fff;color:#1f2328;border-radius:999px;padding:2px 10px;font:inherit;font-size:12px;cursor:pointer}
.pill .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--dot,#0b6bcb)}
.reset{pointer-events:auto;border:0;background:none;color:inherit;font:inherit;font-size:12px;text-decoration:underline;cursor:pointer;padding:0 4px}
.dragging{opacity:.6;cursor:grabbing}
@media (prefers-color-scheme:dark){.pill{background:#1f2328;color:#e6edf3;border-color:#3d444d}}
@media (prefers-reduced-motion:reduce){.slot{transition:none}}
`;

const TOAST_CSS = `
:host{all:initial;display:block}
[part=toast]{box-sizing:border-box;position:relative;display:grid;grid-template-columns:auto 1fr auto;gap:2px 10px;padding:12px 12px 10px 16px;
  background:var(--tt-bg);color:var(--tt-text);border:1px solid var(--tt-border);border-radius:var(--tt-radius);font:14px/1.4 var(--tt-font);overflow:hidden;cursor:default}
[part=toast].link{cursor:pointer}
[part=toast]:focus-visible{outline:2px solid var(--tt-accent);outline-offset:-2px}
.strip{position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--tt-accent)}
.strip.pulse{animation:tt-pulse .6s ease-in-out 2}
[part=icon]{grid-row:1/span 2;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--tt-bg);background:var(--tt-accent);overflow:hidden}
[part=icon].own{background:none;color:inherit;font-size:18px}
[part=icon] img{width:20px;height:20px;object-fit:contain}
[part=title]{font-weight:600;grid-column:2}
[part=message]{grid-column:2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line}
[part=actions]{grid-column:2;display:flex;gap:8px;margin-top:4px}
[part=action]{font:inherit;font-weight:600;color:var(--tt-accent);background:none;border:0;padding:2px 0;cursor:pointer}
[part=close]{grid-column:3;grid-row:1;font:inherit;font-size:16px;line-height:1;color:inherit;opacity:.6;background:none;border:0;padding:2px 4px;cursor:pointer}
[part=close]:hover,[part=close]:focus-visible{opacity:1}
[part=source]{grid-column:2;font-size:12px;opacity:.65;cursor:grab;user-select:none}
[part=progress]{position:absolute;left:0;bottom:0;height:2px;width:100%;background:var(--tt-accent);opacity:.5;transform-origin:left;animation:tt-progress var(--tt-ms) linear forwards;animation-play-state:paused}
[part=progress].run{animation-play-state:running}
.pane{grid-column:1/-1;max-height:480px;overflow:auto}
@keyframes tt-progress{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@keyframes tt-pulse{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.strip.pulse{animation:none}}
`;

/** The CSS custom properties of a look, for light and dark. */
export function lookVars(look: ToastStyle, kind: ToastKind): { light: string; dark: string } {
    const r = look.radius;
    const radius = typeof r === "number" ? `${r}px` : (r ?? "12px");
    const font = look.font ?? `system-ui,-apple-system,"Segoe UI",sans-serif`;
    const light = { accent: look.accent ?? KIND_ACCENT[kind].light, bg: look.background ?? "#ffffff", text: look.text ?? "#1f2328", border: look.border ?? "#d0d7de" };
    const d = look.dark ?? {};
    const dark = {
        accent: d.accent ?? (look.accent ? light.accent : KIND_ACCENT[kind].dark),
        bg: d.background ?? (look.background && !look.dark ? light.bg : "#1f2328"),
        text: d.text ?? (look.text && !look.dark ? light.text : "#e6edf3"),
        border: d.border ?? (look.border && !look.dark ? light.border : "#3d444d"),
    };
    const dr = d.radius === undefined ? radius : typeof d.radius === "number" ? `${d.radius}px` : d.radius;
    const vars = (c: typeof light, rad: string, f: string) => `--tt-accent:${c.accent};--tt-bg:${c.bg};--tt-text:${c.text};--tt-border:${c.border};--tt-radius:${rad};--tt-font:${f}`;
    return { light: vars(light, radius, font), dark: vars(dark, dr, d.font ?? font) };
}

/** The width of a toast, clamped. */
export const toastWidth = (look: ToastStyle): number => Math.min(TOAST_WIDTH.max, Math.max(TOAST_WIDTH.min, look.width ?? TOAST_WIDTH.default));

/** The stack a toast goes to in a viewport `width` px wide. */
export function stackOf(position: ToastPosition, width: number): ToastPosition {
    if (width < NARROW) return "bottom-center";
    // no room for three stacks side by side: the center one joins the right
    if (position.endsWith("center") && width < 3 * TOAST_WIDTH.default + 4 * EDGE) return position.startsWith("top") ? "top-right" : "bottom-right";
    return position;
}

/** The corner nearest to a point in a `w` × `h` viewport. */
export function nearestCorner(x: number, y: number, w: number, h: number): ToastPosition {
    const v = y < h / 2 ? "top" : "bottom";
    const hz = x < w / 3 ? "left" : x > (2 * w) / 3 ? "right" : "center";
    return `${v}-${hz}` as ToastPosition;
}

/** Which toasts of a stack show and which fold: newest first; errors and sticky ones fold last. */
export function foldOrder<T extends { view: ToastView; at: number }>(items: T[], max = TOAST_MAX_VISIBLE): { shown: T[]; folded: T[] } {
    const newest = [...items].sort((a, b) => b.at - a.at);
    if (newest.length <= max) return { shown: newest, folded: [] };
    const keep = (t: T) => t.view.kind === "error" || t.view.duration === "sticky";
    const shown = [...newest.filter(keep), ...newest.filter((t) => !keep(t))].slice(0, max);
    return { shown: newest.filter((t) => shown.includes(t)), folded: newest.filter((t) => !shown.includes(t)) };
}

interface Item {
    view: ToastView;
    at: number;
    slot: HTMLElement;
    progress: HTMLElement | null;
    strip: HTMLElement | null;
    /** ms left on its timer (Infinity: sticky) */
    left: number;
    started: number | null;
    timer: ReturnType<typeof setTimeout> | null;
    hover: boolean;
    /** It timed out: it waits in the pill. */
    missed: boolean;
}

export function createToastLayer(h: ToastLayerHost, win: Window = window): ToastLayer {
    const doc = win.document;
    const items = new Map<string, Item>();
    const open = new Set<ToastPosition>();
    let layer: HTMLElement | null = null;
    let unseen: Item[] = [];

    function ensureLayer(): HTMLElement {
        const root = h.root();
        if (layer && layer.parentNode === root) return layer;
        layer = doc.createElement("div");
        layer.className = "layer";
        const style = doc.createElement("style");
        style.textContent = LAYER_CSS;
        root.appendChild(style);
        root.appendChild(layer);
        return layer;
    }

    const visible = () => doc.visibilityState !== "hidden" && !doc.fullscreenElement;

    // ── the timer ────────────────────────────────────────────────────────
    const shouldRun = (it: Item) => !it.missed && it.left !== Infinity && !it.hover && (visible() || it.view.attention === "none");
    function tick(it: Item): void {
        const run = shouldRun(it);
        if (run && it.started === null) {
            it.started = Date.now();
            it.timer = setTimeout(() => timeOut(it), it.left);
        } else if (!run && it.started !== null) {
            it.left = Math.max(0, it.left - (Date.now() - it.started));
            it.started = null;
            if (it.timer) clearTimeout(it.timer);
            it.timer = null;
        }
        it.progress?.classList.toggle("run", run);
    }
    function timeOut(it: Item): void {
        it.timer = null;
        it.started = null;
        it.missed = true;
        h.send("toast.event", { key: it.view.key, actionId: "timeout" });
        layout();
    }

    // ── one toast ────────────────────────────────────────────────────────
    function build(view: ToastView, prev?: Item): Item {
        const slot = prev?.slot ?? doc.createElement("div");
        slot.className = "slot";
        slot.dataset.key = view.key;
        slot.style.width = `${toastWidth(view.look)}px`;
        const shadow = (slot as any).__tt ?? ((slot as any).__tt = slot.attachShadow({ mode: "closed" }));
        shadow.textContent = "";
        const vars = lookVars(view.look, view.kind);
        const style = doc.createElement("style");
        const ms = view.duration === "sticky" ? 0 : view.duration;
        // the tweak's css first: TangiTweak's layout rules after it win
        style.textContent = `${view.look.css ?? ""}\n${TOAST_CSS}\n:host{${vars.light};--tt-ms:${ms}ms}\n@media (prefers-color-scheme:dark){:host{${vars.dark}}}\n[part=toast]{margin:0!important;position:relative!important;transform:none!important;z-index:auto!important}`;
        shadow.appendChild(style);
        const box = doc.createElement("div");
        box.setAttribute("part", "toast");
        box.setAttribute("role", view.kind === "error" ? "alert" : "status");
        box.tabIndex = 0;
        if (view.url) box.classList.add("link");
        const strip = doc.createElement("div");
        strip.className = "strip";
        box.appendChild(strip);
        const pane = view.pane ? h.pane?.(view, slot) ?? null : null;
        if (pane) {
            pane.classList.add("pane");
            box.appendChild(pane);
        } else {
            box.appendChild(iconOf(view));
            if (view.title) box.appendChild(part("div", "title", view.title));
            if (view.message || !view.title) box.appendChild(part("div", "message", view.message ?? ""));
            if (view.actions?.length) {
                const row = part("div", "actions");
                for (const a of view.actions) {
                    const b = part("button", "action", a.label) as HTMLButtonElement;
                    b.type = "button";
                    b.addEventListener("click", (e) => {
                        e.stopPropagation();
                        act(view.key, a.id, undefined, true);
                    });
                    row.appendChild(b);
                }
                box.appendChild(row);
            }
        }
        const close = part("button", "close", "×") as HTMLButtonElement;
        close.type = "button";
        close.setAttribute("aria-label", "Close");
        close.addEventListener("click", (e) => {
            e.stopPropagation();
            act(view.key, "close", undefined, true);
        });
        box.appendChild(close);
        const source = part("div", "source", `from ${view.source}`);
        source.title = "Drag to move toasts on this site";
        source.addEventListener("pointerdown", (e) => drag(e as PointerEvent, view.key));
        source.addEventListener("click", (e) => e.stopPropagation());
        box.appendChild(source);
        let progress: HTMLElement | null = null;
        if (view.duration !== "sticky") {
            progress = part("div", "progress");
            box.appendChild(progress);
        }
        box.addEventListener("click", () => {
            if (view.url) act(view.key, "click", undefined, true);
        });
        box.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                act(view.key, "close", undefined, true);
            } else if (e.key === "Enter" && e.target === box && view.url) act(view.key, "click", undefined, true);
        });
        shadow.appendChild(box);
        const it: Item = {
            view,
            at: prev?.at ?? Date.now(),
            slot,
            progress,
            strip,
            left: view.duration === "sticky" ? Infinity : (view.duration ?? TOAST_DEFAULT_DURATION_MS),
            started: null,
            timer: null,
            hover: prev?.hover ?? false,
            missed: false,
        };
        if (!prev) {
            slot.addEventListener("pointerenter", () => {
                const cur = items.get(slot.dataset.key!);
                if (cur) (cur.hover = true), tick(cur);
            });
            slot.addEventListener("pointerleave", () => {
                const cur = items.get(slot.dataset.key!);
                if (cur) (cur.hover = false), tick(cur);
            });
        }
        return it;
    }

    function part(tag: string, name: string, text?: string): HTMLElement {
        const el = doc.createElement(tag);
        el.setAttribute("part", name);
        if (text !== undefined) el.textContent = text;
        return el;
    }

    function iconOf(view: ToastView): HTMLElement {
        const el = part("div", "icon");
        el.setAttribute("aria-hidden", "true");
        if (view.icon === false) {
            el.style.display = "none";
            return el;
        }
        const own = typeof view.icon === "string" ? view.icon : "";
        if (/^(https?:|data:image\/)/.test(own)) {
            el.classList.add("own");
            const img = doc.createElement("img");
            img.alt = "";
            img.src = own;
            img.addEventListener("error", () => {
                el.classList.remove("own");
                el.textContent = KIND_ICON[view.kind];
            });
            el.appendChild(img);
        } else if (own) {
            el.classList.add("own");
            el.textContent = own.slice(0, 8);
        } else el.textContent = KIND_ICON[view.kind];
        return el;
    }

    function act(key: string, actionId: string, value: unknown, closes: boolean): void {
        const it = items.get(key);
        if (!it) return;
        h.send("toast.event", { key, actionId, ...(value !== undefined ? { value } : {}), ...(closes ? { closed: true } : {}) });
        if (closes) remove(key);
    }

    function remove(key: string): void {
        const it = items.get(key);
        if (!it) return;
        if (it.timer) clearTimeout(it.timer);
        items.delete(key);
        it.slot.remove();
        unseen = unseen.filter((u) => u.view.key !== key);
        layout();
        signals();
    }

    // ── stacks ───────────────────────────────────────────────────────────
    function layout(): void {
        const root = ensureLayer();
        root.hidden = !!doc.fullscreenElement;
        const width = win.innerWidth;
        const groups = new Map<ToastPosition, Item[]>();
        for (const it of items.values()) {
            const p = stackOf(it.view.position, width);
            groups.set(p, [...(groups.get(p) ?? []), it]);
        }
        for (const el of [...root.children]) if (!groups.has((el as HTMLElement).dataset.pos as ToastPosition)) el.remove();
        for (const [pos, list] of groups) {
            let stack = root.querySelector<HTMLElement>(`.stack[data-pos="${pos}"]`);
            if (!stack) {
                stack = doc.createElement("div");
                stack.className = "stack";
                stack.dataset.pos = pos;
                [stack.dataset.v, stack.dataset.h] = pos.split("-");
                root.appendChild(stack);
            }
            stack.classList.toggle("narrow", width < NARROW);
            const isOpen = open.has(pos);
            stack.classList.toggle("open", isOpen);
            const live = list.filter((t) => !t.missed);
            const { shown, folded } = isOpen ? { shown: [...list].sort((a, b) => b.at - a.at), folded: [] as Item[] } : foldOrder(live);
            const waiting = isOpen ? 0 : folded.length + list.filter((t) => t.missed).length;
            const kids: HTMLElement[] = shown.map((t) => t.slot);
            if (waiting || isOpen) kids.push(pillFor(pos, waiting, list));
            stack.replaceChildren(...kids);
            for (const t of list) {
                if (isOpen && t.missed) {
                    // opened again: it stays until closed
                    t.missed = false;
                    t.left = Infinity;
                    t.progress?.remove();
                    t.progress = null;
                }
                tick(t);
            }
        }
    }

    function pillFor(pos: ToastPosition, waiting: number, list: Item[]): HTMLElement {
        const wrap = doc.createElement("div");
        const pill = doc.createElement("button");
        pill.type = "button";
        pill.className = "pill";
        if (waiting) {
            const dot = doc.createElement("span");
            dot.className = "dot";
            const newest = [...list].sort((a, b) => b.at - a.at)[0];
            dot.style.setProperty("--dot", newest?.view.look.accent ?? KIND_ACCENT[newest?.view.kind ?? "info"].light);
            pill.append(dot, `+${waiting} more`);
        } else pill.textContent = "Show less";
        pill.addEventListener("click", () => {
            if (open.has(pos)) open.delete(pos);
            else open.add(pos);
            layout();
        });
        wrap.appendChild(pill);
        if (open.has(pos) && list.some((t) => t.view.userCorner)) {
            const reset = doc.createElement("button");
            reset.type = "button";
            reset.className = "reset";
            reset.textContent = "Reset position";
            reset.addEventListener("click", () => {
                h.send("toast.corner", { host: win.location.host, position: null });
                for (const t of items.values()) if (t.view.userCorner) t.view = { ...t.view, position: t.view.style?.position ?? t.view.look.position ?? "bottom-right", userCorner: false };
                open.clear();
                layout();
            });
            wrap.appendChild(reset);
        }
        return wrap;
    }

    // dragging a toast's "from" line moves every toast on this site to the corner it's dropped nearest to
    function drag(e: PointerEvent, key: string): void {
        if (e.button !== 0) return;
        const it = items.get(key);
        if (!it) return;
        e.preventDefault();
        const x0 = e.clientX;
        const y0 = e.clientY;
        const stack = it.slot.parentElement;
        const move = (m: PointerEvent) => {
            stack?.classList.add("dragging");
            if (stack) stack.style.translate = `${m.clientX - x0}px ${m.clientY - y0}px`;
        };
        const up = (u: PointerEvent) => {
            win.removeEventListener("pointermove", move);
            win.removeEventListener("pointerup", up);
            if (stack) {
                stack.classList.remove("dragging");
                stack.style.translate = "";
            }
            if (Math.abs(u.clientX - x0) + Math.abs(u.clientY - y0) < 8) return;
            const position = nearestCorner(u.clientX, u.clientY, win.innerWidth, win.innerHeight);
            h.send("toast.corner", { host: win.location.host, position });
            for (const t of items.values()) t.view = { ...t.view, position, userCorner: true };
            layout();
        };
        win.addEventListener("pointermove", move);
        win.addEventListener("pointerup", up);
    }

    // ── waiting signals (the tab title and icon, while hidden) ──────────
    let pageTitle: string | null = null;
    let flashTimer: ReturnType<typeof setInterval> | null = null;
    let flashOn = false;
    let ours = new Set<string>();
    let dotIcon: HTMLLinkElement | null = null;
    let titleWatch: MutationObserver | null = null;

    function setTitle(t: string): void {
        ours.add(t);
        doc.title = t;
    }

    function signals(): void {
        const flash = unseen.filter((u) => u.view.signals.titleFlash);
        const dot = unseen.filter((u) => u.view.signals.iconDot);
        if (flash.length && !visible()) {
            if (pageTitle === null) {
                pageTitle = doc.title;
                // the page changes its own title meanwhile: keep its text under our prefix
                titleWatch = new MutationObserver(() => {
                    if (!ours.has(doc.title)) pageTitle = doc.title;
                });
                const t = doc.querySelector("title");
                if (t) titleWatch.observe(t, { childList: true, characterData: true, subtree: true });
            }
            const show = () => {
                const newest = flash[flash.length - 1];
                flashOn = !flashOn;
                ours = new Set();
                setTitle(flashOn ? `● New from ${newest.view.source}` : `(${flash.length}) ${pageTitle}`);
            };
            if (flashTimer) clearInterval(flashTimer);
            show();
            flashTimer = setInterval(show, FLASH_MS);
        } else stopFlash();
        if (dot.length && !visible()) void showDot(dot[dot.length - 1].view.look.accent ?? KIND_ACCENT[dot[dot.length - 1].view.kind].light);
        else hideDot();
    }

    function stopFlash(): void {
        if (flashTimer) clearInterval(flashTimer);
        flashTimer = null;
        titleWatch?.disconnect();
        titleWatch = null;
        if (pageTitle !== null) {
            if (ours.has(doc.title)) doc.title = pageTitle;
            pageTitle = null;
        }
        ours = new Set();
    }

    async function showDot(color: string): Promise<void> {
        if (dotIcon) return;
        const canvas = doc.createElement("canvas");
        canvas.width = canvas.height = 32;
        const g = canvas.getContext?.("2d");
        if (!g) return;
        const src = doc.querySelector<HTMLLinkElement>('link[rel~="icon"]:not([data-tt])')?.href || `${win.location.origin}/favicon.ico`;
        await new Promise<void>((resolve) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                try {
                    g.drawImage(img, 0, 0, 32, 32);
                } catch {}
                resolve();
            };
            img.onerror = () => resolve();
            img.src = src;
            setTimeout(resolve, 1500);
        });
        g.beginPath();
        g.arc(24, 8, 7, 0, Math.PI * 2);
        g.fillStyle = color;
        g.fill();
        let href: string;
        try {
            href = canvas.toDataURL("image/png");
        } catch {
            return; // a cross-origin icon tainted the canvas: the title says it already
        }
        if (visible() || dotIcon) return;
        dotIcon = doc.createElement("link");
        dotIcon.rel = "icon";
        dotIcon.dataset.tt = "1";
        dotIcon.href = href;
        (doc.head ?? doc.documentElement).appendChild(dotIcon);
    }

    function hideDot(): void {
        dotIcon?.remove();
        dotIcon = null;
    }

    const onVisibility = () => {
        if (visible()) unseen = [];
        for (const it of items.values()) tick(it);
        signals();
    };
    const onFullscreen = () => layout();
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(layout, 100);
    };
    doc.addEventListener("visibilitychange", onVisibility);
    doc.addEventListener("fullscreenchange", onFullscreen);
    win.addEventListener("resize", onResize);

    return {
        show(view) {
            if (!TOAST_POSITIONS.includes(view.position)) view = { ...view, position: "bottom-right" };
            const prev = items.get(view.key);
            if (prev?.timer) clearTimeout(prev.timer);
            const it = build(view, prev);
            items.set(view.key, it);
            if (!prev) {
                it.slot.classList.add("in");
                win.requestAnimationFrame?.(() => it.slot.classList.remove("in"));
                if (view.attention !== "none") it.strip?.classList.add("pulse");
            }
            if (!visible() && view.attention !== "none") unseen = [...unseen.filter((u) => u.view.key !== view.key), it];
            layout();
            signals();
        },
        dismiss: remove,
        keys: () => [...items.keys()],
        destroy() {
            for (const it of items.values()) if (it.timer) clearTimeout(it.timer);
            items.clear();
            unseen = [];
            stopFlash();
            hideDot();
            doc.removeEventListener("visibilitychange", onVisibility);
            doc.removeEventListener("fullscreenchange", onFullscreen);
            win.removeEventListener("resize", onResize);
            layer?.remove();
            layer = null;
        },
    };
}
