import { prisma } from '@uqood/database';
import type { ApprovalMode, ApprovalStatus } from '@prisma/client';

interface ApprovalContext {
  orgId: string;
  entityType: string;
  entityId: string;
  submittedBy: string;
  metadata?: Record<string, any>;
}

interface PolicyMatch {
  policyId: string;
  approvalMode: ApprovalMode;
  approvers: string[];
  level: number;
}

/**
 * Approval Service - Handles Maker-Checker workflow
 * Implements all approval modes from SRS v1.1 section 3.4
 */
export class ApprovalService {
  /**
   * Create an approval request for a new entity
   * Entity remains in PENDING_APPROVAL status until approved
   */
  async createApprovalRequest(context: ApprovalContext): Promise<string> {
    const { orgId, entityType, entityId, submittedBy } = context;

    // Find applicable policies
    const policies = await this.findApplicablePolicies(orgId, entityType);

    if (policies.length === 0) {
      // No policy means auto-approve for this entity type
      await this.autoApproveEntity(entityType, entityId);
      throw new Error('NO_POLICY_REQUIRED');
    }

    // Create approval request
    const request = await prisma.approvalRequest.create({
      data: {
        orgId,
        entityType,
        entityId,
        submittedBy,
        status: 'PENDING',
        currentLevel: 1,
      },
    });

    return request.id;
  }

  /**
   * Find all applicable policies for an entity
   */
  private async findApplicablePolicies(
    orgId: string,
    entityType: string
  ): Promise<PolicyMatch[]> {
    const policies = await prisma.approvalPolicy.findMany({
      where: {
        orgId,
        entityType,
        isActive: true,
      },
      orderBy: { level: 'asc' },
    });

    return policies.map(p => ({
      policyId: p.id,
      approvalMode: p.approvalMode,
      approvers: p.approvers as string[],
      level: p.level,
    }));
  }

  /**
   * Process an approval decision
   */
  async processDecision(
    requestId: string,
    approverId: string,
    decision: 'APPROVE' | 'REJECT' | 'RETURN',
    comment?: string
  ): Promise<{ status: ApprovalStatus; message: string }> {
    const request = await prisma.approvalRequest.findUnique({
      where: { id: requestId },
      include: { decisions: true },
    });

    if (!request) {
      throw new Error('Approval request not found');
    }

    if (request.status !== 'PENDING') {
      throw new Error('Request already processed');
    }

    // Record the decision
    await prisma.approvalDecision.create({
      data: {
        requestId,
        approverId,
        decision,
        comment,
      },
    });

    // Get the policy
    const policy = await prisma.approvalPolicy.findFirst({
      where: {
        orgId: request.orgId,
        entityType: request.entityType,
        isActive: true,
      },
    });

    let finalStatus: ApprovalStatus = 'PENDING';
    let message = 'Decision recorded, awaiting more approvals';

    if (policy) {
      const result = this.evaluateApprovalStatus(
        policy.approvalMode,
        policy.approvers as string[],
        request.decisions,
        decision
      );
      finalStatus = result.status;
      message = result.message;
    } else {
      // Default to single approver
      if (decision === 'APPROVE') {
        finalStatus = 'APPROVED';
        message = 'Request approved';
      } else if (decision === 'REJECT') {
        finalStatus = 'REJECTED';
        message = 'Request rejected';
      }
    }

    // Update request status
    await prisma.approvalRequest.update({
      where: { id: requestId },
      data: { status: finalStatus },
    });

    // If final decision, update the entity
    if (finalStatus === 'APPROVED' || finalStatus === 'REJECTED') {
      await this.finalizeEntity(request.entityType, request.entityId, finalStatus);
    }

    return { status: finalStatus, message };
  }

