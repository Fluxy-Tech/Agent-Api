import { Router } from "express";
import { z } from "zod";
import { companyService } from "../../../application/company/company-service";
import { isSupportOrganization } from "../../../application/company/support-organization";
import { imageUrlFor, presignImageSchema } from "../../../application/profile/image-upload";
import type { AuthUser } from "../types/auth-user";
import { ForbiddenError, ValidationError } from "../../../domain/errors/app-error";
import { apiHandler } from "../middlewares/api-handler";
import { recordAudit } from "../middlewares/audit";

const createCompanySchema = z.object({
  name: z.string().min(1),
  cnpj: z.string().min(1),
});

const updateMemberRoleSchema = z.object({ role: z.string().min(1) });
const updateMemberBlockedSchema = z.object({ blocked: z.boolean() });
const updateMemberPermissionsSchema = z.object({ permissions: z.array(z.string()).nullable() });
const generateInviteCodeSchema = z.object({ role: z.string().min(1), email: z.string().email() });
const redeemInviteCodeSchema = z.object({ code: z.string().min(1) });
const updateCompanySchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Aceita com ou sem máscara, mas precisa ter os 14 dígitos de um CNPJ.
  cnpj: z
    .string()
    .trim()
    .refine((value) => value.replace(/\D/g, "").length === 14, "CNPJ precisa ter 14 dígitos."),
  logo: z.string().min(1).nullable().optional(),
});

export const companiesRouter = Router();

/// Nunca deixa o token de acesso à API externa sair junto do objeto Company
/// (nem em resposta HTTP nem em AuditLog) — o valor em claro só é devolvido
/// pelas rotas dedicadas GET/POST /:id/api-token, que exigem papel de
/// GERENTE/admin.
/// isSupportHub marca a empresa fixa "Suporte Sturnus" (ver
/// support-organization.ts) — o Console usa pra mandar direto pra /support.
function sanitizeCompany<T extends { id: string; tokenAcessApi?: string | null }>(
  company: T,
): Omit<T, "tokenAcessApi"> & { hasApiAccessToken: boolean; isSupportHub: boolean } {
  const { tokenAcessApi, ...rest } = company;
  return { ...rest, hasApiAccessToken: Boolean(tokenAcessApi), isSupportHub: isSupportOrganization(company.id) };
}

/// Organization.logo guarda a chave do S3 — a URL de leitura é presignada
/// (expira), então é gerada a cada leitura.
async function withLogoUrl<T extends { id: string; logo?: string | null; tokenAcessApi?: string | null }>(company: T) {
  return { ...sanitizeCompany(company), logoUrl: await imageUrlFor(company.logo) };
}

/// Mesma checagem manual de papel das rotas de Acessos: Gerente (não
/// bloqueado) da empresa-alvo, ou Administrador.
async function assertCompanyManager(user: AuthUser, organizationId: string, message: string) {
  if (user.isPlatformAdmin) return;
  const requesterMembership = await companyService
    .listMembers(user, organizationId)
    .then((members) => members.find((m) => m.userId === user.id));
  if (requesterMembership?.role !== "GERENTE" || requesterMembership.blocked) {
    throw new ForbiddenError(message);
  }
}

companiesRouter.get(
  "/",
  apiHandler({ requireCompany: false }, async (_req, _res, user) => {
    const companies = await companyService.listForUser(user);
    return companies.map(sanitizeCompany);
  }),
);

companiesRouter.post(
  "/",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = createCompanySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const company = await companyService.create(user, parsed.data);
    const safeCompany = sanitizeCompany(company);
    await recordAudit(req, user, {
      action: "COMPANY_CREATED",
      resourceType: "Company",
      resourceId: company.id,
      afterState: safeCompany,
    });

    return safeCompany;
  }),
);

companiesRouter.get(
  "/:id",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const company = await companyService.getById(user, String(req.params.id));
    return withLogoUrl(company);
  }),
);

