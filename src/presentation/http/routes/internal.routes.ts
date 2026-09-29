import { Router, type Response } from "express";
import { z } from "zod";
import { campaignService } from "../../../application/campaign/campaign-service";
import {
  createCalendarEventForTarget,
  listCalendarEventsForTarget,
  scheduleCalendarEventForTarget,
  updateCalendarEventForTarget,
} from "../../../application/crm/crm-calendar-service";
import { addAgentCommentForTarget, createCardCrmForTarget } from "../../../application/crm/crm-service";
import { env } from "../../../config/env";
import { ragDocumentService } from "../../../application/rag-document/rag-document-service";
import { AppError } from "../../../domain/errors/app-error";
import { prisma } from "../../../infrastructure/database/prisma/client";
import { requireInternalApiKey } from "../middlewares/internal-auth";

export const internalRouter = Router();
internalRouter.use(requireInternalApiKey);

const metadataSchema = z.object({ metadata: z.record(z.string(), z.unknown()) });

const metropoleWelcomeSchema = z.object({
  phone: z.string().trim().min(8),
  name: z.string().trim().min(1),
});

const templateParameterSchema = z.object({ type: z.string(), text: z.string() });

const dispatchContactSchema = z.object({
  numberContact: z.string().trim().min(8, "Telefone obrigatório."),
  nameContact: z.string().trim().optional(),
  emailContact: z.string().trim().email().optional().or(z.literal("")),
  metadata: z.record(z.string(), z.string()).optional(),
  parametersHeader: z.array(templateParameterSchema).optional(),
  parametersBody: z.array(templateParameterSchema).optional(),
  parametersButton: z.array(templateParameterSchema).optional(),
});

/// Contrato interno único de disparo — usado hoje pela futura API externa
/// (Fluxy Agents) e, mais adiante, pelo disparo ativo do Desk. organizationId
/// vem explícito no body porque não há sessão de usuário aqui (o caller já é
/// confiável, autenticado por x-internal-api-key).
const campaignDispatchSchema = z.object({
  organizationId: z.string().trim().min(1),
  whatsappChannelId: z.string().trim().min(1),
  campaignName: z.string().trim().min(1),
  templateName: z.string().trim().min(1),
  language: z.string().trim().optional(),
  idAttendant: z.string().trim().min(1).optional(),
  idQueue: z.string().trim().min(1).optional(),
  createdByName: z.string().trim().optional(),
  skipTransferMessage: z.boolean().optional(),
  /// Texto cru do HEADER/BODY do template (com {{n}}) — só pra gravar no
  /// histórico de conversa a mensagem já com as variáveis substituídas.
  templateHeaderText: z.string().optional(),
  templateBodyText: z.string().optional(),
  contacts: z.array(dispatchContactSchema).min(1, "Envie ao menos 1 contato."),
});

const messageLogEntrySchema = z.object({
  messageId: z.string().trim().min(1),
  messageLog: z.string().trim().min(1),
  stagio: z.enum(["start", "end"]),
});

const messageLogBatchSchema = z.object({
  logs: z.array(messageLogEntrySchema).min(1),
});

const crmCardSchema = z.object({
  description: z.string().trim().max(5000).optional(),
});

const crmCardCommentSchema = z.object({
  comment: z.string().trim().min(1).max(10000),
});

const calendarEventScheduleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  dateEvent: z.coerce.date(),
  eventId: z.string().trim().min(1).optional(),
});

const calendarEventCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  dateEvent: z.coerce.date(),
});

const calendarEventUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).optional(),
    dateEvent: z.coerce.date().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.dateEvent !== undefined, {
    message: "Envie ao menos um campo.",
  });

const calendarEventListSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/// Janela padrão da consulta do agente quando não vier from/to: agora → +30 dias.
const DEFAULT_AGENT_EVENTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function sendAppError(res: Response, error: unknown, fallbackMessage: string) {
  const statusCode = error instanceof AppError ? error.statusCode : 500;
  const message = error instanceof AppError ? error.message : fallbackMessage;
  if (!(error instanceof AppError)) console.error(`[internal] ${fallbackMessage}`, error);
  res.status(statusCode).json({ success: false, result: null, message });
}

const ragDocumentStatusSchema = z.object({
  status: z.enum(["READY", "FAILED"]),
  chunkCount: z.number().int().optional(),
  errorMessage: z.string().optional(),
});

/// Usada pelo AI-Worker (tool de handoff) para decidir/confirmar a fila de
/// destino de um ticket, a partir da ilha ligada ao WhatsApp Channel do contato.
internalRouter.get("/service-islands/:id/queues", async (req, res) => {
  const queues = await prisma.queue.findMany({
    where: { serviceIslandId: String(req.params.id), isActive: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });

  res.json({ success: true, result: queues, message: null });
});

/// Usada pelo AI-Worker para sincronizar o snapshot de metadados aprendido
/// durante a conversa (merge, não substitui o que já existe).
internalRouter.patch("/targets/:id/metadata", async (req, res) => {
  const parsed = metadataSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Dados inválidos." });
    return;
  }

  const target = await prisma.target.findUnique({ where: { id: String(req.params.id) } });
  if (!target) {
    res.status(404).json({ success: false, result: null, message: "Contato não encontrado." });
    return;
  }

  const mergedMetadata = { ...((target.metadata as object) ?? {}), ...parsed.data.metadata };

  const updated = await prisma.target.update({
    where: { id: target.id },
    data: { metadata: mergedMetadata as object },
  });

  res.json({ success: true, result: updated, message: null });
});

/// Usada pelo AI-Worker (reset de jornada por palavra-chave) para limpar
/// TODOS os metadados salvos do contato — diferente do PATCH acima, que faz
/// merge, este substitui por {} (ver Channel.wordsToReset).
internalRouter.delete("/targets/:id/metadata", async (req, res) => {
  const target = await prisma.target.findUnique({ where: { id: String(req.params.id) } });
  if (!target) {
    res.status(404).json({ success: false, result: null, message: "Contato não encontrado." });
    return;
  }

  const updated = await prisma.target.update({
    where: { id: target.id },
    data: { metadata: {} },
  });

  res.json({ success: true, result: updated, message: null });
});

/// Chamada pela Metrópole (server-to-server) sempre que um lead novo se
/// cadastra com WhatsApp pelo formulário de contato do site — dispara a
/// campanha ativa de boas-vindas (template configurado via env) pro contato.
/// Sem sessão de usuário: o canal/template vêm da config do ambiente, não do
/// corpo da requisição, pra a Metrópole não poder disparar template arbitrário.
internalRouter.post("/campaigns/metropole-welcome", async (req, res) => {
  const parsed = metropoleWelcomeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Dados inválidos." });
    return;
  }

  if (!env.METROPOLE_WHATSAPP_CHANNEL_ID) {
    res.status(503).json({
      success: false,
      result: null,
      message: "WhatsApp Channel da Metrópole ainda não configurado (METROPOLE_WHATSAPP_CHANNEL_ID).",
    });
    return;
  }

  try {
    const campaign = await campaignService.triggerSystemCampaign({
      whatsappChannelId: env.METROPOLE_WHATSAPP_CHANNEL_ID,
      phone: parsed.data.phone,
      name: parsed.data.name,
      templateName: env.METROPOLE_WELCOME_TEMPLATE_NAME,
      language: env.METROPOLE_WELCOME_TEMPLATE_LANGUAGE,
      category: env.METROPOLE_WELCOME_TEMPLATE_CATEGORY,
    });
    res.status(202).json({ success: true, result: campaign, message: null });
  } catch (error) {
    const statusCode = error instanceof AppError ? error.statusCode : 502;
    const message = error instanceof Error ? error.message : "Falha ao disparar a campanha de boas-vindas.";
    res.status(statusCode).json({ success: false, result: null, message });
  }
});

