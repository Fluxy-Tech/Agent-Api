import { fromNodeHeaders } from "better-auth/node";
import { Router } from "express";
import { z } from "zod";
import { companyService } from "../../../application/company/company-service";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../domain/errors/app-error";
import { auth } from "../../../infrastructure/auth/better-auth";
import { prisma } from "../../../infrastructure/database/prisma/client";
import { apiHandler } from "../middlewares/api-handler";
import { recordAudit } from "../middlewares/audit";

const activeCompanySchema = z.object({ companyId: z.string().min(1) });

export const sessionRouter = Router();

/// Tela `/business`: grava a empresa escolhida em Session.activeOrganizationId.
/// Administrador (flag de plataforma) pode ativar qualquer empresa; os demais
/// só empresas às quais pertencem (Member).
sessionRouter.post(
  "/active-company",
  apiHandler({ requireCompany: false }, async (req, _res, user) => {
    const parsed = activeCompanySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError("Necessário informar companyId.", parsed.error.flatten());

    const companyId = parsed.data.companyId;

    if (!user.isPlatformAdmin) {
      const companies = await companyService.listForUser(user);
      if (!companies.some((c) => c.id === companyId)) {
        throw new ForbiddenError("Você não pertence a esta empresa.");
      }
    }

    const company = await companyService.getById(user, companyId).catch(() => null);
    if (!company) throw new NotFoundError("Empresa não encontrada.");

    const headers = fromNodeHeaders(req.headers);
    const isMember = await prisma.member.findUnique({
      where: { organizationId_userId: { organizationId: companyId, userId: user.id } },
      select: { id: true },
    });

    if (isMember) {
      await auth.api.setActiveOrganization({ body: { organizationId: companyId }, headers });
    } else {
      // Administrador sem Member na empresa (ex: a central "Suporte Sturnus",
      // ou uma empresa cliente que ele está atendendo): o plugin organization
      // do Better Auth recusa (USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION), então
      // grava a empresa ativa direto na sessão. Seguro porque só chega aqui
      // quem passou pela checagem acima (não-admin precisa ser membro), e a
      // sessão é lida do banco a cada request (sem cookie cache).
      const session = await auth.api.getSession({ headers });
      if (!session) throw new ForbiddenError();
      await prisma.session.update({
        where: { id: session.session.id },
        data: { activeOrganizationId: companyId },
      });
    }

    await recordAudit(req, user, {
      action: "COMPANY_ACTIVATED",
      resourceType: "Company",
      resourceId: companyId,
    });

    return company;
  }),
);
