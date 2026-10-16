import { z } from "zod";

export const recordTokensSchema = z.object({
  origin: z.enum(["OPENAI", "ADK"]),
  quantity: z.number().int().positive(),
  /// Separação entrada/saída — opcional pra não quebrar quem só manda o total.
  inputQuantity: z.number().int().nonnegative().optional(),
  outputQuantity: z.number().int().nonnegative().optional(),
});
export type RecordTokensInput = z.infer<typeof recordTokensSchema>;
