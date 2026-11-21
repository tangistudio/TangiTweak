import { tweak } from "tangitweak";

const FLAGS = "*://app.example.com/api/flags";

const p = tweak.params({ env: { type: "string", default: "staging" } });

tweak.onRequest({ url: FLAGS, strategy: "helper" }, () => ({ replaceResponse: { body: { newNav: true } } }));
tweak.onResponseBody({ url: FLAGS, strategy: "page" }, (_ctx, body) => ({ ...JSON.parse(String(body)), seen: true }));

tweak.onRequest({ url: "*://app.example.com/api/data", strategy: "helper" }, () => ({ headers: { set: { "x-env": p.env } } }));

tweak.onRequest({ url: "*://telemetry.example.com/*", strategy: "rules" }, () => ({ block: true }));
