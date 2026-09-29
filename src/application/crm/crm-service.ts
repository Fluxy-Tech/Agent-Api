import type { CardPriority } from "../../../generated/prisma/client";
import { ForbiddenError, NotFoundError, ValidationError } from "../../domain/errors/app-error";
import { prisma } from "../../infrastructure/database/prisma/client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import {
  createCrmAttachmentUploadUrl,
  createDownloadUrl,
  crmAttachmentKeyPrefix,
} from "../../infrastructure/storage/s3-client";
import type {
  AddAttachmentInput,
  CreateCommentInput,
  CreateStageInput,
  MoveCardInput,
  PresignAttachmentInput,
  UpdatePriorityInput,
  UpdateStageInput,
} from "./crm-validation";

/// A chave é `<prefixo>/<timestamp>-<nome_seguro>` — o nome de exibição é o
/// que sobra depois do timestamp.
function attachmentFileName(s3Key: string): string {
  const base = s3Key.split("/").pop() ?? s3Key;
  return base.replace(/^\d+-/, "");
}

const CARD_TARGET_SELECT = {
  id: true,
  name: true,
  waId: true,
  email: true,
  status: true,
  lastInteractionAt: true,
} as const;

/// Toda empresa nasce com seu CrmToBusiness (ver company-service.ts#create) —
/// este fallback só cobre empresas criadas antes dessa feature existir.
export async function getOrCreateCrm(organizationId: string) {
  const existing = await prisma.crmToBusiness.findUnique({ where: { organizationId } });
  if (existing) return existing;

  return prisma.$transaction(async (tx) => {
    const crm = await tx.crmToBusiness.create({ data: { organizationId } });
    await tx.stagesCrm.create({
      data: { crmToBusinessId: crm.id, nameStage: "Início", position: 1, isDefault: true },
    });
    return crm;
  });
}

/// Estágios (esteiras) do Kanban da empresa, na ordem da tela — sem os
/// cards. Usado pelo seletor de estágio da função KANBAN_CARD e pelos
/// agentes de IA (GET /internal/targets/:id/crm-stages).
export async function listCrmStages(organizationId: string) {
  const crm = await getOrCreateCrm(organizationId);
  return prisma.stagesCrm.findMany({
    where: { crmToBusinessId: crm.id },
    orderBy: { position: "asc" },
    select: { id: true, nameStage: true, position: true, isDefault: true },
  });
}

interface CreateCardOptions {
  description?: string;
  priority?: CardPriority;
  /// Estágio escolhido na função KANBAN_CARD — ignorado (cai no "Início")
  /// se não for um estágio do CRM desta empresa.
  stageId?: string | null;
}

/// Cria o CardCrm do Target no estágio pedido (ou no "Início", isDefault) da
/// empresa. Idempotente: se o Target já tem card, devolve o existente com
/// `created: false` — e, se veio `description` (agente de IA), atualiza só a
/// descrição dele (nunca mexe em estágio/prioridade que o usuário já moveu).
export async function createCardCrmForTarget(targetId: string, organizationId: string, options: CreateCardOptions = {}) {
  const { description, priority, stageId } = options;
  const crm = await getOrCreateCrm(organizationId);

  const existing = await prisma.cardCrm.findUnique({ where: { targetId } });
  if (existing) {
    if (!description || description === existing.description) return { card: existing, created: false };
    const card = await prisma.cardCrm.update({ where: { id: existing.id }, data: { description } });
    return { card, created: false };
  }

  const escolhido = stageId
    ? await prisma.stagesCrm.findFirst({ where: { id: stageId, crmToBusinessId: crm.id } })
    : null;
  const stage = escolhido ?? (await prisma.stagesCrm.findFirst({ where: { crmToBusinessId: crm.id, isDefault: true } }));
  if (!stage) throw new ValidationError('O CRM da empresa não possui o estágio "Início".');

  const card = await prisma.cardCrm.create({
    data: {
      targetId,
      crmToBusinessId: crm.id,
      stagesCrmId: stage.id,
      description: description || null,
      ...(priority ? { statusPriority: priority } : {}),
    },
  });
  return { card, created: true };
}

