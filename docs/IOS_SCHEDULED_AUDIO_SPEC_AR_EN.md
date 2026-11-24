# مواصفات ودمج النداءات الصوتية المجدولة لنظام iOS / iPhone
# iOS Scheduled Audio Announcements Integration Specification

## 1. نظرة عامة / Overview
يفتقر نظام iOS إلى إمكانية تشغيل صوت تلقائي عبر JavaScript من خلفية النظام عند إغلاق أو تعليق WKWebView بسبب سياسات Apple الصارمة لحفظ الطاقة والخصوصية.
يستعرض هذا المستند البنية الهندسية اللازمة لدمج نداءات GYMEG الصوتية المجدولة في تطبيق iPhone الأصلي (Native iOS App) باستخدام Swift و`UNUserNotificationCenter` و`WKScriptMessageHandler`.

iOS strictly prohibits background JavaScript execution and background `audio.play()` calls when the web view is suspended or the app is closed. This specification defines the production integration required for the native iOS application wrapper.

---

## 2. القيود النظامية الصارمة في iOS / Strict iOS System Constraints

1. **الحد الأقصى لملف الصوت (Custom Sound Limit):**
   - تشترط Apple ألا تتجاوز مدة الملف الصوتي المخصص في `UNNotificationSound` **30 ثانية**.
   - أي ملف يتجاوز 30 ثانية ترفضه الخدمة أو ترجع إلى صوت التنبيه الافتراضي للنظام.
   - في GYMEG، يتم تكوين الملف الصوتي الموحد بحيث تكون مدة (صوت التنبيه الأول + النداء + صوت التنبيه الثاني) **أقل من 30 ثانية إلزاميًا** (مع هامش أمان: 29.5 ثانية).

2. **صيغة الصوت المدعومة (Audio Format):**
   - الصيغ المدعومة رسميًا في `UNNotificationSound` هي:
     - Linear PCM WAV (16-bit, mono/stereo, 44.1kHz).
     - AIFF.
     - CAF (Core Audio Format).
   - لا يُدعم تشغيل MP3 مباشرة كصوت إشعار مخصص في خلفية نظام iOS عبر UNNotificationCenter؛ لذلك يقوم نظام GYMEG بإنشاء ملف PCM WAV موحد متوافق 100%.

3. **موقع حفظ الملف الصوتي (Directory):**
   - يجب أن يُحفظ الملف في مسار `Library/Sounds/` داخل مجلد بيانات التطبيق (App Container Data)، أو يكون مضمّنًا في Main Bundle.
   - الملفات في مسار `tmp/` أو `Documents/` لا يتعرف عليها محرك الإشعارات في iOS كأصوات تنبيه.

4. **حد الإشعارات المحلية المعلقة (Pending Notification Limit):**
   - يفرض iOS حدًا أقصى قدره **64 إشعارًا محليًا معلقًا** (Pending Requests) لكل تطبيق.
   - يقوم `GymOSAnnouncementScheduler` بتنظيف وجدولة المواعيد الدورية بما لا يتجاوز هذا الحد.

5. **سلوك وضع الصامت وعدم الإزعاج (Silent Switch & Focus Modes):**
   - الإشعارات العادية بصوت مخصص **لا تتجاوز** مفتاح الصامت (Hardware Silent Switch) أو وضع التركيز (Focus Mode / Do Not Disturb) ما لم يحصل التطبيق على ترخيص خاص من Apple يُعرف باسم `Critical Alerts` (المخصص لتطبيقات الطوارئ الطبية والحرائق فقط).
   - عند فتح التطبيق في المقدمة (Foreground)، يُشغل الصوت عبر `AVAudioSession` بفئة `.playback` مع خيار `.duckOthers` لتجاوز وضع الصامت حسب رغبة مدير الصالة.

6. **إغلاق التطبيق إجباريًا (Force Quit):**
   - إذا قام المستخدم بإغلاق التطبيق بالسحب للأعلى (Force Quit)، تظل إشعارات `UNNotificationRequest` المجدولة مسبقًا تعمل في مواعيدها بصوتها المخصص، ولكن كود JavaScript داخل WKWebView لا يعمل إطلاقًا حتى يعيد المستخدم فتح التطبيق.

---

## 3. خطوات التثبيت في مشروع Xcode / Integration Steps in Xcode

### أ. إضافة الملفات إلى المشروع
أضف الملف التالي الموجود في المستودع إلى مجلد المشروع في Xcode:
- `ios-support/GymOSAnnouncementScheduler.swift`

### ب. ربط المعالج بـ WKWebView
في ملف `ViewController.swift`:
```swift
import UIKit
import WebKit

class WebViewController: UIViewController {
    var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        let contentController = WKUserContentController()
        // تسجيل جسر النداءات الصوتية
        GymOSAnnouncementScheduler.shared.attach(to: contentController)

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        // السماح بالتشغيل التلقائي للصوت بعد تفاعل المستخدم الأولي
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: view.bounds, configuration: config)
        view.addSubview(webView)

        // طلب إذن الإشعارات من المستخدم
        GymOSAnnouncementScheduler.shared.requestPermissions { granted in
            print("Notification permission: \(granted)")
        }

        if let url = URL(string: "https://gymeg.vercel.app/clubs") {
            webView.load(URLRequest(url: url))
        }
    }
}
```

### ج. إعداد Info.plist
أضف المفاتيح التالية لتمكين الصوت في الخلفية والإشعارات:
```xml
<key>UIBackgroundModes</key>
<array>
    <string>audio</string>
</array>
```

---

## 4. تدفق البيانات بين الواجهة وتطبيق iOS (Bridge Protocol)

عند قيام المستخدم بجدولة نداء في واجهة GYMEG، يقوم التطبيق تلقائيًا بالتحقق:
```javascript
if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.gymosAnnouncementBridge) {
  window.webkit.messageHandlers.gymosAnnouncementBridge.postMessage({
    action: "sync",
    items: [
      {
        id: "ann-uuid",
        name: "نداء الإغلاق",
        times: ["22:00"],
        days: [0, 1, 2, 3, 4, 5, 6],
        enabled: true,
        wavBase64: "<COMPOSED_WAV_PCM_BASE64_UNDER_30S>"
      }
    ]
  });
}
```

يستقبل تطبيق iOS الطلب، ويحفظ ملف WAV في `Library/Sounds/ann_ann-uuid.wav`، ويقوم بإنشاء `UNCalendarNotificationTrigger` لكل موعد زمني محدد.
عند حلول الموعد، يصدر نظام iOS الصوت الموحد بالكامل (التنبيه + النداء + التنبيه) حتى ولو كانت شاشة الهاتف مغلقة أو كان التطبيق في الخلفية.
