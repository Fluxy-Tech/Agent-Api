import { NotFoundError } from "../../domain/errors/app-error";
import { prisma } from "../../infrastructure/database/prisma/client";
import { createImageUploadUrl, userAvatarKeyPrefix } from "../../infrastructure/storage/s3-client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import { assertUploadedImage, imageUrlFor } from "./image-upload";

const PROFILE_SELECT = { id: true, name: true, email: true, image: true } as const;

/// User.image guarda a chave do S3 (não uma URL) — a URL de leitura é
/// presignada e expira, então é gerada a cada leitura.
async function toProfile(user: { id: string; name: string; email: string; image: string | null }) {
  return { id: user.id, name: user.name, email: user.email, imageUrl: await imageUrlFor(user.image) };
}

/// Tela Configurações → "Meu perfil": dados do próprio usuário logado.
export const profileService = {
  async get(user: AuthUser) {
    const found = await prisma.user.findUnique({ where: { id: user.id }, select: PROFILE_SELECT });
    if (!found) throw new NotFoundError("Usuário não encontrado.");
    return toProfile(found);
  },

  presignAvatar(user: AuthUser, input: { fileName: string; contentType: string }) {
    return createImageUploadUrl({ keyPrefix: userAvatarKeyPrefix(user.id), ...input });
  },

  /// `image`: chave do S3 de um avatar recém-enviado, null pra remover a foto,
  /// undefined pra manter a atual.
  async update(user: AuthUser, input: { name: string; image?: string | null }) {
    if (input.image) await assertUploadedImage(userAvatarKeyPrefix(user.id), input.image);

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { name: input.name.trim(), ...(input.image !== undefined && { image: input.image }) },
      select: PROFILE_SELECT,
    });
    return toProfile(updated);
  },
};
