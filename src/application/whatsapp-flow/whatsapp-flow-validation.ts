import { z } from "zod";

export const FLOW_CATEGORIES = [
  "SIGN_UP",
  "SIGN_IN",
  "APPOINTMENT_BOOKING",
  "LEAD_GENERATION",
  "SHOPPING",
  "CONTACT_US",
  "CUSTOMER_SUPPORT",
  "SURVEY",
  "OTHER",
] as const;

const flowJson = z
  .string()
  .trim()
  .min(2, "Informe o JSON do flow.")
  .refine((value) => {
    try {
      return typeof JSON.parse(value) === "object";
    } catch {
      return false;
    }
  }, "O JSON do flow é inválido. Confira vírgulas, aspas e chaves.");

export const saveWhatsappFlowSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome do flow.").max(200),
  categories: z.array(z.enum(FLOW_CATEGORIES)).min(1, "Escolha ao menos uma categoria."),
  /// Opcional na edição: ausente = mantém o JSON atual.
  flowJson: flowJson.optional(),
});

export type SaveWhatsappFlowInput = z.infer<typeof saveWhatsappFlowSchema>;
