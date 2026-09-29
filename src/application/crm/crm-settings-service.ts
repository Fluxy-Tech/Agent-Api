import { ValidationError } from "../../domain/errors/app-error";
import { prisma } from "../../infrastructure/database/prisma/client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import type { UpdateCrmSettingsInput } from "./crm-validation";

async function getOrCreateSettings(organizationId: string) {
  return prisma.crmSettings.upsert({ where: { organizationId }, create: { organizationId }, update: {} });
}

/// Membros da empresa que podem aparecer nas listas de seleção. Vem junto do
/// GET das configurações pra tela não depender de acesso à tela de Acessos.
async function listOrganizationUsers(organizationId: string) {
  const members = await prisma.member.findMany({
    where: { organizationId, blocked: false },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return members.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
}

export const crmSettingsService = {
  async get(user: AuthUser) {
    const organizationId = user.activeOrganizationId!;
    const [settings, users] = await Promise.all([getOrCreateSettings(organizationId), listOrganizationUsers(organizationId)]);

    // Quem saiu da empresa (ou foi bloqueado) some da seleção sem precisar
    // de FK nem limpeza — só é filtrado aqui.
    const memberIds = new Set(users.map((u) => u.userId));
    return {
      calendar: {
        userIds: settings.calendarUserIds.filter((id) => memberIds.has(id)),
        visibleToAgent: settings.calendarVisibleToAgent,
      },
      kanban: {
        userIds: settings.kanbanUserIds.filter((id) => memberIds.has(id)),
        maxCardsPerUser: settings.kanbanMaxCardsPerUser,
        visibleToAgent: settings.kanbanVisibleToAgent,
      },
      users,
    };
  },

  async update(user: AuthUser, input: UpdateCrmSettingsInput) {
    const organizationId = user.activeOrganizationId!;
    const users = await listOrganizationUsers(organizationId);
    const memberIds = new Set(users.map((u) => u.userId));

    const calendarUserIds = [...new Set(input.calendar.userIds)];
    const kanbanUserIds = [...new Set(input.kanban.userIds)];
    if ([...calendarUserIds, ...kanbanUserIds].some((id) => !memberIds.has(id))) {
      throw new ValidationError("Um ou mais usuários selecionados não fazem parte desta empresa.");
    }

    await getOrCreateSettings(organizationId);
    await prisma.crmSettings.update({
      where: { organizationId },
      data: {
        calendarUserIds,
        calendarVisibleToAgent: input.calendar.visibleToAgent,
        kanbanUserIds,
        kanbanMaxCardsPerUser: input.kanban.maxCardsPerUser,
        kanbanVisibleToAgent: input.kanban.visibleToAgent,
      },
    });

    return this.get(user);
  },
};
