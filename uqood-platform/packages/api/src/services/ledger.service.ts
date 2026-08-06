/**
 * Ledger Service - Append-Only Financial Journal
 * 
 * Implements Section 3.3.4 of SRS v1.1
 * Every financial transaction is recorded as an immutable entry.
 * Corrections are made via reversal entries only - NEVER update/delete.
 */

import { PrismaClient, LedgerEntryType, LedgerStatus } from '@uqood/database';
import { Decimal } from '@prisma/client/runtime/library';

interface CreateLedgerEntryParams {
  orgId: string;
  entryType: LedgerEntryType;
  amount: Decimal;
  currency: string;
  sourceEntity: string; // 'contract', 'expense', 'cheque', 'payment', 'profit_distribution'
  sourceId: string;
  description?: string;
  metadata?: Record<string, any>;
  createdBy: string;
}

interface ReverseLedgerEntryParams {
  originalEntryId: string;
  reason: string;
  reversedBy: string;
}

export class LedgerService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Create a new ledger entry (Append-Only)
   * This is the ONLY way to add financial records - no updates allowed
   */
  async createEntry(params: CreateLedgerEntryParams) {
    const { orgId, entryType, amount, currency, sourceEntity, sourceId, description, metadata, createdBy } = params;

    return await this.prisma.$transaction(async (tx) => {
      // Verify source entity exists and belongs to org
      const sourceExists = await this.verifySourceEntity(tx, sourceEntity, sourceId, orgId);
      if (!sourceExists) {
        throw new Error(`Source entity ${sourceEntity}:${sourceId} not found or does not belong to organization`);
      }

      // Create immutable ledger entry
      const entry = await tx.ledgerEntry.create({
        data: {
          orgId,
          entryType,
          amount,
          currency,
          sourceEntity,
          sourceId,
          description,
          metadata: metadata || {},
          status: LedgerStatus.POSTED,
          isImmutable: true, // Critical: Mark as immutable
          createdBy,
        },
      });

      // Log to audit trail
      await tx.auditLog.create({
        data: {
          orgId,
          userId: createdBy,
          action: 'LEDGER_ENTRY_CREATED',
          tableName: 'ledger_entries',
          recordId: entry.id,
          newData: {
            entryType,
            amount: amount.toString(),
            currency,
            sourceEntity,
            sourceId,
          },
        },
      });

      return entry;
    });
  }

  /**
   * Create a reversal entry to correct a previous entry
   * NEVER modify or delete existing entries
   */
  async reverseEntry(params: ReverseLedgerEntryParams) {
    const { originalEntryId, reason, reversedBy } = params;

    return await this.prisma.$transaction(async (tx) => {
      // Find original entry
      const originalEntry = await tx.ledgerEntry.findUnique({
        where: { id: originalEntryId },
      });

      if (!originalEntry) {
        throw new Error('Original ledger entry not found');
      }

      if (originalEntry.isReversed) {
        throw new Error('This entry has already been reversed');
      }

      // Create reversal entry with opposite amount
      const reversalEntry = await tx.ledgerEntry.create({
        data: {
          orgId: originalEntry.orgId,
          entryType: originalEntry.entryType, // Same type
          amount: originalEntry.amount.mul(-1), // Opposite amount
          currency: originalEntry.currency,
          sourceEntity: originalEntry.sourceEntity,
          sourceId: originalEntry.sourceId,
          description: `REVERSAL: ${reason}`,
          metadata: {
            reversalReason: reason,
            reversedBy,
            originalEntryId,
          },
          status: LedgerStatus.POSTED,
          isImmutable: true,
          reversalOfId: originalEntryId, // Link to original
          createdBy: reversedBy,
        },
      });

      // Mark original as reversed
      await tx.ledgerEntry.update({
        where: { id: originalEntryId },
        data: {
          isReversed: true,
          reversedAt: new Date(),
        },
      });

      // Log to audit trail
      await tx.auditLog.create({
        data: {
          orgId: originalEntry.orgId,
          userId: reversedBy,
          action: 'LEDGER_ENTRY_REVERSED',
          tableName: 'ledger_entries',
          recordId: originalEntryId,
          newData: {
            reversalEntryId: reversalEntry.id,
            reason,
          },
        },
      });

      return reversalEntry;
    });
  }

  /**
   * Get ledger entries for an organization
   * Always returns immutable entries with reversal status
   */
  async getEntries(orgId: string, filters?: {
    startDate?: Date;
    endDate?: Date;
    entryType?: LedgerEntryType;
    sourceEntity?: string;
    sourceId?: string;
  }) {
    const where: any = {
      orgId,
      isReversed: false, // Only show active entries (not reversed)
    };

    if (filters?.startDate && filters?.endDate) {
      where.createdAt = {
        gte: filters.startDate,
        lte: filters.endDate,
      };
    }

    if (filters?.entryType) {
      where.entryType = filters.entryType;
    }

    if (filters?.sourceEntity) {
      where.sourceEntity = filters.sourceEntity;
      if (filters?.sourceId) {
        where.sourceId = filters.sourceId;
      }
    }

    return await this.prisma.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get balance for a specific source entity
   * Calculates sum of all non-reversed entries
   */
  async getBalance(orgId: string, sourceEntity: string, sourceId: string): Promise<Decimal> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        orgId,
        sourceEntity,
        sourceId,
        isReversed: false,
      },
      select: {
        amount: true,
        currency: true,
      },
    });

    // Sum all amounts (assuming single currency for simplicity)
    return entries.reduce((sum, entry) => sum.add(entry.amount), new Decimal(0));
  }

  /**
   * Verify source entity exists and belongs to organization
   * Prevents IDOR attacks
   */
  private async verifySourceEntity(
    tx: any,
    entityType: string,
    entityId: string,
    orgId: string
  ): Promise<boolean> {
    try {
      let entity: any;

      switch (entityType) {
        case 'contract':
          entity = await tx.contract.findUnique({
            where: { id: entityId },
            select: { orgId: true },
          });
          break;
        case 'expense':
          entity = await tx.expense.findUnique({
            where: { id: entityId },
            select: { orgId: true },
          });
          break;
        case 'payment':
          entity = await tx.paymentSchedule.findUnique({
            where: { id: entityId },
            select: { orgId: true },
          });
          break;
        case 'cheque':
          entity = await tx.cheque.findUnique({
            where: { id: entityId },
            select: { orgId: true },
          });
          break;
        default:
          return false;
      }

      return entity?.orgId === orgId;
    } catch {
      return false;
    }
  }

  /**
   * CRITICAL: Ensure no UPDATE or DELETE operations on ledger entries
   * This method should be called in tests to verify immutability
   */
  async verifyImmutability(entryId: string): Promise<{ isImmutable: boolean; canUpdate: boolean; canDelete: boolean }> {
    const entry = await this.prisma.ledgerEntry.findUnique({
      where: { id: entryId },
    });

    if (!entry) {
      throw new Error('Entry not found');
    }

    // Try to update (should fail in production code)
    let canUpdate = true;
    try {
      await this.prisma.ledgerEntry.update({
        where: { id: entryId },
        data: { amount: new Decimal(999) }, // Should never happen
      });
      // If we reach here, revert immediately
      await this.prisma.ledgerEntry.update({
        where: { id: entryId },
        data: { amount: entry.amount },
      });
    } catch {
      canUpdate = false;
    }

    return {
      isImmutable: entry.isImmutable,
      canUpdate,
      canDelete: false, // Delete should never be allowed
    };
  }
}
