import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(7073),

  DATABASE_URL: z.string().min(1),

  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().min(1),

  /// Origens do frontend com permissão para chamadas com cookies
  /// (credentials: "include") — CORS com wildcard "*" não funciona com
  /// credentials, então isso precisa ser uma lista explícita.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default(
      "https://agentes.sturnusflow.com.br,https://desk.sturnusflow.com.br,http://localhost:7072,http://localhost:7080",
    )
    .transform((value) => value.split(",").map((origin) => origin.trim())),

  INTERNAL_API_KEY: z.string().min(1),

  /// Chave AES-256 (32 bytes em base64) usada pra cifrar/decifrar os tokens
  /// de terceiro por agente (openaiToken/geminiToken — ver token-cipher.ts).
  /// PRECISA ser idêntica no Inbound-Service, que decifra pra repassar ao
  /// AI-Worker — nunca gerar um valor novo sem sincronizar os dois lados.
  AGENT_TOKEN_ENCRYPTION_KEY: z.string().min(1),

  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().min(1),

  RABBITMQ_URL: z.string().min(1),

  MONGO_URL: z.string().min(1),
  MONGO_DB_NAME: z.string().default("orquestrador"),

  SEAWEEDFS_S3_ENDPOINT: z.string().min(1),
  SEAWEEDFS_S3_ACCESS_KEY: z.string().min(1),
  SEAWEEDFS_S3_SECRET_KEY: z.string().min(1),
  SEAWEEDFS_S3_BUCKET: z.string().min(1),
  SEAWEEDFS_S3_REGION: z.string().default("us-east-1"),
  SEAWEEDFS_S3_PREFIX: z.string().default("fluxy-saas/agent-api"),

  APP_TIMEZONE: z.string().default("America/Sao_Paulo"),

  /// Versão da Graph API da Meta usada para consultas (lookup de números,
  /// templates) — o token de acesso agora é por WABA, salvo em
  /// Channel.metaAccessToken.
  META_GRAPH_API_VERSION: z.string().default("v21.0"),

  /// Base URL do Campaign-Worker (POST /campaign/send) — autenticado com o
  /// mesmo INTERNAL_API_KEY acima.
  CAMPAIGN_WORKER_URL: z.string().min(1),

  /// WhatsApp Channel (WABA) do agente "max"/Metrópole — preenchido só depois
  /// que o número da Metrópole for conectado ao agente no Agent Console (ver
  /// campaign-service.ts / internal.routes.ts POST /internal/campaigns/metropole-welcome).
  /// Ausente/vazio = a rota responde 503 em vez de tentar disparar sem canal.
  METROPOLE_WHATSAPP_CHANNEL_ID: z.string().optional(),
  METROPOLE_WELCOME_TEMPLATE_NAME: z.string().default("metropole_boas_vindas"),
  METROPOLE_WELCOME_TEMPLATE_LANGUAGE: z.string().default("pt_BR"),
  METROPOLE_WELCOME_TEMPLATE_CATEGORY: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]).default("MARKETING"),

  /// Conta Gmail usada pra enviar o e-mail de redefinição de senha (Better
  /// Auth emailAndPassword.sendResetPassword) — PASSWORD_GOOGLE é uma senha de
  /// app do Gmail (não a senha normal da conta).
  GMAIL_USER: z.string().min(1),
  PASSWORD_GOOGLE: z.string().min(1),

  /// URL pública do Agent Console — usada nos links dos e-mails de
  /// notificação do suporte técnico (ex: <CONSOLE_URL>/support/<id>).
  /// E-mails que são SEMPRE Administrador da plataforma (time de suporte
  /// técnico) — ver application/authorization/platform-admins.ts. Lista
  /// separada por vírgula; vazio desliga.
  PLATFORM_ADMIN_EMAILS: z
    .string()
    .default("sturnusflow@gmail.com")
    .transform((value) =>
      value
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),

  CONSOLE_URL: z
    .string()
    .default("https://agentes.sturnusflow.com.br")
    .transform((value) => value.replace(/\/+$/, "")),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
