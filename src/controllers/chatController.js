import EventEmitter from 'events';
import geminiServiceInstance, { SUPPORTED_MODELS } from '../services/geminiService.js';
import { summarySessions } from './summaryController.js';

/**
 * فئة إدارة أخطاء متحكم المحادثة والدردشة التفاعلية
 */
export class ChatControllerError extends Error {
  /**
   * إنشاء كائن الخطأ التوضيحي
   * @param {string} message - رسالة الخطأ
   * @param {string} code - الرمز التعريفي للخطأ
   * @param {number} statusCode - رمز حالة HTTP
   * @param {Object} details - بيانات إضافية للتشخيص
   */
  constructor(message, code = 'CHAT_ERROR', statusCode = 400, details = {}) {
    super(message);
    this.name = 'ChatControllerError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ChatControllerError);
    }
  }
}

/**
 * تصنيفات نوايا رسائل المستخدم داخل الشات بوت
 */
export const CHAT_INTENTS = {
  GENERAL_QA: 'general_qa',             // سؤال واستفسار عام عن محتوى المستند
  MODIFY_SUMMARY: 'modify_summary',     // طلب تعديل مباشر على صياغة الملخص
  EXTRACT_DATA: 'extract_data',         // طلب استخراج أرقام، تواريخ، أو جداول معينة
  EXPAND_TOPIC: 'expand_topic',         // طلب التوسع في فكرة أو محور معين
  SIMPLIFY_SUMMARY: 'simplify_summary', // طلب تبسيط التلخيص أو صياغته للمبتدئين
  ACTION_ITEMS: 'action_items',         // طلب استخراج قائمة مهام وقرارات
};

/**
 * الكلمات المفتاحية والدلالات لاكتشاف نية رسالة المستخدم تلقائياً
 */
const INTENT_PATTERNS = [
  {
    intent: CHAT_INTENTS.MODIFY_SUMMARY,
    keywords: ['عدل الملخص', 'غير التلخيص', 'احذف من الملخص', 'أعد صياغة الملخص', 'حدث الملخص', 'اختصر التلخيص'],
  },
  {
    intent: CHAT_INTENTS.SIMPLIFY_SUMMARY,
    keywords: ['بسط', 'اشرح كأني', 'بشكل أبسط', 'بلغة عامية', 'سهلها', 'بدون تعقيد'],
  },
  {
    intent: CHAT_INTENTS.ACTION_ITEMS,
    keywords: ['خطوات عمل', 'مهام', 'توصيات', 'إجراءات', 'ماذا نفعل', 'خطة العمل', 'تطبيق عملي'],
  },
  {
    intent: CHAT_INTENTS.EXTRACT_DATA,
    keywords: ['جدول', 'أرقام', 'إحصائيات', 'تواريخ', 'نسب', 'مقارنة', 'مبالغ', 'بيانات'],
  },
  {
    intent: CHAT_INTENTS.EXPAND_TOPIC,
    keywords: ['توسع في', 'فصل في', 'اشرح بالتفصيل', 'وضح أكثر', 'أعطني تفاصيل إضافية'],
  },
];

/**
 * تحليل رسالة المستخدم وتحديد النية الغالبة لتوجيه النموذج بدقة
 * @param {string} userMessage - نص الرسالة القادمة من المستخدم
 * @returns {string} نية الرسالة
 */
export function detectMessageIntent(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') {
    return CHAT_INTENTS.GENERAL_QA;
  }

  const normalized = userMessage.toLowerCase().trim();

  for (const item of INTENT_PATTERNS) {
    for (const keyword of item.keywords) {
      if (normalized.includes(keyword)) {
        return item.intent;
      }
    }
  }

  return CHAT_INTENTS.GENERAL_QA;
}

/**
 * توليد توجيهات مساعدة للنموذج بحسب النية المكتشفة من رسالة المستخدم
 * @param {string} intent - النية المكتشفة
 * @param {string} currentSummary - نص التلخيص الحالي في الجلسة
 * @returns {string}
 */