/// Tela Configurações → "Empresa": nome, CNPJ e logo da empresa-alvo.
companiesRouter.put(
  "/:id",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = updateCompanySchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues.find((issue) => issue.path[0] === "cnpj")?.message ?? "Dados inválidos.";
      throw new ValidationError(message, parsed.error.flatten());
    }

    const organizationId = String(req.params.id);
    await assertCompanyManager(user, organizationId, "Apenas Gerente ou Administrador podem alterar os dados da empresa.");

    const before = sanitizeCompany(await companyService.getById(user, organizationId));
    const updated = await companyService.update(user, organizationId, parsed.data);
    const safeUpdated = sanitizeCompany(updated);

    await recordAudit(req, user, {
      action: "COMPANY_UPDATED",
      resourceType: "Company",
      resourceId: organizationId,
      beforeState: before,
      afterState: safeUpdated,
    });

    return withLogoUrl(updated);
  }),
);

companiesRouter.post(
  "/:id/logo/presign",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = presignImageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Formato de imagem não suportado. Use PNG, JPG, WEBP ou GIF.", parsed.error.flatten());
    }

    const organizationId = String(req.params.id);
    await assertCompanyManager(user, organizationId, "Apenas Gerente ou Administrador podem alterar o logo da empresa.");

    return companyService.presignLogo(user, organizationId, parsed.data);
  }),
);

companiesRouter.get(
  "/:id/members",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    return companyService.listMembers(user, String(req.params.id));
  }),
);

/// Checagem de permissão manual (não via apiHandler `action`) porque o papel
/// relevante aqui é o do usuário NA EMPRESA-ALVO (:id da URL), que pode não ser
/// a empresa atualmente ativa na sessão — Gerente gerencia acessos de todas as
/// empresas que participa, não só a que está com o seletor ligado no momento.
companiesRouter.put(
  "/:id/members/:memberId",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = updateMemberRoleSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const organizationId = String(req.params.id);

    if (!user.isPlatformAdmin) {
      const requesterMembership = await companyService
        .listMembers(user, organizationId)
        .then((members) => members.find((m) => m.userId === user.id));
      if (requesterMembership?.role !== "GERENTE" || requesterMembership.blocked) {
        throw new ForbiddenError("Apenas Gerente ou Administrador podem alterar o tipo de acesso.");
      }
    }

    const memberId = String(req.params.memberId);
    const before = await companyService
      .listMembers(user, organizationId)
      .then((members) => members.find((m) => m.id === memberId));

    const updated = await companyService.updateMemberRole(user, organizationId, memberId, parsed.data.role);

    await recordAudit(req, user, {
      action: "MEMBER_ROLE_UPDATED",
      resourceType: "Member",
      resourceId: memberId,
      beforeState: before,
      afterState: updated,
    });

    return updated;
  }),
);

/// Telas que o usuário pode acessar/editar (checkboxes da tela de Acessos).
/// `permissions: null` volta ao padrão do papel. Mesma checagem manual de
/// papel (GERENTE/admin) das outras rotas sensíveis desta empresa-alvo.
companiesRouter.put(
  "/:id/members/:memberId/permissions",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = updateMemberPermissionsSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const organizationId = String(req.params.id);

    if (!user.isPlatformAdmin) {
      const requesterMembership = await companyService
        .listMembers(user, organizationId)
        .then((members) => members.find((m) => m.userId === user.id));
      if (requesterMembership?.role !== "GERENTE" || requesterMembership.blocked) {
        throw new ForbiddenError("Apenas Gerente ou Administrador podem alterar permissões.");
      }
    }

    const memberId = String(req.params.memberId);
    const before = await companyService
      .listMembers(user, organizationId)
      .then((members) => members.find((m) => m.id === memberId));

    const updated = await companyService.updateMemberPermissions(
      user,
      organizationId,
      memberId,
      parsed.data.permissions,
    );

    await recordAudit(req, user, {
      action: "MEMBER_PERMISSIONS_UPDATED",
      resourceType: "Member",
      resourceId: memberId,
      beforeState: before?.permissions ?? null,
      afterState: updated.permissions ?? null,
    });

    return updated;
  }),
);

