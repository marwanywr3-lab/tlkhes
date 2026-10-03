import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import EventEmitter from 'events';

/**
 * فئة مخصصة للأخطاء الناتجة عن عمليات رفع الملفات والتحقق الأمني الأولي
 */
export class UploadMiddlewareError extends Error {
  /**
   * إنشاء كائن خطأ رفع مخصص
   * @param {string} message - رسالة الخطأ التوضيحية
   * @param {string} code - رمز الخطأ البرمجي
   * @param {number} statusCode - رمز حالة HTTP
   * @param {Object} context - معلومات تشخيصية إضافية
   */
  constructor(message, code = 'UPLOAD_ERROR', statusCode = 400, context = {}) {
    super(message);
    this.name = 'UploadMiddlewareError';
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
    this.timestamp = new Date().toISOString();

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, UploadMiddlewareError);
    }
  }
}

// الحد الأقصى الافتراضي لحجم الملف: 400 ميغابايت
export const DEFAULT_MAX_FILE_SIZE = 400 * 1024 * 1024;

// مسار المجلد المؤقت الافتراضي لحفظ الملفات المرفوعة
export const DEFAULT_UPLOAD_DIR = path.resolve('uploads');

// القائمة البيضاء لأنواع الوسائط المصرح بها للتحليل بالذكاء الاصطناعي
export const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

// القائمة البيضاء للامتدادات المسموح برفعها
export const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
]);

/**
 * فئة مساعدة لفحص جاهزية القرص الصلب وتوفر المساحة الكافية للملفات الضخمة
 */
class DiskHealthChecker {
  /**
   * التأكد من وجود مجلد الرفع وإمكانية الكتابة فيه
   * @param {string} directoryPath - مسار المجلد المراد فحصه
   */
  static ensureDirectoryExists(directoryPath) {
    try {
      if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { recursive: true, mode: 0o755 });
        console.log(`[UploadMiddleware:Init] تم إنشاء مجلد التخزين المؤقت: ${directoryPath}`);
      }
      fs.accessSync(directoryPath, fs.constants.W_OK | fs.constants.R_OK);
      return true;
    } catch (err) {
      throw new UploadMiddlewareError(
        `تعذر الوصول أو الكتابة في مجلد التخزين المؤقت: ${directoryPath}`,
        'STORAGE_DIR_INACCESSIBLE',
        500,
        { originalError: err.message }
      );
    }
  }

  /**
   * تنظيف الملفات المؤقتة التي استقرت في المجلد أكثر من المدة المسموحة
   * @param {string} directoryPath - مسار المجلد
   * @param {number} maxAgeMs - المدة الزمنية القصوى بالمللي ثانية (افتراضياً ساعتان)
   */
  static purgeStaleTempFiles(directoryPath, maxAgeMs = 2 * 60 * 60 * 1000) {
    if (!fs.existsSync(directoryPath)) return;

    fs.readdir(directoryPath, (readErr, files) => {
      if (readErr) {
        console.error('[UploadMiddleware:Purge] فشل قراءة مجلد الرفع للتنظيف:', readErr.message);
        return;
      }

      const now = Date.now();
      files.forEach((file) => {
        const fullPath = path.join(directoryPath, file);
        fs.stat(fullPath, (statErr, stats) => {
          if (statErr) return;

          if (stats.isFile() && now - stats.mtimeMs > maxAgeMs) {
            fs.unlink(fullPath, (unlinkErr) => {
              if (!unlinkErr) {
                console.log(`[UploadMiddleware:Purge] تم حذف ملف مؤقت منتهي الصلاحية: ${file}`);
              }
            });
          }
        });
      });
    });
  }
}

/**
 * مدير تتبع ومراقبة الملفات المرفوعة أثناء دورة حياة الطلب
 */
class UploadSessionTracker extends EventEmitter {
  constructor() {
    super();
    this.activeTransfers = new Map();
  }

