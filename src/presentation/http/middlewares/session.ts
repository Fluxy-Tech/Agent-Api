import type { Request } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { resolvePermissions } from "../../../application/authorization/permission-matrix";
import { isPlatformAdminEmail } from "../../../application/authorization/platform-admins";
import { isSupportOrganization } from "../../../application/company/support-organization";
import { isMemberRole } from "../../../domain/enums/member-role";
import { PLATFORM_ADMIN_ROLE, PLATFORM_SUPPORT_ROLE } from "../../../domain/enums/platform-role";
import { UnauthorizedError } from "../../../domain/errors/app-error";
import { auth } from "../../../infrastructure/auth/better-auth";
import { prisma } from "../../../infrastructure/database/prisma/client";
import type { AuthUser } from "../types/auth-user";

export async function getAuthUser(req: Request): Promise<AuthUser> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

  if (!session) {
    throw new UnauthorizedError();
  }

  const activeOrganizationId = session.session.activeOrganizationId ?? null;
  let activeMemberRole = null as AuthUser["activeMemberRole"];
  let activePermissions: AuthUser["activePermissions"] = [];

  if (activeOrganizationId) {
    const member = await prisma.member.findUnique({
      where: { organizationId_userId: { organizationId: activeOrganizationId, userId: session.user.id } },
      select: { role: true, blocked: true, permissions: true },
    });

    // Membro bloqueado nunca ganha um papel ativo — mesmo efeito de não ter
    // Member nenhum na empresa, PermissionAction nenhuma passa (ver
    // authorization-service.can), sem precisar mexer em toda checagem manual
    // de papel espalhada pelas rotas.
    if (member && !member.blocked && isMemberRole(member.role)) {
      activeMemberRole = member.role;
      activePermissions = resolvePermissions(member.role, member.permissions);
    }
  }

  const isPlatformAdmin = session.user.role === PLATFORM_ADMIN_ROLE || isPlatformAdminEmail(session.user.email);
  const isSupportAgent = !isPlatformAdmin && session.user.role === PLATFORM_SUPPORT_ROLE;
  // Só o time de suporte (não admin) tem restrição por classificação.
  const supportSettings = isSupportAgent
    ? await prisma.supportAgentSettings.findUnique({ where: { userId: session.user.id }, select: { severities: true } })
    : null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    isPlatformAdmin,
    isSupportAgent,
    supportSeverities: supportSettings?.severities ?? null,
    actingAsSupport: (isPlatformAdmin || isSupportAgent) && isSupportOrganization(activeOrganizationId),
    activeOrganizationId,
    activeMemberRole,
    activePermissions,
  };
}
