import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../domain/errors/app-error";
import { prisma } from "../../infrastructure/database/prisma/client";
import {
  calendarEventDocumentKeyPrefix,
  createCalendarEventDocumentUploadUrl,
  createDownloadUrl,
} from "../../infrastructure/storage/s3-client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import type {
  AddAttachmentInput,
  CalendarAnnotationInput,
  CreateCalendarEventInput,
  PresignAttachmentInput,
  UpdateCalendarEventInput,
} from "./crm-validation";

/// Janela máxima de uma listagem — a tela pede um mês por vez (com as
/// semanas vizinhas visíveis na grade), isso só evita varrer o ano inteiro.
const MAX_RANGE_MS = 62 * 24 * 60 * 60 * 1000;

const EVENT_TARGET_SELECT = { id: true, name: true, waId: true, email: true } as const;

/// A chave é `<prefixo>/<timestamp>-<nome_seguro>` — o nome de exibição é o
/// que sobra depois do timestamp (mesma regra dos anexos de card).
function documentFileName(s3Key: string): string {
  const base = s3Key.split("/").pop() ?? s3Key;
  return base.replace(/^\d+-/, "");
}

async function getOrCreateCalendar(organizationId: string) {
  return prisma.calendarOrganization.upsert({ where: { organizationId }, create: { organizationId }, update: {} });
}

async function assertTargetBelongsToOrganization(targetId: string, organizationId: string) {
  const target = await prisma.target.findFirst({ where: { id: targetId, organizationId }, select: { id: true } });
  if (!target) throw new ValidationError("Contato inválido para esta empresa.");
}

/// Cria um evento pro Target sem sessão de usuário — usado pelo agente de IA
/// (POST /internal/targets/:id/calendar-events). A empresa vem do próprio
/// Target, então não tem como cair no calendário de outra organização.
export async function createCalendarEventForTarget(
  targetId: string,
  input: { name: string; description?: string | null; dateEvent: Date },
) {
  const target = await prisma.target.findUnique({ where: { id: targetId }, select: { id: true, organizationId: true } });
  if (!target) throw new NotFoundError("Contato não encontrado.");
  const calendar = await getOrCreateCalendar(target.organizationId);

  return prisma.calendarEvent.create({
    data: {
      calendarOrganizationId: calendar.id,
      targetId: target.id,
      name: input.name,
      description: input.description || null,
      dateEvent: input.dateEvent,
    },
  });
}

/// Remarca/edita um evento do próprio Target — só enquanto não estiver
/// encerrado (mesma trava da tela, ver crmCalendarService.updateEvent).
export async function updateCalendarEventForTarget(
  targetId: string,
  eventId: string,
  input: { name?: string; description?: string | null; dateEvent?: Date },
) {
  const event = await prisma.calendarEvent.findFirst({ where: { id: eventId, targetId } });
  if (!event) throw new NotFoundError("Evento não encontrado.");
  if (event.isClosed) throw new ValidationError("Evento encerrado — não pode mais ser alterado.");

  return prisma.calendarEvent.update({
    where: { id: event.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.dateEvent !== undefined ? { dateEvent: input.dateEvent } : {}),
    },
  });
}

/// Eventos não têm duração: para checar disponibilidade, cada evento ocupa
/// 30 min a partir de dateEvent (dois eventos conflitam se começam a menos
/// de 30 min um do outro).
const EVENT_SLOT_MS = 30 * 60 * 1000;

