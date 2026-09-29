import { Prisma } from "../../../generated/prisma/client";
import { agentService } from "../agent/agent-service";
import { ConflictError, NotFoundError, ValidationError } from "../../domain/errors/app-error";
import { toMetadataKey } from "../../domain/utils/metadata-key";
import { prisma } from "../../infrastructure/database/prisma/client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import type { UpsertAgentMetadataFieldInput } from "./agent-metadata-field-validation";

/// nameToAgent é sempre derivado aqui (nunca aceito do front) — é a chave
/// gravada em Target.metadata pelo AI-Worker, então precisa ser previsível.
function buildData(input: UpsertAgentMetadataFieldInput) {
  const nameToAgent = toMetadataKey(input.name);
  if (!nameToAgent) throw new ValidationError("O nome precisa ter ao menos uma letra ou número.");
  return { name: input.name, nameToAgent, rule: input.rule, active: input.active };
}

function rethrowDuplicate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new ConflictError("Já existe um metadado com esse nome neste agente.");
  }
  throw error;
}

export const agentMetadataFieldService = {
  async list(user: AuthUser, agentId: string) {
    await agentService.getById(user, agentId);
    return prisma.agentMetadataField.findMany({ where: { agentId }, orderBy: { createdAt: "asc" } });
  },

  async getById(user: AuthUser, agentId: string, fieldId: string) {
    await agentService.getById(user, agentId);
    const field = await prisma.agentMetadataField.findFirst({ where: { id: fieldId, agentId } });
    if (!field) throw new NotFoundError("Metadado não encontrado.");
    return field;
  },

  async create(user: AuthUser, agentId: string, input: UpsertAgentMetadataFieldInput) {
    const agent = await agentService.getById(user, agentId);
    try {
      return await prisma.agentMetadataField.create({ data: { agentId: agent.id, ...buildData(input) } });
    } catch (error) {
      rethrowDuplicate(error);
    }
  },

  async update(user: AuthUser, agentId: string, fieldId: string, input: UpsertAgentMetadataFieldInput) {
    const existing = await this.getById(user, agentId, fieldId);
    try {
      return await prisma.agentMetadataField.update({ where: { id: existing.id }, data: buildData(input) });
    } catch (error) {
      rethrowDuplicate(error);
    }
  },

  async remove(user: AuthUser, agentId: string, fieldId: string) {
    const existing = await this.getById(user, agentId, fieldId);
    await prisma.agentMetadataField.delete({ where: { id: existing.id } });
    return existing;
  },
};
