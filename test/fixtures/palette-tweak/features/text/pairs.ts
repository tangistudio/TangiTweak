/** "a=1, b=2" → { a: "1", b: "2" } */
export function parsePairs(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of text.split(",")) {
        const [k, ...v] = part.split("=");
        if (k.trim()) out[k.trim()] = v.join("=").trim();
    }
    return out;
}
