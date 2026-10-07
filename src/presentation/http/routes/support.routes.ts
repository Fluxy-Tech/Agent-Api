import { Router } from "express";
import { z } from "zod";
import { supportTeamService } from "../../../application/support-team/support-team-service";
import { supportTicketService } from "../../../application/support-ticket/support-ticket-service";
import { supportSeveritySchema } from "../../../application/support-ticket/support-ticket-validation";
import {
  createSupportMessageSchema,
  createSupportTicketSchema,
  listSupportTicketsQuerySchema,
  markSupportTicketReadSchema,
  presignSupportAttachmentSchema,
  updateSupportTicketSchema,
} from "../../../application/support-ticket/support-ticket-validation";
import { PermissionAction } from "../../../domain/enums/permission-action";
import { ValidationError } from "../../../domain/errors/app-error";
import { apiHandler } from "../middlewares/api-handler";
import { recordAudit } from "../middlewares/audit";

/// Suporte técnico — chamados abertos pelas empresas e atendidos pelo time de
/// apoio (Administradores da plataforma, que passam por qualquer
/// PermissionAction e enxergam todas as empresas — ver support-ticket-service).
export const supportRouter = Router();

supportRouter.get(
  "/tickets",
  apiHandler({ action: PermissionAction.SUPPORT_VIEW }, async (req, _res, user) => {
    const parsed = listSupportTicketsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Filtros inválidos.", parsed.error.flatten());

    return supportTicketService.list(user, parsed.data);
  }),
);

/// Dashboard do time de suporte (o service recusa quem não é do time).
supportRouter.get(
  "/dashboard",
  apiHandler({ action: PermissionAction.SUPPORT_VIEW }, async (_req, _res, user) => {
    return supportTicketService.dashboard(user);
  }),
);

/// Não lidas do usuário logado — consultado em polling pelo menu do Console.
supportRouter.get(
  "/unread",
  apiHandler({ action: PermissionAction.SUPPORT_VIEW }, async (_req, _res, user) => {
    return supportTicketService.unread(user);
  }),
);

supportRouter.get(
  "/tickets/:id",
  apiHandler({ action: PermissionAction.SUPPORT_VIEW }, async (req, _res, user) => {
    return supportTicketService.getById(user, String(req.params.id));
  }),
);

/// Marcar como lido não é escrita no chamado — basta poder ver.
supportRouter.post(
  "/tickets/:id/read",
  apiHandler({ action: PermissionAction.SUPPORT_VIEW }, async (req, _res, user) => {
    const parsed = markSupportTicketReadSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    return supportTicketService.markRead(user, String(req.params.id), parsed.data);
  }),
);

supportRouter.post(
  "/attachments/presign",
  apiHandler({ action: PermissionAction.SUPPORT_WRITE }, async (req, _res, user) => {
    const parsed = presignSupportAttachmentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Arquivo inválido.", parsed.error.flatten());

    return supportTicketService.presignAttachment(user, parsed.data);
  }),
);

supportRouter.post(
  "/tickets",
  apiHandler({ action: PermissionAction.SUPPORT_WRITE }, async (req, _res, user) => {
    const parsed = createSupportTicketSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const ticket = await supportTicketService.create(user, parsed.data);
    await recordAudit(req, user, {
      action: "SUPPORT_TICKET_CREATED",
      resourceType: "SupportTicket",
      resourceId: ticket.id,
      afterState: ticket,
    });

    return ticket;
  }),
);

supportRouter.post(
  "/tickets/:id/messages",
  apiHandler({ action: PermissionAction.SUPPORT_WRITE }, async (req, _res, user) => {
    const parsed = createSupportMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Dados inválidos.", parsed.error.flatten());
    }

    return supportTicketService.addMessage(user, String(req.params.id), parsed.data);
  }),
);

supportRouter.patch(
  "/tickets/:id",
  apiHandler({ action: PermissionAction.SUPPORT_WRITE }, async (req, _res, user) => {
    const parsed = updateSupportTicketSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const id = String(req.params.id);
    const before = await supportTicketService.findAccessible(user, id);
    const ticket = await supportTicketService.update(user, id, parsed.data);

    await recordAudit(req, user, {
      action: "SUPPORT_TICKET_UPDATED",
      resourceType: "SupportTicket",
      resourceId: ticket.id,
      beforeState: before,
      afterState: ticket,
    });

    return ticket;
  }),
);

// ---------- TIME DE SUPORTE (flag User.role "support") ----------
// Sem `action`: quem pode é decidido no service (só Administrador). Mantido
// fora da tela de Acessos de propósito — é papel de plataforma, não de empresa.

const severitiesSchema = z.array(supportSeveritySchema).min(1, "Escolha ao menos uma classificação.");
const addSupportMemberSchema = z.object({
  email: z.string().trim().email("E-mail inválido."),
  severities: severitiesSchema.optional(),
});
const updateSeveritiesSchema = z.object({ severities: severitiesSchema });

supportRouter.get(
  "/team",
  apiHandler(async (_req, _res, user) => supportTeamService.list(user)),
);

supportRouter.post(
  "/team",
  apiHandler(async (req, _res, user) => {
    const parsed = addSupportMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Dados inválidos.", parsed.error.flatten());
    }

    const member = await supportTeamService.add(user, parsed.data.email, parsed.data.severities);
    await recordAudit(req, user, {
      action: "SUPPORT_ROLE_GRANTED",
      resourceType: "User",
      resourceId: member.id,
      afterState: member,
    });
    return member;
  }),
);

supportRouter.put(
  "/team/:userId/severities",
  apiHandler(async (req, _res, user) => {
    const parsed = updateSeveritiesSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Dados inválidos.", parsed.error.flatten());
    }

    const member = await supportTeamService.updateSeverities(user, String(req.params.userId), parsed.data.severities);
    await recordAudit(req, user, {
      action: "SUPPORT_SEVERITIES_UPDATED",
      resourceType: "User",
      resourceId: member.id,
      afterState: member,
    });
    return member;
  }),
);

supportRouter.delete(
  "/team/:userId",
  apiHandler(async (req, _res, user) => {
    const member = await supportTeamService.remove(user, String(req.params.userId));
    await recordAudit(req, user, {
      action: "SUPPORT_ROLE_REVOKED",
      resourceType: "User",
      resourceId: member.id,
      afterState: member,
    });
    return member;
  }),
);
