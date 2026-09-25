import { z } from "zod";

const replyText = z
  .string()
  .refine((value) => value.trim().length > 0, "User feedback cannot be blank");
export const userFeedbackAnswerSchema = z.union([
  z.object({ action: z.literal("answer"), text: replyText }).strict(),
  z.object({ action: z.literal("defer") }).strict(),
]);

export const userFeedbackRequestSchema = z
  .object({
    feature: z.string().optional(),
    task: z.string().optional(),
    operation: z.enum(["status", "ask", "reply", "defer"]).default("status"),
    id: z.string().uuid().optional(),
    question: z.string().trim().min(1).optional(),
    context: z.string().trim().min(1).optional(),
    reply: replyText.optional(),
  })
  .strict();
export type UserFeedbackRequest = z.infer<typeof userFeedbackRequestSchema>;

export const userFeedbackRecordSchema = z
  .object({
    id: z.string().uuid(),
    task: z.string().optional(),
    question: z.string(),
    context: z.string().optional(),
    subject: z.string(),
    contract: z.string(),
    createdAt: z.string(),
    status: z.enum(["pending", "answered", "deferred"]),
    dispatchClaimed: z.boolean().optional(),
    deliveryIssue: z.string().optional(),
    reply: z.string().optional(),
    respondedAt: z.string().optional(),
    provenance: z.enum(["caller-reported", "host-elicited"]),
  })
  .strict();
export type UserFeedbackRecord = z.infer<typeof userFeedbackRecordSchema>;
export type UserFeedbackPrompt = {
  id: string;
  question: string;
  originalRequest: string;
  objective: string;
  context?: string;
};
export interface UserFeedbackHost {
  ask(
    prompt: UserFeedbackPrompt,
    options: { signal?: AbortSignal },
  ): Promise<{ action: "answer"; text: string } | { action: "defer" }>;
}
