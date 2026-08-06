import { Hono } from 'hono';
import { z } from 'zod';
import { validateJsonBody, validateQuery } from '@hono/zod-validator';
import { prisma } from '@uqood/database';
import { checkRole } from '../middleware/auth';

const assetsRouter = new Hono();

// Validation schemas
const assetSchema = z.object({
  portfolioId: z.string().uuid().optional(),
  assetType: z.enum(['REAL_ESTATE', 'VEHICLE', 'EQUIPMENT', 'LICENSE', 'INTANGIBLE', 'OTHER']),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  location: z.object({
    lat: z.number().optional(),
    lng: z.number().optional(),
    address: z.string().optional(),
    unitNumber: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
  }).optional(),
  acquisitionData: z.object({
    purchaseDate: z.string().datetime().optional(),
    cost: z.number().positive().optional(),
    supplier: z.string().optional(),
    warrantyEndDate: z.string().datetime().optional(),
  }).optional(),
  status: z.enum(['AVAILABLE', 'UNDER_CONTRACT', 'MAINTENANCE', 'SOLD', 'RETIRED']).optional(),
});

// List assets with filters
assetsRouter.get('/',
  validateQuery(z.object({
    assetType: z.string().optional(),
    status: z.string().optional(),
    portfolioId: z.string().uuid().optional(),
    search: z.string().optional(),
    page: z.string().transform(Number).default('1'),
    limit: z.string().transform(Number).default('20'),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const { assetType, status, portfolioId, search, page, limit } = c.req.valid('query');

    const where: any = { orgId: user.orgId };

    if (assetType) where.assetType = assetType;
    if (status) where.status = status;
    if (portfolioId) where.portfolioId = portfolioId;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        include: {
          portfolio: { select: { id: true, name: true } },
          contracts: {
            select: {
              id: true,
              contractNumber: true,
              title: true,
              status: true,
              startDate: true,
              endDate: true,
            }
          },
          _count: { select: { contracts: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.asset.count({ where })
    ]);

    return c.json({
      data: assets,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  }
);

// Get single asset with full details
assetsRouter.get('/:id', async (c) => {
  const user = c.get('user') as { userId: string; orgId: string; role: string };
  const id = c.req.param('id');

  const asset = await prisma.asset.findFirst({
    where: { id, orgId: user.orgId },
    include: {
      portfolio: true,
      contracts: {
        include: {
          parties: true,
          paymentSchedule: true,
        },
        orderBy: { startDate: 'desc' }
      },
      expenses: true,
    }
  });

  if (!asset) {
    return c.json({ error: 'Asset not found' }, 404);
  }

  // Calculate ROI if there's financial data
  const totalRevenue = asset.contracts.reduce((sum, contract) => {
    return sum + Number(contract.totalValue || 0);
  }, 0);

  const totalExpenses = asset.expenses.reduce((sum, expense) => {
    return sum + Number(expense.amount || 0);
  }, 0);

  const roi = totalExpenses > 0 ? ((totalRevenue - totalExpenses) / totalExpenses) * 100 : 0;

  return c.json({
    data: {
      ...asset,
      analytics: {
        totalRevenue,
        totalExpenses,
        roi: roi.toFixed(2),
        contractCount: asset.contracts.length,
        activeContracts: asset.contracts.filter(c => c.status === 'ACTIVE').length,
      }
    }
  });
});

// Create asset
assetsRouter.post('/',
  checkRole('OWNER', 'ADMIN', 'DATA_ENTRY', 'FULL_PARTNER'),
  validateJsonBody(assetSchema),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const body = c.req.valid('json');

    const asset = await prisma.asset.create({
      data: {
        ...body,
        orgId: user.orgId,
      },
      include: {
        portfolio: true,
      }
    });

    // Log audit
    await prisma.auditLog.create({
      data: {
        orgId: user.orgId,
        userId: user.userId,
        action: 'ASSET_CREATED',
        tableName: 'assets',
        newData: asset,
      }
    });

    return c.json({ data: asset }, 201);
  }
);

// Update asset
assetsRouter.patch('/:id',
  checkRole('OWNER', 'ADMIN', 'FULL_PARTNER'),
  validateJsonBody(assetSchema.partial()),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const existing = await prisma.asset.findFirst({
      where: { id, orgId: user.orgId }
    });

    if (!existing) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    const asset = await prisma.asset.update({
      where: { id },
      data: body,
    });

    await prisma.auditLog.create({
      data: {
        orgId: user.orgId,
        userId: user.userId,
        action: 'ASSET_UPDATED',
        tableName: 'assets',
        oldData: existing,
        newData: asset,
      }
    });

    return c.json({ data: asset });
  }
);

// Delete asset
assetsRouter.delete('/:id',
  checkRole('OWNER', 'ADMIN'),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const id = c.req.param('id');

    const existing = await prisma.asset.findFirst({
      where: { id, orgId: user.orgId }
    });

    if (!existing) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    // Check if asset has active contracts
    const activeContracts = await prisma.contract.count({
      where: { assetId: id, status: { in: ['ACTIVE', 'PENDING_APPROVAL'] } }
    });

    if (activeContracts > 0) {
      return c.json({ 
        error: 'Cannot delete asset with active contracts',
        activeContracts 
      }, 400);
    }

    await prisma.asset.delete({
      where: { id }
    });

    await prisma.auditLog.create({
      data: {
        orgId: user.orgId,
        userId: user.userId,
        action: 'ASSET_DELETED',
        tableName: 'assets',
        oldData: existing,
      }
    });

    return c.json({ message: 'Asset deleted successfully' });
  }
);

export { assetsRouter };
