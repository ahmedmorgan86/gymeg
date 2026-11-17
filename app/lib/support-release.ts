import QRCode from 'qrcode';
import supportRelease from '../../public/downloads/support-android.json' with { type: 'json' };
import managementRelease from '../../public/downloads/gymeg-management-android.json' with { type: 'json' };
import membersRelease from '../../public/downloads/gymeg-members-android.json' with { type: 'json' };

export type AndroidVariantId = 'support' | 'management' | 'members';

export const supportApkVersion = supportRelease.version;
export const supportApkUrl = supportRelease.url;
export const supportApkFilename = supportRelease.url.split('/').pop() ?? `GymEG-Support-Android-${supportRelease.version}.apk`;
export const supportMinAndroid = supportRelease.minAndroid;
export const supportInstallPath = '/support-install';
export const supportMobileEntryPath = '/mobile/support';
export const supportFallbackQrPath = '/downloads/support-mobile-qr.png';

export const managementApkVersion = managementRelease.version;
export const managementApkUrl = managementRelease.url;
export const managementApkFilename = managementRelease.url.split('/').pop() ?? `GymEG-Manager-Android-${managementRelease.version}.apk`;
export const managementMinAndroid = managementRelease.minAndroid;
export const managementInstallPath = '/management-install';
export const managementMobileEntryPath = '/mobile/management';
export const managementFallbackQrPath = '/downloads/gymeg-management-qr.png';

export const membersApkVersion = membersRelease.version;
export const membersApkUrl = membersRelease.url;
export const membersApkFilename = membersRelease.url.split('/').pop() ?? `GymEG-Members-Android-${membersRelease.version}.apk`;
export const membersMinAndroid = membersRelease.minAndroid;
export const membersInstallPath = '/member-install';
export const membersMobileEntryPath = '/mobile/member';
export const membersFallbackQrPath = '/downloads/gymeg-member-qr.png';

export interface AndroidVariantInfo {
  id: AndroidVariantId;
  version: string;
  url: string;
  filename: string;
  minAndroid: string;
  installPath: string;
  mobileEntryPath: string;
  fallbackQrPath: string;
  iconPath: string;
  arTitle: string;
  enTitle: string;
  arCta: string;
  enCta: string;
  arNavLabel: string;
  enNavLabel: string;
  arQrAlt: string;
  enQrAlt: string;
}

export const androidAppVariants: readonly AndroidVariantInfo[] = [
  {
    id: 'support',
    version: supportApkVersion,
    url: supportApkUrl,
    filename: supportApkFilename,
    minAndroid: supportMinAndroid,
    installPath: supportInstallPath,
    mobileEntryPath: supportMobileEntryPath,
    fallbackQrPath: supportFallbackQrPath,
    iconPath: '/icons/support-192.png?v=20261030-role-icons',
    arTitle: 'تطبيق الدعم الفني',
    enTitle: 'Support App',
    arCta: `تحميل تطبيق الدعم — Android (${supportApkVersion})`,
    enCta: `Download Support APK — Android (${supportApkVersion})`,
    arNavLabel: `تحميل تطبيق الدعم APK (${supportApkVersion})`,
    enNavLabel: `Download Support APK (${supportApkVersion})`,
    arQrAlt: 'QR تحميل تطبيق الدعم',
    enQrAlt: 'Support app download QR',
  },
  {
    id: 'management',
    version: managementApkVersion,
    url: managementApkUrl,
    filename: managementApkFilename,
    minAndroid: managementMinAndroid,
    installPath: managementInstallPath,
    mobileEntryPath: managementMobileEntryPath,
    fallbackQrPath: managementFallbackQrPath,
    iconPath: '/icons/icon-192.png?v=20261029-gymeg',
    arTitle: 'تطبيق إدارة النادي',
    enTitle: 'Manager App',
    arCta: `تحميل تطبيق الإدارة — Android (${managementApkVersion})`,
    enCta: `Download Manager APK — Android (${managementApkVersion})`,
    arNavLabel: `تحميل تطبيق الإدارة APK (${managementApkVersion})`,
    enNavLabel: `Download Manager APK (${managementApkVersion})`,
    arQrAlt: 'QR تحميل تطبيق الإدارة',
    enQrAlt: 'Management app download QR',
  },
  {
    id: 'members',
    version: membersApkVersion,
    url: membersApkUrl,
    filename: membersApkFilename,
    minAndroid: membersMinAndroid,
    installPath: membersInstallPath,
    mobileEntryPath: membersMobileEntryPath,
    fallbackQrPath: membersFallbackQrPath,
    iconPath: '/icons/members-192.png?v=20261030-role-icons',
    arTitle: 'تطبيق أعضاء النادي',
    enTitle: 'Members App',
    arCta: `تحميل تطبيق الأعضاء — Android (${membersApkVersion})`,
    enCta: `Download Members APK — Android (${membersApkVersion})`,
    arNavLabel: `تحميل تطبيق الأعضاء APK (${membersApkVersion})`,
    enNavLabel: `Download Members APK (${membersApkVersion})`,
    arQrAlt: 'QR تحميل تطبيق الأعضاء',
    enQrAlt: 'Member app download QR',
  },
];

export function resolveDeploymentOrigin(origin?: string | null): string {
  const candidates = [
    origin?.trim(),
    typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_SITE_URL?.trim() : undefined,
    supportRelease.origin,
    'https://gymeg.vercel.app',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) {
        return parsed.origin;
      }
    } catch {
      continue;
    }
  }
  return 'https://gymeg.vercel.app';
}

export function resolveSupportApkUrl(origin?: string | null): string {
  if (!origin) return supportApkUrl;
  return new URL(supportApkUrl, resolveDeploymentOrigin(origin)).toString();
}

export function resolveSupportInstallUrl(origin?: string | null): string {
  if (!origin) return supportInstallPath;
  return new URL(supportInstallPath, resolveDeploymentOrigin(origin)).toString();
}

export function resolveManagementApkUrl(origin?: string | null): string {
  if (!origin) return managementApkUrl;
  return new URL(managementApkUrl, resolveDeploymentOrigin(origin)).toString();
}

export function resolveManagementInstallUrl(origin?: string | null): string {
  if (!origin) return managementInstallPath;
  return new URL(managementInstallPath, resolveDeploymentOrigin(origin)).toString();
}

export function resolveMembersApkUrl(origin?: string | null): string {
  if (!origin) return membersApkUrl;
  return new URL(membersApkUrl, resolveDeploymentOrigin(origin)).toString();
}

export function resolveMembersInstallUrl(origin?: string | null): string {
  if (!origin) return membersInstallPath;
  return new URL(membersInstallPath, resolveDeploymentOrigin(origin)).toString();
}

export async function generateQrDataUrl(targetUrl: string, fallback = supportFallbackQrPath): Promise<string> {
  try {
    const svg = await QRCode.toString(targetUrl, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
    });
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  } catch {
    return fallback;
  }
}

