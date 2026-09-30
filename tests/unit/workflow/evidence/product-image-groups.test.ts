import { expect, it, vi } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import { ok } from "../../../../src/core/result.js";
import {
  newestRunPerJourney,
  type ProductReviewImageGroup,
  productReviewImageGroups,
} from "../../../../src/workflow/product/image-groups.js";
import { inspectProductImages } from "../../../../src/workflow/product/images.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { pngHeader } from "../../support/workspace.js";

const bytes = pngHeader(1280, 720);
const subject = "a".repeat(64);
const viewport = { width: 1280, height: 720 };
const capture = (id: string, width = 1280) => ({
  id,
  path: `${id}.png`,
  sha256: sha256(bytes),
  subjectDigest: subject,
  route: "/start",
  steps: ["Open", "Click Begin"],
  viewport: { width, height: 720 },
  createdAt: "2026-01-01",
  provenance: "runner-captured" as const,
});
const workspace = {
  files: { readBytesIfExists: async () => ok(bytes) },
} as unknown as WorkspaceState;
const group = (id: string, captureIds: string[], width = 1280): ProductReviewImageGroup => ({
  id,
  captureIds,
  viewport: { width, height: 720 },
});

it("delivers the preserved observation selection before applying default viewport sampling", async () => {
  const desktop = group("desktop", ["initial", "held", "release", "flight", "result", "reset"]);
  const mobile = group("phone", ["phone-initial"], 390);
  const captures = [...desktop.captureIds.map((id) => capture(id)), capture("phone-initial", 390)];
  const selected = ["phone-initial", "initial", "held", "release", "reset"];
  const result = await inspectProductImages(
    workspace,
    subject,
    captures,
    [],
    [mobile, desktop],
    selected,
  );
  expect(new Set(result.images.map((image) => image.id))).toEqual(new Set(selected));
  expect(result.groups.find((entry) => entry.id === "desktop")?.omittedCaptureIds).toEqual([
    "flight",
    "result",
  ]);
});

it("keeps three complete journey pairs when unrelated images would split the six-image window", async () => {
  const groups = ["new", "middle", "old", "omitted"].map((id) =>
    group(id, [`${id}-before`, `${id}-after`]),
  );
  const captures = groups.flatMap((entry) => entry.captureIds.map((id) => capture(id)));
  const result = await inspectProductImages(
    workspace,
    subject,
    [...captures, capture("unrelated")],
    [],
    groups,
  );
  expect(result.images.map((entry) => entry.id)).toEqual(
    groups.slice(0, 3).flatMap((entry) => entry.captureIds),
  );
  expect(result.groups.at(-1)).toMatchObject({ status: "not-delivered", deliveredCaptureIds: [] });
  expect(result.availability.find((entry) => entry.id === "omitted-before")?.status).toBe(
    "not-delivered",
  );
  expect(result.gaps).toEqual([]);
});

it("selects requested groups and preserves endpoints when sampling desktop and mobile journeys", async () => {
  const desktop = group(
    "desktop",
    Array.from({ length: 8 }, (_, index) => `desktop-${index}`),
  );
  const mobile = group("mobile", ["mobile-before", "mobile-after"], 390);
  const other = group("other", ["other-before", "other-after"]);
  const captures = [
    ...desktop.captureIds.map((id) => capture(id)),
    ...mobile.captureIds.map((id) => capture(id, 390)),
    ...other.captureIds.map((id) => capture(id)),
  ];
  const result = await inspectProductImages(
    workspace,
    subject,
    captures,
    [],
    [desktop, other, mobile],
  );
  expect(result.groups.find((entry) => entry.id === "desktop")).toMatchObject({
    status: "delivered",
    deliveredCaptureIds: ["desktop-0", "desktop-4", "desktop-7"],
  });
  expect(result.groups.find((entry) => entry.id === "mobile")?.status).toBe("delivered");
  expect(result.images).toHaveLength(5);
  const requested = await inspectProductImages(
    workspace,
    subject,
    captures,
    ["other"],
    [desktop, mobile, other],
  );
  expect(requested.images.slice(0, 2).map((entry) => entry.id)).toEqual(other.captureIds);
});

