/**
 * Chrome MV3 runs onPage code (the default world) and onSite code
 * through the `chrome.userScripts` API, which needs the optional `userScripts`
 * permission and the user's "Allow User Scripts" switch (Developer mode
 * before Chrome 138). These are the words every place that explains it uses.
 */

/** ok: onPage and onSite code run; no-permission: the optional permission isn't granted; off: the user hasn't allowed user scripts */
export type UserScriptsStatus = "ok" | "no-permission" | "off";

/** what calls into onPage or onSite code reject with while user scripts can't run */
export const USER_SCRIPTS_OFF = "not running on this page (user scripts are off)";

/** the core of the Problems error (the UI shows route problems containing it as errors, not warnings) */
export const USER_SCRIPTS_PROBLEM = "this code doesn't run: user scripts are off";

/** how to turn them on (Chrome's own wording for the switch) */
export function userScriptsHowTo(status: Exclude<UserScriptsStatus, "ok">, extensionId: string): string {
    const allow = `turn on "Allow User Scripts" on TangiTweak's details page (chrome://extensions/?id=${extensionId}; before Chrome 138: Developer mode on chrome://extensions)`;
    return status === "no-permission" ? `grant the "user scripts" permission from the Editor's banner, then ${allow}` : allow;
}

/** the toolbar icon's "!" tooltip and the popup's notice while user scripts are off, with the popup's button */
export const USER_SCRIPTS_NOTICE: Record<Exclude<UserScriptsStatus, "ok">, { lines: string[]; action: string }> = {
    "no-permission": {
        lines: ["User scripts are off.", `onPage and onSite code don't run until TangiTweak has the "user scripts" permission.`],
        action: "Grant permission",
    },
    off: {
        lines: ["User scripts are off.", `onPage and onSite code don't run until "Allow User Scripts" is on in TangiTweak's details (before Chrome 138: Developer mode).`],
        action: "Open extension details",
    },
};

/** the Problems error for an onPage or onSite handler (`label`: "onPage #2") */
export function userScriptsProblem(label: string, status: Exclude<UserScriptsStatus, "ok">, extensionId: string): string {
    return `${label}: ${USER_SCRIPTS_PROBLEM} — ${userScriptsHowTo(status, extensionId)}`;
}

/** the Problems warning for an onOverlay the "Debugger-friendly overlays" setting can't move out of its iframe (`label`: "onOverlay #1") */
export function debuggerOverlaysProblem(label: string, status: Exclude<UserScriptsStatus, "ok">, extensionId: string): string {
    return `${label}: stays in an extension iframe that debuggers like Playwriter remove. "Debugger-friendly overlays" needs user scripts: ${userScriptsHowTo(status, extensionId)}`;
}

/**
 * What the "Debugger-friendly overlays" setting (`on`) moves out of extension
 * iframes: every onOverlay but tweak.site's (Chrome MV3: while user scripts
 * run) and toast panes (Chrome MV3: also needs `userScripts.execute`, Chrome
 * 135). Firefox and MV2: pass "ok" and true.
 */
export function debuggerFriendly(on: boolean, userScripts: UserScriptsStatus, paneWorld: boolean): { overlays: boolean; panes: boolean } {
    const overlays = on && userScripts === "ok";
    return { overlays, panes: overlays && paneWorld };
}

/** the Problems warning for toast panes the setting can't draw in the page (`status` "ok": the browser can't run code in a page on demand) */
export function debuggerPanesProblem(status: UserScriptsStatus, extensionId: string): string {
    const why = status === "ok" ? "draws them in the page from Chrome 135" : `needs user scripts: ${userScriptsHowTo(status, extensionId)}`;
    return `tweak.toastPane: its panes stay in an extension iframe that debuggers like Playwriter remove. "Debugger-friendly overlays" ${why}`;
}
