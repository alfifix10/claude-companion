# Launch Checklist — 48 Hours to Ship

**القاعدة**: لا تنشر حتى تُنجز **كل** pre-launch checks. 90% من failures في HN/PH تأتي من شيء صغير نُسِيَ (broken link، screenshot غلط، GIF لا يعمل).

---

## 📋 Pre-Launch (قبل أي نشر بـ 24 ساعة)

### Repo Hygiene

- [ ] **README**: أوّل 100 حرف تُجيب "لماذا أستخدم هذا؟" — لا "ما هذا؟"
- [ ] **Demo GIF/video** في أوّل 500 كلمة من README (GitHub يحتاج visual فوراً)
- [ ] **Install steps مُختبَرة** على جهاز نظيف (VM أو جهاز صديق)
- [ ] **LICENSE** موجود ومُحدّد
- [ ] **SECURITY.md** يحتوي private reporting path
- [ ] **PRIVACY.md** أو فقرة وافية في README
- [ ] **CHANGELOG.md** أو GitHub release notes لـ v1.0.0
- [ ] **`.github/FUNDING.yml`** يُشير لـ GitHub Sponsors / Ko-fi / Polar
- [ ] **Social preview image** (1280×640) في Settings → Social preview
- [ ] **Description + website + topics** في GitHub repo settings:
  - Topics suggested: `claude`, `anthropic`, `mcp`, `browser-automation`, `chromium-extension`, `ai-agent`, `arabic`, `local-first`

### Demo Assets

- [ ] **Main video** (60-90s) مرفوع على YouTube (unlisted) + رابطه في README
- [ ] **Short clip** (15-30s) mp4 مخزّن في `docs/demo.mp4` للـ X/embed
- [ ] **Hero GIF** (8-15s، under 10MB) في README — أهمّ أصل
- [ ] **Screenshots**: side panel عربيّ + إنجليزيّ + settings
- [ ] **Architecture diagram**: ASCII في README + SVG في docs/
- [ ] **Thumbnail** للفيديو الطويل إن نُشر على YouTube

### Technical Sanity

- [ ] **كل install.sh + install.ps1 اختُبرا على جهاز نظيف** (VM)
- [ ] **`npm audit` نظيف** على host + extension
- [ ] **CI green** على آخر commit
- [ ] **`git tag v1.0.0`** + GitHub Release مع changelog
- [ ] **مرّة واحدة على كل المتصفّحات الستّة**: Chrome, Brave, Edge, Opera, Vivaldi, Arc
- [ ] **اختبار جهاز ثانٍ** (macOS أو Windows مقابل Linux) — أحد الاثنين سيكشف شيئاً

### Legal / Trademark

- [ ] **"Not affiliated with Anthropic"** سطر واضح في README (موجود بالفعل ✅)
- [ ] **لا استخدام للشعار الرسميّ** لـ Anthropic
- [ ] **`claude`** الاسم يُستخدم فقط كـ descriptor ("يعمل مع Claude") لا كاسم المنتج نفسه
- [ ] **Terms of use acceptable** — تحقّق من Anthropic ToS أن استخدام CLI داخل tool مسموح (هو مسموح للاستخدام الشخصيّ حاليّاً، راقب التحديثات)

### Personal Prep

- [ ] **اختار اليوم**: ثلاثاء أو أربعاء يُفضّلان (نتائج تاريخيّة)
- [ ] **خطّط الوقت**: 6 ساعات متاحة للردّ على التعليقات يوم النشر
- [ ] **أخبر صديقين مُقرّبين** ليردّا بأسئلة مُشروعة في أوّل 30 دقيقة — لا upvote rings، فقط engagement طبيعيّ
- [ ] **Caffeine/food ready** ← جدّيّاً، يوم النشر مُرهِق

---

## 🚀 Launch Day — الساعة بالساعة

### T-1h (قبل ساعة من النشر)
- [ ] أعِد قراءة HN post كاملاً مرّة أخيرة (typo check)
- [ ] افتح 4 تبويبات: GitHub repo, HN submit, Twitter compose, analytics
- [ ] جهّز **5 أسئلة متوقّعة + إجاباتها** مكتوبة في ملف نصّيّ (for fast copy-paste)
- [ ] تأكّد GitHub repo public (ليس private)

### T=0 (وقت النشر — 8:00 صباحاً PST، ثلاثاء)
- [ ] انشر على HN **فقط** (لا X، لا LinkedIn، لا Reddit)
- [ ] افتح الـ post صفحة + refresh كلّ 60 ثانية أوّل 15 دقيقة

### T+15min
- [ ] إذا وصل أوّل تعليق → ردّ **فوراً** (أهمّ 15 دقيقة على HN)
- [ ] لو مرّت 15 دقيقة بدون activity → السبب غالباً **title ضعيف**. لا تحذف وتُعيد — فقط اقبل

### T+30min
- [ ] إذا وصلت لأوّل 30 في front page → ابدأ **X thread** (ليس قبل)
- [ ] إذا لم تصل → انتظر ساعة أخرى ثم X thread بغض النظر

### T+1h — T+3h
- [ ] ردّ على **كلّ** تعليق HN في هذا النطاق
- [ ] راقب X engagement — قم بـ retweet لتعليقات جيّدة على thread
- [ ] اشكر بوضوح من يشير للـ security details

### T+3h — T+6h (ذروة الـ traffic)
- [ ] أجب على DMs في X
- [ ] حدّث README إذا اكتُشف linkbroken أو typo (لا تُغيّر جوهر الـ post)
- [ ] فتح 2–3 GitHub issues من أسئلة HN إذا كانت مُبرَّرة