it("preserves a sampled desktop/mobile selection without expanding one group and evicting the other", async () => {
  const desktop = group(
    "desktop",
    Array.from({ length: 6 }, (_, index) => `desktop-${index}`),
  );
  const mobile = group(
    "mobile",
    Array.from({ length: 6 }, (_, index) => `mobile-${index}`),
    390,
  );
  const groups = [desktop, mobile];
  const captures = groups.flatMap((entry) =>
    entry.captureIds.map((id) => capture(id, entry.viewport.width)),
  );
  const initial = await inspectProductImages(workspace, subject, captures, [], groups);
  const ids = initial.images.map((entry) => entry.id);
  expect(ids).toHaveLength(6);
  expect(initial.images.filter((entry) => entry.viewport.width === 390)).toHaveLength(3);
  const roundtrip = await inspectProductImages(workspace, subject, captures, ids, groups, ids);
  expect(roundtrip.images.map((entry) => entry.id)).toEqual(ids);
  expect(roundtrip.groups.every((entry) => entry.deliveredCaptureIds.length === 3)).toBe(true);
  const absent = await inspectProductImages(workspace, subject, captures, [], groups, []);
  expect(absent.images).toEqual([]);
  expect(absent.groups.every((entry) => entry.status === "not-delivered")).toBe(true);
});

it("detects missing or corrupt images even when they fall outside delivery, without delivering half a journey", async () => {
  const groups = Array.from({ length: 5 }, (_, index) =>
    group(`g${index}`, [`${index}-before`, `${index}-after`]),
  );
  const captures = groups.flatMap((entry) => entry.captureIds.map((id) => capture(id)));
  const brokenWorkspace = {
    files: {
      readBytesIfExists: async (path: string) =>
        ok(
          path === "3-before.png"
            ? Buffer.from("corrupt")
            : path === "4-before.png"
              ? undefined
              : bytes,
        ),
    },
  } as unknown as WorkspaceState;
  const result = await inspectProductImages(brokenWorkspace, subject, captures, ["g3"], groups);
  expect(result.images.some((entry) => entry.id === "3-after")).toBe(false);
  expect(result.availability.find((entry) => entry.id === "3-after")?.status).toBe("not-delivered");
  expect(result.availability.find((entry) => entry.id === "3-before")?.status).toBe("unavailable");
  expect(result.availability.find((entry) => entry.id === "4-before")?.status).toBe("unavailable");
  expect(result.groups.find((entry) => entry.id === "g3")?.status).toBe("unavailable");
  expect(result.gaps.join()).toContain("image changed since capture");
  expect(result.gaps.join()).toContain("missing");
});

it("enforces the total byte budget atomically and avoids reading oversized files", async () => {
  const large = Buffer.alloc(3 * 1024 * 1024);
  bytes.copy(large);
  const groups = [
    group("one", ["one-before", "one-after"]),
    group("two", ["two-before", "two-after"]),
  ];
  const captures = groups.flatMap((entry) =>
    entry.captureIds.map((id) => ({ ...capture(id), sha256: sha256(large) })),
  );
  const limited = {
    files: { readBytesIfExists: async () => ok(large) },
  } as unknown as WorkspaceState;
  const result = await inspectProductImages(limited, subject, captures, [], groups);
  expect(result.images).toHaveLength(2);
  expect(result.groups[1]?.status).toBe("not-delivered");
  const read = vi.fn(async () => ok(large));
  const oversized = {
    files: {
      metadata: async () => ok({ type: "file", size: 5 * 1024 * 1024 }),
      readBytesIfExists: read,
    },
  } as unknown as WorkspaceState;
  const blocked = await inspectProductImages(oversized, subject, [capture("huge")]);
  expect(blocked.images).toEqual([]);
  expect(blocked.availability[0]?.status).toBe("unavailable");
  expect(read).not.toHaveBeenCalled();
});

it("rechecks bytes at delivery and withholds the complete group if one image changes", async () => {
  const reads = new Map<string, number>();
  const changing = {
    files: {
      readBytesIfExists: async (path: string) => {
        const count = (reads.get(path) ?? 0) + 1;
        reads.set(path, count);
        return ok(path === "after.png" && count > 1 ? Buffer.from("changed") : bytes);
      },
    },
  } as unknown as WorkspaceState;
  const result = await inspectProductImages(
    changing,
    subject,
    [capture("before"), capture("after")],
    [],
    [group("journey", ["before", "after"])],
  );
  expect(result.images).toEqual([]);
  expect(result.groups[0]?.status).toBe("unavailable");
  expect(result.availability.find((entry) => entry.id === "before")?.status).toBe("not-delivered");
  expect(result.availability.find((entry) => entry.id === "after")?.status).toBe("unavailable");
  expect(result.gaps.join()).toContain("during delivery");
});

