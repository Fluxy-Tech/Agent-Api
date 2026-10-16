import { env } from "../../config/env";
import { UpstreamError } from "../../domain/errors/app-error";

/// Chamadas à Graph API de gestão do WABA: templates de mensagem e WhatsApp
/// Flows. A Meta é a fonte da verdade — nada disso é guardado no banco.

const base = () => `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;

interface MetaError {
  error?: { message?: string; error_user_title?: string; error_user_msg?: string };
}

async function graph<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base()}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & MetaError;
  if (!response.ok) {
    // error_user_msg é a mensagem pensada pro usuário final (ex: motivo de
    // recusa do template); cai pra message técnica se não vier.
    const e = body.error;
    throw new UpstreamError(e?.error_user_msg || e?.error_user_title || e?.message || "Falha na comunicação com a Meta.");
  }
  return body;
}

async function paginate<T>(path: string, token: string, max = 500): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = path;
  while (next && items.length < max) {
    type Page = { data?: T[]; paging?: { next?: string } };
    const page: Page = next.startsWith("http")
      ? ((await (await fetch(next, { headers: { Authorization: `Bearer ${token}` } })).json()) as Page)
      : await graph<Page>(next, token);
    items.push(...(page.data ?? []));
    next = page.paging?.next;
  }
  return items;
}

// ---------- Templates ----------

export interface MetaTemplateDetail {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: Record<string, unknown>[];
  rejected_reason?: string;
  quality_score?: { score?: string };
}

export function listTemplatesDetailed(wabaId: string, token: string) {
  return paginate<MetaTemplateDetail>(
    `${wabaId}/message_templates?fields=id,name,language,status,category,components,rejected_reason,quality_score&limit=100`,
    token,
  );
}

export function createTemplate(wabaId: string, token: string, body: Record<string, unknown>) {
  return graph<{ id: string; status: string; category: string }>(`${wabaId}/message_templates`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const appIdByToken = new Map<string, string>();

/// App da Meta dono do token (o upload de mídia é feito no app, não no WABA).
async function appIdOf(token: string): Promise<string> {
  const cached = appIdByToken.get(token);
  if (cached) return cached;
  const debug = await graph<{ data?: { app_id?: string } }>(`debug_token?input_token=${encodeURIComponent(token)}`, token);
  const appId = debug.data?.app_id;
  if (!appId) throw new UpstreamError("Não foi possível identificar o app da Meta deste token.");
  appIdByToken.set(token, appId);
  return appId;
}

/// Upload retomável da Meta: a mídia de exemplo do cabeçalho do template vira
/// um handle ("4::...") que vai em example.header_handle.
export async function uploadTemplateMedia(token: string, file: { bytes: Uint8Array; fileName: string; contentType: string }) {
  const appId = await appIdOf(token);
  const query = new URLSearchParams({
    file_name: file.fileName,
    file_length: String(file.bytes.byteLength),
    file_type: file.contentType,
  });
  const session = await graph<{ id: string }>(`${appId}/uploads?${query}`, token, { method: "POST" });

  const response = await fetch(`${base()}/${session.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, file_offset: "0", "Content-Type": "application/octet-stream" },
    body: file.bytes,
  });
  const body = (await response.json().catch(() => ({}))) as { h?: string } & MetaError;
  if (!response.ok || !body.h) {
    throw new UpstreamError(body.error?.error_user_msg || body.error?.message || "A Meta não aceitou o arquivo do cabeçalho.");
  }
  return body.h;
}

/// hsm_id + name apaga só aquele idioma; só name apagaria todos os idiomas.
export function deleteTemplate(wabaId: string, token: string, templateId: string, name: string) {
  const query = new URLSearchParams({ hsm_id: templateId, name });
  return graph<{ success: boolean }>(`${wabaId}/message_templates?${query}`, token, { method: "DELETE" });
}

// ---------- Flows ----------

export interface MetaFlowValidationError {
  error: string;
  error_type: string;
  message: string;
  line_start?: number;
  line_end?: number;
  column_start?: number;
  column_end?: number;
}

export interface MetaFlow {
  id: string;
  name: string;
  status: string;
  categories: string[];
  validation_errors: MetaFlowValidationError[];
  updated_at?: string;
  json_version?: string;
  preview?: { preview_url?: string; expires_at?: string };
}

export function listFlows(wabaId: string, token: string) {
  return paginate<MetaFlow>(`${wabaId}/flows?fields=id,name,status,categories,validation_errors,updated_at&limit=100`, token);
}

export function getFlow(flowId: string, token: string) {
  return graph<MetaFlow>(
    `${flowId}?fields=id,name,status,categories,validation_errors,updated_at,json_version,preview.invalidate(false)`,
    token,
  );
}

/// Conteúdo do flow.json atual (asset FLOW_JSON) — a Meta só devolve um link
/// de download temporário.
export async function getFlowJson(flowId: string, token: string): Promise<string | null> {
  const assets = await graph<{ data?: { asset_type?: string; download_url?: string }[] }>(`${flowId}/assets`, token);
  const url = assets.data?.find((a) => a.asset_type === "FLOW_JSON")?.download_url;
  if (!url) return null;
  const response = await fetch(url);
  return response.ok ? response.text() : null;
}

export function createFlow(wabaId: string, token: string, name: string, categories: string[]) {
  return graph<{ id: string }>(`${wabaId}/flows`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, categories }),
  });
}

export function updateFlowMetadata(flowId: string, token: string, name: string, categories: string[]) {
  return graph<{ success: boolean }>(flowId, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, categories }),
  });
}

export function uploadFlowJson(flowId: string, token: string, flowJson: string) {
  const form = new FormData();
  form.append("file", new Blob([flowJson], { type: "application/json" }), "flow.json");
  form.append("name", "flow.json");
  form.append("asset_type", "FLOW_JSON");
  return graph<{ success: boolean; validation_errors?: MetaFlowValidationError[] }>(`${flowId}/assets`, token, {
    method: "POST",
    body: form,
  });
}

export function publishFlow(flowId: string, token: string) {
  return graph<{ success: boolean }>(`${flowId}/publish`, token, { method: "POST" });
}

export function deprecateFlow(flowId: string, token: string) {
  return graph<{ success: boolean }>(`${flowId}/deprecate`, token, { method: "POST" });
}

export function deleteFlow(flowId: string, token: string) {
  return graph<{ success: boolean }>(flowId, token, { method: "DELETE" });
}
