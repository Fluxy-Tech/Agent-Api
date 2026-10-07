import type { Prisma } from "../../../generated/prisma/client";
import { NotFoundError, ValidationError } from "../../domain/errors/app-error";
import { normalizeBrazilianWaId } from "../../domain/utils/phone";
import { sendCampaignToWorker } from "../../infrastructure/campaign-worker/campaign-worker-client";
import { prisma } from "../../infrastructure/database/prisma/client";
import { listWabaTemplates } from "../../infrastructure/meta/meta-graph-client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import type {
  CreateCampaignInput,
  ListCampaignsFilter,
  ListCampaignsQuery,
  UpdateCampaignDestinationInput,
} from "./campaign-validation";

function buildCampaignWhere(user: AuthUser, filter: ListCampaignsFilter): Prisma.CampaignWhereInput {
  return {
    organizationId: user.activeOrganizationId!,
    ...(filter.whatsappChannelId ? { whatsappChannelId: filter.whatsappChannelId } : {}),
    ...(filter.agentId ? { agentId: filter.agentId } : {}),
    ...(filter.search ? { name: { contains: filter.search, mode: "insensitive" } } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.templateName ? { templateName: filter.templateName } : {}),
    ...(filter.startDate || filter.endDate
      ? {
          sentAt: {
            ...(filter.startDate ? { gte: filter.startDate } : {}),
            ...(filter.endDate ? { lte: filter.endDate } : {}),
          },
        }
      : {}),
  };
}

async function resolveChannel(id: string, organizationId: string) {
  const channel = await prisma.channel.findFirst({
    where: { id, organizationId },
    include: { agent: true, serviceIsland: true },
  });
  if (!channel) throw new NotFoundError("WhatsApp Channel não encontrado.");
  if (!channel.serviceIsland) throw new NotFoundError("Ilha de atendimento do canal não encontrada.");
  // Campaign.agentId é obrigatório (snapshot do agente que disparou) — desde
  // que agentId virou opcional em Channel, um canal sem agente
  // vinculado não pode disparar campanha.
  if (!channel.agent) throw new ValidationError("Este canal não tem um agente de IA vinculado para disparar campanhas.");
  return { ...channel, agent: channel.agent };
}

/// routeToQueueId precisa ser uma fila da ilha deste canal; routeToUserId
/// (se vier) precisa ser um atendente daquela fila especificamente — evita
/// atribuir a campanha a alguém sem acesso pra ver o ticket depois.
async function assertRouteToHumanIsValid(
  serviceIslandId: string,
  routeToQueueId: string | undefined,
  routeToUserId: string | undefined,
) {
  if (!routeToQueueId) {
    if (routeToUserId) throw new ValidationError("routeToUserId exige routeToQueueId.");
    return;
  }

  const queue = await prisma.queue.findFirst({ where: { id: routeToQueueId, serviceIslandId, deletedAt: null } });
  if (!queue) throw new ValidationError("Fila de destino inválida para este canal.");

  if (routeToUserId) {
    const member = await prisma.queueMember.findFirst({ where: { queueId: routeToQueueId, userId: routeToUserId } });
    if (!member) throw new ValidationError("O atendente selecionado não pertence a essa fila.");
  }
}

interface DispatchTemplateParameter {
  type: string;
  text: string;
}

export interface DispatchContactInput {
  phone: string;
  name?: string;
  email?: string;
  /// Qualquer campo do contato que não seja telefone/nome/email vira metadado
  /// livre — mergeado em Target.metadata pelo Campaign-Worker (nunca apaga o
  /// que já existia).
  metadata?: Record<string, string>;
  parametersHeader?: DispatchTemplateParameter[];
  parametersBody?: DispatchTemplateParameter[];
  parametersButton?: DispatchTemplateParameter[];
  buttonSubType?: string;
}

export interface DispatchInput {
  organizationId: string;
  whatsappChannelId: string;
  campaignName: string;
  templateName: string;
  /// category/language são opcionais — se não vierem (caso do disparo padronizado,
  /// que só conhece o nome do template), são resolvidos consultando a Meta.
  category?: string;
  language?: string;
  dispatchType?: "CSV" | "MANUAL";
  templateHeaderText?: string;
  templateBodyText?: string;
  routeToQueueId?: string;
  routeToUserId?: string;
  createdByUserId?: string;
  createdByName?: string;
  createdByEmail?: string;
  /// Usado pelo disparo ativo do Desk — suprime a transferMessage genérica do
  /// agente quando o ticket nasce a partir desse disparo.
  skipTransferMessage?: boolean;
  /// Disparo escalonado: se batchSize/batchIntervalMinutes ou scheduledAt
  /// vierem, a lista NÃO vai pra fila do Campaign-Worker — fica em
  /// CampaignPendingContact e o scheduler do worker envia os lotes.
  batchSize?: number;
  batchIntervalMinutes?: number;
  scheduledAt?: Date;
  contacts: DispatchContactInput[];
}

