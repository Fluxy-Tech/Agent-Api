import { Prisma } from "../../../generated/prisma/client";
import { NotFoundError } from "../../domain/errors/app-error";
import { prisma } from "../../infrastructure/database/prisma/client";
import type { AuthUser } from "../../presentation/http/types/auth-user";
import { buildBucketKeys, resolveSeriesWindow } from "../whatsapp-channel/whatsapp-channel-service";
import type { SeriesPeriod } from "../whatsapp-channel/whatsapp-channel-validation";
import type { RecordTokensInput } from "./agent-token-validation";

type Origin = "OPENAI" | "ADK";
type OriginTotals = Record<Origin, number>;

function emptyTotals(): OriginTotals {
  return { OPENAI: 0, ADK: 0 };
}

/// Agregado no Postgres (não linha a linha) — é uma linha de Token por
/// chamada de LLM, o volume cresce rápido. Buckets em UTC, igual aos
/// gráficos de canal (resolveSeriesWindow/buildBucketKeys).
async function aggregate(organizationId: string, period: SeriesPeriod, agentId?: string) {
  const { start, end, granularity } = resolveSeriesWindow(period);
  const format = granularity === "day" ? "YYYY-MM-DD" : "YYYY-MM";

  const rows = await prisma.$queryRaw<{ date: string; agentId: string; origin: Origin; total: bigint }[]>`
    SELECT to_char(t."createdAt", ${format}) AS date, t."agentId", t."origin"::text AS origin,
           SUM(t."quantity")::bigint AS total
    FROM "Token" t
    JOIN "Agent" a ON a."id" = t."agentId"
    WHERE a."organizationId" = ${organizationId}
      AND t."createdAt" >= ${start} AND t."createdAt" < ${end}
      ${agentId ? Prisma.sql`AND t."agentId" = ${agentId}` : Prisma.empty}
    GROUP BY 1, 2, 3
  `;

  const byOrigin = emptyTotals();
  const byDate = new Map<string, OriginTotals>();
  const byAgent = new Map<string, OriginTotals>();

  for (const row of rows) {
    const total = Number(row.total);
    byOrigin[row.origin] += total;

    const date = byDate.get(row.date) ?? emptyTotals();
    date[row.origin] += total;
    byDate.set(row.date, date);

    const agent = byAgent.get(row.agentId) ?? emptyTotals();
    agent[row.origin] += total;
    byAgent.set(row.agentId, agent);
  }

  return {
    period,
    granularity,
    total: byOrigin.OPENAI + byOrigin.ADK,
    byOrigin,
    byAgent,
    points: buildBucketKeys(start, end, granularity).map((date) => ({ date, ...(byDate.get(date) ?? emptyTotals()) })),
  };
}

export const agentTokenService = {
  /// Chamada pelo AI-Worker (rota interna) — uma linha por chamada de LLM.
  async record(agentId: string, input: RecordTokensInput) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
    if (!agent) throw new NotFoundError("Agente não encontrado.");

    return prisma.token.create({ data: { agentId: agent.id, quantity: input.quantity, origin: input.origin } });
  },

  /// Consumo da empresa inteira no período, com o detalhamento por agente.
  /// Agentes excluídos (soft delete) só aparecem se consumiram algo no
  /// período — o gasto deles continua contando no total da empresa.
  async organizationUsage(user: AuthUser, period: SeriesPeriod) {
    const organizationId = user.activeOrganizationId!;
    const { byAgent, ...usage } = await aggregate(organizationId, period);

    const agents = await prisma.agent.findMany({
      where: { organizationId, OR: [{ deletedAt: null }, { id: { in: [...byAgent.keys()] } }] },
      select: { id: true, name: true, deletedAt: true },
      orderBy: { createdAt: "desc" },
    });

    return {
      ...usage,
      agents: agents
        .map((agent) => {
          const totals = byAgent.get(agent.id) ?? emptyTotals();
          return {
            agentId: agent.id,
            name: agent.name,
            deleted: agent.deletedAt !== null,
            total: totals.OPENAI + totals.ADK,
            ...totals,
          };
        })
        .sort((a, b) => b.total - a.total),
    };
  },

  async agentUsage(user: AuthUser, agentId: string, period: SeriesPeriod) {
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, organizationId: user.activeOrganizationId! },
      select: { id: true },
    });
    if (!agent) throw new NotFoundError("Agente não encontrado.");

    const { byAgent: _byAgent, ...usage } = await aggregate(user.activeOrganizationId!, period, agent.id);
    return usage;
  },
};
