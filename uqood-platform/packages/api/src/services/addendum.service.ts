import { prisma } from '@uqood/database';
import type { ChangeType, ApprovalStatus } from '@prisma/client';

interface CreateAddendumData {
  contractId: string;
  changeType: ChangeType;
  oldValues: Record<string, any>;
  newValues: Record<string, any>;
  effectiveDate: Date;
  reason?: string;
  documentFile?: string;
  submittedBy: string;
  orgId: string;
}

/**
 * Addendum Service - Manages contract modifications
 * Implements immutable contract principle from SRS v1.1 section 3.1.4
 */
export class AddendumService {
  /**
   * Create a new addendum for an active contract
   * Original contract remains unchanged (immutable)
   */
  async createAddendum(data: CreateAddendumData): Promise<any> {
    const { 
      contractId, 
      changeType, 
      oldValues, 
      newValues, 
      effectiveDate, 
      reason, 
      documentFile,
      submittedBy,
      orgId 
    } = data;

    // Verify contract exists and is active
    const contract = await prisma.contract.findFirst({
      where: { id: contractId, orgId },
      include: { addendums: true },
    });

    if (!contract) {
      throw new Error('Contract not found');
    }

    if (contract.status !== 'ACTIVE' && contract.status !== 'PENDING_APPROVAL') {
      throw new Error('Can only create addendums for active or pending contracts');
    }

    // Get next addendum number
    const addendumNumber = contract.addendums.length + 1;

    // Create addendum in PENDING status
    const addendum = await prisma.contractAddendum.create({
      data: {
        contractId,
        addendumNumber,
        changeType,
        oldValues: oldValues as any,
        newValues: newValues as any,
        effectiveDate,
        reason,
        documentFile,
        status: 'PENDING',
      },
    });

    // Create approval request for the addendum
    const { approvalService } = await import('./approval.service');
    
    try {
      const requestId = await approvalService.createApprovalRequest({
        orgId,
        entityType: 'ADDENDUM',
        entityId: addendum.id,
        submittedBy,
      });

      return {
        ...addendum,
        approvalRequestId: requestId,
      };
    } catch (error: any) {
      if (error.message === 'NO_POLICY_REQUIRED') {
        // Auto-approve if no policy
        await this.approveAddendum(addendum.id);
        return {
          ...addendum,
          autoApproved: true,
        };
      }
      throw error;
    }
  }

  /**
   * Approve an addendum and apply changes
   */
  async approveAddendum(addendumId: string): Promise<void> {
    const addendum = await prisma.contractAddendum.findUnique({
      where: { id: addendumId },
      include: { contract: true },
    });

    if (!addendum) {
      throw new Error('Addendum not found');
    }

    if (addendum.status !== 'PENDING') {
      throw new Error('Addendum already processed');
    }

    // Update addendum status
    await prisma.contractAddendum.update({
      where: { id: addendumId },
      data: { status: 'APPROVED' },
    });

    // Apply changes based on change type
    await this.applyAddendumChanges(addendum);
  }

  /**
   * Apply addendum changes to create effective version
   * Does NOT modify original contract data
   */
  private async applyAddendumChanges(addendum: any): Promise<void> {
    const { contractId, changeType, newValues, effectiveDate } = addendum;

    switch (changeType) {
      case 'VALUE':
        // Update contract total value
        await prisma.contract.update({
          where: { id: contractId },
          data: {
            totalValue: newValues.totalValue,
            currency: newValues.currency || undefined,
          },
        });

        // Reschedule future payments only (not paid ones)
        await this.reschedulePayments(contractId, effectiveDate, newValues);
        break;

      case 'DURATION':
        // Update contract dates
        await prisma.contract.update({
          where: { id: contractId },
          data: {
            startDate: newValues.startDate ? new Date(newValues.startDate) : undefined,
            endDate: newValues.endDate ? new Date(newValues.endDate) : undefined,
            autoRenew: newValues.autoRenew ?? undefined,
          },
        });
        break;

      case 'CLAUSES':
        // Add or update clauses
        if (newValues.clauses) {
          for (const clause of newValues.clauses) {
            await prisma.contractClause.upsert({
              where: { id: clause.id || `temp_${Math.random()}` },
              create: {
                contractId,
                clauseType: clause.clauseType,
                baseData: clause.baseData,
                customFields: clause.customFields,
                order: clause.order,
              },
              update: {
                clauseType: clause.clauseType,
                baseData: clause.baseData,
                customFields: clause.customFields,
                order: clause.order,
              },
            });
          }
        }
        break;

      case 'PARTIES':
        // Add or update parties
        if (newValues.parties) {
          for (const party of newValues.parties) {
            await prisma.contractParty.upsert({
              where: { id: party.id || `temp_${Math.random()}` },
              create: {
                contractId,
                partyType: party.partyType,
                name: party.name,
                taxNumber: party.taxNumber,
                contactInfo: party.contactInfo,
                rating: party.rating,
                role: party.role,
              },
              update: {
                partyType: party.partyType,
                name: party.name,
                taxNumber: party.taxNumber,
                contactInfo: party.contactInfo,
                rating: party.rating,
                role: party.role,
              },
            });
          }
        }
        break;

      case 'OTHER':
        // Handle other changes via metadata
        await prisma.contract.update({
          where: { id: contractId },
          data: {
            customFields: {
              ...(contract.customFields as any),
              ...newValues.customFields,
            },
          },
        });
        break;
    }

    // Create ledger entry for financial impact
    if (changeType === 'VALUE' && newValues.adjustmentAmount) {
      await prisma.ledgerEntry.create({
        data: {
          orgId: (await prisma.contract.findUnique({ 
            where: { id: contractId },
            select: { orgId: true }
          }))!.orgId!,
          entryType: 'ADDENDUM_ADJUSTMENT',
          amount: Math.abs(newValues.adjustmentAmount),
          currency: newValues.currency || 'SAR',
          sourceEntity: 'ADDENDUM',
          sourceId: addendum.id,
          createdBy: 'SYSTEM',
          metadata: {
            changeType,
            description: `Contract value adjustment via Addendum #${addendum.addendumNumber}`,
            effectiveDate: effectiveDate.toISOString(),
          },
        },
      });
    }
  }

