import { z } from "zod";

export const agentFunctionTypeSchema = z.enum(["CALENDAR_EVENT", "KANBAN_CARD"], { message: "Função inválida." });

export const updateAgentFunctionSchema = z.object({
  runAtStart: z.boolean(),
  runAfterMetadata: z.boolean(),
  /// Só KANBAN_CARD: estágio em que o card nasce. Ausente = mantém o atual;
  /// null = estágio padrão ("Início").
  crmStageId: z.string().trim().min(1).nullable().optional(),
});

export const updateAgentFunctionSettingsSchema = z.object({
  handoffAfterFunctions: z.boolean(),
});

export type UpdateAgentFunctionInput = z.infer<typeof updateAgentFunctionSchema>;
export type UpdateAgentFunctionSettingsInput = z.infer<typeof updateAgentFunctionSettingsSchema>;