it("derives scoped current viewport groups and retains failed journey identity", () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-groups",
    originalRequest: "Useful UI",
    goal: "Useful UI",
    outcomes: [{ id: "O001", kind: "experience", statement: "Useful UI" }],
    slices: [{ id: "T001", goal: "UI", outcomes: ["O001"], scope: { allowed: ["app.js"] } }],
  });
  const run = {
    id: "run",
    version: 2,
    provenance: "runner-executed",
    subjectDigest: subject,
    contractDigest: productContractDigest(brief),
    status: "failed",
    captures: [
      capture("desktop-before"),
      capture("desktop-after"),
      capture("mobile-before", 390),
      capture("mobile-after", 390),
    ],
  };
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: {
      ...initialProductState(brief, "2026-01-01"),
      captureRuns: [
        run,
        { ...run, id: "stale", subjectDigest: "old" },
        { ...run, id: "wrong-contract", contractDigest: "old" },
        { ...run, id: "removed-task", task: "T999" },
      ],
    },
  };
  const groups = productReviewImageGroups(record, subject, brief.slices[0]);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatchObject({
    id: "image-group:run:1280x720",
    runStatus: "failed",
    viewport,
    captureIds: ["desktop-before", "desktop-after"],
  });
  expect(groups[1]?.viewport.width).toBe(390);
});

it("bounds metadata for 130 current groups while retaining requested and delivered groups", async () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-groups",
    originalRequest: "Review the UI",
    goal: "Review the UI",
  });
  const runs = Array.from({ length: 130 }, (_, index) => ({
    id: `run-${index}`,
    version: 1,
    provenance: "runner-executed",
    subjectDigest: subject,
    captures: [capture(`${index}-before`), capture(`${index}-after`)],
  }));
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: { ...initialProductState(brief, "2026-01-01"), captureRuns: runs },
  };
  const groups = productReviewImageGroups(record, subject);
  const requested = "image-group:run-0:1280x720";
  const brokenWorkspace = {
    files: {
      readBytesIfExists: async (path: string) => ok(path === "0-before.png" ? undefined : bytes),
    },
  } as unknown as WorkspaceState;
  const result = await inspectProductImages(
    brokenWorkspace,
    subject,
    runs.flatMap((run) => run.captures),
    [requested],
    groups,
  );
  expect(result.groups).toHaveLength(12);
  expect(result.groupsOmitted).toBe(118);
  expect(result.images).toHaveLength(6);
  expect(result.availability).toHaveLength(260);
  expect(result.groups.slice(0, 3).every((group) => group.status === "delivered")).toBe(true);
  expect(result.groups[3]).toMatchObject({
    id: requested,
    status: "unavailable",
    deliveredCaptureIds: [],
    captureCount: 2,
    omittedCaptureCount: 2,
  });
  expect(result.availability.find((entry) => entry.id === "1-before")?.status).toBe(
    "not-delivered",
  );
});

it("bounds oversized legacy group ID lists with exact total and omitted counts", async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `legacy-${index}`);
  const result = await inspectProductImages(
    workspace,
    subject,
    ids.map((id) => capture(id)),
    ["legacy"],
    [group("legacy", ids)],
  );
  const delivered = result.groups[0];
  expect(delivered).toMatchObject({
    captureCount: 100,
    omittedCaptureCount: 94,
    status: "delivered",
  });
  expect(delivered?.captureIds).toHaveLength(6);
  expect(delivered?.omittedCaptureIds).toHaveLength(6);
  expect(delivered?.deliveredCaptureIds).toEqual(result.images.map((image) => image.id));
  expect(delivered?.deliveredCaptureIds).toContain("legacy-99");
  expect(result.availability).toHaveLength(100);
  expect(result.availability.filter((entry) => entry.status === "not-delivered")).toHaveLength(94);
  expect(result.groupsOmitted).toBe(0);
});

it("reserves endpoints for three viewports instead of dropping the older journey", async () => {
  const groups = [
    group("landscape", ["l"], 844),
    group("portrait", ["p0", "p1", "p2", "p3"], 390),
    group("desktop", ["d0", "d1", "d2", "d3", "d4"]),
  ];
  const captures = groups.flatMap((g) => g.captureIds.map((id) => capture(id, g.viewport.width)));
  const result = await inspectProductImages(workspace, subject, captures, [], groups);
  expect(result.images.map((i) => i.id)).toEqual(["l", "p0", "p2", "p3", "d0", "d4"]);
  expect(result.groups.every((g) => g.status === "delivered")).toBe(true);
  expect(result.groups.find((g) => g.id === "desktop")?.omittedCaptureCount).toBe(3);
  const ids = result.images.map((i) => i.id);
  const roundtrip = await inspectProductImages(
    workspace,
    subject,
    [...captures, capture("new")],
    ids,
    groups,
    ids,
  );
  expect(roundtrip.images.map((i) => i.id)).toEqual(ids);
  const explicit = await inspectProductImages(workspace, subject, captures, ["desktop"], groups);
  expect(explicit.groups.find((g) => g.id === "desktop")?.deliveredCaptureIds).toEqual(
    groups[2]?.captureIds,
  );
});

