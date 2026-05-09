# Launch Copy — جاهز للنسخ/اللصق

كل نصّ هنا تمّ صياغته لمنصّة مُحدّدة. **لا تنسخ نفس النصّ لكلّ المنصّات** — كلّ جمهور يحتاج نكهة.

---

## 🟧 Hacker News — Show HN post

**Title** (تحت 80 حرفاً — قاعدة HN):
```
Show HN: Claude Companion – Browser copilot using your Claude Max subscription
```

**Alt titles** (جرّب أحدها إذا الأوّل لم يلتقط):
```
Show HN: Turn your Claude Max sub into a browser agent – no API keys, local-first
Show HN: A Chromium extension that runs browser tasks via Claude CLI (no API)
```

**Body** (اللصق في صندوق "url" فارغ، و"text" هذا):

```
Hi HN — I built Claude Companion, a Chromium side-panel extension that uses
the `claude` CLI (authenticated to a Max subscription) as its agent backend.
No API keys, no proxy server, no per-token billing. Everything local.

The extension talks to a small Node native host, which spawns `claude -p`
and exposes 18 browser tools (read_page, click, type, navigate, screenshot,
…) to it via MCP. Tool calls flow: side panel → service worker → native
host → MCP server → claude CLI → Anthropic. Nothing else phones home.

Why I built it: I'm paying $100/mo for Max anyway. The web UI can't drive
my browser. Claude for Chrome is waitlisted. Operator isn't Claude. So I
glued the pieces together.

A few design notes that might interest extension / agent folks:

- Tool allowlist is hard-coded in the native host. Bash/Write/Edit are
  explicitly disallowed as belt-and-suspenders. Unknown tools fail closed.
- Native host ↔ MCP server use a 32-byte shared secret on a localhost TCP
  bridge, with timingSafeEqual comparison. Prevents local-process
  impersonation of the browser.
- 16MB cap on both native-messaging frames and TCP frames to block
  length-prefix DoS.
- Multi-browser aware: running in both Brave + Chrome spawns two native
  hosts; the primary MCP server routes tool calls by session ID.
- Arabic voice input + a local "shortcut parser" that catches things like
  `open youtube` and `click X` without calling the model at all (free).

Known limitations: requires Max sub (no API fallback by design), `debugger`
permission shows the Chromium banner (by design), install is 3 CLI steps
(Load unpacked — not on Web Store yet).

MIT licensed. Demo video + install steps in README:
https://github.com/<YOUR_HANDLE>/claude-companion

Happy to answer questions on the architecture, threat model, or why I
avoided every shortcut that would've made this "easier but weirder".
```

**⚠️ قواعد HN**:
1. انشر يوم **ثلاثاء/أربعاء/خميس** بين 8-10 صباحاً PST (UTC-8).
2. **لا** تطلب upvotes أبداً. HN يحظرك.
3. **ردّ على أوّل 5 تعليقات خلال 30 دقيقة** — مهمّ لـ algorithm.
4. لا تدافع بشدّة — عند الانتقاد، اشكر وعدِّل في README.

---

## 🐦 X/Twitter — Thread (عربيّ)

**التغريدة الأولى — الـ hook**:

```
بنيت إضافة متصفّح تُحوّل اشتراكك في Claude Max إلى مساعد تصفّح كامل.

بدون مفاتيح API.
بدون خادم خارجيّ.
بدون تكاليف إضافيّة.

كلّه محلّي، مفتوح المصدر، بـ MIT.

[فيديو 15 ثانية]

🧵
```

**التغريدة 2**:
```
المشكلة:

أنا أدفع $100/شهر لـ Claude Max.
أستخدم Claude يوميّاً للكتابة والبحث.
لكنّه لا يستطيع:
- أن يتصفّح لي
- أن يضغط لي
- أن يملأ لي form
- أن يلخّص الصفحة التي أنظر إليها

Anthropic لديها Claude for Chrome، لكنّه waitlist.
```

**التغريدة 3**:
```
الحلّ:

إضافة Chromium + Side Panel.
18 أداة متصفّح عبر MCP.
تستدعي claude CLI محلّيّاً.

المسار:
side panel → service worker → native host → MCP → claude CLI → Anthropic

لا وسيط. لا telemetry. لا دفع إضافيّ.
```

**التغريدة 4** — **المهمّة المعقّدة** (اختر واحدة):
```
مثال واقعيّ:

قلت بصوتي: "ادخل نون، دوّر على iPhone 15 Pro، قارن مع الإمارات."

Claude:
١- فتح نون.سا، بحث، استخرج أسعار
٢- فتح نون.ae، بحث، استخرج أسعار
٣- أنشأ جدول مقارنة في الشريط الجانبيّ
٤- وفّر لي 18 دقيقة

[screenshot]
```

