import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';

/**
 * فئة إدارة أخطاء مخصصة لخدمات Gemini API
 * تتيح تتبع تفاصيل الخطأ ورموز الاستجابة ونوع المشكلة بدقة
 */
export class GeminiServiceError extends Error {
  constructor(message, originalError = null, errorCode = 'GEMINI_GENERIC_ERROR', statusCode = 500) {
    super(message);
    this.name = 'GeminiServiceError';
    this.errorCode = errorCode;
    this.statusCode = statusCode;
    this.originalError = originalError;
    this.timestamp = new Date().toISOString();

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GeminiServiceError);
    }
  }
}

export const SUPPORTED_MODELS = {
  FAST_LITE: 'gemini-3.5-flash-lite',
  DEEP_FLASH: 'gemini-3.8-flash',
};

const DEFAULT_CONFIG = {
  temperature: 0.3,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
};

const SYSTEM_INSTRUCTIONS = {
  SUMMARIZER: `
أنت خبير أكاديمي ومحلل محتوى رفيع المستوى متخصص في استخراج أدق المعطيات وتلخيص المستندات الشاملة (PDF، صور، نصوص، وسائط).
مهمتك الأساسية هي:
1. تقديم ملخص تنفيذي مركز يوضح الفكرة الجوهرية للوثيقة.
2. استخراج النقاط الأساسية والتفاصيل الدقيقة والبيانات الهامة دون إغفال السياق.
3. تفكيك المحتوى إلى محاور مهيكلة وواضحة يسهل قراءتها عبر شاشات الحواسيب والهواتف.
4. صياغة النص بأسلوب عربي فصيح، دافئ، احترافي، وخالٍ من الركاكة.
5. الإشارة لأي جداول أو إحصائيات أو تحذيرات مذكورة في الأصل.
`,
  CHATBOT: `
أنت المساعد الذكي التفاعلي المخصص لهذا المستند وتلخيصه.
وظيفتك:
1. الإجابة بدقة استناداً إلى الوثيقة المرفوعة والملخص المُعد.
2. تعديل التلخيص حسب رغبة المستخدم (توسيعه، اختصاره، استخراج نقاط عمل، تحويله إلى نقاط أو جداول).
3. الحفاظ على نبرة ودودة ومفيدة وأمينة للمحتوى الأصلي، مع تنبيه المستخدم في حال سؤاله عن أمور غير واردة بالمستند.
`,
};

export class GeminiService extends EventEmitter {
  /**
   * تهيئة الخدمة مع التحقق الصارم من وجود مفتاح الـ API
   * @param {string} apiKey - مفتاح الواجهة البرمجية لـ Google AI Studio
   */
  constructor(apiKey = process.env.GEMINI_API_KEY) {
    super();

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new GeminiServiceError(
        'مفتاح Gemini API غير معرف. يرجى ضبط المتغير البيئي GEMINI_API_KEY.',
        null,
        'MISSING_API_KEY',
        500
      );
    }

    this.apiKey = apiKey.trim();
    this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    this.activeUploads = new Map();
    this.sessionCaches = new Map();

