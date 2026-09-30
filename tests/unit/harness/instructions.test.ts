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

it("routes review through visp next and polls long commands in every guide", () => {
  for (const guide of [renderAgentGuide(), renderMinimalGuide()]) {
    expect(guide).toContain(
      "If visp done runs VISP's reviewer, run or delegate no review; visp next waits.",
    );
    expect(guide).toContain("Run visp critic/review only when visp next prints it.");
    expect(guide).toContain(
      "Run feature/done/verify/accept/next with the host's maximum shell timeout. If it keeps running, poll it; never start feature, done or accept again until that call ends (after a kill or error, rerun once).",
    );
    expect(guide).not.toContain("delegate nothing");
  }
  expect(renderAgentGuide()).toContain(
    "Use at least 10 minutes for feature/done/verify/accept/next",
  );
  expect(renderAgentGuide()).toContain(
    "When visp next hands you a\n  review, pause scoped edits until it returns.",
  );
  expect(renderAgentGuide()).not.toContain("feedbackLoop");
});

it("tells every guide that UI previews use the real action's function and start point", () => {
  for (const guide of [renderAgentGuide(), renderMinimalGuide()]) {
    expect(guide).toContain(
      "- UI previews (aim line, predicted path): compute them with the real action's function and start point; check with real input. Do not delete or shrink requested content to pass a check.",
    );
  }
});
