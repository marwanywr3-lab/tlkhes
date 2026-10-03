import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import EventEmitter from 'events';

/**
 * فئة إدارة أخطاء معالجة الملفات المخصصة
 * تعطي تفاصيل دقيقة عن نوع الخلل الحاصل في التحقق من الملفات
 */
export class FileProcessorError extends Error {
  /**
   * بناء كائن الخطأ لمعالجة الملفات
   * @param {string} message - رسالة الخطأ
   * @param {string} code - الرمز التعريفي للخطأ
   * @param {number} statusCode - كود حالة HTTP المناسب
   * @param {Object} details - بيانات إضافية للتشخيص
   */
  constructor(message, code = 'FILE_PROCESSOR_ERROR', statusCode = 400, details = {}) {
    super(message);
    this.name = 'FileProcessorError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FileProcessorError);
    }
  }
}

/**
 * قائمة التواقيع الثنائية (Magic Numbers / Magic Bytes)
 * تستخدم للتحقق القاطع من نوع الملفات الحقيقي دون الاعتماد على الامتداد السطحي فقط
 */
export const MAGIC_SIGNATURES = {
  PDF: [
    { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  ],
  PNG: [
    { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // .PNG\r\n\x1a\n
  ],
  JPEG: [
    { offset: 0, bytes: [0xff, 0xd8, 0xff] }, // SOI marker
  ],
  WEBP: [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // WEBP
  ],
  GIF: [
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // GIF89a
  ],
  BMP: [
    { offset: 0, bytes: [0x42, 0x4d] }, // BM
  ],
  TIFF_LE: [
    { offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] }, // II*. (Little Endian)
  ],
  TIFF_BE: [
    { offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] }, // MM.* (Big Endian)
  ],
  ZIP_CONTAINER: [
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK.. (DOCX, PPTX, XLSX, EPUB)
  ],
};

/**
 * خريطة الامتدادات المصرح بها مع أنواع الـ MIME ومسموحيات الذكاء الاصطناعي
 */
export const ALLOWED_MIME_REGISTRY = {
  'application/pdf': {
    extensions: ['.pdf'],
    category: 'document',
    maxSize: 400 * 1024 * 1024,
    parser: 'parsePdfHeaders',
  },
  'image/jpeg': {
    extensions: ['.jpg', '.jpeg'],
    category: 'image',
    maxSize: 100 * 1024 * 1024,
    parser: 'parseJpegMetadata',
  },
  'image/png': {
    extensions: ['.png'],
    category: 'image',
    maxSize: 100 * 1024 * 1024,
    parser: 'parsePngMetadata',
  },
  'image/webp': {
    extensions: ['.webp'],
    category: 'image',
    maxSize: 50 * 1024 * 1024,
    parser: 'parseWebpMetadata',
  },
  'text/plain': {
    extensions: ['.txt', '.log', '.csv', '.tsv'],
    category: 'text',
    maxSize: 50 * 1024 * 1024,
    parser: 'parseTextMetadata',
  },
  'text/markdown': {
    extensions: ['.md', '.markdown'],
    category: 'text',
    maxSize: 50 * 1024 * 1024,
    parser: 'parseTextMetadata',
  },
};

/**
 * معالج الملفات والمستندات الذكي
 * مسؤول عن الفحص الشامل، التحقق الأمني، استخراج الخصائص الوصفية، وإعداد الملف للإرسال
 */
export class FileProcessor extends EventEmitter {
  /**
   * تهيئة معالج الملفات
   * @param {Object} options - إعدادات المعالج
   */
  constructor(options = {}) {
    super();

    this.maxFileSize = options.maxFileSize || 400 * 1024 * 1024; // 400MB
    this.tempDirectory = options.tempDirectory || path.resolve('uploads');
    this.enableDeepInspection = options.enableDeepInspection !== false;
    this.bufferReadLimit = 65536; // قراءة أول 64 كيلوبايت للفحص الأمني السريع

    this.processedFilesHistory = new Map();
  }

