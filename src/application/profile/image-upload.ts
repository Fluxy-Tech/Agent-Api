import { z } from "zod";
import { ValidationError } from "../../domain/errors/app-error";
import { createDownloadUrl, headObject } from "../../infrastructure/storage/s3-client";

/// Foto de perfil e logo da empresa: só formatos de imagem rasterizada (SVG
/// fica de fora — pode carregar script) e até 2 MB.
export const IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export const presignImageSchema = z.object({
  fileName: z.string().min(1).max(200),
  contentType: z.enum(IMAGE_CONTENT_TYPES),
});

/// Confirma uma imagem já enviada direto pro S3: a chave precisa estar no
/// prefixo esperado (do usuário/empresa) e o objeto precisa existir, ser
/// imagem e respeitar o limite — vale o que o S3 diz, não o que o front
/// declarou.
export async function assertUploadedImage(keyPrefix: string, s3Key: string): Promise<void> {
  if (!s3Key.startsWith(keyPrefix)) throw new ValidationError("Imagem inválida.");

  const head = await headObject(s3Key);
  if (!head) throw new ValidationError("Imagem não encontrada. Envie o arquivo novamente.");
  if (head.size > IMAGE_MAX_BYTES) throw new ValidationError("A imagem pode ter no máximo 2 MB.");
  if (!head.contentType || !(IMAGE_CONTENT_TYPES as readonly string[]).includes(head.contentType)) {
    throw new ValidationError("Formato de imagem não suportado. Use PNG, JPG, WEBP ou GIF.");
  }
}

/// URL de leitura (presignada, 1h) de uma imagem guardada como chave do S3.
/// null quando não há imagem.
export async function imageUrlFor(s3Key: string | null | undefined): Promise<string | null> {
  return s3Key ? createDownloadUrl(s3Key) : null;
}
