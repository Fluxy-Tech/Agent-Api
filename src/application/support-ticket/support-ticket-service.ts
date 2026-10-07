import { Prisma } from "../../../generated/prisma/client";
import { ForbiddenError, NotFoundError, ValidationError } from "../../domain/errors/app-error";
import { prisma } from "../../infrastructure/database/prisma/client";
import {
  createDownloadUrl,
  createSupportAttachmentUploadUrl,
  headObject,
  supportAttachmentKeyPrefix,
} from "../../infrastructure/storage/s3-client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import { isSupportOrganization } from "../company/support-organization";
import { notifyMessageCreated, notifyTicketOpened } from "./support-notifier";
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  type CreateSupportMessageInput,
  type CreateSupportTicketInput,
  type ListSupportTicketsQuery,
  type MarkSupportTicketReadInput,
  type PresignSupportAttachmentInput,
  type SupportAttachmentRef,
  type UpdateSupportTicketInput,
} from "./support-ticket-validation";

/// Time de apoio = Administrador da plataforma (User.role "admin") ou time
/// de suporte (User.role "support", ver platform-role.ts). Vê e
/// responde os chamados de TODAS as empresas; o resto só enxerga os da
/// empresa ativa.
/// Só conta como time de suporte dentro da central "Suporte Sturnus"
/// (actingAsSupport) — numa empresa cliente, Administrador/flag de suporte é
/// tratado como membro daquela empresa.
function isSupportTeam(user: AuthUser): boolean {
  return user.actingAsSupport;
}

/// Empresa: só os tickets dela. Time de suporte: todas as empresas, mas só
/// as classificações pelas quais a pessoa responde (Administrador: todas).
function ticketScope(user: AuthUser): Prisma.SupportTicketWhereInput {
  if (!isSupportTeam(user)) return { organizationId: user.activeOrganizationId! };
  return user.supportSeverities ? { severity: { in: user.supportSeverities } } : {};
}

