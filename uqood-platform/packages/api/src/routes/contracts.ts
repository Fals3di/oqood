import { Hono } from 'hono';
import { z } from 'zod';
import { validateJsonBody, validateQuery } from '@hono/zod-validator';
import { prisma } from '@uqood/database';
import { checkRole } from '../middleware/auth';

const contractsRouter = new Hono();

// Validation schemas
const contractBaseSchema = z.object({
  templateId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  portfolioId: z.string().uuid().optional(),
  contractNumber: z.string().min(1).max(50),
  title: z.string().min(1).max(200),
  status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'EXPIRING_SOON', 'EXPIRED', 'RENEWED', 'CANCELLED', 'TERMINATED']).optional(),
  baseData: z.record(z.any()).optional(),
  customFields: z.record(z.any()).optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  autoRenew: z.boolean().default(false),
  currency: z.string().default('SAR'),
  totalValue: z.number().positive(),
  responsibleUserId: z.string().uuid().optional(),
});

const createContractSchema = contractBaseSchema.extend({
  parties: z.array(z.object({
    partyType: z.enum(['INDIVIDUAL', 'COMPANY']),
    name: z.string().min(1),
    taxNumber: z.string().optional(),
    contactInfo: z.object({
      email: z.string().email().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
    }).optional(),
    rating: z.number().min(0).max(5).optional(),
    role: z.enum(['FIRST_PARTY', 'SECOND_PARTY', 'GUARANTOR', 'WITNESS']),
  })).optional(),
  clauses: z.array(z.object({
    clauseType: z.enum(['MAINTENANCE', 'PAYMENT', 'INSURANCE', 'PENALTIES', 'DELIVERY', 'WARRANTY', 'CONFIDENTIALITY', 'TERMINATION', 'DISPUTE_RESOLUTION', 'OTHER']),
    baseData: z.record(z.any()).optional(),
    customFields: z.record(z.any()).optional(),
    order: z.number().int().default(0),
  })).optional(),
});

const updateContractSchema = contractBaseSchema.partial();

// List contracts with filters
contractsRouter.get('/', 
  validateQuery(z.object({
    status: z.string().optional(),
    portfolioId: z.string().uuid().optional(),
    assetId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
    search: z.string().optional(),
    page: z.string().transform(Number).default('1'),
    limit: z.string().transform(Number).default('20'),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const { status, portfolioId, assetId, templateId, search, page, limit } = c.req.valid('query');

    const where: any = { orgId: user.orgId };

    if (status) where.status = status;
    if (portfolioId) where.portfolioId = portfolioId;
    if (assetId) where.assetId = assetId;
    if (templateId) where.templateId = templateId;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { contractNumber: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [contracts, total] = await Promise.all([
      prisma.contract.findMany({
        where,
        include: {
          asset: { select: { id: true, name: true, assetType: true } },
          portfolio: { select: { id: true, name: true } },
          template: { select: { id: true, typeName: true } },
          parties: true,
          _count: { select: { addendums: true, clauses: true, paymentSchedule: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.contract.count({ where })
    ]);

    return c.json({
      data: contracts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  }
);

// Get single contract
contractsRouter.get('/:id', async (c) => {
  const user = c.get('user') as { userId: string; orgId: string; role: string };
  const id = c.req.param('id');

  const contract = await prisma.contract.findFirst({
    where: { id, orgId: user.orgId },
    include: {
      asset: true,
      portfolio: true,
      template: true,
      parties: true,
      addendums: { orderBy: { addendumNumber: 'asc' } },
      clauses: { orderBy: { order: 'asc' }, include: { details: true } },
      paymentSchedule: { orderBy: { dueDate: 'asc' } },
      expenses: true,
      cheques: true,
      files: true,
      conversations: true,
      alerts: true,
    }
  });

  if (!contract) {
    return c.json({ error: 'Contract not found' }, 404);
  }

  // Check access based on user role and partnership scope
  // TODO: Implement scope checking logic

  return c.json({ data: contract });
});

// Create contract
contractsRouter.post('/',
  checkRole('OWNER', 'ADMIN', 'DATA_ENTRY', 'FULL_PARTNER'),
  validateJsonBody(createContractSchema),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const body = c.req.valid('json');
    const { parties, clauses, ...contractData } = body;

    // Create contract with nested parties and clauses
    const contract = await prisma.contract.create({
      data: {
        ...contractData,
        orgId: user.orgId,
        responsibleUserId: contractData.responsibleUserId || user.userId,
        parties: parties ? { create: parties } : undefined,
        clauses: clauses ? { create: clauses } : undefined,
      },
      include: {
        parties: true,
        clauses: true,
      }
    });

    // Create approval request if needed based on policy
    // TODO: Implement approval policy check

    // Create ledger entry for contract value
    await prisma.ledgerEntry.create({
      data: {
        orgId: user.orgId,
        entryType: 'ADJUSTMENT',
        amount: contract.totalValue,
        currency: contract.currency,
        sourceEntity: 'CONTRACT',
        sourceId: contract.id,
        createdBy: user.userId,
        metadata: { action: 'contract_created', contractNumber: contract.contractNumber }
      }
    });

    // Trigger webhook
    // TODO: Implement webhook dispatch

    return c.json({ data: contract }, 201);
  }
);

// Update contract
contractsRouter.patch('/:id',
  checkRole('OWNER', 'ADMIN', 'FULL_PARTNER'),
  validateJsonBody(updateContractSchema),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const id = c.req.param('id');
    const body = c.req.valid('json');

    // Verify contract exists and belongs to org
    const existing = await prisma.contract.findFirst({
      where: { id, orgId: user.orgId }
    });

    if (!existing) {
      return c.json({ error: 'Contract not found' }, 404);
    }

    // For active contracts, significant changes should go through addendum
    // This is a simplified update for non-critical fields
    
    const contract = await prisma.contract.update({
      where: { id },
      data: body,
      include: {
        parties: true,
        clauses: true,
      }
    });

    // Log audit
    await prisma.auditLog.create({
      data: {
        orgId: user.orgId,
        userId: user.userId,
        action: 'CONTRACT_UPDATED',
        tableName: 'contracts',
        oldData: existing,
        newData: contract,
      }
    });

    return c.json({ data: contract });
  }
);

// Delete contract (soft delete via status)
contractsRouter.delete('/:id',
  checkRole('OWNER', 'ADMIN'),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const id = c.req.param('id');

    const contract = await prisma.contract.update({
      where: { id, orgId: user.orgId },
      data: { status: 'CANCELLED' }
    });

    await prisma.auditLog.create({
      data: {
        orgId: user.orgId,
        userId: user.userId,
        action: 'CONTRACT_CANCELLED',
        tableName: 'contracts',
        newData: contract,
      }
    });

    return c.json({ data: contract, message: 'Contract cancelled successfully' });
  }
);

export { contractsRouter };
