import path from 'path';
import fs from 'fs';
import EventEmitter from 'events';
import geminiServiceInstance, { SUPPORTED_MODELS } from '../services/geminiService.js';
import fileProcessorInstance from '../services/fileProcessor.js';

/**
 * فئة إدارة أخطاء وحدة معالجة وتوليد التلخيصات
 */
export class SummaryControllerError extends Error {
  /**
   * إنشاء كائن الخطأ التوضيحي
   * @param {string} message - رسالة الخطأ
   * @param {string} code - الرمز البرمجي للخطأ
   * @param {number} statusCode - كود حالة HTTP
   * @param {Object} details - تفاصيل إضافية لتسهيل التشخيص
   */
  constructor(message, code = 'SUMMARY_ERROR', statusCode = 500, details = {}) {
    super(message);
    this.name = 'SummaryControllerError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SummaryControllerError);
    }
  }
}

/**
 * قوالب التوجيه الهندسي المتقدمة للذكاء الاصطناعي بحسب نمط التلخيص المطلوب
 */
export const SUMMARY_MODES = {
  EXECUTIVE: 'executive',     // ملخص تنفيذي يركز على الرؤية والقرارات والنتائج
  DETAILED: 'detailed',       // تلخيص تحليلي عميق يغطي كل الفصول والأقسام
  BULLETS: 'bullets',         // نقاط سريعة وقصيرة ومباشرة
  ACADEMIC: 'academic',       // تلخيص منهجي يبرز الأهداف والمنهجية والنتائج
  ACTIONABLE: 'actionable',   // تلخيص موجه لمهام وخطوات عمل قابلة للتنفيذ
};

/**
 * بناء صياغة التوجيه المتخصص استناداً إلى النمط المختار
 * @param {string} mode - نمط التلخيص
 * @param {string} additionalUserInstructions - توجيهات إضافية خاصة بالمستخدم
 * @returns {string}
 */
export function buildEngineeredPrompt(mode = SUMMARY_MODES.EXECUTIVE, additionalUserInstructions = '') {
  let promptFoundation = '';

  switch (mode) {
    case SUMMARY_MODES.DETAILED:
      promptFoundation = `
قم بإجراء تلخيص تحليلي عميق وشامل للغاية لهذا المستند باللغة العربية الفصيحة، مع مراعاة ما يلي بدقة:
1. استخراج الفكرة المركزية للمستند في فقرة تمهيدية مكثفة.
2. تفكيك المحتوى إلى محاور فرعية واضحة وعناوين بارزة تغطي كل جزء مهم ورد في الأصل.
3. تفصيل أي بيانات إحصائية، جداول، معايير، أو أرقام وردت في المستند مع إبراز دلالتها.
4. إبراز الاستنتاجات والتوصيات النهائية المذكورة.
5. المحافظة على الدقة والأمانة العلمية التامة دون تحريف السياق.
`;
      break;

    case SUMMARY_MODES.BULLETS:
      promptFoundation = `
قم بإنتاج ملخص سريع، واضح، ومباشر للغاية للمستند باللغة العربية على شكل نقاط رئيسية وفرعية:
- ابدأ بفقرة من 3 أسطر تعرّف بموضوع المستند والهدف منه.
- استخرج أهم 10 إلى 15 فكرة جوهرية في شكل نقاط نقطية (Bullet Points) مرقمة ومنظمة.
- ضع قسماً صغيراً في النهاية للنتائج السريعة والتوصيات.
`;
      break;

    case SUMMARY_MODES.ACADEMIC:
      promptFoundation = `
أنت محكم أكاديمي خبير. قم بتلخيص هذه الورقة أو المستند بصياغة علمية رصينة باللغة العربية تشمل الأقسام التالية:
- الملخص العام والمشكلة البحثية.
- المنهجية والأدوات المستخدمة إن وجدت.
- النتائج الرئيسية والأرقام الدقيقة.
- الخاتمة، القيود البحثية، والتوصيات المستقبلية.
`;
      break;

    case SUMMARY_MODES.ACTIONABLE:
      promptFoundation = `
قم بتحليل هذا المستند واستخراج ملخص موجه للإنجاز والعمل (Action-Oriented Summary) باللغة العربية:
1. الأهداف الرئيسية المستخلصة.
2. قائمة المهام وخطوات العمل المستخرجة من المستند مع ذكر المسؤولين أو التوصيات إن وُجدت.
3. التحديات والمخاطر المذكورة في المستند وكيفية تجنبها.
4. مؤشرات النجاح والنتائج المتوقعة.
`;
      break;

    case SUMMARY_MODES.EXECUTIVE:
    default:
      promptFoundation = `
أنت مستشار استراتيجي رفيع المستوى. قم بصياغة ملخص تنفيذي رفيع ومترابط باللغة العربية الفصيحة:
1. **الرؤية والهدف الجوهري**: فقرة تلخص جوهر المستند بشكل احترافي.
2. **المحاور الاستراتيجية والأفكار الكبرى**: تقسيم منظم للأفكار والمواضيع المطروحة.
3. **أبرز الحقائق والبيانات**: ذكر الأرقام والمعطيات الحيوية.
4. **التوصيات والخلاصة التنفيذية**: نتائج ومخرجات حاسمة.
`;
      break;
  }

  if (additionalUserInstructions && additionalUserInstructions.trim().length > 0) {
    promptFoundation += `\n\nتعليمات وتفضيلات إضافية من المستخدم يجب الالتزام بها بدقة:\n"""\n${additionalUserInstructions.trim()}\n"""`;
  }

  return promptFoundation.trim();
}

