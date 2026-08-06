import { Hono } from 'hono';
import { z } from 'zod';
import { validateJsonBody, validateQuery } from '@hono/zod-validator';
import { prisma } from '@uqood/database';
import { checkRole } from '../middleware/auth';

const approvalsRouter = new Hono();

// List approval requests
approvalsRouter.get('/requests',
  validateQuery(z.object({
    status: z.string().optional(),
    entityType: z.string().optional(),
    page: z.string().transform(Number).default('1'),
    limit: z.string().transform(Number).default('20'),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const { status, entityType, page, limit } = c.req.valid('query');

    const where: any = { orgId: user.orgId };
    if (status) where.status = status;
    if (entityType) where.entityType = entityType;

    const [requests, total] = await Promise.all([
      prisma.approvalRequest.findMany({
        where,
        include: {
          decisions: {
            include: {
              request: {
                select: { id: true, entityType: true, entityId: true }
              }
            }
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.approvalRequest.count({ where })
    ]);

    return c.json({
      data: requests,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  }
);

// Get pending approvals for current user
approvalsRouter.get('/pending', async (c) => {
  const user = c.get('user') as { userId: string; orgId: string; role: string };

  // Find approval policies where this user is an approver
  const policies = await prisma.approvalPolicy.findMany({
    where: {
      orgId: user.orgId,
      isActive: true,
    }
  });

  // Get pending requests for those policies
  const pendingRequests = await prisma.approvalRequest.findMany({
    where: {
      orgId: user.orgId,
      status: 'PENDING',
      entityType: {
        in: policies.map(p => p.entityType)
      }
    },
    include: {
      decisions: true,
    }
  });

  return c.json({ data: pendingRequests });
});

// Make approval decision
approvalsRouter.post('/requests/:id/decide',
  validateJsonBody(z.object({
    decision: z.enum(['APPROVE', 'REJECT', 'RETURN']),
    comment: z.string().max(500).optional(),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const id = c.req.param('id');
    const { decision, comment } = c.req.valid('json');

    const request = await prisma.approvalRequest.findFirst({
      where: { id, orgId: user.orgId },
      include: {
        decisions: true
      }
    });

    if (!request) {
      return c.json({ error: 'Approval request not found' }, 404);
    }

    if (request.status !== 'PENDING') {
      return c.json({ error: 'This request has already been processed' }, 400);
    }

    // Record decision
    await prisma.approvalDecision.create({
      data: {
        requestId: id,
        approverId: user.userId,
        decision,
        comment,
      }
    });

    // Check if we have enough decisions to finalize
    const policy = await prisma.approvalPolicy.findFirst({
      where: {
        orgId: user.orgId,
        entityType: request.entityType,
        isActive: true,
      }
    });

    let finalStatus = request.status;
    
    if (policy) {
      const allDecisions = await prisma.approvalDecision.findMany({
        where: { requestId: id }
      });

      switch (policy.approvalMode) {
        case 'SINGLE_APPROVER':
          if (decision === 'APPROVE') {
            finalStatus = 'APPROVED';
          } else if (decision === 'REJECT') {
            finalStatus = 'REJECTED';
          }
          break;
          
        case 'ANY_PARTNER':
          if (decision === 'APPROVE') {
            finalStatus = 'APPROVED';
          }
          break;
          
        case 'ALL_PARTNERS':
          const totalApprovers = (policy.approvers as any[]).length;
          if (allDecisions.length >= totalApprovers) {
            const hasReject = allDecisions.some(d => d.decision === 'REJECT');
            finalStatus = hasReject ? 'REJECTED' : 'APPROVED';
          }
          break;
          
        case 'MAJORITY':
          const approveCount = allDecisions.filter(d => d.decision === 'APPROVE').length;
          const rejectCount = allDecisions.filter(d => d.decision === 'REJECT').length;
          if (approveCount > allDecisions.length / 2) {
            finalStatus = 'APPROVED';
          } else if (rejectCount >= allDecisions.length / 2) {
            finalStatus = 'REJECTED';
          }
          break;
      }
    } else {
      // Default: single approver mode
      if (decision === 'APPROVE') {
        finalStatus = 'APPROVED';
      } else if (decision === 'REJECT') {
        finalStatus = 'REJECTED';
      }
    }

    // Update request status
    const updatedRequest = await prisma.approvalRequest.update({
      where: { id },
      data: { status: finalStatus }
    });

    // If approved, update the entity status
    if (finalStatus === 'APPROVED') {
      switch (request.entityType) {
        case 'CONTRACT':
          await prisma.contract.update({
            where: { id: request.entityId },
            data: { status: 'ACTIVE' }
          });
          break;
        case 'EXPENSE':
          await prisma.expense.update({
            where: { id: request.entityId },
            data: { status: 'APPROVED' }
          });
          break;
        case 'ADDENDUM':
          await prisma.contractAddendum.update({
            where: { id: request.entityId },
            data: { status: 'APPROVED' }
          });
          break;
      }
    }

    return c.json({ 
      data: {
        request: updatedRequest,
        message: `Request ${finalStatus.toLowerCase()}`
      }
    });
  }
);

// Create approval policy
approvalsRouter.post('/policies',
  checkRole('OWNER', 'ADMIN'),
  validateJsonBody(z.object({
    entityType: z.string(),
    condition: z.record(z.any()).optional(),
    approvalMode: z.enum(['SINGLE_APPROVER', 'ANY_PARTNER', 'ALL_PARTNERS', 'MAJORITY', 'SEQUENTIAL']),
    approvers: z.array(z.string()),
    level: z.number().int().positive().default(1),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const body = c.req.valid('json');

    const policy = await prisma.approvalPolicy.create({
      data: {
        ...body,
        orgId: user.orgId,
      }
    });

    return c.json({ data: policy }, 201);
  }
);

export { approvalsRouter };
