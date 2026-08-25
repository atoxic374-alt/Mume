# Lavalink on Railway

هذا المجلد يبني خدمة Lavalink 4.2.2 مستقلة على Railway. الصورة الأساسية تحتوي على Java 17 وLavalink و`youtube-plugin-1.18.2.jar`. يضيف البناء `lavasrc-plugin-4.8.3.jar` لتفعيل Spotify، بينما SoundCloud يعمل من مصدر Lavalink المدمج.

## خدمة Lavalink في Railway

اجعل Railway يستخدم هذا المجلد كـ Root Directory أو انقل محتوياته إلى مستودع خدمة Lavalink. استخدم Dockerfile الموجود هنا، ثم أضف المتغيرات التالية في خدمة Lavalink:

| Variable | Value |
|---|---|
| `PORT` | `8080` |
| `LAVALINK_SERVER_PASSWORD` | كلمة مرور قوية جديدة، غير موجودة في Git |
| `SPOTIFY_CLIENT_ID` | Client ID من Spotify Developer Dashboard |
| `SPOTIFY_CLIENT_SECRET` | Client Secret من Spotify Developer Dashboard |
| `SPOTIFY_COUNTRY_CODE` | `US` أو رمز بلدك المكوّن من حرفين |

لا تضع `LAVALINK_PASS` في خدمة Lavalink؛ هذا الاسم مخصص لخدمة Mume. لا تستخدم كلمة المرور القديمة التي كانت في المستودع.

## متغيرات خدمة Mume

إذا كان اسم خدمة Lavalink في Railway هو `lavalink`، استخدم الشبكة الخاصة بين الخدمتين:

| Variable | Value |
|---|---|
| `LAVALINK_HOST` | `lavalink.railway.internal` |
| `LAVALINK_PORT` | `8080` |
| `LAVALINK_SECURE` | `false` |
| `LAVALINK_PASS` | نفس قيمة `LAVALINK_SERVER_PASSWORD` في خدمة Lavalink |
| `LAVALINK_RESUME_TIMEOUT_SEC` | `600` |

إذا كان اسم الخدمة مختلفًا، استبدل `lavalink` باسم الخدمة الفعلي. لا تستخدم النطاق العام `*.up.railway.app` إلا كحل بديل؛ الاتصال الداخلي أسرع وأقل عرضة للمشاكل، ولا يحتاج نطاقًا عامًا أو TLS.

## التشغيل

بعد إضافة المتغيرات، انشر خدمة Lavalink أولًا وتأكد من ظهور الإضافتين في السجل: `youtube-plugin-1.18.2.jar` و`lavasrc-plugin-4.8.3.jar`. بعدها أعد تشغيل خدمة Mume. يجب أن ينجح تشغيل روابط YouTube وSoundCloud، وأن تُحل روابط Spotify إلى صوت قابل للتشغيل عبر موفّر `ytsearch`.

## ملاحظات أمنية وأدائية

تم تعطيل مصادر `http` و`local` غير المطلوبة لتقليل سطح الهجوم. تم إبقاء `opusEncodingQuality: 10` لجودة ترميز الصوت، مع `resamplingQuality: LOW` لتقليل استهلاك CPU دون التأثير المعتاد على جودة ملفات المصدر. تم تعطيل request payload logging في الإنتاج حتى لا تُسجل روابط المستخدمين ولا يزداد الحمل بلا فائدة.

## المصادر

[توثيق Lavalink للإعدادات](https://lavalink.dev/configuration/)

[توثيق Lavalink للإضافات](https://lavalink.dev/plugins)

[YouTube Source Plugin](https://github.com/lavalink-devs/youtube-source)

[LavaSrc](https://github.com/topi314/LavaSrc)

[Railway Private Networking](https://docs.railway.com/networking/private-networking)
