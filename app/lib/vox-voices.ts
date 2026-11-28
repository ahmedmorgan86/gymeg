export interface VoxVoiceOption {
  id: string;
  nameAr: string;
  nameEn: string;
  gender: 'male' | 'female';
  ageGroup: 'young' | 'adult' | 'mature';
  timbreAr: string;
  timbreEn: string;
}

export const VOX_VOICES: VoxVoiceOption[] = [
  { id: 'Puck', nameAr: 'باك (Puck) — شبابي مصري مقترح', nameEn: 'Puck — Recommended Youthful', gender: 'male', ageGroup: 'young', timbreAr: 'شبابي وحيوي', timbreEn: 'Upbeat & Youthful' },
  { id: 'Kore', nameAr: 'كوري (Kore)', nameEn: 'Kore', gender: 'female', ageGroup: 'adult', timbreAr: 'دافئ ورخيم', timbreEn: 'Warm & Articulate' },
  { id: 'Charon', nameAr: 'شارون (Charon)', nameEn: 'Charon', gender: 'male', ageGroup: 'mature', timbreAr: 'باريتون عميق', timbreEn: 'Deep Baritone' },
  { id: 'Fenrir', nameAr: 'فنرير (Fenrir)', nameEn: 'Fenrir', gender: 'male', ageGroup: 'adult', timbreAr: 'قوي وحماسي', timbreEn: 'Commanding & Energetic' },
  { id: 'Zephyr', nameAr: 'زفير (Zephyr)', nameEn: 'Zephyr', gender: 'female', ageGroup: 'young', timbreAr: 'ناعم وهادئ', timbreEn: 'Soft & Gentle' },
  { id: 'Aoede', nameAr: 'أويدي (Aoede)', nameEn: 'Aoede', gender: 'female', ageGroup: 'young', timbreAr: 'مشرق وودود', timbreEn: 'Bright & Friendly' },
  { id: 'Leda', nameAr: 'ليدا (Leda)', nameEn: 'Leda', gender: 'female', ageGroup: 'young', timbreAr: 'عصري وحيوي', timbreEn: 'Youthful & Modern' },
  { id: 'Orus', nameAr: 'أوروس (Orus)', nameEn: 'Orus', gender: 'male', ageGroup: 'mature', timbreAr: 'حازم وواضح', timbreEn: 'Firm & Clear' },
  { id: 'Callirrhoe', nameAr: 'كاليروي (Callirrhoe)', nameEn: 'Callirrhoe', gender: 'female', ageGroup: 'adult', timbreAr: 'سلس وواضح', timbreEn: 'Easygoing & Clear' },
  { id: 'Autonoe', nameAr: 'أوتونوي (Autonoe)', nameEn: 'Autonoe', gender: 'female', ageGroup: 'adult', timbreAr: 'مشرق ومتفائل', timbreEn: 'Bright & Optimistic' },
  { id: 'Enceladus', nameAr: 'إنسيلادوس (Enceladus)', nameEn: 'Enceladus', gender: 'male', ageGroup: 'adult', timbreAr: 'دافئ ومسترخٍ', timbreEn: 'Warm & Relaxed' },
  { id: 'Iapetus', nameAr: 'إيابيتوس (Iapetus)', nameEn: 'Iapetus', gender: 'male', ageGroup: 'adult', timbreAr: 'واضح ومباشر', timbreEn: 'Clear & Direct' },
  { id: 'Umbriel', nameAr: 'أومبرييل (Umbriel)', nameEn: 'Umbriel', gender: 'male', ageGroup: 'adult', timbreAr: 'هادئ ومتزن', timbreEn: 'Easygoing & Balanced' },
  { id: 'Algieba', nameAr: 'الجيبـا (Algieba)', nameEn: 'Algieba', gender: 'male', ageGroup: 'adult', timbreAr: 'سلس ورصين', timbreEn: 'Smooth & Poised' },
  { id: 'Despina', nameAr: 'ديسبينا (Despina)', nameEn: 'Despina', gender: 'female', ageGroup: 'adult', timbreAr: 'سلس ودافئ', timbreEn: 'Smooth & Warm' },
  { id: 'Erinome', nameAr: 'إيرينومي (Erinome)', nameEn: 'Erinome', gender: 'female', ageGroup: 'adult', timbreAr: 'واضح ومنضبط', timbreEn: 'Clear & Crisp' },
  { id: 'Algenib', nameAr: 'الجنب (Algenib)', nameEn: 'Algenib', gender: 'male', ageGroup: 'mature', timbreAr: 'خشن وقوي', timbreEn: 'Gravelly & Strong' },
  { id: 'Rasalgethi', nameAr: 'رأس الجاثي (Rasalgethi)', nameEn: 'Rasalgethi', gender: 'male', ageGroup: 'mature', timbreAr: 'إخباري رصين', timbreEn: 'Informative & Steady' },
  { id: 'Laomedeia', nameAr: 'لاوميديا (Laomedeia)', nameEn: 'Laomedeia', gender: 'female', ageGroup: 'young', timbreAr: 'حيوي ومبتهج', timbreEn: 'Upbeat & Cheerful' },
  { id: 'Achernar', nameAr: 'آخر النهر (Achernar)', nameEn: 'Achernar', gender: 'female', ageGroup: 'adult', timbreAr: 'لطيف وناعم', timbreEn: 'Soft & Polite' },
  { id: 'Alnilam', nameAr: 'النظام (Alnilam)', nameEn: 'Alnilam', gender: 'male', ageGroup: 'adult', timbreAr: 'حازم وواثق', timbreEn: 'Firm & Confident' },
  { id: 'Schedar', nameAr: 'الصدر (Schedar)', nameEn: 'Schedar', gender: 'male', ageGroup: 'adult', timbreAr: 'متوازن وهادئ', timbreEn: 'Even & Grounded' },
  { id: 'Gacrux', nameAr: 'جاكروكس (Gacrux)', nameEn: 'Gacrux', gender: 'female', ageGroup: 'mature', timbreAr: 'ناضج ووقور', timbreEn: 'Mature & Dignified' },
  { id: 'Pulcherrima', nameAr: 'بولشيريما (Pulcherrima)', nameEn: 'Pulcherrima', gender: 'female', ageGroup: 'young', timbreAr: 'معبّر وواضح', timbreEn: 'Forward & Expressive' },
  { id: 'Achird', nameAr: 'أخيرد (Achird)', nameEn: 'Achird', gender: 'male', ageGroup: 'young', timbreAr: 'ودود وقريب', timbreEn: 'Friendly & Approachable' },
  { id: 'Zubenelgenubi', nameAr: 'الزبانى الجنوبي (Zubenelgenubi)', nameEn: 'Zubenelgenubi', gender: 'male', ageGroup: 'adult', timbreAr: 'عفوي وطبيعي', timbreEn: 'Casual & Natural' },
  { id: 'Vindemiatrix', nameAr: 'فينديمياتريكس (Vindemiatrix)', nameEn: 'Vindemiatrix', gender: 'female', ageGroup: 'adult', timbreAr: 'لطيف وهادئ', timbreEn: 'Gentle & Calm' },
  { id: 'Sadachbia', nameAr: 'سعد الأخبية (Sadachbia)', nameEn: 'Sadachbia', gender: 'female', ageGroup: 'young', timbreAr: 'نشيط ومشرق', timbreEn: 'Lively & Bright' },
  { id: 'Sadaltager', nameAr: 'سعد التاجر (Sadaltager)', nameEn: 'Sadaltager', gender: 'male', ageGroup: 'adult', timbreAr: 'خبير وموثوق', timbreEn: 'Knowledgeable & Trusted' },
  { id: 'Sulafat', nameAr: 'السلحفاة (Sulafat)', nameEn: 'Sulafat', gender: 'female', ageGroup: 'adult', timbreAr: 'دافئ وحنون', timbreEn: 'Warm & Soothing' }
];

