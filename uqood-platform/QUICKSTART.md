# دليل التشغيل السريع لنظام «عُقود»
# Uqood Platform - Quick Start Guide

## المتطلبات المسبقة | Prerequisites

- **Node.js** v20+ 
- **npm** v10+
- **Docker** و **Docker Compose** (لتشغيل PostgreSQL و Redis)
- **Git**

## خطوات التثبيت | Installation Steps

### 1. استنساخ المستودع | Clone Repository

```bash
cd /workspace/uqood-platform
```

### 2. تثبيت التبعيات | Install Dependencies

```bash
npm install
```

### 3. إعداد متغيرات البيئة | Environment Setup

```bash
# انسخ ملف المثال
cp .env.example .env

# عدل القيم في ملف .env (خاصة كلمات المرور)
# Edit values in .env file (especially passwords)
```

**القيم المطلوبة للتطوير المحلي:**
- `DB_PASSWORD`: غيّر كلمة المرور الافتراضية
- `JWT_SECRET`: أنشئ قيمة عشوائية آمنة
- `SESSION_SECRET`: أنشئ قيمة عشوائية آمنة

### 4. تشغيل قواعد البيانات | Start Databases

```bash
# تشغيل PostgreSQL و Redis عبر Docker
docker-compose up -d

# التحقق من الحالة
docker-compose ps
```

يجب أن ترى:
- `uqood_postgres` - يعمل على المنفذ 5432
- `uqood_redis` - يعمل على المنفذ 6379

### 5. تهيئة قاعدة البيانات | Initialize Database

```bash
# توليد عميل Prisma
npm run db:generate

# تشغيل الترحيلات الأولى
npm run db:migrate

# (اختياري) ملء البيانات التجريبية
npm run db:seed
```

### 6. تشغيل الخادم | Start Server

```bash
# تطوير مع إعادة التحميل التلقائي
npm run dev

# أو تشغيل الإنتاج
npm run build
npm run start
```

الخادم سيعمل على: `http://localhost:8080`

## اختبار النظام | Testing

### تشغيل اختبارات قاعدة البيانات

```bash
cd packages/database
npm test
```

### اختبار API

```bash
# اختبار نقطة الدخول
curl http://localhost:8080/api/health

# اختبار المصادقة (بعد إنشاء مستخدم)
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@example.com","password":"secure_password"}'
```

## الهيكل الأساسي | Project Structure

```
uqood-platform/
├── apps/
│   ├── web/              # تطبيق الويب (Next.js) - قيد التطوير
│   └── mobile/           # تطبيق الجوال (React Native) - قيد التطوير
├── packages/
│   ├── api/              # واجهة برمجة التطبيقات (Hono)
│   ├── database/         # مخطط Prisma وقاعدة البيانات
│   └── ui/               # مكتبة المكونات (قيد الإنشاء)
├── docker-compose.yml    # إعدادات Docker
├── .env.example          # مثال متغيرات البيئة
└── README.md             # هذا الملف
```

## الأوامر المتاحة | Available Commands

| الأمر | الوصف |
|-------|-------|
| `npm install` | تثبيت جميع التبعيات |
| `npm run dev` | تشغيل خادم التطوير |
| `npm run build` | بناء المشروع للإنتاج |
| `npm run start` | تشغيل خادم الإنتاج |
| `npm run db:migrate` | تشغيل ترحيلات قاعدة البيانات |
| `npm run db:generate` | توليد عميل Prisma |
| `npm run db:studio` | فتح Prisma Studio |
| `docker-compose up -d` | تشغيل قواعد البيانات |
| `docker-compose down` | إيقاف قواعد البيانات |

## التحقق من الصحة | Health Checks

```bash
# التحقق من PostgreSQL
docker exec uqood_postgres pg_isready -U uqood_user -d uqood_db

# التحقق من Redis
docker exec uqood_redis redis-cli ping

# التحقق من API
curl http://localhost:8080/api/health
```

## الخطوات التالية | Next Steps

### المرحلة 1 - الأساس (جارية)
- ✅ قاعدة البيانات ومخطط Prisma
- ✅ Docker وبيئة التطوير
- ✅ نظام المصادقة
- ⏳ إدارة القوالب العقدية
- ⏳ دورة حياة العقد
- ⏳ رفع الملفات
- ⏳ سجل التدقيق

### المراحل القادمة
2. **الاعتمادات والشركاء** - نظام Maker-Checker
3. **المالية** - دفتر الحركات والدفعات
4. **الذكاء الاصطناعي** - OCR واستخراج البيانات
5. **التعاون والجوال** - المحادثات وتطبيق الجوال
6. **التوسع** - Webhooks والتوقيع الرقمي

## الدعم | Support

للمشاكل التقنية أو الأسئلة:
1. راجع ملف `.env.example` للتأكد من الإعدادات
2. تحقق من سجلات Docker: `docker-compose logs -f`
3. تأكد من تشغيل جميع الخدمات: `docker-compose ps`

---

**الإصدار**: 1.1  
**الحالة**: مسودة للمراجعة  
**التاريخ**: يوليو 2026
