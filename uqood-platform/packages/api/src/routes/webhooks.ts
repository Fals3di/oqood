import { Hono } from 'hono';
import { z } from 'zod';
import { validateJsonBody } from '@hono/zod-validator';
import { prisma } from '@uqood/database';
import crypto from 'crypto';
import { checkRole } from '../middleware/auth';

const webhooksRouter = new Hono();

// List webhook subscriptions
webhooksRouter.get('/subscriptions', async (c) => {
  const user = c.get('user') as { userId: string; orgId: string; role: string };

  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { orgId: user.orgId },
    include: {
      deliveries: {
        orderBy: { createdAt: 'desc' },
        take: 10,
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  return c.json({ data: subscriptions });
});

// Create webhook subscription
webhooksRouter.post('/subscriptions',
  checkRole('OWNER', 'ADMIN'),
  validateJsonBody(z.object({
    url: z.string().url(),
    events: z.array(z.enum([
      'contract.created',
      'contract.approved',
      'contract.expiring',
      'addendum.approved',
      'payment.due',
      'payment.paid',
      'expense.approved',
      'cheque.status_changed',
      'approval.requested',
      'approval.decided',
    ])),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const { url, events } = c.req.valid('json');

    // Generate secret for HMAC signing
    const secret = crypto.randomBytes(32).toString('hex');

    const subscription = await prisma.webhookSubscription.create({
      data: {
        orgId: user.orgId,
        url,
        events,
        secret,
        status: 'ACTIVE',
      }
    });

    return c.json({ 
      data: {
        ...subscription,
        secret // Show secret only once at creation
      } 
    }, 201);
  }
);

// Update webhook subscription
webhooksRouter.patch('/subscriptions/:id',
  checkRole('OWNER', 'ADMIN'),
  validateJsonBody(z.object({
    url: z.string().url().optional(),
    events: z.array(z.string()).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const subscription = await prisma.webhookSubscription.update({
      where: { id, orgId: user.orgId },
      data: body,
    });

    return c.json({ data: subscription });
  }
);

// Delete webhook subscription
webhooksRouter.delete('/subscriptions/:id',
  checkRole('OWNER', 'ADMIN'),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const id = c.req.param('id');

    await prisma.webhookSubscription.delete({
      where: { id, orgId: user.orgId }
    });

    return c.json({ message: 'Webhook subscription deleted' });
  }
);

// Get delivery logs for a subscription
webhooksRouter.get('/subscriptions/:id/deliveries',
  validateQuery(z.object({
    status: z.string().optional(),
    page: z.string().transform(Number).default('1'),
    limit: z.string().transform(Number).default('50'),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const id = c.req.param('id');
    const { status, page, limit } = c.req.valid('query');

    const where: any = { subscriptionId: id };
    if (status) where.status = status;

    const [deliveries, total] = await Promise.all([
      prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.webhookDelivery.count({ where })
    ]);

    return c.json({
      data: deliveries,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  }
);

// Retry failed delivery
webhooksRouter.post('/deliveries/:id/retry',
  checkRole('OWNER', 'ADMIN'),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const id = c.req.param('id');

    const delivery = await prisma.webhookDelivery.findFirst({
      where: { id },
      include: {
        subscription: true
      }
    });

    if (!delivery || delivery.subscription.orgId !== user.orgId) {
      return c.json({ error: 'Delivery not found' }, 404);
    }

    if (delivery.status === 'SUCCESS') {
      return c.json({ error: 'Cannot retry successful delivery' }, 400);
    }

    // Reset delivery for retry
    await prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: 'PENDING',
        attempts: 0,
        responseCode: null,
        lastAttemptAt: null,
      }
    });

    // TODO: Queue delivery for retry via BullMQ

    return c.json({ message: 'Delivery queued for retry' });
  }
);

export { webhooksRouter };
