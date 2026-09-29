import type { AgentFunctionType } from "../../../generated/prisma/client";
import { ValidationError } from "../../domain/errors/app-error";
import { agentService } from "../agent/agent-service";
import { getOrCreateCrm, listCrmStages } from "../crm/crm-service";
import { prisma } from "../../infrastructure/database/prisma/client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import type { UpdateAgentFunctionInput, UpdateAgentFunctionSettingsInput } from "./agent-function-validation";

/// Ordem em que as funções aparecem na tela. Strings (e não o enum do
/// Prisma): o client gerado não exporta enums em runtime por esse caminho.
const FUNCTION_TYPES: AgentFunctionType[] = ["CALENDAR_EVENT", "KANBAN_CARD"];

function toResponse(row: { type: AgentFunctionType; runAtStart: boolean; runAfterMetadata: boolean; crmStageId: string | null }) {
  return { type: row.type, runAtStart: row.runAtStart, runAfterMetadata: row.runAfterMetadata, crmStageId: row.crmStageId };
}

export const agentFunctionService = {
  /// Sempre devolve todas as funções fixas — as que ainda não têm linha no
  /// banco voltam com os dois momentos desligados.
  async list(user: AuthUser, agentId: string) {
    await agentService.getById(user, agentId);
    const saved = await prisma.agentFunction.findMany({ where: { agentId } });

    return FUNCTION_TYPES.map((type) => {
      const row = saved.find((f) => f.type === type);
      return toResponse(row ?? { type, runAtStart: false, runAfterMetadata: false, crmStageId: null });
    });
  },

  async update(user: AuthUser, agentId: string, type: AgentFunctionType, input: UpdateAgentFunctionInput) {
    const agent = await agentService.getById(user, agentId);

    const { crmStageId, ...moments } = input;
    const data: { runAtStart: boolean; runAfterMetadata: boolean; crmStageId?: string | null } = { ...moments };
    if (crmStageId !== undefined) {
      if (type !== "KANBAN_CARD") throw new ValidationError("Só a função Card no Kanban tem estágio.");
      if (crmStageId) {
        const crm = await getOrCreateCrm(agent.organizationId);
        const stage = await prisma.stagesCrm.findFirst({ where: { id: crmStageId, crmToBusinessId: crm.id } });
        if (!stage) throw new ValidationError("Estágio do Kanban não encontrado.");
      }
      data.crmStageId = crmStageId;
    }

    const saved = await prisma.agentFunction.upsert({
      where: { agentId_type: { agentId: agent.id, type } },
      create: { agentId: agent.id, type, ...data },
      update: data,
    });
    return toResponse(saved);
  },

  /// Estágios do Kanban da empresa do agente — opções do seletor de estágio
  /// da função KANBAN_CARD.
  async listCrmStages(user: AuthUser, agentId: string) {
    const agent = await agentService.getById(user, agentId);
    return listCrmStages(agent.organizationId);
  },

  /// Configurações gerais do card "Funções" — ficam no próprio Agent, mas têm
  /// endpoint separado do PUT /agents/:id pra salvar na hora sem mexer no
  /// formulário do agente.
  async getSettings(user: AuthUser, agentId: string) {
    const agent = await agentService.getById(user, agentId);
    return { handoffAfterFunctions: agent.handoffAfterFunctions };
  },

  async updateSettings(user: AuthUser, agentId: string, input: UpdateAgentFunctionSettingsInput) {
    const agent = await agentService.getById(user, agentId);
    const saved = await prisma.agent.update({
      where: { id: agent.id },
      data: { handoffAfterFunctions: input.handoffAfterFunctions },
    });
    return { handoffAfterFunctions: saved.handoffAfterFunctions };
  },
};
