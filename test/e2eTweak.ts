/**
 * Seeding tweaks in the e2e suites through the background's messages, the
 * way the engine stores a bundle: `<folder>/package.json` (with a
 * "tangitweak" block) as a data file, and its entry `<folder>/index` and
 * modules as scripts. The entry's id is the tweak's: its enable switch,
 * params and handlers.
 */
import { bundlePkg } from "./bundleHelper";

export type Send = (msg: any) => Promise<any>;

/** `<folder>/package.json`, unless the folder has one */
export async function seedTweakPkg(send: Send, folder: string): Promise<void> {
    const r = await send({ type: "saveDataFile", path: `${folder}/package.json`, text: bundlePkg(folder.split("/").pop()!) });
    if (r?.error && !/already exists/.test(r.error)) throw new Error(`seeding ${folder}/package.json: ${r.error}`);
}

/**
 * Saves `code` as the entry (index.ts) of the tweak in `folder`, or as its
 * module `file` (`"lib"` → `<folder>/lib.ts`); returns the saved script.
 */
export async function saveTweak(send: Send, id: string, folder: string, code: string, opts: { file?: string; enabled?: boolean } = {}): Promise<any> {
    await seedTweakPkg(send, folder);
    return send({ type: "saveScript", id, name: `${folder}/${opts.file ?? "index"}`, code, ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }) });
}

/** removes a tweak: its folder, with its package.json, entry and modules */
export const deleteTweak = (send: Send, folder: string): Promise<any> => send({ type: "deleteFolder", path: folder });
