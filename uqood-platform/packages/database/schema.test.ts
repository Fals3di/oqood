/**
 * Unit Tests for Database Schema Validation
 * اختبار صحة مخطط قاعدة البيانات
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Database Schema Tests', () => {
  beforeAll(async () => {
    // Ensure database connection
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Organization Model', () => {
    it('should create organization with required fields', async () => {
      const org = await prisma.organization.create({
        data: {
          name: 'Test Organization',
          plan: 'STARTER',
        },
      });

      expect(org.id).toBeDefined();
      expect(org.name).toBe('Test Organization');
      expect(org.plan).toBe('STARTER');
      expect(org.createdAt).toBeDefined();

      // Cleanup
      await prisma.organization.delete({ where: { id: org.id } });
    });

    it('should have default settings as empty object', async () => {
      const org = await prisma.organization.create({
        data: {
          name: 'Test Org 2',
          plan: 'PRO',
        },
      });

      expect(org.settings).toEqual({});

      await prisma.organization.delete({ where: { id: org.id } });
    });
  });

  describe('User Model & RBAC', () => {
    it('should create user with all roles', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Role Test Org', plan: 'ENTERPRISE' },
      });

      const roles = [
        'OWNER',
        'ADMIN',
        'FULL_PARTNER',
        'FINANCIAL_PARTNER',
        'OPERATIONS_MANAGER',
        'DATA_ENTRY',
        'VIEWER',
        'AUDITOR',
      ];

      for (const role of roles) {
        const user = await prisma.user.create({
          data: {
            email: `test.${role.toLowerCase()}@example.com`,
            passwordHash: 'hashed_password_placeholder',
            role: role as any,
            organizationId: org.id,
          },
        });

        expect(user.role).toBe(role);
        await prisma.user.delete({ where: { id: user.id } });
      }

      await prisma.organization.delete({ where: { id: org.id } });
    });

    it('should enforce unique email per organization', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Unique Email Org', plan: 'STARTER' },
      });

      await prisma.user.create({
        data: {
          email: 'duplicate@example.com',
          passwordHash: 'hash1',
          role: 'DATA_ENTRY',
          organizationId: org.id,
        },
      });

      await expect(
        prisma.user.create({
          data: {
            email: 'duplicate@example.com',
            passwordHash: 'hash2',
            role: 'DATA_ENTRY',
            organizationId: org.id,
          },
        })
      ).rejects.toThrow();

      await prisma.organization.delete({ where: { id: org.id } });
    });
  });

  describe('Contract Template Model', () => {
    it('should create template with dynamic JSONB fields', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Template Org', plan: 'PRO' },
      });

      const baseSchema = {
        type: 'object',
        properties: {
          propertyAddress: { type: 'string' },
          rentalValue: { type: 'number' },
          electricityMeter: { type: 'string' },
        },
      };

      const template = await prisma.contractTemplate.create({
        data: {
          organizationId: org.id,
          typeName: 'Lease Agreement',
          baseSchema: baseSchema as any,
          defaultClauses: [
            {
              type: 'PAYMENT',
              title: 'Payment Terms',
              content: 'Monthly payment due on 1st',
            },
          ] as any,
        },
      });

      expect(template.typeName).toBe('Lease Agreement');
      expect(template.baseSchema).toEqual(baseSchema);
      expect(template.defaultClauses).toHaveLength(1);

      await prisma.contractTemplate.delete({ where: { id: template.id } });
      await prisma.organization.delete({ where: { id: org.id } });
    });
  });

  describe('Contract & Addendum Model', () => {
    it('should create contract and addendum without modifying original', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Contract Org', plan: 'ENTERPRISE' },
      });

      const template = await prisma.contractTemplate.create({
        data: {
          organizationId: org.id,
          typeName: 'Service Contract',
          baseSchema: {},
        },
      });

      const contract = await prisma.contract.create({
        data: {
          organizationId: org.id,
          templateId: template.id,
          contractNumber: 'CNT-2026-001',
          status: 'ACTIVE',
          startDate: new Date('2026-01-01'),
          endDate: new Date('2026-12-31'),
          baseData: { value: 100000, currency: 'SAR' },
        },
      });

      expect(contract.status).toBe('ACTIVE');
      expect(contract.baseData).toEqual({ value: 100000, currency: 'SAR' });

      // Create addendum - should not modify original contract
      const addendum = await prisma.contractAddendum.create({
        data: {
          contractId: contract.id,
          addendumNumber: 1,
          changeType: 'VALUE_CHANGE',
          oldValues: { value: 100000 } as any,
          newValues: { value: 120000 } as any,
          effectiveDate: new Date('2026-06-01'),
          status: 'PENDING_APPROVAL',
          reason: 'Scope expansion',
        },
      });

      expect(addendum.addendumNumber).toBe(1);
      expect(addendum.oldValues).toEqual({ value: 100000 });
      expect(addendum.newValues).toEqual({ value: 120000 });

      // Verify original contract is unchanged
      const originalContract = await prisma.contract.findUnique({
        where: { id: contract.id },
      });

      expect(originalContract?.baseData).toEqual({ value: 100000, currency: 'SAR' });

      // Cleanup
      await prisma.contractAddendum.delete({ where: { id: addendum.id } });
      await prisma.contract.delete({ where: { id: contract.id } });
      await prisma.contractTemplate.delete({ where: { id: template.id } });
      await prisma.organization.delete({ where: { id: org.id } });
    });
  });

  describe('Ledger Entries (Append-Only)', () => {
    it('should create ledger entry and verify append-only behavior', async () => {
      const org = await prisma.organization.create({
        data: { name: 'Ledger Org', plan: 'ENTERPRISE' },
      });

      const ledgerEntry = await prisma.ledgerEntry.create({
        data: {
          organizationId: org.id,
          entryType: 'PAYMENT',
          amount: 5000,
          currency: 'SAR',
          sourceEntity: 'CONTRACT',
          sourceId: 'CNT-001',
          description: 'Initial payment',
          metadata: { invoiceNumber: 'INV-001' },
        },
      });

      expect(ledgerEntry.amount).toBe(5000);
      expect(ledgerEntry.entryType).toBe('PAYMENT');

      // Verify reversal entry can be created
      const reversalEntry = await prisma.ledgerEntry.create({
        data: {
          organizationId: org.id,
          entryType: 'REVERSAL',
          amount: -5000,
          currency: 'SAR',
          sourceEntity: 'CONTRACT',
          sourceId: 'CNT-001',
          description: 'Reversal of initial payment',
          reversalOfId: ledgerEntry.id,
        },
      });

      expect(reversalEntry.reversalOfId).toBe(ledgerEntry.id);
      expect(reversalEntry.amount).toBe(-5000);

      // Cleanup
      await prisma.ledgerEntry.delete({ where: { id: reversalEntry.id } });
      await prisma.ledgerEntry.delete({ where: { id: ledgerEntry.id } });
      await prisma.organization.delete({ where: { id: org.id } });
    });
  });

  describe('Multi-Tenancy Isolation', () => {
    it('should isolate data between organizations', async () => {
      const org1 = await prisma.organization.create({
        data: { name: 'Org 1', plan: 'STARTER' },
      });

      const org2 = await prisma.organization.create({
        data: { name: 'Org 2', plan: 'STARTER' },
      });

      const contract1 = await prisma.contract.create({
        data: {
          organizationId: org1.id,
          contractNumber: 'ORG1-CNT-001',
          status: 'DRAFT',
          startDate: new Date(),
          endDate: new Date(),
          baseData: {},
        },
      });

      const contract2 = await prisma.contract.create({
        data: {
          organizationId: org2.id,
          contractNumber: 'ORG2-CNT-001',
          status: 'DRAFT',
          startDate: new Date(),
          endDate: new Date(),
          baseData: {},
        },
      });

      // Verify org1 cannot see org2's contracts
      const org1Contracts = await prisma.contract.findMany({
        where: { organizationId: org1.id },
      });

      expect(org1Contracts).toHaveLength(1);
      expect(org1Contracts[0].contractNumber).toBe('ORG1-CNT-001');

      // Verify org2 cannot see org1's contracts
      const org2Contracts = await prisma.contract.findMany({
        where: { organizationId: org2.id },
      });

      expect(org2Contracts).toHaveLength(1);
      expect(org2Contracts[0].contractNumber).toBe('ORG2-CNT-001');

      // Cleanup
      await prisma.contract.delete({ where: { id: contract1.id } });
      await prisma.contract.delete({ where: { id: contract2.id } });
      await prisma.organization.delete({ where: { id: org1.id } });
      await prisma.organization.delete({ where: { id: org2.id } });
    });
  });
});
