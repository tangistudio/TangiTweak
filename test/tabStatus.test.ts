import { describe, it, expect, vi } from "vitest";
import { tabStatus } from "../src/shared/tabStatus";

const yes = async () => true;
const no = async () => false;
const tab = (url: string, status = "complete") => ({ url, status });

describe("tabStatus", () => {
    it("asks for a reload when the page has no bridge", async () => {
        expect(await tabStatus(tab("https://a.com/x"), no, yes)).toBe("reload");
        expect(await tabStatus(tab("https://a.com/x"), yes, yes)).toBe("ok");
    });

    it("reports missing site access before pinging", async () => {
        const ping = vi.fn(no);
        expect(await tabStatus(tab("https://a.com/x"), ping, async (o) => o !== "https://a.com")).toBe("no-access");
        expect(ping).not.toHaveBeenCalled();
    });

    it("says nothing where no bridge is expected", async () => {
        for (const t of [tab("https://a.com/x", "loading"), tab("chrome://extensions"), tab("https://chromewebstore.google.com/detail/x"), tab("https://a.com/doc.PDF"), undefined]) {
            expect(await tabStatus(t, no, no)).toBe("ok");
        }
    });
});
