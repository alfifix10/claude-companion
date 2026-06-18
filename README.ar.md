# 🤖 Claude Companion — مرافق كلود

**مساعد متصفح ذكي يعمل باشتراك Claude Max — بدون API، بدون مفاتيح، بدون تكاليف إضافية.**

إضافة متصفح Chromium تربط الشريط الجانبي بـ Claude Code عبر MCP. كل طلب يسير من خلال اشتراكك — $0 تكلفة API.

---

## ✨ المزايا

- 🚀 **Claude Max فقط** — بلا مفاتيح API، بلا اختيارات نماذج
- 🌐 **يعمل على كل متصفح Chromium** — Chrome, Brave, Edge, Opera, Vivaldi, Arc, Chromium
- 🛡️ **موثوقية من اليوم الأول** — ping/pong health check، auto-reconnect
- 🎤 **إدخال صوتي عربي** مجاني (Web Speech API)
- 📚 **Prompts سياقية** — chips خاصة بيوتيوب/GitHub/Gmail/Amazon/...
- ⚡ **اختصارات عربية فورية** — "اضغط على X"، "اكتب Y في Z"، بدون AI
- 📄 **Readability** — استخراج محتوى المقالات (60-80% توفير tokens)
- 🔄 **DOM diff** — ترسل فقط التغييرات بعد كل قراءة
- 🎯 **Setup Wizard** — شاشة ترحيب ذكية مع checklist حيّ
- 💻 **يعمل في الخلفية** — service worker مُبقى حيّاً

## 🏗️ البنية

```
Side Panel ←→ Service Worker ←→ Native Host ←→ Claude Code (Max sub)
                                   ↕
                                MCP Server ←→ 18 browser tools
```

## 📦 التثبيت — خطوتان

### 🌟 المسار الأسهل — نقرة مزدوجة

1. نزّل الحزمة وفُكّ الضغط.
2. **انقر نقرًا مزدوجًا** على `SETUP-Windows.bat` (ويندوز) أو `SETUP-Mac-Linux.command` (ماك/لينكس).
   يفحص Node (ويُثبّته آليًا إن لزم)، يُثبّت Claude CLI، يفتح تسجيل الدخول، ويُسجّل الخادم المحليّ — كل ذلك في نافذة واحدة.
3. افتح `chrome://extensions` ← فعّل **Developer mode** ← **Load unpacked** ← اختر مجلّد `extension`.

تظهر **صفحة ترحيب** تلقائيًا بعلامات ✓ حيّة تؤكّد اتصال كل جزء.

### 🛠️ المسار اليدوي (للمحترفين)

```powershell
# Windows
npm install -g @anthropic-ai/claude-code
claude auth login
# حمّل الإضافة من chrome://extensions (Load unpacked → extension/)
.\install.ps1
```

```bash
# macOS / Linux
npm install -g @anthropic-ai/claude-code
claude auth login
./install.sh
```

## 🎮 الاستخدام

- انقر أيقونة الإضافة → الشريط الجانبي يفتح
- اكتب أي طلب:
  - `لخّص هذه الصفحة`
  - `افتح يوتيوب`
  - `اضغط على تسجيل الدخول` (فوري بدون AI)
  - `استخرج نص المقال`
- جميع الأدوات الـ18 متاحة لـ Claude تلقائياً

## 🔧 استكشاف الأخطاء

الشريط الجانبي يعرض شاشة تشخيص حيّة عند وجود مشكلة:
- ❌ Native messaging host → نفّذ `install.ps1` / `install.sh`
- ❌ Node.js → ثبّت من [nodejs.org](https://nodejs.org)
- ❌ Claude Code CLI → `npm install -g @anthropic-ai/claude-code`
- ❌ Max login → `claude auth login`

## 📁 البنية

```
claude-companion/
├── install.ps1 / install.sh    # مثبِّتات cross-platform
├── host/
│   ├── native-host.js          # Node.js bridge (stdio ↔ TCP ↔ claude CLI)
│   ├── mcp-server.js           # MCP server (18 browser tools)
│   └── package.json
└── extension/
    ├── manifest.json            # Manifest V3
    ├── background.js            # Service worker + keepalive
    ├── content.js               # Readability + AX tree + DOM diff
    ├── panel.html/css/js        # Side panel UI
    ├── welcome.html             # صفحة ترحيب أول تشغيل (بعلامات ✓ حيّة)
    ├── settings.html            # Simple memories + diagnostic
    └── src/
        ├── core/      (state, cdp, tabs, utils)
        ├── messaging/ (native, panel)
        ├── tools/     (executor, local, native-handlers)
        └── agent/     (max)
```

## 🙏 الإشادات

- Anthropic — Claude Max + Claude Code
- Mozilla — Readability algorithm inspiration
- WebClaw — Selective ref approach

## 📜 الرخصة

MIT