/// Bloqueia/desbloqueia o acesso do usuário a esta empresa — reversível, ao
/// contrário do DELETE abaixo. Mesma checagem manual de papel das outras
/// rotas sensíveis desta empresa-alvo.
companiesRouter.patch(
  "/:id/members/:memberId/blocked",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = updateMemberBlockedSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const organizationId = String(req.params.id);

    if (!user.isPlatformAdmin) {
      const requesterMembership = await companyService
        .listMembers(user, organizationId)
        .then((members) => members.find((m) => m.userId === user.id));
      if (requesterMembership?.role !== "GERENTE" || requesterMembership.blocked) {
        throw new ForbiddenError("Apenas Gerente ou Administrador podem bloquear/desbloquear acesso.");
      }
    }

    const memberId = String(req.params.memberId);
    const before = await companyService
      .listMembers(user, organizationId)
      .then((members) => members.find((m) => m.id === memberId));

    const updated = await companyService.setMemberBlocked(user, organizationId, memberId, parsed.data.blocked);

    await recordAudit(req, user, {
      action: parsed.data.blocked ? "MEMBER_BLOCKED" : "MEMBER_UNBLOCKED",
      resourceType: "Member",
      resourceId: memberId,
      beforeState: before,
      afterState: updated,
    });

    return updated;
  }),
);

/// Remove o acesso do usuário a esta empresa (exclui o Member — não é
/// reversível com um clique, precisa de um novo convite). Mesma checagem
/// manual de papel das outras rotas sensíveis desta empresa-alvo.
companiesRouter.delete(
  "/:id/members/:memberId",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const organizationId = String(req.params.id);

    if (!user.isPlatformAdmin) {
      const requesterMembership = await companyService
        .listMembers(user, organizationId)
        .then((members) => members.find((m) => m.userId === user.id));
      if (requesterMembership?.role !== "GERENTE" || requesterMembership.blocked) {
        throw new ForbiddenError("Apenas Gerente ou Administrador podem remover acesso.");
      }
    }

    const memberId = String(req.params.memberId);
    const removed = await companyService.removeMember(user, organizationId, memberId);

    await recordAudit(req, user, {
      action: "MEMBER_REMOVED",
      resourceType: "Member",
      resourceId: memberId,
      beforeState: removed,
    });

    return { success: true };
  }),
);

/// Gera (ou rotaciona) o token de acesso à API externa (Fluxy Agents) — mesma
/// checagem manual de papel (GERENTE/admin) da rota de troca de acesso acima,
/// já que é uma ação sensível de segurança, não só de escrita comum.
companiesRouter.post(
  "/:id/api-token",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const organizationId = String(req.params.id);

    if (!user.isPlatformAdmin) {
      const requesterMembership = await companyService
        .listMembers(user, organizationId)
        .then((members) => members.find((m) => m.userId === user.id));
      if (requesterMembership?.role !== "GERENTE" || requesterMembership.blocked) {
        throw new ForbiddenError("Apenas Gerente ou Administrador podem gerar o token de acesso à API.");
      }
    }

    const { token } = await companyService.generateApiToken(user, organizationId);

    await recordAudit(req, user, {
      action: "API_TOKEN_GENERATED",
      resourceType: "Company",
      resourceId: organizationId,
      afterState: { hasApiAccessToken: true },
    });

    return { token };
  }),
);

/// Devolve o token de acesso à API já configurado, se houver — mesma
/// checagem manual de papel (GERENTE/admin) da rota de geração acima, já que
/// ler o token ativo é tão sensível quanto gerar um novo.
companiesRouter.get(
  "/:id/api-token",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const organizationId = String(req.params.id);

    if (!user.isPlatformAdmin) {
      const requesterMembership = await companyService
        .listMembers(user, organizationId)
        .then((members) => members.find((m) => m.userId === user.id));
      if (requesterMembership?.role !== "GERENTE" || requesterMembership.blocked) {
        throw new ForbiddenError("Apenas Gerente ou Administrador podem visualizar o token de acesso à API.");
      }
    }

    const { token } = await companyService.getApiToken(user, organizationId);

    await recordAudit(req, user, {
      action: "API_TOKEN_VIEWED",
      resourceType: "Company",
      resourceId: organizationId,
    });

    return { token };
  }),
);

