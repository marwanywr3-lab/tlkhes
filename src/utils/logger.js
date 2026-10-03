
import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';

export const LOG_LEVELS = {
  DEBUG: { priority: 0, label: 'DEBUG', color: '\x1b[36m' }, // سماوي
  INFO: { priority: 1, label: 'INFO', color: '\x1b[32m' },   // أخضر
  WARN: { priority: 2, label: 'WARN', color: '\x1b[33m' },   // أصفر
  ERROR: { priority: 3, label: 'ERROR', color: '\x1b[31m' }, // أحمر
  FATAL: { priority: 4, label: 'FATAL', color: '\x1b[35m' }, // بنفسجي
};

const RESET_COLOR = '\x1b[0m';

export class Logger extends EventEmitter {
  /**
   * تهيئة نظام السجلات والمراقبة
   * @param {Object} options - إعدادات السجل
   */
  constructor(options = {}) {
    super();
    this.logsDirectory = options.logsDirectory || path.resolve('logs');
    this.minLevel = options.minLevel || 'INFO';
    this.enableFileLogging = options.enableFileLogging !== false;
    this.enableConsole = options.enableConsole !== false;
    this.maxLogFileSize = options.maxLogFileSize || 10 * 1024 * 1024; // 10MB
    this.writeQueue = [];
    this.isWriting = false;

    this.ensureLogDir();
  }

  /**
   * التأكد من وجود مجلد السجلات على الخادم
   */
  ensureLogDir() {
    try {
      if (!fs.existsSync(this.logsDirectory)) {
        fs.mkdirSync(this.logsDirectory, { recursive: true });
      }
    } catch (err) {
      console.error('[Logger:Error] تعذر إنشاء مجلد السجلات:', err.message);
    }
  }

  /**
   * تنسيق الرسالة مع البصمة الزمنية والبيانات المرفقة
   * @param {string} level - مستوى السجل
   * @param {string} message - نص الرسالة
   * @param {Object} context - بيانات وصفية إضافية
   * @returns {Object} كائن السجل المنسق
   */
  formatEntry(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    return {
      timestamp,
      level,
      message,
      context: Object.keys(context).length > 0 ? context : null,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      pid: process.pid,
    };
  }

  /**
   * كتابة السجل في سطر الأوامر (Console) بالألوان المحددة
   * @param {Object} entry - كائن السجل
   */
  printToConsole(entry) {
    if (!this.enableConsole) return;

    const levelConfig = LOG_LEVELS[entry.level] || LOG_LEVELS.INFO;
    const color = levelConfig.color;
    const prefix = `${color}[${entry.timestamp}] [${entry.level}]${RESET_COLOR}`;
    const contextStr = entry.context ? ` | Context: ${JSON.stringify(entry.context)}` : '';

    if (entry.level === 'ERROR' || entry.level === 'FATAL') {
      console.error(`${prefix} ${entry.message}${contextStr}`);
    } else if (entry.level === 'WARN') {
      console.warn(`${prefix} ${entry.message}${contextStr}`);
    } else {
      console.log(`${prefix} ${entry.message}${contextStr}`);
    }
  }

  /**
   * إدراج السجل في طابور الكتابة إلى الملف
   * @param {Object} entry - كائن السجل
   */
  queueWriteToFile(entry) {
    if (!this.enableFileLogging) return;

    const logLine = JSON.stringify(entry) + '\n';
    this.writeQueue.push(logLine);
    this.flushQueue();
  }

  /**
   * تفريغ طابور الكتابة إلى القرص بشكل غير متزامن وآمن
   */
  async flushQueue() {
    if (this.isWriting || this.writeQueue.length === 0) return;

    this.isWriting = true;
    const chunk = this.writeQueue.splice(0, 50).join('');
    const today = new Date().toISOString().slice(0, 10);
    const targetFile = path.join(this.logsDirectory, `app-${today}.log`);

    try {
      await fs.promises.appendFile(targetFile, chunk, 'utf8');
    } catch (err) {
      console.error('[Logger:WriteError] فشل كتابة السجل في الملف:', err.message);
    } finally {
      this.isWriting = false;
      if (this.writeQueue.length > 0) {
        setImmediate(() => this.flushQueue());
      }
    }
  }

  /**
   * تسجيل رسالة بمستوى محدد
   * @param {string} level - المستوى
   * @param {string} message - الرسالة
   * @param {Object} context - البيانات المرفقة
   */
  log(level, message, context = {}) {
    const currentPriority = LOG_LEVELS[this.minLevel]?.priority ?? 1;
    const targetPriority = LOG_LEVELS[level]?.priority ?? 1;

    if (targetPriority < currentPriority) return;

    const entry = this.formatEntry(level, message, context);
    this.printToConsole(entry);
    this.queueWriteToFile(entry);
    this.emit('log', entry);
  }

  debug(message, context = {}) {
    this.log('DEBUG', message, context);
  }

  info(message, context = {}) {
    this.log('INFO', message, context);
  }

  warn(message, context = {}) {
    this.log('WARN', message, context);
  }

  error(message, context = {}) {
    this.log('ERROR', message, context);
  }

  fatal(message, context = {}) {
    this.log('FATAL', message, context);
  }

  /**
   * وسيط Express لتسجيل ومتابعة أداء الطلبات اللحظية
   * @returns {Function}
   */
  httpMiddleware() {
    return (req, res, next) => {
      const startTime = process.hrtime();
      const clientIp = req.ip || req.connection.remoteAddress;

      res.on('finish', () => {
        const diff = process.hrtime(startTime);
        const durationMs = parseFloat((diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2));
        const statusCode = res.statusCode;

        const level = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';

        this.log(level, `HTTP ${req.method} ${req.originalUrl} [${statusCode}] (${durationMs}ms)`, {
          method: req.method,
          url: req.originalUrl,
          statusCode,
          durationMs,
          clientIp,
          userAgent: req.get('user-agent') || 'unknown',
        });
      });

      next();
    };
  }
}

// تصدير نسخة أحادية عامة
export const logger = new Logger();
export default logger;
