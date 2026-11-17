/**
 * Shortcuts in cross-origin iframes (`ctx.shortcut(keys, fn, { iframes:
 * { crossOrigin: true } })`). The parent can't reach the iframe's page, but
 * the bridge content script runs in it too. No user code goes there: the
 * parent offers the background a random token for (keys, priority) and
 * posts the token into the iframe; the child's bridge claims it; the
 * background checks the child really is in that iframe (Chrome: the frame
 * tree; Firefox: the frameId the parent read with `runtime.getFrameId`),
 * then tells the child to watch those keys. A press there is consumed in
 * the child (so `"pass"` doesn't work across origins) and comes back as a
 * hit, and `fn` runs in the parent.
 */
import { ShortcutRegistry, watchShortcuts, type ShortcutPriority } from "./shortcut";
import type { Endpoint } from "./wire";

/** the message the parent posts into the iframe */
export const FRAME_CLAIM = "__ttFrameClaim";

function newToken(): string {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** parent side: one offer per (shortcut, iframe element) */
export class FrameKeyOffers {
    private readonly live = new Map<string, { offer: () => void; fire: () => void }>();

    /**
     * `link`: the port to the background; `frameIdOf`: Firefox's
     * `runtime.getFrameId`; `hold`: called with true while there are
     * offers (keep the port open) and false once there are none
     */
    constructor(
        private readonly link: () => Promise<Endpoint>,
        private readonly frameIdOf?: (el: HTMLIFrameElement) => number,
        private readonly hold?: (on: boolean) => void
    ) {}

    /** watch `keys` in `el`'s document, now and after each load; `fire` runs on a press there */
    watch(el: HTMLIFrameElement, keys: string, priority: ShortcutPriority, fire: () => void): () => void {
        const token = newToken();
        let gone = false;
        const offer = () => {
            let child: number | undefined;
            try {
                child = this.frameIdOf?.(el);
            } catch {
                return;
            }
            if (child !== undefined && child < 0) return;
            this.link()
                .then((ep) => ep.call("frameKeys.offer", { token, keys, priority, ...(child !== undefined ? { child } : {}) }))
                .then(
                    () => {
                        if (!gone) el.contentWindow?.postMessage({ [FRAME_CLAIM]: token }, "*");
                    },
                    () => {}
                );
        };
        this.live.set(token, { offer, fire });
        if (this.live.size === 1) this.hold?.(true);
        el.addEventListener("load", offer);
        offer();
        return () => {
            if (gone) return;
            gone = true;
            el.removeEventListener("load", offer);
            this.live.delete(token);
            this.link().then(
                (ep) => ep.push("frameKeys.withdraw", { token }),
                () => {}
            );
            if (!this.live.size) this.hold?.(false);
        };
    }

    /** the background relayed a press */
    hit(token: unknown): void {
        if (typeof token === "string") this.live.get(token)?.fire();
    }

    /** a new port (the old one, and the background's grants, are gone): offer everything again */
    relink(): void {
        for (const g of this.live.values()) g.offer();
    }
}

/**
 * The token in a claim message for this frame: posted by one of its
 * ancestors, and only if its parent is cross-origin (a same-origin parent
 * listens in this frame itself)
 */
export function claimToken(e: MessageEvent, win: Window = window): string | null {
    const token = (e.data as any)?.[FRAME_CLAIM];
    if (typeof token !== "string" || win === win.top) return null;
    let ancestor = false;
    for (let w: Window = win; w !== w.parent; ) {
        w = w.parent;
        if (e.source === w) {
            ancestor = true;
            break;
        }
    }
    if (!ancestor) return null;
    try {
        void win.parent.document.documentElement;
        return null;
    } catch {
        return token;
    }
}

/** child side: the keys parents asked this frame to watch */
export class FrameKeyWatch {
    private readonly reg: ShortcutRegistry;
    private unwatch: (() => void) | null = null;

    constructor(
        private readonly win: Window,
        private readonly hit: (token: string) => void,
        private readonly opts: { mac?: boolean; trusted?: (e: KeyboardEvent) => boolean } = {}
    ) {
        this.reg = new ShortcutRegistry(opts.mac);
    }

    add(token: string, keys: string, priority: ShortcutPriority): void {
        // one owner for all, so every parent watching the same keys hears them
        this.reg.add("", token, keys, priority);
        this.unwatch ??= watchShortcuts(
            this.win,
            (e) => this.reg.find(e),
            (hits) => {
                for (const h of hits) this.hit(h.id);
            },
            { trusted: this.opts.trusted }
        );
    }

    remove(token: string): void {
        this.reg.remove("", token);
        if (!this.reg.size) this.clear();
    }

    clear(): void {
        this.reg.removeScript("");
        this.unwatch?.();
        this.unwatch = null;
    }

    get size(): number {
        return this.reg.size;
    }
}