/// Função CALENDAR_EVENT do agente de IA: agenda (ou remarca `eventId`) um
/// evento do Target num horário livre.
/// - Com CrmSettings.calendarVisibleToAgent ligado e usuários permitidos:
///   escolhe um desses usuários sem outro evento no horário (o com menos
///   eventos no dia; na remarcação, mantém o atual se ele seguir livre) e
///   vincula ao evento. Nenhum livre = ConflictError.
/// - Senão: cria sem responsável, desde que não haja nenhum outro evento da
///   empresa no horário.
export async function scheduleCalendarEventForTarget(
  targetId: string,
  input: { name: string; description?: string | null; dateEvent: Date; eventId?: string },
) {
  const target = await prisma.target.findUnique({ where: { id: targetId }, select: { id: true, organizationId: true } });
  if (!target) throw new NotFoundError("Contato não encontrado.");
  const calendar = await getOrCreateCalendar(target.organizationId);

  let existing: { id: string; userId: string | null } | null = null;
  if (input.eventId) {
    const event = await prisma.calendarEvent.findFirst({ where: { id: input.eventId, targetId: target.id } });
    if (!event) throw new NotFoundError("Evento não encontrado.");
    if (event.isClosed) throw new ValidationError("Evento encerrado — não pode mais ser alterado.");
    existing = { id: event.id, userId: event.userId };
  }

  const start = input.dateEvent.getTime();
  const conflicts = await prisma.calendarEvent.findMany({
    where: {
      calendarOrganizationId: calendar.id,
      status: { not: "CANCELED" },
      dateEvent: { gt: new Date(start - EVENT_SLOT_MS), lt: new Date(start + EVENT_SLOT_MS) },
      ...(existing ? { id: { not: existing.id } } : {}),
    },
    select: { userId: true },
  });

  const settings = await prisma.crmSettings.findUnique({ where: { organizationId: target.organizationId } });
  let allowedUserIds: string[] = [];
  if (settings?.calendarVisibleToAgent && settings.calendarUserIds.length > 0) {
    const members = await prisma.member.findMany({
      where: { organizationId: target.organizationId, blocked: false, userId: { in: settings.calendarUserIds } },
      select: { userId: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    allowedUserIds = settings.calendarUserIds.filter((id) => memberIds.has(id));
  }

  let userId: string | null = null;
  if (allowedUserIds.length > 0) {
    const busy = new Set(conflicts.map((c) => c.userId).filter((id): id is string => !!id));
    const free = allowedUserIds.filter((id) => !busy.has(id));
    if (free.length === 0) throw new ConflictError("Nenhum responsável está livre nesse dia e horário.");

    if (existing?.userId && free.includes(existing.userId)) {
      userId = existing.userId;
    } else {
      // Distribui a agenda: o responsável livre com menos eventos no dia.
      const dayStart = new Date(input.dateEvent);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEvents = await prisma.calendarEvent.groupBy({
        by: ["userId"],
        where: {
          calendarOrganizationId: calendar.id,
          status: { not: "CANCELED" },
          userId: { in: free },
          dateEvent: { gte: dayStart, lt: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000) },
        },
        _count: { _all: true },
      });
      const load = new Map(dayEvents.map((e) => [e.userId, e._count._all]));
      userId = [...free].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0))[0];
    }
  } else if (conflicts.length > 0) {
    throw new ConflictError("Já existe outro evento agendado nesse dia e horário.");
  }

  const data = {
    name: input.name,
    description: input.description || null,
    dateEvent: input.dateEvent,
    userId,
  };
  const event = existing
    ? await prisma.calendarEvent.update({ where: { id: existing.id }, data, include: { user: { select: { id: true, name: true } } } })
    : await prisma.calendarEvent.create({
        data: { ...data, calendarOrganizationId: calendar.id, targetId: target.id },
        include: { user: { select: { id: true, name: true } } },
      });

  return { event, rescheduled: !!existing };
}

