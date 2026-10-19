import { z } from "zod";

const optionalMessage = z.string().trim().optional();

export const createAgentSchema = z.object({
  name: z.string().trim().min(1, "Nome é obrigatório."),
  isActive: z.boolean().optional(),

  processingMessage: optionalMessage,
  transferMessage: optionalMessage,
  unsupportedFormatMessage: optionalMessage,
  blockedMessage: optionalMessage,

  outOfHoursMessage: optionalMessage,
  outOfHoursEnabled: z.boolean().optional(),

  closingMessage: optionalMessage,
  closingEnabled: z.boolean().optional(),

  errorMessage: optionalMessage,
  errorEnabled: z.boolean().optional(),

  defaultQueueId: z.string().trim().min(1).nullable().optional(),

  personality: optionalMessage,
  ragEnabled: z.boolean().optional(),
  ragChunkSize: z.number().int().min(100).max(4000).optional(),

  /// RGBS — quebra a resposta em várias mensagens ([QB]) e espera, antes de
  /// cada uma, o tempo (segundos) da faixa de tamanho dela.
  rgbsEnabled: z.boolean().optional(),
  timeSmall: z.number().int().min(1, "O tempo para mensagens pequenas é de no mínimo 1 segundo.").max(300).optional(),
  timeMedium: z.number().int().min(4, "O tempo para mensagens médias é de no mínimo 4 segundos.").max(300).optional(),
  timeLarge: z.number().int().min(8, "O tempo para mensagens grandes é de no mínimo 8 segundos.").max(300).optional(),

  /// Últimas mensagens trocadas que vão pro modelo a cada resposta (ver
  /// Agent.limitHistoryToAgent no schema).
  limitHistoryToAgent: z
    .number()
    .int("O histórico enviado ao agente deve ser um número inteiro de mensagens.")
    .min(2, "O histórico enviado ao agente é de no mínimo 2 mensagens.")
    .max(50, "O histórico enviado ao agente é de no máximo 50 mensagens.")
    .optional(),

  /// Em claro aqui só nesta requisição — cifrados antes de gravar (ver
  /// agent-service.ts). Ausente/vazio = mantém o token já salvo, nunca limpa.
  openaiToken: z.string().trim().min(1).optional(),
  geminiToken: z.string().trim().min(1).optional(),
});

export const updateAgentSchema = createAgentSchema.partial();

/// includeDeleted=true é usado só pelos seletores de FILTRO (Contatos,
/// Campanhas) — telas de configuração (lista de agentes, vínculo de
/// WhatsApp Channel) nunca passam isso, então continuam vendo só os ativos.
export const listAgentsQuerySchema = z.object({
  includeDeleted: z.coerce.boolean().optional(),
});

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
