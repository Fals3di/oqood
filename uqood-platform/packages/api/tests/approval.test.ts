import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@uqood/database';

describe('Approval System - Maker-Checker', () => {
  let testOrgId: string;
  let testUserId: string;
  let testApproverId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'Test Org', plan: 'PRO' },
    });
    testOrgId = org.id;

    const user1 = await prisma.user.create({
      data: { orgId: testOrgId, email: 'maker@test.com', password: 'hashed', role: 'DATA_ENTRY' },
    });
    testUserId = user1.id;

    const user2 = await prisma.user.create({
      data: { orgId: testOrgId, email: 'checker@test.com', password: 'hashed', role: 'ADMIN' },
    });
    testApproverId = user2.id;
  });

  afterAll(async () => {
    await prisma.approvalRequest.deleteMany({ where: { orgId: testOrgId } });
    await prisma.approvalPolicy.deleteMany({ where: { orgId: testOrgId } });
    await prisma.contract.deleteMany({ where: { orgId: testOrgId } });
    await prisma.user.deleteMany({ where: { orgId: testOrgId } });
    await prisma.organization.delete({ where: { id: testOrgId } });
  });

  it('should create approval policy', async () => {
    const policy = await prisma.approvalPolicy.create({
      data: {
        orgId: testOrgId,
        entityType: 'CONTRACT',
        condition: {},
        approvalMode: 'SINGLE_APPROVER',
        approvers: [testApproverId],
        level: 1,
      },
    });
    expect(policy.approvalMode).toBe('SINGLE_APPROVER');
  });

  it('should create and approve request', async () => {
    const contract = await prisma.contract.create({
      data: {
        orgId: testOrgId,
        contractNumber: 'TEST-001',
        title: 'Test',
        status: 'PENDING_APPROVAL',
        baseData: {},
        customFields: {},
        startDate: new Date(),
        endDate: new Date(),
        totalValue: 10000,
        currency: 'SAR',
      },
    });

    const request = await prisma.approvalRequest.create({
      data: {
        orgId: testOrgId,
        entityType: 'CONTRACT',
        entityId: contract.id,
        submittedBy: testUserId,
        status: 'PENDING',
      },
    });

    expect(request.status).toBe('PENDING');

    await prisma.approvalDecision.create({
      data: {
        requestId: request.id,
        approverId: testApproverId,
        decision: 'APPROVE',
        comment: 'Approved',
      },
    });

    await prisma.approvalRequest.update({
      where: { id: request.id },
      data: { status: 'APPROVED' },
    });

    await prisma.contract.update({
      where: { id: contract.id },
      data: { status: 'ACTIVE' },
    });

    const updated = await prisma.contract.findUnique({ where: { id: contract.id } });
    expect(updated?.status).toBe('ACTIVE');
  });
});

describe('Partnership Service', () => {
  let testOrgId: string;
  let testPartnerId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'Partner Org', plan: 'PRO' },
    });
    testOrgId = org.id;

    const user = await prisma.user.create({
      data: { orgId: testOrgId, email: 'partner@test.com', password: 'hashed', role: 'FULL_PARTNER' },
    });
    testPartnerId = user.id;
  });

  afterAll(async () => {
    await prisma.partnership.deleteMany({ where: { orgId: testOrgId } });
    await prisma.user.deleteMany({ where: { orgId: testOrgId } });
    await prisma.organization.delete({ where: { id: testOrgId } });
  });

  it('should create partnership with profit share', async () => {
    const partnership = await prisma.partnership.create({
      data: {
        orgId: testOrgId,
        userId: testPartnerId,
        role: 'FULL_PARTNER',
        scope: { all: true },
        profitShare: 25,
        status: 'ACTIVE',
      },
    });

    expect(partnership.profitShare).toBe(25);
    expect(partnership.scope).toEqual({ all: true });
  });

  it('should validate profit share range', async () => {
    await expect(
      prisma.partnership.create({
        data: {
          orgId: testOrgId,
          userId: testPartnerId,
          role: 'FULL_PARTNER',
          scope: { all: true },
          profitShare: 150,
          status: 'ACTIVE',
        },
      })
    ).rejects.toThrow();
  });
});

describe('Addendum Service', () => {
  let testOrgId: string;
  let testContractId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'Addendum Org', plan: 'PRO' },
    });
    testOrgId = org.id;

    const contract = await prisma.contract.create({
      data: {
        orgId: testOrgId,
        contractNumber: 'ADD-001',
        title: 'Addendum Test',
        status: 'ACTIVE',
        baseData: {},
        customFields: {},
        startDate: new Date(),
        endDate: new Date(),
        totalValue: 100000,
        currency: 'SAR',
      },
    });
    testContractId = contract.id;
  });

  afterAll(async () => {
    await prisma.contractAddendum.deleteMany({ where: { contractId: testContractId } });
    await prisma.contract.deleteMany({ where: { orgId: testOrgId } });
    await prisma.organization.delete({ where: { id: testOrgId } });
  });

  it('should create addendum', async () => {
    const addendum = await prisma.contractAddendum.create({
      data: {
        contractId: testContractId,
        addendumNumber: 1,
        changeType: 'VALUE',
        oldValues: { totalValue: 100000 },
        newValues: { totalValue: 120000 },
        effectiveDate: new Date(),
        status: 'PENDING',
      },
    });

    expect(addendum.addendumNumber).toBe(1);
    expect(addendum.changeType).toBe('VALUE');
  });

  it('should get addendum history', async () => {
    const history = await prisma.contractAddendum.findMany({
      where: { contractId: testContractId },
      orderBy: { addendumNumber: 'asc' },
    });

    expect(history.length).toBeGreaterThan(0);
  });
});
