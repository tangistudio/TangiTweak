import { expect, test } from "vitest";
import { tweak } from "tangitweak";
import { parsePairs } from "../features/text/pairs";
import { greetings } from "../features/text/greet";
import "../features/net/flags";

test("parses key=value pairs", () => {
    expect(parsePairs("env=staging, region=us-east-1")).toEqual({ env: "staging", region: "us-east-1" });
});

test("npm imports resolve as in Node", () => {
    expect(greetings("bo")).toBe("hello bo / HELLO BO");
});

test("tangitweak on its own: handlers are recorded, params are their defaults", () => {
    expect(tweak.params({ env: { type: "string", default: "staging" } })).toEqual({ env: "staging" });
});
