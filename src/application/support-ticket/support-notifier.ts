import { env } from "../../config/env";
import { prisma } from "../../infrastructure/database/prisma/client";
import { sendSupportNotificationEmail } from "../../infrastructure/mail/mailer";
import { PLATFORM_ADMIN_ROLE, PLATFORM_SUPPORT_ROLE } from "../../domain/enums/platform-role";

/// E-mails do suporte técnico. Sempre chamado em segundo plano (depois da
/// resposta HTTP, sem await) e nunca lança: SMTP lento ou fora do ar não
/// pode travar nem derrubar a abertura/mensagem do chamado.
///
/// Anti-spam: cada pessoa recebe UM e-mail por chamado até abri-lo. Se ela já
/// tinha mensagem não lida daquele lado no chamado, a nova não gera outro
/// e-mail (o aviso anterior ainda vale) — numa conversa rápida isso evita um
/// e-mail por mensagem.

const PREVIEW_LIMIT = 400;
const SEVERITY_LABEL = { S1: "S1 · Baixa", S2: "S2 · Alta", S3: "S3 · Crítica" } as const;

/// Time de suporte e empresa têm telas separadas no Console: /support/<id>
/// (quem atende) e /technical-support/<id> (quem abriu).
function ticketUrl(ticketId: string, audience: "supportTeam" | "customer"): string {
  const base = audience === "supportTeam" ? "support" : "technical-support";
  return `${env.CONSOLE_URL}/${base}/${ticketId}`;
}

function preview(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > PREVIEW_LIMIT ? `${trimmed.slice(0, PREVIEW_LIMIT)}…` : trimmed;
}

/// Quem atende tickets desta classificação: Administradores (todas) + time
/// de suporte responsável por ela (sem configuração = todas), não banidos.
async function supportTeam(severity: "S1" | "S2" | "S3") {
  const users = await prisma.user.findMany({
    where: { role: { in: [PLATFORM_ADMIN_ROLE, PLATFORM_SUPPORT_ROLE] }, OR: [{ banned: false }, { banned: null }] },
    select: { id: true, name: true, email: true, role: true, supportAgentSettings: { select: { severities: true } } },
  });
  return users
    .filter(
      (user) =>
        user.role === PLATFORM_ADMIN_ROLE ||
        !user.supportAgentSettings ||
        user.supportAgentSettings.severities.includes(severity),
    )
    .map(({ id, name, email }) => ({ id, name, email }));
}

async function send(to: string, email: Omit<Parameters<typeof sendSupportNotificationEmail>[0], "to">) {
  try {
    await sendSupportNotificationEmail({ to, ...email });
  } catch (error) {
    console.error(`[support-notifier] Falha ao enviar e-mail para ${to}:`, error);
  }
}

/// Chamado novo → avisa todo o time de apoio.
export async function notifyTicketOpened(ticketId: string): Promise<void> {
  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { organization: { select: { name: true } }, openedBy: { select: { name: true } } },
    });
    if (!ticket) return;

    const recipients = (await supportTeam(ticket.severity)).filter((user) => user.id !== ticket.openedById);
    const severity = SEVERITY_LABEL[ticket.severity];

    await Promise.all(
      recipients.map((user) =>
        send(user.email, {
          subject: `[${severity}] Novo chamado #${ticket.code} — ${ticket.organization.name}: ${ticket.title}`,
          heading: "Novo chamado de suporte",
          intro: `${ticket.openedBy.name} (${ticket.organization.name}) abriu um chamado ${severity}.`,
          ticketLabel: `#${ticket.code} · ${ticket.title}`,
          preview: preview(ticket.description),
          url: ticketUrl(ticket.id, "supportTeam"),
        }),
      ),
    );
  } catch (error) {
    console.error(`[support-notifier] Falha ao notificar abertura do chamado ${ticketId}:`, error);
  }
}

/// Mensagem nova → avisa o outro lado:
/// - apoio escreveu → quem abriu o chamado;
/// - empresa escreveu → time de apoio.
export async function notifyMessageCreated(messageId: string): Promise<void> {
  try {
    const message = await prisma.supportTicketMessage.findUnique({
      where: { id: messageId },
      include: {
        author: { select: { id: true, name: true } },
        ticket: {
          include: {
            organization: { select: { name: true } },
            openedBy: { select: { id: true, name: true, email: true } },
          },
        },
        _count: { select: { attachments: true } },
      },
    });
    if (!message) return;
    const { ticket } = message;

    const fromSupport = message.authorType === "SUPPORT";
    const candidates = fromSupport ? [ticket.openedBy] : await supportTeam(ticket.severity);
    const recipients = candidates.filter((user) => user.id !== message.authorId);
    if (recipients.length === 0) return;

    const readStates = await prisma.supportTicketReadState.findMany({
      where: { ticketId: ticket.id, userId: { in: recipients.map((user) => user.id) } },
    });
    const lastReadBy = new Map(readStates.map((state) => [state.userId, state.lastReadAt]));

    const attachmentNote =
      message._count.attachments > 0
        ? `\n\n📎 ${message._count.attachments} anexo${message._count.attachments > 1 ? "s" : ""}`
        : "";
    const text = preview(message.content + attachmentNote);

    await Promise.all(
      recipients.map(async (user) => {
        const lastReadAt = lastReadBy.get(user.id);

        // Apoio que nunca abriu o chamado já recebeu o e-mail de abertura —
        // o aviso dele continua pendente, não precisa de outro.
        if (!lastReadAt && !fromSupport) return;

        const previousUnread = await prisma.supportTicketMessage.count({
          where: {
            ticketId: ticket.id,
            authorType: message.authorType,
            id: { not: message.id },
            ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
          },
        });
        if (previousUnread > 0) return;

        await send(user.email, {
          subject: fromSupport
            ? `O time de apoio respondeu seu chamado #${ticket.code}: ${ticket.title}`
            : `Nova mensagem no chamado #${ticket.code} — ${ticket.organization.name}: ${ticket.title}`,
          heading: fromSupport ? "Resposta do time de apoio" : "Nova mensagem da empresa",
          intro: fromSupport
            ? `${message.author.name}, do time de apoio, respondeu o seu chamado.`
            : `${message.author.name} (${ticket.organization.name}) escreveu no chamado.`,
          ticketLabel: `#${ticket.code} · ${ticket.title}`,
          preview: text,
          url: ticketUrl(ticket.id, fromSupport ? "customer" : "supportTeam"),
        });
      }),
    );
  } catch (error) {
    console.error(`[support-notifier] Falha ao notificar mensagem ${messageId}:`, error);
  }
}
