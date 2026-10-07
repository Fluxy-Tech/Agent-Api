import { Router } from "express";
import { campaignService } from "../../../application/campaign/campaign-service";
import {
  checkBlockedContactsSchema,
  createCampaignSchema,
  listCampaignsFilterSchema,
  listCampaignsQuerySchema,
  setCampaignActiveSchema,
  updateCampaignDestinationSchema,
} from "../../../application/campaign/campaign-validation";
import { PermissionAction } from "../../../domain/enums/permission-action";
import { ValidationError } from "../../../domain/errors/app-error";
import { apiHandler } from "../middlewares/api-handler";
import { recordAudit } from "../middlewares/audit";

export const campaignsRouter = Router();

campaignsRouter.get(
  "/",
  apiHandler({ action: PermissionAction.CAMPAIGNS_VIEW }, async (req, _res, user) => {
    const parsed = listCampaignsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Filtros inválidos.", parsed.error.flatten());

    return campaignService.list(user, parsed.data);
  }),
);

// Precisam vir ANTES de "/:id", senão o Express casaria "stats"/"filter-options" como id.
campaignsRouter.get(
  "/stats",
  apiHandler({ action: PermissionAction.CAMPAIGNS_VIEW }, async (req, _res, user) => {
    const parsed = listCampaignsFilterSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Filtros inválidos.", parsed.error.flatten());

    return campaignService.getStats(user, parsed.data);
  }),
);

campaignsRouter.get(
  "/filter-options",
  apiHandler({ action: PermissionAction.CAMPAIGNS_VIEW }, async (_req, _res, user) => {
    return campaignService.getFilterOptions(user);
  }),
);

campaignsRouter.get(
  "/:id",
  apiHandler({ action: PermissionAction.CAMPAIGNS_VIEW }, async (req, _res, user) => {
    return campaignService.getById(user, String(req.params.id));
  }),
);

campaignsRouter.post(
  "/blocked-contacts",
  apiHandler({ action: PermissionAction.CAMPAIGNS_WRITE }, async (req, _res, user) => {
    const parsed = checkBlockedContactsSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const blockedPhones = await campaignService.findBlockedPhones(user, parsed.data.whatsappChannelId, parsed.data.phones);
    return { blockedPhones };
  }),
);

campaignsRouter.post(
  "/",
  apiHandler({ action: PermissionAction.CAMPAIGNS_WRITE }, async (req, _res, user) => {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const campaign = await campaignService.create(user, parsed.data);

    await recordAudit(req, user, {
      action: "CAMPAIGN_CREATED",
      resourceType: "Campaign",
      resourceId: campaign.id,
      afterState: campaign,
    });

    return campaign;
  }),
);

campaignsRouter.patch(
  "/:id/active",
  apiHandler({ action: PermissionAction.CAMPAIGNS_WRITE }, async (req, _res, user) => {
    const parsed = setCampaignActiveSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const campaign = await campaignService.setActive(user, String(req.params.id), parsed.data.active);

    await recordAudit(req, user, {
      action: parsed.data.active ? "CAMPAIGN_RESUMED" : "CAMPAIGN_PAUSED",
      resourceType: "Campaign",
      resourceId: campaign.id,
      afterState: { active: campaign.active },
    });

    return campaign;
  }),
);

campaignsRouter.patch(
  "/:id/destination",
  apiHandler({ action: PermissionAction.CAMPAIGNS_WRITE }, async (req, _res, user) => {
    const parsed = updateCampaignDestinationSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const campaign = await campaignService.updateDestination(user, String(req.params.id), parsed.data);

    await recordAudit(req, user, {
      action: "CAMPAIGN_DESTINATION_UPDATED",
      resourceType: "Campaign",
      resourceId: campaign.id,
      afterState: { routeToQueueId: campaign.routeToQueueId, routeToUserId: campaign.routeToUserId },
    });

    return campaign;
  }),
);
