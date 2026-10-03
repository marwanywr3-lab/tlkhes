import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { createServer } from 'http';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// إعداد الثوابت والمتغيرات التشغيلية الأساسية
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_UPLOAD_SIZE_MB = parseInt(process.env.MAX_UPLOAD_SIZE_MB, 10) || 400;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const UPLOAD_DIR = path.resolve(rootDir, process.env.UPLOAD_DIR || 'uploads');
const PUBLIC_DIR = path.resolve(rootDir, 'public');

function initializeDirectories() {
  const dirs = [UPLOAD_DIR, path.join(rootDir, 'logs')];
  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[Init] Created directory: ${dir}`);
      } catch (err) {
        console.error(`[Error] Failed to create directory ${dir}:`, err);
        process.exit(1);
      }
    }
  });
}

initializeDirectories();

const app = express();
const httpServer = createServer(app);

// تتبع الاتصالات النشطة لضمان الإغلاق الآمن (Graceful Shutdown)
const activeConnections = new Set();
httpServer.on('connection', (socket) => {
  activeConnections.add(socket);
  socket.on('close', () => {
    activeConnections.delete(socket);
  });
});

const systemHealth = {
  startedAt: new Date(),
  totalRequests: 0,
  activeUploads: 0,
  peakMemoryMB: 0,
  getMemoryMetrics() {
    const memory = process.memoryUsage();
    const heapUsedMB = Math.round(memory.heapUsed / 1024 / 1024);
    const rssMB = Math.round(memory.rss / 1024 / 1024);
    if (rssMB > this.peakMemoryMB) {
      this.peakMemoryMB = rssMB;
    }
    return {
      heapUsedMB,
      rssMB,
      peakMemoryMB: this.peakMemoryMB,
      systemFreeMB: Math.round(os.freemem() / 1024 / 1024),
      systemTotalMB: Math.round(os.totalmem() / 1024 / 1024),
    };
  }
};

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      // السماح بطلبات السيرفر الداخلي أو المسارات المحددة
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Cross-Origin Request Blocked by Security Policy'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true,
    maxAge: 86400, // 24 hours preflight cache
  })
);

app.use(
  compression({
    filter: (req, res) => {
      if (req.headers['x-no-compression']) {
        return false;
      }
      return compression.filter(req, res);
    },
    level: 6,
    threshold: 1024,
  })
);

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.use((req, res, next) => {
  systemHealth.totalRequests++;
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const startTime = process.hrtime();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const diff = process.hrtime(startTime);
    const timeInMs = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2);
    const memory = systemHealth.getMemoryMetrics();

    if (NODE_ENV !== 'test') {
      const logTag = `[${req.method}] ${req.originalUrl}`;
      const statusTag = `Status: ${res.statusCode} (${timeInMs}ms)`;
      const memoryTag = `Heap: ${memory.heapUsedMB}MB / RSS: ${memory.rssMB}MB`;
      console.log(`[Trace:${requestId}] ${logTag} -> ${statusTag} | ${memoryTag}`);
    }
  });

  next();
});

app.use((req, res, next) => {
  const memory = systemHealth.getMemoryMetrics();
  // إذا قلت الذاكرة الشاغرة عن 150 ميغابايت نمنع العمليات الجديدة مؤقتاً لحماية النظام
  if (memory.systemFreeMB < 150) {
    console.warn(`[Warning] Memory threshold exceeded. Free: ${memory.systemFreeMB}MB`);
    return res.status(503).json({
      success: false,
      error: 'الخادم يمر بضغط عالٍ في الذاكرة حالياً، يرجى إعادة المحاولة بعد ثوانٍ قليلة.',
      code: 'SERVER_UNDER_PRESSURE',
    });
  }
  next();
});

app.use(
  express.static(PUBLIC_DIR, {
    maxAge: NODE_ENV === 'production' ? '1d' : '0',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  })
);

app.get('/api/health', (req, res) => {
  const memory = systemHealth.getMemoryMetrics();
  const uptimeSeconds = Math.floor((new Date() - systemHealth.startedAt) / 1000);

  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: `${uptimeSeconds}s`,
    environment: NODE_ENV,
    limits: {
      maxUploadAllowedMB: MAX_UPLOAD_SIZE_MB,
      supportedModels: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
    },
    performance: {
      totalHandledRequests: systemHealth.totalRequests,
      activeUploadOperations: systemHealth.activeUploads,
      memory,
    },
  });
});

// سنقوم في الملفات التالية بربط مصفوفة المتحكمات (Controllers) والخدمات (Services)
app.use('/api/v1/summarize', (req, res, next) => {
  // تتبع العمليات المرفوعة
  systemHealth.activeUploads++;
  res.on('finish', () => {
    systemHealth.activeUploads = Math.max(0, systemHealth.activeUploads - 1);
  });
  next();
});

app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'نقطة النهاية المطلوبة غير موجودة في واجهة التطبيق البرمجية.',
    code: 'ROUTE_NOT_FOUND',
    path: req.originalUrl,
  });
});

// توجيه باقي الطلبات إلى واجهة المستخدم الأحادية
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('جاري إعداد الصفحة الرئيسية...');
  }
});

app.use((err, req, res, next) => {
  const requestId = req.id || 'untracked';
  console.error(`[Error:Handler][Req:${requestId}]`, err);

  // معالجة أخطاء الحجم الزائد (Payload Too Large)
  if (err.code === 'LIMIT_FILE_SIZE' || err.status === 413) {
    return res.status(413).json({
      success: false,
      error: `حجم الملف المرفوع تجاوز الحد الأقصى المسموح به (${MAX_UPLOAD_SIZE_MB} ميغابايت).`,
      code: 'FILE_TOO_LARGE',
    });
  }

  // أخطاء التنسيق وفك تشفير الـ JSON
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'هيكل بيانات JSON المرسل غير صالح.',
      code: 'INVALID_JSON_PAYLOAD',
    });
  }

  // أخطاء الـ CORS
  if (err.message && err.message.includes('Cross-Origin Request Blocked')) {
    return res.status(403).json({
      success: false,
      error: 'غير مصرح بالوصول من هذا النطاق الخارجي.',
      code: 'CORS_VIOLATION',
    });
  }

  // الخطأ العام الافتراضي
  res.status(err.status || 500).json({
    success: false,
    error: NODE_ENV === 'production' 
      ? 'حدث خطأ تقني داخلي في الخادم، يرجى المحاولة لاحقاً.' 
      : (err.message || 'Internal Server Error'),
    code: err.code || 'INTERNAL_ERROR',
    requestId,
  });
});

function cleanupZombieUploads() {
  const maxAgeMs = 2 * 60 * 60 * 1000; // ساعتان
  const now = Date.now();

  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) {
      console.error('[Cleanup] Error reading uploads directory:', err);
      return;
    }

    files.forEach((file) => {
      const filePath = path.join(UPLOAD_DIR, file);
      fs.stat(filePath, (statErr, stats) => {
        if (!statErr && now - stats.mtimeMs > maxAgeMs) {
          fs.unlink(filePath, (unlinkErr) => {
            if (!unlinkErr) {
              console.log(`[Cleanup] Removed stale upload file: ${file}`);
            }
          });
        }
      });
    });
  });
}

// تشغيل دورة التنظيف الدوري كل 30 دقيقة
setInterval(cleanupZombieUploads, 30 * 60 * 1000);

function handleGracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}. Starting graceful shutdown...`);

  httpServer.close((err) => {
    if (err) {
      console.error('[Shutdown] Error while closing HTTP server:', err);
      process.exit(1);
    }
    console.log('[Shutdown] Closed all HTTP listeners.');

    // تنظيف الاتصالات المفتوحة المعلقة
    for (const socket of activeConnections) {
      socket.destroy();
    }
    activeConnections.clear();

    console.log('[Shutdown] Application cleanly terminated.');
    process.exit(0);
  });

  // فرض الإغلاق بعد مهلة زمنية قصوى في حال تعليق أي عملية
  setTimeout(() => {
    console.error('[Shutdown] Forceful termination triggered due to timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Fatal] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[Fatal] Uncaught Exception:', error);
  handleGracefulShutdown('UNCAUGHT_EXCEPTION');
});

httpServer.listen(PORT, HOST, () => {
  console.log('='.repeat(65));
  console.log(` ✨ AI Document Summarizer & Contextual Chat Server`);
  console.log(` 🚀 Server Listening on: http://${HOST}:${PORT}`);
  console.log(` 📂 Upload Directory: ${UPLOAD_DIR}`);
  console.log(` 📦 Max File Size Allowed: ${MAX_UPLOAD_SIZE_MB} MB`);
  console.log(` 🤖 Active Models: Gemini 3.5 Flash Lite & Gemini 3.8 Flash`);
  console.log(` 🌍 Environment: ${NODE_ENV}`);
  console.log('='.repeat(65));
});

export default app;
