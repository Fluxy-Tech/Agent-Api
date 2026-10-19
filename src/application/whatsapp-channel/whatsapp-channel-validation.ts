import { z } from "zod";

/// Primeiro ano disponível no filtro dos gráficos "Fluxo de
/// conversas"/"Fluxo de mensagens" — nunca existe dado de antes disso.
export const MIN_SERIES_YEAR = 2024;

/// Período dos gráficos na tela de detalhe do canal: um ano específico
/// (granularidade mensal, Jan-Dez, a partir de MIN_SERIES_YEAR) ou
/// "current-month" (granularidade diária, mês corrente — só o gráfico de
/// mensagens oferece essa opção) — ver resolveSeriesWindow em
/// whatsapp-channel-service.ts.
export const seriesPeriodSchema = z
  .string()
  .default("current-month")
  .transform((value, ctx) => {
    if (value === "current-month") return "current-month" as const;

    const currentYear = new Date().getUTCFullYear();
    const year = Number(value);
    if (!/^\d{4}$/.test(value) || year < MIN_SERIES_YEAR || year > currentYear) {
      ctx.addIssue({
        code: "custom",
        message: `Período inválido — use "current-month" ou um ano entre ${MIN_SERIES_YEAR} e ${currentYear}.`,
      });
      return z.NEVER;
    }
    return year;
  });
export type SeriesPeriod = z.infer<typeof seriesPeriodSchema>;

/// Filtro de período do card "Gastos" (endpoint /campaigns-report) — sem
/// startDate/endDate, o relatório sai com o histórico completo do canal.
export const campaignReportFilterSchema = z.object({
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});
export type CampaignReportFilter = z.infer<typeof campaignReportFilterSchema>;

export const createWhatsappChannelSchema = z.object({
  /// Não é mais obrigatório: um canal pode nascer sem agente de IA (só
  /// atendimento humano). Quando informado, openAgent nasce true; quando
  /// omitido, openAgent nasce false (ver whatsapp-channel-service.ts).
  agentId: z.string().trim().min(1, "Agente inválido.").optional(),
  phoneNumberId: z.string().trim().min(1, "Phone Number ID é obrigatório."),
  displayNumber: z.string().trim().min(1, "Número de exibição é obrigatório."),
  wabaId: z.string().trim().min(1, "WhatsApp Business Account ID é obrigatório."),
  metaAccessToken: z.string().trim().min(1, "Token de acesso da Meta é obrigatório."),
});

export const updateWhatsappChannelSchema = createWhatsappChannelSchema.partial().extend({
  /// Liga/desliga o roteamento pro agente de IA deste canal especificamente
  /// (ver Channel.openAgent no schema). Não pode virar true sem um
  /// agentId (existente ou enviado na mesma requisição) — validado no service.
  openAgent: z.boolean().optional(),
  /// Id da fila (Queue) que recebe o atendimento quando openAgent=false.
  /// null explícito limpa a seleção; omitido não mexe no valor salvo.
  idServiceIslandDefault: z.string().trim().min(1, "Fila inválida.").nullish(),
  /// Palavras/frases-chave de reset de jornada (ver Channel.wordsToReset
  /// no schema). Enviado sempre como lista completa — substitui a anterior.
  wordsToReset: z.array(z.string().trim().min(1)).optional(),
  /// Mensagem enviada ao contato depois do reset de jornada. "" (string vazia)
  /// limpa e volta a usar a mensagem padrão do Piloto; omitido não mexe no
  /// valor salvo.
  resetMessage: z.string().trim().nullish(),
  /// Frases de bloqueio automático de campanha (ver Channel.wordsToBlockCampaign
  /// no schema). Enviado sempre como lista completa — substitui a anterior.
  wordsToBlockCampaign: z.array(z.string().trim().min(1)).optional(),
  /// Liga/desliga a avaliação de wordsToBlockCampaign para este canal.
  useWordsToBlockCampaign: z.boolean().optional(),
  /// Tempo de aguardo de mensagem em segundos (ver Channel.messageWaitSeconds
  /// no schema) — janela que agrupa as mensagens seguidas do contato.
  messageWaitSeconds: z
    .number()
    .int("O tempo de aguardo deve ser um número inteiro de segundos.")
    .min(1, "O tempo de aguardo de mensagem é de no mínimo 1 segundo.")
    .max(120, "O tempo de aguardo de mensagem é de no máximo 120 segundos.")
    .optional(),
});

export const wabaLookupSchema = z.object({
  wabaId: z.string().trim().min(1, "WhatsApp Business Account ID é obrigatório."),
  metaAccessToken: z.string().trim().min(1, "Token de acesso da Meta é obrigatório."),
});

export const bulkCreateWhatsappChannelSchema = z.object({
  /// Mesma regra do cadastro individual: opcional. Sem agente, cada canal
  /// criado nasce com openAgent=false (ver whatsapp-channel-service.ts).
  agentId: z.string().trim().min(1, "Agente inválido.").optional(),
  wabaId: z.string().trim().min(1, "WhatsApp Business Account ID é obrigatório."),
  metaAccessToken: z.string().trim().min(1, "Token de acesso da Meta é obrigatório."),
  phoneNumbers: z
    .array(
      z.object({
        phoneNumberId: z.string().trim().min(1),
        displayNumber: z.string().trim().min(1),
      }),
    )
    .min(1, "Selecione ao menos um número para cadastrar."),
});

export type CreateWhatsappChannelInput = z.infer<typeof createWhatsappChannelSchema>;
export type UpdateWhatsappChannelInput = z.infer<typeof updateWhatsappChannelSchema>;
export type WabaLookupInput = z.infer<typeof wabaLookupSchema>;
export type BulkCreateWhatsappChannelInput = z.infer<typeof bulkCreateWhatsappChannelSchema>;
