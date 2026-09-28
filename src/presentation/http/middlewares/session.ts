import type { Request } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { resolvePermissions } from "../../../application/authorization/permission-matrix";
import { isMemberRole } from "../../../domain/enums/member-role";
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

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    isPlatformAdmin: session.user.role === "admin",
    activeOrganizationId,
    activeMemberRole,
    activePermissions,
  };
}
