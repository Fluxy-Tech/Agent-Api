import type { PermissionAction } from "../../../domain/enums/permission-action";
import type { MemberRole } from "../../../domain/enums/member-role";
import type { SupportSeverityValue } from "../../../domain/enums/support-severity";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /// User.role === "admin" do plugin admin do Better Auth — acesso global,
  /// ignora a matriz de permissões por organização.
  isPlatformAdmin: boolean;
  /// User.role === "support" (e não admin) — time de suporte técnico: só as
  /// ações de suporte (SUPPORT_*), em todas as empresas. Ver platform-role.ts.
  isSupportAgent: boolean;
  /// Classificações que este membro do time de suporte atende (definidas pelo
  /// Administrador na tela "Time de suporte"). null = todas — Administrador,
  /// suporte sem restrição configurada, ou quem não é do time.
  supportSeverities: SupportSeverityValue[] | null;
  /// Atuando COMO time de suporte agora: é do time (Administrador ou flag
  /// "support") E a empresa ativa é a central "Suporte Sturnus". Em qualquer
  /// outra empresa a pessoa é um membro comum dela (vê os tickets daquela
  /// empresa como cliente), mesmo tendo a flag.
  actingAsSupport: boolean;
  activeOrganizationId: string | null;
  /// Papel do usuário na organização ativa (null se ele não é Member dela, ou
  /// se nenhuma organização está ativa na sessão).
  activeMemberRole: MemberRole | null;
  /// Permissões efetivas na organização ativa: padrão do papel, ou o que o
  /// Gerente marcou por checkbox na tela de Acessos. Vazio sem papel ativo.
  activePermissions: PermissionAction[];
}
