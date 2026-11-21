/**
 * A background `window` and `document` for test files that run without a
 * DOM environment. Each test page gets its own happy-dom window
 * (`openPage`); React reads a few globals of its own (`window.event`, and
 * whether a DOM exists, once when `react-dom` loads), so this module is
 * imported before anything that loads React.
 */
import { Window } from "happy-dom";

if (typeof (globalThis as any).document === "undefined") {
    const bg = new Window({ url: "about:blank" });
    Object.assign(globalThis, { window: bg, document: bg.document });
}
