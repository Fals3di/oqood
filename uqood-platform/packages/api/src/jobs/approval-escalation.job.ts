import { Queue, Worker } from 'bullmq';
import { prisma } from '@uqood/database';
import Redis from 'ioredis';

// Initialize Redis connection
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Create queues
const approvalEscalationQueue = new Queue('approval-escalation', {
  connection: redisConnection,
});

const notificationQueue = new Queue('notifications', {
  connection: redisConnection,
});

/**
 * Approval Escalation Service - Handles automatic reminders and escalations
 * Implements section 3.4.2 smart rules from SRS v1.1
 */
export class ApprovalEscalationService {
  /**
   * Schedule escalation for a pending approval request
   * - Reminder after 48 hours
   * - Escalate to next level after 5 days
   */
  async scheduleEscalation(requestId: string, createdAt: Date): Promise<void> {
    const reminderDelay = 48 * 60 * 60 * 1000; // 48 hours in ms
    const escalationDelay = 5 * 24 * 60 * 60 * 1000; // 5 days in ms

    // Schedule reminder job
    await approvalEscalationQueue.add(
      'reminder',
      { requestId },
      {
        delay: reminderDelay,
        jobId: `reminder:${requestId}`,
      }
    );

    // Schedule escalation job
    await approvalEscalationQueue.add(
      'escalate',
      { requestId },
      {
        delay: escalationDelay,
        jobId: `escalate:${requestId}`,
      }
    );
  }

  /**
   * Cancel scheduled escalations for an approved/rejected request
   */
  async cancelEscalation(requestId: string): Promise<void> {
    await Promise.all([
      approvalEscalationQueue.remove(`reminder:${requestId}`),
      approvalEscalationQueue.remove(`escalate:${requestId}`),
    ]);
  }

  /**
   * Send reminder to approvers
   */
  async sendReminder(requestId: string): Promise<void> {
    const request = await prisma.approvalRequest.findUnique({
      where: { id: requestId },
      include: {
        decisions: true,
      },
    });

    if (!request || request.status !== 'PENDING') {
      return; // Request already processed
    }

    // Get policy to find approvers
    const policy = await prisma.approvalPolicy.findFirst({
      where: {
        orgId: request.orgId,
        entityType: request.entityType,
        isActive: true,
      },
    });

    if (!policy) return;

    const approvers = policy.approvers as string[];
    
    // Get users who haven't decided yet
    const decidedUserIds = request.decisions.map(d => d.approverId);
    const pendingApprovers = approvers.filter(id => !decidedUserIds.includes(id));

    // Send notifications
    for (const approverId of pendingApprovers) {
      await notificationQueue.add('email', {
        to: approverId,
        subject: 'تذكير: موافقة مطلوبة',
        body: `هناك طلب معلق للموافقة منذ أكثر من 48 ساعة. الرجاء المراجعة.`,
        type: 'APPROVAL_REMINDER',
        requestId,
      });
    }
  }

  /**
   * Escalate to next approval level
   */
  async escalateToNextLevel(requestId: string): Promise<void> {
    const request = await prisma.approvalRequest.findUnique({
      where: { id: requestId },
    });

    if (!request || request.status !== 'PENDING') {
      return;
    }

    // Get current policy
    const policy = await prisma.approvalPolicy.findFirst({
      where: {
        orgId: request.orgId,
        entityType: request.entityType,
        isActive: true,
      },
    });

    if (!policy) return;

    // For sequential approval, move to next level
    if (policy.approvalMode === 'SEQUENTIAL') {
      const nextLevel = request.currentLevel + 1;

      // Check if there's a policy for the next level
      const nextPolicy = await prisma.approvalPolicy.findFirst({
        where: {
          orgId: request.orgId,
          entityType: request.entityType,
          level: nextLevel,
          isActive: true,
        },
      });

      if (nextPolicy) {
        await prisma.approvalRequest.update({
          where: { id: requestId },
          data: { currentLevel: nextLevel },
        });

        // Schedule new escalations for next level
        await this.scheduleEscalation(requestId, new Date());

        // Notify next level approvers
        const approvers = nextPolicy.approvers as string[];
        for (const approverId of approvers) {
          await notificationQueue.add('email', {
            to: approverId,
            subject: 'تنبيه: موافقة مطلوبة على مستوى أعلى',
            body: `تم تصعيد طلب الموافقة إلى المستوى ${nextLevel}. الرجاء المراجعة.`,
            type: 'APPROVAL_ESCALATION',
            requestId,
          });
        }
      }
    } else {
      // For other modes, notify admins/owners
      const admins = await prisma.user.findMany({
        where: {
          orgId: request.orgId,
          role: { in: ['OWNER', 'ADMIN'] },
        },
      });

      for (const admin of admins) {
        await notificationQueue.add('email', {
          to: admin.id,
          subject: 'تنبيه: تأخر الموافقة',
          body: `طلب الموافقة #${requestId} متأخر منذ أكثر من 5 أيام.`,
          type: 'APPROVAL_OVERDUE',
          requestId,
        });
      }
    }
  }
}

export const approvalEscalationService = new ApprovalEscalationService();

// Worker to process escalation jobs
const worker = new Worker(
  'approval-escalation',
  async job => {
    switch (job.name) {
      case 'reminder':
        await approvalEscalationService.sendReminder(job.data.requestId);
        break;
      case 'escalate':
        await approvalEscalationService.escalateToNextLevel(job.data.requestId);
        break;
    }
  },
  {
    connection: redisConnection,
  }
);

worker.on('error', err => {
  console.error('Approval escalation worker error:', err);
});

console.log('✅ Approval escalation worker started');
