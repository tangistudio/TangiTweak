import { tweak } from "tangitweak";

export const choices = tweak.globalStore("choices", { compact: false });
export const palette = tweak.tabStore({ open: false, filter: "" });
export const visit = tweak.pageStore({ count: 0 });
export const site = tweak.siteStore({ lastUrl: "" });