**التغريدة 5** — المعماريّة:
```
Tech stack:

▸ Chrome MV3 + Side Panel
▸ Node native messaging host
▸ MCP Server (Model Context Protocol)
▸ claude CLI (Max subscription)
▸ TCP bridge with shared-secret auth
▸ No external dependencies

الكل محلّيّ. كود الإضافة ~580KB. الكود نظيف ومُعلَّق.
```

**التغريدة 6** — خصوصيّة وأمن:
```
قرارات أمنيّة أفخر بها:

- Tool allowlist ثابت في الكود
- Bash/Write/Edit مرفوضة صراحةً
- TCP bridge = 32-byte secret + timingSafeEqual
- 16MB cap على payloads
- لا telemetry أبداً
- stable extension ID (RSA-signed)

SECURITY.md + threat model واضحان.
```

**التغريدة 7** — CTA:
```
مفتوح المصدر الآن:

🔗 github.com/<YOUR_HANDLE>/claude-companion
📄 MIT license
🌐 يعمل على Chrome/Brave/Edge/Opera/Vivaldi/Arc
🎙️ يدعم صوت عربيّ + إنجليزيّ
📚 README عربيّ + إنجليزيّ كاملان

Starred؟ جرّبه وقلّي نقدك.
```

**التغريدة 8 (اختياريّة)** — hook ثانوي للـ reply game:
```
هذا أوّل browser agent يفهم العربيّة كلّياً:

"افتح يوتيوب"
"اضغط على تسجيل الدخول"
"لخّص هذا المقال"

كلّها تعمل. وأكثر من 50% من الأوامر تُنفَّذ محلّيّاً بدون استدعاء AI — توفير tokens بشكل جنونيّ.
```

---

## 🐦 X/Twitter — Thread (English)

**Tweet 1**:
```
I built a Chrome extension that turns your Claude Max subscription into a
full browser copilot.

No API keys.
No external server.
No extra billing.

MIT open source.

[15s video]

🧵
```

**Tweet 2**:
```
The problem:

I pay $100/mo for Claude Max.
I use it daily for writing and research.

But it can't:
- browse for me
- click for me
- fill forms
- summarize what I'm looking at

Anthropic has Claude for Chrome — but it's waitlisted.
```

**Tweet 3**:
```
The solution:

Chromium extension + side panel + 18 MCP browser tools that call the
`claude` CLI locally.

Flow: side panel → service worker → native host → MCP → claude CLI

No middleman. No telemetry. Zero marginal cost.
```

**Tweet 4** (task demo):
```
Real task from today:

"Compare iPhone 15 Pro prices on noon.com between SA and UAE."

Claude:
1. opened noon.sa, searched, extracted prices
2. opened noon.ae, searched, extracted prices
3. built a markdown comparison table in side panel
4. saved me 18 minutes

[screenshot]
```

**Tweet 5** (tech):
```
Stack:

• Chrome MV3 + Side Panel
• Node native messaging host
• MCP server (Anthropic's Model Context Protocol)
• claude CLI (your Max subscription)
• Localhost TCP bridge, shared-secret auth
• 1 dep: @modelcontextprotocol/sdk

Clean, documented, ~580KB total.
```

**Tweet 6** (security):
```
Security decisions I'm proud of:

- Tool allowlist hard-coded (Bash/Write/Edit explicitly denied)
- TCP bridge: 32-byte secret, timingSafeEqual
- 16MB payload cap on both messaging transports
- Stable extension ID (RSA-signed manifest)
- Zero telemetry, ever

Full SECURITY.md + threat model in repo.
```

**Tweet 7** (CTA):
```
Open source. MIT. Link:

github.com/<YOUR_HANDLE>/claude-companion

Works on:
→ Chrome, Brave, Edge, Opera, Vivaldi, Arc
→ Windows, macOS, Linux
→ Arabic + English voice input

Star, fork, tell me what breaks.
```

---

## 💼 LinkedIn — Single Post (English-leaning, for MENA tech recruiters/founders)

**قاعدة LinkedIn**: أطول من X. قصّة شخصيّة في البداية. نتيجة واضحة. hashtags معتدلة.

```
I spent 4 weekends building something I desperately wanted and couldn't
find: a browser copilot that uses my existing Claude Max subscription
instead of billing me per-token.

The result is live today: Claude Companion, an open-source (MIT)
Chromium extension that gives Claude the ability to read pages, click,
type, navigate, and take screenshots — entirely through your local
`claude` CLI. Nothing leaves your machine except the calls Claude
already makes to Anthropic.

Why this matters for anyone paying for Max:

→ Your $100 or $200 a month already covers unlimited web tasks. The API
  gateway version would cost a small fortune for the same usage.
→ It works in Arabic natively — commands, voice input, markdown output.
  The first real browser agent I've seen that speaks MENA.
→ It routes around subscription lock-in. You own your workflow.

Technical highlights for the engineering folks:

• 18 MCP tools exposed to Claude via stdio
• Native-host ↔ MCP server bridge with shared-secret auth (timing-safe
  comparison, 16MB DoS caps)
• Multi-browser aware (Brave + Chrome side-by-side works)
• Tool allowlist hard-coded — Bash/Write/Edit are permanently refused

This is my first real public project. I'd love your eyes on it — stars,
forks, brutal feedback, or just a message about what broke for you.

Link in first comment.

#ClaudeAI #Anthropic #OpenSource #BrowserAutomation #MCP #MENA
```