  /**
   * Reschedule payments after value/duration change
   * Only affects future payments (after effective date)
   * Paid payments remain untouched (no retroactive effect)
   */
  private async reschedulePayments(
    contractId: string,
    effectiveDate: Date,
    newValues: Record<string, any>
  ): Promise<void> {
    // Get all unpaid payments after effective date
    const futurePayments = await prisma.paymentSchedule.findMany({
      where: {
        contractId,
        dueDate: { gte: effectiveDate },
        status: { not: 'PAID' },
      },
    });

    if (futurePayments.length === 0) {
      return;
    }

    // Calculate new payment amounts based on new total value
    const newTotalValue = Number(newValues.totalValue);
    const totalFutureAmount = futurePayments.reduce((sum, p) => sum + Number(p.amount), 0);

    if (totalFutureAmount === 0) {
      return;
    }

    const ratio = newTotalValue / totalFutureAmount;

    // Update each future payment proportionally
    for (const payment of futurePayments) {
      await prisma.paymentSchedule.update({
        where: { id: payment.id },
        data: {
          amount: Number(payment.amount) * ratio,
        },
      });
    }
  }

  /**
   * Get effective version of a contract (original + approved addendums)
   */
  async getEffectiveContract(contractId: string): Promise<any> {
    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
      include: {
        addendums: {
          where: { status: 'APPROVED' },
          orderBy: { addendumNumber: 'asc' },
        },
        parties: true,
        clauses: true,
        paymentSchedule: true,
      },
    });

    if (!contract) {
      throw new Error('Contract not found');
    }

    // Build effective version by applying addendums
    let effectiveData = {
      ...contract,
      baseData: { ...contract.baseData },
      customFields: { ...contract.customFields },
    };

    for (const addendum of contract.addendums) {
      if (addendum.changeType === 'VALUE') {
        effectiveData.totalValue = addendum.newValues.totalValue;
      } else if (addendum.changeType === 'DURATION') {
        if (addendum.newValues.startDate) {
          effectiveData.startDate = new Date(addendum.newValues.startDate);
        }
        if (addendum.newValues.endDate) {
          effectiveData.endDate = new Date(addendum.newValues.endDate);
        }
      }
      // Apply other changes as needed
    }

    return effectiveData;
  }

  /**
   * Get addendum history for a contract
   */
  async getAddendumHistory(contractId: string): Promise<any[]> {
    return prisma.contractAddendum.findMany({
      where: { contractId },
      orderBy: { addendumNumber: 'asc' },
      include: {
        contract: {
          select: {
            contractNumber: true,
            title: true,
          },
        },
      },
    });
  }

  /**
   * Compare two versions of a contract
   */
  async compareVersions(
    contractId: string,
    version1: number,
    version2: number
  ): Promise<{ differences: Record<string, any> }> {
    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
      include: {
        addendums: {
          orderBy: { addendumNumber: 'asc' },
        },
      },
    });

    if (!contract) {
      throw new Error('Contract not found');
    }

    // Get state at version 1
    const state1 = version1 === 0 
      ? contract 
      : await this.getVersionAtPoint(contract, version1);

    // Get state at version 2
    const state2 = version2 === 0
      ? contract
      : await this.getVersionAtPoint(contract, version2);

    // Compare states
    const differences: Record<string, any> = {};

    if (state1.totalValue !== state2.totalValue) {
      differences.totalValue = {
        before: state1.totalValue,
        after: state2.totalValue,
      };
    }

    if (state1.startDate?.toISOString() !== state2.startDate?.toISOString()) {
      differences.startDate = {
        before: state1.startDate,
        after: state2.startDate,
      };
    }

    if (state1.endDate?.toISOString() !== state2.endDate?.toISOString()) {
      differences.endDate = {
        before: state1.endDate,
        after: state2.endDate,
      };
    }

    return { differences };
  }

  /**
   * Get contract state at a specific addendum version
   */
  private async getVersionAtPoint(contract: any, version: number): Promise<any> {
    const addendums = contract.addendums.slice(0, version);
    
    let state = { ...contract };

    for (const addendum of addendums) {
      if (addendum.status !== 'APPROVED') continue;

      if (addendum.changeType === 'VALUE') {
        state.totalValue = addendum.newValues.totalValue;
      } else if (addendum.changeType === 'DURATION') {
        if (addendum.newValues.startDate) {
          state.startDate = new Date(addendum.newValues.startDate);
        }
        if (addendum.newValues.endDate) {
          state.endDate = new Date(addendum.newValues.endDate);
        }
      }
    }

    return state;
  }
}

export const addendumService = new AddendumService();
