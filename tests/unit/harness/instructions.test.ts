import { expect, it } from "vitest";
import {
  renderAgentGuide,
  renderMinimalGuide,
  SLASH_COMMANDS,
} from "../../../src/harness/instructions.js";

it("keeps the verbatim request in full, minimal and shortcut feature guidance", () => {
  expect(renderAgentGuide()).toContain('visp feature "<goal>" --source-brief "<verbatim request>"');
  expect(renderMinimalGuide()).toContain(
    'visp feature "<goal>" --source-brief "<verbatim request>"',
  );
  expect(SLASH_COMMANDS.find((command) => command.name === "visp-feature")?.body).toContain(
    "--source-brief",
  );
});
