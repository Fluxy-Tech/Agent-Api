import { z } from "zod";

export const createStageSchema = z.object({
  nameStage: z.string().trim().min(1, "Nome do estágio obrigatório."),
  position: z.coerce.number().int().min(1, "Posição precisa ser um número inteiro a partir de 1."),
});

export const updateStageSchema = z.object({
  nameStage: z.string().trim().min(1, "Nome do estágio obrigatório."),
});

export const moveCardSchema = z.object({
  stagesCrmId: z.string().trim().min(1, "Selecione um estágio."),
});

export const updatePrioritySchema = z.object({
  statusPriority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"], { message: "Prioridade inválida." }),
});

export const presignAttachmentSchema = z.object({
  fileName: z.string().trim().min(1, "Nome do arquivo é obrigatório."),
  contentType: z.string().trim().min(1).default("application/octet-stream"),
});

export const addAttachmentSchema = z.object({
  s3Key: z.string().trim().min(1, "Arquivo não foi enviado."),
});

export const removeAttachmentQuerySchema = z.object({
  s3Key: z.string().trim().min(1, "Informe o arquivo."),
});

export const createCommentSchema = z.object({
  comment: z.string().trim().min(1, "Escreva um comentário.").max(2000, "Comentário muito longo (máx. 2000 caracteres)."),
});

export type CreateStageInput = z.infer<typeof createStageSchema>;
export type UpdateStageInput = z.infer<typeof updateStageSchema>;
export type MoveCardInput = z.infer<typeof moveCardSchema>;
export type UpdatePriorityInput = z.infer<typeof updatePrioritySchema>;
export type PresignAttachmentInput = z.infer<typeof presignAttachmentSchema>;
export type AddAttachmentInput = z.infer<typeof addAttachmentSchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

/// Etapa do funil: `value` só é obrigatório (e só é guardado) quando
/// useValue=true — sem ele a etapa só confere se a chave existe no metadata.
export const funnelFieldSchema = z
  .object({
    name: z.string().trim().min(1, "Nome do campo obrigatório."),
    value: z.string().trim().optional().nullable(),
    useValue: z.boolean().default(false),
  })
  .refine((data) => !data.useValue || (data.value && data.value.length > 0), {
    message: "Informe o valor esperado ou desative a comparação por valor.",
    path: ["value"],
  })
  .transform((data) => ({ ...data, value: data.useValue ? data.value! : null }));

export type FunnelFieldInput = z.infer<typeof funnelFieldSchema>;

// ---------- CALENDÁRIO ----------

const EVENT_STATUS_VALUES = ["FINISHED", "RESCHEDULED", "CANCELED"] as const;

export const listCalendarEventsQuerySchema = z.object({
  from: z.coerce.date({ message: "Data inicial inválida." }),
  to: z.coerce.date({ message: "Data final inválida." }),
});

export const createCalendarEventSchema = z.object({
  name: z.string().trim().min(1, "Nome do evento obrigatório."),
  description: z.string().trim().max(5000).optional().nullable(),
  dateEvent: z.coerce.date({ message: "Data do evento inválida." }),
  targetId: z.string().trim().min(1, "Selecione o contato do evento."),
});

/// Todos opcionais — a tela manda só o que mudou. status null = volta a "Agendado".
export const updateCalendarEventSchema = z.object({
  name: z.string().trim().min(1, "Nome do evento obrigatório.").optional(),
  description: z.string().trim().max(5000).optional().nullable(),
  dateEvent: z.coerce.date({ message: "Data do evento inválida." }).optional(),
  targetId: z.string().trim().min(1).optional(),
  status: z.enum(EVENT_STATUS_VALUES, { message: "Status inválido." }).nullable().optional(),
  isClosed: z.boolean().optional(),
});

export const calendarAnnotationSchema = z.object({
  message: z.string().trim().min(1, "Escreva a anotação.").max(2000, "Anotação muito longa (máx. 2000 caracteres)."),
});

export const calendarTargetSearchQuerySchema = z.object({
  q: z.string().trim().optional(),
});

export type CreateCalendarEventInput = z.infer<typeof createCalendarEventSchema>;
export type UpdateCalendarEventInput = z.infer<typeof updateCalendarEventSchema>;
export type CalendarAnnotationInput = z.infer<typeof calendarAnnotationSchema>;

export const updateCrmSettingsSchema = z.object({
  calendar: z.object({
    userIds: z.array(z.string().trim().min(1)),
    visibleToAgent: z.boolean(),
  }),
  kanban: z.object({
    userIds: z.array(z.string().trim().min(1)),
    /// null = sem limite de cards por usuário.
    maxCardsPerUser: z.number().int().min(1, "O limite precisa ser de pelo menos 1 card.").nullable(),
    visibleToAgent: z.boolean(),
  }),
});

export type UpdateCrmSettingsInput = z.infer<typeof updateCrmSettingsSchema>;
