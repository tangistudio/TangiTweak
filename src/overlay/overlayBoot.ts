/** overlay.js: a script's overlay frame (overlay.html) or site page boots its runtime (src/overlay/overlayRuntime.ts) */
import { boot } from "./overlayRuntime";

if (typeof document !== "undefined" && document.documentElement?.dataset.ttOverlay === "1") boot();
