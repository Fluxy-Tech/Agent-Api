import { z } from "zod";

/// Limites da Meta para mensagens interativas — conferidos aqui pra que a
/// configuração salva nunca gere um envio recusado pela Graph API.
export const META_LIMITS = {
  buttonText: 20,
  headerText: 60,
  footerText: 60,
  listSectionTitle: 24,
  listRowTitle: 24,
  listRowDescription: 72,
  listMaxRows: 10,
  listMaxSections: 10,
  replyButtons: 3,
  carouselMinCards: 2,
  carouselMaxCards: 10,
  carouselCardBody: 160,
  flowCta: 30,
} as const;

export const AGENT_FEATURE_TYPES = [
  "CATALOG",
  "PRODUCT_CAROUSEL",
  "CTA_URL",
  "LIST",
  "REPLY_BUTTONS",
  "MEDIA_CAROUSEL",
  "LOCATION_REQUEST",
  "CONTEXTUAL_REPLY",
  "LINK_PREVIEW",
  "PAYMENT",
  "FLOW",
] as const;
export type AgentFeatureType = (typeof AGENT_FEATURE_TYPES)[number];

/// Só uma por agente — as demais podem ter várias instâncias.
export const SINGLE_INSTANCE_FEATURES: AgentFeatureType[] = ["LOCATION_REQUEST", "CONTEXTUAL_REPLY", "PAYMENT"];

/// Tipos em que o "quando usar" é opcional.
const PROMPT_OPTIONAL: AgentFeatureType[] = ["CONTEXTUAL_REPLY", "PAYMENT"];

const maxChars = (max: number) => `Use no máximo ${max} caracteres.`;
const optionalText = (max: number) => z.string().trim().max(max, maxChars(max)).optional().default("");
const url = z.string().trim().url("Informe um link válido (com https://).");

/// "agent" = a IA escolhe os itens; "manual" = definidos no Console;
/// "integration" = vêm do sistema do cliente (função de integração do AI-Worker).
const source = z.enum(["agent", "manual", "integration"]);

const catalogConfig = z.object({
  catalogId: z.string().trim().min(1, "Selecione o catálogo."),
  catalogName: z.string().trim().default(""),
});

const productCarouselConfig = catalogConfig
  .extend({
    source: source.default("agent"),
    productIds: z.array(z.string().trim().min(1)).max(META_LIMITS.carouselMaxCards, `Máximo de ${META_LIMITS.carouselMaxCards} cards.`).default([]),
  })
  .superRefine((config, ctx) => {
    if (config.source === "manual" && config.productIds.length < META_LIMITS.carouselMinCards) {
      ctx.addIssue({ code: "custom", path: ["productIds"], message: "Escolha de 2 a 10 produtos para o carrossel." });
    }
  });

const ctaUrlConfig = z.object({
  url,
  displayText: z.string().trim().min(1, "Informe o texto do botão.").max(META_LIMITS.buttonText, maxChars(META_LIMITS.buttonText)),
  headerText: optionalText(META_LIMITS.headerText),
  footerText: optionalText(META_LIMITS.footerText),
});

const listConfig = z
  .object({
    buttonText: z.string().trim().min(1, "Informe o texto do botão da lista.").max(META_LIMITS.buttonText, maxChars(META_LIMITS.buttonText)),
    headerText: optionalText(META_LIMITS.headerText),
    footerText: optionalText(META_LIMITS.footerText),
    sections: z
      .array(
        z.object({
          title: z.string().trim().min(1, "Informe o título da seção.").max(META_LIMITS.listSectionTitle, maxChars(META_LIMITS.listSectionTitle)),
          rows: z
            .array(
              z.object({
                id: z.string().trim().min(1).max(200, maxChars(200)),
                title: z.string().trim().min(1, "Informe o título da opção.").max(META_LIMITS.listRowTitle, maxChars(META_LIMITS.listRowTitle)),
                description: optionalText(META_LIMITS.listRowDescription),
              }),
            )
            .min(1, "Cada seção precisa de ao menos uma opção."),
        }),
      )
      .min(1, "Adicione ao menos uma seção.")
      .max(META_LIMITS.listMaxSections, `Máximo de ${META_LIMITS.listMaxSections} seções.`),
  })
  .superRefine((config, ctx) => {
    const rows = config.sections.flatMap((s) => s.rows);
    if (rows.length > META_LIMITS.listMaxRows) {
      ctx.addIssue({ code: "custom", path: ["sections"], message: "A lista pode ter no máximo 10 opções no total." });
    }
    const titles = rows.map((r) => r.title.toLowerCase());
    if (new Set(titles).size !== titles.length) {
      ctx.addIssue({ code: "custom", path: ["sections"], message: "As opções da lista precisam ter títulos diferentes." });
    }
  });