/// Inserção da lista de contatos em pedaços — CSVs grandes estourariam o
/// limite de parâmetros do Postgres num único INSERT.
const PENDING_CONTACTS_CHUNK_SIZE = 1000;

export const campaignService = {
  /// Ponto único de disparo ativo de template — usado pelo fluxo de sessão
  /// (create, abaixo), pela integração da Metrópole (triggerSystemCampaign,
  /// abaixo) e pela rota /internal/campaigns/dispatch (chamável por qualquer
  /// serviço confiável, incluindo a futura API externa e o disparo pelo Desk).
  /// Cria a Campaign de forma síncrona e só então chama o Campaign-Worker, que
  /// enfileira o envio em massa. Se a chamada ao worker falhar, a campanha fica
  /// órfã em PROCESSING — mesmo comportamento de falha do app antigo.
  async dispatch(params: DispatchInput) {
    const channel = await resolveChannel(params.whatsappChannelId, params.organizationId);

    const semTelefone = params.contacts.some((c) => !c.phone);
    if (semTelefone) throw new ValidationError("Todo contato precisa ter telefone preenchido.");

    await assertRouteToHumanIsValid(channel.serviceIsland!.id, params.routeToQueueId, params.routeToUserId);

    let { category, language } = params;
    if (!category || !language) {
      if (!channel.metaAccessToken) {
        throw new ValidationError("Este canal ainda não tem um token de acesso da Meta cadastrado.");
      }

      const templates = await listWabaTemplates(channel.wabaId, channel.metaAccessToken);
      const matches = templates.filter(
        (t) => t.name === params.templateName && t.status === "APPROVED" && (!language || t.language === language),
      );

      if (matches.length === 0) {
        throw new ValidationError(
          `Nenhum template aprovado chamado "${params.templateName}" foi encontrado neste canal${language ? ` no idioma ${language}` : ""}.`,
        );
      }
      if (matches.length > 1) {
        throw new ValidationError(
          `Existem ${matches.length} templates aprovados chamados "${params.templateName}" em idiomas diferentes — informe "language" para desambiguar.`,
        );
      }

      category = category ?? matches[0].category;
      language = language ?? matches[0].language;
    }

    const isScheduled = Boolean(params.batchSize || params.scheduledAt);
    if (isScheduled) {
      const campaign = await prisma.$transaction(
        async (tx) => {
          const created = await tx.campaign.create({
            data: {
              organizationId: params.organizationId,
              whatsappChannelId: channel.id,
              agentId: channel.agent.id,
              name: params.campaignName,
              category,
              templateName: params.templateName,
              language,
              dispatchType: params.dispatchType ?? "MANUAL",
              expectedContacts: params.contacts.length,
              createdByUserId: params.createdByUserId,
              createdByName: params.createdByName,
              createdByEmail: params.createdByEmail,
              routeToQueueId: params.routeToQueueId,
              routeToUserId: params.routeToUserId,
              templateHeaderText: params.templateHeaderText,
              templateBodyText: params.templateBodyText,
              // Agendamento sem lote (ex: disparo manual agendado) = manda
              // tudo de uma vez quando chegar a hora.
              batchSize: params.batchSize ?? params.contacts.length,
              batchIntervalMinutes: params.batchIntervalMinutes ?? 1,
              scheduledAt: params.scheduledAt,
              nextBatchAt: params.scheduledAt ?? new Date(),
            },
          });

          for (let i = 0; i < params.contacts.length; i += PENDING_CONTACTS_CHUNK_SIZE) {
            await tx.campaignPendingContact.createMany({
              data: params.contacts.slice(i, i + PENDING_CONTACTS_CHUNK_SIZE).map((contact, j) => ({
                campaignId: created.id,
                position: i + j,
                contact: contact as unknown as Prisma.InputJsonValue,
              })),
            });
          }

          return created;
        },
        { timeout: 60_000 },
      );

      return this.toListItem(campaign, channel.displayNumber, channel.agent.name);
    }

    const campaign = await prisma.campaign.create({
      data: {
        organizationId: params.organizationId,
        whatsappChannelId: channel.id,
        // Snapshot do agente que atende o canal NESTE momento — trocar o
        // agente do canal depois não deve alterar quem aparece no histórico
        // desta campanha (ver comentário do campo no schema.prisma).
        agentId: channel.agent.id,
        name: params.campaignName,
        category,
        templateName: params.templateName,
        language,
        dispatchType: params.dispatchType ?? "MANUAL",
        expectedContacts: params.contacts.length,
        createdByUserId: params.createdByUserId,
        createdByName: params.createdByName,
        createdByEmail: params.createdByEmail,
        routeToQueueId: params.routeToQueueId,
        routeToUserId: params.routeToUserId,
      },
    });

    await sendCampaignToWorker({
      campaignId: campaign.id,
      organizationId: params.organizationId,
      whatsappChannelId: channel.id,
      phoneNumberId: channel.phoneNumberId,
      wabaId: channel.wabaId,
      serviceIslandId: channel.serviceIsland!.id,
      agentId: channel.agent.id,
      agentName: channel.agent.name,
      templateName: params.templateName,
      language,
      category,
      templateHeaderText: params.templateHeaderText,
      templateBodyText: params.templateBodyText,
      contacts: params.contacts,
      routeToQueueId: params.routeToQueueId,
      routeToUserId: params.routeToUserId,
      skipTransferMessage: params.skipTransferMessage,
    });

    return this.toListItem(campaign, channel.displayNumber, channel.agent.name);
  },

  /// Disparo de campanha sem sessão de usuário (chamado via /internal/*, ex:
  /// a Metrópole avisando um novo cadastro) — sempre dispara pra 1 único
  /// contato, resolve o canal só pelo id (o caller já é confiável, autenticado
  /// por x-internal-api-key) em vez de por organizationId de uma sessão.
  async triggerSystemCampaign(input: {
    whatsappChannelId: string;
    phone: string;
    name: string;
    templateName: string;
    language: string;
    category: string;
    createdByName?: string;
  }) {
    const channel = await prisma.channel.findUnique({ where: { id: input.whatsappChannelId } });
    if (!channel) throw new NotFoundError("WhatsApp Channel configurado para a Metrópole não encontrado.");

    return this.dispatch({
      organizationId: channel.organizationId,
      whatsappChannelId: channel.id,
      campaignName: `Boas-vindas — ${input.name}`,
      templateName: input.templateName,
      language: input.language,
      category: input.category,
      dispatchType: "MANUAL",
      createdByName: input.createdByName ?? "Integração Metrópole",
      contacts: [
        {
          phone: input.phone,
          name: input.name,
          parametersBody: [{ type: "text", text: input.name }],
        },
      ],
    });
  },

  /// Cria a Campaign a partir do formulário de sessão do Agent Console —
  /// category/language já vêm explícitos do frontend (que consultou a Meta
  /// antes), então dispatch() não precisa resolver nada.
  async create(user: AuthUser, input: CreateCampaignInput) {
    const contacts = input.contacts.map((c) => ({ ...c, email: c.email || undefined }));

    return this.dispatch({
      organizationId: user.activeOrganizationId!,
      whatsappChannelId: input.whatsappChannelId,
      campaignName: input.name,
      templateName: input.templateName,
      category: input.category,
      language: input.language,
      dispatchType: input.dispatchType,
      templateHeaderText: input.templateHeaderText,
      templateBodyText: input.templateBodyText,
      routeToQueueId: input.routeToQueueId,
      routeToUserId: input.routeToUserId,
      createdByUserId: user.id,
      createdByName: user.name,
      createdByEmail: user.email,
      batchSize: input.batchSize,
      batchIntervalMinutes: input.batchIntervalMinutes,
      scheduledAt: input.scheduledAt,
      contacts,
    });
  },

  /// Pausa/retoma um disparo escalonado. Retomar não mexe em nextBatchAt: se
  /// o horário do próximo lote já passou, o scheduler pega no próximo tick;
  /// se não, respeita o intervalo que faltava.
  async setActive(user: AuthUser, id: string, active: boolean) {
    const campaign = await this.findScheduledCampaign(user, id);
    if (campaign.status === "COMPLETED") throw new ValidationError("Esta campanha já foi concluída.");

    if (active) {
      // O destino pode ter sido alterado enquanto pausada — revalida antes de
      // voltar a disparar (fila/atendente podem ter sido removidos).
      await assertRouteToHumanIsValid(
        campaign.whatsappChannel.serviceIsland!.id,
        campaign.routeToQueueId ?? undefined,
        campaign.routeToUserId ?? undefined,
      );
    }

    await prisma.campaign.update({ where: { id: campaign.id }, data: { active } });
    return this.getById(user, id);
  },

  /// Troca o destino dos contatos que ainda vão ser disparados — Agente de IA
  /// (sem fila) ou Atendimento humano (fila + atendente opcional). Só com a
  /// campanha pausada, pra não mudar o destino no meio de um lote.
  async updateDestination(user: AuthUser, id: string, input: UpdateCampaignDestinationInput) {
    const campaign = await this.findScheduledCampaign(user, id);
    if (campaign.status === "COMPLETED") throw new ValidationError("Esta campanha já foi concluída.");
    if (campaign.active) throw new ValidationError("Pause a campanha antes de alterar o destino.");

    const routeToQueueId = input.routeToQueueId ?? undefined;
    const routeToUserId = routeToQueueId ? (input.routeToUserId ?? undefined) : undefined;
    await assertRouteToHumanIsValid(campaign.whatsappChannel.serviceIsland!.id, routeToQueueId, routeToUserId);

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { routeToQueueId: routeToQueueId ?? null, routeToUserId: routeToUserId ?? null },
    });
    return this.getById(user, id);
  },

  async findScheduledCampaign(user: AuthUser, id: string) {
    const campaign = await prisma.campaign.findFirst({
      where: { id, organizationId: user.activeOrganizationId! },
      include: { whatsappChannel: { include: { serviceIsland: true } } },
    });
    if (!campaign) throw new NotFoundError("Campanha não encontrada.");
    if (campaign.batchSize === null) {
      throw new ValidationError("Apenas campanhas com disparo escalonado podem ser pausadas ou ter o destino alterado.");
    }
    if (!campaign.whatsappChannel.serviceIsland) throw new NotFoundError("Ilha de atendimento do canal não encontrada.");
    return campaign;
  },

  async list(user: AuthUser, query: ListCampaignsQuery) {
    const where = buildCampaignWhere(user, query);

    const [rows, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        include: { whatsappChannel: true, agent: true },
        orderBy: { sentAt: query.sortDir },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.campaign.count({ where }),
    ]);

    return {
      items: rows.map((c) => this.toListItem(c, c.whatsappChannel.displayNumber, c.agent.name)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  },

  /// Métricas da fileira de cards do topo da tela de Campanhas — mesmos
  /// filtros de `list()` (sem paginação), sempre recalculadas na hora.
  async getStats(user: AuthUser, filter: ListCampaignsFilter) {
    const where = buildCampaignWhere(user, filter);

    const [totalCampaigns, completedCampaigns, aggregates, campaignIds] = await Promise.all([
      prisma.campaign.count({ where }),
      prisma.campaign.count({ where: { ...where, status: "COMPLETED" } }),
      prisma.campaign.aggregate({ where, _sum: { totalContacts: true, totalFailures: true } }),
      prisma.campaign.findMany({ where, select: { id: true } }),
    ]);

    const uniqueContactRows =
      campaignIds.length > 0
        ? await prisma.campaignTarget.findMany({
            where: { campaignId: { in: campaignIds.map((c) => c.id) } },
            distinct: ["targetId"],
            select: { targetId: true },
          })
        : [];

    return {
      totalCampaigns,
      completedCampaigns,
      totalMessagesSent: aggregates._sum.totalContacts ?? 0,
      totalFailures: aggregates._sum.totalFailures ?? 0,
      uniqueContacts: uniqueContactRows.length,
    };
  },

  /// Nomes de template já usados pela empresa — popula o select "Template"
  /// do filtro (não é a lista de templates cadastrados na Meta, é só o que já
  /// foi disparado alguma vez).
  async getFilterOptions(user: AuthUser) {
    const rows = await prisma.campaign.findMany({
      where: { organizationId: user.activeOrganizationId! },
      distinct: ["templateName"],
      select: { templateName: true },
      orderBy: { templateName: "asc" },
    });
    return { templates: rows.map((r) => r.templateName) };
  },

  /// Usado pela tela de "Nova campanha" ANTES de disparar: dado um canal e a
  /// lista de telefones que vão receber o template, devolve quais deles têm
  /// um Target bloqueado de campanha NESTE canal (ver TargetBlockCampaign,
  /// criado pelo Inbound-Service quando o contato responde com uma frase de
  /// Channel.wordsToBlockCampaign). O front usa isso pra avisar o usuário e,
  /// se ele confirmar, remove esses telefones da lista antes de enviar.
  async findBlockedPhones(user: AuthUser, whatsappChannelId: string, phones: string[]): Promise<string[]> {
    const organizationId = user.activeOrganizationId!;
    const channel = await prisma.channel.findFirst({ where: { id: whatsappChannelId, organizationId } });
    if (!channel) throw new NotFoundError("WhatsApp Channel não encontrado.");

    // waId normalizado -> telefone original enviado pelo front, pra devolver
    // exatamente os valores que ele já tem na lista de contatos.
    const normalizedToOriginal = new Map<string, string>();
    for (const phone of phones) normalizedToOriginal.set(normalizeBrazilianWaId(phone), phone);

    const blocks = await prisma.targetBlockCampaign.findMany({
      where: { whatsappChannelId: channel.id, target: { waId: { in: [...normalizedToOriginal.keys()] } } },
      select: { target: { select: { waId: true } } },
    });

    const blockedOriginals = new Set<string>();
    for (const b of blocks) {
      const original = b.target.waId ? normalizedToOriginal.get(b.target.waId) : undefined;
      if (original) blockedOriginals.add(original);
    }
    return [...blockedOriginals];
  },

  async getById(user: AuthUser, id: string) {
    const campaign = await prisma.campaign.findFirst({
      where: { id, organizationId: user.activeOrganizationId! },
      include: {
        whatsappChannel: true,
        agent: true,
        routeToQueue: { select: { name: true } },
        routeToUser: { select: { name: true } },
      },
    });
    if (!campaign) throw new NotFoundError("Campanha não encontrada.");

    const [targets, pendingContacts] = await Promise.all([
      prisma.campaignTarget.findMany({
        where: { campaignId: campaign.id },
        include: { target: { select: { name: true, waId: true } } },
        orderBy: { createdAt: "asc" },
      }),
      campaign.batchSize !== null ? prisma.campaignPendingContact.count({ where: { campaignId: campaign.id } }) : 0,
    ]);

    return {
      ...this.toListItem(campaign, campaign.whatsappChannel.displayNumber, campaign.agent.name),
      routeToQueueId: campaign.routeToQueueId,
      routeToQueueName: campaign.routeToQueue?.name ?? null,
      routeToUserId: campaign.routeToUserId,
      routeToUserName: campaign.routeToUser?.name ?? null,
      pendingContacts,
      targets: targets.map((t) => ({
        id: t.id,
        targetId: t.targetId,
        targetName: t.target.name,
        targetPhone: t.target.waId,
        status: t.status,
        messageId: t.messageId,
        variables: t.variables,
        createdAt: t.createdAt,
      })),
    };
  },

  /// agentId/agentName vêm da própria Campaign (snapshot do momento do
  /// disparo, ver comentário do campo no schema.prisma) — NUNCA do
  /// whatsappChannel.agent atual, que pode já apontar pra outro agente.
  toListItem(
    c: {
      id: string;
      name: string;
      category: string | null;
      templateName: string;
      status: string;
      dispatchType: string;
      expectedContacts: number;
      totalContacts: number;
      totalSent: number;
      totalFailures: number;
      whatsappChannelId: string;
      agentId: string;
      createdByName: string | null;
      createdByEmail: string | null;
      sentAt: Date;
      batchSize: number | null;
      batchIntervalMinutes: number | null;
      active: boolean;
      scheduledAt: Date | null;
      nextBatchAt: Date | null;
    },
    whatsappChannelDisplayNumber: string,
    agentName: string,
  ) {
    return {
      id: c.id,
      name: c.name,
      category: c.category,
      templateName: c.templateName,
      status: c.status,
      dispatchType: c.dispatchType,
      expectedContacts: c.expectedContacts,
      totalContacts: c.totalContacts,
      totalSent: c.totalSent,
      totalFailures: c.totalFailures,
      whatsappChannelId: c.whatsappChannelId,
      whatsappChannelDisplayNumber,
      agentId: c.agentId,
      agentName,
      createdByName: c.createdByName,
      createdByEmail: c.createdByEmail,
      sentAt: c.sentAt,
      batchSize: c.batchSize,
      batchIntervalMinutes: c.batchIntervalMinutes,
      active: c.active,
      scheduledAt: c.scheduledAt,
      nextBatchAt: c.nextBatchAt,
    };
  },
};
