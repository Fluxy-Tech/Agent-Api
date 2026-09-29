import { Router } from "express";
import { agentService } from "../../../application/agent/agent-service";
import { createAgentSchema, listAgentsQuerySchema, updateAgentSchema } from "../../../application/agent/agent-validation";
import { agentFunctionService } from "../../../application/agent-function/agent-function-service";
import {
  agentFunctionTypeSchema,
  updateAgentFunctionSchema,
} from "../../../application/agent-function/agent-function-validation";
import { agentMetadataFieldService } from "../../../application/agent-metadata-field/agent-metadata-field-service";
import { upsertAgentMetadataFieldSchema } from "../../../application/agent-metadata-field/agent-metadata-field-validation";
import { ragDocumentService } from "../../../application/rag-document/rag-document-service";
import {
  createRagDocumentSchema,
  presignRagDocumentSchema,
} from "../../../application/rag-document/rag-document-validation";
import { PermissionAction } from "../../../domain/enums/permission-action";
import { ValidationError } from "../../../domain/errors/app-error";
import { previewToken } from "../../../infrastructure/crypto/token-cipher";
import { apiHandler } from "../middlewares/api-handler";
import { recordAudit } from "../middlewares/audit";

export const agentsRouter = Router();

/// Nunca deixa os tokens de terceiro (OpenAI/Gemini) saírem em claro pela API
/// (resposta HTTP ou AuditLog) — a UI só precisa dos 6 primeiros chars pra
/// confirmar visualmente qual token está configurado.
function sanitizeAgent<T extends { openaiTokenEncrypted?: string | null; geminiTokenEncrypted?: string | null }>(
  agent: T,
): Omit<T, "openaiTokenEncrypted" | "geminiTokenEncrypted"> & {
  openaiTokenPreview: string | null;
  geminiTokenPreview: string | null;
} {
  const { openaiTokenEncrypted, geminiTokenEncrypted, ...rest } = agent;
  return {
    ...rest,
    openaiTokenPreview: previewToken(openaiTokenEncrypted ?? null),
    geminiTokenPreview: previewToken(geminiTokenEncrypted ?? null),
  };
}

agentsRouter.get(
  "/",
  apiHandler({ action: PermissionAction.AGENTS_VIEW }, async (req, _res, user) => {
    const parsed = listAgentsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Filtros inválidos.", parsed.error.flatten());

    const agents = await agentService.list(user, parsed.data);
    return agents.map(sanitizeAgent);
  }),
);

agentsRouter.get(
  "/:id",
  apiHandler({ action: PermissionAction.AGENTS_VIEW }, async (req, _res, user) => {
    const agent = await agentService.getById(user, String(req.params.id));
    return sanitizeAgent(agent);
  }),
);

agentsRouter.post(
  "/",
  apiHandler({ action: PermissionAction.AGENTS_WRITE }, async (req, _res, user) => {
    const parsed = createAgentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const agent = await agentService.create(user, parsed.data);
    const safeAgent = sanitizeAgent(agent);
    await recordAudit(req, user, {
      action: "AGENT_CREATED",
      resourceType: "Agent",
      resourceId: agent.id,
      afterState: safeAgent,
    });

    return safeAgent;
  }),
);

agentsRouter.put(
  "/:id",
  apiHandler({ action: PermissionAction.AGENTS_WRITE }, async (req, _res, user) => {
    const parsed = updateAgentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const id = String(req.params.id);
    const before = await agentService.getById(user, id);
    const agent = await agentService.update(user, id, parsed.data);
    const safeAgent = sanitizeAgent(agent);

    await recordAudit(req, user, {
      action: "AGENT_UPDATED",
      resourceType: "Agent",
      resourceId: agent.id,
      beforeState: sanitizeAgent(before),
      afterState: safeAgent,
    });

    return safeAgent;
  }),
);

agentsRouter.delete(
  "/:id",
  apiHandler({ action: PermissionAction.AGENTS_WRITE }, async (req, _res, user) => {
    const id = String(req.params.id);
    const before = await agentService.getById(user, id);
    const agent = await agentService.delete(user, id);

    await recordAudit(req, user, {
      action: "AGENT_DELETED",
      resourceType: "Agent",
      resourceId: agent.id,
      beforeState: sanitizeAgent(before),
      afterState: sanitizeAgent(agent),
    });

    return sanitizeAgent(agent);
  }),
);

