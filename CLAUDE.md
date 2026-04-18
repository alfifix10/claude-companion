# Claude Companion — ذاكرة المشروع

مساعد متصفح يعمل باشتراك Claude Max. للاستخدام الشخصي. بلا API keys.

---

## 🎭 فريق المراجعة الافتراضيّ — استخدم العدسة المناسبة

**المهندسون المُعتمدون** (ملفات persona + slash commands):

| Slash | Persona | متى |
|-------|---------|------|
| `/red` | Adversarial Reviewer (`ADVERSARIAL_REVIEW.md`) | **يومياً** — قبل أي كود غير تافه |
| `/security` | Security Engineer (`SECURITY_REVIEW.md`) | auth / IO / rendering paths |
| `/perf` | Performance Engineer (`PERFORMANCE_REVIEW.md`) | feature كبير / شكوى بطء |
| `/design` | Visual Designer (`VISUAL_DESIGN_REVIEW.md`) | جماليّات — ألوان، typography، hierarchy |
| `/frontend` | Frontend Engineer (`FRONTEND_REVIEW.md`) | CSS health، a11y هيكليّ، compat |

**الفرق بين `/design` و `/frontend`**:
- `/design` يقول: *"الألوان مسطّحة"* — جماليّات
- `/frontend` يقول: *"specificity battle في هذا الـ rule"* — تقنيّ

**قاعدة الاستخدام**: 90% من الوقت `/red` كافٍ. 10% الباقية استدعِ المتخصّص حسب الحاجة.
قبل release عامّ: **الخمسة مرّة واحدة**.

## 🔴 القاعدة الأولى — قبل أي كود جديد

**إلزامي**: لأي ميزة/refactor/تغيير غير تافه، طبّق Adversarial Review **من تلقاء نفسك**
قبل كتابة سطر واحد. اقرأ `ADVERSARIAL_REVIEW.md` في نفس المجلد واتبع الخطوات السبع.

**التغييرات التافهة** (استثناءات):
- تغيير لون/نص/margin
- إصلاح typo
- إضافة تعليق
- تغيير سطر واحد لا يؤثّر على السلوك

**كل ما عداها** يتطلّب على الأقل:
1. ذكر 3 مخاطر محتملة (UX + تزامن + فشل خارجي)
2. اقتراح كيفية تجنّبها
3. ثم التنفيذ

لا تنتظر مني أن أطلب ذلك — افعله افتراضياً.

---

## المسار
`C:\Users\fix\Desktop\nnn\claude-companion\`

## المعمارية
```
Side Panel (UI) ─ Service Worker ─ Native Host (Node) ─┬── claude CLI (Max)
                                                        └── MCP Server ─ Claude Code
