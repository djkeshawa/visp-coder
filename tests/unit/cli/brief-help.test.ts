import { expect, it } from "vitest";
import { parse } from "yaml";
import { briefCommand } from "../../../src/cli/commands/product.js";
import { productBriefSchema } from "../../../src/workflow/product/model.js";

it("provides brief entry examples that validate without changing the editable template", () => {
  let output = "";
  briefCommand()
    .configureOutput({
      writeOut: (text) => {
        output += text;
      },
    })
    .outputHelp();
  const example = output.match(/```yaml\n([\s\S]*?)```/)?.[1];
  expect(example).toBeDefined();
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-example",
    originalRequest: "An independently authored request",
    goal: "An independently authored request",
    ...parse(example ?? ""),
  });
  expect(brief.slices[0]?.checks).toEqual([brief.checks[0]?.id]);
  expect(brief.slices[0]?.outcomes).toEqual([brief.outcomes[0]?.id]);
  expect(brief.outcomes[0]?.provenance).toBe("agent-proposed");
  expect(output).toContain("editable object is inside the envelope's `data`");
  expect(output).toContain("linked in that slice before running visp work or visp done");
});