export function buildIntentDirective(intent, currentSummary) {
  switch (intent) {
    case CHAT_INTENTS.MODIFY_SUMMARY:
      return `
[توجيه داخلي للنظام]:
المستخدم يرغب في تعديل التلخيص المعتمد.
التلخيص المعتمد الحالي هو:
"""
${currentSummary}
"""
قم بإجراء التعديل المطلوب بدقة مع الحفاظ على ترابط المحتوى، واختم إجابتك بفقرة تفيد: "إذا أعجبك هذا التعديل، يمكنك النقر على زر اعتماد التعديل لتحديث الملخص الرئيسي."
`;

    case CHAT_INTENTS.SIMPLIFY_SUMMARY:
      return `
[توجيه داخلي للنظام]:
المستخدم يطلب تبسيط الفكرة أو التلخيص. استخدم أسلوباً تعليمياً سهلاً، مع الاستعانة بأمثلة توضيحية من سياق المستند لتسهيل الفهم دون الإخلال بالحقائق.
`;

    case CHAT_INTENTS.ACTION_ITEMS:
      return `
[توجيه داخلي للنظام]:
استخرج من المستند المهام والخطوات الإجرائية بصيغة نقاط عمل مرتبة وقابلة للتطبيق الفوري (Actionable Steps).
`;

    case CHAT_INTENTS.EXTRACT_DATA:
      return `
[توجيه داخلي للنظام]:
المستخدم يسأل عن بيانات محددة أو أرقام أو جداول. قم بصياغة الإجابة على شكل جدول Markdown منظم مع ذكر السياق الرقمي بدقة تامة كما ورد في الوثيقة الأصلية.
`;

    case CHAT_INTENTS.EXPAND_TOPIC:
      return `
[توجيه داخلي للنظام]:
المستخدم يطلب التعمق والتفصيل في محور معين. استند للمستند الأصلي لتقديم تحليل معمق مع ذكر كافة الحيثيات المذكورة.
`;

    case CHAT_INTENTS.GENERAL_QA:
    default:
      return `
[توجيه داخلي للنظام]:
أجب على استفسار المستخدم بشكل مباشر وموثوق باللغة العربية اعتماداً على المستند الأصلي والملخص القائم، وإذا كانت المعلومة غير موجودة في المستند، وضح ذلك بأمانة دون افتراضات خارجية.
`;
  }
}

/**
 * مدير سجل رسائل المحادثة داخل ذاكرة الخادم
 */
class ConversationManager extends EventEmitter {
  constructor() {
    super();
    // مفتاح الجلسة -> مصفوفة الرسائل
    this.conversations = new Map();
    // الحد الأقصى لعدد الرسائل المحفوظة في تاريخ المحادثة الواحدة لمنع التضخم
    this.maxHistoryPerSession = 50;
  }

  /**
   * جلب تاريخ المحادثة لجلسة معينة
   * @param {string} sessionId - معرف الجلسة
   * @returns {Array<Object>}
   */
  getHistory(sessionId) {
    if (!this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, []);
    }
    return this.conversations.get(sessionId);
  }

  /**
   * إضافة رسالة جديدة لتاريخ المحادثة
   * @param {string} sessionId - معرف الجلسة
   * @param {string} role - الدور ('user' أو 'assistant')
   * @param {string} content - نص الرسالة
   * @param {Object} metadata - خصائص وصفية اختيارية (النموذج، النية، وقت التوليد)
   */
  appendMessage(sessionId, role, content, metadata = {}) {
    const history = this.getHistory(sessionId);

    const messageRecord = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      role: role === 'assistant' ? 'assistant' : 'user',
      content: content.trim(),
      timestamp: new Date().toISOString(),
      metadata,
    };

    history.push(messageRecord);

    // الحفاظ على سقف أقصى لتاريخ المحادثة لتفادي إجهاد الذاكرة
    if (history.length > this.maxHistoryPerSession) {
      history.shift();
    }

    this.emit('message:appended', { sessionId, message: messageRecord });
    return messageRecord;
  }

  /**
   * مسح تاريخ المحادثة لجلسة معينة مع الإبقاء على الوثيقة والملخص
   * @param {string} sessionId
   */
  clearHistory(sessionId) {
    if (this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, []);
      this.emit('history:cleared', { sessionId });
      return true;
    }
    return false;
  }

  /**
   * حذف السجل بالكامل للجلسات الملغاة
   * @param {string} sessionId
   */
  removeSession(sessionId) {
    this.conversations.delete(sessionId);
  }
}