it("reports a viewport that cannot fit without splitting its journey endpoints", async () => {
  const groups = [320, 640, 960, 1280].map((width) =>
    group(String(width), [`${width}-start`, `${width}-end`], width),
  );
  const result = await inspectProductImages(
    workspace,
    subject,
    groups.flatMap((g) => g.captureIds.map((id) => capture(id, g.viewport.width))),
    [],
    groups,
  );
  expect(result.images).toHaveLength(6);
  expect(result.groups.find((g) => g.id === "1280")).toMatchObject({
    status: "not-delivered",
    omittedCaptureCount: 2,
  });
});

const keyed = (id: string, journeyKey: string, captureIds: string[], width = 1280) => ({
  ...group(id, captureIds, width),
  journeyKey,
});

it("keeps other journeys in the packet when one journey was replayed three times", async () => {
  const numbered = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
  const groups = [
    keyed("A3", "journey-a", numbered("A3", 5)),
    keyed("A2", "journey-a", numbered("A2", 5)),
    keyed("A1", "journey-a", numbered("A1", 5)),
    keyed("B", "journey-b", numbered("B", 3)),
  ];
  const captures = groups.flatMap((entry) => entry.captureIds.map((id) => capture(id)));
  const result = await inspectProductImages(workspace, subject, captures, [], groups);
  expect(result.images.map((entry) => entry.id)).toEqual([
    "A3-1",
    "A3-2",
    "A3-4",
    "A3-5",
    "B-1",
    "B-3",
  ]);
  expect(result.groups.map((entry) => [entry.id, entry.status])).toEqual([
    ["A3", "delivered"],
    ["B", "delivered"],
    ["A2", "not-delivered"],
    ["A1", "not-delivered"],
  ]);
});

it("keeps replays with different journey keys and spends the window on distinct journeys", async () => {
  const groups = ["one", "two", "three", "four"].map((id) =>
    keyed(id, `journey-${id}`, [`${id}-0`, `${id}-1`, `${id}-2`]),
  );
  const captures = groups.flatMap((entry) => entry.captureIds.map((id) => capture(id)));
  const result = await inspectProductImages(workspace, subject, captures, [], groups);
  expect(result.images.map((entry) => entry.id)).toEqual([
    "one-0",
    "one-2",
    "two-0",
    "two-2",
    "three-0",
    "three-2",
  ]);
  expect(result.groups.find((entry) => entry.id === "four")?.status).toBe("not-delivered");
});

it("gives unkeyed repeated groups at one viewport the same sample as before", async () => {
  const groups = ["new", "old"].map((id) =>
    group(id, [`${id}-0`, `${id}-1`, `${id}-2`, `${id}-3`]),
  );
  const captures = groups.flatMap((entry) => entry.captureIds.map((id) => capture(id)));
  const result = await inspectProductImages(workspace, subject, captures, [], groups);
  expect(result.groups.map((entry) => [entry.id, entry.status])).toEqual([
    ["new", "delivered"],
    ["old", "not-delivered"],
  ]);
  expect(result.images.map((entry) => entry.id)).toEqual(["new-0", "new-1", "new-2", "new-3"]);
});

