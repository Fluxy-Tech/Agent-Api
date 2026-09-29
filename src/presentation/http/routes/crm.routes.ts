import { Router } from "express";
import { crmCalendarService } from "../../../application/crm/crm-calendar-service";
import { crmFunnelService } from "../../../application/crm/crm-funnel-service";
import { crmService } from "../../../application/crm/crm-service";
import { crmSettingsService } from "../../../application/crm/crm-settings-service";
import {
  addAttachmentSchema,
  calendarAnnotationSchema,
  calendarTargetSearchQuerySchema,
  createCalendarEventSchema,
  createCommentSchema,
  createStageSchema,
  funnelFieldSchema,
  listCalendarEventsQuerySchema,
  moveCardSchema,
  presignAttachmentSchema,
  removeAttachmentQuerySchema,
  updatePrioritySchema,
  updateCalendarEventSchema,
  updateCrmSettingsSchema,
  updateStageSchema,
} from "../../../application/crm/crm-validation";
import { PermissionAction } from "../../../domain/enums/permission-action";
import { ValidationError } from "../../../domain/errors/app-error";
import { apiHandler } from "../middlewares/api-handler";
import { recordAudit } from "../middlewares/audit";

export const crmRouter = Router();

crmRouter.get(
  "/",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (_req, _res, user) => {
    return crmService.getBoard(user);
  }),
);

crmRouter.post(
  "/stages",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = createStageSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const stage = await crmService.createStage(user, parsed.data);
    await recordAudit(req, user, {
      action: "CRM_STAGE_CREATED",
      resourceType: "StagesCrm",
      resourceId: stage.id,
      afterState: stage,
    });

    return stage;
  }),
);

crmRouter.patch(
  "/stages/:id",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = updateStageSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const stage = await crmService.updateStage(user, String(req.params.id), parsed.data);
    await recordAudit(req, user, {
      action: "CRM_STAGE_UPDATED",
      resourceType: "StagesCrm",
      resourceId: stage.id,
      afterState: { nameStage: stage.nameStage },
    });

    return stage;
  }),
);

crmRouter.delete(
  "/stages/:id",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const stage = await crmService.deleteStage(user, String(req.params.id));
    await recordAudit(req, user, {
      action: "CRM_STAGE_DELETED",
      resourceType: "StagesCrm",
      resourceId: stage.id,
      beforeState: stage,
    });

    return stage;
  }),
);

crmRouter.get(
  "/cards/:id",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    return crmService.getCard(user, String(req.params.id));
  }),
);

crmRouter.delete(
  "/cards/:id",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const card = await crmService.deleteCard(user, String(req.params.id));
    await recordAudit(req, user, {
      action: "CRM_CARD_DELETED",
      resourceType: "CardCrm",
      resourceId: card.id,
      beforeState: card,
    });

    return { id: card.id, deleted: true };
  }),
);

crmRouter.patch(
  "/cards/:id/priority",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = updatePrioritySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const before = await crmService.findCard(user, String(req.params.id));
    const card = await crmService.updatePriority(user, before.id, parsed.data);
    await recordAudit(req, user, {
      action: "CRM_CARD_PRIORITY_UPDATED",
      resourceType: "CardCrm",
      resourceId: card.id,
      beforeState: { statusPriority: before.statusPriority },
      afterState: { statusPriority: card.statusPriority },
    });

    return { id: card.id, statusPriority: card.statusPriority };
  }),
);

crmRouter.post(
  "/cards/:id/attachments/presign",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = presignAttachmentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    return crmService.presignAttachment(user, String(req.params.id), parsed.data);
  }),
);

crmRouter.post(
  "/cards/:id/attachments",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = addAttachmentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const card = await crmService.addAttachment(user, String(req.params.id), parsed.data);
    await recordAudit(req, user, {
      action: "CRM_CARD_ATTACHMENT_ADDED",
      resourceType: "CardCrm",
      resourceId: card.id,
      afterState: { s3Key: parsed.data.s3Key },
    });

    return { id: card.id, attachments: card.attachments };
  }),
);

// s3Key vai na query (DELETE sem body) — o arquivo continua no S3.
crmRouter.delete(
  "/cards/:id/attachments",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = removeAttachmentQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const card = await crmService.removeAttachment(user, String(req.params.id), parsed.data.s3Key);
    await recordAudit(req, user, {
      action: "CRM_CARD_ATTACHMENT_REMOVED",
      resourceType: "CardCrm",
      resourceId: card.id,
      beforeState: { s3Key: parsed.data.s3Key },
    });

    return { id: card.id, attachments: card.attachments };
  }),
);

// Comentar só exige poder ver o CRM — qualquer usuário com acesso ao card.
crmRouter.post(
  "/cards/:id/comments",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    const parsed = createCommentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    return crmService.addComment(user, String(req.params.id), parsed.data);
  }),
);

// Editar/apagar: só o autor do comentário (checado em crm-service.ts#findOwnComment).
crmRouter.patch(
  "/cards/:id/comments/:commentId",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    const parsed = createCommentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    return crmService.updateComment(user, String(req.params.id), String(req.params.commentId), parsed.data);
  }),
);

crmRouter.delete(
  "/cards/:id/comments/:commentId",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    const comment = await crmService.deleteComment(user, String(req.params.id), String(req.params.commentId));
    return { id: comment.id };
  }),
);

crmRouter.patch(
  "/cards/:id/move",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = moveCardSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const card = await crmService.moveCard(user, String(req.params.id), parsed.data);
    await recordAudit(req, user, {
      action: "CRM_CARD_MOVED",
      resourceType: "CardCrm",
      resourceId: card.id,
      afterState: { stagesCrmId: card.stagesCrmId },
    });

    return card;
  }),
);

// ---------- FUNIL DE CONVERSÕES ----------

