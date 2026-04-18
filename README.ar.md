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

## 📦 التثبيت — بنقرة واحدة

### 🌟 المسار الأسهل — Setup Wizard التلقائي

**Windows**: انقر بزر الفأرة اليمين على `setup.ps1` → Run with PowerShell
**macOS / Linux**: افتح Terminal ونفّذ `./setup.sh`

سيفتح معالج جميل في متصفحك يقوم بكل شيء آلياً:
- ✅ يفحص Node.js (ويُثبِّته إن ناقصاً عبر winget/brew)
- ✅ يُثبّت Claude Code CLI
- ✅ يفتح تسجيل الدخول لـ Claude Max
- ✅ يفتح صفحة الإضافات ويكشف تحميلها تلقائياً
- ✅ يسجّل Native Host + MCP
- ✅ يُعيد تشغيل المتصفح بإذنك

### 🛠️ المسار اليدوي (للمحترفين)

```powershell
# Windows
npm install -g @anthropic-ai/claude-code
claude login
# حمّل الإضافة من chrome://extensions (Load unpacked → extension/)
.\install.ps1
```

```bash
# macOS / Linux
npm install -g @anthropic-ai/claude-code
claude login
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
- ❌ Max login → `claude login`

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
    ├── welcome.html             # First-run wizard
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