/// Eventos da empresa do Target dentro de [from, to] — pro agente de IA saber
/// o que o contato já tem marcado e quais horários já estão ocupados. Eventos
/// de OUTROS contatos voltam só com data/status (sem nome nem descrição), pra
/// o agente nunca repassar dado de um lead pra outro.
export async function listCalendarEventsForTarget(targetId: string, from: Date, to: Date) {
  if (to.getTime() < from.getTime()) throw new ValidationError("A data final precisa ser depois da inicial.");
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new ValidationError("Período muito longo (máx. 62 dias).");

  const target = await prisma.target.findUnique({ where: { id: targetId }, select: { id: true, organizationId: true } });
  if (!target) throw new NotFoundError("Contato não encontrado.");
  const calendar = await getOrCreateCalendar(target.organizationId);

  const events = await prisma.calendarEvent.findMany({
    where: { calendarOrganizationId: calendar.id, dateEvent: { gte: from, lte: to } },
    select: { id: true, targetId: true, name: true, description: true, dateEvent: true, status: true, isClosed: true },
    orderBy: { dateEvent: "asc" },
  });

  return {
    contactEvents: events
      .filter((e) => e.targetId === target.id)
      .map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        dateEvent: e.dateEvent,
        status: e.status,
        isClosed: e.isClosed,
      })),
    busySlots: events
      .filter((e) => e.targetId !== target.id && e.status !== "CANCELED")
      .map((e) => ({ dateEvent: e.dateEvent, status: e.status })),
  };
}

