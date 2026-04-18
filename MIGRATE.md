# 🔄 النقل لجهاز جديد

> الإضافة قابلة للتنقّل بين الأجهزة بنفس الـ Extension ID.
> `key` في manifest.json يضمن الهوية الثابتة.

---

## 📋 قائمة مختصرة

1. انسخ مجلّد `claude-companion/` (دون `node_modules/` و `.pem`)
2. على الجهاز الجديد: ثبّت Node.js + Claude CLI
3. شغّل `install.ps1`
4. حمّل الإضافة من `chrome://extensions`
5. استورد الإعدادات من Export JSON أو انسخ `user-data.json`

---

## 🗂️ ما ينتقل مع المشروع

| يُنقل | لماذا |
|-------|------|
| `extension/` كامل | الكود + `manifest.json` مع `key` الثابت |
| `host/native-host.js` + `host/mcp-server.js` | كود native host + MCP |
| `host/package.json` | قائمة الاعتماديات (npm يحمّلها) |
| `install.ps1` / `install.sh` | المثبِّتات |
| `CLAUDE.md`, `README.md`, `MIGRATE.md` | توثيق |

## 🚫 ما لا يُنقل

| يُستثنى | البديل |
|---------|-------|
| `host/node_modules/` | `npm install` يعيد إنشاءها |
| `host/com.anthropic.claude_companion.json` | `install.ps1` يُولِّده بمسارات جديدة |
| `host/native-host-wrapper.bat` | نفس السبب |
| `.extension-private-key.pem` | اختياري — للنشر على Web Store فقط |
| `~/.config/claude-companion/config.json` | secret جديد يُولَّد تلقائياً |

## 💾 ما تريد نقله يدوياً (اختياري)

| الملف | كيف |
|-------|-----|
| Memories + Tasks | Export من الإعدادات → Import في الجديد |
| `~/.config/claude-companion/user-data.json` | انسخ كما هو (بديل لـ Export/Import) |
| تاريخ المحادثات | غير مدعوم حالياً في Export |

---

## 🔧 خطوات مفصّلة

### على الجهاز القديم (مرّة واحدة)

1. افتح إعدادات الإضافة → `⬇ تصدير`
2. احفظ `claude-companion-settings-YYYY-MM-DD.json` في مكان آمن
3. انسخ كامل مجلّد المشروع (بدون `node_modules/`)

### على الجهاز الجديد

```powershell
# 1. Node.js v18+
# ↳ nodejs.org → LTS installer

# 2. Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude login    # يفتح المتصفح

# 3. فك ضغط المشروع أو git clone
cd C:\path\to\claude-companion

# 4. ثبّت اعتماديات host
cd host
npm install
cd ..

# 5. سجّل Native Host + MCP
.\install.ps1   # PowerShell — Windows
# أو
./install.sh    # Bash — macOS/Linux
```

### في المتصفح

1. `brave://extensions` أو `chrome://extensions`
2. فعّل **"وضع المطوِّر"** (أعلى يمين)
3. **"تحميل غير مُضغوط"** → اختر مجلّد `extension/`
4. ستظهر Claude Companion بـ ID: `bciopdghgdndoedlgbbcffgaebjbkago` ✓
5. أعد تشغيل المتصفح (registry يُقرأ عند startup فقط)

### استعادة الإعدادات

**طريقة 1: Import JSON**
- افتح إعدادات الإضافة → `⬆ استيراد` → اختر ملف JSON المُصدَّر

**طريقة 2: نسخ user-data.json**
```powershell
# Windows
# من الجهاز القديم:
copy %USERPROFILE%\.config\claude-companion\user-data.json backup.json

# على الجهاز الجديد:
mkdir %USERPROFILE%\.config\claude-companion
copy backup.json %USERPROFILE%\.config\claude-companion\user-data.json
```
ثم أعد تشغيل الإضافة (disable → enable) ← تستعيد تلقائياً.

---

## ⚠️ تنبيهات

- **لا تنسخ `.extension-private-key.pem`** لجهاز غير موثوق — من يملكها يمكنه نشر إضافة مزوَّرة بنفس ID.
- **لا تنسخ `config.json`** الذي فيه secret — غير ضروري (يُولَّد على كل جهاز) + يعرّضك لخطر التقاطع لو شاركت الجهاز.
- **Max subscription على عدّة أجهزة**: مسموح، لكن استخدام متوازٍ ثقيل قد يصل للسقف الأسبوعي.

---

## 🔍 التحقّق بعد النقل

على الجهاز الجديد، افتح Claude Code CLI:
```bash
claude mcp list
# توقّع: claude-companion: node ... - ✓ Connected
```

في المتصفح:
- فتح الشريط الجانبي → اكتب "افتح يوتيوب" → يجب أن ينجح
- Settings → تظهر memories + tasks المستوردة

إن لم ينجح، راجع `CLAUDE.md` للدروس التشخيصية.