crmRouter.get(
  "/settings",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (_req, _res, user) => {
    return crmSettingsService.get(user);
  }),
);

crmRouter.put(
  "/settings",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = updateCrmSettingsSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const before = await crmSettingsService.get(user);
    const settings = await crmSettingsService.update(user, parsed.data);

    await recordAudit(req, user, {
      action: "CRM_SETTINGS_UPDATED",
      resourceType: "CrmSettings",
      resourceId: user.activeOrganizationId!,
      beforeState: { calendar: before.calendar, kanban: before.kanban },
      afterState: { calendar: settings.calendar, kanban: settings.kanban },
    });

    return settings;
  }),
);

crmRouter.get(
  "/funnel",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (_req, _res, user) => {
    return crmFunnelService.getFunnel(user);
  }),
);

crmRouter.post(
  "/funnel/fields",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = funnelFieldSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const field = await crmFunnelService.createField(user, parsed.data);
    await recordAudit(req, user, {
      action: "CRM_FUNNEL_FIELD_CREATED",
      resourceType: "FieldsFunil",
      resourceId: field.id,
      afterState: field,
    });

    return field;
  }),
);

crmRouter.patch(
  "/funnel/fields/:id",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = funnelFieldSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const field = await crmFunnelService.updateField(user, String(req.params.id), parsed.data);
    await recordAudit(req, user, {
      action: "CRM_FUNNEL_FIELD_UPDATED",
      resourceType: "FieldsFunil",
      resourceId: field.id,
      afterState: field,
    });

    return field;
  }),
);

crmRouter.delete(
  "/funnel/fields/:id",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const field = await crmFunnelService.deleteField(user, String(req.params.id));
    await recordAudit(req, user, {
      action: "CRM_FUNNEL_FIELD_DELETED",
      resourceType: "FieldsFunil",
      resourceId: field.id,
      beforeState: field,
    });

    return field;
  }),
);

crmRouter.get(
  "/funnel/fields/:id/targets",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    return crmFunnelService.getFieldTargets(user, String(req.params.id));
  }),
);

// ---------- CALENDÁRIO ----------

crmRouter.get(
  "/calendar/events",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    const parsed = listCalendarEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parâmetros inválidos.", parsed.error.flatten());

    return crmCalendarService.listEvents(user, parsed.data.from, parsed.data.to);
  }),
);

crmRouter.get(
  "/calendar/targets",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    const parsed = calendarTargetSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Parâmetros inválidos.", parsed.error.flatten());

    return crmCalendarService.searchTargets(user, parsed.data.q);
  }),
);

crmRouter.post(
  "/calendar/events",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = createCalendarEventSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const event = await crmCalendarService.createEvent(user, parsed.data);
    await recordAudit(req, user, {
      action: "CALENDAR_EVENT_CREATED",
      resourceType: "CalendarEvent",
      resourceId: event.id,
      afterState: event,
    });

    return event;
  }),
);

crmRouter.get(
  "/calendar/events/:id",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    return crmCalendarService.getEvent(user, String(req.params.id));
  }),
);

crmRouter.patch(
  "/calendar/events/:id",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = updateCalendarEventSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const before = await crmCalendarService.findEvent(user, String(req.params.id));
    const event = await crmCalendarService.updateEvent(user, before.id, parsed.data);
    await recordAudit(req, user, {
      action: "CALENDAR_EVENT_UPDATED",
      resourceType: "CalendarEvent",
      resourceId: event.id,
      beforeState: before,
      afterState: event,
    });

    return event;
  }),
);

crmRouter.delete(
  "/calendar/events/:id",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const event = await crmCalendarService.deleteEvent(user, String(req.params.id));
    await recordAudit(req, user, {
      action: "CALENDAR_EVENT_DELETED",
      resourceType: "CalendarEvent",
      resourceId: event.id,
      beforeState: event,
    });

    return { id: event.id };
  }),
);

crmRouter.post(
  "/calendar/events/:id/documents/presign",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = presignAttachmentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    return crmCalendarService.presignDocument(user, String(req.params.id), parsed.data);
  }),
);

crmRouter.post(
  "/calendar/events/:id/documents",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = addAttachmentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const event = await crmCalendarService.addDocument(user, String(req.params.id), parsed.data);
    return { id: event.id, documents: event.documents };
  }),
);

// s3Key vai na query (DELETE sem body) — o arquivo continua no S3.
crmRouter.delete(
  "/calendar/events/:id/documents",
  apiHandler({ action: PermissionAction.CRM_WRITE }, async (req, _res, user) => {
    const parsed = removeAttachmentQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const event = await crmCalendarService.removeDocument(user, String(req.params.id), parsed.data.s3Key);
    return { id: event.id, documents: event.documents };
  }),
);

// Anotar só exige ver o CRM (mesma regra dos comentários do card);
// editar/apagar só o autor (crm-calendar-service.ts#findOwnAnnotation).
crmRouter.post(
  "/calendar/events/:id/annotations",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    const parsed = calendarAnnotationSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    return crmCalendarService.addAnnotation(user, String(req.params.id), parsed.data);
  }),
);

crmRouter.patch(
  "/calendar/events/:id/annotations/:annotationId",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    const parsed = calendarAnnotationSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    return crmCalendarService.updateAnnotation(
      user,
      String(req.params.id),
      String(req.params.annotationId),
      parsed.data,
    );
  }),
);

crmRouter.delete(
  "/calendar/events/:id/annotations/:annotationId",
  apiHandler({ action: PermissionAction.CRM_VIEW }, async (req, _res, user) => {
    const annotation = await crmCalendarService.deleteAnnotation(
      user,
      String(req.params.id),
      String(req.params.annotationId),
    );
    return { id: annotation.id };
  }),
);
