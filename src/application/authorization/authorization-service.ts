import { PermissionAction } from "../../domain/enums/permission-action";
import { ForbiddenError } from "../../domain/errors/app-error";
import type { AuthUser } from "../../presentation/http/types/auth-user";

/// O que o time de suporte (User.role "support") pode fazer na central
/// "Suporte Sturnus" (onde não é Member). Em outras empresas vale só o papel
/// dele lá (Member), como qualquer membro.
const SUPPORT_AGENT_ACTIONS: PermissionAction[] = [PermissionAction.SUPPORT_VIEW, PermissionAction.SUPPORT_WRITE];

export const authorizationService = {
  /// activePermissions já vem resolvido na sessão (papel + checkboxes da tela
  /// de Acessos, ver resolvePermissions) — vazio quando não há papel ativo.
  can(user: AuthUser, action: PermissionAction): boolean {
    if (user.isPlatformAdmin) return true;
    if (user.isSupportAgent && user.actingAsSupport && SUPPORT_AGENT_ACTIONS.includes(action)) return true;
    if (!user.activeMemberRole) return false;
    return user.activePermissions.includes(action);
  },

  assert(user: AuthUser, action: PermissionAction): void {
    if (!this.can(user, action)) {
      throw new ForbiddenError();
    }
  },
};
