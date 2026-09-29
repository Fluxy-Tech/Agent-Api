import type { AgentFunctionType } from "../../../generated/prisma/client";
import { agentService } from "../agent/agent-service";
import { prisma } from "../../infrastructure/database/prisma/client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import type { UpdateAgentFunctionInput } from "./agent-function-validation";

/// Ordem em que as funções aparecem na tela. Strings (e não o enum do
/// Prisma): o client gerado não exporta enums em runtime por esse caminho.
const FUNCTION_TYPES: AgentFunctionType[] = ["CALENDAR_EVENT", "KANBAN_CARD"];

export const agentFunctionService = {
  /// Sempre devolve todas as funções fixas — as que ainda não têm linha no
  /// banco voltam com os dois momentos desligados.
  async list(user: AuthUser, agentId: string) {
    await agentService.getById(user, agentId);
    const saved = await prisma.agentFunction.findMany({ where: { agentId } });

    return FUNCTION_TYPES.map((type) => {
      const row = saved.find((f) => f.type === type);
      return { type, runAtStart: row?.runAtStart ?? false, runAfterMetadata: row?.runAfterMetadata ?? false };
    });
  },

  async update(user: AuthUser, agentId: string, type: AgentFunctionType, input: UpdateAgentFunctionInput) {
    const agent = await agentService.getById(user, agentId);
    const saved = await prisma.agentFunction.upsert({
      where: { agentId_type: { agentId: agent.id, type } },
      create: { agentId: agent.id, type, ...input },
      update: input,
    });
    return { type: saved.type, runAtStart: saved.runAtStart, runAfterMetadata: saved.runAfterMetadata };
  },
};
