import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import express from "express";
import { ensurePlatformAdmins } from "./application/authorization/platform-admins";
import { ensureSupportOrganization } from "./application/company/support-organization";
import { env } from "./config/env";
import { auth } from "./infrastructure/auth/better-auth";
import { redis } from "./infrastructure/cache/redis/client";
import { pingMongo } from "./infrastructure/database/mongo/client";
import { prisma } from "./infrastructure/database/prisma/client";
import { getRabbitChannel } from "./infrastructure/queue/rabbitmq/connection";
import { agentsRouter } from "./presentation/http/routes/agents.routes";
import { campaignsRouter } from "./presentation/http/routes/campaigns.routes";
import { companiesRouter } from "./presentation/http/routes/companies.routes";
import { crmRouter } from "./presentation/http/routes/crm.routes";
import { internalRouter } from "./presentation/http/routes/internal.routes";
import { meRouter } from "./presentation/http/routes/me.routes";
import { reportsRouter } from "./presentation/http/routes/reports.routes";
import { supportRouter } from "./presentation/http/routes/support.routes";
import { serviceIslandsRouter } from "./presentation/http/routes/service-islands.routes";
import { sessionRouter } from "./presentation/http/routes/session.routes";
import { targetsRouter } from "./presentation/http/routes/targets.routes";
import { ticketsRouter } from "./presentation/http/routes/tickets.routes";
import { whatsappChannelsRouter } from "./presentation/http/routes/whatsapp-channels.routes";

async function main() {
  await prisma.$connect();
  await ensurePlatformAdmins();
  await ensureSupportOrganization();
  await getRabbitChannel();

  const app = express();
  app.use(
    cors({
      origin: env.CORS_ALLOWED_ORIGINS,
      credentials: true,
    }),
  );

  // Better Auth precisa do corpo cru da requisição — tem que vir ANTES do
  // express.json(), senão o handler interno do Better Auth recebe um stream já
  // consumido.
  app.all(/^\/api\/auth\/.*/, toNodeHandler(auth));

  app.use(express.json());

  app.use("/api/companies", companiesRouter);
  app.use("/api/session", sessionRouter);
  app.use("/api/me", meRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/channels", whatsappChannelsRouter);
  app.use("/api/service-islands", serviceIslandsRouter);
  app.use("/api/targets", targetsRouter);
  app.use("/api/tickets", ticketsRouter);
  app.use("/api/campaigns", campaignsRouter);
  app.use("/api/crm", crmRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/support", supportRouter);
  app.use("/internal", internalRouter);

  app.get("/health", async (_req, res) => {
    const [dbOk, redisOk, mongoOk] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      redis.ping().then(() => true).catch(() => false),
      pingMongo(),
    ]);

    res.json({ status: "ok", service: "agent-api", db: dbOk, redis: redisOk, mongo: mongoOk });
  });

  app.listen(env.PORT, () => {
    console.log(`Agent-Api listening on port ${env.PORT}`);
  });
}

main().catch((error) => {
  console.error("Fatal error during Agent-Api bootstrap:", error);
  process.exit(1);
});