function ticketScopeSql(user: AuthUser): Prisma.Sql {
  if (!isSupportTeam(user)) return Prisma.sql`t."organizationId" = ${user.activeOrganizationId!}`;
  if (!user.supportSeverities) return Prisma.sql`TRUE`;
  if (user.supportSeverities.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`t."severity"::text IN (${Prisma.join(user.supportSeverities)})`;
}

const USER_SELECT = { id: true, name: true, email: true } as const;

const ATTACHMENT_SELECT = {
  id: true,
  fileName: true,
  contentType: true,
  size: true,
  s3Key: true,
  createdAt: true,
  uploadedBy: { select: USER_SELECT },
} as const;

async function withUrls<T extends { s3Key: string }>(attachments: T[]) {
  return Promise.all(
    attachments.map(async ({ s3Key, ...attachment }) => ({ ...attachment, url: await createDownloadUrl(s3Key) })),
  );
}

/// Confirma anexos já enviados direto pro S3: a chave precisa estar no
/// prefixo da empresa do chamado (impede anexar arquivo de outra empresa
/// forjando a chave) e o objeto precisa existir e respeitar o limite de
/// tamanho de verdade — o tamanho gravado é o do S3, não o declarado.
async function resolveAttachments(organizationId: string, refs: SupportAttachmentRef[]) {
  const prefix = supportAttachmentKeyPrefix(organizationId);

  return Promise.all(
    refs.map(async (ref) => {
      if (!ref.s3Key.startsWith(prefix)) throw new ValidationError(`Arquivo inválido: ${ref.fileName}.`);

      const head = await headObject(ref.s3Key);
      if (!head) throw new ValidationError(`O envio de ${ref.fileName} não foi concluído. Anexe de novo.`);
      if (head.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
        throw new ValidationError(`${ref.fileName} passa do limite de 25 MB.`);
      }

      return { s3Key: ref.s3Key, fileName: ref.fileName, contentType: ref.contentType, size: head.size };
    }),
  );
}

interface UnreadRow {
  ticketId: string;
  code: number;
  title: string;
  status: string;
  neverRead: boolean;
  unread: number;
}

/// Não lidas do usuário, por chamado: mensagens do OUTRO lado (empresa ↔
/// apoio) depois do lastReadAt dele (sem linha de leitura = todas). Pro time
/// de apoio, chamado nunca aberto e ainda não resolvido também conta como
/// "novo", mesmo sem mensagem nenhuma (só a abertura).
async function unreadRows(user: AuthUser) {
  const supportTeam = isSupportTeam(user);
  const otherSide = supportTeam ? "CUSTOMER" : "SUPPORT";
  const scope = ticketScopeSql(user);

  const rows = await prisma.$queryRaw<UnreadRow[]>`
    SELECT t."id" AS "ticketId", t."code", t."title", t."status"::text AS "status",
           (r."lastReadAt" IS NULL) AS "neverRead",
           (SELECT count(*)::int FROM "SupportTicketMessage" m
             WHERE m."ticketId" = t."id"
               AND m."authorType"::text = ${otherSide}
               AND (r."lastReadAt" IS NULL OR m."createdAt" > r."lastReadAt")) AS "unread"
    FROM "SupportTicket" t
    LEFT JOIN "SupportTicketReadState" r ON r."ticketId" = t."id" AND r."userId" = ${user.id}
    WHERE ${scope}
  `;

  return rows
    .map((row) => ({
      ticketId: row.ticketId,
      code: row.code,
      title: row.title,
      unreadCount: row.unread,
      isNew: supportTeam && row.neverRead && row.status !== "RESOLVED",
    }))
    .filter((row) => row.unreadCount > 0 || row.isNew);
}

async function markReadUpTo(ticketId: string, userId: string, readUpTo: Date) {
  const existing = await prisma.supportTicketReadState.findUnique({
    where: { ticketId_userId: { ticketId, userId } },
  });
  // Nunca volta no tempo — um "lido até" atrasado (polling antigo) não pode
  // desmarcar como lido algo que já tinha sido lido.
  if (existing && existing.lastReadAt >= readUpTo) return existing;

  return prisma.supportTicketReadState.upsert({
    where: { ticketId_userId: { ticketId, userId } },
    create: { ticketId, userId, lastReadAt: readUpTo },
    update: { lastReadAt: readUpTo },
  });
}

export const supportTicketService = {
  async findAccessible(user: AuthUser, id: string) {
    const ticket = await prisma.supportTicket.findFirst({ where: { id, ...ticketScope(user) } });
    if (!ticket) throw new NotFoundError("Chamado não encontrado.");
    return ticket;
  },

  /// Lista mais recente primeiro (última mensagem). O time de apoio recebe
  /// também o nome da empresa de cada chamado.
  async list(user: AuthUser, query: ListSupportTicketsQuery) {
    const [tickets, unread] = await Promise.all([this.findMany(user, query), unreadRows(user)]);
    const unreadByTicket = new Map(unread.map((row) => [row.ticketId, row]));

    return tickets.map(({ messages, ...ticket }) => ({
      ...ticket,
      // Prévia da conversa na lista (estilo Desk): última mensagem, ou null
      // quando só existe a abertura.
      lastMessage: messages[0]
        ? {
            content: messages[0].content,
            authorType: messages[0].authorType,
            createdAt: messages[0].createdAt,
            attachmentCount: messages[0]._count.attachments,
          }
        : null,
      unreadCount: unreadByTicket.get(ticket.id)?.unreadCount ?? 0,
      isNew: unreadByTicket.get(ticket.id)?.isNew ?? false,
    }));
  },

  /// Dashboard do time de suporte: totais por status e a mesma contagem por
  /// empresa — sempre dentro das classificações da pessoa.
  async dashboard(user: AuthUser) {
    if (!isSupportTeam(user)) throw new ForbiddenError("Dashboard exclusivo do time de suporte.");

    const groups = await prisma.supportTicket.groupBy({
      by: ["organizationId", "status"],
      where: ticketScope(user),
      _count: { _all: true },
    });

    type Counts = { total: number; OPEN: number; IN_PROGRESS: number; WAITING_CUSTOMER: number; RESOLVED: number };
    const empty = (): Counts => ({ total: 0, OPEN: 0, IN_PROGRESS: 0, WAITING_CUSTOMER: 0, RESOLVED: 0 });

    const totals = empty();
    const byOrganization = new Map<string, Counts>();
    for (const group of groups) {
      const count = group._count._all;
      const org = byOrganization.get(group.organizationId) ?? empty();
      org[group.status] += count;
      org.total += count;
      byOrganization.set(group.organizationId, org);
      totals[group.status] += count;
      totals.total += count;
    }

    const organizations = await prisma.organization.findMany({
      where: { id: { in: [...byOrganization.keys()] } },
      select: { id: true, name: true },
    });

    return {
      totals,
      severities: user.supportSeverities,
      organizations: organizations
        .map((org) => ({ organizationId: org.id, name: org.name, ...byOrganization.get(org.id)! }))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    };
  },

  /// Contador do menu + base dos toasts/notificações do navegador.
  async unread(user: AuthUser) {
    const tickets = await unreadRows(user);
    return {
      tickets: tickets.length,
      messages: tickets.reduce((sum, ticket) => sum + ticket.unreadCount, 0),
      items: tickets,
    };
  },

  /// readUpTo = data da mensagem mais recente que a tela realmente mostrou
  /// (não "agora"): se chegar mensagem entre o GET e esta chamada, ela
  /// continua não lida. Limitado a agora, pra não marcar o futuro como lido.
  async markRead(user: AuthUser, ticketId: string, input: MarkSupportTicketReadInput) {
    const ticket = await this.findAccessible(user, ticketId);
    const now = new Date();
    const readUpTo = input.readUpTo && input.readUpTo < now ? input.readUpTo : now;
    await markReadUpTo(ticket.id, user.id, readUpTo);
    return { ticketId: ticket.id, lastReadAt: readUpTo };
  },

  async findMany(user: AuthUser, query: ListSupportTicketsQuery) {
    return prisma.supportTicket.findMany({
      where: {
        ...ticketScope(user),
        ...(query.status ? { status: query.status } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
      },
      orderBy: { lastMessageAt: "desc" },
      take: 500,
      select: {
        id: true,
        code: true,
        title: true,
        severity: true,
        status: true,
        lastMessageAt: true,
        resolvedAt: true,
        createdAt: true,
        updatedAt: true,
        organization: { select: { id: true, name: true } },
        openedBy: { select: USER_SELECT },
        _count: { select: { messages: true, attachments: true } },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { content: true, authorType: true, createdAt: true, _count: { select: { attachments: true } } },
        },
      },
    });
  },

  async getById(user: AuthUser, id: string) {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id, ...ticketScope(user) },
      include: {
        organization: { select: { id: true, name: true } },
        openedBy: { select: USER_SELECT },
        attachments: { where: { messageId: null }, orderBy: { createdAt: "asc" }, select: ATTACHMENT_SELECT },
        messages: {
          orderBy: { createdAt: "asc" },
          include: {
            author: { select: USER_SELECT },
            attachments: { orderBy: { createdAt: "asc" }, select: ATTACHMENT_SELECT },
          },
        },
      },
    });
    if (!ticket) throw new NotFoundError("Chamado não encontrado.");

    return {
      ...ticket,
      attachments: await withUrls(ticket.attachments),
      messages: await Promise.all(
        ticket.messages.map(async (message) => ({ ...message, attachments: await withUrls(message.attachments) })),
      ),
    };
  },

  async presignAttachment(user: AuthUser, input: PresignSupportAttachmentInput) {
    const organizationId = input.ticketId
      ? (await this.findAccessible(user, input.ticketId)).organizationId
      : user.activeOrganizationId!;

    return createSupportAttachmentUploadUrl({
      organizationId,
      fileName: input.fileName,
      contentType: input.contentType,
    });
  },

  async create(user: AuthUser, input: CreateSupportTicketInput) {
    const organizationId = user.activeOrganizationId!;
    if (isSupportOrganization(organizationId)) {
      throw new ValidationError("A Suporte Sturnus é a central de atendimento — abra o chamado pela empresa cliente.");
    }
    const attachments = await resolveAttachments(organizationId, input.attachments);

    const ticket = await prisma.supportTicket.create({
      data: {
        organizationId,
        openedById: user.id,
        title: input.title,
        description: input.description,
        severity: input.severity,
        attachments: { create: attachments.map((attachment) => ({ ...attachment, uploadedById: user.id })) },
        // Quem abre já "leu" o próprio chamado.
        readStates: { create: { userId: user.id, lastReadAt: new Date() } },
      },
    });

    void notifyTicketOpened(ticket.id);
    return ticket;
  },

  /// Mensagem no histórico do chamado. Quem escreve define o lado
  /// (Administrador = SUPPORT, resto = CUSTOMER) e o status anda sozinho:
  /// - apoio respondendo um chamado OPEN → IN_PROGRESS;
  /// - empresa respondendo WAITING_CUSTOMER → IN_PROGRESS;
  /// - empresa escrevendo num chamado RESOLVED → reabre como OPEN.
  async addMessage(user: AuthUser, ticketId: string, input: CreateSupportMessageInput) {
    const ticket = await this.findAccessible(user, ticketId);
    const attachments = await resolveAttachments(ticket.organizationId, input.attachments);
    const authorType = isSupportTeam(user) ? "SUPPORT" : "CUSTOMER";

    let nextStatus = ticket.status;
    if (authorType === "SUPPORT" && ticket.status === "OPEN") nextStatus = "IN_PROGRESS";
    if (authorType === "CUSTOMER" && ticket.status === "WAITING_CUSTOMER") nextStatus = "IN_PROGRESS";
    if (authorType === "CUSTOMER" && ticket.status === "RESOLVED") nextStatus = "OPEN";

    const now = new Date();
    const [message] = await prisma.$transaction([
      prisma.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorId: user.id,
          authorType,
          content: input.content,
          attachments: {
            create: attachments.map((attachment) => ({ ...attachment, ticketId: ticket.id, uploadedById: user.id })),
          },
        },
      }),
      prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          lastMessageAt: now,
          status: nextStatus,
          ...(nextStatus !== "RESOLVED" && ticket.status === "RESOLVED" ? { resolvedAt: null } : {}),
        },
      }),
    ]);

    // Quem escreve leu tudo o que veio antes da própria mensagem.
    await markReadUpTo(ticket.id, user.id, message.createdAt);
    void notifyMessageCreated(message.id);
    return message;
  },

  /// Time de apoio muda status e reclassifica a severidade livremente. A
  /// empresa só pode encerrar o próprio chamado (RESOLVED) — reabrir é
  /// mandando uma nova mensagem.
  async update(user: AuthUser, ticketId: string, input: UpdateSupportTicketInput) {
    const ticket = await this.findAccessible(user, ticketId);

    if (!isSupportTeam(user)) {
      if (input.severity !== undefined) {
        throw new ForbiddenError("Só o time de apoio pode reclassificar a severidade.");
      }
      if (input.status !== undefined && input.status !== "RESOLVED") {
        throw new ForbiddenError("Você só pode encerrar o chamado. Para reabrir, envie uma nova mensagem.");
      }
    }

    const status = input.status ?? ticket.status;
    return prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status,
        severity: input.severity ?? ticket.severity,
        resolvedAt: status === "RESOLVED" ? (ticket.resolvedAt ?? new Date()) : null,
      },
    });
  },
};
