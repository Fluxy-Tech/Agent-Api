import { Router } from "express";
import { whatsappChannelService } from "../../../application/whatsapp-channel/whatsapp-channel-service";
import {
  bulkCreateWhatsappChannelSchema,
  campaignReportFilterSchema,
  createWhatsappChannelSchema,
  seriesPeriodSchema,
  updateWhatsappChannelSchema,
  wabaLookupSchema,
} from "../../../application/whatsapp-channel/whatsapp-channel-validation";
import { messageTemplateService } from "../../../application/message-template/message-template-service";
import { createMessageTemplateSchema } from "../../../application/message-template/message-template-validation";
import { whatsappFlowService } from "../../../application/whatsapp-flow/whatsapp-flow-service";
import { saveWhatsappFlowSchema } from "../../../application/whatsapp-flow/whatsapp-flow-validation";
import { PermissionAction } from "../../../domain/enums/permission-action";
import { ValidationError } from "../../../domain/errors/app-error";
import { apiHandler } from "../middlewares/api-handler";
import { recordAudit } from "../middlewares/audit";

export const whatsappChannelsRouter = Router();

/// Nunca deixa o token da Meta sair em claro pela API (resposta HTTP ou
/// AuditLog) — o front só recebe os 3 primeiros e os 3 últimos caracteres,
/// com um número fixo de asteriscos no meio (não varia com o tamanho real
/// do token, pra não vazar nem esse detalhe). null quando não há token.
function previewMetaAccessToken(token: string | null | undefined): string | null {
  if (!token) return null;
  if (token.length <= 6) return "*".repeat(12);
  return `${token.slice(0, 3)}${"*".repeat(12)}${token.slice(-3)}`;
}

function sanitizeChannel<T extends { metaAccessToken?: string | null }>(
  channel: T,
): Omit<T, "metaAccessToken"> & { metaAccessTokenPreview: string | null } {
  const { metaAccessToken, ...rest } = channel;
  return { ...rest, metaAccessTokenPreview: previewMetaAccessToken(metaAccessToken) };
}

whatsappChannelsRouter.get(
  "/",
  apiHandler({ action: PermissionAction.WABAS_VIEW }, async (_req, _res, user) => {
    const channels = await whatsappChannelService.list(user);
    return channels.map(sanitizeChannel);
  }),
);

whatsappChannelsRouter.get(
  "/:id",
  apiHandler({ action: PermissionAction.WABAS_VIEW }, async (req, _res, user) => {
    const channel = await whatsappChannelService.getById(user, String(req.params.id));
    return sanitizeChannel(channel);
  }),
);

whatsappChannelsRouter.post(
  "/",
  apiHandler({ action: PermissionAction.WABAS_WRITE }, async (req, _res, user) => {
    const parsed = createWhatsappChannelSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const channel = await whatsappChannelService.create(user, parsed.data);
    const safeChannel = sanitizeChannel(channel);
    await recordAudit(req, user, {
      action: "WHATSAPP_CHANNEL_CREATED",
      resourceType: "Channel",
      resourceId: channel.id,
      afterState: safeChannel,
    });

    return safeChannel;
  }),
);

whatsappChannelsRouter.get(
  "/:id/templates",
  apiHandler({ action: PermissionAction.CAMPAIGNS_VIEW }, async (req, _res, user) => {
    return whatsappChannelService.listTemplates(user, String(req.params.id));
  }),
);

// ---------- TEMPLATES DE MENSAGEM (tela Campanhas › Templates) ----------

whatsappChannelsRouter.get(
  "/:id/message-templates",
  apiHandler({ action: PermissionAction.CAMPAIGNS_VIEW }, async (req, _res, user) => {
    return messageTemplateService.list(user, String(req.params.id));
  }),
);

whatsappChannelsRouter.post(
  "/:id/message-templates",
  apiHandler({ action: PermissionAction.CAMPAIGNS_WRITE }, async (req, _res, user) => {
    const parsed = createMessageTemplateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Dados inválidos.", parsed.error.flatten());

    const result = await messageTemplateService.create(user, String(req.params.id), parsed.data);
    await recordAudit(req, user, {
      action: "MESSAGE_TEMPLATE_CREATED",
      resourceType: "MessageTemplate",
      resourceId: result.id,
      afterState: { name: parsed.data.name, language: parsed.data.language, status: result.status },
    });
    return result;
  }),
);

whatsappChannelsRouter.delete(
  "/:id/message-templates/:templateId",
  apiHandler({ action: PermissionAction.CAMPAIGNS_WRITE }, async (req, _res, user) => {
    const name = String(req.query.name ?? "");
    if (!name) throw new ValidationError("Informe o nome do template.");
    return messageTemplateService.remove(user, String(req.params.id), String(req.params.templateId), name);
  }),
);

// ---------- WHATSAPP FLOWS (Redes sociais › aba Flows) ----------

whatsappChannelsRouter.get(
  "/:id/flows",
  apiHandler({ action: PermissionAction.WABAS_VIEW }, async (req, _res, user) => {
    return whatsappFlowService.list(user, String(req.params.id));
  }),
);

