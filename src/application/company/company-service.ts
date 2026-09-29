import { randomBytes, randomInt, randomUUID } from "crypto";
import { Prisma } from "../../../generated/prisma/client";
import { isConfigurablePermission } from "../authorization/permission-matrix";
import { isMemberRole } from "../../domain/enums/member-role";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../domain/errors/app-error";
import { slugify } from "../../domain/utils/slug";
import { prisma } from "../../infrastructure/database/prisma/client";
import type { AuthUser } from "../../presentation/http/types/auth-user";

/// Sem 0/O/1/I/L — código digitado à mão, não pode ter caracteres ambíguos.
const INVITE_CODE_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateInviteCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += INVITE_CODE_CHARSET[randomInt(INVITE_CODE_CHARSET.length)];
  }
  return code;
}

export const companyService = {
  /// Sempre cria Organization + Member(GERENTE) diretamente — nunca pela API de
  /// criação de organização do Better Auth, pra garantir que o Member nasça com
  /// um valor válido do nosso union type de papéis, não o default do plugin.
  /// Toda empresa já nasce com seu CRM (CrmToBusiness) e o estágio "Início"
  /// (isDefault=true, position=1) — ver crm-service.ts#createCardCrmForTarget,
  /// que depende desse estágio existir pra todo lead novo cair nele.
  async create(user: AuthUser, input: { name: string; cnpj: string }) {
    return prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          id: randomUUID(),
          name: input.name,
          slug: slugify(input.name),
          cnpj: input.cnpj,
          status: "ACTIVE",
          createdAt: new Date(),
        },
      });

      await tx.member.create({
        data: {
          id: randomUUID(),
          organizationId: organization.id,
          userId: user.id,
          role: "GERENTE",
          createdAt: new Date(),
        },
      });

      const crmToBusiness = await tx.crmToBusiness.create({
        data: { organizationId: organization.id },
      });

      await tx.stagesCrm.create({
        data: { crmToBusinessId: crmToBusiness.id, nameStage: "Início", position: 1, isDefault: true },
      });

      return organization;
    });
  },

  async listForUser(user: AuthUser) {
    if (user.isPlatformAdmin) {
      return prisma.organization.findMany({ orderBy: { createdAt: "desc" } });
    }

    const memberships = await prisma.member.findMany({
      where: { userId: user.id },
      include: { organization: true },
      orderBy: { createdAt: "desc" },
    });

    return memberships.map((m) => m.organization);
  },

  async getById(user: AuthUser, organizationId: string) {
    if (!user.isPlatformAdmin) {
      const member = await prisma.member.findUnique({
        where: { organizationId_userId: { organizationId, userId: user.id } },
      });
      if (!member) throw new ForbiddenError("Você não tem acesso a esta empresa.");
    }

    const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!organization) throw new NotFoundError("Empresa não encontrada.");

    return organization;
  },

  async listMembers(user: AuthUser, organizationId: string) {
    await this.getById(user, organizationId);

    return prisma.member.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
      orderBy: { createdAt: "asc" },
    });
  },

  /// Tela de Acessos: "Tipo de acesso" de um usuário dentro da empresa.
  /// Administrador não é editável aqui — é a flag global do plugin admin do
  /// Better Auth, fora do escopo de uma organização específica.
  async updateMemberRole(user: AuthUser, organizationId: string, memberId: string, role: string) {
    await this.getById(user, organizationId);

    if (!isMemberRole(role)) {
      throw new ValidationError("Tipo de acesso inválido.");
    }

    const member = await prisma.member.findFirst({ where: { id: memberId, organizationId } });
    if (!member) throw new NotFoundError("Usuário não encontrado nesta empresa.");

    // Trocar o papel zera as telas personalizadas: o usuário passa a seguir o
    // padrão do novo papel (checkboxes podem ser ajustados de novo depois).
    return prisma.member.update({
      where: { id: member.id },
      data: { role, permissions: Prisma.DbNull },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
    });
  },

  /// Tela de Acessos: telas que o usuário pode acessar/editar, marcadas por
  /// checkbox. null volta ao padrão do papel. Só aceita ações configuráveis
  /// (CONFIGURABLE_PERMISSIONS) — Acessos/empresas seguem presos ao papel.
  async updateMemberPermissions(
    user: AuthUser,
    organizationId: string,
    memberId: string,
    permissions: string[] | null,
  ) {
    await this.getById(user, organizationId);

    const member = await prisma.member.findFirst({ where: { id: memberId, organizationId } });
    if (!member) throw new NotFoundError("Usuário não encontrado nesta empresa.");
    if (member.userId === user.id) throw new ValidationError("Você não pode alterar as suas próprias permissões.");

    if (permissions && !permissions.every(isConfigurablePermission)) {
      throw new ValidationError("Permissão inválida.");
    }

    return prisma.member.update({
      where: { id: member.id },
      data: { permissions: permissions ? [...new Set(permissions)] : Prisma.DbNull },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
    });
  },

  /// Remove o acesso do usuário a esta empresa (exclui o Member — pra voltar
  /// precisa de um novo convite/código). Diferente de bloquear, não é
  /// reversível com um clique.
  async removeMember(user: AuthUser, organizationId: string, memberId: string) {
    await this.getById(user, organizationId);

    const member = await prisma.member.findFirst({ where: { id: memberId, organizationId } });
    if (!member) throw new NotFoundError("Usuário não encontrado nesta empresa.");
    if (member.userId === user.id) throw new ValidationError("Você não pode remover o seu próprio acesso.");

    await prisma.member.delete({ where: { id: member.id } });
    return member;
  },

  /// Bloqueia/desbloqueia o acesso do usuário a esta empresa especificamente —
  /// reversível (ver Member.blocked no schema), ao contrário de removeMember.
  async setMemberBlocked(user: AuthUser, organizationId: string, memberId: string, blocked: boolean) {
    await this.getById(user, organizationId);

    const member = await prisma.member.findFirst({ where: { id: memberId, organizationId } });
    if (!member) throw new NotFoundError("Usuário não encontrado nesta empresa.");
    if (member.userId === user.id) throw new ValidationError("Você não pode bloquear o seu próprio acesso.");

    return prisma.member.update({
      where: { id: member.id },
      data: { blocked },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
    });
  },

  /// Gera (ou rotaciona) o token de acesso à API externa (Fluxy Agents) desta
  /// empresa.
  async generateApiToken(user: AuthUser, organizationId: string) {
    await this.getById(user, organizationId);

    const token = randomBytes(32).toString("hex");
    await prisma.organization.update({
      where: { id: organizationId },
      data: { tokenAcessApi: token },
    });

    return { token };
  },

  /// Devolve o token de acesso à API externa já configurado nesta empresa
  /// (ou null se nunca foi gerado) — quem chama a rota já checou a mesma
  /// permissão de GERENTE/admin usada para gerar o token.
  async getApiToken(user: AuthUser, organizationId: string) {
    const organization = await this.getById(user, organizationId);
    return { token: organization.tokenAcessApi ?? null };
  },

  /// Gera um código de convite (invitationMember) para a empresa, com o papel
  /// que será concedido a quem resgatar e o e-mail da pessoa convidada — quem
  /// resgata não escolhe papel nem e-mail, quem convida sim, na hora da
  /// geração. O resgate só é aceito se bater com esse e-mail (ver
  /// redeemInviteCode).
  async generateInviteCode(user: AuthUser, organizationId: string, role: string, email: string) {
    await this.getById(user, organizationId);

    if (!isMemberRole(role)) {
      throw new ValidationError("Papel inválido.");
    }

    return prisma.invitationMember.create({
      data: { organizationId, code: generateInviteCode(), role, email: email.trim().toLowerCase(), finish: true },
    });
  },

  async listInviteCodes(user: AuthUser, organizationId: string) {
    await this.getById(user, organizationId);

    return prisma.invitationMember.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });
  },

  /// Exclui um código de convite ainda ativo. Convite já resgatado não pode
  /// ser excluído — ele é o histórico de quem entrou por ele. O deleteMany com
  /// finish=true no where segue o mesmo compare-and-swap do resgate: se o
  /// convite for resgatado no meio da exclusão, count vem 0 e nada some.
  async deleteInviteCode(user: AuthUser, organizationId: string, invitationId: string) {
    await this.getById(user, organizationId);

    const invitation = await prisma.invitationMember.findFirst({ where: { id: invitationId, organizationId } });
    if (!invitation) throw new NotFoundError("Código de convite não encontrado.");
    if (!invitation.finish) throw new ConflictError("Este convite já foi utilizado e não pode ser excluído.");

    const deleted = await prisma.invitationMember.deleteMany({ where: { id: invitationId, organizationId, finish: true } });
    if (deleted.count === 0) throw new ConflictError("Este convite já foi utilizado e não pode ser excluído.");

    return invitation;
  },

  /// Resgate do código na tela de cadastro (signup): o code precisa existir,
  /// ainda estar ativo (finish=true) E o e-mail da conta logada precisa bater
  /// com o e-mail informado na geração — o code sozinho não basta, alguém que
  /// o intercepte não consegue usá-lo com outra conta. O updateMany com
  /// finish=true na cláusula where funciona como compare-and-swap — se duas
  /// requisições concorrentes tentarem resgatar o mesmo code, só uma consegue
  /// afetar 1 linha; a outra recebe count 0 e sabe que perdeu a corrida, sem
  /// precisar de lock explícito.
  async redeemInviteCode(user: AuthUser, code: string) {
    const invitation = await prisma.invitationMember.findUnique({ where: { code } });
    if (!invitation) throw new NotFoundError("Código de convite inválido.");

    if (invitation.email !== user.email.trim().toLowerCase()) {
      throw new ForbiddenError("Este código de convite foi gerado para outro e-mail.");
    }

    const existingMember = await prisma.member.findUnique({
      where: { organizationId_userId: { organizationId: invitation.organizationId, userId: user.id } },
    });
    if (existingMember) throw new ConflictError("Você já faz parte desta empresa.");

    const claimed = await prisma.invitationMember.updateMany({
      where: { id: invitation.id, finish: true },
      data: { finish: false, userId: user.id },
    });
    if (claimed.count === 0) throw new ConflictError("Este código de convite já foi utilizado.");

    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
        createdAt: new Date(),
      },
    });

    return prisma.organization.findUniqueOrThrow({ where: { id: invitation.organizationId } });
  },
};
