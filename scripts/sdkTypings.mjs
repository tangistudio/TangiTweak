/**
 * The SDK's declaration files, and the check that every symbol in them is
 * documented (docs/development.md#documenting-the-sdk).
 *
 * `node scripts/sdkTypings.mjs [filter…]` emits the declarations, checks
 * them and src/types/tt-api.d.ts (the SDK's index.d.ts) and lists what has
 * no doc comment, optionally only in files whose path has a filter in it.
 * It exits 1 when something is missing.
 *
 * @module
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");

/**
 * Emits the declarations `tangitweak/test` needs: test.d.ts and every
 * declaration file it imports, with `.js` added to relative imports so any
 * `moduleResolution` finds them.
 *
 * @returns Path under src/ (e.g. `shared/wire.d.ts`) → declaration text.
 * @throws When TypeScript reports an error, or a relative import has no declarations.
 */
export async function sdkDeclarations() {
    const cfg = ts.getParsedCommandLineOfConfigFile(path.join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    const src = path.join(root, "src");
    const program = ts.createProgram([path.join(src, "testing/test.ts"), path.join(src, "types/globals.d.ts"), path.join(src, "types/tt-api.d.ts")], {
        ...cfg.options,
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: src,
        outDir: src,
    });
    const emitted = new Map();
    const res = program.emit(undefined, (file, text) => emitted.set(path.relative(src, file).split(path.sep).join("/"), text));
    if (res.emitSkipped || res.diagnostics.length) {
        throw new Error(`SDK typings: ${ts.formatDiagnostics(res.diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => "\n" })}`);
    }
    const out = new Map();
    const queue = ["testing/test.d.ts"];
    while (queue.length) {
        const file = queue.pop();
        if (out.has(file)) continue;
        let text = keepOverview(program, path.join(src, file), emitted.get(file));
        // TypeScript's scanner, not a regex: `import … from` lines in doc examples aren't imports
        const specs = ts.preProcessFile(text, true, true).importedFiles.filter((f) => /^\.\.?\//.test(f.fileName));
        for (const { fileName: spec, pos } of specs.sort((a, b) => b.pos - a.pos)) {
            const base = path.posix.join(path.posix.dirname(file), spec);
            const hit = [".d.ts", "/index.d.ts"].map((ext) => base + ext).find((f) => emitted.has(f));
            if (!hit) throw new Error(`SDK typings: ${file} imports ${spec}, which has no declarations`);
            queue.push(hit);
            // `pos` is the opening quote
            const end = pos + 1 + spec.length;
            text = text.slice(0, end) + (hit.endsWith("/index.d.ts") ? "/index.js" : ".js") + text.slice(end);
        }
        out.set(file, text);
    }
    return out;
}

/**
 * Puts the source file's overview back at the top of its declarations,
 * followed by a blank line. Declaration emit drops that blank line, which
 * makes editors show the overview as the first declaration's doc, and drops
 * the overview with a leading type-only import.
 *
 * @param program The program that emitted `text`.
 * @param dts Absolute path of the emitted declaration file.
 * @param text Its emitted text.
 * @returns `text` starting with the overview, or unchanged when the source has none.
 */
function keepOverview(program, dts, text) {
    const base = dts.replace(/\.d\.ts$/, "");
    const source = [".ts", ".tsx", ".d.ts"].map((ext) => program.getSourceFile(base + ext)).find(Boolean)?.text;
    const range = source && ts.getLeadingCommentRanges(source, 0)?.find((c) => source.startsWith("/**", c.pos));
    if (!range || !/^[ \t]*\r?\n[ \t]*\r?\n/.test(source.slice(range.end))) return text;
    const overview = source.slice(range.pos, range.end);
    return `${overview}\n\n${(text.startsWith(overview) ? text.slice(overview.length) : text).trimStart()}`;
}

/** `WireOps` entries' `req`, `res` and `push` keys: the op's doc covers them, their members still need their own */
const OP_PARTS = new Set(["req", "res", "push"]);

/**
 * Lists the symbols in declaration files that have no doc comment.
 *
 * Needs one: the file itself (a leading `/** … *\/` with a blank line after
 * it, which {@link sdkDeclarations} keeps), every declaration (the first of
 * overloads), and every member of interfaces, classes, enums and object
 * types anywhere in a type, except private members, index, call and
 * construct signatures, and `WireOps`' `req`/`res`/`push` keys.
 * A comment with only tags (`/** @internal *\/`) doesn't count.
 *
 * @param files Path → declaration text.
 * @returns One `path: qualified.name` line per missing comment.
 */
export function undocumented(files) {
    const missing = [];
    for (const [file, text] of Object.entries(files)) {
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const report = (name) => missing.push(`${file}: ${name}`);
        const overview = ts.getLeadingCommentRanges(text, 0)?.find((c) => text.startsWith("/**", c.pos));
        const first = sf.statements[0];
        // the parser also hands the file's overview to the first statement: it isn't that statement's doc
        const hasDoc = (node) =>
            ts.getJSDocCommentsAndTags(node).some((d) => ts.isJSDoc(d) && d.pos !== overview?.pos && ts.getTextOfJSDocComment(d.comment)?.trim());
        const isOnlyReexports = sf.statements.every((s) => ts.isExportDeclaration(s));
        const detached = overview && (!first || /\n[ \t]*\r?\n/.test(text.slice(overview.end, first.getStart(sf))));
        if (!isOnlyReexports && !detached) report("(file overview: a /** … */ at the top, followed by a blank line)");

        const nameOf = (node) => {
            if (ts.isVariableStatement(node)) return node.declarationList.declarations.map((d) => d.name.getText(sf)).join(", ");
            if (ts.isConstructorDeclaration(node)) return "constructor";
            return node.name?.getText(sf) ?? "(anonymous)";
        };
        const isPrivate = (node) => ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Private || (node.name && ts.isPrivateIdentifier(node.name));

        /** members of an object-like node, then any object types nested in their types */
        const members = (list, owner) => {
            const seen = new Set();
            for (const m of list) {
                if (ts.isIndexSignatureDeclaration(m) || ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m)) {
                    nested(m, owner);
                    continue;
                }
                if (isPrivate(m)) continue;
                if (ts.isConstructorDeclaration(m) && !m.parameters.length) continue;
                const name = nameOf(m);
                const qualified = `${owner}.${name}`;
                const overload = seen.has(name);
                seen.add(name);
                if (!overload && !hasDoc(m) && !(OP_PARTS.has(name) && m.type && ts.isTypeLiteralNode(m.type))) report(qualified);
                nested(m, qualified);
            }
        };
        /** object types inside a node's types and parameters */
        const nested = (node, owner) => {
            const visit = (n) => {
                if (ts.isTypeLiteralNode(n)) return members(n.members, owner);
                if (ts.isMappedTypeNode(n)) return;
                ts.forEachChild(n, visit);
            };
            ts.forEachChild(node, (c) => (ts.isJSDoc(c) ? undefined : visit(c)));
        };

        const statements = (list, prefix) => {
            const seen = new Set();
            for (const s of list) {
                if (ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s) || ts.isExportDeclaration(s) || ts.isExportAssignment(s)) continue;
                if (ts.isModuleDeclaration(s) && s.flags & ts.NodeFlags.GlobalAugmentation) {
                    if (s.body && ts.isModuleBlock(s.body)) statements(s.body.statements, prefix);
                    continue;
                }
                const name = prefix + nameOf(s);
                const overload = ts.isFunctionDeclaration(s) && seen.has(name);
                seen.add(name);
                if (!overload && !hasDoc(s)) report(name);
                if (ts.isModuleDeclaration(s)) {
                    let body = s.body;
                    while (body && ts.isModuleDeclaration(body)) body = body.body;
                    if (body && ts.isModuleBlock(body)) statements(body.statements, `${name}.`);
                } else if (ts.isInterfaceDeclaration(s) || ts.isClassDeclaration(s)) {
                    members(s.members, name);
                    for (const h of s.heritageClauses ?? []) nested(h, name);
                } else if (ts.isEnumDeclaration(s)) {
                    for (const m of s.members) if (!hasDoc(m)) report(`${name}.${m.name.getText(sf)}`);
                } else {
                    nested(s, name);
                }
            }
        };
        statements(sf.statements, "");
    }
    return missing;
}

/**
 * The files the SDK ships its own docs in, under their published paths:
 * `index.d.ts` (src/types/tt-api.d.ts) and `types/…` (the emitted declarations).
 */
export async function sdkDocFiles() {
    const files = { "index.d.ts": await readFile(path.join(root, "src/types/tt-api.d.ts"), "utf8") };
    for (const [file, text] of await sdkDeclarations()) files[`types/${file}`] = text;
    return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
    const filters = process.argv.slice(2);
    const files = Object.fromEntries(Object.entries(await sdkDocFiles()).filter(([f]) => !filters.length || filters.some((x) => f.includes(x))));
    const missing = undocumented(files);
    for (const line of missing) console.log(line);
    console.log(`${missing.length} undocumented in ${Object.keys(files).length} files`);
    process.exit(missing.length ? 1 : 0);
}
