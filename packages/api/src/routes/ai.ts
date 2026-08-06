import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ocrService, ExtractedContractDataSchema } from '../services/ai/ocr.service';
import { riskAssessmentService } from '../services/ai/risk-assessment.service';
import { authMiddleware } from '../middleware/auth';
import { OrgContext } from '../types/context';

/**
 * AI Routes - OCR and Risk Assessment endpoints
 * Reference: SRS v1.1 Section 3.7
 */

export const aiRoutes = new Hono<{ Variables: { context: OrgContext } }>();

// Apply authentication to all AI routes
aiRoutes.use('/*', authMiddleware);

/**
 * POST /ai/ocr/process
 * Process a contract file with OCR and AI analysis
 */
aiRoutes.post(
  '/ocr/process',
  zValidator('json', z.object({
    fileId: z.string().uuid()
  })),
  async (c) => {
    const { fileId } = c.req.valid('json');
    const context = c.get('context');

    try {
      const extractedData = await ocrService.processContractFile(fileId, context);

      return c.json({
        success: true,
        data: extractedData,
        message: 'تم استخراج البيانات بنجاح، يرجى مراجعتها قبل الحفظ'
      });
    } catch (error) {
      console.error('[AI OCR Error]', error);
      return c.json({
        success: false,
        error: 'فشل في معالجة الملف'
      }, 500);
    }
  }
);

/**
 * POST /ai/contracts/compare
 * Compare two contracts using AI
 */
aiRoutes.post(
  '/contracts/compare',
  zValidator('json', z.object({
    contractId1: z.string().uuid(),
    contractId2: z.string().uuid()
  })),
  async (c) => {
    const { contractId1, contractId2 } = c.req.valid('json');
    const context = c.get('context');

    try {
      const comparison = await ocrService.compareContracts(contractId1, contractId2, context);

      return c.json({
        success: true,
        data: comparison
      });
    } catch (error) {
      console.error('[AI Compare Error]', error);
      return c.json({
        success: false,
        error: 'فشل في مقارنة العقود'
      }, 500);
    }
  }
);

/**
 * POST /ai/risk/assess/:contractId
 * Assess risk for a specific contract
 */
aiRoutes.post(
  '/risk/assess/:contractId',
  async (c) => {
    const contractId = c.req.param('contractId');
    const context = c.get('context');

    try {
      const assessment = await riskAssessmentService.assessContractRisk(contractId, context);

      return c.json({
        success: true,
        data: assessment
      });
    } catch (error) {
      console.error('[AI Risk Error]', error);
      return c.json({
        success: false,
        error: 'فشل في تقييم المخاطر'
      }, 500);
    }
  }
);

/**
 * GET /ai/risk/high-risk
 * Get all high-risk contracts for the organization
 */
aiRoutes.get('/risk/high-risk', async (c) => {
  const context = c.get('context');
  const limit = parseInt(c.req.query('limit') || '10');

  try {
    const highRiskContracts = await riskAssessmentService.getHighRiskContracts(context, limit);

    return c.json({
      success: true,
      data: highRiskContracts
    });
  } catch (error) {
    console.error('[AI High Risk Error]', error);
    return c.json({
      success: false,
      error: 'فشل في جلب العقود عالية المخاطر'
    }, 500);
  }
});

/**
 * GET /ai/stats
 * Get AI processing statistics for the organization
 */
aiRoutes.get('/stats', async (c) => {
  const context = c.get('context');

  // TODO: Implement stats aggregation from database
  // Count OCR processed files, risk assessments done, etc.

  return c.json({
    success: true,
    data: {
      ocrProcessedCount: 0,
      riskAssessmentsCount: 0,
      averageConfidence: 0,
      highRiskContractsCount: 0
    }
  });
});
