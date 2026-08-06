import { z } from 'zod';
import { prisma, ContractStatus, RiskLevel } from '@uqood/database';
import { OrgContext } from '../../types/context';

/**
 * Risk Assessment Service - Evaluates contract risk across 4 dimensions
 * Reference: SRS v1.1 Section 3.7.2
 */

export const RiskAssessmentSchema = z.object({
  financialRisk: z.number().min(0).max(100).describe('المخاطر المالية (0-100)'),
  timelineRisk: z.number().min(0).max(100).describe('المخاطر الزمنية (0-100)'),
  legalRisk: z.number().min(0).max(100).describe('المخاطر القانونية (0-100)'),
  reputationRisk: z.number().min(0).max(100).describe('مخاطر السمعة (0-100)'),
  overallScore: z.number().min(0).max(100).describe('الدرجة الإجمالية'),
  overallLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).describe('التصنيف الإجمالي'),
  factors: z.array(z.string()).describe('العوامل المؤثرة في التقييم'),
  recommendations: z.array(z.string()).describe('التوصيات')
});

export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export class RiskAssessmentService {
  /**
   * Assess risk for a specific contract
   * @param contractId - Contract ID
   * @param context - Organization context
   * @returns Risk assessment report
   */
  async assessContractRisk(contractId: string, context: OrgContext): Promise<RiskAssessment> {
    const contract = await prisma.contract.findUnique({
      where: { id: contractId, orgId: context.orgId },
      include: {
        parties: true,
        paymentSchedule: true,
        addendums: true
      }
    });

    if (!contract) {
      throw new Error('العقد غير موجود');
    }

    console.log(`[AI] Assessing risk for contract ${contractId}`);

    // Calculate financial risk
    const financialRisk = this.calculateFinancialRisk(contract);

    // Calculate timeline risk
    const timelineRisk = this.calculateTimelineRisk(contract);

    // Calculate legal risk
    const legalRisk = this.calculateLegalRisk(contract);

    // Calculate reputation risk
    const reputationRisk = await this.calculateReputationRisk(contract);

    // Calculate overall score (weighted average)
    const overallScore = Math.round(
      financialRisk * 0.3 +
      timelineRisk * 0.25 +
      legalRisk * 0.25 +
      reputationRisk * 0.2
    );

    // Determine overall level
    const overallLevel = this.getRiskLevel(overallScore);

    // Generate factors and recommendations
    const factors = this.generateRiskFactors({
      financialRisk,
      timelineRisk,
      legalRisk,
      reputationRisk,
      contract
    });

    const recommendations = this.generateRecommendations({
      financialRisk,
      timelineRisk,
      legalRisk,
      reputationRisk,
      contract
    });

    // Update contract with risk score
    await prisma.contract.update({
      where: { id: contractId },
      data: {
        riskScore: overallScore,
        aiSummary: JSON.stringify({
          level: overallLevel,
          assessedAt: new Date().toISOString(),
          factors
        })
      }
    });

    // Log to audit trail
    await prisma.auditLog.create({
      data: {
        orgId: context.orgId,
        userId: context.userId,
        action: 'AI_RISK_ASSESSED',
        tableName: 'contracts',
        recordId: contractId,
        newData: { overallScore, overallLevel }
      }
    });

    return {
      financialRisk,
      timelineRisk,
      legalRisk,
      reputationRisk,
      overallScore,
      overallLevel,
      factors,
      recommendations
    };
  }

  /**
   * Calculate financial risk based on value, payment terms, and history
   */
  private calculateFinancialRisk(contract: any): number {
    let risk = 0;

    // High value contracts have higher risk
    const value = Number(contract.value) || 0;
    if (value > 1000000) risk += 30;
    else if (value > 500000) risk += 20;
    else if (value > 100000) risk += 10;

    // Check payment schedule for overdue payments
    const overduePayments = contract.paymentSchedule?.filter(
      (p: any) => p.status === 'OVERDUE'
    ).length || 0;

    if (overduePayments > 0) {
      risk += Math.min(overduePayments * 15, 40);
    }

    // Long-term contracts have higher uncertainty
    const startDate = new Date(contract.startDate);
    const endDate = new Date(contract.endDate);
    const durationMonths = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 30);

    if (durationMonths > 24) risk += 20;
    else if (durationMonths > 12) risk += 10;

    return Math.min(risk, 100);
  }

  /**
   * Calculate timeline risk based on deadlines and progress
   */
  private calculateTimelineRisk(contract: any): number {
    let risk = 0;

    const now = new Date();
    const endDate = new Date(contract.endDate);
    const startDate = new Date(contract.startDate);

    // Contract ending soon
    const daysUntilEnd = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntilEnd < 0) {
      risk += 50; // Already expired
    } else if (daysUntilEnd < 30) {
      risk += 30; // Ending within 30 days
    } else if (daysUntilEnd < 90) {
      risk += 15; // Ending within 90 days
    }

    // Check for addendums (modifications indicate instability)
    const addendumCount = contract.addendums?.length || 0;
    if (addendumCount > 3) {
      risk += 25;
    } else if (addendumCount > 1) {
      risk += 10;
    }

    // Auto-renewal without clear terms increases risk
    if (contract.autoRenewal && !contract.renewalNoticeDays) {
      risk += 15;
    }

    return Math.min(risk, 100);
  }

  /**
   * Calculate legal risk based on clauses and compliance
   */
  private calculateLegalRisk(contract: any): number {
    let risk = 0;

    // Missing key clauses increases risk
    const clauses = contract.clauses || [];
    const hasPenaltyClause = clauses.some((c: any) => c.clauseType === 'PENALTY');
    const hasTerminationClause = clauses.some((c: any) => c.clauseType === 'TERMINATION');
    const hasDisputeClause = clauses.some((c: any) => c.clauseType === 'DISPUTE_RESOLUTION');

    if (!hasPenaltyClause) risk += 20;
    if (!hasTerminationClause) risk += 20;
    if (!hasDisputeClause) risk += 15;

    // Contracts with individuals have slightly higher legal risk
    const hasIndividualParty = contract.parties?.some((p: any) => p.type === 'INDIVIDUAL');
    if (hasIndividualParty) risk += 10;

    // No penalty for late payment
    if (!contract.penaltyClauses) {
      risk += 15;
    }

    return Math.min(risk, 100);
  }

  /**
   * Calculate reputation risk based on party ratings
   */
  private async calculateReputationRisk(contract: any): Promise<number> {
    let risk = 0;

    // Check party ratings
    for (const party of contract.parties || []) {
      if (party.rating && party.rating < 3) {
        risk += 30;
      } else if (party.rating && party.rating < 4) {
        risk += 15;
      }

      // New parties without history
      if (!party.rating) {
        risk += 10;
      }
    }

    // Government contracts have lower reputation risk
    const hasGovernmentParty = contract.parties?.some((p: any) =>
      p.name.includes('وزارة') || p.name.includes('هيئة')
    );

    if (hasGovernmentParty) {
      risk -= 10;
    }

    return Math.max(Math.min(risk, 100), 0);
  }

  /**
   * Convert score to risk level
   */
  private getRiskLevel(score: number): RiskLevel {
    if (score >= 75) return 'CRITICAL';
    if (score >= 50) return 'HIGH';
    if (score >= 25) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Generate human-readable risk factors
   */
  private generateRiskFactors(data: any): string[] {
    const factors: string[] = [];

    if (data.financialRisk > 50) {
      factors.push('قيمة العقد مرتفعة نسبياً');
    }

    if (data.timelineRisk > 50) {
      const daysLeft = Math.ceil(
        (new Date(data.contract.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      if (daysLeft < 30) {
        factors.push(`العقد ينتهي خلال ${daysLeft} يوماً`);
      }
      if (data.contract.addendums?.length > 3) {
        factors.push('تم تعديل العقد عدة مرات مما يشير إلى عدم استقرار');
      }
    }

    if (data.legalRisk > 50) {
      if (!data.contract.clauses?.some((c: any) => c.clauseType === 'PENALTY')) {
        factors.push('لا يوجد بند للغرامات');
      }
      if (!data.contract.clauses?.some((c: any) => c.clauseType === 'TERMINATION')) {
        factors.push('لا يوجد بند للإنهاء');
      }
    }

    if (data.reputationRisk > 30) {
      factors.push('بعض الأطراف لديها تقييم منخفض أو لا يوجد تاريخ سابق');
    }

    return factors;
  }

  /**
   * Generate actionable recommendations
   */
  private generateRecommendations(data: any): string[] {
    const recommendations: string[] = [];

    if (data.financialRisk > 50) {
      recommendations.push('مراجعة شروط الدفع وتقليل المخاطر المالية');
      recommendations.push('طلب ضمانات إضافية للعقد');
    }

    if (data.timelineRisk > 50) {
      recommendations.push('بدء إجراءات التجديد قبل 90 يوماً من الانتهاء');
      recommendations.push('توثيق جميع التعديلات بشكل رسمي');
    }

    if (data.legalRisk > 50) {
      recommendations.push('إضافة بنود واضحة للغرامات والإنهاء');
      recommendations.push('استشارة الفريق القانوني لمراجعة العقد');
    }

    if (data.reputationRisk > 30) {
      recommendations.push('التحقق من سمعة الأطراف المتعاقدة');
      recommendations.push('طلب مراجع أو ضمانات من الأطراف الجديدة');
    }

    if (recommendations.length === 0) {
      recommendations.push('العقد ضمن مستويات مخاطر مقبولة');
    }

    return recommendations;
  }

  /**
   * Get all high-risk contracts for an organization
   */
  async getHighRiskContracts(context: OrgContext, limit = 10): Promise<any[]> {
    const contracts = await prisma.contract.findMany({
      where: {
        orgId: context.orgId,
        status: 'ACTIVE',
        riskScore: { gte: 50 }
      },
      orderBy: { riskScore: 'desc' },
      take: limit,
      include: {
        parties: true,
        asset: true
      }
    });

    return contracts.map(c => ({
      id: c.id,
      title: c.title,
      riskScore: c.riskScore,
      riskLevel: this.getRiskLevel(c.riskScore || 0),
      parties: c.parties.map(p => p.name),
      endDate: c.endDate
    }));
  }
}

export const riskAssessmentService = new RiskAssessmentService();