agentsRouter.post(
  "/:id/rag/presign",
  apiHandler({ action: PermissionAction.AGENTS_WRITE }, async (req, _res, user) => {
    const parsed = presignRagDocumentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    return ragDocumentService.presign(user, String(req.params.id), parsed.data);
  }),
);

agentsRouter.get(
  "/:id/rag/documents",
  apiHandler({ action: PermissionAction.AGENTS_VIEW }, async (req, _res, user) => {
    return ragDocumentService.list(user, String(req.params.id));
  }),
);

agentsRouter.post(
  "/:id/rag/documents",
  apiHandler({ action: PermissionAction.AGENTS_WRITE }, async (req, _res, user) => {
    const parsed = createRagDocumentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const agentId = String(req.params.id);
    const document = await ragDocumentService.create(user, agentId, parsed.data);

    await recordAudit(req, user, {
      action: "RAG_DOCUMENT_CREATED",
      resourceType: "RagDocument",
      resourceId: document.id,
      afterState: document,
    });

    return document;
  }),
);

agentsRouter.delete(
  "/:id/rag/documents/:documentId",
  apiHandler({ action: PermissionAction.AGENTS_WRITE }, async (req, _res, user) => {
    await ragDocumentService.delete(user, String(req.params.id), String(req.params.documentId));
    return { deleted: true };
  }),
);

agentsRouter.get(
  "/:id/metadata-fields",
  apiHandler({ action: PermissionAction.AGENTS_VIEW }, async (req, _res, user) => {
    return agentMetadataFieldService.list(user, String(req.params.id));
  }),
);

agentsRouter.post(
  "/:id/metadata-fields",
  apiHandler({ action: PermissionAction.AGENTS_WRITE }, async (req, _res, user) => {
    const parsed = upsertAgentMetadataFieldSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const field = await agentMetadataFieldService.create(user, String(req.params.id), parsed.data);

    await recordAudit(req, user, {
      action: "AGENT_METADATA_FIELD_CREATED",
      resourceType: "AgentMetadataField",
      resourceId: field.id,
      afterState: field,
    });

    return field;
  }),
);

agentsRouter.put(
  "/:id/metadata-fields/:fieldId",
  apiHandler({ action: PermissionAction.AGENTS_WRITE }, async (req, _res, user) => {
    const parsed = upsertAgentMetadataFieldSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const agentId = String(req.params.id);
    const fieldId = String(req.params.fieldId);
    const before = await agentMetadataFieldService.getById(user, agentId, fieldId);
    const field = await agentMetadataFieldService.update(user, agentId, fieldId, parsed.data);

    await recordAudit(req, user, {
      action: "AGENT_METADATA_FIELD_UPDATED",
      resourceType: "AgentMetadataField",
      resourceId: field.id,
      beforeState: before,
      afterState: field,
    });

    return field;
  }),
);

agentsRouter.delete(
  "/:id/metadata-fields/:fieldId",
  apiHandler({ action: PermissionAction.AGENTS_WRITE }, async (req, _res, user) => {
    const field = await agentMetadataFieldService.remove(user, String(req.params.id), String(req.params.fieldId));

    await recordAudit(req, user, {
      action: "AGENT_METADATA_FIELD_DELETED",
      resourceType: "AgentMetadataField",
      resourceId: field.id,
      beforeState: field,
    });

    return { deleted: true };
  }),
);

agentsRouter.get(
  "/:id/functions",
  apiHandler({ action: PermissionAction.AGENTS_VIEW }, async (req, _res, user) => {
    return agentFunctionService.list(user, String(req.params.id));
  }),
);

agentsRouter.put(
  "/:id/functions/:type",
  apiHandler({ action: PermissionAction.AGENTS_WRITE }, async (req, _res, user) => {
    const type = agentFunctionTypeSchema.safeParse(req.params.type);
    if (!type.success) throw new ValidationError("Função inválida.");
    const parsed = updateAgentFunctionSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Dados inválidos.", parsed.error.flatten());

    const agentId = String(req.params.id);
    const saved = await agentFunctionService.update(user, agentId, type.data, parsed.data);

    await recordAudit(req, user, {
      action: "AGENT_FUNCTION_UPDATED",
      resourceType: "AgentFunction",
      resourceId: agentId,
      afterState: saved,
    });

    return saved;
  }),
);
