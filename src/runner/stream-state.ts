import { adapterFor, object } from "./adapters.js";
import type { EventJournal } from "./artifacts.js";
import { sameCommand } from "./command-observation.js";
import type { HostEvent, NormalizedUsage, RunnerSpec } from "./contracts.js";
import type { StreamResult } from "./process.js";
import { estimateUsage } from "./run-support.js";

type LifecycleKind = "tool" | "command" | "shared";

export interface HostObservations {
  readonly tools: readonly string[];
  readonly hooks: readonly string[];
  readonly commands: readonly (readonly string[])[];
}

export class HostStreamState {
  readonly usage: NormalizedUsage[] = [];
  readonly diagnostics: string[] = [];
  sessionId: string | null;
  terminal: "completed" | "failed" | undefined;
  private hostEstimatedUsd: number | undefined;
  private readonly observedTools = new Set<string>();
  private readonly observedHooks = new Set<string>();
  private readonly observedCommands: (readonly string[])[] = [];
  private readonly pendingToolCalls = new Map<string, string>();
  private readonly finishedToolCallIds = new Set<string>();
  private readonly pendingCommandCalls = new Map<string, readonly string[] | undefined>();
  private readonly finishedCommandCallIds = new Set<string>();
  private readonly lifecycleKinds = new Map<string, LifecycleKind>();
  private readonly sharedCallIds = new Set<string>();
  private static readonly maxPendingCalls = 256;
  private static readonly maxTrackedCallIds = 10_000;

  constructor(
    readonly spec: RunnerSpec,
    readonly journal: EventJournal,
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? null;
  }

  get estimatedUsd(): number | null {
    return this.hostEstimatedUsd ?? estimateUsage(this.usage, this.spec);
  }

  get observations(): HostObservations {
    return {
      tools: [...this.observedTools],
      hooks: [...this.observedHooks],
      commands: [...this.observedCommands],
    };
  }

