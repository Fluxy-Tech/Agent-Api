import type { Prisma } from "../../../generated/prisma/client";
import { ConflictError, NotFoundError, UpstreamError, ValidationError } from "../../domain/errors/app-error";
import { prisma } from "../../infrastructure/database/prisma/client";
import { getFlow, getFlowJson } from "../../infrastructure/meta/meta-business-client";
import { listCatalogProducts } from "../../infrastructure/meta/meta-graph-client";
import { createAgentFeatureMediaUploadUrl, createDownloadUrl } from "../../infrastructure/storage/s3-client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import { agentService } from "../agent/agent-service";
import {
  FEATURE_CONFIG_SCHEMAS,
  isPromptRequired,
  SINGLE_INSTANCE_FEATURES,
  type AgentFeatureType,
  type CreateAgentFeatureInput,
  type PresignFeatureMediaInput,
  type UpdateAgentFeatureInput,
} from "./agent-feature-validation";

/// Valida a config do tipo (o schema da rota só garante que é um objeto) e o
/// "quando usar". A mensagem do primeiro problema vira o erro mostrado no Console.
function parseFeature(type: AgentFeatureType, prompt: string, config: Record<string, unknown>) {
  if (isPromptRequired(type) && !prompt) {
    throw new ValidationError("Descreva quando o agente deve usar esta funcionalidade.");
  }
  const parsed = FEATURE_CONFIG_SCHEMAS[type].safeParse(config);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Configuração inválida.", parsed.error.flatten());
  }
  return parsed.data as Prisma.InputJsonValue;
}

/// Flow escolhido: confere na Meta (com o token de uma rede social do agente
/// no mesmo WABA) que existe, está em rascunho ou publicado, e guarda o status
/// e a primeira tela, usados no envio.
async function resolveFlowConfig(agentId: string, organizationId: string, config: Record<string, unknown>) {
  const flowId = String(config.flowId ?? "");
  const channels = await prisma.channel.findMany({
    where: { agentId, organizationId, ...(config.wabaId ? { wabaId: String(config.wabaId) } : {}), metaAccessToken: { not: null } },
    select: { wabaId: true, metaAccessToken: true },
  });
  for (const channel of channels) {
    const flow = await getFlow(flowId, channel.metaAccessToken!).catch(() => null);
    if (!flow) continue;
    if (flow.status !== "DRAFT" && flow.status !== "PUBLISHED") {
      throw new ValidationError("Escolha um flow em rascunho ou publicado.");
    }
    const json = await getFlowJson(flowId, channel.metaAccessToken!).catch(() => null);
    let firstScreen = "";
    try {
      firstScreen = (JSON.parse(json ?? "{}") as { screens?: { id?: string }[] }).screens?.[0]?.id ?? "";
    } catch {
      // JSON inválido: o envio cai na primeira tela que a Meta escolher.
    }
    return { ...config, flowName: flow.name, wabaId: channel.wabaId, status: flow.status, firstScreen };
  }
  throw new ValidationError("Flow não encontrado nas redes sociais deste agente.");
}

type FeatureRow = { type: string; config: Prisma.JsonValue };

/// Cards do carrossel com arquivo no S3 ganham `previewUrl` (assinada, 1h) só
/// pra exibição no Console — não é gravada (o schema descarta no salvar).
async function withPreviews<T extends FeatureRow>(feature: T): Promise<T> {
  const config = feature.config as { cards?: { mediaKey?: string }[] } | null;
  if (feature.type !== "MEDIA_CAROUSEL" || !config?.cards?.length) return feature;
  const cards = await Promise.all(
    config.cards.map(async (card) => (card.mediaKey ? { ...card, previewUrl: await createDownloadUrl(card.mediaKey) } : card)),
  );
  return { ...feature, config: { ...config, cards } };
}

async function findFeature(user: AuthUser, agentId: string, featureId: string) {
  const agent = await agentService.getById(user, agentId);
  const feature = await prisma.agentFeature.findFirst({ where: { id: featureId, agentId: agent.id } });
  if (!feature) throw new NotFoundError("Funcionalidade não encontrada.");
  return feature;
}

export const agentFeatureService = {
  async list(user: AuthUser, agentId: string) {
    const agent = await agentService.getById(user, agentId);
    const features = await prisma.agentFeature.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: "asc" } });
    return Promise.all(features.map(withPreviews));
  },

  async create(user: AuthUser, agentId: string, input: CreateAgentFeatureInput) {
    const agent = await agentService.getById(user, agentId);

    if (SINGLE_INSTANCE_FEATURES.includes(input.type)) {
      const existing = await prisma.agentFeature.findFirst({ where: { agentId: agent.id, type: input.type } });
      if (existing) throw new ConflictError("Este agente já tem essa funcionalidade.");
    }

    const created = await prisma.agentFeature.create({
      data: {
        agentId: agent.id,
        type: input.type,
        name: input.name,
        prompt: input.prompt,
        config: parseFeature(
          input.type,
          input.prompt,
          input.type === "FLOW" ? await resolveFlowConfig(agent.id, agent.organizationId, input.config) : input.config,
        ),
      },
    });
    return withPreviews(created);
  },

  async update(user: AuthUser, agentId: string, featureId: string, input: UpdateAgentFeatureInput) {
    const feature = await findFeature(user, agentId, featureId);
    const updated = await prisma.agentFeature.update({
      where: { id: feature.id },
      data: {
        name: input.name,
        prompt: input.prompt,
        config: parseFeature(
          feature.type as AgentFeatureType,
          input.prompt,
          feature.type === "FLOW" ? await resolveFlowConfig(feature.agentId, user.activeOrganizationId!, input.config) : input.config,
        ),
      },
    });
    return withPreviews(updated);
  },

  async remove(user: AuthUser, agentId: string, featureId: string) {
    const feature = await findFeature(user, agentId, featureId);
    await prisma.agentFeature.delete({ where: { id: feature.id } });
    return { id: feature.id };
  },

  /// Upload direto do navegador pro S3 da mídia de um card do carrossel.
  async presignMedia(user: AuthUser, agentId: string, input: PresignFeatureMediaInput) {
    const agent = await agentService.getById(user, agentId);
    return createAgentFeatureMediaUploadUrl({
      organizationId: user.activeOrganizationId!,
      agentId: agent.id,
      fileName: input.fileName,
      contentType: input.contentType,
    });
  },

  /// Produtos de um catálogo, lidos com o token de uma das redes sociais do
  /// agente (a primeira que conseguir ler) — o catálogo pertence ao WABA.
  async listCatalogProducts(user: AuthUser, agentId: string, catalogId: string) {
    const agent = await agentService.getById(user, agentId);
    const channels = await prisma.channel.findMany({
      where: { agentId: agent.id, organizationId: user.activeOrganizationId!, metaAccessToken: { not: null } },
      select: { metaAccessToken: true },
    });
    if (channels.length === 0) throw new ValidationError("Vincule o agente a uma rede social com token da Meta.");

    let lastError: unknown;
    for (const channel of channels) {
      try {
        return await listCatalogProducts(catalogId, channel.metaAccessToken!);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new UpstreamError("Falha ao consultar os produtos do catálogo.");
  },
};