### T+6h
- [ ] نشر LinkedIn post (وقت إجمال أمريكا الوسطى الصباح)
- [ ] تحضير Reddit posts للـ يوم التالي

### T+24h (يوم 2)
- [ ] نشر Reddit (r/LocalLLaMA + r/ClaudeAI)
- [ ] تجهيز Product Hunt launch لليوم الثالث

### T+48h (يوم 3)
- [ ] Product Hunt launch صباح الثلاثاء/أربعاء التالي (أفضل أيّام PH)
- [ ] تغريدة شكر: "شكراً لكل من جرّب. الأرقام: X stars, Y stars/hour, Z downloads."

---

## 📊 Success Metrics — ماذا تُراقب ولماذا

| المقياس | قيمة مُحترمة | قيمة ناجحة | قيمة انفجار |
|---|---|---|---|
| HN position في T+3h | top 30 | top 10 | #1 |
| GitHub stars يوم 1 | 100+ | 500+ | 2K+ |
| GitHub stars أسبوع 1 | 500+ | 2K+ | 8K+ |
| GitHub issues مفتوحة | 2–5 | 10–20 | 50+ |
| GitHub forks | 20+ | 100+ | 500+ |
| Twitter impressions | 10K+ | 100K+ | 1M+ |
| PR/merge في أوّل شهر | 1+ | 5+ | 20+ |

**مؤشر خطر**: 0 stars بعد T+6h ⇒ شيء في العنوان/الـ demo فشل. لا تُكرّر الـ post — حلّل وعد بعد أسبوعين بـ launch مختلف.

---

## 🧯 خطة الطوارئ — ماذا لو…

### لو كُشف CVE في الإضافة خلال يوم النشر
1. افتح GitHub Security Advisory **فوراً**
2. حرّر تغريدة فوقيّة (pinned) تُشير إلى الـ advisory
3. أصلِح، أصدر v1.0.1، أعلن الإصلاح بنفس الـ thread
4. **لا تحاول إخفاء** — HN سيكتشف، سيُدمّر السمعة

### لو HN thread انفجر بالسلب (flame war)
1. **لا تدافع بقوّة**. اشكر، اذكر أنك تسمع، وعد بـ issue tracking
2. حوّل الجدل لـ GitHub issues حيث يمكن حلّه بالفعل
3. **لا تحذف تعليقاتك** — يُقرأ كخداع

### لو فجأة وصل 100 issues في أسبوع
1. **closed as wontfix** ≠ عيب. استخدمها بجرأة
2. أضِف `.github/ISSUE_TEMPLATE/` إذا لم تكن موجودة
3. اشتغل على **3 issues أكثر طلباً فقط** في الأسابيع الأولى

### لو Anthropic تواصلت (C&D أو تحذير)
1. **لا تردّ الفوريّ** — خذ 24 ساعة
2. اعرض على محامٍ (الكثير من مكاتب القانون في MENA تقبل مشاورات أوّليّة مجانيّة)
3. تجنّب ادّعاءات مثل "Claude-powered" → استخدم "compatible with Claude Max via official CLI"

### لو نجح أكثر من المتوقّع (5K+ stars أسبوع 1)
1. **لا تستقبل كل عرض consulting**. اختَر 2 فقط.
2. **افتح GitHub Sponsors** اليوم الأوّل
3. **اكتب follow-up post**: "Week 1 in numbers" — يُحرّك موجة ثانية
4. **لا تعد بميّزات علنيّة** — هذا يُعطّلك لأشهر

---

## 💰 Post-Launch Monetization — الخطوات الفوريّة إذا نجح

### في أوّل أسبوع:
- [ ] فعّل GitHub Sponsors (مجّاني)
- [ ] أضف رابط Polar.sh للدفع المباشر
- [ ] أضف سطر في README: "Need help integrating for your team? Email me."

### في أوّل 30 يوماً:
- [ ] أوّل عميل consulting ($1.5K–5K setup fee)
- [ ] Landing page بسيط (claude-companion.dev أو .io)
- [ ] Newsletter signup form — يبني قائمة للعروض المستقبلية

### في أوّل 90 يوماً:
- [ ] **حدّد vertical واحد** فقط (من التحليل السابق)
- [ ] MVP عموديّ مدفوع
- [ ] أوّل 5 عملاء مدفوعين

---

## 📁 ملخّص الملفات الثلاثة

| ملف | ماذا يحوي | متى يُستخدم |
|---|---|---|
| `01-demo-script.md` | سكريبت فيديو 60-90s بلغتين + specs تصوير | قبل أيّ نشر بيومين |
| `02-launch-copy.md` | نسخ جاهزة لـ HN, X, LinkedIn, Reddit, PH, cold email | يوم النشر |
| `03-launch-checklist.md` | هذا الملف — خطوة بخطوة لـ 48 ساعة | يوم النشر -1 → يوم +2 |

---

## ✋ قبل النشر بيوم واحد — قراءة أخيرة

ارجع لـ `CLAUDE.md` و `ADVERSARIAL_REVIEW.md` في الجذر. اسأل نفسك:

- هل أنا مستعدّ لأوّل استخدام سيئ النيّة؟
- هل أنا مستعدّ لأوّل security report؟
- هل أنا مستعدّ لأن يُهمَل المشروع لأسبوع بسبب الحمل ثم أعود؟

إذا نعم في الثلاث → **انشر**.

حظّاً موفّقاً. أنا معك في كلّ خطوة.
