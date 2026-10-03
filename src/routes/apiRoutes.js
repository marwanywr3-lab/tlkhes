import express from 'express';
import { SummaryController } from '../controllers/summaryController.js';
import { ChatController } from '../controllers/chatController.js';
import { handleSingleFileUpload } from '../middleware/uploadMiddleware.js';

const router = express.Router();

/**
 * ذاكرة وسيطة بسيطة لحساب وتحديد معدل الطلبات لحماية نقاط النهاية الحساسة
 */
class InMemoryRateLimiter {
  constructor(windowMs = 60 * 1000, maxRequests = 30) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.hits = new Map();
  }

  middleware() {
    return (req, res, next) => {
      const clientIp = req.ip || req.connection.remoteAddress || 'unknown-client';
      const now = Date.now();

      if (!this.hits.has(clientIp)) {
        this.hits.set(clientIp, { count: 1, resetAt: now + this.windowMs });
        return next();
      }

      const clientRecord = this.hits.get(clientIp);

      if (now > clientRecord.resetAt) {
        clientRecord.count = 1;
        clientRecord.resetAt = now + this.windowMs;
        return next();
      }

      clientRecord.count++;

      if (clientRecord.count > this.maxRequests) {
        return res.status(429).json({
          success: false,
          error: 'تم تجاوز الحد الأقصى المسموح به من الطلبات مؤقتاً. يرجى الانتظار دقيقة.',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterMs: clientRecord.resetAt - now,
        });
      }

      next();
    };
  }
}

const generalLimiter = new InMemoryRateLimiter(60 * 1000, 60);
const heavyOperationsLimiter = new InMemoryRateLimiter(60 * 1000, 15);

/**
 * @route   GET /api/v1/meta/capabilities
 * @desc    استعراض النماذج المدعومة، الأنماط، وحدود الرفع
 * @access  عام
 */
router.get('/meta/capabilities', generalLimiter.middleware(), SummaryController.getCapabilities);

/**
 * @route   GET /api/v1/meta/health
 * @desc    فحص صحة طبقة التوجيه واستقرار الخادم
 * @access  عام
 */
router.get('/meta/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ONLINE',
    timestamp: new Date().toISOString(),
    routesVersion: 'v1.0.0',
    endpoints: {
      summarization: ['POST /summarize', 'POST /summarize/:sessionId/regenerate'],
      conversation: ['POST /chat/:sessionId', 'POST /chat/:sessionId/apply-revision'],
      sessionManagement: ['GET /sessions/:sessionId', 'DELETE /sessions/:sessionId'],
    },
  });
});

/**
 * @route   POST /api/v1/summarize
 * @desc    رفع مستند جديد (حتى 400 ميغابايت) واستخراج التلخيص الذكي
 * @access  عام مع حماية التدفق الثقيل
 */
router.post(
  '/summarize',
  heavyOperationsLimiter.middleware(),
  handleSingleFileUpload('file'),
  SummaryController.processDocumentSummary
);

/**
 * @route   POST /api/v1/summarize/:sessionId/regenerate
 * @desc    إعادة توليد التلخيص لجلسة قائمة بنمط جديد أو تعليمات مخصصة
 * @access  عام
 */
router.post(
  '/summarize/:sessionId/regenerate',
  heavyOperationsLimiter.middleware(),
  SummaryController.regenerateSummary
);

/**
 * @route   GET /api/v1/summarize/:sessionId/export
 * @desc    تصدير التلخيص كملف Markdown أو Text قابل للتنزيل المباشر
 * @access  عام
 */
router.get(
  '/summarize/:sessionId/export',
  generalLimiter.middleware(),
  SummaryController.exportSummary
);

/**
 * @route   POST /api/v1/chat/:sessionId
 * @desc    إرسال رسالة دردشة تفاعلية في سياق المستند والملخص الحالي
 * @access  عام
 */
router.post(
  '/chat/:sessionId',
  generalLimiter.middleware(),
  ChatController.handleSendMessage
);

/**
 * @route   POST /api/v1/chat/:sessionId/apply-revision
 * @desc    اعتماد وتثبيت التعديل المقترح من المحادثة كملخص رئيسي
 * @access  عام
 */
router.post(
  '/chat/:sessionId/apply-revision',
  generalLimiter.middleware(),
  ChatController.applySummaryRevision
);

/**
 * @route   GET /api/v1/chat/:sessionId/history
 * @desc    استرجاع كامل سجل المحادثة التفاعلية لجلسة معينة
 * @access  عام
 */
router.get(
  '/chat/:sessionId/history',
  generalLimiter.middleware(),
  ChatController.getChatHistory
);

/**
 * @route   DELETE /api/v1/chat/:sessionId/clear
 * @desc    تصفير سجل المحادثة مع الاحتفاظ بالوثيقة والملخص
 * @access  عام
 */
router.delete(
  '/chat/:sessionId/clear',
  generalLimiter.middleware(),
  ChatController.clearConversation
);

/**
 * @route   GET /api/v1/chat/:sessionId/export
 * @desc    تصدير تفريغ المحادثة كملف نصي أو Markdown
 * @access  عام
 */
router.get(
  '/chat/:sessionId/export',
  generalLimiter.middleware(),
  ChatController.exportTranscript
);

/**
 * @route   GET /api/v1/sessions/:sessionId
 * @desc    جلب تفاصيل وحالة الجلسة والملخص وتاريخ التعديلات
 * @access  عام
 */
router.get(
  '/sessions/:sessionId',
  generalLimiter.middleware(),
  SummaryController.getSummaryBySessionId
);

/**
 * @route   DELETE /api/v1/sessions/:sessionId
 * @desc    إنهاء الجلسة وحذف الملف السحابي المرتبط بها فورياً
 * @access  عام
 */
router.delete(
  '/sessions/:sessionId',
  generalLimiter.middleware(),
  SummaryController.terminateSession
);

router.use('/*', (req, res) => {
  res.status(404).json({
    success: false,
    error: `المسار المطلوب [${req.method} ${req.originalUrl}] غير مدعوم في واجهة برمجة التطبيقات.`,
    code: 'API_ENDPOINT_NOT_FOUND',
  });
});

export default router;
