import { z } from "zod";

/// Tamanho máximo de cada anexo (25 MB) — conferido de novo no S3
/// (HeadObject) na confirmação, o valor declarado pelo front não basta.
export const SUPPORT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/// Máximo de anexos por abertura/mensagem.
const MAX_ATTACHMENTS = 10;

/// Documentos, planilhas, imagens (prints de tela), vídeos (gravação de tela),
/// texto/log e zip — o que costuma ajudar a reproduzir um problema.
export const SUPPORT_ATTACHMENT_CONTENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
  "application/x-zip-compressed",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

export const supportSeveritySchema = z.enum(["S1", "S2", "S3"]);
export const supportTicketStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"]);

export const presignSupportAttachmentSchema = z.object({
  fileName: z.string().trim().min(1, "Nome do arquivo é obrigatório."),
  contentType: z.enum(SUPPORT_ATTACHMENT_CONTENT_TYPES, { message: "Tipo de arquivo não permitido." }),
  size: z.number().int().positive().max(SUPPORT_ATTACHMENT_MAX_BYTES, "Cada arquivo pode ter no máximo 25 MB."),
  /// Presente ao anexar numa mensagem de um chamado já aberto — a chave sai
  /// no prefixo da empresa DO CHAMADO (o time de apoio responde chamados de
  /// qualquer empresa). Ausente = abertura, prefixo da empresa ativa.
  ticketId: z.string().trim().min(1).optional(),
});

const attachmentRefSchema = z.object({
  s3Key: z.string().trim().min(1, "Arquivo não foi enviado."),
  fileName: z.string().trim().min(1),
  contentType: z.enum(SUPPORT_ATTACHMENT_CONTENT_TYPES),
});

export const createSupportTicketSchema = z.object({
  title: z.string().trim().min(5, "Título precisa ter ao menos 5 caracteres.").max(150),
  description: z.string().trim().min(10, "Descreva o problema com ao menos 10 caracteres.").max(10000),
  severity: supportSeveritySchema,
  attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
});

export const createSupportMessageSchema = z
  .object({
    content: z.string().trim().max(10000).default(""),
    attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
  })
  .refine((value) => value.content.length > 0 || value.attachments.length > 0, {
    message: "Escreva uma mensagem ou anexe um arquivo.",
  });

export const updateSupportTicketSchema = z
  .object({
    status: supportTicketStatusSchema.optional(),
    severity: supportSeveritySchema.optional(),
  })
  .refine((value) => value.status !== undefined || value.severity !== undefined, {
    message: "Nada para atualizar.",
  });

export const listSupportTicketsQuerySchema = z.object({
  status: supportTicketStatusSchema.optional(),
  severity: supportSeveritySchema.optional(),
});

export const markSupportTicketReadSchema = z.object({
  readUpTo: z.coerce.date().optional(),
});

export type MarkSupportTicketReadInput = z.infer<typeof markSupportTicketReadSchema>;
export type PresignSupportAttachmentInput = z.infer<typeof presignSupportAttachmentSchema>;
export type SupportAttachmentRef = z.infer<typeof attachmentRefSchema>;
export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>;
export type CreateSupportMessageInput = z.infer<typeof createSupportMessageSchema>;
export type UpdateSupportTicketInput = z.infer<typeof updateSupportTicketSchema>;
export type ListSupportTicketsQuery = z.infer<typeof listSupportTicketsQuerySchema>;
