import { env } from "../../config/env";
import { prisma } from "../../infrastructure/database/prisma/client";

/// Contas que são SEMPRE Administrador da plataforma (time de suporte), por
/// e-mail — PLATFORM_ADMIN_EMAILS. Garantido em três pontos:
/// - na subida da API (ensurePlatformAdmins, contas que já existem);
/// - no cadastro (hook do Better Auth em better-auth.ts);
/// - na resolução da sessão (session.ts), mesmo que o role seja rebaixado no
///   banco por fora.
export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  return !!email && env.PLATFORM_ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

/// Promove a admin as contas da lista que ainda não são. Idempotente; nunca
/// derruba a subida da API se falhar (só loga).
export async function ensurePlatformAdmins(): Promise<void> {
  if (env.PLATFORM_ADMIN_EMAILS.length === 0) return;
  try {
    const { count } = await prisma.user.updateMany({
      where: {
        email: { in: env.PLATFORM_ADMIN_EMAILS, mode: "insensitive" },
        OR: [{ role: null }, { role: { not: "admin" } }],
      },
      data: { role: "admin" },
    });
    if (count > 0) console.log(`[platform-admins] ${count} conta(s) promovida(s) a Administrador da plataforma.`);
  } catch (error) {
    console.error("[platform-admins] Falha ao garantir os Administradores da plataforma:", error);
  }
}