```

- **extension/**: Manifest V3 + side panel + content script
- **host/**: native-host.js (bridge) + mcp-server.js (MCP tools)
- **install.ps1**: يُسجّل native messaging + يُثبّت Claude CLI + يربط MCP

## الاسم والهوية
- **Name**: Claude Companion (بالإنجليزي في UI)
- **Extension ID (ثابت دائم)**: `bciopdghgdndoedlgbbcffgaebjbkago`
  - مُثبَّت عبر `key` في manifest.json (RSA 2048) → ID لا يتغيّر عبر المتصفحات أو المسار
  - المفتاح الخاص في `.extension-private-key.pem` (git-ignored — لا تُسرّبه)
- **Native host name**: `com.anthropic.claude_companion`
- **TCP port**: 18799

## الميزات الأساسية
1. **Side panel UI** — chat بسيط
2. **18 أداة متصفح** عبر MCP
3. **Local Arabic shortcuts** — "اضغط على X"، "افتح يوتيوب"، إلخ (مجانية بدون AI)
4. **Markdown renderer** للردود (bold, headings, tables, code)
5. **Voice input** عربي (Web Speech API)
6. **مهام مكررة** — chips ⚡ في الشريط الجانبي (من settings)
7. **ذاكرة مخصّصة** — نص يُرسَل مع كل طلب
8. **Orange automation border** — يظهر أثناء الأتمتة
9. **Click ripple** — موجة برتقالية عند النقر
10. **Copy buttons** — على كل رسالة

## الدروس البرمجية الحرجة (لا تُكرَّر)

### Windows native messaging
- **Prompt via stdin** — لا كـ CLI arg (shell quoting يكسره)
- **Absolute path** لـ `claude.cmd` (PATH محدود عند spawn من Brave)
- **Single backslashes** في الـ .bat wrapper
- **taskkill /F /T /PID** لقتل شجرة العمليات كاملة (SIGTERM لا يكفي)

### PowerShell scripts
- **No em-dashes or Arabic in code** (فقط في strings) — PS 5.1 يقرأ UTF-8 بلا BOM خطأ

### Service worker (MV3)
- **chrome.alarms keepalive** كل 20s
- **نصوص خارجية فقط** (inline `<script>` مرفوض بـ CSP)
- **import lazy** في message handlers

### Native host
- **لا يخرج عند فشل TCP** — TCP للـ MCP اختياري
- **ready banner عند startup** لإثبات صحة القناة
- **ping/pong** للتحقق من الاتصال قبل الطلبات

### Cross-browser
- **sessionId لكل native-host** + **routing في primary MCP** (منع التداخل)
- **retargetTaskTab** عند tabs_create/switch_tab
- **Tab locking** عند بدء مهمة (`activeTask.tabId`)

### Stop/Cancel (إيقاف صارم)
1. `chat_stop` → cancelActiveMaxTask + cancelAllHost + rejectToolsFor(10s)
2. `killTree` على ويندوز → taskkill /T
3. `responseHandlers.clear()` → تجاهل events متأخرة
4. `setBorder(false)` في cancelActiveMaxTask
5. UI guards: `if (!isLoading) return` في onBgMessage

### Task timeouts
- **No-first-event**: 20s
- **Stuck (no progress)**: 90s
- **Hard ceiling**: 6 min
- **finishTask idempotent**

### UI design
- **لا header مكرر** — الاسم يُعرض مرة واحدة فقط
- **لا setup card ولا diagnostic** (للاستخدام الشخصي — يعمل أو لا)
- **زر الإرسال الأخضر** → يتحوّل أحمر (⏹) أثناء المهمة
- **Quick scroll buttons** → يقفزان لأعلى/أسفل الـ chat panel (ليس الصفحة)

### Scroll (browser)
- استخدم `window.scrollBy` بدل `Input.dispatchMouseEvent` (أكثر موثوقية)
- كشف أقرب container قابل للتمرير حول activeElement

### Content extraction
- **Readability-style** في content.js (scoring بالكثافة النصية)
- **DOM diff** على read_page (إرسال changes فقط بعد أول قراءة)
- **Selective refs** (interactive-only) في accessibility tree

## إعدادات المستخدم الحالية
- اشتراك: **Claude Max (5x)** · حساب `alfifix10@gmail.com`
- Node.js: v24.14.0
- Claude Code: v2.1.112
- Brave كمتصفح أساسي

## المشاكل المعروفة / للمستقبل
- الإضافة لا تعمل إذا Brave مغلق كلياً
- Voice input يحتاج إنترنت (Web Speech API)
- Markdown renderer مكتوب يدوياً (لا dependencies)

## الهيكل النهائي

```
claude-companion/
├── CLAUDE.md                (هذا الملف)
├── README.md
├── install.ps1              (Windows, cross-browser, auto-detect)
├── install.sh               (macOS/Linux)
├── host/
│   ├── package.json
│   ├── native-host.js       (stdio ↔ TCP ↔ spawn claude)
│   └── mcp-server.js        (18 tools, session routing)
└── extension/
    ├── manifest.json
    ├── background.js
    ├── content.js           (Readability + AX tree + DOM diff + border + ripple)
    ├── panel.html/css/js    (side panel — main UI)
    ├── settings.html/js     (memories + tasks)
    ├── mic-permission.html/js
    ├── icons/
    └── src/
        ├── core/            (state, cdp, tabs, utils)
        ├── messaging/       (native ping/pong, panel port)
        ├── tools/           (executor, local shortcuts, native handlers)
        └── agent/           (max — the only provider)
```

## الأولويات القادمة (إن أردت)
- جدولة المهام (chrome.alarms لتشغيل المهام تلقائياً)
- تحسينات UX إضافية
- Extended cache TTL لو Anthropic دعمه

---
آخر تحديث: 2026-04-18
