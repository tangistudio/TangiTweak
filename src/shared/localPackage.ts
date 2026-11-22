/** a package from local files (a chosen folder or a .zip) */
import { isBundlePackageJson } from "./packageMetadata";
import { crawl, filesHash, type CrawledPackage } from "./packageSource";

export { isPackageFile, unzipPackage } from "./packageSource";

/** the tweaks (tweak package.json files, when `textOf` reads them) a set of files has, shallowest first */
export function startsIn(paths: string[], textOf?: (path: string) => string | undefined): string[] {
    const depth = (p: string) => p.split("/").length;
    return paths
        .filter((p) => /(^|\/)package\.json$/i.test(p) && !/(^|\/)node_modules\//.test(p) && (!textOf || isBundlePackageJson(textOf(p))))
        .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

/** a tweak's package.json and what it brings, out of `files` */
export async function localPackage(files: Record<string, string>, start: string): Promise<CrawledPackage & { revision: string }> {
    const c = await crawl(start, async (p) => files[p] ?? null);
    return { ...c, revision: await filesHash(c.files) };
}
