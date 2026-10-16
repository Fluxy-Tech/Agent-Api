import { AGENT_DEFAULT_MESSAGES, DEFAULT_AGENT_PERSONALITY } from "../../domain/constants/agent-default-messages";
import { NotFoundError, ValidationError } from "../../domain/errors/app-error";
import { encryptToken } from "../../infrastructure/crypto/token-cipher";
import { prisma } from "../../infrastructure/database/prisma/client";
import { listWabaCatalogs } from "../../infrastructure/meta/meta-graph-client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import type { CreateAgentInput, ListAgentsQuery, UpdateAgentInput } from "./agent-validation";

function resolveRequired(value: string | undefined, label: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (!value) throw new ValidationError(`${label} é obrigatória e não pode ficar vazia.`);
  return value;
}

function resolveToggleable(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : value;
}

async function assertQueueBelongsToOrganization(queueId: string, organizationId: string): Promise<void> {
  const queue = await prisma.queue.findFirst({
    where: { id: queueId, serviceIsland: { organizationId }, deletedAt: null },
    select: { id: true },
  });
  if (!queue) throw new ValidationError("Fila padrão inválida para esta empresa.");
}

export const agentService = {
  async list(user: AuthUser, query: ListAgentsQuery = {}) {
    return prisma.agent.findMany({
      where: {
        organizationId: user.activeOrganizationId!,
        ...(query.includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: { createdAt: "desc" },
    });
  },

  /// Catálogos da Meta disponíveis para o agente: os conectados aos WABAs das
  /// redes sociais vinculadas a ele (o envio sai pelo número do canal, então
  /// só esses catálogos funcionam). Falha num canal não derruba os outros —
  /// volta em `errors` pro Console explicar (ex: token sem catalog_management).
  async listCatalogs(user: AuthUser, id: string) {
    const agent = await this.getById(user, id);
    const channels = await prisma.channel.findMany({
      where: { agentId: agent.id, organizationId: user.activeOrganizationId! },
      select: { wabaId: true, displayNumber: true, metaAccessToken: true },
    });

    const catalogs = new Map<string, { id: string; name: string }>();
    const errors: string[] = [];
    const seenWabas = new Set<string>();

    for (const channel of channels) {
      if (seenWabas.has(channel.wabaId)) continue;
      seenWabas.add(channel.wabaId);
      if (!channel.metaAccessToken) {
        errors.push(`${channel.displayNumber}: rede social sem token da Meta cadastrado.`);
        continue;
      }
      try {
        for (const catalog of await listWabaCatalogs(channel.wabaId, channel.metaAccessToken)) {
          catalogs.set(catalog.id, { id: catalog.id, name: catalog.name });
        }
      } catch (error) {
        errors.push(`${channel.displayNumber}: ${error instanceof Error ? error.message : "falha ao consultar a Meta."}`);
      }
    }

    return { catalogs: [...catalogs.values()], hasChannels: channels.length > 0, errors };
  },

  async getById(user: AuthUser, id: string) {
    const agent = await prisma.agent.findFirst({
      where: { id, organizationId: user.activeOrganizationId! },
    });
    if (!agent) throw new NotFoundError("Agente não encontrado.");
    return agent;
  },

  async create(user: AuthUser, input: CreateAgentInput) {
    if (input.defaultQueueId) {
      await assertQueueBelongsToOrganization(input.defaultQueueId, user.activeOrganizationId!);
    }

    return prisma.agent.create({
      data: {
        organizationId: user.activeOrganizationId!,
        name: input.name,
        isActive: input.isActive ?? true,

        processingMessage: resolveRequired(
          input.processingMessage,
          "Mensagem de processando",
          AGENT_DEFAULT_MESSAGES.processingMessage,
        ),
        transferMessage: resolveRequired(
          input.transferMessage,
          "Mensagem de transbordo",
          AGENT_DEFAULT_MESSAGES.transferMessage,
        ),
        unsupportedFormatMessage: resolveRequired(
          input.unsupportedFormatMessage,
          "Mensagem de formato não suportado",
          AGENT_DEFAULT_MESSAGES.unsupportedFormatMessage,
        ),
        blockedMessage: resolveRequired(
          input.blockedMessage,
          "Mensagem para números bloqueados",
          AGENT_DEFAULT_MESSAGES.blockedMessage,
        ),

        outOfHoursMessage: resolveToggleable(input.outOfHoursMessage, AGENT_DEFAULT_MESSAGES.outOfHoursMessage),
        outOfHoursEnabled: input.outOfHoursEnabled ?? true,

        closingMessage: resolveToggleable(input.closingMessage, AGENT_DEFAULT_MESSAGES.closingMessage),
        closingEnabled: input.closingEnabled ?? true,

        errorMessage: resolveToggleable(input.errorMessage, AGENT_DEFAULT_MESSAGES.errorMessage),
        errorEnabled: input.errorEnabled ?? true,

        defaultQueueId: input.defaultQueueId ?? null,

        personality: resolveToggleable(input.personality, DEFAULT_AGENT_PERSONALITY),
        ragEnabled: input.ragEnabled ?? false,
        ragChunkSize: input.ragChunkSize ?? null,

        rgbsEnabled: input.rgbsEnabled ?? false,
        timeSmall: input.timeSmall ?? 5,
        timeMedium: input.timeMedium ?? 10,
        timeLarge: input.timeLarge ?? 15,

        openaiTokenEncrypted: input.openaiToken ? encryptToken(input.openaiToken) : null,
        geminiTokenEncrypted: input.geminiToken ? encryptToken(input.geminiToken) : null,
      },
    });
  },

  async update(user: AuthUser, id: string, input: UpdateAgentInput) {
    const existing = await this.getById(user, id);

    if (input.defaultQueueId) {
      await assertQueueBelongsToOrganization(input.defaultQueueId, user.activeOrganizationId!);
    }

    const nextProcessing =
      input.processingMessage === undefined
        ? existing.processingMessage
        : resolveRequired(input.processingMessage, "Mensagem de processando", existing.processingMessage);
    const nextTransfer =
      input.transferMessage === undefined
        ? existing.transferMessage
        : resolveRequired(input.transferMessage, "Mensagem de transbordo", existing.transferMessage);
    const nextUnsupported =
      input.unsupportedFormatMessage === undefined
        ? existing.unsupportedFormatMessage
        : resolveRequired(
            input.unsupportedFormatMessage,
            "Mensagem de formato não suportado",
            existing.unsupportedFormatMessage,
          );
    const nextBlocked =
      input.blockedMessage === undefined
        ? existing.blockedMessage
        : resolveRequired(input.blockedMessage, "Mensagem para números bloqueados", existing.blockedMessage);

    return prisma.agent.update({
      where: { id: existing.id },
      data: {
        name: input.name ?? existing.name,
        isActive: input.isActive ?? existing.isActive,

        processingMessage: nextProcessing,
        transferMessage: nextTransfer,
        unsupportedFormatMessage: nextUnsupported,
        blockedMessage: nextBlocked,

        outOfHoursMessage: input.outOfHoursMessage ?? existing.outOfHoursMessage,
        outOfHoursEnabled: input.outOfHoursEnabled ?? existing.outOfHoursEnabled,

        closingMessage: input.closingMessage ?? existing.closingMessage,
        closingEnabled: input.closingEnabled ?? existing.closingEnabled,

        errorMessage: input.errorMessage ?? existing.errorMessage,
        errorEnabled: input.errorEnabled ?? existing.errorEnabled,

        defaultQueueId: input.defaultQueueId === undefined ? existing.defaultQueueId : input.defaultQueueId,

        personality: input.personality ?? existing.personality,
        ragEnabled: input.ragEnabled ?? existing.ragEnabled,
        ragChunkSize: input.ragChunkSize === undefined ? existing.ragChunkSize : input.ragChunkSize,

        rgbsEnabled: input.rgbsEnabled ?? existing.rgbsEnabled,
        timeSmall: input.timeSmall ?? existing.timeSmall,
        timeMedium: input.timeMedium ?? existing.timeMedium,
        timeLarge: input.timeLarge ?? existing.timeLarge,

        // Ausente/vazio = mantém o token já salvo — não existe forma de
        // "limpar" um token por essa rota, só sobrescrever com um novo (mesmo
        // padrão do metaAccessToken em whatsapp-channel-service.ts).
        openaiTokenEncrypted: input.openaiToken ? encryptToken(input.openaiToken) : existing.openaiTokenEncrypted,
        geminiTokenEncrypted: input.geminiToken ? encryptToken(input.geminiToken) : existing.geminiTokenEncrypted,
      },
    });
  },

  /// Nunca hard-delete (ver comentário de Agent.deletedAt no schema) —
  /// bloqueia de vez se algum WhatsApp Channel ainda apontar pro agente, em
  /// vez de soft-deletar por baixo dele. Idempotente: chamar de novo num
  /// agente já excluído não faz nada.
  async delete(user: AuthUser, id: string) {
    const agent = await prisma.agent.findFirst({
      where: { id, organizationId: user.activeOrganizationId! },
      include: { whatsappChannels: { select: { id: true } } },
    });
    if (!agent) throw new NotFoundError("Agente não encontrado.");
    if (agent.deletedAt) return agent;

    if (agent.whatsappChannels.length > 0) {
      throw new ValidationError(
        "Não é possível excluir um agente vinculado a um WhatsApp Channel. Desvincule-o (troque o agente do canal) antes de excluir.",
      );
    }

    return prisma.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
  },
};