whatsappChannelsRouter.get(
  "/:id/flows/:flowId",
  apiHandler({ action: PermissionAction.WABAS_VIEW }, async (req, _res, user) => {
    return whatsappFlowService.get(user, String(req.params.id), String(req.params.flowId));
  }),
);

whatsappChannelsRouter.post(
  "/:id/flows",
  apiHandler({ action: PermissionAction.WABAS_WRITE }, async (req, _res, user) => {
    const parsed = saveWhatsappFlowSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Dados inválidos.", parsed.error.flatten());
    return whatsappFlowService.create(user, String(req.params.id), parsed.data);
  }),
);

whatsappChannelsRouter.put(
  "/:id/flows/:flowId",
  apiHandler({ action: PermissionAction.WABAS_WRITE }, async (req, _res, user) => {
    const parsed = saveWhatsappFlowSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Dados inválidos.", parsed.error.flatten());
    return whatsappFlowService.update(user, String(req.params.id), String(req.params.flowId), parsed.data);
  }),
);

whatsappChannelsRouter.post(
  "/:id/flows/:flowId/publish",
  apiHandler({ action: PermissionAction.WABAS_WRITE }, async (req, _res, user) => {
    return whatsappFlowService.publish(user, String(req.params.id), String(req.params.flowId));
  }),
);

whatsappChannelsRouter.post(
  "/:id/flows/:flowId/deprecate",
  apiHandler({ action: PermissionAction.WABAS_WRITE }, async (req, _res, user) => {
    return whatsappFlowService.deprecate(user, String(req.params.id), String(req.params.flowId));
  }),
);

whatsappChannelsRouter.delete(
  "/:id/flows/:flowId",
  apiHandler({ action: PermissionAction.WABAS_WRITE }, async (req, _res, user) => {
    return whatsappFlowService.remove(user, String(req.params.id), String(req.params.flowId));
  }),
);

whatsappChannelsRouter.get(
  "/:id/status",
  apiHandler({ action: PermissionAction.WABAS_VIEW }, async (req, _res, user) => {
    return whatsappChannelService.getPhoneStatus(user, String(req.params.id));
  }),
);

whatsappChannelsRouter.get(
  "/:id/conversations-series",
  apiHandler({ action: PermissionAction.WABAS_VIEW }, async (req, _res, user) => {
    const parsed = seriesPeriodSchema.safeParse(req.query.period);
    if (!parsed.success) throw new ValidationError("Período inválido.", parsed.error.flatten());

    return whatsappChannelService.getConversationsSeries(user, String(req.params.id), parsed.data);
  }),
);

whatsappChannelsRouter.get(
  "/:id/messages-series",
  apiHandler({ action: PermissionAction.WABAS_VIEW }, async (req, _res, user) => {
    const parsed = seriesPeriodSchema.safeParse(req.query.period);
    if (!parsed.success) throw new ValidationError("Período inválido.", parsed.error.flatten());

    return whatsappChannelService.getMessagesSeries(user, String(req.params.id), parsed.data);
  }),
);

whatsappChannelsRouter.get(
  "/:id/campaigns-report",
  apiHandler({ action: PermissionAction.WABAS_VIEW }, async (req, _res, user) => {
    const parsed = campaignReportFilterSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Filtro de período inválido.", parsed.error.flatten());

    return whatsappChannelService.getCampaignReport(user, String(req.params.id), parsed.data);
  }),
);

whatsappChannelsRouter.post(
  "/waba-lookup",
  apiHandler({ action: PermissionAction.WABAS_WRITE }, async (req) => {
    const parsed = wabaLookupSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    return whatsappChannelService.lookupWaba(parsed.data.wabaId, parsed.data.metaAccessToken);
  }),
);

whatsappChannelsRouter.post(
  "/bulk",
  apiHandler({ action: PermissionAction.WABAS_WRITE }, async (req, _res, user) => {
    const parsed = bulkCreateWhatsappChannelSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const result = await whatsappChannelService.bulkCreate(user, parsed.data);
    const safeCreated = result.created.map(sanitizeChannel);

    for (const channel of safeCreated) {
      await recordAudit(req, user, {
        action: "WHATSAPP_CHANNEL_CREATED",
        resourceType: "Channel",
        resourceId: channel.id,
        afterState: channel,
      });
    }

    return { created: safeCreated, skipped: result.skipped };
  }),
);

whatsappChannelsRouter.put(
  "/:id",
  apiHandler({ action: PermissionAction.WABAS_WRITE }, async (req, _res, user) => {
    const parsed = updateWhatsappChannelSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const id = String(req.params.id);
    const before = await whatsappChannelService.getById(user, id);
    const channel = await whatsappChannelService.update(user, id, parsed.data);
    const safeChannel = sanitizeChannel(channel);

    await recordAudit(req, user, {
      action: "WHATSAPP_CHANNEL_UPDATED",
      resourceType: "Channel",
      resourceId: channel.id,
      beforeState: sanitizeChannel(before),
      afterState: safeChannel,
    });

    return safeChannel;
  }),
);
