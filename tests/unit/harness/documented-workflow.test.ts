import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildProgram } from "../../../src/cli/main.js";
import { commandGuide, VISP_COMMANDS } from "../../../src/harness/command-guide.js";
import { browserJourneySchema } from "../../../src/testing/browser-journey.js";
import { independentReviewSchema } from "../../../src/workflow/product/independent-review.js";
import { productCheckSchema } from "../../../src/workflow/product/model.js";

describe("documented browser check inputs", () => {
  it.each(["README.md", "docs/product-review.md"])(
    "%s contains a browser check accepted by the brief validator",
    async (path) => {
      const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
      const checks: unknown[] = [];
      for (const block of text.matchAll(/```yaml\r?\n([\s\S]*?)```/g)) {
        const input: unknown = parse(block[1] ?? "");
        if (input && typeof input === "object" && "checks" in input && Array.isArray(input.checks))
          checks.push(...input.checks);
      }
      const browserChecks = checks
        .map((check) => productCheckSchema.parse(check))
        .filter((check) => typeof check.command === "object" && "kind" in check.command);
      expect(browserChecks).toHaveLength(1);
      expect(browserChecks[0]).toMatchObject({
        environment: "browser",
        command: {
          kind: "browser-journey",
          journey: {
            actions: expect.arrayContaining([
              expect.objectContaining({ kind: "click" }),
              expect.objectContaining({
                kind: "wait-for",
                attribute: { name: "data-state", value: "playing" },
              }),
            ]),
          },
        },
      });
    },
  );
});

it("parses every command-map example and the generated browser journey", () => {
  const program = buildProgram();
  for (const entry of VISP_COMMANDS) {
    const tokens =
      entry.example.match(/"[^"]*"|\S+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
    let command = program.commands.find((command) => command.name() === tokens[1]);
    let offset = 2;
    while (command?.commands.some((child) => child.name() === tokens[offset])) {
      command = command.commands.find((child) => child.name() === tokens[offset]);
      offset++;
    }
    expect(command, entry.example).toBeDefined();
    expect(command?.parseOptions(tokens.slice(offset)).unknown, entry.example).toEqual([]);
  }
  const block = /```yaml\n([\s\S]*?)```/.exec(commandGuide());
  expect(browserJourneySchema.safeParse(parse(block?.[1] ?? "")).success).toBe(true);
});

it("routes saved-history upgrades through the backed-up standalone migration", () => {
  const guide = commandGuide();
  expect(guide).toContain("visp-migrate --project <project> preview");
  expect(guide).toContain("visp-migrate --project <project> apply");
  expect(guide).not.toContain("then run\n`visp migrate`");
});

it("keeps the documented session response valid and explicitly unresolved", async () => {
  const text = await readFile(new URL("../../../docs/product-review.md", import.meta.url), "utf8");
  const block = /```json\n([\s\S]*?)```/.exec(text);
  const response = independentReviewSchema.parse(JSON.parse(block?.[1] ?? ""));
  expect(response.assessments).toEqual([]);
  expect(response.limitations.length).toBeGreaterThan(0);
});
