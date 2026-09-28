import { expect, it } from "vitest";
import {
  renderAgentGuide,
  renderMinimalGuide,
  SLASH_COMMANDS,
} from "../../../src/harness/instructions.js";

it("keeps the verbatim request in full, minimal and shortcut feature guidance", () => {
  expect(renderAgentGuide()).toContain('visp feature "<goal>" --source-brief -');
  expect(renderMinimalGuide()).toContain('visp feature "<goal>" --source-brief -');
  expect(SLASH_COMMANDS.find((command) => command.name === "visp-feature")?.body).toContain(
    "--source-brief",
  );
});

it("starts the minimal guide with a one-slice check and a shell-safe request", () => {
  expect(renderMinimalGuide()).toContain('visp work --check "<test command>"');
  expect(renderMinimalGuide()).toContain("--source-brief -");
  expect(renderMinimalGuide()).toContain("<<'REQUEST'");
});

it("tells every guide to show user-readable information as labeled text", () => {
  for (const guide of [renderAgentGuide(), renderMinimalGuide()]) {
    expect(guide).toContain(
      "If the request has a UI, show status, counts, errors as word-labeled text",
    );
    expect(guide).toContain("Score: 1500");
    expect(guide).toContain("not only canvas/icons");
  }
});