/// Checagem manual de papel (GERENTE/admin) igual às outras rotas sensíveis
/// desta empresa-alvo — a listagem expõe os `code` ainda ativos, então não
/// pode ficar aberta pra qualquer membro (só esconder na UI não bastaria).
companiesRouter.get(
  "/:id/invite-codes",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const organizationId = String(req.params.id);

    if (!user.isPlatformAdmin) {
      const requesterMembership = await companyService
        .listMembers(user, organizationId)
        .then((members) => members.find((m) => m.userId === user.id));
      if (requesterMembership?.role !== "GERENTE" || requesterMembership.blocked) {
        throw new ForbiddenError("Apenas Gerente ou Administrador podem ver os códigos de convite.");
      }
    }

    return companyService.listInviteCodes(user, organizationId);
  }),
);

/// Mesma checagem manual de papel (GERENTE/admin) das outras rotas sensíveis
/// desta empresa-alvo acima — gerar convite não é uma ação de leitura comum.
companiesRouter.post(
  "/:id/invite-codes",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = generateInviteCodeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const organizationId = String(req.params.id);

    if (!user.isPlatformAdmin) {
      const requesterMembership = await companyService
        .listMembers(user, organizationId)
        .then((members) => members.find((m) => m.userId === user.id));
      if (requesterMembership?.role !== "GERENTE" || requesterMembership.blocked) {
        throw new ForbiddenError("Apenas Gerente ou Administrador podem gerar código de convite.");
      }
    }

    const invitation = await companyService.generateInviteCode(
      user,
      organizationId,
      parsed.data.role,
      parsed.data.email,
    );

    await recordAudit(req, user, {
      action: "INVITE_CODE_GENERATED",
      resourceType: "InvitationMember",
      resourceId: invitation.id,
      afterState: { code: invitation.code, role: invitation.role, email: invitation.email },
    });

    return invitation;
  }),
);

/// Exclui um convite ainda não utilizado — mesma checagem manual de papel
/// (GERENTE/admin) da geração/listagem de convites acima.
companiesRouter.delete(
  "/:id/invite-codes/:inviteId",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const organizationId = String(req.params.id);

    if (!user.isPlatformAdmin) {
      const requesterMembership = await companyService
        .listMembers(user, organizationId)
        .then((members) => members.find((m) => m.userId === user.id));
      if (requesterMembership?.role !== "GERENTE" || requesterMembership.blocked) {
        throw new ForbiddenError("Apenas Gerente ou Administrador podem excluir código de convite.");
      }
    }

    const inviteId = String(req.params.inviteId);
    const removed = await companyService.deleteInviteCode(user, organizationId, inviteId);

    await recordAudit(req, user, {
      action: "INVITE_CODE_DELETED",
      resourceType: "InvitationMember",
      resourceId: inviteId,
      beforeState: { code: removed.code, role: removed.role, email: removed.email },
    });

    return { success: true };
  }),
);

/// Resgate na tela de cadastro: usuário acabou de ser criado (signUp.email)
/// e ainda não tem empresa ativa, por isso requireCompany: false — o próprio
/// code identifica a organização de destino.
companiesRouter.post(
  "/redeem-invite",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = redeemInviteCodeSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const organization = await companyService.redeemInviteCode(user, parsed.data.code.trim().toUpperCase());
    const safeCompany = sanitizeCompany(organization);

    await recordAudit(req, user, {
      action: "INVITE_CODE_REDEEMED",
      resourceType: "Company",
      resourceId: organization.id,
      afterState: safeCompany,
    });

    return safeCompany;
  }),
);