it("drops older identical replays of a journey but keeps other outcomes, viewports and unkeyed runs", () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-replays",
    originalRequest: "Useful UI",
    goal: "Useful UI",
  });
  const run = (id: string, createdAt: string, extra: Record<string, unknown>) => ({
    id,
    version: 1,
    provenance: "runner-executed",
    subjectDigest: subject,
    createdAt,
    status: "completed",
    captures: [capture(`${id}-a`), capture(`${id}-b`), capture(`${id}-m`, 390)],
    ...extra,
  });
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: {
      ...initialProductState(brief, "2026-01-01"),
      captureRuns: [
        run("r1", "2026-01-01T00:00:01Z", { journeyKey: "k1" }),
        run("r2", "2026-01-01T00:00:02Z", { journeyKey: "k1" }),
        run("r3", "2026-01-01T00:00:03Z", { journeyKey: "k1", status: "failed" }),
        run("r4", "2026-01-01T00:00:04Z", { journeyKey: "k2" }),
        run("r5", "2026-01-01T00:00:05Z", {}),
        run("r6", "2026-01-01T00:00:06Z", {}),
      ],
    },
  };
  const groups = productReviewImageGroups(record, subject);
  expect(groups.map((entry) => entry.id)).toEqual([
    "image-group:r6:1280x720",
    "image-group:r6:390x720",
    "image-group:r5:1280x720",
    "image-group:r5:390x720",
    "image-group:r4:1280x720",
    "image-group:r4:390x720",
    "image-group:r3:1280x720",
    "image-group:r3:390x720",
    "image-group:r2:1280x720",
    "image-group:r2:390x720",
  ]);
  expect(groups.find((entry) => entry.runId === "r4")?.journeyKey).toBe("k2");
  expect(groups.find((entry) => entry.runId === "r6")).not.toHaveProperty("journeyKey");
});

it("keeps the newest of each identical replay among the last three capture runs", () => {
  const run = (id: string, journeyKey?: string, extra: Record<string, unknown> = {}) => ({
    id,
    ...(journeyKey ? { journeyKey } : {}),
    ...extra,
  });
  const runs = [
    run("old", "b"),
    run("a1", "a"),
    run("a2", "a"),
    run("a3", "a"),
    run("plain-1"),
    run("plain-2"),
  ];
  expect(newestRunPerJourney(runs, 3).map((entry) => entry.id)).toEqual([
    "a3",
    "plain-1",
    "plain-2",
  ]);
  expect(newestRunPerJourney(runs.slice(0, 4), 3).map((entry) => entry.id)).toEqual(["old", "a3"]);
  expect(newestRunPerJourney([{ note: "not a run" }, run("x")], 3)).toHaveLength(2);
  // A same-key failed reproduction is not replaced by a completed rerun, and vice versa.
  const reproduction = [
    run("failed", "a", { status: "failed", failure: { kind: "behavior" } }),
    run("timeout", "a", { status: "timed-out" }),
    run("completed", "a", { status: "completed" }),
    run("completed-2", "a", { status: "completed" }),
    run("other-captures", "a", { status: "completed", captures: [{ steps: ["Click"] }] }),
  ];
  expect(newestRunPerJourney(reproduction, 5).map((entry) => entry.id)).toEqual([
    "failed",
    "timeout",
    "completed-2",
    "other-captures",
  ]);
});

it("keeps an older failed group when a newer cancelled run has one image, and runs with other captures", () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-outcomes",
    originalRequest: "Useful UI",
    goal: "Useful UI",
  });
  const step = (steps: string[]) => (entry: ReturnType<typeof capture>) => ({ ...entry, steps });
  const run = (id: string, createdAt: string, extra: Record<string, unknown>) => ({
    id,
    version: 1,
    provenance: "runner-executed",
    subjectDigest: subject,
    createdAt,
    journeyKey: "k",
    ...extra,
  });
  const failedCaptures = ["f1", "f2", "f3", "f4", "f5"].map((id, index) =>
    step([`Drag ${index}`])(capture(id)),
  );
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: {
      ...initialProductState(brief, "2026-01-01"),
      captureRuns: [
        run("failed", "2026-01-01T00:00:01Z", {
          status: "failed",
          failure: { kind: "behavior" },
          captures: failedCaptures,
        }),
        run("cancelled", "2026-01-01T00:00:02Z", {
          status: "cancelled",
          captures: [step(["Drag 0"])(capture("c1"))],
        }),
        run("done-a", "2026-01-01T00:00:03Z", {
          status: "completed",
          captures: [step(["Open"])(capture("a1")), step(["Drag 0"])(capture("a2"))],
        }),
        run("done-b", "2026-01-01T00:00:04Z", {
          status: "completed",
          captures: [step(["Open"])(capture("b1")), step(["Drag 1"])(capture("b2"))],
        }),
        run("done-b-again", "2026-01-01T00:00:05Z", {
          status: "completed",
          captures: [step(["Open"])(capture("e1")), step(["Drag 1"])(capture("e2"))],
        }),
      ],
    },
  };
  const ids = productReviewImageGroups(record, subject).map((entry) => entry.runId);
  expect(ids).toEqual(["done-b-again", "done-a", "cancelled", "failed"]);
});