export const conversationManager = new ConversationManager();

/**
 * متحكم عمليات الدردشة والمحادثة الذكية التفاعلية للمستندات
 */
export class ChatController {
  /**
   * معالجة إرسال رسالة دردشة جديدة والرد عليها بسياق المستند والملخص
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static async handleSendMessage(req, res) {
    const startTime = Date.now();
    const { sessionId } = req.params;
    const { message, model, customDirective } = req.body;

    try {
      // 1. التحقق من المدخلات الأساسية
      if (!sessionId || typeof sessionId !== 'string') {
        throw new ChatControllerError('معرف الجلسة (sessionId) مطلوب وغير صالح.', 'INVALID_SESSION_ID', 400);
      }

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        throw new ChatControllerError('نص الرسالة مطلوب ولا يمكن أن يكون فارغاً.', 'EMPTY_MESSAGE', 400);
      }

      // 2. التحقق من وجود الجلسة وسياق المستند في سجل الجلسات
      const session = summarySessions.getSession(sessionId);
      if (!session) {
        throw new ChatControllerError(
          'جلسة التلخيص غير موجودة أو انتهت صلاحيتها من الذاكرة المؤقتة.',
          'SESSION_EXPIRED',
          404
        );
      }

      // 3. تحديد النموذج ونية الرسالة وتوليد التوجيه الملائم
      const requestedModel = model || SUPPORTED_MODELS.FAST_LITE;
      const detectedIntent = detectMessageIntent(message);
      const intentDirective = buildIntentDirective(detectedIntent, session.summary);

      // تسجيل رسالة المستخدم في التاريخ
      conversationManager.appendMessage(sessionId, 'user', message, {
        intent: detectedIntent,
      });

      // 4. تجهيز تاريخ الرسائل وتنسيقها للنموذج
      const history = conversationManager.getHistory(sessionId);
      const contextualMessages = history.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // حقن التوجيه الإضافي الخاص بالنية في الرسالة الأخيرة للمستخدم قبل الإرسال
      const enrichedUserMessage = `
${intentDirective}
${customDirective ? `[توجيه إضافي من المستخدم]: ${customDirective}\n` : ''}
استفسار المستخدم:
${message.trim()}
      `.trim();

      // استبدال النص الأخير بالنص الغني لـ Gemini دون تغيير ما يظهر في واجهة المستخدم
      contextualMessages[contextualMessages.length - 1].content = enrichedUserMessage;

      console.log(`[ChatController] معالجة رسالة للجلسة ${sessionId} | النية: ${detectedIntent} | النموذج: ${requestedModel}`);

      // 5. استدعاء خدمة Gemini مع تمرير مرجع الملف السحابي والملخص الحالي
      const chatResponse = await geminiServiceInstance.handleChatConversation({
        messages: contextualMessages,
        fileUri: session.fileUri,
        mimeType: session.mimeType,
        currentSummary: session.summary,
        model: requestedModel,
      });

      // 6. حفظ رد المساعد في سجل المحادثة
      const assistantMessageRecord = conversationManager.appendMessage(
        sessionId,
        'assistant',
        chatResponse.reply,
        {
          modelUsed: chatResponse.modelUsed,
          intentHandled: detectedIntent,
          usage: chatResponse.usage,
        }
      );

      const processingDurationMs = Date.now() - startTime;

      // 7. إرجاع الرد المتكامل للواجهة
      return res.status(200).json({
        success: true,
        sessionId,
        message: {
          id: assistantMessageRecord.id,
          role: 'assistant',
          content: chatResponse.reply,
          timestamp: assistantMessageRecord.timestamp,
          intent: detectedIntent,
          modelUsed: chatResponse.modelUsed,
        },
        documentContext: {
          title: session.documentTitle,
          originalName: session.originalName,
          hasSummary: !!session.summary,
        },
        suggestedActions: ChatController.generateSuggestedActions(detectedIntent),
        durationMs: processingDurationMs,
      });
    } catch (error) {
      console.error('[ChatController:Error] فشلت معالجة رسالة المحادثة:', error);

      const statusCode = error.statusCode || 500;
      const errorCode = error.code || 'CHAT_PROCESSING_FAILED';

      return res.status(statusCode).json({
        success: false,
        error: error.message || 'حدث خطأ أثناء التواصل مع المساعد الذكي.',
        code: errorCode,
        details: error.details || null,
      });
    }
  }

  /**
   * اعتماد تعديل مقترح على التلخيص تم توليده عبر المحادثة
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static async applySummaryRevision(req, res) {
    try {
      const { sessionId } = req.params;
      const { revisedSummary, revisionNote } = req.body;

      if (!sessionId || typeof sessionId !== 'string') {
        throw new ChatControllerError('معرف الجلسة غير صالح.', 'INVALID_SESSION_ID', 400);
      }

      if (!revisedSummary || typeof revisedSummary !== 'string' || revisedSummary.trim().length === 0) {
        throw new ChatControllerError('النص المعدل للملخص مطلوب ولا يمكن تركه فارغاً.', 'INVALID_SUMMARY_CONTENT', 400);
      }

      const session = summarySessions.getSession(sessionId);
      if (!session) {
        throw new ChatControllerError('جلسة التلخيص غير موجودة.', 'SESSION_NOT_FOUND', 404);
      }

      // تحديث التلخيص في سجل الجلسة الرسمي
      const updatedSession = summarySessions.updateSessionSummary(
        sessionId,
        revisedSummary.trim(),
        revisionNote || 'تم التعديل بواسطة اقتراح المساعد الذكي'
      );

      // تسجيل رسالة نظام في المحادثة لتوثيق التعديل
      conversationManager.appendMessage(
        sessionId,
        'assistant',
        `✅ تم بنجاح اعتماد وتحديث التلخيص الرئيسي للوثيقة (الإصدار رقم ${updatedSession.revisionHistory.length}).`,
        { isSystemNotice: true }
      );

      return res.status(200).json({
        success: true,
        sessionId,
        message: 'تم تحديث التلخيص المعتمد للجلسة بنجاح.',
        currentSummary: updatedSession.summary,
        version: updatedSession.revisionHistory.length,
      });
    } catch (error) {
      console.error('[ChatController:ApplyRevisionError]', error);
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({
        success: false,
        error: error.message || 'فشل تطبيق تعديل التلخيص.',
        code: error.code || 'REVISION_APPLY_FAILED',
      });
    }
  }

  /**
   * جلب كامل تاريخ المحادثة التفاعلية لجلسة معينة
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static async getChatHistory(req, res) {
    try {
      const { sessionId } = req.params;

      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'معرف الجلسة غير صالح.',
          code: 'INVALID_SESSION_ID',
        });
      }

      const session = summarySessions.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'الجلسة غير موجودة أو انتهت صلاحيتها.',
          code: 'SESSION_NOT_FOUND',
        });
      }

      const history = conversationManager.getHistory(sessionId);

      return res.status(200).json({
        success: true,
        sessionId,
        documentTitle: session.documentTitle,
        totalMessages: history.length,
        messages: history,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: `تعذر جلب سجل المحادثة: ${err.message}`,
        code: 'HISTORY_FETCH_FAILED',
      });
    }
  }

  /**
   * إعادة ضبط وتصفير سجل الدردشة دون حذف المستند أو الملخص
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static async clearConversation(req, res) {
    try {
      const { sessionId } = req.params;

      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'معرف الجلسة غير صالح.',
          code: 'INVALID_SESSION_ID',
        });
      }

      const session = summarySessions.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'الجلسة غير موجودة.',
          code: 'SESSION_NOT_FOUND',
        });
      }

      conversationManager.clearHistory(sessionId);

      return res.status(200).json({
        success: true,
        message: 'تم تصفير سجل المحادثة بنجاح مع الاحتفاظ بالمستند والملخص.',
        sessionId,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: `تعذر مسح سجل المحادثة: ${err.message}`,
        code: 'CLEAR_FAILED',
      });
    }
  }

  /**
   * تصدير تفاصيل المحادثة كملف نصي أو Markdown
   * @param {Object} req - طلب Express
   * @param {Object} res - رد Express
   */
  static async exportTranscript(req, res) {
    try {
      const { sessionId } = req.params;
      const format = (req.query.format || 'markdown').toLowerCase();

      const session = summarySessions.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'الجلسة غير موجودة.',
          code: 'SESSION_NOT_FOUND',
        });
      }

      const history = conversationManager.getHistory(sessionId);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `chat_${session.sanitizedName}_${timestamp}.${format === 'text' ? 'txt' : 'md'}`;

      let output = '';

      if (format === 'text') {
        output += `سجل محادثة المساعد الذكي حول المستند: ${session.documentTitle}\n`;
        output += `تاريخ التصدير: ${new Date().toLocaleString('ar-SA')}\n`;
        output += `عدد الرسائل: ${history.length}\n`;
        output += `${'='.repeat(60)}\n\n`;

        history.forEach((msg, idx) => {
          const sender = msg.role === 'user' ? 'المستخدم' : 'المساعد الذكي';
          output += `[${idx + 1}] (${msg.timestamp}) ${sender}:\n${msg.content}\n\n`;
        });

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      } else {
        output += `# سجل المحادثة الذكية حول: ${session.documentTitle}\n\n`;
        output += `- **الملف الأصلي:** \`${session.originalName}\`\n`;
        output += `- **تاريخ التصدير:** ${new Date().toLocaleString('ar-SA')}\n`;
        output += `- **إجمالي الرسائل:** ${history.length}\n\n---\n\n`;

        history.forEach((msg, idx) => {
          const isUser = msg.role === 'user';
          output += `### ${idx + 1}. ${isUser ? '👤 المستخدم' : '🤖 المساعد الذكي'}\n`;
          output += `*التوقيت: ${new Date(msg.timestamp).toLocaleTimeString('ar-SA')}*\n\n`;
          output += `${msg.content}\n\n---\n\n`;
        });

        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      }

      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return res.status(200).send(output);
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: `فشل تصدير سجل المحادثة: ${err.message}`,
        code: 'EXPORT_FAILED',
      });
    }
  }

  /**
   * توليد اقتراحات ذكية تظهر للمستخدم بناءً على النية للضغط السريع
   * @param {string} intent - نية الرسالة الأخيرة
   * @returns {Array<string>} قائمة أسئلة سريعة مقترحة
   */
  static generateSuggestedActions(intent) {
    switch (intent) {
      case CHAT_INTENTS.MODIFY_SUMMARY:
        return [
          'حول الملخص إلى نقاط نقطية (Bullet Points)',
          'احذف المقدمة وركز على القرارات والتوصيات',
          'اعتمد هذا التعديل كملخص رئيسي',
        ];
      case CHAT_INTENTS.EXTRACT_DATA:
        return [
          'اعرض البيانات في جدول إحصائي مفصل',
          'ما هي أهم المؤشرات المالية المذكورة؟',
          'هل توجد تواريخ تسليم أو مواعيد نهائية؟',
        ];
      case CHAT_INTENTS.ACTION_ITEMS:
        return [
          'حدد المسؤول عن كل مهمة إن وُجد في المستند',
          'رتب المهام حسب الأولوية التنفيذية',
          'ما هي المخاطر المحتملة التي حذر منها المستند؟',
        ];
      case CHAT_INTENTS.SIMPLIFY_SUMMARY:
        return [
          'لخص الفكرة في فقرة واحدة من ثلاثة أسطر',
          'ما هي أهم مصطلحات تقنية وردت وما معناها؟',
          'كيف أشرح هذا المحتوى لشخص غير متخصص؟',
        ];
      default:
        return [
          'هل يمكنك تعديل الملخص ليصبح أكثر إيجازاً؟',
          'استخرج أهم 5 حقائق وردت في الوثيقة',
          'ما هي التوصيات الختامية المذكورة في الأصل؟',
        ];
    }
  }
}

export default ChatController;
