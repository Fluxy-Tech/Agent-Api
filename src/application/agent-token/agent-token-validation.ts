import { z } from "zod";

export const recordTokensSchema = z.object({
  origin: z.enum(["OPENAI", "ADK"]),
  quantity: z.number().int().positive(),
});
export type RecordTokensInput = z.infer<typeof recordTokensSchema>;