/// Comentário do agente de IA (função KANBAN_CARD) no card do Target — sem
/// usuário (userId null), a tela mostra como "Agente de IA". Cria o card se
/// o contato ainda não tiver um (com `priority`/`stageId`, se vierem).
export async function addAgentCommentForTarget(
  targetId: string,
  comment: string,
  options: Pick<CreateCardOptions, "priority" | "stageId"> = {},
) {
  const target = await prisma.target.findUnique({ where: { id: targetId }, select: { id: true, organizationId: true } });
  if (!target) throw new NotFoundError("Contato não encontrado.");

  const { card, created } = await createCardCrmForTarget(target.id, target.organizationId, options);
  const saved = await prisma.cardCrmComment.create({ data: { cardCrmId: card.id, userId: null, comment } });
  return { card, cardCreated: created, comment: saved };
}

export const crmService = {
  async getBoard(user: AuthUser) {
    const crm = await getOrCreateCrm(user.activeOrganizationId!);

    const stages = await prisma.stagesCrm.findMany({
      where: { crmToBusinessId: crm.id },
      orderBy: { position: "asc" },
      include: {
        cards: {
          orderBy: { createdAt: "asc" },
          include: { target: { select: CARD_TARGET_SELECT }, _count: { select: { comments: true } } },
        },
      },
    });

    return { stages };
  },

  /// Se a posição pedida já estiver ocupada, desloca (+1) as posições >= a
  /// ela antes de inserir — mantém a semântica de "inserir nesta posição" em
  /// vez de rejeitar com conflito.
  async createStage(user: AuthUser, input: CreateStageInput) {
    const crm = await getOrCreateCrm(user.activeOrganizationId!);

    return prisma.$transaction(async (tx) => {
      await tx.stagesCrm.updateMany({
        where: { crmToBusinessId: crm.id, position: { gte: input.position } },
        data: { position: { increment: 1 } },
      });

      return tx.stagesCrm.create({
        data: { crmToBusinessId: crm.id, nameStage: input.nameStage, position: input.position },
      });
    });
  },

  async updateStage(user: AuthUser, stageId: string, input: UpdateStageInput) {
    const crm = await getOrCreateCrm(user.activeOrganizationId!);

    const stage = await prisma.stagesCrm.findFirst({ where: { id: stageId, crmToBusinessId: crm.id } });
    if (!stage) throw new NotFoundError("Estágio não encontrado.");

    return prisma.stagesCrm.update({
      where: { id: stage.id },
      data: { nameStage: input.nameStage },
    });
  },

  /// O estágio "Início" (isDefault) nunca pode ser excluído — todo lead novo
  /// depende dele existir (ver createCardCrmForTarget). Cards do
  /// estágio excluído ficam sem estágio (stagesCrmId vira null, onDelete:
  /// SetNull no schema), não são apagados.
  async deleteStage(user: AuthUser, stageId: string) {
    const crm = await getOrCreateCrm(user.activeOrganizationId!);

    const stage = await prisma.stagesCrm.findFirst({ where: { id: stageId, crmToBusinessId: crm.id } });
    if (!stage) throw new NotFoundError("Estágio não encontrado.");
    if (stage.isDefault) throw new ValidationError('O estágio "Início" não pode ser excluído.');

    // Agente excluído (soft delete) não segura o estágio — o FK zera o vínculo.
    const emUso = await prisma.agentFunction.findMany({
      where: { crmStageId: stage.id, agent: { deletedAt: null } },
      select: { agent: { select: { name: true } } },
    });
    if (emUso.length > 0) {
      const agentes = emUso.map((f) => f.agent.name).join(", ");
      throw new ValidationError(
        `Este estágio está selecionado na função "Card no Kanban" do(s) agente(s) ${agentes}. Troque o estágio lá antes de excluir.`,
      );
    }

    await prisma.stagesCrm.delete({ where: { id: stage.id } });
    return stage;
  },

  async findCard(user: AuthUser, cardId: string) {
    const crm = await getOrCreateCrm(user.activeOrganizationId!);
    const card = await prisma.cardCrm.findFirst({ where: { id: cardId, crmToBusinessId: crm.id } });
    if (!card) throw new NotFoundError("Card não encontrado.");
    return card;
  },

  /// Tudo que o Drawer "Detalhes do lead" precisa numa chamada só: o Target
  /// completo, os estágios (pra barra de progresso), os comentários com o
  /// autor e os anexos já com URL presignada de leitura.
  async getCard(user: AuthUser, cardId: string) {
    const crm = await getOrCreateCrm(user.activeOrganizationId!);
    const card = await prisma.cardCrm.findFirst({
      where: { id: cardId, crmToBusinessId: crm.id },
      include: {
        target: true,
        comments: { orderBy: { createdAt: "desc" }, include: { user: { select: { id: true, name: true } } } },
      },
    });
    if (!card) throw new NotFoundError("Card não encontrado.");

    const stages = await prisma.stagesCrm.findMany({
      where: { crmToBusinessId: crm.id },
      orderBy: { position: "asc" },
      select: { id: true, nameStage: true, position: true },
    });

    const attachments = await Promise.all(
      card.attachments.map(async (s3Key) => ({
        s3Key,
        fileName: attachmentFileName(s3Key),
        url: await createDownloadUrl(s3Key),
      })),
    );

    return { ...card, attachments, stages };
  },

  async updatePriority(user: AuthUser, cardId: string, input: UpdatePriorityInput) {
    const card = await this.findCard(user, cardId);
    return prisma.cardCrm.update({
      where: { id: card.id },
      data: { statusPriority: input.statusPriority },
    });
  },

  async presignAttachment(user: AuthUser, cardId: string, input: PresignAttachmentInput) {
    const card = await this.findCard(user, cardId);
    return createCrmAttachmentUploadUrl({
      organizationId: user.activeOrganizationId!,
      cardId: card.id,
      fileName: input.fileName,
      contentType: input.contentType,
    });
  },

  /// Confirma um upload já feito direto no S3 e guarda a chave na lista do
  /// card. A chave precisa ter o prefixo deste card/empresa — impede anexar
  /// arquivo de outro card ou de outra empresa forjando a chave.
  async addAttachment(user: AuthUser, cardId: string, input: AddAttachmentInput) {
    const card = await this.findCard(user, cardId);
    if (!input.s3Key.startsWith(crmAttachmentKeyPrefix(user.activeOrganizationId!, card.id))) {
      throw new ValidationError("Arquivo inválido para este card.");
    }

    return prisma.cardCrm.update({
      where: { id: card.id },
      data: { attachments: { push: input.s3Key } },
    });
  },

  /// Só tira a chave da lista do card — o arquivo continua no S3 de propósito
  /// (pedido do produto: remover do card não é apagar o arquivo).
  async removeAttachment(user: AuthUser, cardId: string, s3Key: string) {
    const card = await this.findCard(user, cardId);
    if (!card.attachments.includes(s3Key)) throw new NotFoundError("Arquivo não encontrado neste card.");

    return prisma.cardCrm.update({
      where: { id: card.id },
      data: { attachments: card.attachments.filter((key) => key !== s3Key) },
    });
  },

  /// Editar/apagar comentário é só do autor — nem Gerente mexe no comentário
  /// de outra pessoa.
  async findOwnComment(user: AuthUser, cardId: string, commentId: string) {
    const card = await this.findCard(user, cardId);
    const comment = await prisma.cardCrmComment.findFirst({ where: { id: commentId, cardCrmId: card.id } });
    if (!comment) throw new NotFoundError("Comentário não encontrado.");
    if (comment.userId !== user.id) throw new ForbiddenError("Só o autor pode alterar este comentário.");
    return comment;
  },

  async updateComment(user: AuthUser, cardId: string, commentId: string, input: CreateCommentInput) {
    const comment = await this.findOwnComment(user, cardId, commentId);
    return prisma.cardCrmComment.update({
      where: { id: comment.id },
      data: { comment: input.comment },
      include: { user: { select: { id: true, name: true } } },
    });
  },

  async deleteComment(user: AuthUser, cardId: string, commentId: string) {
    const comment = await this.findOwnComment(user, cardId, commentId);
    await prisma.cardCrmComment.delete({ where: { id: comment.id } });
    return comment;
  },

  async addComment(user: AuthUser, cardId: string, input: CreateCommentInput) {
    const card = await this.findCard(user, cardId);
    return prisma.cardCrmComment.create({
      data: { cardCrmId: card.id, userId: user.id, comment: input.comment },
      include: { user: { select: { id: true, name: true } } },
    });
  },

  async moveCard(user: AuthUser, cardId: string, input: MoveCardInput) {
    const crm = await getOrCreateCrm(user.activeOrganizationId!);

    const card = await prisma.cardCrm.findFirst({ where: { id: cardId, crmToBusinessId: crm.id } });
    if (!card) throw new NotFoundError("Card não encontrado.");

    const stage = await prisma.stagesCrm.findFirst({ where: { id: input.stagesCrmId, crmToBusinessId: crm.id } });
    if (!stage) throw new NotFoundError("Estágio não encontrado.");

    return prisma.cardCrm.update({
      where: { id: card.id },
      data: { stagesCrmId: stage.id },
      include: { target: { select: CARD_TARGET_SELECT } },
    });
  },
};
