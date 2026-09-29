const COMBINING_DIACRITICS = /[̀-ͯ]/g;

/// Chave usada em Target.metadata a partir do nome digitado no Agent Console
/// ("Cidade de Interesse" -> "cidade_de_interesse"): minúsculas, sem acento,
/// qualquer coisa fora de [a-z0-9] vira _, sem _ repetido nem nas pontas.
export function toMetadataKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/(^_|_$)/g, "");
}
