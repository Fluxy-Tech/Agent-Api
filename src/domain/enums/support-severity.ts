/// Espelho do enum SupportSeverity do schema — usado onde não dá pra
/// depender do client gerado (ex: AuthUser).
export const SUPPORT_SEVERITIES = ["S1", "S2", "S3"] as const;
export type SupportSeverityValue = (typeof SUPPORT_SEVERITIES)[number];