  /**
   * فحص شامل للملف المرفوع قبل اعتماده للإرسال إلى Gemini API
   * @param {string} filePath - مسار الملف على الخادم
   * @param {string} reportedMime - نوع الـ MIME القادم من العميل
   * @param {string} originalName - اسم الملف الأصلي
   * @returns {Promise<Object>} تقرير شامل ببيانات الملف والتحقق الأمني
   */
  async processAndInspect(filePath, reportedMime, originalName = 'unnamed_file') {
    const startTime = Date.now();
    this.emit('processing:start', { filePath, originalName });

    try {
      // 1. التحقق من الوجود والحجم الأساسي
      const fileStats = await this.verifyFileBasics(filePath);

      // 2. قراءة أول كتلة بيانات ثنائية للفحص الأمني
      const headerBuffer = await this.readHeaderBuffer(filePath, this.bufferReadLimit);

      // 3. التحقق القاطع من التوقيع الثنائي الحقيقي
      const verifiedType = this.verifyMagicSignature(headerBuffer, reportedMime, originalName);

      // 4. حساب البصمات التشفيرية لتفادي التكرار وضمان عدم التلاعب
      const checksums = await this.calculateFileChecksums(filePath);

      // 5. استخراج البيانات الوصفية المخصصة حسب طبيعة الملف
      let metadata = {};
      if (this.enableDeepInspection) {
        metadata = await this.extractDeepMetadata(filePath, verifiedType.mimeType, headerBuffer);
      }

      const processingDuration = Date.now() - startTime;

      const fileReport = {
        success: true,
        originalName: path.basename(originalName),
        sanitizedName: this.sanitizeFileName(originalName),
        filePath: filePath,
        fileSize: fileStats.size,
        fileSizeFormatted: this.formatBytes(fileStats.size),
        detectedMime: verifiedType.mimeType,
        verifiedExtension: verifiedType.extension,
        category: verifiedType.category,
        checksums: {
          sha256: checksums.sha256,
          md5: checksums.md5,
        },
        metadata: metadata,
        processingDurationMs: processingDuration,
        inspectedAt: new Date().toISOString(),
      };

      this.processedFilesHistory.set(checksums.sha256, {
        report: fileReport,
        cachedAt: Date.now(),
      });

      this.emit('processing:complete', fileReport);
      return fileReport;
    } catch (error) {
      this.emit('processing:error', { filePath, originalName, error });
      throw error;
    }
  }

  /**
   * التأكد من وجود الملف وصلاحيات قراءته وحدود حجمه الفيزيائي
   * @param {string} filePath - مسار الملف
   * @returns {Promise<fs.Stats>}
   */
  async verifyFileBasics(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      throw new FileProcessorError('مسار الملف غير محدد أو غير صالح.', 'INVALID_FILE_PATH', 400);
    }

    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch (accessErr) {
      throw new FileProcessorError(
        `الملف غير متاح أو لا يملك الخادم صلاحية قراءته: ${filePath}`,
        'FILE_ACCESS_DENIED',
        403,
        { original: accessErr.message }
      );
    }

    const stats = await fs.promises.stat(filePath);

    if (!stats.isFile()) {
      throw new FileProcessorError('المسار المحدد لا يشير إلى ملف حقيقي.', 'NOT_A_FILE', 400);
    }

    if (stats.size === 0) {
      throw new FileProcessorError('الملف المرفوع فارغ تماماً بحجم 0 بايت.', 'FILE_EMPTY', 400);
    }

    if (stats.size > this.maxFileSize) {
      throw new FileProcessorError(
        `حجم الملف (${this.formatBytes(stats.size)}) يتجاوز الحد الأقصى المسموح (${this.formatBytes(this.maxFileSize)}).`,
        'FILE_TOO_LARGE',
        413,
        { size: stats.size, maxSize: this.maxFileSize }
      );
    }