/// Ponto único de disparo ativo, chamável por qualquer serviço confiável
/// (x-internal-api-key) — hoje usado pela API externa Fluxy Agents, e serve
/// de base para o futuro disparo ativo pelo Desk. organizationId vem
/// explícito no body (sem sessão de usuário).
internalRouter.post("/campaigns/dispatch", async (req, res) => {
  const parsed = campaignDispatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Dados inválidos.", errors: parsed.error.flatten() });
    return;
  }

  try {
    const campaign = await campaignService.dispatch({
      organizationId: parsed.data.organizationId,
      whatsappChannelId: parsed.data.whatsappChannelId,
      campaignName: parsed.data.campaignName,
      templateName: parsed.data.templateName,
      language: parsed.data.language,
      routeToQueueId: parsed.data.idQueue,
      routeToUserId: parsed.data.idAttendant,
      createdByName: parsed.data.createdByName,
      skipTransferMessage: parsed.data.skipTransferMessage,
      templateHeaderText: parsed.data.templateHeaderText,
      templateBodyText: parsed.data.templateBodyText,
      contacts: parsed.data.contacts.map((c) => ({
        phone: c.numberContact,
        name: c.nameContact,
        email: c.emailContact || undefined,
        metadata: c.metadata,
        parametersHeader: c.parametersHeader,
        parametersBody: c.parametersBody,
        parametersButton: c.parametersButton,
      })),
    });
    res.status(202).json({ success: true, result: campaign, message: null });
  } catch (error) {
    const statusCode = error instanceof AppError ? error.statusCode : 502;
    const message = error instanceof Error ? error.message : "Falha ao disparar a campanha.";
    res.status(statusCode).json({ success: false, result: null, message });
  }
});

/// Usada pelo AI-Worker (tool de "não quero mais receber") quando o contato
/// pede pra parar de receber campanhas — marca Target.blockCampaigns.
internalRouter.patch("/targets/:id/block-campaigns", async (req, res) => {
  const target = await prisma.target.findUnique({ where: { id: String(req.params.id) } });
  if (!target) {
    res.status(404).json({ success: false, result: null, message: "Contato não encontrado." });
    return;
  }

  const updated = await prisma.target.update({
    where: { id: target.id },
    data: { blockCampaigns: true },
  });

  res.json({ success: true, result: updated, message: null });
});

/// Função padrão dos agentes de IA: cria o card do contato no Kanban da
/// empresa (estágio "Início") ou, se já existir, só atualiza a descrição.
/// Idempotente — o AI-Worker pode chamar a cada dado novo coletado.
internalRouter.post("/targets/:id/crm-card", async (req, res) => {
  const parsed = crmCardSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Dados inválidos." });
    return;
  }

  const target = await prisma.target.findUnique({ where: { id: String(req.params.id) } });
  if (!target) {
    res.status(404).json({ success: false, result: null, message: "Contato não encontrado." });
    return;
  }

  try {
    const { card, created } = await createCardCrmForTarget(target.id, target.organizationId, parsed.data.description);
    res.status(created ? 201 : 200).json({ success: true, result: { card, created }, message: null });
  } catch (error) {
    sendAppError(res, error, "Falha ao criar card no CRM.");
  }
});

/// Função padrão dos agentes de IA: cria um evento no calendário da empresa
/// ligado ao contato (ex: horário que o lead pediu pra conversar).
internalRouter.post("/targets/:id/calendar-events", async (req, res) => {
  const parsed = calendarEventCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Dados inválidos.", errors: parsed.error.flatten() });
    return;
  }

  try {
    const event = await createCalendarEventForTarget(String(req.params.id), parsed.data);
    res.status(201).json({ success: true, result: event, message: null });
  } catch (error) {
    sendAppError(res, error, "Falha ao criar evento.");
  }
});

