import { Context } from 'hono';

/**
 * Organization Context - Contains authenticated user and org info
 * Used throughout the application for multi-tenant isolation
 */
export interface OrgContext {
  userId: string;
  orgId: string;
  userRole: string;
  userEmail: string;
  userName: string;
}

/**
 * Extract organization context from Hono context
 * Ensures multi-tenant isolation on every request
 */
export function getOrgContext(c: Context): OrgContext {
  const context = c.get('context');
  
  if (!context) {
    throw new Error('Organization context not found. Authentication required.');
  }

  return context as OrgContext;
}

/**
 * Permission checks helper
 */
export const permissions = {
  canViewContracts: (role: string) => 
    ['OWNER', 'ADMIN', 'FULL_PARTNER', 'OPERATIONS_MANAGER', 'DATA_ENTRY'].includes(role),
  
  canEditContracts: (role: string) => 
    ['OWNER', 'ADMIN', 'FULL_PARTNER'].includes(role),
  
  canApprove: (role: string) => 
    ['OWNER', 'ADMIN', 'FULL_PARTNER'].includes(role),
  
  canViewFinancials: (role: string) => 
    ['OWNER', 'ADMIN', 'FULL_PARTNER', 'FINANCIAL_PARTNER'].includes(role),
  
  canManagePartners: (role: string) => 
    ['OWNER'].includes(role),
  
  canDelete: (role: string) => 
    ['OWNER'].includes(role)
};
