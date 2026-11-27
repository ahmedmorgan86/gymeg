import { addDays, dayAt, type GymState } from './domain.ts';
import { defaultWhatsApp, WHATSAPP_TEMPLATE_PRESETS } from './manual-whatsapp.ts';

export const DEFAULT_CLOSING_ANNOUNCEMENTS = [
  {
    key: 'closing-30m',
    hour: 21,
    text: 'يا كباتن ويا أبطال، بنفكركم إن ميعاد قفل النادي قرب، والنادي هيقفل بعد نص ساعة إن شاء الله. يا ريت نبدأ نخلّص تمريننا ونجهّز نفسنا، وشكراً لتعاونكم!'
  },
  {
    key: 'closing-15m',
    hour: 21,
    text: 'تنبيه أخير يا شباب، النادي هيقفل بعد ربع ساعة بس. يا ريت الكل يخلّص تمرينه ويتفضل لغرف تغيير الملابس والاستقبال. نشوفكم على خير بكرة!'
  }
] as const;

/**
 * Seeds default WhatsApp templates (all member statuses, religious holidays,
 * general holidays, and offers) and Egyptian colloquial closing voice
 * announcements for a newly created club/branch.
 */
export function seedNewClubDefaults(state: GymState, now = new Date().toISOString()): GymState {
  const today = dayAt(now, state.settings.timezone);
  const stamp = (day: string, hour: number, minute = 0) =>
    `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;

  state.manualWhatsApp ??= [];
  state.announcements ??= [];

  const statusNames: Record<string, string> = {
    welcome: 'ترحيب بعضو جديد',
    policy: 'سياسات النادي والسلامة',
    renewal: 'قرب انتهاء الاشتراك',
    expired: 'انتهاء الاشتراك',
    absence: 'غياب وانقطاع عن التمرين',
    birthday: 'عيد ميلاد العضو'
  };

  for (const branch of state.branches) {
    const existingNames = new Set(
      state.manualWhatsApp.filter((t) => t.branch === branch.id).map((t) => t.name.trim())
    );
    for (const kind of ['welcome', 'policy', 'renewal', 'expired', 'absence', 'birthday'] as const) {
      const name = statusNames[kind];
      if (!existingNames.has(name)) {
        state.manualWhatsApp.push({
          id: `default-${branch.id}-${kind}`,
          branch: branch.id,
          name,
          kind,
          body: defaultWhatsApp(kind, true),
          enabled: true,
          offset: 7
        });
        existingNames.add(name);
      }
    }
    for (const preset of WHATSAPP_TEMPLATE_PRESETS) {
      if (preset.category === 'statuses') continue;
      if (!existingNames.has(preset.titleAr)) {
        state.manualWhatsApp.push({
          id: `default-${branch.id}-${preset.id}`,
          branch: branch.id,
          name: preset.titleAr,
          kind: preset.kind,
          body: preset.bodyAr,
          enabled: true,
          offset: preset.offset,
          ...(preset.kind === 'occasion' ? { date: today } : {})
        });
        existingNames.add(preset.titleAr);
      }
    }

    for (const [idx, item] of DEFAULT_CLOSING_ANNOUNCEMENTS.entries()) {
      const id = `default-${branch.id}-${item.key}`;
      if (!state.announcements.some((a) => a.id === id)) {
        state.announcements.push({
          id,
          branch: branch.id,
          text: item.text,
          lang: 'ar',
          voice: '',
          rate: 0.95,
          at: stamp(addDays(today, 1), item.hour, idx === 0 ? 0 : 15),
          enabled: false,
          repeat: 'daily',
          timezone: state.settings.timezone,
          priority: 1,
          quiet: { start: 22, end: 7 }
        });
      }
    }
  }
  return state;
}
