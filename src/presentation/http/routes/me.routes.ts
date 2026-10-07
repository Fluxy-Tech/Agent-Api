import { Router } from "express";
import { z } from "zod";
import { presignImageSchema } from "../../../application/profile/image-upload";
import { profileService } from "../../../application/profile/profile-service";
import { ValidationError } from "../../../domain/errors/app-error";
import { apiHandler } from "../middlewares/api-handler";
import { recordAudit } from "../middlewares/audit";

const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  image: z.string().min(1).nullable().optional(),
});

/// Dados do próprio usuário logado (tela Configurações → "Meu perfil"). Não
/// depende de empresa ativa nem de permissão: todo usuário edita o próprio.
export const meRouter = Router();

meRouter.get(
  "/",
  apiHandler({ requireCompany: false }, async (_req, _res, user) => profileService.get(user)),
);

meRouter.post(
  "/avatar/presign",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = presignImageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Formato de imagem não suportado. Use PNG, JPG, WEBP ou GIF.", parsed.error.flatten());
    }
    return profileService.presignAvatar(user, parsed.data);
  }),
);

meRouter.put(
  "/",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const before = await profileService.get(user);
    const updated = await profileService.update(user, parsed.data);

    await recordAudit(req, user, {
      action: "USER_PROFILE_UPDATED",
      resourceType: "User",
      resourceId: user.id,
      beforeState: { name: before.name, hasImage: Boolean(before.imageUrl) },
      afterState: { name: updated.name, hasImage: Boolean(updated.imageUrl) },
    });

    return updated;
  }),
);
