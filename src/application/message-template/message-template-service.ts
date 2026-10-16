import { ValidationError } from "../../domain/errors/app-error";
import { createTemplate, deleteTemplate, listTemplatesDetailed, uploadTemplateMedia } from "../../infrastructure/meta/meta-business-client";
import { createTemplateMediaUploadUrl, readObject, templateMediaKeyPrefix } from "../../infrastructure/storage/s3-client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import { whatsappChannelService } from "../whatsapp-channel/whatsapp-channel-service";
import {
  TEMPLATE_MEDIA,
  toMetaTemplate,
  type CreateMessageTemplateInput,
  type PresignTemplateMediaInput,
  type TemplateMediaFormat,
} from "./message-template-validation";

/// Canal da empresa ativa + token — templates e flows pertencem ao WABA do canal.
export async function resolveChannelAccess(user: AuthUser, channelId: string) {
  const channel = await whatsappChannelService.getById(user, channelId);
  if (!channel.metaAccessToken) {
    throw new ValidationError("Esta rede social ainda não tem um token de acesso da Meta cadastrado.");
  }
  return { wabaId: channel.wabaId, token: channel.metaAccessToken, organizationId: channel.organizationId };
}

/// Hosts de onde a Meta serve a mídia de exemplo dos templates — o clone só
/// baixa daqui (nunca de um link qualquer vindo do front).
const META_MEDIA_HOSTS = [".whatsapp.net", ".fbcdn.net", ".fbsbx.com"];

function isMetaMediaUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && META_MEDIA_HOSTS.some((h) => url.hostname.endsWith(h));
  } catch {
    return false;
  }
}

function checkMedia(format: TemplateMediaFormat, contentType: string, size: number) {
  const rule = TEMPLATE_MEDIA[format];
  if (!(rule.contentTypes as readonly string[]).includes(contentType) || size > rule.maxBytes) {
    throw new ValidationError(`Para este cabeçalho, envie ${rule.label}.`);
  }
}

/// Lê a mídia de exemplo (do S3 ou do link da Meta, no clone) e sobe no
/// upload retomável da Meta, que devolve o handle usado no template.
async function headerMediaHandle(
  input: Extract<CreateMessageTemplateInput, { header: unknown }>,
  access: { token: string; organizationId: string },
  channelId: string,
) {
  const format = input.header.format as TemplateMediaFormat;
  let file: { bytes: Uint8Array; contentType: string; fileName: string };

  if (input.header.mediaKey) {
    if (!input.header.mediaKey.startsWith(templateMediaKeyPrefix(access.organizationId, channelId))) {
      throw new ValidationError("Arquivo do cabeçalho inválido. Envie o arquivo de novo.");
    }
    const object = await readObject(input.header.mediaKey);
    if (!object) throw new ValidationError("O arquivo do cabeçalho não foi encontrado. Envie de novo.");
    file = {
      bytes: object.bytes,
      contentType: object.contentType ?? "",
      fileName: input.header.mediaKey.split("/").pop() ?? "midia",
    };
  } else {
    const sourceUrl = input.header.sourceUrl ?? "";
    if (!isMetaMediaUrl(sourceUrl)) throw new ValidationError("Envie o arquivo de exemplo do cabeçalho.");
    const response = await fetch(sourceUrl);
    if (!response.ok || !isMetaMediaUrl(response.url)) {
      throw new ValidationError("Não foi possível copiar a mídia do template original. Envie o arquivo de novo.");
    }
    file = {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: (response.headers.get("content-type") ?? "").split(";")[0].trim(),
      fileName: format === "DOCUMENT" ? "documento.pdf" : format === "VIDEO" ? "video.mp4" : "imagem",
    };
  }

  checkMedia(format, file.contentType, file.bytes.byteLength);
  return uploadTemplateMedia(access.token, file);
}

/// Templates de mensagem do WABA, lidos direto da Meta (status ao vivo).
export const messageTemplateService = {
  async list(user: AuthUser, channelId: string) {
    const { wabaId, token } = await resolveChannelAccess(user, channelId);
    const templates = await listTemplatesDetailed(wabaId, token);
    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      components: t.components,
      rejectedReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
      quality: t.quality_score?.score ?? null,
    }));
  },

  /// URL de upload da mídia de exemplo do cabeçalho (navegador → S3).
  async presignMedia(user: AuthUser, channelId: string, input: PresignTemplateMediaInput) {
    const { organizationId } = await resolveChannelAccess(user, channelId);
    checkMedia(input.format, input.contentType, input.size);
    return createTemplateMediaUploadUrl({ organizationId, channelId, fileName: input.fileName, contentType: input.contentType });
  },

  /// Cria e manda pra análise da Meta — volta com o status inicial
  /// (normalmente PENDING; às vezes já APPROVED ou REJECTED).
  async create(user: AuthUser, channelId: string, input: CreateMessageTemplateInput) {
    const access = await resolveChannelAccess(user, channelId);
    const handle =
      input.category !== "AUTHENTICATION" && !["NONE", "TEXT"].includes(input.header.format)
        ? await headerMediaHandle(input, access, channelId)
        : undefined;
    return createTemplate(access.wabaId, access.token, toMetaTemplate(input, handle));
  },

  async remove(user: AuthUser, channelId: string, templateId: string, name: string) {
    const { wabaId, token } = await resolveChannelAccess(user, channelId);
    await deleteTemplate(wabaId, token, templateId, name);
    return { id: templateId };
  },
};