**Comment 1 (pinned)**: `github.com/<YOUR_HANDLE>/claude-companion`

---

## 🐙 Reddit — r/LocalLLaMA + r/ClaudeAI

### r/LocalLLaMA:
```
Title: I built a Chrome extension that gives Claude Max browser-control
powers via MCP — no API needed

Body: Hey LocalLLaMA — this isn't a local model project but it fits the
spirit: using a subscription you already have to avoid API bills.

Claude Companion is a Chromium side-panel extension that routes tool
calls through the official `claude` CLI, which uses your Max sub. No
proxy, no API key, nothing leaves the box beyond what Claude Code
already does.

18 browser tools (read, click, type, navigate, screenshot, form fill).
Arabic + English voice input. Local shortcut parser catches simple
commands before hitting the model, so ~30% of requests cost zero
tokens.

Repo (MIT): github.com/<YOUR_HANDLE>/claude-companion
Threat model + architecture details in README + SECURITY.md.

Happy to talk about why `--dangerously-skip-permissions` is actually
safe here (hint: hard-coded allowlist) if anyone wants to chew on that.
```

### r/ClaudeAI:
```
Title: Built a browser copilot that uses my Max subscription instead
of the API — sharing the open-source repo

Body: [نفس body بصياغة أقلّ تقنيّة]
```

---

## 🚀 Product Hunt — إعداد

### Tagline (تحت 60 حرفاً):
```
Browser copilot powered by your Claude Max subscription
```

### Description (260 حرفاً):
```
Turn your Claude Max subscription into a full browser copilot. Chat in
a side panel, and Claude reads, clicks, types, and navigates for you —
all via the local claude CLI. Zero API keys. Zero servers. Open source
MIT. Arabic + English.
```

### Gallery (6 slots):
1. Side panel with active task (Arabic)
2. Side panel with active task (English)
3. Architecture diagram (from README)
4. Settings page (memories + tasks)
5. Voice input in action
6. Multi-browser (Brave + Chrome side by side)

### First comment from maker:
```
Hey PH 👋

I built this because I kept thinking: I pay $100/mo for Claude Max, why
am I still copy-pasting URLs into the chat UI?

A few things that make it different:

→ No API spend — calls go through your Max sub
→ Local-first, zero telemetry
→ Arabic voice + Arabic shortcuts (first of its kind AFAIK)
→ MIT licensed, 580KB of source, one dependency

Would love your feedback. I'll be in the thread all day.
```

---

## 📧 Cold outreach — للـ newsletters / YouTubers

**To**: maintainers of AI newsletters (e.g. TLDR AI, Ben's Bites, AI Breakdown), YouTubers covering Claude.

```
Subject: Open-source tool: Claude Max → full browser agent (MIT)

Hi [Name],

Short version: I built a Chromium extension that uses the `claude` CLI
locally so Max subscribers get browser-agent capabilities without
touching the API. Thought it might interest your audience given your
coverage of [specific relevant piece].

Demo (60s): [video link]
Repo (MIT): github.com/<YOUR_HANDLE>/claude-companion

Three things I think are newsworthy:

1. It's the first public project I've seen that treats the Max
   subscription as an agent runtime rather than a chat endpoint.
2. Arabic voice + shortcut parser — first browser agent built for MENA
   use-cases.
3. Threat-modeled seriously: tool allowlist, shared-secret TCP, no
   telemetry. SECURITY.md spells it out.

No ask — just thought you'd want to know it exists. Happy to answer
questions if relevant.

Best,
[Your Name]
```

---

## ⚠️ قواعد ذهبيّة للـ launch day

1. **لا تنشر في أكثر من منصّة واحدة في نفس اليوم**. HN + PH في يوم واحد = انقسام الجمهور.

   **اليوم 1**: HN (صباح الثلاثاء PST)
   **اليوم 2**: X + LinkedIn thread
   **اليوم 3**: Reddit
   **اليوم 4**: Product Hunt

2. **GitHub repo جاهز قبل أي نشر**:
   - README محدّث بـ demo GIF
   - 2–3 issues مفتوحة بعنوان "good first issue" لجذب المُساهمين
   - Release note v1.0.0 موقّع
   - `.github/FUNDING.yml` للـ sponsors
   - Social preview image مضبوطة

3. **ردّ على كلّ تعليق أوّل 6 ساعات**. الـ algorithm يُكافئ النشاط.

4. **تتبّع الأرقام**:
   - GitHub stars كلّ ساعة في أوّل يوم
   - PH rank كلّ 30 دقيقة
   - HN position
   - Twitter impressions + CTR
