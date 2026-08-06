import { Context, Next } from 'hono';
import { prisma } from '@uqood/database';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'uqood-secret-key-change-in-production';

export interface UserContext {
  userId: string;
  orgId: string;
  role: string;
}

export const authMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as UserContext;
    
    // Verify user still exists and is active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { organization: true }
    });

    if (!user || user.organization.plan === 'SUSPENDED') {
      return c.json({ error: 'Unauthorized: User not found or account suspended' }, 401);
    }

    // Attach user context to request
    c.set('user', decoded);
    
    await next();
  } catch (error) {
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }
};

export const generateToken = (userId: string, orgId: string, role: string): string => {
  return jwt.sign(
    { userId, orgId, role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

export const checkRole = (...allowedRoles: string[]) => {
  return async (c: Context, next: Next) => {
    const user = c.get('user') as UserContext;
    
    if (!user || !allowedRoles.includes(user.role)) {
      return c.json({ error: 'Forbidden: Insufficient permissions' }, 403);
    }
    
    await next();
  };
};

export const checkOrgAccess = async (c: Context, next: Next) => {
  const user = c.get('user') as UserContext;
  const orgIdFromParams = c.req.param('orgId');
  
  if (orgIdFromParams && orgIdFromParams !== user.orgId) {
    // Check if user has access to this organization via partnerships
    const partnership = await prisma.partnership.findFirst({
      where: {
        userId: user.userId,
        orgId: orgIdFromParams,
        status: 'ACTIVE'
      }
    });
    
    if (!partnership) {
      return c.json({ error: 'Forbidden: Access denied to this organization' }, 403);
    }
  }
  
  await next();
};
