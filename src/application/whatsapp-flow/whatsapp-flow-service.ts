import { ValidationError } from "../../domain/errors/app-error";
import { prisma } from "../../infrastructure/database/prisma/client";
import {
  createFlow,
  deleteFlow,
  deprecateFlow,
  getFlow,
  getFlowJson,
  listFlows,
  publishFlow,
  updateFlowMetadata,
  uploadFlowJson,
} from "../../infrastructure/meta/meta-business-client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import { resolveChannelAccess } from "../message-template/message-template-service";
import type { SaveWhatsappFlowInput } from "./whatsapp-flow-validation";

/// O flow precisa ser do WABA deste canal — evita operar flow de outra conta
/// passando só o id.
async function assertFlowOfChannel(user: AuthUser, channelId: string, flowId: string) {
  const access = await resolveChannelAccess(user, channelId);
  const flows = await listFlows(access.wabaId, access.token);
  const flow = flows.find((f) => f.id === flowId);
  if (!flow) throw new ValidationError("Flow não encontrado nesta rede social.");
  return { ...access, flow };
}

/// WhatsApp Flows do WABA da rede social — lidos e gerenciados direto na Meta
/// (sem tabela própria: a Meta é a fonte da verdade).
/// Funcionalidades "Formulário (Flow)" dos agentes guardam o status do flow
/// (rascunho sai em modo draft; descontinuado/excluído deixa de ser enviado).
async function syncAgentFeatures(user: AuthUser, flowId: string, status: string) {
  const features = await prisma.agentFeature.findMany({
    where: { type: "FLOW", config: { path: ["flowId"], equals: flowId }, agent: { organizationId: user.activeOrganizationId! } },
    select: { id: true, config: true },
  });
  for (const feature of features) {
    await prisma.agentFeature.update({
      where: { id: feature.id },
      data: { config: { ...(feature.config as Record<string, unknown>), status } },
    });
  }
}

export const whatsappFlowService = {
  async list(user: AuthUser, channelId: string) {
    const { wabaId, token } = await resolveChannelAccess(user, channelId);
    return listFlows(wabaId, token);
  },

  /// Detalhe com o JSON atual e o link de pré-visualização.
  async get(user: AuthUser, channelId: string, flowId: string) {
    const { token } = await assertFlowOfChannel(user, channelId, flowId);
    const [flow, flowJson] = await Promise.all([getFlow(flowId, token), getFlowJson(flowId, token)]);
    return { ...flow, flowJson };
  },

  /// Cria como rascunho e sobe o JSON. Erros de validação do JSON voltam na
  /// resposta (o flow fica salvo como rascunho pra ser corrigido).
  async create(user: AuthUser, channelId: string, input: SaveWhatsappFlowInput) {
    const { wabaId, token } = await resolveChannelAccess(user, channelId);
    const { id } = await createFlow(wabaId, token, input.name, input.categories);
    const upload = input.flowJson ? await uploadFlowJson(id, token, input.flowJson) : null;
    return { id, validationErrors: upload?.validation_errors ?? [] };
  },

  async update(user: AuthUser, channelId: string, flowId: string, input: SaveWhatsappFlowInput) {
    const { token, flow } = await assertFlowOfChannel(user, channelId, flowId);
    if (flow.status !== "DRAFT") throw new ValidationError("Só é possível editar flows em rascunho.");
    await updateFlowMetadata(flowId, token, input.name, input.categories);
    const upload = input.flowJson ? await uploadFlowJson(flowId, token, input.flowJson) : null;
    return { id: flowId, validationErrors: upload?.validation_errors ?? [] };
  },

  async publish(user: AuthUser, channelId: string, flowId: string) {
    const { token } = await assertFlowOfChannel(user, channelId, flowId);
    const result = await publishFlow(flowId, token);
    await syncAgentFeatures(user, flowId, "PUBLISHED");
    return result;
  },

  async deprecate(user: AuthUser, channelId: string, flowId: string) {
    const { token } = await assertFlowOfChannel(user, channelId, flowId);
    const result = await deprecateFlow(flowId, token);
    await syncAgentFeatures(user, flowId, "DEPRECATED");
    return result;
  },

  async remove(user: AuthUser, channelId: string, flowId: string) {
    const { token, flow } = await assertFlowOfChannel(user, channelId, flowId);
    if (flow.status !== "DRAFT") {
      throw new ValidationError("Só é possível excluir flows em rascunho. Flows publicados podem ser descontinuados.");
    }
    const result = await deleteFlow(flowId, token);
    await syncAgentFeatures(user, flowId, "DELETED");
    return result;
  },
};
