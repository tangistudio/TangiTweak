/**
 * Is TangiTweak running in a tab's page? Chrome doesn't add content
 * scripts to tabs already open when the extension starts (install, update,
 * reload), and the old copy is cut off: nothing runs there until the tab
 * reloads. Shown on the toolbar badge and explained in the popup.
 */
export type TabStatus = "ok" | "reload" | "no-access";

// pages the browser never lets extensions into: nothing to fix there
const CLOSED = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|addons\.mozilla\.org|microsoftedge\.microsoft\.com\/addons)(\/|$)/i;

export async function tabStatus(
    tab: { url?: string; status?: string } | undefined,
    injected: () => Promise<boolean>,
    hasAccess: (origin: string) => Promise<boolean>
): Promise<TabStatus> {
    const url = tab?.url;
    if (!url || !/^https?:/i.test(url) || tab.status !== "complete" || CLOSED.test(url)) return "ok";
    const u = new URL(url);
    // Chrome's PDF viewer isn't a page content scripts run in
    if (/\.pdf$/i.test(u.pathname)) return "ok";
    if (!(await hasAccess(u.origin))) return "no-access";
    return (await injected()) ? "ok" : "reload";
}

export const TAB_NOTICE: Record<Exclude<TabStatus, "ok">, { lines: string[]; action: string }> = {
    reload: {
        lines: ["TangiTweak isn't running on this tab.", "It was open before TangiTweak was installed or updated.", "Reload the tab to turn it on."],
        action: "Reload tab",
    },
    "no-access": {
        lines: ["TangiTweak can't run on this site.", "Its site access is turned off in the browser."],
        action: "Allow and reload",
    },
};
