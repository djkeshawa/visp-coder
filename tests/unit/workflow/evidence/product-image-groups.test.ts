import { expect, it, vi } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import { ok } from "../../../../src/core/result.js";
import {
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
