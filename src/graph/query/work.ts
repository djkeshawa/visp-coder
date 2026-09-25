import { clampBudget } from "./budget.js";
import type { QueryBudget, QueryWork } from "./types.js";

/** Counts actual traversal work, including edges rejected by a relation filter. */
export class TraversalWork {
  private readonly budget: Required<QueryBudget>;
  private nodes = 0;
  private edges = 0;
  private cut = false;

  constructor(budget: QueryBudget) {
    this.budget = clampBudget(budget);
  }

  visit(): boolean {
    if (this.nodes >= this.budget.nodes) {
      this.cut = true;
      return false;
    }
    this.nodes += 1;
    return true;
  }

  examine(): boolean {
    if (this.edges >= this.budget.edges) {
      this.cut = true;
      return false;
    }
    this.edges += 1;
    return true;
  }

  receipt(): QueryWork {
    return { visitedNodes: this.nodes, examinedEdges: this.edges, truncated: this.cut };
  }

  notes(): string[] {
    return this.cut
      ? [
          "Traversal work budget exhausted; results and discovered unknowns are incomplete. Increase the nodes/edges budget to continue investigating.",
        ]
      : [];
  }
}
