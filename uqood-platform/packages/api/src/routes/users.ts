import { Hono } from 'hono';
import { z } from 'zod';
import { validateJsonBody, validateQuery } from '@hono/zod-validator';
import { prisma } from '@uqood/database';
import bcrypt from 'bcryptjs';
import { generateToken, checkRole } from '../middleware/auth';

const usersRouter = new Hono();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['OWNER', 'ADMIN', 'FULL_PARTNER', 'FINANCIAL_PARTNER', 'OPERATIONS_MANAGER', 'DATA_ENTRY', 'VIEWER', 'AUDITOR']),
});

// Login
usersRouter.post('/login',
  validateJsonBody(loginSchema),
  async (c) => {
    const { email, password } = c.req.valid('json');

    const user = await prisma.user.findFirst({
      where: { email },
      include: { organization: true }
    });

    if (!user) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const token = generateToken(user.id, user.orgId, user.role);

    return c.json({
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          orgId: user.orgId,
        },
        token,
      }
    });
  }
);

// Register new organization and owner
usersRouter.post('/register',
  validateJsonBody(z.object({
    email: z.string().email(),
    password: z.string().min(6),
    organizationName: z.string().min(1),
  })),
  async (c) => {
    const { email, password, organizationName } = c.req.valid('json');

    // Check if user exists
    const existing = await prisma.user.findFirst({
      where: { email }
    });

    if (existing) {
      return c.json({ error: 'Email already registered' }, 400);
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Create organization and owner in transaction
    const result = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: organizationName,
          plan: 'FREE',
        }
      });

      const user = await tx.user.create({
        data: {
          orgId: org.id,
          email,
          password: hashedPassword,
          role: 'OWNER',
        }
      });

      return { org, user };
    });

    const token = generateToken(result.user.id, result.org.id, 'OWNER');

    return c.json({
      data: {
        user: {
          id: result.user.id,
          email: result.user.email,
          role: 'OWNER',
          orgId: result.org.id,
        },
        organization: {
          id: result.org.id,
          name: result.org.name,
          plan: result.org.plan,
        },
        token,
      }
    }, 201);
  }
);

// Get current user profile
usersRouter.get('/me', async (c) => {
  const user = c.get('user') as { userId: string; orgId: string; role: string };

  const userData = await prisma.user.findUnique({
    where: { id: user.userId },
    include: {
      organization: true,
      partnerships: true,
    }
  });

  if (!userData) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({
    data: {
      id: userData.id,
      email: userData.email,
      role: userData.role,
      organization: userData.organization,
      partnerships: userData.partnerships,
    }
  });
});

// List users in organization
usersRouter.get('/',
  checkRole('OWNER', 'ADMIN'),
  validateQuery(z.object({
    role: z.string().optional(),
    page: z.string().transform(Number).default('1'),
    limit: z.string().transform(Number).default('20'),
  })),
  async (c) => {
    const user = c.get('user') as { userId: string; orgId: string; role: string };
    const { role, page, limit } = c.req.valid('query');

    const where: any = { orgId: user.orgId };
    if (role) where.role = role;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          role: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where })
    ]);

    return c.json({
      data: users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  }
);

// Create user in organization
usersRouter.post('/',
  checkRole('OWNER', 'ADMIN'),
  validateJsonBody(createUserSchema),
  async (c) => {
    const currentUser = c.get('user') as { userId: string; orgId: string; role: string };
    const { email, password, role } = c.req.valid('json');

    const existing = await prisma.user.findFirst({
      where: { email, orgId: currentUser.orgId }
    });

    if (existing) {
      return c.json({ error: 'Email already exists in this organization' }, 400);
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        orgId: currentUser.orgId,
        email,
        password: hashedPassword,
        role,
      },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
      }
    });

    return c.json({ data: user }, 201);
  }
);

export { usersRouter };
