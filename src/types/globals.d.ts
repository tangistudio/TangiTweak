/** Build-time injected: true for the Firefox build (dist-firefox/), which leaves out Chromium-only APIs */
declare const __FIREFOX__: boolean;
/** Build-time injected: true for the content scripts (hook.js, bridge.js), which must not run code from strings */
declare const __NO_EVAL__: boolean;
/** Build-time injected: short git commit of the build ("-dirty" if uncommitted changes). */
declare const __COMMIT__: string;
/** Build-time injected: ISO timestamp of the build. */
declare const __BUILD_TIME__: string;
