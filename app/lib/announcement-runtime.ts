export type NativeAnnouncementHosts = {
  windows: boolean;
  androidBridge: boolean;
  ios: boolean;
  userAgent: string;
};

/** A native app owns alarms; the browser timer must not try to play them too. */
export function shouldRunBrowserAnnouncementScheduler(hosts: NativeAnnouncementHosts): boolean {
  const androidApp = /GymEGManagerAndroid|GymOSManagerAndroid/i.test(hosts.userAgent);
  return !(hosts.windows || hosts.androidBridge || androidApp || hosts.ios);
}
