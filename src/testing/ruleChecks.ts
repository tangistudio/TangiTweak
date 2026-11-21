/**
 * What Chrome checks when TangiTweak adds a tweak's `rules` handlers as
 * session rules, done in the test loader: each rule's regex through RE2
 * (`re2js`, a port of the engine Chrome uses), its compiled size
 * (estimated — Chrome's 2 KB limit can't be measured outside Chrome) and
 * the rule counts. The texts are the extension's own (rulesStrategy.ts).
 */
import { RE2JS } from "re2js";
import { regexCost, regexProblemText, ruleErrorLine, type RuleSpec } from "../shared/dnrRules";
import type { RouteMeta } from "../shared/route";

/** Chrome's session-rule limits (the whole extension's: other tweaks share them) */
export const MAX_SESSION_RULES = 5000;
export const MAX_REGEX_RULES = 1000;

/** the size estimate (character classes + captures, see regexCost): about 10 fit; well over is an error, close a warning */
const COST_WARN = 8;
const COST_FAIL = 20;

export interface RuleGroup {
    scriptName: string;
    route: RouteMeta;
    specs: RuleSpec[];
}

export interface RuleCheck {
    errors: string[];
    warnings: string[];
    /** the groups whose rules the browser takes */
    accepted: RuleGroup[];
}

function specProblem(spec: RuleSpec): { error?: string; warning?: string } {
    const regex = spec.condition?.regexFilter;
    if (typeof regex !== "string") return {};
    const capturing = typeof spec.action?.redirect?.regexSubstitution === "string";
    try {
        RE2JS.compile(regex);
    } catch (e: any) {
        const reason = String(e?.message || e).replace(/^error parsing regexp:\s*/, "");
        return { error: regexProblemText(regex, spec.pattern, reason, capturing) };
    }
    const { classes, captures } = regexCost(regex);
    const cost = classes + (capturing ? captures : 0);
    if (cost > COST_FAIL) return { error: regexProblemText(regex, spec.pattern, "memoryLimitExceeded", capturing) };
    if (cost > COST_WARN) return { warning: `${regexProblemText(regex, spec.pattern, "memoryLimitExceeded", capturing).replace(" is too complex for a rule", " may be too complex for a rule")} (an estimate: only Chrome can tell)` };
    return {};
}

/** check a tweak's generated rules as Chrome would when adding them */
export function checkRules(groups: RuleGroup[]): RuleCheck {
    const out: RuleCheck = { errors: [], warnings: [], accepted: [] };
    for (const g of groups) {
        let error: string | undefined;
        for (const spec of g.specs) {
            const p = specProblem(spec);
            if (p.warning) out.warnings.push(`${g.scriptName}: ${ruleErrorLine(g.route, p.warning)}`);
            if (p.error) {
                error = p.error;
                break;
            }
        }
        if (error) out.errors.push(`${g.scriptName}: ${ruleErrorLine(g.route, error)}`);
        else out.accepted.push(g);
    }
    const specs = out.accepted.flatMap((g) => g.specs);
    const regexRules = specs.filter((s) => typeof s.condition?.regexFilter === "string").length;
    if (specs.length > MAX_SESSION_RULES) out.errors.push(`the tweak makes ${specs.length} browser rules — Chrome allows ${MAX_SESSION_RULES} for all tweaks together`);
    if (regexRules > MAX_REGEX_RULES) out.errors.push(`the tweak makes ${regexRules} regex rules — Chrome allows ${MAX_REGEX_RULES} for all tweaks together`);
    return out;
}
