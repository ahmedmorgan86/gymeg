import { readDevicePreferences } from './device-preferences';

type WebViewHost = { postMessage: (data: unknown) => void };

/**
 * Triggers the configured local turnstile/gate relay via the Windows WebView2 bridge
 * when a member checks in or an administrator tests the gate.
 */
export function triggerClubGate(scope: string | null, reason: 'checkin' | 'test', memberId?: string): boolean {
  if (!scope || typeof window === 'undefined') return false;
  const host = (window as Window & { chrome?: { webview?: WebViewHost } }).chrome?.webview;
  if (!host) return false;
  const prefs = readDevicePreferences(scope);
  if (!prefs.gateEnabled || !prefs.gateEndpoint?.trim()) return false;
  try {
    host.postMessage({
      type: 'gymos-desktop',
      action: 'openGate',
      protocol: prefs.gateProtocol ?? 'http-relay',
      endpoint: prefs.gateEndpoint.trim(),
      pulseMs: prefs.gatePulseMs ?? 1500,
      reason,
      member: memberId ?? '',
    });
    return true;
  } catch {
    return false;
  }
}