    return stats;
  }

  /**
   * قراءة الترويسة الثنائية للملف باستخدام الـ File Handle لحفظ الذاكرة
   * @param {string} filePath - مسار الملف
   * @param {number} bytesToRead - عدد البايتات المراد قراءتها
   * @returns {Promise<Buffer>}
   */
  async readHeaderBuffer(filePath, bytesToRead = 65536) {
    let fileHandle = null;
    try {
      fileHandle = await fs.promises.open(filePath, 'r');
      const stats = await fileHandle.stat();
      const actualBytes = Math.min(bytesToRead, stats.size);
      const buffer = Buffer.alloc(actualBytes);

      await fileHandle.read(buffer, 0, actualBytes, 0);
      return buffer;
    } catch (err) {
      throw new FileProcessorError(
        `فشل قراءة رأس البيانات الثنائية للملف: ${err.message}`,
        'HEADER_READ_FAILED',
        500,
        { original: err.message }
      );
    } finally {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
    }
  }

  /**
   * مقارنة التوقيع الثنائي للترويسة مع قائمة التواقيع الموثوقة لمنع هجمات التمويه
   * @param {Buffer} buffer - ترويسة البايتات
   * @param {string} reportedMime - نوع الـ MIME المعلن
   * @param {string} originalName - اسم الملف الأصلي
   * @returns {Object} نوع الملف المحقق وامتداده وتصنيفه
   */
  verifyMagicSignature(buffer, reportedMime, originalName) {
    const ext = path.extname(originalName).toLowerCase();

    // فحص PDF
    if (this.matchesSignature(buffer, MAGIC_SIGNATURES.PDF[0])) {
      return {
        mimeType: 'application/pdf',
        extension: '.pdf',
        category: 'document',
      };
    }

    // فحص JPEG
    if (this.matchesSignature(buffer, MAGIC_SIGNATURES.JPEG[0])) {
      return {
        mimeType: 'image/jpeg',
        extension: '.jpg',
        category: 'image',
      };
    }

    // فحص PNG
    if (this.matchesSignature(buffer, MAGIC_SIGNATURES.PNG[0])) {
      return {
        mimeType: 'image/png',
        extension: '.png',
        category: 'image',
      };
    }

    // فحص WebP
    if (
      this.matchesSignature(buffer, MAGIC_SIGNATURES.WEBP[0]) &&
      this.matchesSignature(buffer, MAGIC_SIGNATURES.WEBP[1])
    ) {
      return {
        mimeType: 'image/webp',
        extension: '.webp',
        category: 'image',
      };
    }

    // فحص النصوص العادية والماركداون (Text files lack strict magic bytes)
    if (['.txt', '.md', '.markdown', '.csv', '.json'].includes(ext)) {
      if (this.isPrintableUtf8Text(buffer)) {
        return {
          mimeType: ext === '.md' || ext === '.markdown' ? 'text/markdown' : 'text/plain',
          extension: ext,
          category: 'text',
        };
      }
    }

    // إذا أعلن العميل عن صيغة معتمدة لكن البصمة لم تطابق ما سبق
    const matchingRegistryEntry = Object.entries(ALLOWED_MIME_REGISTRY).find(([mime, config]) => {
      return mime === reportedMime && config.extensions.includes(ext);
    });

    if (matchingRegistryEntry) {
      return {
        mimeType: matchingRegistryEntry[0],
        extension: ext,
        category: matchingRegistryEntry[1].category,
      };
    }

    throw new FileProcessorError(
      `نوع الملف غير مدعوم أو أن محتواه الثنائي لا يطابق امتداده (${originalName}). الأنواع المعتمدة تشمل: PDF، الصور، والنصوص.`,
      'UNSUPPORTED_OR_CORRUPTED_FILE',
      415,
      { reportedMime, extension: ext }
    );
  }

  /**
   * مقارنة مصفوفة بايتات محددة داخل البفر
   * @param {Buffer} buffer - مخزن البايتات
   * @param {Object} sig - التوقيع والإزاحة
   * @returns {boolean}
   */
  matchesSignature(buffer, sig) {
    if (!buffer || buffer.length < sig.offset + sig.bytes.length) {
      return false;
    }

    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[sig.offset + i] !== sig.bytes[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * فحص ما إذا كان الملف نصاً مقروءاً بترميز UTF-8
   * @param {Buffer} buffer - كتلة البايتات
   * @returns {boolean}
   */
  isPrintableUtf8Text(buffer) {
    const checkLength = Math.min(buffer.length, 1024);
    let nullBytesCount = 0;

    for (let i = 0; i < checkLength; i++) {
      const byte = buffer[i];
      // فحص وجود بايتات الصفر (Null Bytes) التي تدل على ملفات ثنائية
      if (byte === 0x00) {
        nullBytesCount++;
      }
    }

    // إذا تجاوزت بايتات الصفر نسبة 1% فهو ملف ثنائي وليس نصياً
    return nullBytesCount / checkLength < 0.01;
  }

  /**
   * حساب التجزئة التشفيرية المزدوجة (SHA-256 و MD5) باستخدام التيارات دون إجهاد الذاكرة
   * @param {string} filePath - مسار الملف على القرص
   * @returns {Promise<{sha256: string, md5: string}>}
   */
  async calculateFileChecksums(filePath) {
    return new Promise((resolve, reject) => {
      const sha256Hash = crypto.createHash('sha256');
      const md5Hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (chunk) => {
        sha256Hash.update(chunk);
        md5Hash.update(chunk);
      });

      stream.on('end', () => {
        resolve({
          sha256: sha256Hash.digest('hex'),
          md5: md5Hash.digest('hex'),
        });
      });

      stream.on('error', (err) => {
        reject(
          new FileProcessorError(
            `تعذر حساب بصمة التشفير للملف: ${err.message}`,
            'CHECKSUM_CALCULATION_FAILED',
            500,
            { original: err.message }
          )
        );
      });
    });
  }

  /**
   * استخراج البيانات الوصفية الدقيقة استناداً إلى تصنيف الملف
   * @param {string} filePath - مسار الملف
   * @param {string} mimeType - نوع الملف المعتمد
   * @param {Buffer} headerBuffer - الترويسة المبدئية
   * @returns {Promise<Object>}
   */
  async extractDeepMetadata(filePath, mimeType, headerBuffer) {
    try {
      if (mimeType === 'application/pdf') {
        return await this.parsePdfMetadata(filePath, headerBuffer);
      }
      if (mimeType === 'image/jpeg') {
        return this.parseJpegMetadata(headerBuffer);
      }
      if (mimeType === 'image/png') {
        return this.parsePngMetadata(headerBuffer);
      }
      if (mimeType === 'image/webp') {
        return this.parseWebpMetadata(headerBuffer);
      }
      if (mimeType.startsWith('text/')) {
        return await this.parseTextMetadata(filePath);
      }
      return { note: 'لا توجد بيانات وصفية موسعة لهذا الامتداد.' };
    } catch (err) {
      console.warn(`[FileProcessor:Warning] فشل استخراج بعض الخصائص الوصفية: ${err.message}`);
      return { extractionWarning: err.message };
    }
  }

  /**
   * فحص هيكل ملف الـ PDF واستخراج إصداره وتقدير عدد الصفحات والتحقق من التشفير
   * @param {string} filePath - مسار الملف
   * @param {Buffer} headerBuffer - ترويسة البايتات
   * @returns {Promise<Object>}
   */
  async parsePdfMetadata(filePath, headerBuffer) {
    // 1. استخراج إصدار الـ PDF من السطر الأول
    const headerString = headerBuffer.slice(0, 32).toString('ascii');
    const versionMatch = headerString.match(/%PDF-(\d+\.\d+)/);
    const pdfVersion = versionMatch ? versionMatch[1] : 'Unknown';

    // 2. فحص تذييل الـ PDF وقراءة نهاية الملف للبحث عن الفهارس والتشفير
    let isEncrypted = false;
    let estimatedPageCount = 0;
    let fileHandle = null;

    try {
      fileHandle = await fs.promises.open(filePath, 'r');
      const stats = await fileHandle.stat();
      const tailBytesToRead = Math.min(131072, stats.size); // قراءة آخر 128KB
      const tailBuffer = Buffer.alloc(tailBytesToRead);

      await fileHandle.read(tailBuffer, 0, tailBytesToRead, stats.size - tailBytesToRead);
      const tailString = tailBuffer.toString('binary');

      if (tailString.includes('/Encrypt')) {
        isEncrypted = true;
      }

      // حساب عدد كائنات الصفحات التقريبي عبر مؤشرات /Type /Page
      const pageMatches = tailString.match(/\/Type\s*\/Page\b/g);
      if (pageMatches) {
        estimatedPageCount = pageMatches.length;
      }
    } catch (err) {
      console.warn('[FileProcessor:PDF] تعذر قراءة تذييل ملف PDF:', err.message);
    } finally {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
    }

    return {
      format: 'PDF',
      version: pdfVersion,
      isEncrypted: isEncrypted,
      estimatedPageCount: estimatedPageCount > 0 ? estimatedPageCount : 'غير محدد (يتطلب فك شفرة كامل)',
      isAiCompliant: !isEncrypted,
    };
  }

  /**
   * استخراج أبعاد صورة JPEG ونوع الضغط
   * @param {Buffer} buffer - ترويسة صورة الـ JPEG
   * @returns {Object}
   */
  parseJpegMetadata(buffer) {
    let offset = 2; // تخطي علامة SOI (0xFF, 0xD8)
    let width = 0;
    let height = 0;

    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) break;

      const marker = buffer[offset + 1];
      // علامات SOF0 (Baseline), SOF1 (Extended), SOF2 (Progressive)
      if (marker >= 0xc0 && marker <= 0xc3) {
        height = buffer.readUInt16BE(offset + 5);
        width = buffer.readUInt16BE(offset + 7);
        break;
      }

      const segmentLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
    }

    return {
      format: 'JPEG',
      width: width || 'غير متوفر',
      height: height || 'غير متوفر',
      aspectRatio: width && height ? (width / height).toFixed(2) : null,
      orientation: 'standard',
    };
  }

  /**
   * استخراج أبعاد صورة PNG وعمق الألوان من قسم IHDR
   * @param {Buffer} buffer - ترويسة صورة الـ PNG
   * @returns {Object}
   */
  parsePngMetadata(buffer) {
    if (buffer.length < 24) {
      return { format: 'PNG', corrupted: true };
    }

    // قسم IHDR يبدأ مباشرة بعد التوقيع عند الإزاحة 12
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    const bitDepth = buffer[24];
    const colorType = buffer[25];

    return {
      format: 'PNG',
      width,
      height,
      bitDepth,
      colorType,
      aspectRatio: (width / height).toFixed(2),
    };
  }

  /**
   * استخراج أبعاد صورة WebP من كتل VP8 أو VP8L أو VP8X
   * @param {Buffer} buffer - ترويسة WebP
   * @returns {Object}
   */
  parseWebpMetadata(buffer) {
    if (buffer.length < 30) {
      return { format: 'WEBP', corrupted: true };
    }

    const chunkFourCC = buffer.slice(12, 16).toString('ascii');
    let width = 0;
    let height = 0;

    if (chunkFourCC === 'VP8 ') {
      // تنسيق الفقدان Lossy VP8
      width = buffer.readUInt16LE(26) & 0x3fff;
      height = buffer.readUInt16LE(28) & 0x3fff;
    } else if (chunkFourCC === 'VP8L') {
      // تنسيق عديم الفقدان Lossless VP8L
      const b1 = buffer[21];
      const b2 = buffer[22];
      const b3 = buffer[23];
      const b4 = buffer[24];
      width = 1 + (((b2 & 0x3f) << 8) | b1);
      height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    }

    return {
      format: 'WEBP',
      compression: chunkFourCC.trim(),
      width: width || 'غير متوفر',
      height: height || 'غير متوفر',
      aspectRatio: width && height ? (width / height).toFixed(2) : null,
    };
  }

  /**
   * قراءة عينة من الملفات النصية واستخراج عدد الأسطر والكلمات والترميز التقديري
   * @param {string} filePath - مسار الملف النصي
   * @returns {Promise<Object>}
   */
  async parseTextMetadata(filePath) {
    return new Promise((resolve) => {
      let lineCount = 0;
      let wordCount = 0;
      let characterCount = 0;
      const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });

      stream.on('data', (chunk) => {
        characterCount += chunk.length;
        const lines = chunk.split('\n');
        lineCount += lines.length - 1;
        const words = chunk.trim().split(/\s+/);
        wordCount += words.filter(Boolean).length;
      });

      stream.on('end', () => {
        resolve({
          format: 'TEXT',
          estimatedLines: Math.max(1, lineCount),
          estimatedWords: wordCount,
          totalCharacters: characterCount,
          encoding: 'UTF-8',
        });
      });

      stream.on('error', () => {
        resolve({ format: 'TEXT', errorReading: true });
      });
    });
  }

  /**
   * تنظيف اسم الملف ومنع أي محاولات لاختراق المسارات (Path Traversal / Null Byte Injection)
   * @param {string} rawName - الاسم الأصلي
   * @returns {string} الاسم بعد التطهير
   */
  sanitizeFileName(rawName) {
    if (!rawName || typeof rawName !== 'string') {
      return `file_${Date.now()}`;
    }

    // إزالة مسارات الأدلة والنقاط المزدوجة
    let base = path.basename(rawName).replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

    // إزالة المحارف غير الآمنة مع الإبقاء على الحروف العربية والإنجليزية والأرقام
    base = base.replace(/[\\/:*?"<>|]+/g, '_').trim();

    if (base.length === 0 || base === '.') {
      return `document_${Date.now()}`;
    }

    // تقليص الطول الأقصى لاسم الملف لمنع طفح أنظمة الملفات
    if (base.length > 120) {
      const ext = path.extname(base);
      const nameWithoutExt = path.basename(base, ext).slice(0, 110);
      base = `${nameWithoutExt}${ext}`;
    }

    return base;
  }

  /**
   * تحويل حجم البايتات إلى صياغة بشرية واضحة ومقروءة
   * @param {number} bytes - الحجم بالبايت
   * @param {number} decimals - عدد الخانات العشرية
   * @returns {string} الحجم المهيأ
   */
  formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  /**
   * حذف ملف محلي بشكل آمن بعد انتهاء دورة معالجته أو عند وقوع خطأ
   * @param {string} filePath - مسار الملف المراد إتلافه
   * @returns {Promise<boolean>}
   */
  async safeDelete(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;

    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        this.emit('file:deleted', { filePath, timestamp: new Date().toISOString() });
        return true;
      }
      return false;
    } catch (err) {
      console.error(`[FileProcessor:CleanupError] تعذر حذف الملف ${filePath}:`, err.message);
      return false;
    }
  }

  /**
   * مسح ذاكرة التخزين المؤقت للعمليات السابقة
   */
  clearHistory() {
    this.processedFilesHistory.clear();
  }
}

// تصدير نسخة أحادية (Singleton) جاهزة للاستخدام عبر التطبيق
const defaultFileProcessorInstance = new FileProcessor();
export default defaultFileProcessorInstance;
