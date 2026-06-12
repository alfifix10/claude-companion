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
| `/wise` | **Wise Council** (`WISE_REVIEW.md`) | **بعد** المراجعين الآخرين — حكم نهائيّ |

**الفرق بين `/design` و `/frontend`**:
- `/design` يقول: *"الألوان مسطّحة"* — جماليّات
- `/frontend` يقول: *"specificity battle في هذا الـ rule"* — تقنيّ

**دور `/wise` المختلف**:
- الآخرون **يحلّلون** ويجدون مشاكل → قوائم طويلة
- الشيخ **يختم** ويُصدر حكماً → SHIP 🟢 / DEFER 🟡 / REJECT 🔴 / REFRAME 🔵
- يُستدعى **بعد** (لا بدلاً عن) الآخرين
- يُجيب في < 300 كلمة دائماً
- ينحاز للبساطة + الشحن + المستخدم

**قاعدة الاستخدام**:
- 90% من الوقت `/red` كافٍ
- 10% الباقية استدعِ المتخصّص حسب الحاجة
- قبل **قرار غير قابل للتراجع** (merge إلى main، release، refactor كبير، dependency جديد): استدعِ `/wise` **في النهاية** ليُصدر الحكم
- قبل release عامّ: **الخمسة + الشيخ** — الأوّلون للتحليل، الشيخ للختم

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
`C:\Users\<you>\…\claude-companion\` (جذر المستودع المحليّ)

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
2. **60 أداة MCP** موزّعة على 10 فئات (تفاصيل تحت) — تشمل `act` المركّبة و`fill_form`
3. **Pro Mode** — filesystem + shell + PDF/JSON/CSV (gated خلف toggle)
4. **Local Arabic shortcuts** — "اضغط على X"، "افتح يوتيوب"، إلخ (مجانية بدون AI)
5. **Markdown renderer** للردود (bold, headings, tables, code, code blocks)
6. **Voice input** عربي (Web Speech API)
7. **مهام مكررة** — chips ⚡ في الشريط الجانبي (من settings)
8. **ذاكرة مخصّصة (memories)** — نص يُرسَل مع كل طلب
9. **Project memory** — CLAUDE.md + _STATE.md من working dir تُحقَن في كلّ turn
10. **Smart conversation history** — first-2 + last-12 + compaction nudge + **استرجاع BM25** لأكثر أدوار المنتصف صلةً + **تثبيت الهدف** حتى 200 رسالة (`cap-conversation`)
11. **Auto-retry** على transient API errors (ENOTFOUND, 5xx, 429، إلخ)
12. **Orange automation border** — يظهر أثناء الأتمتة
13. **Image Q&A pure mode** — مسار منفصل بلا system prompt لمنع الهلوسة
14. **Multi-browser session routing** — Brave + Chrome + Edge بدون تداخل
15. **Copy buttons + Edit-and-resend** — على كل رسالة
16. **بوّابة تأكيد Pro Mode (1.3)** — موافقة بشريّة قبل write/edit/delete/run_command؛ آمنة افتراضيّاً
17. **نظام توقّف ذكيّ (5.2/5.3)** — استئناف تلقائيّ محصور للمهام الطويلة، لا توقّف كاذب على التمرير، توقّف صارم عند المشاكل الحقيقيّة
18. **سجلّ كيانات (C3) + site playbooks (4.4)** — تذكّر بريد/مسارات/مُعرّفات + تلميحات لأصعب المواقع
19. **مؤشّر توكن (3.6)** + **كتابة في المحرّرات الغنيّة** (contenteditable) — Slack/Discord/Notion/ProseMirror

## الـ 60 أداة بالفئات

| الفئة | العدد | أمثلة |
|---|:--:|---|
| **Browser automation** | 24 | navigate, read_page, **act**, **fill_form**, click, type_text, screenshot, run_javascript, ... |
| **DevTools** (read-only) | 7 | read_console_messages, read_network_requests, read_page_errors, inspect_element, read_storage (Pro), read_performance, clear_injected_scripts |
| **Filesystem** (Pro) | 8 | read_file, write_file, edit_file, list_directory, find_files, ... |
| **Shell** (Pro) | 1 | run_command (allowlist + denylist + shell:false) |
| **Documents** (Pro) | 3 | generate_pdf, save_json, save_csv |
| **Git structured** (Pro) | 5 | git_status, git_diff, git_log, git_blame, git_branches |
| **Code search** (Pro) | 4 | grep_files, find_symbol, find_references, code_outline |
| **HTTP** (Pro) | 2 | http_fetch, http_get_json |
| **Code Quality** (Pro) | 3 | lint_file, format_file, type_check |
| **SQLite** (Pro) | 2 | sqlite_query, sqlite_schema (read-only enforced) |
| **Project memory** (Pro) | 1 | update_project_state |

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

### Task timeouts (محدَّثة بعد جلسات طويلة فعليّة)
- **No-first-event**: 20s
- **Stuck (no progress)**: 300s (5min) — مُنع التشغيل أثناء `toolsInFlight > 0`
- **Hard ceiling**: 60min — رُفعت من 20min بعد scrapers طويلة كانت تُقطع
- **Auto-retry**: ENOTFOUND/ECONNRESET/ETIMEDOUT/5xx/429 → ×2 مع backoff (2s → 6s)
- **finishTask idempotent**

### Smart conversation history (داخل الجلسة)
- **First 2 messages always kept** — الـ goal-setting في أوّل turn
- **Last 12 messages always kept** — الـ flow الحاليّ
- **بينهما marker** — `[ELIDED: N earlier turns folded — see _STATE.md]`
- **Compaction nudge** عند 30+ message: نظام يقترح `update_project_state`
- **Token cost**: ثابت ~6.6K input/turn حتّى لمحادثات 200 turn (لو raised النافذة، 18K+ في 50 turn)

### Project memory (عبر الجلسات)
- **`<workingDir>/CLAUDE.md`** — معماريّة المشروع (≤8KB) — يُحقَن كلّ turn
- **`<workingDir>/_STATE.md`** — حالة العمل (≤4KB) — الـ agent يحدّثها بنفسه
- **يدخل dynamic user message**, ليس static system → لا يكسر prompt cache
- **Pro Mode + workingDirectory مطلوبان** — graceful no-op خلاف ذلك

### Pro-Mode coding discipline (قاعدة ثابتة في STATIC_SYSTEM)
قسم `PROJECT MEMORY & DISCIPLINE` في max.js يطبّق حلقة احترافيّة افتراضيّاً
لكلّ مشروع برمجيّ (محصور بـ Pro Mode + working dir، مُستثنى منه التصفّح):
- **اقرأ قبل أن تكتب** (read_file/grep) — لا يستدلّ على الكود من الذاكرة (#1 ضدّ الهلوسة)
- **أنشئ CLAUDE.md** القصير إن غاب (مرّة)
- **خطوات صغيرة + إثبات** قبل «تمّ» (شغّل/اقرأ النتيجة)
- **git commit** عند نقاط التوقّف = سجلّ التغيير الصادق
- **حدّث _STATE.md** (update_project_state، بلا تأكيد) في نهاية التقدّم
- المبدأ: git = الحقيقة، _STATE.md = مؤشّر «أين تركنا»

### Pro Mode (Layer 1+2+3+4+5)
- **Toggle في settings** — مع working directory مُحدَّد
- **Filesystem** sandboxed داخل working dir + symlink-escape check
- **Shell** allowlist (git/npm/python/node/tsc/...) + denylist (rm -rf/sudo/chmod 777/dd if=...)
- **shell:false** + args كـ array → لا shell injection
- **run_javascript** disabled في default mode (Pro Mode فقط — RCE surface)

### UI design
- **لا header مكرر** — الاسم يُعرض مرة واحدة فقط
- **لا setup card ولا diagnostic** (للاستخدام الشخصي — يعمل أو لا)
- **زر الإرسال الأخضر** → يتحوّل أحمر (⏹) أثناء المهمة
- **Quick scroll buttons** → يقفزان لأعلى/أسفل الـ chat panel (ليس الصفحة)

### Warm CLI pool — إلغاء كلفة الإطلاق البارد (2026-06-12)
- بعد كل دور، `native-host` يُطلق عملية `claude` تالية مسبقًا وتبقى منتظرة على stdin — **التبنّي يوفّر ~1450ms لكل دور** (مُقاس حيًّا: 44ms بدل ~1500ms حتى أول حدث)
- **مطبّ حاسم**: `claude -p` مع stdin خام **ينتحر بعد 3 ثوانٍ** بلا مدخلات ("no stdin data received in 3s") — الحل: `--input-format stream-json` **بلا مهلة إطلاقًا** (مُثبَت 6+ ثوانٍ انتظار)، لذا كل الأدوار غير النقية تُرسل الـ prompt كرسالة stream-json
- **التوقيع الصارم** (`warm-pool.js` نقية + 8 اختبارات): نموذج + proMode (يُقرأ طازجًا عند التبنّي — أمن صلاحيات run_javascript) + نص النظام كاملًا؛ أي اختلاف = قتل وإطلاق طازج (سلوك ما قبل الميزة حرفيًا)
- خانة واحدة، عمر أقصى 15 دقيقة، تُقتل عند shutdown، أدوار الصور/النقية لا تمسّها
- `proc.stdin.on("error", noop)` في spawnClaude — EPIPE بلا مستمع كان يُسقط المضيف كله (خطر قائم قديمًا اتسعت نافذته)
- اختبار يدوي حيّ: `node host/e2e-warm.mjs` (يستهلك حصة — 3 استعلامات صغيرة)

### Smart settle — انتظار واعٍ بالشبكة (2026-06-12)
- **كل أداة مُغيِّرة تُنهى بـ `settleAfterAction(tabId, opts)`** (executor.js) = waitForSettled + prefetch في خطّاف واحد — لا تنثر الزوج يدويًا في أداة جديدة
- `waitForSettled` = سكون DOM ← تصريف XHR الجارية (سقف 1200ms) ← settle لاحق قصير **فقط إن انتظرنا فعلًا**
- تتبّع in-flight في background.js: `requestWillBeSent` +1، `loadingFinished/Failed` −1 (ليس `responseReceived` — الجسم قد ما يزال يتدفق)، كنس 15s ضد التسريب
- **الطلبات الأقدم من 3 ثوانٍ لا تحجب السكون** (`longLivedMs`): long-poll/SSE دائم بدأ قبل فعلنا ≠ استجابة نترقّبها — صفحات الدردشة/اللوحات بلا كلفة إضافية
- `fill_form` تسوّي **مرة واحدة** في نهاية الدفعة (علامة `_batch` في form_input)

### كاشف الحلقات — قاعدة المحور (2026-06-12)
- تكرار mutating مطابق يُحتسب علوقًا **فقط** إن لم يحدث تقدّم بينه وبين سابقه: قراءة متقدّمة (progressed) أو فعل مُغيِّر مختلف ما يزال تحت عتبته («الجِدّة» — تمنع زوجًا ميتًا متبادلًا A,B,A,B من التحايل)
- نمط المحور navigate(قائمة)←act(عنصر)←navigate(قائمة)… لا يتوقف أبدًا؛ 3 navigate ميتة متتالية (أو بقراءات راكدة) تتوقف عند 3 كما كانت

### Build/lint (مطبّات)
- **لا تشغّل `lint:fix` على كامل src** — biome الحالي يعيد تنسيق ~16 ملفًا ملتزَمًا (أسلوب الالتزام ≠ biome) فيضخّم الـ changeset
- `npm run build` يعيد توليد `version-compare.js` بتنسيق tsc مختلف عن الملتزَم — استبعده من الـ commits
- اختبارات lib تستورد الـ `.js` المُصرَّف — **build قبل vitest** بعد أي تعديل `.ts`

### Scroll (browser)
- استخدم `window.scrollBy` بدل `Input.dispatchMouseEvent` (أكثر موثوقية)
- كشف أقرب container قابل للتمرير حول activeElement

### Content extraction
- **Readability-style** في content.js (scoring بالكثافة النصية)
- **DOM diff** على read_page (إرسال changes فقط بعد أول قراءة)
- **Selective refs** (interactive-only) في accessibility tree

## بيئة التطوير المستهدَفة
- اشتراك: **Claude Max** (أيّ خطّة تدعم الـ CLI)
- Node.js 18+
- Claude Code CLI latest
- Brave / Chrome / Edge / Opera / Vivaldi / Arc — كلّها Chromium-based

## المشاكل المعروفة / للمستقبل
- الإضافة لا تعمل إذا Brave مغلق كلياً
- Voice input يحتاج إنترنت (Web Speech API)
- Markdown renderer مكتوب يدوياً (لا dependencies)
- panel.js عند ~2,850 سطر — monolith (تقسيمه 6.1 أُجِّل: بلا قيمة لمطوّر منفرد)
- Skills MVP rolled back — ملفّات composer/interview اليتيمة أُزيلت (لم تعد موجودة)
- لا scheduling (`chrome.alarms` غير مُستعمَل) — خيار قادم
- ~~لا token-usage indicator~~ ✅ أُضيف (3.6): رقاقة `≈ NK توكن` في شريط التبويب

## الهيكل النهائي

```
claude-companion/
├── CLAUDE.md                (هذا الملف)
├── README.md
├── SETUP-Windows.bat        (مثبّت بنقرة مزدوجة — يلفّ install.ps1 + CLI + login)
├── SETUP-Mac-Linux.command  (نظيره لماك/لينكس، قابل للتنفيذ)
├── install.ps1              (Windows, cross-browser, auto-detect)
├── install.sh               (macOS/Linux)
├── landing/                 (صفحة هبوط تسويقيّة ثابتة — index.html/style.css/script.js)
├── host/
│   ├── package.json
│   ├── native-host.js       (stdio ↔ TCP ↔ spawn claude)
│   └── mcp-server.js        (18 tools, session routing)
└── extension/
    ├── manifest.json
    ├── background.js
    ├── content.js           (Readability + AX tree + DOM diff + border + ripple)
    ├── panel.html/css/js    (side panel — main UI)
    ├── welcome.html/css/js  (onboarding — opens on first install, live ✓ via diag)
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
آخر تحديث: 2026-06-12 (v2 + smart settle + إصلاح إنذار المحور الكاذب + **warm CLI pool: ~1450ms أسرع لكل دور، مُقاس حيًّا**. ~364+20 اختبار. انظر ROADMAP.md لِلسجلّ الكامل.)