/**
 * سجل الجلسات المعتمدة في الذاكرة لتغذية الشات بوت التفاعلي بالسياق الكامل
 */
class SummarySessionManager extends EventEmitter {
  constructor() {
    super();
    // مفتاح الجلسة -> بيانات الجلسة والمستند
    this.sessions = new Map();
    // مدة بقاء الجلسة في الذاكرة: 6 ساعات
    this.ttlMs = 6 * 60 * 60 * 1000;
  }

  /**
   * إنشاء وتخزين جلسة تلخيص جديدة
   * @param {string} sessionId - معرف الجلسة الفريد
   * @param {Object} sessionData - بيانات الجلسة والملخص والملف السحابي
   */
  createSession(sessionId, sessionData) {
    const record = {
      sessionId,
      ...sessionData,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      revisionHistory: [
        {
          version: 1,
          summary: sessionData.summary,
          modelUsed: sessionData.modelUsed,
          timestamp: new Date().toISOString(),
          note: 'Initial Summary',
        },
      ],
    };

    this.sessions.set(sessionId, record);
    this.emit('session:created', { sessionId, record });
    return record;
  }

  /**
   * جلب جلسة تلخيص بواسطة المعرف
   * @param {string} sessionId
   * @returns {Object|null}
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.lastAccessedAt = Date.now();
    return session;
  }

  /**
   * إضافة نسخة معدلة للملخص في سجل الجلسة
   * @param {string} sessionId - معرف الجلسة
   * @param {string} newSummary - النص الجديد للملخص بعد التعديل عبر الشات بوت
   * @param {string} updateReason - سبب التعديل
   */
  updateSessionSummary(sessionId, newSummary, updateReason = 'Chatbot revision') {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.summary = newSummary;
    session.lastAccessedAt = Date.now();
    session.revisionHistory.push({
      version: session.revisionHistory.length + 1,
      summary: newSummary,
      timestamp: new Date().toISOString(),
      note: updateReason,
    });

    this.emit('session:updated', { sessionId, version: session.revisionHistory.length });
    return session;
  }

  /**
   * تنظيف الجلسات منتهية الصلاحية
   */
  purgeStaleSessions() {
    const now = Date.now();
    for (const [sessionId, data] of this.sessions.entries()) {
      if (now - data.lastAccessedAt > this.ttlMs) {
        // حذف الملف السحابي المرتبط بالجلسة إن وجد
        if (data.remoteFileName) {
          geminiServiceInstance.deleteRemoteFile(data.remoteFileName).catch(() => {});
        }
        this.sessions.delete(sessionId);
        this.emit('session:purged', { sessionId });
      }
    }
  }
}

export const summarySessions = new SummarySessionManager();

// دورة تنظيف الجلسات كل ساعة
setInterval(() => {
  summarySessions.purgeStaleSessions();
}, 60 * 60 * 1000);

/**
 * فئة التحكم الرئيسية لعمليات التلخيص والتحليل الذكي للمستندات
 */
