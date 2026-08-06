import { Hono } from 'hono';
import { z } from 'zod';
import { validateQuery } from '@hono/zod-validator';
import { prisma } from '@uqood/database';

const reportsRouter = new Hono();

// Dashboard overview
reportsRouter.get('/dashboard', async (c) => {
  const user = c.get('user') as { userId: string; orgId: string; role: string };

  const [
    contractStats,
    assetStats,
    financialStats,
    approvalStats
  ] = await Promise.all([
    // Contract statistics
    prisma.$transaction([
      prisma.contract.count({ where: { orgId: user.orgId, status: 'ACTIVE' } }),
      prisma.contract.count({ where: { orgId: user.orgId, status: 'PENDING_APPROVAL' } }),
      prisma.contract.count({ 
        where: { 
          orgId: user.orgId,
          endDate: { lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
          status: 'ACTIVE'
        }
      }),
      prisma.contract.aggregate({
        where: { orgId: user.orgId },
        _sum: { totalValue: true }
      })
    ]),
    
    // Asset statistics
    prisma.$transaction([
      prisma.asset.count({ where: { orgId: user.orgId } }),
      prisma.asset.count({ where: { orgId: user.orgId, status: 'UNDER_CONTRACT' } }),
      prisma.asset.count({ where: { orgId: user.orgId, status: 'AVAILABLE' } })
    ]),
    
    // Financial statistics
    prisma.$transaction([
      prisma.paymentSchedule.aggregate({
        where: { contract: { orgId: user.orgId } },
        _sum: { amount: true }
      }),
      prisma.paymentSchedule.count({
        where: { 
          contract: { orgId: user.orgId },
          status: 'OVERDUE'
        }
      }),
      prisma.ledgerEntry.aggregate({
        where: { orgId: user.orgId },
        _sum: { amount: true }
      })
    ]),
    
    // Approval statistics
    prisma.$transaction([
      prisma.approvalRequest.count({ 
        where: { orgId: user.orgId, status: 'PENDING' }
      }),
      prisma.approvalRequest.count({ 
        where: { orgId: user.orgId, status: 'APPROVED' }
      }),
      prisma.approvalRequest.count({ 
        where: { orgId: user.orgId, status: 'REJECTED' }
      })
    ])
  ]);

  return c.json({
    data: {
      contracts: {
        active: contractStats[0],
        pendingApproval: contractStats[1],
        expiringSoon: contractStats[2],
        totalValue: Number(contractStats[3]._sum.totalValue || 0)
      },
      assets: {
        total: assetStats[0],
        underContract: assetStats[1],
        available: assetStats[2]
      },
      financial: {
        totalPayments: Number(financialStats[0]._sum.amount || 0),
        overduePayments: financialStats[1],
        ledgerTotal: Number(financialStats[2]._sum.amount || 0)
      },
      approvals: {
        pending: approvalStats[0],
        approved: approvalStats[1],
        rejected: approvalStats[2]
      }
    }
  });
});

// Contract analytics report
reportsRouter.get('/contracts/analytics',
  validateQuery(z.object({
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    groupBy: z.enum(['type', 'status', 'month']).default('status'),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const { startDate, endDate, groupBy } = c.req.valid('query');

    const where: any = { orgId: user.orgId };
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    let contracts;
    
    if (groupBy === 'status') {
      contracts = await prisma.contract.groupBy({
        by: ['status'],
        where,
        _count: { id: true },
        _sum: { totalValue: true }
      });
    } else if (groupBy === 'type') {
      // Group by template type
      contracts = await prisma.contract.findMany({
        where,
        include: {
          template: { select: { typeName: true } }
        }
      });
      
      // Manual grouping
      const grouped: Record<string, any> = {};
      contracts.forEach(c => {
        const type = c.template?.typeName || 'OTHER';
        if (!grouped[type]) {
          grouped[type] = { count: 0, totalValue: 0 };
        }
        grouped[type].count++;
        grouped[type].totalValue += Number(c.totalValue);
      });
      
      contracts = Object.entries(grouped).map(([type, data]: [string, any]) => ({
        type,
        ...data
      }));
    }

    return c.json({ data: contracts });
  }
);

// Financial report
reportsRouter.get('/financial/summary',
  validateQuery(z.object({
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
    includeLedger: z.string().transform(v => v === 'true').default('false'),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const { startDate, endDate, includeLedger } = c.req.valid('query');

    const [payments, expenses, ledgerEntries] = await Promise.all([
      prisma.paymentSchedule.findMany({
        where: {
          contract: { orgId: user.orgId },
          paidDate: { gte: new Date(startDate), lte: new Date(endDate) }
        },
        include: {
          contract: { select: { contractNumber: true, title: true } }
        }
      }),
      prisma.expense.findMany({
        where: {
          orgId: user.orgId,
          expenseDate: { gte: new Date(startDate), lte: new Date(endDate) },
          status: 'APPROVED'
        }
      }),
      includeLedger ? prisma.ledgerEntry.findMany({
        where: {
          orgId: user.orgId,
          createdAt: { gte: new Date(startDate), lte: new Date(endDate) }
        },
        orderBy: { createdAt: 'desc' },
        take: 100
      }) : []
    ]);

    const totalIncome = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

    return c.json({
      data: {
        period: { startDate, endDate },
        summary: {
          totalIncome,
          totalExpenses,
          netProfit: totalIncome - totalExpenses
        },
        payments,
        expenses,
        ledgerEntries: includeLedger ? ledgerEntries : undefined
      }
    });
  }
);

// Export data (placeholder for actual export logic)
reportsRouter.get('/export/:entityType',
  validateQuery(z.object({
    format: z.enum(['json', 'csv']).default('json'),
    filters: z.string().optional(),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const entityType = c.req.param('entityType');
    const { format, filters } = c.req.valid('query');

    // Placeholder - in production, implement proper CSV/PDF generation
    return c.json({
      message: 'Export functionality - implement based on requirements',
      entityType,
      format,
      note: 'Use libraries like json2csv or pdfkit for actual export'
    });
  }
);

export { reportsRouter };
