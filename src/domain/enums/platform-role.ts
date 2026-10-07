/// Papéis de PLATAFORMA (User.role, campo do plugin admin do Better Auth) —
/// ortogonais ao papel por empresa (Member.role: GERENTE/SUPERVISOR/ATENDENTE).
/// - admin: Administrador — acesso total a todas as empresas.
/// - support: time de suporte técnico — só vê e responde os chamados de
///   suporte de todas as empresas (e entra na central "Suporte Sturnus").
///   Atribuído/removido só pela tela de Suporte técnico (time de suporte),
///   nunca pela tela de Acessos.
/// - user (ou null): conta comum, acesso só pelas empresas em que é Member.
export const PLATFORM_ADMIN_ROLE = "admin";
export const PLATFORM_SUPPORT_ROLE = "support";
export const PLATFORM_DEFAULT_ROLE = "user";
