import { z } from "zod";

export const upsertAgentMetadataFieldSchema = z.object({
  name: z.string().trim().min(1, "Nome do metadado é obrigatório.").max(80, "Use no máximo 80 caracteres."),
  rule: z.string().trim().min(1, "Regra de coleta é obrigatória."),
  active: z.boolean().default(true),
});

export type UpsertAgentMetadataFieldInput = z.infer<typeof upsertAgentMetadataFieldSchema>;
