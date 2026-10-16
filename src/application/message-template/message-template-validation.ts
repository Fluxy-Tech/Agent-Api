import { z } from "zod";

/// Limites da Meta para templates de mensagem.
export const TEMPLATE_LIMITS = {
  header: 60,
  body: 1024,
  footer: 60,
  buttonText: 25,
  buttons: 10,
  copyCode: 15,
} as const;

const maxChars = (max: number) => `Use no máximo ${max} caracteres.`;

const buttonSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("QUICK_REPLY"),
    text: z.string().trim().min(1, "Informe o texto do botão.").max(TEMPLATE_LIMITS.buttonText, maxChars(TEMPLATE_LIMITS.buttonText)),
  }),
  z.object({
    type: z.literal("URL"),
    text: z.string().trim().min(1, "Informe o texto do botão.").max(TEMPLATE_LIMITS.buttonText, maxChars(TEMPLATE_LIMITS.buttonText)),
    /// Pode terminar com {{1}} (link dinâmico) — aí `example` é obrigatório.
    url: z.string().trim().url("Informe um link válido (com https://)."),
    example: z.string().trim().optional(),
  }),
  z.object({
    type: z.literal("PHONE_NUMBER"),
    text: z.string().trim().min(1, "Informe o texto do botão.").max(TEMPLATE_LIMITS.buttonText, maxChars(TEMPLATE_LIMITS.buttonText)),
    phoneNumber: z.string().trim().regex(/^\+?\d{10,15}$/, "Informe o telefone com DDI e DDD, só números (ex.: 5534999999999)."),
  }),
  z.object({
    type: z.literal("COPY_CODE"),
    example: z.string().trim().min(1, "Informe um código de exemplo.").max(TEMPLATE_LIMITS.copyCode, maxChars(TEMPLATE_LIMITS.copyCode)),
  }),
]);

/// Variáveis posicionais ({{1}}, {{2}}...) presentes no texto.
export function variablesOf(text: string): number[] {
  return [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
}

function checkVariables(text: string, examples: string[], label: string, ctx: z.RefinementCtx, path: string[]) {
  const vars = [...new Set(variablesOf(text))].sort((a, b) => a - b);
  if (vars.some((v, i) => v !== i + 1)) {
    ctx.addIssue({ code: "custom", path, message: `As variáveis do ${label} precisam ser sequenciais: {{1}}, {{2}}, {{3}}...` });
    return;
  }
  if (vars.length > 0 && (examples.length < vars.length || examples.slice(0, vars.length).some((e) => !e.trim()))) {
    ctx.addIssue({ code: "custom", path, message: `Preencha um exemplo para cada variável do ${label}.` });
  }
  if (/^\s*\{\{\s*\d+\s*\}\}|\{\{\s*\d+\s*\}\}\s*$/.test(text)) {
    ctx.addIssue({ code: "custom", path, message: `O ${label} não pode começar nem terminar com uma variável.` });
  }
}

export const createMessageTemplateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Informe o nome do template.")
      .max(512)
      .regex(/^[a-z0-9_]+$/, "Use só letras minúsculas, números e _ no nome (ex.: boas_vindas_2)."),
    category: z.enum(["MARKETING", "UTILITY"]),
    language: z.string().trim().min(2).max(10),
    header: z
      .object({
        format: z.enum(["NONE", "TEXT"]).default("NONE"),
        text: z.string().trim().max(TEMPLATE_LIMITS.header, maxChars(TEMPLATE_LIMITS.header)).default(""),
        example: z.string().trim().default(""),
      })
      .default({ format: "NONE", text: "", example: "" }),
    body: z.object({
      text: z.string().trim().min(1, "Escreva o texto da mensagem.").max(TEMPLATE_LIMITS.body, maxChars(TEMPLATE_LIMITS.body)),
      examples: z.array(z.string()).default([]),
    }),
    footer: z.string().trim().max(TEMPLATE_LIMITS.footer, maxChars(TEMPLATE_LIMITS.footer)).default(""),
    buttons: z.array(buttonSchema).max(TEMPLATE_LIMITS.buttons, `Máximo de ${TEMPLATE_LIMITS.buttons} botões.`).default([]),
  })
  .superRefine((t, ctx) => {
    checkVariables(t.body.text, t.body.examples, "texto", ctx, ["body"]);
    if (t.header.format === "TEXT") {
      if (!t.header.text) ctx.addIssue({ code: "custom", path: ["header"], message: "Escreva o texto do cabeçalho." });
      const vars = variablesOf(t.header.text);
      if (vars.length > 1 || vars.some((v) => v !== 1)) {
        ctx.addIssue({ code: "custom", path: ["header"], message: "O cabeçalho aceita no máximo uma variável, {{1}}." });
      } else if (vars.length === 1 && !t.header.example) {
        ctx.addIssue({ code: "custom", path: ["header"], message: "Preencha o exemplo da variável do cabeçalho." });
      }
    }
    for (const [i, b] of t.buttons.entries()) {
      if (b.type === "URL" && /\{\{\s*1\s*\}\}$/.test(b.url) && !b.example) {
        ctx.addIssue({ code: "custom", path: ["buttons", i], message: "Preencha um link de exemplo para o botão com link dinâmico." });
      }
    }
    if (t.buttons.filter((b) => b.type === "URL").length > 2) {
      ctx.addIssue({ code: "custom", path: ["buttons"], message: "Use no máximo 2 botões de link." });
    }
    if (t.buttons.filter((b) => b.type === "PHONE_NUMBER").length > 1) {
      ctx.addIssue({ code: "custom", path: ["buttons"], message: "Use no máximo 1 botão de telefone." });
    }
  });

export type CreateMessageTemplateInput = z.infer<typeof createMessageTemplateSchema>;

/// Converte o formulário do Console no formato `components` da Meta.
export function toMetaTemplate(input: CreateMessageTemplateInput) {
  const components: Record<string, unknown>[] = [];

  if (input.header.format === "TEXT") {
    components.push({
      type: "HEADER",
      format: "TEXT",
      text: input.header.text,
      ...(variablesOf(input.header.text).length ? { example: { header_text: [input.header.example] } } : {}),
    });
  }

  const bodyVars = new Set(variablesOf(input.body.text)).size;
  components.push({
    type: "BODY",
    text: input.body.text,
    ...(bodyVars ? { example: { body_text: [input.body.examples.slice(0, bodyVars)] } } : {}),
  });

  if (input.footer) components.push({ type: "FOOTER", text: input.footer });

  if (input.buttons.length) {
    components.push({
      type: "BUTTONS",
      buttons: input.buttons.map((b) => {
        switch (b.type) {
          case "QUICK_REPLY":
            return { type: "QUICK_REPLY", text: b.text };
          case "URL":
            return { type: "URL", text: b.text, url: b.url, ...(b.example ? { example: [b.example] } : {}) };
          case "PHONE_NUMBER":
            return { type: "PHONE_NUMBER", text: b.text, phone_number: b.phoneNumber.replace(/^\+?/, "+") };
          case "COPY_CODE":
            return { type: "COPY_CODE", example: b.example };
        }
      }),
    });
  }

  return {
    name: input.name,
    category: input.category,
    language: input.language,
    parameter_format: "positional",
    components,
  };
}