const replyButtonsConfig = z
  .object({
    /// "fixed" = a IA só usa os botões definidos aqui; "free" = a IA cria os
    /// botões (até 3), seguindo as regras.
    mode: z.enum(["fixed", "free"]).default("free"),
    buttons: z.array(z.string().trim().min(1).max(META_LIMITS.buttonText, maxChars(META_LIMITS.buttonText))).max(META_LIMITS.replyButtons, `Máximo de ${META_LIMITS.replyButtons} botões.`).default([]),
    /// O que a IA pode ou não pode usar como botão.
    rules: optionalText(1000),
  })
  .superRefine((config, ctx) => {
    if (config.mode === "fixed" && config.buttons.length === 0) {
      ctx.addIssue({ code: "custom", path: ["buttons"], message: "Defina de 1 a 3 botões." });
    }
  });

const mediaCarouselConfig = z
  .object({
    source: z.enum(["manual", "integration"]).default("manual"),
    cards: z
      .array(
        z.object({
          mediaType: z.enum(["image", "video"]).default("image"),
          /// Arquivo enviado pelo Console (chave no S3 — o Inbound-Service gera
          /// a URL assinada no envio) ou link público externo.
          mediaKey: z.string().trim().min(1).optional(),
          mediaUrl: url.optional(),
          bodyText: optionalText(META_LIMITS.carouselCardBody),
          buttonText: z.string().trim().min(1, "Informe o texto do botão do card.").max(META_LIMITS.buttonText, maxChars(META_LIMITS.buttonText)),
          url,
        }),
      )
      .max(META_LIMITS.carouselMaxCards, `Máximo de ${META_LIMITS.carouselMaxCards} cards.`)
      .default([]),
  })
  .superRefine((config, ctx) => {
    if (config.cards.some((card) => !card.mediaKey && !card.mediaUrl)) {
      ctx.addIssue({ code: "custom", path: ["cards"], message: "Cada card precisa de uma imagem ou vídeo." });
    }
    if (config.source === "manual" && config.cards.length < META_LIMITS.carouselMinCards) {
      ctx.addIssue({ code: "custom", path: ["cards"], message: "O carrossel precisa de 2 a 10 cards." });
    }
  });

const locationRequestConfig = z.object({
  /// Texto padrão do pedido, usado quando a IA não escrever um.
  bodyText: optionalText(1024),
});

const linkPreviewConfig = z.object({ url });

const paymentConfig = z.object({
  goodsType: z.enum(["digital-goods", "physical-goods"]).default("digital-goods"),
  methods: z.array(z.enum(["pix", "payment_link", "boleto"])).min(1).default(["pix"]),
  merchantName: optionalText(100),
  pixKey: optionalText(100),
  pixKeyType: z.enum(["CPF", "CNPJ", "EMAIL", "PHONE", "EVP"]).optional(),
});

/// WhatsApp Flow (formulário). Status e primeira tela são conferidos na Meta
/// ao salvar (agent-feature-service.ts); rascunho sai em modo "draft".
const flowConfig = z.object({
  flowId: z.string().trim().min(1, "Selecione o flow."),
  flowName: z.string().trim().default(""),
  wabaId: z.string().trim().default(""),
  status: z.string().trim().default(""),
  firstScreen: z.string().trim().default(""),
  ctaText: z.string().trim().min(1, "Informe o texto do botão que abre o flow.").max(META_LIMITS.flowCta, maxChars(META_LIMITS.flowCta)),
  bodyText: optionalText(1024),
  headerText: optionalText(META_LIMITS.headerText),
  footerText: optionalText(META_LIMITS.footerText),
  /// Ligado: as respostas do formulário viram metadados do contato.
  saveAsMetadata: z.boolean().default(false),
});

export const FEATURE_CONFIG_SCHEMAS: Record<AgentFeatureType, z.ZodTypeAny> = {
  CATALOG: catalogConfig,
  PRODUCT_CAROUSEL: productCarouselConfig,
  CTA_URL: ctaUrlConfig,
  LIST: listConfig,
  REPLY_BUTTONS: replyButtonsConfig,
  MEDIA_CAROUSEL: mediaCarouselConfig,
  LOCATION_REQUEST: locationRequestConfig,
  CONTEXTUAL_REPLY: z.object({}).passthrough().transform(() => ({})),
  LINK_PREVIEW: linkPreviewConfig,
  PAYMENT: paymentConfig,
  FLOW: flowConfig,
};

export function isPromptRequired(type: AgentFeatureType): boolean {
  return !PROMPT_OPTIONAL.includes(type);
}

export const createAgentFeatureSchema = z.object({
  type: z.enum(AGENT_FEATURE_TYPES),
  name: z.string().trim().min(1, "Dê um nome para a funcionalidade.").max(80),
  prompt: z.string().trim().max(1000, "A descrição pode ter no máximo 1000 caracteres.").default(""),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const updateAgentFeatureSchema = createAgentFeatureSchema.omit({ type: true });

export const presignFeatureMediaSchema = z.object({
  fileName: z.string().min(1).max(200),
  contentType: z.enum(["image/jpeg", "image/png", "video/mp4"]),
});

export type CreateAgentFeatureInput = z.infer<typeof createAgentFeatureSchema>;
export type UpdateAgentFeatureInput = z.infer<typeof updateAgentFeatureSchema>;
export type PresignFeatureMediaInput = z.infer<typeof presignFeatureMediaSchema>;
