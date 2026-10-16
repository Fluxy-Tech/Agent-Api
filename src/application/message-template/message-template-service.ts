import { ValidationError } from "../../domain/errors/app-error";
import { createTemplate, deleteTemplate, listTemplatesDetailed } from "../../infrastructure/meta/meta-business-client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import { whatsappChannelService } from "../whatsapp-channel/whatsapp-channel-service";
import { toMetaTemplate, type CreateMessageTemplateInput } from "./message-template-validation";

/// Canal da empresa ativa + token — templates e flows pertencem ao WABA do canal.
export async function resolveChannelAccess(user: AuthUser, channelId: string) {
  const channel = await whatsappChannelService.getById(user, channelId);
  if (!channel.metaAccessToken) {
    throw new ValidationError("Esta rede social ainda não tem um token de acesso da Meta cadastrado.");
  }
  return { wabaId: channel.wabaId, token: channel.metaAccessToken };
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

  /// Cria e manda pra análise da Meta — volta com o status inicial
  /// (normalmente PENDING; às vezes já APPROVED ou REJECTED).
  async create(user: AuthUser, channelId: string, input: CreateMessageTemplateInput) {
    const { wabaId, token } = await resolveChannelAccess(user, channelId);
    return createTemplate(wabaId, token, toMetaTemplate(input));
  },

  async remove(user: AuthUser, channelId: string, templateId: string, name: string) {
    const { wabaId, token } = await resolveChannelAccess(user, channelId);
    await deleteTemplate(wabaId, token, templateId, name);
    return { id: templateId };
  },
};
