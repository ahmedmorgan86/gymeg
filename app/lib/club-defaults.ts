import { dayAt, type GymState } from './domain.ts';
import { defaultWhatsApp, WHATSAPP_TEMPLATE_PRESETS } from './manual-whatsapp.ts';

/**
 * Seeds default WhatsApp templates (all member statuses, religious holidays,
 * general holidays, and offers) for a newly created club/branch.
 */
export function seedNewClubDefaults(state: GymState, now = new Date().toISOString()): GymState {
  const today = dayAt(now, state.settings.timezone);

  state.manualWhatsApp ??= [];

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
  }
  return state;
}