  /**
   * تسجيل بدء عملية نقل جديدة
   * @param {string} transferId - المعرف الفريد للعملية
   * @param {Object} details - تفاصيل العملية
   */
  registerTransfer(transferId, details) {
    this.activeTransfers.set(transferId, {
      ...details,
      bytesReceived: 0,
      startedAt: Date.now(),
      status: 'transferring',
    });
    this.emit('transfer:start', { transferId, details });
  }

  /**
   * تحديث حجم البيانات المستلمة
   * @param {string} transferId - المعرف الفريد
   * @param {number} chunkLength - حجم الكتلة المستلمة
   */
  updateProgress(transferId, chunkLength) {
    const session = this.activeTransfers.get(transferId);
    if (session) {
      session.bytesReceived += chunkLength;
      this.emit('transfer:progress', {
        transferId,
        bytesReceived: session.bytesReceived,
      });
    }
  }

  /**
   * إنهاء عملية النقل بنجاح
   * @param {string} transferId - المعرف الفريد
   */
  completeTransfer(transferId) {
    const session = this.activeTransfers.get(transferId);
    if (session) {
      session.status = 'completed';
      session.completedAt = Date.now();
      this.emit('transfer:complete', { transferId, session });
      this.activeTransfers.delete(transferId);
    }
  }

  /**
   * إلغاء عملية النقل وحذف سجلها
   * @param {string} transferId - المعرف الفريد
   */
  abortTransfer(transferId) {
    const session = this.activeTransfers.get(transferId);
    if (session) {
      session.status = 'aborted';
      this.emit('transfer:abort', { transferId, session });
      this.activeTransfers.delete(transferId);
    }
  }
}

const sessionTracker = new UploadSessionTracker();

/**
 * بناء محرك تخزين مخصص على القرص يضمن الأمان وتفادي تضارب التسميات
 * @param {string} destinationDirectory - المجلد المستهدف للتخزين
 * @returns {multer.StorageEngine}
 */
function createSecureDiskStorage(destinationDirectory) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        DiskHealthChecker.ensureDirectoryExists(destinationDirectory);
        cb(null, destinationDirectory);
      } catch (err) {
        cb(err, destinationDirectory);
      }
    },
    filename: (req, file, cb) => {
      try {
        // توليد بادئة عشوائية آمنة تشفيرياً
        const randomBytes = crypto.randomBytes(16).toString('hex');
        const timestamp = Date.now();

        // تنظيف امتداد الملف والتأكد من توافقه
        const ext = path.extname(file.originalname).toLowerCase();
        const baseName = path.basename(file.originalname, ext);

        // تطهير الاسم الأصلي من أي رموز غير مقبولة في أنظمة التشغيل المختلفة
        const sanitizedBase = baseName
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
          .replace(/[\\/:*?"<>|]+/g, '_')
          .slice(0, 50);

        const secureFileName = `upload_${timestamp}_${randomBytes}_${sanitizedBase}${ext}`;
        cb(null, secureFileName);
      } catch (err) {
        cb(new UploadMiddlewareError('فشل توليد اسم آمن للملف المرفوع.', 'FILENAME_GEN_ERROR', 500));
      }
    },
  });
}

/**
 * مرشح الملفات للتحقق الأولي من امتداد الملف ونوع الميديا المعلن قبل بدء استهلاك المساحة
 * @param {Object} req - كائن طلب Express
 * @param {Object} file - كائن الملف المقدم من Multer
 * @param {Function} cb - دالة الرد callback
 */
