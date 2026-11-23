/**
 * Monaco's ESM build, bundled by scripts/build.mjs into lib/monaco/ and
 * loaded on demand by monacoSetup.ts, which reads it from `window.monaco`.
 *
 * Everything Monaco's own entry point imports except the languages: models
 * are only ever "typescript" (scripts, diff editor), "json" (settings.json,
 * stores.json, data files), "xml" (.svg data files), "markdown" (.md files)
 * and "plaintext" (raster image data files).
 */
import * as api from "monaco-editor/editor";
import "monaco-editor/features/register.all";
import "monaco-editor/editor/browser/coreCommands";
import "monaco-editor/editor/common/standaloneStrings";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/markdown/register";
import * as json from "monaco-editor/languages/features/json/register";
import * as typescript from "monaco-editor/languages/features/typescript/register";

(globalThis as any).monaco = { ...api, json, typescript };
