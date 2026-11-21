/**
 * New Tweak…: a folder with a package.json (its "tangitweak" block), a
 * tsconfig.json, an index.ts and a .gitignore (docs/packages.md).
 */
import { currentTangiTweakVersion, isBundlePackageJson, MANIFEST_FILE } from "./packageMetadata";
import { folderOf } from "./scriptImports";
import { DEFAULT_DATA_FOLDER } from "./tweakData";

export const NEW_TWEAK_ENTRY = `import { tweak } from "tangitweak";

// Adjustable parameters (editable in the popup's ⚙ dialog):
const cfg = tweak.params({
    color: { type: "string", default: "#ffeb3b", description: "Highlight color" },
});

// Runs on every page of example.com: highlight its headings
tweak.onPage({ url: "*://*.example.com/*" }, () => {
    for (const h of document.querySelectorAll("h1, h2")) (h as HTMLElement).style.background = cfg.color;
});
`;

/** an npm package name made out of a folder's name ("My Tweak" → "my-tweak") */
export function packageNameOf(folder: string): string {
    const base = folder.slice(folder.lastIndexOf("/") + 1);
    const slug = base
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[._-]+|-+$/g, "");
    return slug || "tweak";
}

/** the files of a new tweak in `folder`: data files (package.json, tsconfig.json, .gitignore — it ignores the data folder `df`) and its entry script */
export function newTweakFiles(folder: string, df = DEFAULT_DATA_FOLDER, version = currentTangiTweakVersion()): { data: { path: string; text: string }[]; entry: { name: string; code: string } } {
    const display = folder.slice(folder.lastIndexOf("/") + 1);
    const pkg = {
        name: packageNameOf(folder),
        version: "1.0.0",
        description: "",
        tangitweak: { displayName: display },
        dependencies: { tangitweak: `^${version}` },
    };
    return {
        data: [
            { path: `${folder}/${MANIFEST_FILE}`, text: JSON.stringify(pkg, null, 4) + "\n" },
            { path: `${folder}/tsconfig.json`, text: JSON.stringify({ extends: "tangitweak/tsconfig.json" }, null, 4) + "\n" },
            { path: `${folder}/.gitignore`, text: `node_modules/\n${df}/\n` },
        ],
        entry: { name: `${folder}/index`, code: NEW_TWEAK_ENTRY },
    };
}

/** the tweaks' folders among `dataFiles`: folder → its package.json path (one with a "tangitweak" block) */
export function tweakFolders(dataFiles: readonly { path: string; text: string }[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const d of dataFiles) if (d.path.toLowerCase().endsWith("/" + MANIFEST_FILE) && isBundlePackageJson(d.text)) out.set(folderOf(d.path), d.path);
    return out;
}
