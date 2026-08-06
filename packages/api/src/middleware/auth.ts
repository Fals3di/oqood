import { Context, Next } from 'hono';
import { jwtVerify } from 'hono/jwt';
import { prisma, UserRole } from '@uqood/database';
import { OrgContext } from '../types/context';

/**
 * Authentication Middleware
 * Verifies JWT token and attaches organization context to request
 * Reference: SRS v1.1 Section 4 (Security)
 */

export const authMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({
      success: false,
      error: 'Unauthorized: Missing or invalid authorization header'
    }, 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    // Verify JWT token
    const verified = await jwtVerify(token, process.env.JWT_SECRET || 'fallback-secret');

    const userId = verified.payload.sub;
    const orgId = verified.payload.org as string;

    if (!userId || !orgId) {
      throw new Error('Invalid token payload');
    }

    // Fetch user from database to ensure they still exist and are active
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        partnerships: {
          where: { orgId, status: 'ACTIVE' }
        }
      }
    });

    if (!user) {
      return c.json({
        success: false,
        error: 'User not found'
      }, 401);
    }

    if (user.status !== 'ACTIVE') {
      return c.json({
        success: false,
        error: 'User account is inactive'
      }, 401);
    }

    // Check if user has access to this organization
    let role: UserRole = user.role;
    let partnership = null;

    // If user is a partner, get their specific role and scope
    if (user.partnerships.length > 0) {
      partnership = user.partnerships[0];
      role = partnership.role;
    }

    // Create organization context
    const context: OrgContext = {
      userId: user.id,
      orgId,
      userRole: role,
      userEmail: user.email,
      userName: user.name
    };

    // Attach context to request
    c.set('context', context);

    await next();
  } catch (error) {
    console.error('[Auth Error]', error);
    return c.json({
      success: false,
      error: 'Unauthorized: Invalid token'
    }, 401);
  }
};

/**
 * Role-based access control middleware
 * @param allowedRoles - Array of roles that can access the endpoint
 */
export const rbacMiddleware = (allowedRoles: UserRole[]) => {
  return async (c: Context, next: Next) => {
    const context = c.get('context') as OrgContext;

    if (!context) {
      return c.json({
        success: false,
        error: 'Authentication required'
      }, 401);
    }

    if (!allowedRoles.includes(context.userRole as UserRole)) {
      return c.json({
        success: false,
        error: 'Forbidden: Insufficient permissions'
      }, 403);
    }

    await next();
  };
};

/**
 * Owner-only middleware for critical operations
 */
export const ownerOnlyMiddleware = rbacMiddleware(['OWNER']);

/**
 * Admin or Owner middleware
 */
export const adminOrOwnerMiddleware = rbacMiddleware(['ADMIN', 'OWNER']);