  accept(line: string): "budget-exceeded" | undefined {
    let row: Record<string, unknown>;
    let event: HostEvent;
    try {
      row = object(JSON.parse(line), "Host JSON event");
      event = adapterFor(this.spec.host.kind).parse(row, this.spec.host.model);
    } catch (cause) {
      this.journal.append({
        source: this.spec.host.kind,
        rawLine: line,
        parserError: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
    this.journal.append({ source: this.spec.host.kind, raw: row, normalized: event });
    this.observeEvent(event);
    const cost = this.estimatedUsd;
    return cost !== null && cost >= this.spec.budget.maxEstimatedUsd
      ? "budget-exceeded"
      : undefined;
  }

  finish(execution: StreamResult): void {
    if (execution.error) this.diagnostics.push(execution.error);
    if (!this.sessionId) this.diagnostics.push("Host did not report a session identity");
    if (!this.terminal) this.diagnostics.push("Host stream ended without a terminal result");
    if (!this.usage.length) this.diagnostics.push("Host did not report attributable token usage");
    this.diagnostics.push(...harnessRequirementGaps(this.spec.harness, this.observations));
    for (const row of this.usage) {
      if (row.model !== this.spec.host.model)
        this.diagnostics.push(`Usage includes an unpinned model: ${row.model}`);
    }
    if (this.estimatedUsd === null) this.diagnostics.push("Complete priced usage is unavailable");
  }

  private observeIdentity(event: HostEvent): void {
    if (event.sessionId) {
      if (this.sessionId && this.sessionId !== event.sessionId)
        throw new Error("Host session identity changed during the attempt");
      this.sessionId = event.sessionId;
    }
    if (event.reportedModel && event.reportedModel !== this.spec.host.model)
      this.diagnostics.push(`Host reported a different model: ${event.reportedModel}`);
  }

  private observeEvent(event: HostEvent): void {
    if (this.terminal) {
      this.observeAfterTerminal(event);
      return;
    }
    this.observeIdentity(event);
    if (event.usage) this.usage.push(...event.usage);
    if (event.estimatedUsd !== undefined) this.hostEstimatedUsd = event.estimatedUsd;
    for (const tool of event.observedTools ?? []) this.observedTools.add(tool);
    for (const hook of event.observedHooks ?? []) this.observedHooks.add(hook);
    const sharedCallIds = this.sharedCallIdsFor(event);
    for (const call of event.toolCalls ?? []) this.observeToolCall(call, sharedCallIds);
    for (const call of event.commandCalls ?? []) this.observeCommandCall(call, sharedCallIds);
    if (event.type === "completed" || event.type === "failed") this.observeTerminal(event.type);
  }

  private observeAfterTerminal(event: HostEvent): void {
    if (
      event.type === "started" ||
      event.sessionId !== undefined ||
      event.usage !== undefined ||
      event.estimatedUsd !== undefined ||
      event.observedTools !== undefined ||
      event.observedHooks !== undefined ||
      event.reportedModel !== undefined ||
      event.toolCalls !== undefined ||
      event.commandCalls !== undefined
    )
      this.diagnostics.push("Host emitted evidence after terminal result");
    if (event.type === "completed" || event.type === "failed") this.observeTerminal(event.type);
  }

  private sharedCallIdsFor(event: HostEvent): ReadonlySet<string> {
    const commandStarts = new Set(
      (event.commandCalls ?? [])
        .filter((call) => call.outcome === "started")
        .map((call) => call.id),
    );
    for (const call of event.toolCalls ?? []) {
      if (
        call.name === "Bash" &&
        call.outcome === "started" &&
        commandStarts.has(call.id) &&
        !this.lifecycleKinds.has(call.id)
      ) {
        this.sharedCallIds.add(call.id);
      }
    }
    return this.sharedCallIds;
  }

  private observeTerminal(type: "completed" | "failed"): void {
    if (this.terminal) throw new Error("Host emitted more than one terminal event");
    this.terminal = type;
  }

  private observeToolCall(
    call: NonNullable<HostEvent["toolCalls"]>[number],
    sharedCallIds: ReadonlySet<string>,
  ): void {
    if (this.finishedToolCallIds.has(call.id)) return;
    const allowShared =
      sharedCallIds.has(call.id) && (call.outcome !== "started" || call.name === "Bash");
    if (!this.claimLifecycleKind(call.id, "tool", allowShared)) {
      this.invalidateCallIdentity(
        call.id,
        `Call identity was reused across tool and command lifecycles: ${call.id}`,
      );
      return;
    }
    const name = this.pendingToolCalls.get(call.id);
    if (
      !name &&
      this.pendingToolCalls.size + this.finishedToolCallIds.size >=
        HostStreamState.maxTrackedCallIds
    )
      throw new Error("Host exceeded 10000 distinct tool call identities");
    if (call.outcome === "started") {
      this.observeToolStart(call, name);
      return;
    }
    this.pendingToolCalls.delete(call.id);
    this.finishedToolCallIds.add(call.id);
    if (name && call.name && call.name !== name) {
      this.diagnostics.push(`Tool completion changed the name for identity: ${call.id}`);
      return;
    }
    // Codex completion events carry their own tool identity; Claude results do not.
    const completedName = name ?? (this.spec.host.kind === "codex" ? call.name : undefined);
    if (call.outcome === "completed" && completedName) this.observedTools.add(completedName);
  }

  private observeToolStart(
    call: NonNullable<HostEvent["toolCalls"]>[number],
    pendingName: string | undefined,
  ): void {
    if (pendingName) {
      this.invalidateCallIdentity(call.id, `Duplicate pending tool call identity: ${call.id}`);
      return;
    }
    if (!call.name) return;
    if (this.pendingToolCalls.size >= HostStreamState.maxPendingCalls)
      throw new Error("Host exceeded 256 pending tool calls");
    this.pendingToolCalls.set(call.id, call.name);
  }

  private observeCommandCall(
    call: NonNullable<HostEvent["commandCalls"]>[number],
    sharedCallIds: ReadonlySet<string>,
  ): void {
    if (this.finishedCommandCallIds.has(call.id)) return;
    const pending = this.pendingCommandCalls.has(call.id);
    const startedCommand = this.pendingCommandCalls.get(call.id);
    if (this.ignoreUnmatchedCommandResult(call, pending)) return;
    if (!this.claimLifecycleKind(call.id, "command", sharedCallIds.has(call.id))) {
      this.invalidateCallIdentity(
        call.id,
        `Call identity was reused across tool and command lifecycles: ${call.id}`,
      );
      return;
    }
    if (
      !pending &&
      this.pendingCommandCalls.size + this.finishedCommandCallIds.size >=
        HostStreamState.maxTrackedCallIds
    )
      throw new Error("Host exceeded 10000 distinct command call identities");
    if (call.outcome === "started") {
      if (pending) {
        this.invalidateCallIdentity(call.id, `Duplicate pending command call identity: ${call.id}`);
        return;
      }
      if (this.pendingCommandCalls.size >= HostStreamState.maxPendingCalls)
        throw new Error("Host exceeded 256 pending command calls");
      this.pendingCommandCalls.set(call.id, call.argv);
      return;
    }
    this.pendingCommandCalls.delete(call.id);
    this.finishedCommandCallIds.add(call.id);
    if (pending && call.argv && !sameCommand(startedCommand, call.argv)) {
      this.diagnostics.push(`Command completion changed the command for identity: ${call.id}`);
      return;
    }
    if (
      call.outcome === "completed" &&
      pending &&
      startedCommand &&
      (this.spec.host.kind === "claude" || call.argv !== undefined)
    )
      this.observedCommands.push(startedCommand);
  }

  private invalidateCallIdentity(id: string, diagnostic: string): void {
    this.pendingToolCalls.delete(id);
    this.pendingCommandCalls.delete(id);
    this.finishedToolCallIds.add(id);
    this.finishedCommandCallIds.add(id);
    this.diagnostics.push(diagnostic);
  }

  private claimLifecycleKind(id: string, kind: "tool" | "command", allowShared: boolean): boolean {
    const existing = this.lifecycleKinds.get(id);
    if (!existing || existing === kind) {
      this.lifecycleKinds.set(id, kind);
      return true;
    }
    if (!allowShared) return false;
    this.lifecycleKinds.set(id, "shared");
    return true;
  }

  private ignoreUnmatchedCommandResult(
    call: NonNullable<HostEvent["commandCalls"]>[number],
    pending: boolean,
  ): boolean {
    if (pending || call.outcome === "started" || this.lifecycleKinds.get(call.id) !== "tool")
      return false;
    this.finishedCommandCallIds.add(call.id);
    return true;
  }
}

export function harnessRequirementGaps(
  harness: RunnerSpec["harness"],
  observed: HostObservations,
): string[] {
  const gaps: string[] = [];
  for (const [kind, required, values] of [
    ["tool", harness.requiredTools, observed.tools],
    ["hook", harness.requiredHooks, observed.hooks],
  ] as const) {
    const present = new Set(values);
    for (const value of required)
      if (!present.has(value)) gaps.push(`Required ${kind} was not observed: ${value}`);
  }
  for (const command of harness.requiredCommands ?? [])
    if (!observed.commands.some((actual) => sameCommand(actual, command)))
      gaps.push(`Required command was not observed: ${JSON.stringify(command)}`);
  return gaps;
}
