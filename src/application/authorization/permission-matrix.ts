import { MemberRole } from "../../domain/enums/member-role";
import { PermissionAction } from "../../domain/enums/permission-action";

/// Mapeamento direto das descrições de papel do EscopoSaas:
/// - Atendente: só visualiza contatos, sem edição, sem acesso a empresas.
/// - Supervisor: gerenciamento de atendentes (filas), contatos, campanhas.
/// - Gerente: todas as funcionalidades das empresas que ele acessa.
/// - Administrador (fora desta matriz, ver AuthorizationService): bypass total
///   + acesso cross-empresa.
export const PERMISSION_MATRIX: Record<MemberRole, PermissionAction[]> = {
  ATENDENTE: [PermissionAction.CONTACTS_VIEW],
  SUPERVISOR: [
    PermissionAction.CONTACTS_VIEW,
    PermissionAction.CONTACTS_WRITE,
    PermissionAction.QUEUES_VIEW,
    PermissionAction.QUEUES_WRITE,
    PermissionAction.CAMPAIGNS_VIEW,
    PermissionAction.CAMPAIGNS_WRITE,
    PermissionAction.CRM_VIEW,
    PermissionAction.CRM_WRITE,
    PermissionAction.REPORTS_VIEW,
  ],
  GERENTE: [
    PermissionAction.AGENTS_VIEW,
    PermissionAction.AGENTS_WRITE,
    PermissionAction.WABAS_VIEW,
    PermissionAction.WABAS_WRITE,
    PermissionAction.SERVICE_ISLANDS_VIEW,
    PermissionAction.SERVICE_ISLANDS_WRITE,
    PermissionAction.QUEUES_VIEW,
    PermissionAction.QUEUES_WRITE,
    PermissionAction.CONTACTS_VIEW,
    PermissionAction.CONTACTS_WRITE,
    PermissionAction.CAMPAIGNS_VIEW,
    PermissionAction.CAMPAIGNS_WRITE,
    PermissionAction.CRM_VIEW,
    PermissionAction.CRM_WRITE,
    PermissionAction.ACCESS_VIEW,
    PermissionAction.ACCESS_WRITE,
    PermissionAction.REPORTS_VIEW,
    PermissionAction.SUPPORT_VIEW,
    PermissionAction.SUPPORT_WRITE,
    PermissionAction.COMPANIES_MANAGE_OWN,
  ],
};

/// Ações que o Gerente pode ligar/desligar por usuário na tela de Acessos
/// (Member.permissions). Acessos (ACCESS_*) e gestão de empresas ficam de
/// fora de propósito: continuam presos ao papel, senão um checkbox viraria
/// atalho pra escalar privilégio.
export const CONFIGURABLE_PERMISSIONS: PermissionAction[] = [
  PermissionAction.CONTACTS_VIEW,
  PermissionAction.CONTACTS_WRITE,
  PermissionAction.CAMPAIGNS_VIEW,
  PermissionAction.CAMPAIGNS_WRITE,
  PermissionAction.CRM_VIEW,
  PermissionAction.CRM_WRITE,
  PermissionAction.REPORTS_VIEW,
  PermissionAction.AGENTS_VIEW,
  PermissionAction.AGENTS_WRITE,
  PermissionAction.WABAS_VIEW,
  PermissionAction.WABAS_WRITE,
  PermissionAction.SERVICE_ISLANDS_VIEW,
  PermissionAction.SERVICE_ISLANDS_WRITE,
  PermissionAction.QUEUES_VIEW,
  PermissionAction.QUEUES_WRITE,
  PermissionAction.SUPPORT_VIEW,
  PermissionAction.SUPPORT_WRITE,
];

export function isConfigurablePermission(value: unknown): value is PermissionAction {
  return CONFIGURABLE_PERMISSIONS.includes(value as PermissionAction);
}

/// Permissões efetivas de um membro: sem personalização (null) vale o papel;
/// com personalização, as ações configuráveis vêm da lista salva e as não
/// configuráveis (Acessos/empresas) continuam vindo do papel.
export function resolvePermissions(role: MemberRole, custom: unknown): PermissionAction[] {
  const byRole = PERMISSION_MATRIX[role];
  if (!Array.isArray(custom)) return byRole;

  const chosen = custom.filter(isConfigurablePermission);
  const fixed = byRole.filter((action) => !CONFIGURABLE_PERMISSIONS.includes(action));
  return [...new Set([...chosen, ...fixed])];
}