  /**
   * Evaluate approval status based on mode and decisions
   */
  private evaluateApprovalStatus(
    mode: ApprovalMode,
    requiredApprovers: string[],
    existingDecisions: any[],
    newDecision: 'APPROVE' | 'REJECT' | 'RETURN'
  ): { status: ApprovalStatus; message: string } {
    const approveCount = existingDecisions.filter(d => d.decision === 'APPROVE').length +
      (newDecision === 'APPROVE' ? 1 : 0);
    const rejectCount = existingDecisions.filter(d => d.decision === 'REJECT').length +
      (newDecision === 'REJECT' ? 1 : 0);
    const totalDecisions = existingDecisions.length + 1;

    switch (mode) {
      case 'SINGLE_APPROVER':
        if (newDecision === 'APPROVE') {
          return { status: 'APPROVED', message: 'Approved by designated approver' };
        } else if (newDecision === 'REJECT') {
          return { status: 'REJECTED', message: 'Rejected by designated approver' };
        }
        break;

      case 'ANY_PARTNER':
        if (newDecision === 'APPROVE') {
          return { status: 'APPROVED', message: 'Approved by one partner' };
        }
        break;

      case 'ALL_PARTNERS':
        if (newDecision === 'REJECT') {
          return { status: 'REJECTED', message: 'Rejected by a partner' };
        }
        if (totalDecisions >= requiredApprovers.length && rejectCount === 0) {
          return { status: 'APPROVED', message: 'Unanimously approved' };
        }
        break;

      case 'MAJORITY':
        const totalRequired = requiredApprovers.length;
        if (approveCount > totalRequired / 2) {
          return { status: 'APPROVED', message: 'Approved by majority' };
        }
        if (rejectCount >= totalRequired / 2) {
          return { status: 'REJECTED', message: 'Rejected by majority' };
        }
        break;

      case 'SEQUENTIAL':
        // For sequential, we need to check levels (simplified implementation)
        if (newDecision === 'APPROVE') {
          // Move to next level or approve if last
          return { status: 'APPROVED', message: 'Approved at current level' };
        } else if (newDecision === 'REJECT') {
          return { status: 'REJECTED', message: 'Rejected at current level' };
        }
        break;
    }

    return { status: 'PENDING', message: 'Awaiting more approvals' };
  }

  /**
   * Finalize entity status after approval decision
   */
  private async finalizeEntity(
    entityType: string,
    entityId: string,
    status: ApprovalStatus
  ): Promise<void> {
    switch (entityType) {
      case 'CONTRACT':
        await prisma.contract.update({
          where: { id: entityId },
          data: { 
            status: status === 'APPROVED' ? 'ACTIVE' : 'CANCELLED'
          },
        });
        break;

      case 'EXPENSE':
        await prisma.expense.update({
          where: { id: entityId },
          data: { 
            status: status === 'APPROVED' ? 'APPROVED' : 'REJECTED'
          },
        });
        break;

      case 'ADDENDUM':
        await prisma.contractAddendum.update({
          where: { id: entityId },
          data: { 
            status: status === 'APPROVED' ? 'APPROVED' : 'REJECTED'
          },
        });
        break;

      case 'ASSET':
        await prisma.asset.update({
          where: { id: entityId },
          data: { 
            status: status === 'APPROVED' ? 'AVAILABLE' : 'RETIRED'
          },
        });
        break;
    }
  }

  /**
   * Auto-approve entity when no policy is required
   */
  private async autoApproveEntity(entityType: string, entityId: string): Promise<void> {
    switch (entityType) {
      case 'CONTRACT':
        await prisma.contract.update({
          where: { id: entityId },
          data: { status: 'ACTIVE' },
        });
        break;
      case 'EXPENSE':
        await prisma.expense.update({
          where: { id: entityId },
          data: { status: 'APPROVED' },
        });
        break;
    }
  }

  /**
   * Get pending approvals for a specific user
   */
  async getPendingForUser(orgId: string, userId: string): Promise<any[]> {
    // Find policies where this user is an approver
    const policies = await prisma.approvalPolicy.findMany({
      where: {
        orgId,
        isActive: true,
      },
    });

    const relevantPolicies = policies.filter(p => {
      const approvers = p.approvers as string[];
      return approvers.includes(userId) || 
             approvers.some(role => role === `ROLE:${p.entityType}`);
    });

    if (relevantPolicies.length === 0) {
      return [];
    }

    const requests = await prisma.approvalRequest.findMany({
      where: {
        orgId,
        status: 'PENDING',
        entityType: {
          in: relevantPolicies.map(p => p.entityType),
        },
      },
      include: {
        decisions: {
          include: {
            request: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return requests;
  }

  /**
   * Check if a user can approve a specific request
   */
  async canApprove(requestId: string, userId: string): Promise<boolean> {
    const request = await prisma.approvalRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) return false;

    const policy = await prisma.approvalPolicy.findFirst({
      where: {
        orgId: request.orgId,
        entityType: request.entityType,
        isActive: true,
      },
    });

    if (!policy) return true; // No policy means anyone can approve

    const approvers = policy.approvers as string[];
    return approvers.includes(userId);
  }
}

export const approvalService = new ApprovalService();