export class SummaryController {
  /**
   * معالجة طلب تلخيص مستند جديد مرفوع
   * يستقبل الملف من multer عبر handleSingleFileUpload، يفحصه، يرفعه لـ Gemini Files API، وينتج التلخيص
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static async processDocumentSummary(req, res) {
    const startTime = Date.now();
    const file = req.file;
    const fileDetails = req.fileDetails;
    let localFilePath = file ? file.path : null;
    let remoteUploadData = null;

    // استخراج معطيات التلخيص من النموذج
    const requestedModel = req.body.model || SUPPORTED_MODELS.DEEP_FLASH;
    const summaryMode = req.body.mode || SUMMARY_MODES.EXECUTIVE;
    const customInstructions = req.body.customInstructions || '';
    const clientProvidedTitle = req.body.title || (file ? file.originalname : 'وثيقة غير معنونة');

    try {
      // 1. التحقق من وجود الملف المستلم
      if (!file || !localFilePath) {
        throw new SummaryControllerError(
          'لم يتم استلام أي ملف لمعالجته. يرجى اختيار ملف صالح وإعادة المحاولة.',
          'NO_FILE_ATTACHED',
          400
        );
      }

      console.log(`[SummaryController] بدء دورة التلخيص للملف: ${file.originalname} (${file.size} بايت)`);

      // 2. الفحص الأمني المتقدم وتحديد نوع البايتات الحقيقية عبر FileProcessor
      const inspectionReport = await fileProcessorInstance.processAndInspect(
        localFilePath,
        file.mimetype,
        file.originalname
      );

      console.log(`[SummaryController] تم فحص الملف بنجاح. النوع المكتشف: ${inspectionReport.detectedMime}`);

      // 3. رفع الملف الضخم إلى سحابة Google Files API
      remoteUploadData = await geminiServiceInstance.uploadLargeFileToGemini(
        localFilePath,
        inspectionReport.detectedMime,
        inspectionReport.sanitizedName
      );

      console.log(`[SummaryController] تم رفع المستند إلى Files API. المرجع: ${remoteUploadData.fileUri}`);

      // 4. بناء التوجيه الهندسي المخصص
      const engineeredPrompt = buildEngineeredPrompt(summaryMode, customInstructions);

      // 5. طلب التلخيص من خدمة Gemini
      const summaryResult = await geminiServiceInstance.generateDocumentSummary({
        fileUri: remoteUploadData.fileUri,
        mimeType: inspectionReport.detectedMime,
        model: requestedModel,
        customPrompt: engineeredPrompt,
      });

      // 6. إنشاء جلسة تلخيص جديدة لتسهيل تفاعل الشات بوت لاحقاً
      const sessionId = req.uploadSessionId || `sum_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      const sessionRecord = summarySessions.createSession(sessionId, {
        documentTitle: clientProvidedTitle,
        originalName: inspectionReport.originalName,
        sanitizedName: inspectionReport.sanitizedName,
        fileSize: inspectionReport.fileSize,
        fileSizeFormatted: inspectionReport.fileSizeFormatted,
        mimeType: inspectionReport.detectedMime,
        fileUri: remoteUploadData.fileUri,
        remoteFileName: remoteUploadData.fileName,
        summary: summaryResult.summary,
        modelUsed: summaryResult.modelUsed,
        mode: summaryMode,
        checksums: inspectionReport.checksums,
        metadata: inspectionReport.metadata,
      });

      const totalProcessingDuration = Date.now() - startTime;

      // 7. الرد النهائي للعميل بالملخص والبيانات الكاملة
      return res.status(200).json({
        success: true,
        sessionId: sessionId,
        document: {
          title: clientProvidedTitle,
          originalName: inspectionReport.originalName,
          fileSizeFormatted: inspectionReport.fileSizeFormatted,
          mimeType: inspectionReport.detectedMime,
          category: inspectionReport.category,
          metadata: inspectionReport.metadata,
        },
        summary: {
          content: summaryResult.summary,
          mode: summaryMode,
          modelUsed: summaryResult.modelUsed,
          tokensUsed: summaryResult.tokensUsed,
          generatedAt: summaryResult.generatedAt,
        },
        performance: {
          totalDurationMs: totalProcessingDuration,
          fileInspectionDurationMs: inspectionReport.processingDurationMs,
        },
        chatContextReady: true,
      });

    } catch (error) {
      console.error('[SummaryController:Error] فشلت عملية تلخيص المستند:', error);

      // إذا نجح الرفع السحابي وفشلت المعالجة، ننظف الملف السحابي فوراً لمنع تراكم الملفات المهملة
      if (remoteUploadData && remoteUploadData.fileName) {
        geminiServiceInstance.deleteRemoteFile(remoteUploadData.fileName).catch((delErr) => {
          console.warn('[SummaryController:CleanupWarning] فشل حذف الملف السحابي بعد خطأ:', delErr.message);
        });
      }

      const statusCode = error.statusCode || 500;
      const errorCode = error.code || error.errorCode || 'SUMMARY_GENERATION_FAILED';

      return res.status(statusCode).json({
        success: false,
        error: error.message || 'حدث خطأ غير متوقع أثناء تحليل وتلخيص المستند.',
        code: errorCode,
        details: error.details || error.context || null,
      });

    } finally {
      // حذف الملف المؤقت من القرص المحلي دائماً بعد اكتمال الرفع السحابي
      if (localFilePath) {
        fileProcessorInstance.safeDelete(localFilePath).catch((err) => {
          console.error(`[SummaryController:Cleanup] فشل حذف الملف المؤقت ${localFilePath}:`, err.message);
        });
      }
    }
  }

  /**
   * استرجاع ملخص جلسة سابقة بواسطة الـ Session ID
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static async getSummaryBySessionId(req, res) {
    try {
      const { sessionId } = req.params;

      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'معرف الجلسة (sessionId) مطلوب وغير صالح.',
          code: 'INVALID_SESSION_ID',
        });
      }

      const session = summarySessions.getSession(sessionId);

      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'جلسة التلخيص المطلوبة غير موجودة أو انتهت صلاحيتها من الخادم.',
          code: 'SESSION_NOT_FOUND',
        });
      }

      return res.status(200).json({
        success: true,
        sessionId: session.sessionId,
        document: {
          title: session.documentTitle,
          originalName: session.originalName,
          fileSizeFormatted: session.fileSizeFormatted,
          mimeType: session.mimeType,
          metadata: session.metadata,
        },
        summary: {
          content: session.summary,
          mode: session.mode,
          modelUsed: session.modelUsed,
          revisionCount: session.revisionHistory.length,
          lastUpdatedAt: session.revisionHistory[session.revisionHistory.length - 1]?.timestamp,
        },
        history: session.revisionHistory,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: `تعذر جلب بيانات الجلسة: ${err.message}`,
        code: 'SESSION_RETRIEVAL_FAILED',
      });
    }
  }

  /**
   * إعادة توليد التلخيص لجلسة قائمة بنمط جديد أو بتعليمات إضافية
   * دون الحاجة لإعادة رفع الملف من جهاز العميل مرة أخرى
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static async regenerateSummary(req, res) {
    try {
      const { sessionId } = req.params;
      const { mode, customInstructions, model } = req.body;

      const session = summarySessions.getSession(sessionId);

      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'جلسة التلخيص المراد إعادة بنائها غير موجودة أو منتهية الصلاحية.',
          code: 'SESSION_NOT_FOUND',
        });
      }

      const targetMode = mode || session.mode || SUMMARY_MODES.EXECUTIVE;
      const targetModel = model || session.modelUsed || SUPPORTED_MODELS.DEEP_FLASH;
      const engineeredPrompt = buildEngineeredPrompt(targetMode, customInstructions || '');

      console.log(`[SummaryController:Regenerate] إعادة توليد التلخيص للجلسة ${sessionId} بنمط: ${targetMode}`);

      const summaryResult = await geminiServiceInstance.generateDocumentSummary({
        fileUri: session.fileUri,
        mimeType: session.mimeType,
        model: targetModel,
        customPrompt: engineeredPrompt,
      });

      // تحديث الجلسة بالملخص الجديد وإضافته لسجل المراجعات
      summarySessions.updateSessionSummary(
        sessionId,
        summaryResult.summary,
        `Regenerated with mode: ${targetMode}`
      );

      session.mode = targetMode;
      session.modelUsed = targetModel;

      return res.status(200).json({
        success: true,
        sessionId,
        summary: {
          content: summaryResult.summary,
          mode: targetMode,
          modelUsed: targetModel,
          tokensUsed: summaryResult.tokensUsed,
          regeneratedAt: summaryResult.generatedAt,
        },
      });
    } catch (err) {
      console.error('[SummaryController:RegenerateError]', err);
      return res.status(500).json({
        success: false,
        error: `فشلت إعادة توليد التلخيص: ${err.message}`,
        code: 'REGENERATION_FAILED',
      });
    }
  }

  /**
   * إنهاء جلسة التلخيص وحذف الملف السحابي المرتبط بها فورياً
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static async terminateSession(req, res) {
    try {
      const { sessionId } = req.params;
      const session = summarySessions.getSession(sessionId);

      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'الجلسة غير موجودة بالفعل.',
          code: 'SESSION_NOT_FOUND',
        });
      }

      // حذف الملف السحابي من Google Files API
      if (session.remoteFileName) {
        await geminiServiceInstance.deleteRemoteFile(session.remoteFileName);
      }

      summarySessions.sessions.delete(sessionId);

      return res.status(200).json({
        success: true,
        message: 'تم إنهاء الجلسة وحذف الموارد السحابية والمحلية المرتبطة بها بنجاح.',
        sessionId,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: `تعذر إنهاء الجلسة وحذف الموارد: ${err.message}`,
        code: 'TERMINATION_FAILED',
      });
    }
  }

  /**
   * تصدير التلخيص بصيغة نصية واضحة أو Markdown للتنزيل المباشر
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static async exportSummary(req, res) {
    try {
      const { sessionId } = req.params;
      const format = (req.query.format || 'markdown').toLowerCase();

      const session = summarySessions.getSession(sessionId);

      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'الجلسة المراد تصدير ملخصها غير موجودة.',
          code: 'SESSION_NOT_FOUND',
        });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeDocName = session.sanitizedName.replace(/\.[^/.]+$/, '');
      const exportFileName = `summary_${safeDocName}_${timestamp}.${format === 'text' ? 'txt' : 'md'}`;

      let content = '';

      if (format === 'text') {
        content = `
عنوان المستند: ${session.documentTitle}
الملف الأصلي: ${session.originalName} (${session.fileSizeFormatted})
النموذج المستخدم: ${session.modelUsed}
نمط التلخيص: ${session.mode}
تاريخ التوليد: ${new Date().toLocaleString('ar-SA')}
----------------------------------------------------------------------
المـلـخـص:
----------------------------------------------------------------------
${session.summary}
----------------------------------------------------------------------
تم التوليد عبر منصة التلخيص الذكية (Gemini AI Engine)
`.trim();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      } else {
        content = `
# ${session.documentTitle}

- **الملف الأصلي:** \`${session.originalName}\`
- **الحجم:** ${session.fileSizeFormatted}
- **النموذج الذكي:** \`${session.modelUsed}\`
- **نمط التلخيص:** ${session.mode}
- **تاريخ المعالجة:** ${new Date().toLocaleString('ar-SA')}

---

## الملخص التنفيذي

${session.summary}

---
*تم توليد هذا الملخص آلياً باستخدام محرك التلخيص والتحليل الذكي.*
`.trim();
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      }

      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(exportFileName)}"`);
      return res.status(200).send(content);

    } catch (err) {
      return res.status(500).json({
        success: false,
        error: `فشل تصدير الملخص: ${err.message}`,
        code: 'EXPORT_FAILED',
      });
    }
  }

  /**
   * استعراض قائمة الأنماط والنماذج المدعومة في واجهة التطبيق
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static getCapabilities(req, res) {
    return res.status(200).json({
      success: true,
      supportedModels: [
        {
          id: SUPPORTED_MODELS.DEEP_FLASH,
          name: 'Gemini 3.8 Flash',
          description: 'النموذج الموصى به للتحليل المعمق، فهم الجداول، والمستندات التقنية الضخمة.',
          defaultFor: 'summary',
        },
        {
          id: SUPPORTED_MODELS.FAST_LITE,
          name: 'Gemini 3.5 Flash Lite',
          description: 'فائق السرعة وخفيف، ممتاز للمحادثات السريعة والتعديلات الفورية للملخص.',
          defaultFor: 'chat',
        },
      ],
      supportedModes: [
        { id: SUMMARY_MODES.EXECUTIVE, name: 'ملخص تنفيذي', description: 'تركيز استراتيجي على الرؤية والأهداف والنتائج.' },
        { id: SUMMARY_MODES.DETAILED, name: 'ملخص تحليلي مفصل', description: 'تغطية واسعة لجميع فصول وأجزاء المستند بالأرقام.' },
        { id: SUMMARY_MODES.BULLETS, name: 'نقاط جوهرية سريعة', description: 'قائمة نقطية من 10-15 فكرة رئيسية مباشرة.' },
        { id: SUMMARY_MODES.ACADEMIC, name: 'ملخص أكاديمي رصين', description: 'تقسيم علمي: تمهيد، منهجية، نتائج، وتوصيات.' },
        { id: SUMMARY_MODES.ACTIONABLE, name: 'خطوات عمل ومهام', description: 'استخراج التكليفات والمهام القابلة للتنفيذ الفوري.' },
      ],
      limits: {
        maxUploadBytes: 400 * 1024 * 1024,
        maxUploadMB: 400,
      },
    });
  }
}

export default SummaryController;
