import { prisma } from '@uqood/database';
import type { PartnershipStatus, UserRole } from '@prisma/client';

interface PartnershipScope {
  all?: boolean;
  portfolios?: string[];
  contractTypes?: string[];
  specificContracts?: string[];
}

interface CreatePartnershipData {
  orgId: string;
  userId: string;
  role: UserRole;
  scope: PartnershipScope;
  profitShare: number;
}

/**
 * Partnership Service - Manages partner invitations and access control
 * Implements scope-based permissions from SRS v1.1 section 2.2
 */
export class PartnershipService {
  /**
   * Create a partnership with scoped access
   */
  async createPartnership(data: CreatePartnershipData): Promise<any> {
    const { orgId, userId, role, scope, profitShare } = data;

    // Validate profit share (0-100)
    if (profitShare < 0 || profitShare > 100) {
      throw new Error('Profit share must be between 0 and 100');
    }

    // Check if partnership already exists
    const existing = await prisma.partnership.findUnique({
      where: {
        orgId_userId: {
          orgId,
          userId,
        },
      },
    });

    if (existing) {
      throw new Error('Partnership already exists for this user');
    }

    // Create partnership
    const partnership = await prisma.partnership.create({
      data: {
        orgId,
        userId,
        role,
        scope: scope as any,
        profitShare,
        status: 'PENDING',
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    // TODO: Send invitation email via Resend/SendGrid
    // await sendInvitationEmail(user.email, partnership.id);

    return partnership;
  }

  /**
   * Accept partnership invitation
   */
  async acceptPartnership(partnershipId: string, userId: string): Promise<any> {
    const partnership = await prisma.partnership.update({
      where: { 
        id: partnershipId,
        userId,
      },
      data: {
        status: 'ACTIVE',
      },
    });

    return partnership;
  }

  /**
   * Reject partnership invitation
   */
  async rejectPartnership(partnershipId: string, userId: string): Promise<void> {
    await prisma.partnership.delete({
      where: {
        id: partnershipId,
        userId,
      },
    });
  }

  /**
   * Get partnerships for an organization
   */
  async getPartnerships(orgId: string): Promise<any[]> {
    return prisma.partnership.findMany({
      where: { orgId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Update partnership scope and profit share
   */
  async updatePartnership(
    partnershipId: string,
    orgId: string,
    updates: { scope?: PartnershipScope; profitShare?: number }
  ): Promise<any> {
    if (updates.profitShare !== undefined) {
      if (updates.profitShare < 0 || updates.profitShare > 100) {
        throw new Error('Profit share must be between 0 and 100');
      }
    }

    return prisma.partnership.update({
      where: { 
        id: partnershipId,
        orgId,
      },
      data: updates,
    });
  }

  /**
   * Deactivate partnership
   */
  async deactivatePartnership(partnershipId: string, orgId: string): Promise<any> {
    return prisma.partnership.update({
      where: {
        id: partnershipId,
        orgId,
      },
      data: {
        status: 'INACTIVE',
      },
    });
  }

  /**
   * Check if user has access to a specific resource based on scope
   */
  async hasAccessToResource(
    userId: string,
    orgId: string,
    resourceType: 'CONTRACT' | 'ASSET' | 'PORTFOLIO',
    resourceId: string
  ): Promise<boolean> {
    const partnership = await prisma.partnership.findFirst({
      where: {
        userId,
        orgId,
        status: 'ACTIVE',
      },
    });

    if (!partnership) {
      // User is not a partner, check if they have direct access
      return false;
    }

    const scope = partnership.scope as PartnershipScope;

    // If scope.all is true, they have access to everything
    if (scope.all === true) {
      return true;
    }

    // Check specific scopes based on resource type
    switch (resourceType) {
      case 'PORTFOLIO':
        if (scope.portfolios) {
          return scope.portfolios.includes(resourceId);
        }
        break;

      case 'CONTRACT':
        // Check if contract is in allowed portfolios
        if (scope.portfolios) {
          const contract = await prisma.contract.findUnique({
            where: { id: resourceId },
            select: { portfolioId: true },
          });
          
          if (contract?.portfolioId && scope.portfolios.includes(contract.portfolioId)) {
            return true;
          }
        }

        // Check specific contracts
        if (scope.specificContracts) {
          return scope.specificContracts.includes(resourceId);
        }

        // Check contract types
        if (scope.contractTypes) {
          const contract = await prisma.contract.findUnique({
            where: { id: resourceId },
            include: { template: true },
          });

          if (contract?.template && scope.contractTypes.includes(contract.template.typeName)) {
            return true;
          }
        }
        break;

      case 'ASSET':
        // Check if asset is in allowed portfolios
        if (scope.portfolios) {
          const asset = await prisma.asset.findUnique({
            where: { id: resourceId },
            select: { portfolioId: true },
          });

          if (asset?.portfolioId && scope.portfolios.includes(asset.portfolioId)) {
            return true;
          }
        }
        break;
    }

    return false;
  }

  /**
   * Get accessible contracts for a partner based on their scope
   */
  async getAccessibleContracts(userId: string, orgId: string): Promise<any[]> {
    const partnership = await prisma.partnership.findFirst({
      where: {
        userId,
        orgId,
        status: 'ACTIVE',
      },
    });

    if (!partnership) {
      return [];
    }

    const scope = partnership.scope as PartnershipScope;

    if (scope.all === true) {
      return prisma.contract.findMany({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
      });
    }

    const whereConditions: any[] = [{ orgId }];

    if (scope.portfolios && scope.portfolios.length > 0) {
      whereConditions.push({
        portfolioId: { in: scope.portfolios },
      });
    }

    if (scope.specificContracts && scope.specificContracts.length > 0) {
      whereConditions.push({
        id: { in: scope.specificContracts },
      });
    }

    if (scope.contractTypes && scope.contractTypes.length > 0) {
      const contracts = await prisma.contract.findMany({
        where: {
          orgId,
          template: {
            typeName: { in: scope.contractTypes },
          },
        },
      });

      whereConditions.push({
        id: { in: contracts.map(c => c.id) },
      });
    }

    return prisma.contract.findMany({
      where: { OR: whereConditions },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Calculate profit distribution for a partner
   */
  async calculateProfitDistribution(
    orgId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<{ partnerId: string; amount: number; percentage: number }[]> {
    const partnerships = await prisma.partnership.findMany({
      where: {
        orgId,
        status: 'ACTIVE',
        profitShare: { gt: 0 },
      },
    });

    // Get total revenue from approved contracts in the period
    const contracts = await prisma.contract.findMany({
      where: {
        orgId,
        status: 'ACTIVE',
        paymentSchedule: {
          some: {
            paidDate: {
              gte: periodStart,
              lte: periodEnd,
            },
            status: 'PAID',
          },
        },
      },
      include: {
        paymentSchedule: {
          where: {
            status: 'PAID',
            paidDate: {
              gte: periodStart,
              lte: periodEnd,
            },
          },
        },
      },
    });

    const totalRevenue = contracts.reduce((sum, contract) => {
      return sum + contract.paymentSchedule.reduce((s, p) => s + Number(p.amount), 0);
    }, 0);

    // Get total expenses in the period
    const expenses = await prisma.expense.aggregate({
      where: {
        orgId,
        status: 'APPROVED',
        expenseDate: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      _sum: { amount: true },
    });

    const totalExpenses = Number(expenses._sum.amount || 0);
    const netProfit = totalRevenue - totalExpenses;

    // Calculate each partner's share
    return partnerships.map(p => ({
      partnerId: p.userId,
      amount: (netProfit * Number(p.profitShare)) / 100,
      percentage: Number(p.profitShare),
    }));
  }
}

export const partnershipService = new PartnershipService();
