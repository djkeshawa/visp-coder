import type { QueryRow } from "../../graph/index.js";
import type { RelevantMemoryNote } from "../../memory/store.js";
import type { criticUnderstanding } from "./critic-understanding.js";
import type { currentJourneyFeedback } from "./evidence-references.js";
import type { productFeedbackPlan } from "./feedback.js";
import type { ProductAssessment, ProductBrief, ProductSlice } from "./model.js";
import type { ProductNext } from "./status.js";

export interface ProductContextContent {
  /** Current product-review routing, after any recorded observations. */
  readonly criticAdvice?: ProductNext["criticAdvice"];
  readonly criticUnderstanding?: Extract<
    Awaited<ReturnType<typeof criticUnderstanding>>,
    { ok: true }
  >["value"];
  /** Acceptance tests an independent tester wrote from the original request. */
  readonly independentTests?: import("./independent-tests.js").IndependentTestsSummary;
  readonly userFeedback?: ReturnType<typeof import("./user-feedback.js").userFeedbackPlan>;
  readonly feedbackPlan?: ReturnType<typeof productFeedbackPlan>;
  readonly feature: string;
  readonly task: string;
  readonly taskClass?: ProductSlice["taskClass"];
  readonly originalRequest: string;
  readonly objective: string;
  readonly outcomes: ProductBrief["outcomes"];
  readonly examples: ProductBrief["examples"];
  readonly decisions: ProductBrief["decisions"];
  readonly uncertainties: readonly string[];
  readonly scope: ProductSlice["scope"];
  readonly checks: ProductBrief["checks"];
  readonly files: readonly { path: string; content: string; truncated: boolean }[];
  readonly graph: readonly QueryRow[];
  /** Released project memory is advisory and may be stale; see each item's labels. */
  readonly memory?: readonly RelevantMemoryNote[];
  readonly notes: readonly string[];
  readonly mayEdit: boolean;
  readonly subjectDigest: string;
  readonly skills: readonly {
    path: string;
    content: string;
    truncated: boolean;
    reason: "skill";
    advisory: true;
  }[];
  readonly reviewFeedback: readonly {
    subjectDigest: string;
    current: boolean;
    assessments: readonly ProductAssessment[];
    summary?: string;
    limitations?: readonly string[];
  }[];
  readonly acceptanceBaseline?: ProductBrief["acceptanceBaseline"];
  readonly journeyFailures?: readonly string[];
  readonly journeyFeedback?: ReturnType<typeof currentJourneyFeedback>;
  readonly feedback: readonly {
    check: string;
    status: string;
    output: string;
    current: boolean;
    truncated?: boolean;
  }[];
}

export interface ProductWorkContext extends ProductContextContent {
  readonly budget: {
    readonly tokenBudget: number;
    readonly estimatedTokens: number;
    readonly status: "within-budget" | "essential-overflow";
    readonly omitted: {
      readonly files: number;
      readonly graphRows: number;
      readonly memory: number;
      readonly skills: number;
      readonly feedbackCharacters: number;
      readonly probes?: number;
      readonly observationGuidance?: boolean;
    };
    readonly sources: readonly string[];
  };
}
