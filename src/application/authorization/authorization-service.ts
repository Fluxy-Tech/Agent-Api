import type { PermissionAction } from "../../domain/enums/permission-action";
import { ForbiddenError } from "../../domain/errors/app-error";
import type { AuthUser } from "../../presentation/http/types/auth-user";
export const authorizationService = {
  /// activePermissions já vem resolvido na sessão (papel + checkboxes da tela
  /// de Acessos, ver resolvePermissions) — vazio quando não há papel ativo.
  can(user: AuthUser, action: PermissionAction): boolean {
    if (user.isPlatformAdmin) return true;
    if (!user.activeMemberRole) return false;
    return user.activePermissions.includes(action);
  },

  assert(user: AuthUser, action: PermissionAction): void {
    if (!this.can(user, action)) {
      throw new ForbiddenError();
    }
  },
};
