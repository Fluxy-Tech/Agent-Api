import { z } from "zod";

const templateParameterSchema = z.object({ type: z.string(), text: z.string() });

export const campaignContactSchema = z.object({
  phone: z.string().trim().min(8, "Telefone obrigatório."),
  email: z.string().trim().email().optional().or(z.literal("")),
  name: z.string().trim().optional(),
  parametersHeader: z.array(templateParameterSchema).optional(),
  parametersBody: z.array(templateParameterSchema).optional(),
  parametersButton: z.array(templateParameterSchema).optional(),
  buttonSubType: z.string().optional(),
});

export const createCampaignSchema = z
  .object({
    whatsappChannelId: z.string().trim().min(1, "Selecione um WhatsApp Channel."),
    name: z.string().trim().min(1, "Informe um nome para a campanha."),
    templateName: z.string().trim().min(1, "Selecione um template."),
    category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
    language: z.string().trim().min(1, "Template sem idioma definido."),
    dispatchType: z.enum(["CSV", "MANUAL"]).default("CSV"),
    templateHeaderText: z.string().optional(),
    templateBodyText: z.string().optional(),
    contacts: z.array(campaignContactSchema).min(1, "Envie ao menos 1 contato."),
    /// Se preenchido, cada contato atingido com sucesso vira um Ticket nesta
    /// fila (Target sai de AI e vira HUMAN) em vez de continuar com a IA.
    routeToQueueId: z.string().trim().min(1).optional(),
    /// Só válido junto de routeToQueueId — atendente específico assume o
    /// ticket direto (IN_PROGRESS) em vez de cair WAITING na fila.
    routeToUserId: z.string().trim().min(1).optional(),
    /// Disparo em massa (CSV): quantos contatos enviar por lote e quantos
    /// minutos esperar entre um lote e o próximo.
    batchSize: z.coerce.number().int().min(1, "Informe ao menos 1 disparo por lote.").optional(),
    batchIntervalMinutes: z.coerce.number().int().min(1, "O intervalo mínimo é de 1 minuto.").optional(),
    /// Data/hora para começar o disparo — ausente = começa agora.
    scheduledAt: z.coerce.date().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.dispatchType === "CSV" && (!data.batchSize || !data.batchIntervalMinutes)) {
      ctx.addIssue({
        code: "custom",
        path: ["batchSize"],
        message: "Disparo em massa exige a quantidade de disparos por lote e o intervalo entre lotes.",
      });
    }
    // Pequena folga pra não recusar um horário escolhido "pra agora" que
    // chegou alguns segundos atrasado.
    if (data.scheduledAt && data.scheduledAt.getTime() < Date.now() - 60_000) {
      ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "A data de agendamento precisa ser futura." });
    }
  });

/// PATCH /api/campaigns/:id/active — pausa (false) ou retoma (true) um disparo escalonado.
export const setCampaignActiveSchema = z.object({ active: z.boolean() });

/// PATCH /api/campaigns/:id/destination — só com a campanha pausada. Sem
/// routeToQueueId = os contatos seguem com o Agente de IA; com = vão para o
/// Atendimento humano naquela fila.
export const updateCampaignDestinationSchema = z.object({
  routeToQueueId: z.string().trim().min(1).nullable().optional(),
  routeToUserId: z.string().trim().min(1).nullable().optional(),
});

export const checkBlockedContactsSchema = z.object({
  whatsappChannelId: z.string().trim().min(1, "Selecione uma rede social."),
  phones: z.array(z.string().trim().min(1)).min(1, "Informe ao menos um telefone."),
});

export const listCampaignsFilterSchema = z.object({
  agentId: z.string().trim().optional(),
  whatsappChannelId: z.string().trim().optional(),
  search: z.string().trim().optional(),
  status: z.enum(["PROCESSING", "COMPLETED"]).optional(),
  templateName: z.string().trim().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export const listCampaignsQuerySchema = listCampaignsFilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type CheckBlockedContactsInput = z.infer<typeof checkBlockedContactsSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type ListCampaignsFilter = z.infer<typeof listCampaignsFilterSchema>;
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;
export type UpdateCampaignDestinationInput = z.infer<typeof updateCampaignDestinationSchema>;
