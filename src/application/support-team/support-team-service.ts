import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../domain/errors/app-error";
import { PLATFORM_ADMIN_ROLE, PLATFORM_DEFAULT_ROLE, PLATFORM_SUPPORT_ROLE } from "../../domain/enums/platform-role";
import { prisma } from "../../infrastructure/database/prisma/client";
import { SUPPORT_SEVERITIES, type SupportSeverityValue } from "../../domain/enums/support-severity";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import { isPlatformAdminEmail } from "../authorization/platform-admins";

const MEMBER_SELECT = { id: true, name: true, email: true, role: true, banned: true, createdAt: true } as const;

/// Só Administrador gerencia quem é time de suporte — quem é "support" atende
/// chamados, mas não promove/remove colegas (senão o papel viraria atalho
/// pra espalhar acesso a chamados de todas as empresas).
function assertCanManage(user: AuthUser) {
  if (!user.isPlatformAdmin) throw new ForbiddenError("Só Administradores gerenciam o time de suporte.");
  if (!user.actingAsSupport) throw new ForbiddenError("Gerencie o time de suporte pela central Suporte Sturnus.");
}

/// Flag "support" (User.role) — atribuída SÓ por aqui (tela de Suporte
/// técnico), nunca pela tela de Acessos, e só pra quem já tem conta.
export const supportTeamService = {
  async list(user: AuthUser) {
    assertCanManage(user);
    const users = await prisma.user.findMany({
      where: { role: { in: [PLATFORM_ADMIN_ROLE, PLATFORM_SUPPORT_ROLE] } },
      select: { ...MEMBER_SELECT, supportAgentSettings: { select: { severities: true } } },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    });

    return users.map(({ supportAgentSettings, ...member }) => ({
      ...member,
      // Classificações que atende. Administrador e suporte sem configuração:
      // todas.
      severities:
        member.role === PLATFORM_SUPPORT_ROLE && supportAgentSettings
          ? supportAgentSettings.severities
          : [...SUPPORT_SEVERITIES],
      // Administrador não sai do time por esta tela; os de PLATFORM_ADMIN_EMAILS
      // nunca saem (são recolocados a cada subida da API).
      removable: member.role === PLATFORM_SUPPORT_ROLE,
      locked: isPlatformAdminEmail(member.email),
    }));
  },

  /// Checa se o e-mail já é de um usuário cadastrado antes de dar a flag —
  /// não cria conta nem convida.
  async add(user: AuthUser, email: string, severities?: SupportSeverityValue[]) {
    assertCanManage(user);
    const target = await prisma.user.findFirst({
      where: { email: { equals: email.trim(), mode: "insensitive" } },
      select: MEMBER_SELECT,
    });

    if (!target) {
      throw new NotFoundError(
        "Nenhum usuário cadastrado com este e-mail. A pessoa precisa criar a conta na plataforma antes de entrar no time de suporte.",
      );
    }
    if (target.banned) throw new ValidationError("Este usuário está banido da plataforma.");
    if (target.role === PLATFORM_ADMIN_ROLE || isPlatformAdminEmail(target.email)) {
      throw new ConflictError("Este usuário é Administrador — já atende os chamados.");
    }
    if (target.role === PLATFORM_SUPPORT_ROLE) throw new ConflictError("Este usuário já faz parte do time de suporte.");

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { role: PLATFORM_SUPPORT_ROLE },
      select: MEMBER_SELECT,
    });
    // Sem classificações informadas (ou todas) = sem linha = atende todas.
    if (severities && severities.length < SUPPORT_SEVERITIES.length) {
      await this.saveSeverities(updated.id, severities);
    }
    return updated;
  },

  /// Administrador define quais classificações a pessoa do time atende.
  async updateSeverities(user: AuthUser, userId: string, severities: SupportSeverityValue[]) {
    assertCanManage(user);
    const target = await prisma.user.findUnique({ where: { id: userId }, select: MEMBER_SELECT });
    if (!target) throw new NotFoundError("Usuário não encontrado.");
    if (target.role !== PLATFORM_SUPPORT_ROLE) {
      throw new ValidationError("Administradores atendem todas as classificações — só o time de suporte é configurável.");
    }
    if (severities.length === 0) {
      throw new ValidationError("Escolha ao menos uma classificação. Para tirar a pessoa do atendimento, remova-a do time.");
    }
    await this.saveSeverities(target.id, severities);
    return { ...target, severities: [...new Set(severities)].sort() };
  },

  async saveSeverities(userId: string, severities: SupportSeverityValue[]) {
    const unique = [...new Set(severities)].sort() as SupportSeverityValue[];
    await prisma.supportAgentSettings.upsert({
      where: { userId },
      create: { userId, severities: unique },
      update: { severities: unique },
    });
  },

  /// Tira só a flag "support" (volta a conta comum). Administrador não é
  /// rebaixado por aqui.
  async remove(user: AuthUser, userId: string) {
    assertCanManage(user);
    const target = await prisma.user.findUnique({ where: { id: userId }, select: MEMBER_SELECT });
    if (!target) throw new NotFoundError("Usuário não encontrado.");
    if (target.role !== PLATFORM_SUPPORT_ROLE) {
      throw new ValidationError("Só é possível remover quem tem a flag de suporte — Administradores não saem por aqui.");
    }

    // Sai do time sem levar a configuração junto — se voltar, começa de novo
    // atendendo todas.
    const [updated] = await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { role: PLATFORM_DEFAULT_ROLE }, select: MEMBER_SELECT }),
      prisma.supportAgentSettings.deleteMany({ where: { userId: target.id } }),
    ]);
    return updated;
  },
};
