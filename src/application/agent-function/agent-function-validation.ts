import { z } from "zod";

export const agentFunctionTypeSchema = z.enum(["CALENDAR_EVENT", "KANBAN_CARD"], { message: "Função inválida." });

export const updateAgentFunctionSchema = z.object({
  runAtStart: z.boolean(),
  runAfterMetadata: z.boolean(),
});

export type UpdateAgentFunctionInput = z.infer<typeof updateAgentFunctionSchema>;
