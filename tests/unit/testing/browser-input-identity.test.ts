import { expect, it } from "vitest";
import { browserInputIdentity } from "../../../src/testing/browser-input-identity.js";
import { browserJourneySchema } from "../../../src/testing/browser-journey.js";

it("records executed control and input semantics rather than coordinates or capture flags", () => {
  const journey = browserJourneySchema.parse({
    url: "http://localhost:3000",
    actions: [
      { kind: "click", selector: "#next" },
      { kind: "key", key: "Enter" },
      { kind: "drag", selector: "canvas", from: { x: 0.2, y: 0.3 }, to: { x: 0.5, y: 0.5 } },
      { kind: "wait-for", selector: "#result", visibility: "visible" },
    ],
  });
  expect(journey.actions.map(browserInputIdentity)).toEqual([
    { kind: "click", selector: "#next" },
    { kind: "key", key: "Enter" },
    { kind: "drag", selector: "canvas", input: "pointer" },
    undefined,
  ]);
  expect(browserInputIdentity(undefined)).toBeUndefined();
});