function validateIncomingFile(req, file, cb) {
  try {
    const extension = path.extname(file.originalname).toLowerCase();
    const reportedMime = file.mimetype ? file.mimetype.toLowerCase() : '';

    // 1. التحقق من الامتداد
    if (!extension || !SUPPORTED_EXTENSIONS.has(extension)) {
      return cb(
        new UploadMiddlewareError(
          `امتداد الملف (${extension || 'بدون امتداد'}) غير مدعوم. الصيغ المدعومة تشمل: PDF والصور والملفات النصية.`,
          'UNSUPPORTED_FILE_EXTENSION',
          415,
          { originalName: file.originalname, extension }
        ),
        false
      );
    }

    // 2. التحقق من نوع الـ MIME المعلن
    if (reportedMime && !SUPPORTED_MIME_TYPES.has(reportedMime) && reportedMime !== 'application/octet-stream') {
      return cb(
        new UploadMiddlewareError(
          `نوع المحتوى (${reportedMime}) غير مصرح به.`,
          'UNSUPPORTED_MIME_TYPE',
          415,
          { reportedMime, originalName: file.originalname }
        ),
        false
      );
    }

    // فحص سلامة الاسم ضد محاولات Path Traversal
    if (file.originalname.includes('..') || file.originalname.includes('/') || file.originalname.includes('\\')) {
      return cb(
        new UploadMiddlewareError(
          'اسم الملف يحتوي على مسارات غير مصرح بها أو غير آمنة.',
          'INVALID_FILENAME_SECURITY_RISK',
          400,
          { originalName: file.originalname }
        ),
        false
      );
    }

    cb(null, true);
  } catch (validationErr) {
    cb(
      new UploadMiddlewareError(
        `حدث خلل أثناء فحص صلاحية الملف: ${validationErr.message}`,
        'FILE_FILTER_EXCEPTION',
        500
      ),
      false
    );
  }
}

/**
 * إنشاء وسيط Multer مهيأ بالكامل لاستقبال الملفات حتى 400 ميغابايت
 * @param {Object} customOptions - خيارات التخصيص الإضافية
 * @returns {multer.Multer}
 */
export function configureUploadMiddleware(customOptions = {}) {
  const uploadDir = customOptions.uploadDir || DEFAULT_UPLOAD_DIR;
  const maxFileSize = customOptions.maxFileSize || DEFAULT_MAX_FILE_SIZE;

  DiskHealthChecker.ensureDirectoryExists(uploadDir);

  const storage = createSecureDiskStorage(uploadDir);

  return multer({
    storage: storage,
    limits: {
      fileSize: maxFileSize,
      files: 1, // السماح برفع ملف واحد لكل طلب تلخيص
      fields: 10,
      parts: 20,
    },
    fileFilter: validateIncomingFile,
  });
}

// النسخة الافتراضية الجاهزة للاستخدام في المسارات
const defaultUploadInstance = configureUploadMiddleware();

/**
 * دالة وسيطة مغلفة (Wrapper Middleware) للتعامل مع أخطاء الرفع وتوفير استجابات JSON منسقة باللغة العربية
 * @param {string} fieldName - اسم الحقل في الـ FormData (الافتراضي 'file')
 * @returns {Function} Express Middleware
 */