    // إعدادات إعادة المحاولة
    this.retryOptions = {
      maxRetries: 4,
      initialDelayMs: 1500,
      maxDelayMs: 12000,
      backoffFactor: 2,
    };
  }

  /**
   * تنفيذ الدوال غير المتزامنة مع إعادة المحاولة التلقائية عند حدوث اختناق بالشبكة أو ضغط حصص الاستخدام
   * @param {Function} asyncFn - الدالة المراد تنفيذها
   * @param {string} operationName - اسم العملية لأغراض التوثيق
   */
  async executeWithRetry(asyncFn, operationName = 'GeminiOperation') {
    let attempt = 0;
    let delay = this.retryOptions.initialDelayMs;

    while (attempt < this.retryOptions.maxRetries) {
      try {
        attempt++;
        return await asyncFn();
      } catch (error) {
        const isRateLimit = error?.status === 429 || error?.message?.includes('RESOURCE_EXHAUSTED');
        const isNetworkTransient = error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || error?.status >= 500;

        if ((isRateLimit || isNetworkTransient) && attempt < this.retryOptions.maxRetries) {
          console.warn(
            `[GeminiService:Retry] فشل تنفيذ (${operationName}) في المحاولة ${attempt}. إعادة المحاولة بعد ${delay}ms... السبب: ${error.message}`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * this.retryOptions.backoffFactor, this.retryOptions.maxDelayMs);
        } else {
          console.error(`[GeminiService:Fatal] فشل نهائي في (${operationName}) بعد ${attempt} محاولات:`, error);
          throw new GeminiServiceError(
            `فشل تنفيذ عملية الذكاء الاصطناعي (${operationName}): ${error.message || 'خطأ غير معروف'}`,
            error,
            'API_CALL_FAILED',
            error?.status || 500
          );
        }
      }
    }
  }

  /**
   * فحص سلامة الملف المحلي والتأكد من وجوده واستخراج امتداده ومطابقة نوع الوسائط
   * @param {string} localFilePath - المسار الفعلي للملف المؤقت
   * @param {string} mimeType - نوع المحتوى المستلم
   */
  validateLocalFile(localFilePath, mimeType) {
    if (!fs.existsSync(localFilePath)) {
      throw new GeminiServiceError(
        `الملف المحدد غير موجود على المسار المحلي: ${localFilePath}`,
        null,
        'FILE_NOT_FOUND',
        404
      );
    }

    const stats = fs.statSync(localFilePath);
    if (stats.size === 0) {
      throw new GeminiServiceError('الملف المرفوع فارغ تماماً (0 بايت).', null, 'EMPTY_FILE', 400);
    }

    const maxLimitBytes = 400 * 1024 * 1024;
    if (stats.size > maxLimitBytes) {
      throw new GeminiServiceError(
        `حجم الملف (${Math.round(stats.size / 1024 / 1024)}MB) يتجاوز الحد الأقصى المسموح (400MB).`,
        null,
        'FILE_TOO_LARGE',
        413
      );
    }

    return {
      size: stats.size,
      sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
      mimeType: mimeType || 'application/octet-stream',
    };
  }

  /**
   * رفع الملفات الضخمة حتى 400 ميغابايت إلى Google Files API
   * ومتابعة دورة معالجتها حتى تصبح جاهزة للاستهلاك من النماذج
   * @param {string} localFilePath - المسار على السيرفر
   * @param {string} mimeType - نوع الملف (PDF, image, audio, etc.)
   * @param {string} displayName - اسم الملف للعرض
   */
  async uploadLargeFileToGemini(localFilePath, mimeType, displayName = 'Uploaded_Document') {
    const fileMeta = this.validateLocalFile(localFilePath, mimeType);
    const trackingId = `upload_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    console.log(`[GeminiService:Upload] بدء رفع ملف بحجم ${fileMeta.sizeMB}MB عبر Files API... [${trackingId}]`);
    this.emit('uploadProgress', { stage: 'start', trackingId, sizeMB: fileMeta.sizeMB });

    return await this.executeWithRetry(async () => {
      const fileStream = fs.createReadStream(localFilePath);

      const uploadResponse = await this.ai.files.upload({
        file: fileStream,
        mimeType: fileMeta.mimeType,
        config: {
          displayName: displayName.slice(0, 100),
        },
      });

      console.log(`[GeminiService:Upload] تم اكتمال الرفع الأولي بنجاح. معرف الملف: ${uploadResponse.name}`);

      // استطلاع حالة معالجة الملف لضمان جهوزيته للتحليل (خاصة مع الـ PDFs الضخمة والفيديوهات)
      let fileInfo = await this.ai.files.get({ name: uploadResponse.name });
      let attempts = 0;
      const maxPollAttempts = 60; // انتظار حتى 120 ثانية كحد أقصى

      while (fileInfo.state === 'PROCESSING' && attempts < maxPollAttempts) {
        attempts++;
        console.log(`[GeminiService:Polling] الملف لا يزال قيد المعالجة السحابية... المحاولة ${attempts}`);
        await new Promise((res) => setTimeout(res, 2000));
        fileInfo = await this.ai.files.get({ name: uploadResponse.name });
      }

      if (fileInfo.state === 'FAILED') {
        throw new GeminiServiceError(
          'فشلت سحابة Google في معالجة المستند المرفوع.',
          null,
          'FILE_PROCESSING_FAILED',
          422
        );
      }

      this.activeUploads.set(uploadResponse.name, {
        uri: uploadResponse.uri,
        name: uploadResponse.name,
        mimeType: fileMeta.mimeType,
        uploadedAt: new Date(),
      });

      this.emit('uploadProgress', { stage: 'completed', trackingId, uri: uploadResponse.uri });

      return {
        fileUri: uploadResponse.uri,
        fileName: uploadResponse.name,
        mimeType: fileMeta.mimeType,
        sizeMB: fileMeta.sizeMB,
      };
    }, 'UploadLargeFile');
  }

  /**
   * تحديد واختيار النموذج مع ضمان التراجع للبديل الآمن في حال تمرير قيمة غير مدعومة
   * @param {string} requestedModel - النموذج المطلوب
   */
  resolveModel(requestedModel) {
    if (requestedModel === SUPPORTED_MODELS.FAST_LITE) {
      return SUPPORTED_MODELS.FAST_LITE;
    }
    if (requestedModel === SUPPORTED_MODELS.DEEP_FLASH) {
      return SUPPORTED_MODELS.DEEP_FLASH;
    }
    // الافتراضي للتلخيص الشامل هو 3.8 Flash
    return SUPPORTED_MODELS.DEEP_FLASH;
  }

  /**
   * معالجة وتوليد التلخيص الذكي للمستند
   * @param {Object} params - إعدادات التلخيص
   * @param {string} params.fileUri - رابط الملف في Google Files API
   * @param {string} params.mimeType - نوع وسائط الملف
   * @param {string} [params.model] - النموذج المستهدف (3.8 Flash أو 3.5 Flash Lite)
   * @param {string} [params.customPrompt] - تعليمات إضافية يحددها المستخدم للملخص
   */
  async generateDocumentSummary({ fileUri, mimeType, model = SUPPORTED_MODELS.DEEP_FLASH, customPrompt = '' }) {
    if (!fileUri) {
      throw new GeminiServiceError('رابط المستند السحابي (fileUri) مطلوب لبدء التلخيص.', null, 'MISSING_FILE_URI', 400);
    }

    const selectedModel = this.resolveModel(model);
    console.log(`[GeminiService:Summarize] بدء التلخيص باستخدام النموذج: ${selectedModel}`);

    const basePrompt = customPrompt && customPrompt.trim().length > 0
      ? `قم بتحليل المستند وتلخيصه بدقة عالية باللغة العربية، مع الالتزام بالتعليمات الإضافية التالية: "${customPrompt.trim()}".`
      : 'قم بتحليل وتلخيص هذا المستند بشكل شامل ومنظم باللغة العربية، مبرزاً النقاط الجوهرية، الأفكار المحورية، والنتائج مع الحفاظ على ترابط المعنى وسهولة التصفح.';

    return await this.executeWithRetry(async () => {
      const response = await this.ai.models.generateContent({
        model: selectedModel,
        config: {
          systemInstruction: SYSTEM_INSTRUCTIONS.SUMMARIZER,
          temperature: DEFAULT_CONFIG.temperature,
          topP: DEFAULT_CONFIG.topP,
          maxOutputTokens: DEFAULT_CONFIG.maxOutputTokens,
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                fileData: {
                  fileUri: fileUri,
                  mimeType: mimeType || 'application/pdf',
                },
              },
              {
                text: basePrompt,
              },
            ],
          },
        ],
      });

      const summaryText = response.text;
      if (!summaryText || summaryText.trim() === '') {
        throw new GeminiServiceError(
          'لم يرجع النموذج أي نص تلخيصي صالح.',
          null,
          'EMPTY_MODEL_RESPONSE',
          502
        );
      }

      return {
        success: true,
        summary: summaryText.trim(),
        modelUsed: selectedModel,
        tokensUsed: response.usageMetadata || null,
        generatedAt: new Date().toISOString(),
      };
    }, `GenerateSummary:${selectedModel}`);
  }

  /**
   * إدارة المحادثة التفاعلية وتعديل التلخيص بالاعتماد على سياق الملف والمحادثة
   * @param {Object} params - معطيات المحادثة
   * @param {Array} params.messages - سجل الرسائل السابقة بين المستخدم والمساعد
   * @param {string} [params.fileUri] - رابط الملف في Files API لحفظ السياق
   * @param {string} [params.mimeType] - نوع الملف
   * @param {string} [params.currentSummary] - النص الحالي للملخص للرجوع له وتعديله
   * @param {string} [params.model] - النموذج المستهدف للمحادثة (الافتراضي 3.5 Flash Lite للسرعة)
   */
  async handleChatConversation({
    messages = [],
    fileUri = null,
    mimeType = null,
    currentSummary = null,
    model = SUPPORTED_MODELS.FAST_LITE,
  }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new GeminiServiceError(
        'قائمة الرسائل (messages) يجب أن تحتوي على رسالة واحدة على الأقل.',
        null,
        'INVALID_MESSAGES_ARRAY',
        400
      );
    }

    const selectedModel = this.resolveModel(model);
    console.log(`[GeminiService:Chat] معالجة رسالة المحادثة بالنموذج: ${selectedModel} (عدد الرسائل: ${messages.length})`);

    const formattedContents = [];

    // حقن سياق الملف والمستند في أول تفاعل إن وُجد
    if (fileUri && mimeType) {
      const initialParts = [
        {
          fileData: {
            fileUri: fileUri,
            mimeType: mimeType,
          },
        },
        {
          text: `هذا هو المستند الأصلي المعتمد كمرجع رئيسي وحصري للمحادثة. ${
            currentSummary ? `وهذا هو التلخيص المعتمد الحالي:\n"""\n${currentSummary}\n"""` : ''
          }`,
        },
      ];

      formattedContents.push({
        role: 'user',
        parts: initialParts,
      });

      formattedContents.push({
        role: 'model',
        parts: [
          {
            text: 'تم استلام وفحص المستند والملخص الحالي بدقة. أنا جاهز لإجراء أي تعديلات، تلخيص نقاط إضافية، أو الإجابة على أي استفسارات.',
          },
        ],
      });
    }

    // تصفية وإدراج تاريخ المحادثة بالترتيب الصحيح
    for (const msg of messages) {
      if (!msg.content || typeof msg.content !== 'string') continue;

      const role = msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user';
      formattedContents.push({
        role: role,
        parts: [{ text: msg.content.trim() }],
      });
    }

    return await this.executeWithRetry(async () => {
      const response = await this.ai.models.generateContent({
        model: selectedModel,
        config: {
          systemInstruction: SYSTEM_INSTRUCTIONS.CHATBOT,
          temperature: 0.4,
          topP: 0.95,
          maxOutputTokens: DEFAULT_CONFIG.maxOutputTokens,
        },
        contents: formattedContents,
      });

      const replyText = response.text;
      if (!replyText || replyText.trim() === '') {
        throw new GeminiServiceError('استجابة خالية من المساعد الذكي.', null, 'EMPTY_CHAT_RESPONSE', 502);
      }

      return {
        success: true,
        reply: replyText.trim(),
        modelUsed: selectedModel,
        usage: response.usageMetadata || null,
        timestamp: new Date().toISOString(),
      };
    }, `ChatConversation:${selectedModel}`);
  }

  /**
   * حذف الملف المرفوع من سحابة Google Files API بعد الانتهاء من المعالجة أو عند انتهاء الجلسة
   * @param {string} fileName - الاسم البرمجي للملف في Files API مثل (files/abc123xyz)
   */
  async deleteRemoteFile(fileName) {
    if (!fileName) return false;

    try {
      console.log(`[GeminiService:Cleanup] جاري حذف الملف السحابي: ${fileName}`);
      await this.ai.files.delete({ name: fileName });
      this.activeUploads.delete(fileName);
      console.log(`[GeminiService:Cleanup] تم حذف الملف السحابي بنجاح: ${fileName}`);
      return true;
    } catch (err) {
      console.warn(`[GeminiService:Cleanup] تعذر حذف الملف السحابي ${fileName}:`, err.message);
      return false;
    }
  }

  /**
   * فحص الاتصال بالخدمة وصلاحية المفتاح
   */
  async ping() {
    try {
      const response = await this.ai.models.generateContent({
        model: SUPPORTED_MODELS.FAST_LITE,
        contents: 'قل كلمة واحدة فقط: متصل',
      });
      return {
        healthy: true,
        response: response.text?.trim(),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return {
        healthy: false,
        error: err.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

// تصدير نسخة عامة أحادية (Singleton) للاستخدام المباشر
const geminiServiceInstance = new GeminiService();
export default geminiServiceInstance;
