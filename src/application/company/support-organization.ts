import { prisma } from "../../infrastructure/database/prisma/client";

/// "Suporte Sturnus" — empresa fixa da plataforma que serve de porta de
/// entrada do time de suporte técnico na tela /business: ao acessá-la, o
/// Console vai direto pra /support e só mostra o menu de suporte. É uma
/// Organization de verdade porque as telas do Console (e as rotas com
/// requireCompany) exigem uma empresa ativa na sessão. Ninguém é Member dela
/// — só Administradores da plataforma a enxergam (eles veem todas as
/// empresas). Id fixo pra ser reconhecida em qualquer serviço/tela.
export const SUPPORT_ORGANIZATION_ID = "suporte-sturnus";
const SUPPORT_ORGANIZATION_NAME = "Suporte Sturnus";
const SUPPORT_ORGANIZATION_SLUG = "suporte-sturnus";

export function isSupportOrganization(organizationId: string | null | undefined): boolean {
  return organizationId === SUPPORT_ORGANIZATION_ID;
}

/// Cria a empresa na subida da API se ainda não existir (e restaura o nome se
/// alguém tiver mudado). Idempotente; nunca derruba a subida se falhar.
export async function ensureSupportOrganization(): Promise<void> {
  try {
    await prisma.organization.upsert({
      where: { id: SUPPORT_ORGANIZATION_ID },
      create: {
        id: SUPPORT_ORGANIZATION_ID,
        name: SUPPORT_ORGANIZATION_NAME,
        slug: SUPPORT_ORGANIZATION_SLUG,
        // Campo obrigatório de Organization — não é uma empresa cliente.
        cnpj: "Central de suporte técnico",
        status: "ACTIVE",
        createdAt: new Date(),
      },
      update: { name: SUPPORT_ORGANIZATION_NAME, status: "ACTIVE" },
    });
  } catch (error) {
    console.error("[support-organization] Falha ao garantir a empresa Suporte Sturnus:", error);
  }
}
