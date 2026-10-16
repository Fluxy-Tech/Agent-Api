import { env } from "../../config/env";
import { UpstreamError } from "../../domain/errors/app-error";

export interface MetaPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
}

interface MetaPhoneNumbersResponse {
  data: MetaPhoneNumber[];
}

interface MetaErrorResponse {
  error?: { message?: string };
}

/// Consulta a Graph API pra listar todos os números de telefone cadastrados
/// em um WhatsApp Business Account — usado no cadastro em massa de canais a
/// partir de um WABA ID já existente na Meta.
export async function listWabaPhoneNumbers(wabaId: string, accessToken: string): Promise<MetaPhoneNumber[]> {
  const url = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${wabaId}/phone_numbers`;

  const response = await fetch(`${url}?access_token=${encodeURIComponent(accessToken)}`);
  const body = (await response.json()) as MetaPhoneNumbersResponse & MetaErrorResponse;

  if (!response.ok) {
    throw new UpstreamError(body.error?.message ?? "Falha ao consultar os números do WABA na Meta.");
  }

  return body.data ?? [];
}

export interface MetaCatalog {
  id: string;
  name: string;
}

/// Catálogos (Commerce Manager) conectados ao WABA — exige que o token tenha
/// a permissão catalog_management, além das de WhatsApp.
export async function listWabaCatalogs(wabaId: string, accessToken: string): Promise<MetaCatalog[]> {
  const url = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${wabaId}/product_catalogs?fields=id,name`;

  const response = await fetch(`${url}&access_token=${encodeURIComponent(accessToken)}`);
  const body = (await response.json()) as { data?: MetaCatalog[] } & MetaErrorResponse;

  if (!response.ok) {
    throw new UpstreamError(body.error?.message ?? "Falha ao consultar os catálogos do WABA na Meta.");
  }

  return body.data ?? [];
}

export interface MetaCatalogProduct {
  retailerId: string;
  name: string;
  price: string | null;
  imageUrl: string | null;
  availability: string | null;
}

/// Produtos de um catálogo (até `limit`) — usado pra escolher os produtos do
/// carrossel no Console.
export async function listCatalogProducts(catalogId: string, accessToken: string, limit = 200): Promise<MetaCatalogProduct[]> {
  const products: MetaCatalogProduct[] = [];
  let url: string | undefined =
    `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${catalogId}/products?fields=retailer_id,name,price,image_url,availability&limit=100`;

  while (url && products.length < limit) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = (await response.json()) as {
      data?: { retailer_id?: string; name?: string; price?: string; image_url?: string; availability?: string }[];
      paging?: { next?: string };
    } & MetaErrorResponse;
    if (!response.ok) throw new UpstreamError(body.error?.message ?? "Falha ao consultar os produtos do catálogo na Meta.");

    for (const item of body.data ?? []) {
      if (!item.retailer_id) continue;
      products.push({
        retailerId: item.retailer_id,
        name: item.name ?? item.retailer_id,
        price: item.price ?? null,
        imageUrl: item.image_url ?? null,
        availability: item.availability ?? null,
      });
    }
    url = body.paging?.next;
  }

  return products.slice(0, limit);
}

export interface MetaPhoneNumberStatus {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  /// Estado de conexão do número na Meta (ex: CONNECTED, PENDING, FLAGGED,
  /// RESTRICTED, RATE_LIMITED, BANNED) — nem toda versão da Graph API retorna
  /// esse campo pra todo número, por isso é opcional.
  status?: string;
  /// GREEN | YELLOW | RED | UNKNOWN — qualidade do número, afeta o quanto ele
  /// pode enviar sem ser limitado pela Meta.
  quality_rating?: string;
  name_status?: string;
  code_verification_status?: string;
  messaging_limit_tier?: string;
  throughput?: { level?: string };
}

/// Consulta o status/qualidade de um número específico na Graph API — campos
/// não suportados pela versão da API ou não aplicáveis ao número simplesmente
/// não vêm na resposta (a Meta não retorna erro por isso).
export async function getPhoneNumberStatus(phoneNumberId: string, accessToken: string): Promise<MetaPhoneNumberStatus> {
  const fields =
    "id,display_phone_number,verified_name,status,quality_rating,name_status,code_verification_status,messaging_limit_tier,throughput";
  const url = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${phoneNumberId}?fields=${fields}`;

  const response = await fetch(`${url}&access_token=${encodeURIComponent(accessToken)}`);
  const body = (await response.json()) as MetaPhoneNumberStatus & MetaErrorResponse;

  if (!response.ok) {
    throw new UpstreamError(body.error?.message ?? "Falha ao consultar o status do número na Meta.");
  }

  return body;
}

export interface MetaTemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: string;
  text?: string;
  buttons?: { type: string; text: string }[];
}

export interface MetaTemplate {
  id: string;
  name: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language: string;
  status: string;
  components: MetaTemplateComponent[];
}

interface MetaTemplatesResponse {
  data: MetaTemplate[];
}

/// Conta quantas variáveis {{1}}, {{2}}... existem em um texto de componente —
/// usado pra saber quantos campos de preenchimento mostrar por contato no
/// disparo de campanha (CSV ou manual).
function countVariables(text?: string): number {
  if (!text) return 0;
  const matches = text.match(/\{\{\d+\}\}/g);
  return matches ? new Set(matches).size : 0;
}

export function getTemplateVariableCount(components: MetaTemplateComponent[]): { header: number; body: number } {
  const header = components.find((c) => c.type === "HEADER");
  const body = components.find((c) => c.type === "BODY");
  return {
    header: countVariables(header?.text),
    body: countVariables(body?.text),
  };
}

/// Lista os templates de mensagem cadastrados no WABA (aprovados ou não) —
/// usado na etapa de escolha de template do disparo de campanha.
export async function listWabaTemplates(wabaId: string, accessToken: string): Promise<MetaTemplate[]> {
  const url = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${wabaId}/message_templates`;

  const response = await fetch(`${url}?access_token=${encodeURIComponent(accessToken)}`);
  const body = (await response.json()) as MetaTemplatesResponse & MetaErrorResponse;

  if (!response.ok) {
    throw new UpstreamError(body.error?.message ?? "Falha ao consultar os templates do WABA na Meta.");
  }

  return body.data ?? [];
}