export const crmCalendarService = {
  /// Eventos da empresa ativa dentro de [from, to] — só o resumo que a grade
  /// do calendário precisa; o detalhe vem de getEvent.
  async listEvents(user: AuthUser, from: Date, to: Date) {
    if (to.getTime() < from.getTime()) throw new ValidationError("A data final precisa ser depois da inicial.");
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new ValidationError("Período muito longo (máx. 62 dias).");

    const calendar = await getOrCreateCalendar(user.activeOrganizationId!);
    return prisma.calendarEvent.findMany({
      where: { calendarOrganizationId: calendar.id, dateEvent: { gte: from, lte: to } },
      select: {
        id: true,
        name: true,
        dateEvent: true,
        status: true,
        isClosed: true,
        target: { select: EVENT_TARGET_SELECT },
      },
      orderBy: { dateEvent: "asc" },
    });
  },

  async findEvent(user: AuthUser, eventId: string) {
    const calendar = await getOrCreateCalendar(user.activeOrganizationId!);
    const event = await prisma.calendarEvent.findFirst({ where: { id: eventId, calendarOrganizationId: calendar.id } });
    if (!event) throw new NotFoundError("Evento não encontrado.");
    return event;
  },

  /// Tudo que o modal do evento precisa: contato, anotações com autor e os
  /// documentos já com URL presignada de leitura.
  async getEvent(user: AuthUser, eventId: string) {
    const existing = await this.findEvent(user, eventId);
    const event = await prisma.calendarEvent.findUniqueOrThrow({
      where: { id: existing.id },
      include: {
        target: { select: EVENT_TARGET_SELECT },
        user: { select: { id: true, name: true } },
        annotations: { orderBy: { createdAt: "desc" }, include: { user: { select: { id: true, name: true } } } },
      },
    });

    const documents = await Promise.all(
      event.documents.map(async (s3Key) => ({
        s3Key,
        fileName: documentFileName(s3Key),
        url: await createDownloadUrl(s3Key),
      })),
    );

    return { ...event, documents };
  },

  async createEvent(user: AuthUser, input: CreateCalendarEventInput) {
    const organizationId = user.activeOrganizationId!;
    await assertTargetBelongsToOrganization(input.targetId, organizationId);
    const calendar = await getOrCreateCalendar(organizationId);

    return prisma.calendarEvent.create({
      data: {
        calendarOrganizationId: calendar.id,
        targetId: input.targetId,
        name: input.name,
        description: input.description || null,
        dateEvent: input.dateEvent,
      },
    });
  },

  /// Evento encerrado só aceita reabrir (isClosed=false) e mudar o status —
  /// nome, descrição, data e contato ficam travados até reabrir.
  async updateEvent(user: AuthUser, eventId: string, input: UpdateCalendarEventInput) {
    const event = await this.findEvent(user, eventId);

    const changesData =
      input.name !== undefined ||
      input.description !== undefined ||
      input.dateEvent !== undefined ||
      input.targetId !== undefined;
    const staysClosed = input.isClosed ?? event.isClosed;
    if (staysClosed && changesData) throw new ValidationError("Evento encerrado — reabra o evento para editar os dados.");

    if (input.targetId) await assertTargetBelongsToOrganization(input.targetId, user.activeOrganizationId!);

    return prisma.calendarEvent.update({
      where: { id: event.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description || null } : {}),
        ...(input.dateEvent !== undefined ? { dateEvent: input.dateEvent } : {}),
        ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.isClosed !== undefined ? { isClosed: input.isClosed } : {}),
      },
    });
  },

  async deleteEvent(user: AuthUser, eventId: string) {
    const event = await this.findEvent(user, eventId);
    await prisma.calendarEvent.delete({ where: { id: event.id } });
    return event;
  },

  /// Busca de contato do modal de criar evento — só nome/telefone, 20 por
  /// vez. Endpoint próprio pra não exigir a permissão de Contatos de quem só
  /// usa o Kanban/calendário.
  async searchTargets(user: AuthUser, q?: string) {
    return prisma.target.findMany({
      where: {
        organizationId: user.activeOrganizationId!,
        ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { waId: { contains: q } }] } : {}),
      },
      select: EVENT_TARGET_SELECT,
      orderBy: { lastInteractionAt: { sort: "desc", nulls: "last" } },
      take: 20,
    });
  },

  // ---------- DOCUMENTOS ----------

  async presignDocument(user: AuthUser, eventId: string, input: PresignAttachmentInput) {
    const event = await this.findEvent(user, eventId);
    return createCalendarEventDocumentUploadUrl({
      organizationId: user.activeOrganizationId!,
      eventId: event.id,
      fileName: input.fileName,
      contentType: input.contentType,
    });
  },

  /// A chave precisa ter o prefixo deste evento/empresa — impede anexar
  /// arquivo de outro evento ou de outra empresa forjando a chave.
  async addDocument(user: AuthUser, eventId: string, input: AddAttachmentInput) {
    const event = await this.findEvent(user, eventId);
    if (!input.s3Key.startsWith(calendarEventDocumentKeyPrefix(user.activeOrganizationId!, event.id))) {
      throw new ValidationError("Arquivo inválido para este evento.");
    }
    return prisma.calendarEvent.update({ where: { id: event.id }, data: { documents: { push: input.s3Key } } });
  },

  /// Só tira da lista do evento — o arquivo continua no S3 (mesma regra do card).
  async removeDocument(user: AuthUser, eventId: string, s3Key: string) {
    const event = await this.findEvent(user, eventId);
    if (!event.documents.includes(s3Key)) throw new NotFoundError("Documento não encontrado neste evento.");
    return prisma.calendarEvent.update({
      where: { id: event.id },
      data: { documents: event.documents.filter((key) => key !== s3Key) },
    });
  },

  // ---------- ANOTAÇÕES ----------

  async addAnnotation(user: AuthUser, eventId: string, input: CalendarAnnotationInput) {
    const event = await this.findEvent(user, eventId);
    return prisma.calendarEventAnnotation.create({
      data: { eventId: event.id, userId: user.id, message: input.message },
      include: { user: { select: { id: true, name: true } } },
    });
  },

  async findOwnAnnotation(user: AuthUser, eventId: string, annotationId: string) {
    const event = await this.findEvent(user, eventId);
    const annotation = await prisma.calendarEventAnnotation.findFirst({ where: { id: annotationId, eventId: event.id } });
    if (!annotation) throw new NotFoundError("Anotação não encontrada.");
    if (annotation.userId !== user.id) throw new ForbiddenError("Só o autor pode alterar esta anotação.");
    return annotation;
  },

  async updateAnnotation(user: AuthUser, eventId: string, annotationId: string, input: CalendarAnnotationInput) {
    const annotation = await this.findOwnAnnotation(user, eventId, annotationId);
    return prisma.calendarEventAnnotation.update({
      where: { id: annotation.id },
      data: { message: input.message },
      include: { user: { select: { id: true, name: true } } },
    });
  },

  async deleteAnnotation(user: AuthUser, eventId: string, annotationId: string) {
    const annotation = await this.findOwnAnnotation(user, eventId, annotationId);
    await prisma.calendarEventAnnotation.delete({ where: { id: annotation.id } });
    return annotation;
  },
};