export function handleSingleFileUpload(fieldName = 'file') {
  const uploadSingle = defaultUploadInstance.single(fieldName);

  return (req, res, next) => {
    const uploadSessionId = `upl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    req.uploadSessionId = uploadSessionId;

    sessionTracker.registerTransfer(uploadSessionId, {
      ip: req.ip,
      method: req.method,
      url: req.originalUrl,
    });

    // مراقبة إلغاء اتصال العميل أثناء الرفع الكبير
    req.on('close', () => {
      if (!req.complete && req.file && req.file.path) {
        console.warn(`[UploadMiddleware:ClientAborted] قطع العميل الاتصال أثناء رفع الملف: ${req.file.path}`);
        sessionTracker.abortTransfer(uploadSessionId);
        cleanupOrphanFile(req.file.path);
      }
    });

    uploadSingle(req, res, (err) => {
      if (err) {
        sessionTracker.abortTransfer(uploadSessionId);

        // معالجة خطأ الحجم الزائد الخاص بـ Multer
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
              success: false,
              code: 'FILE_TOO_LARGE',
              error: `حجم الملف المرفوع تجاوز الحد الأقصى المسموح به (${formatBytes(DEFAULT_MAX_FILE_SIZE)}).`,
              maxAllowedBytes: DEFAULT_MAX_FILE_SIZE,
            });
          }

          if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
              success: false,
              code: 'UNEXPECTED_FIELD',
              error: `اسم حقل الملف في النموذج يجب أن يكون "${fieldName}". الحقل المستلم غير صالح.`,
              expectedField: fieldName,
            });
          }

          return res.status(400).json({
            success: false,
            code: `MULTER_${err.code}`,
            error: `حدث خلل في معالجة النموذج المرفوع: ${err.message}`,
          });
        }

        // معالجة أخطاء الفحص المخصص
        if (err instanceof UploadMiddlewareError) {
          return res.status(err.statusCode).json({
            success: false,
            code: err.code,
            error: err.message,
            context: err.context,
          });
        }

        // أخطاء غير متوقعة
        return res.status(500).json({
          success: false,
          code: 'UPLOAD_PROCESSING_FAILED',
          error: `تعذر إتمام عملية استلام الملف: ${err.message || 'خطأ غير معروف'}`,
        });
      }

      // التحقق من أن الملف تم استلامه بالفعل
      if (!req.file) {
        sessionTracker.abortTransfer(uploadSessionId);
        return res.status(400).json({
          success: false,
          code: 'MISSING_FILE',
          error: `لم يتم إرفاق أي ملف في الحقل المطلوب ("${fieldName}"). يرجى اختيار ملف قبل الإرسال.`,
        });
      }

      sessionTracker.completeTransfer(uploadSessionId);

      // تمرير معلومات إضافية منسقة للطلب لتسهيل التعامل معها في الـ Controllers
      req.fileDetails = {
        sessionId: uploadSessionId,
        originalName: req.file.originalname,
        storedPath: req.file.path,
        fileName: req.file.filename,
        sizeBytes: req.file.size,
        sizeFormatted: formatBytes(req.file.size),
        mimeType: req.file.mimetype,
        receivedAt: new Date().toISOString(),
      };

      next();
    });
  };
}

/**
 * حذف ملف يتيم بأمان بعد فشل العملية لتفادي تراكم الملفات على القرص
 * @param {string} filePath - مسار الملف المراد تنظيفه
 */
export function cleanupOrphanFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return;

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) return;

    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr) {
        console.error(`[UploadMiddleware:CleanupFailed] فشل حذف الملف اليتيم ${filePath}:`, unlinkErr.message);
      } else {
        console.log(`[UploadMiddleware:CleanupSuccess] تم حذف الملف المؤقت غير المكتمل: ${filePath}`);
      }
    });
  });
}

/**
 * تحويل الحجم بالبايت إلى صياغة بشرية مقروءة
 * @param {number} bytes - الحجم بالبايت
 * @param {number} decimals - دقة الخانات العشرية
 * @returns {string}
 */
export function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * فحص وتأكيد جاهزية نظام الرفع بالكامل
 * @returns {Object} تقرير حالة وسيط الرفع
 */
export function getUploadSubsystemStatus() {
  return {
    uploadDirectory: DEFAULT_UPLOAD_DIR,
    maxFileSizeAllowed: DEFAULT_MAX_FILE_SIZE,
    maxFileSizeFormatted: formatBytes(DEFAULT_MAX_FILE_SIZE),
    supportedExtensions: Array.from(SUPPORTED_EXTENSIONS),
    supportedMimeTypes: Array.from(SUPPORTED_MIME_TYPES),
    activeTransfersCount: sessionTracker.activeTransfers.size,
    isHealthy: fs.existsSync(DEFAULT_UPLOAD_DIR),
  };
}

// بدء دورة التنظيف الدوري للملفات المؤقتة كل 45 دقيقة
setInterval(() => {
  DiskHealthChecker.purgeStaleTempFiles(DEFAULT_UPLOAD_DIR);
}, 45 * 60 * 1000);

export default handleSingleFileUpload;