/// Função CALENDAR_EVENT do agente de IA: agenda (ou remarca eventId) num
/// horário livre, escolhendo um responsável entre os usuários liberados na
/// aba Configurações do Kanban. 409 = horário indisponível (a mensagem diz
/// o motivo, pro agente pedir outro horário ao contato).
internalRouter.post("/targets/:id/calendar-events/schedule", async (req, res) => {
  const parsed = calendarEventScheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Dados inválidos.", errors: parsed.error.flatten() });
    return;
  }

  try {
    const result = await scheduleCalendarEventForTarget(String(req.params.id), parsed.data);
    res.status(result.rescheduled ? 200 : 201).json({ success: true, result, message: null });
  } catch (error) {
    sendAppError(res, error, "Falha ao agendar evento.");
  }
});

/// Função KANBAN_CARD do agente de IA: comenta no card do contato (cria o
/// card se ainda não existir). Comentário sem usuário = "Agente de IA".
internalRouter.post("/targets/:id/crm-card/comments", async (req, res) => {
  const parsed = crmCardCommentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Dados inválidos." });
    return;
  }

  try {
    const result = await addAgentCommentForTarget(String(req.params.id), parsed.data.comment);
    res.status(201).json({ success: true, result, message: null });
  } catch (error) {
    sendAppError(res, error, "Falha ao comentar no card do CRM.");
  }
});

/// Remarca um evento do próprio contato (ex: lead corrigiu o horário).
internalRouter.patch("/targets/:id/calendar-events/:eventId", async (req, res) => {
  const parsed = calendarEventUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Dados inválidos.", errors: parsed.error.flatten() });
    return;
  }

  try {
    const event = await updateCalendarEventForTarget(String(req.params.id), String(req.params.eventId), parsed.data);
    res.json({ success: true, result: event, message: null });
  } catch (error) {
    sendAppError(res, error, "Falha ao atualizar evento.");
  }
});

/// Função padrão dos agentes de IA: consulta os eventos do contato e os
/// horários já ocupados da empresa em [from, to] (padrão: próximos 30 dias).
internalRouter.get("/targets/:id/calendar-events", async (req, res) => {
  const parsed = calendarEventListSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Datas inválidas." });
    return;
  }

  const from = parsed.data.from ?? new Date();
  const to = parsed.data.to ?? new Date(from.getTime() + DEFAULT_AGENT_EVENTS_WINDOW_MS);

  try {
    const result = await listCalendarEventsForTarget(String(req.params.id), from, to);
    res.json({ success: true, result, message: null });
  } catch (error) {
    sendAppError(res, error, "Falha ao consultar eventos.");
  }
});

/// Usada pelo AI-Worker (Python, sem acesso direto ao Postgres) pra gravar
/// suas linhas de MessageLog — os demais serviços da mensageria (TypeScript)
/// escrevem direto via Prisma, sem passar por HTTP. Aceita lote pra cobrir o
/// caso de mensagens agrupadas na janela de debounce (uma linha por
/// mensagem, mesmo stagio). Ver MENSAGERIA.md.
internalRouter.post("/message-logs", async (req, res) => {
  const parsed = messageLogBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Dados inválidos." });
    return;
  }

  await prisma.messageLog.createMany({ data: parsed.data.logs });
  res.status(202).json({ success: true, result: null, message: null });
});

/// Chamada pelo worker Python (AI-Worker/max) ao terminar de processar (ou
/// falhar) a ingestão de um documento de RAG — ver rag-document-service.ts.
internalRouter.patch("/rag-documents/:id/status", async (req, res) => {
  const parsed = ragDocumentStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, result: null, message: "Dados inválidos." });
    return;
  }

  try {
    const updated = await ragDocumentService.updateStatus(String(req.params.id), parsed.data);
    res.json({ success: true, result: updated, message: null });
  } catch {
    res.status(404).json({ success: false, result: null, message: "Documento não encontrado." });
  }
});