export const VOX_ARABIC_DIALECTS = [
  { id: 'egyptian', ar: 'مصرية عامية (القاهرة)', en: 'Egyptian Arabic (Cairo)' },
  { id: 'egyptian_saidi', ar: 'مصرية صعيدية', en: 'Upper Egyptian (Saidi)' },
  { id: 'msa', ar: 'العربية الفصحى المعاصرة', en: 'Modern Standard Arabic' },
  { id: 'classical', ar: 'فصحى كلاسيكية', en: 'Classical Arabic' },
  { id: 'saudi_najdi', ar: 'سعودية نجدية', en: 'Saudi Najdi' },
  { id: 'saudi_hijazi', ar: 'سعودية حجازية', en: 'Saudi Hijazi' },
  { id: 'emirati', ar: 'إماراتية', en: 'Emirati' },
  { id: 'kuwaiti', ar: 'كويتية', en: 'Kuwaiti' },
  { id: 'qatari_bahraini', ar: 'قطرية وبحرينية', en: 'Qatari & Bahraini' },
  { id: 'syrian', ar: 'سورية شامية', en: 'Syrian Levantine' },
  { id: 'lebanese', ar: 'لبنانية', en: 'Lebanese' },
  { id: 'jordanian_palestinian', ar: 'أردنية وفلسطينية', en: 'Jordanian & Palestinian' },
  { id: 'iraqi', ar: 'عراقية بغدادية', en: 'Iraqi Baghdadi' },
  { id: 'sudanese', ar: 'سودانية', en: 'Sudanese' },
  { id: 'yemeni', ar: 'يمنية', en: 'Yemeni' },
  { id: 'moroccan', ar: 'مغربية دارجة', en: 'Moroccan Darija' },
  { id: 'algerian', ar: 'جزائرية', en: 'Algerian' },
  { id: 'tunisian', ar: 'تونسية', en: 'Tunisian' }
] as const;

export const VOX_ENGLISH_DIALECTS = [
  { id: 'american', ar: 'إنجليزية أمريكية', en: 'American English' },
  { id: 'british', ar: 'إنجليزية بريطانية (RP)', en: 'British English (RP)' },
  { id: 'british_london', ar: 'بريطانية عصرية (لندن)', en: 'London British' },
  { id: 'canadian', ar: 'كندية', en: 'Canadian English' },
  { id: 'australian', ar: 'أسترالية', en: 'Australian English' }
] as const;

export const VOX_STYLES = [
  { id: 'Friendly, upbeat, energetic young gym announcer', ar: 'شبابي حماسي وودود (مذيع جيم)', en: 'Energetic & friendly gym announcer' },
  { id: 'Natural and clear professional speaker', ar: 'طبيعي وواضح (استقبال احترافي)', en: 'Natural & clear professional' },
  { id: 'Warm, welcoming and hospitable tone', ar: 'دافئ ومرحّب بالأعضاء', en: 'Warm & welcoming' },
  { id: 'Urgent, clear closing reminder with polite urgency', ar: 'تنبيه حازم ومهذب (قبل الإغلاق)', en: 'Polite closing reminder' },
  { id: 'Calm, soothing and relaxing wellness voice', ar: 'هادئ ومريح (للاسترخاء والسبا)', en: 'Calm & relaxing' },
  { id: 'Dramatic, deep and motivational sports coach', ar: 'ملهم وقوي (تحفيز رياضي)', en: 'Motivational sports coach' }
] as const;
