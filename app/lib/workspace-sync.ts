import type {Packet} from './client-types';
import type {GymState} from './domain';

export interface DeltaEvent {
  id: string;
  revision: number;
  eventType: 'entity.upsert' | 'entity.delete' | 'metadata.update';
  collection?: string;
  entityId?: string;
  branch?: string | null;
  payload?: any;
}

export interface DeltaResponse {
  requiresSnapshot: boolean;
  fromRevision: number;
  toRevision: number;
  hasMore: boolean;
  events: DeltaEvent[];
}

export type SyncStatus = 'connecting' | 'connected' | 'syncing' | 'reconnecting' | 'offline';

export interface SyncOptions {
  tenantId: string;
  owner: string;
  initialRevision: number;
  getCurrentPacket: () => Packet | null;
  onPacketUpdate: (packet: Packet) => void;
  onSnapshotRequired: () => void;
  onStatusChange?: (status: SyncStatus) => void;
}

/**
 * Pure function to apply incremental delta events onto a local Packet.
 * Modifies state immutably and returns the updated Packet.
 */
export function applyWorkspaceDeltas(prev: Packet | null, events: DeltaEvent[]): Packet | null {
  if (!prev) return null;
  if (!events || !events.length) return prev;

  const nextState: GymState = {...prev.state};
  let latestRevision = prev.revision;

  for (const ev of events) {
    if (ev.revision > latestRevision) {
      latestRevision = ev.revision;
    }

    if (ev.eventType === 'metadata.update' && ev.payload) {
      if (ev.payload.settings) {
        nextState.settings = {...nextState.settings, ...ev.payload.settings};
      }
      continue;
    }

    const col = ev.collection as keyof GymState;
    if (!col || !Array.isArray(nextState[col])) {
      continue;
    }

    const list = [...(nextState[col] as any[])];

    if (ev.eventType === 'entity.delete') {
      const idx = list.findIndex(item => item.id === ev.entityId);
      if (idx !== -1) {
        list.splice(idx, 1);
        (nextState as any)[col] = list;
      }
    } else if (ev.eventType === 'entity.upsert' && ev.payload) {
      const idx = list.findIndex(item => item.id === ev.entityId);
      if (idx !== -1) {
        list[idx] = ev.payload;
      } else {
        list.push(ev.payload);
      }
      (nextState as any)[col] = list;
    }
  }

  return {
    ...prev,
    revision: latestRevision,
    state: nextState
  };
}

/**
 * Manages real-time channel subscription and incremental Delta recovery.
 */
export class WorkspaceSyncManager {
  private status: SyncStatus = 'connecting';
  private currentRevision: number;
  private syncing = false;
  private channel: any = null;
  private unmounted = false;
  private reconnectTimer: any = null;
  private retryAttempt = 0;

  private options: SyncOptions;

  constructor(options: SyncOptions) {
    this.options = options;
    this.currentRevision = options.initialRevision;
  }

  public getStatus(): SyncStatus {
    return this.status;
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  public updateLocalRevision(rev: number) {
    if (rev > this.currentRevision) {
      this.currentRevision = rev;
    }
  }

  /**
   * Starts realtime subscription.
   */
  public async start(realtimeClient?: any) {
    this.unmounted = false;
    this.setStatus('connecting');

    if (realtimeClient && typeof realtimeClient.channel === 'function') {
      try {
        const topic = `club:${this.options.tenantId}:workspace`;
        this.channel = realtimeClient.channel(topic, {
          config: {
            broadcast: { ack: false, self: false }
          }
        });

        this.channel
          .on('broadcast', { event: 'workspace.updated' }, (payload: any) => {
            const remoteRev = payload?.payload?.revision;
            if (typeof remoteRev === 'number' && remoteRev > this.currentRevision) {
              void this.pullDeltas();
            }
          })
          .subscribe((status: string) => {
            if (this.unmounted) return;
            if (status === 'SUBSCRIBED') {
              this.retryAttempt = 0;
              this.setStatus('connected');
              // Catch up on any events that happened while connecting
              void this.pullDeltas();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              this.handleDisconnect();
            }
          });
      } catch (e) {
        this.handleDisconnect();
      }
    } else {
      // Fallback mode without Supabase client: still connected via delta pulls
      this.setStatus('connected');
    }

    // Attach visibility & network listeners for instant catch-up
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      document.addEventListener('visibilitychange', this.handleVisibility);
    }
  }

  private handleOnline = () => {
    if (this.unmounted) return;
    this.setStatus('reconnecting');
    void this.pullDeltas();
  };

  private handleVisibility = () => {
    if (this.unmounted) return;
    if (document.visibilityState === 'visible') {
      void this.pullDeltas();
    }
  };

  private handleDisconnect() {
    if (this.unmounted) return;
    this.setStatus('reconnecting');
    this.retryAttempt++;
    // Exponential backoff with jitter: 2s, 4s, 8s ... max 30s
    const delay = Math.min(30000, Math.pow(2, this.retryAttempt) * 1000 + Math.random() * 1000);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.unmounted) {
        void this.pullDeltas();
      }
    }, delay);
  }

  /**
   * Fetches missed delta changes from the Delta API.
   */
  public async pullDeltas(): Promise<boolean> {
    if (this.syncing || this.unmounted) return false;
    this.syncing = true;
    const prevStatus = this.status;
    this.setStatus('syncing');

    try {
      let hasMore = true;
      while (hasMore && !this.unmounted) {
        const current = this.options.getCurrentPacket();
        const currentRev = current?.revision ?? this.currentRevision;
        const url = `/api/workspace/changes?after=${currentRev}`;
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: {
            'Accept': 'application/json',
            'X-GymOS-Tenant': this.options.owner
          },
          signal: AbortSignal.timeout(8000)
        });

        if (!res.ok) {
          if (res.status === 409 || res.status === 503) {
            // Server asks for full snapshot or is temporarily unavailable
            this.options.onSnapshotRequired();
            return false;
          }
          throw new Error(`Delta fetch failed with status ${res.status}`);
        }

        const data: DeltaResponse = await res.json();

        if (data.requiresSnapshot) {
          this.options.onSnapshotRequired();
          return false;
        }

        if (data.events && data.events.length > 0) {
          const current = this.options.getCurrentPacket();
          if (current) {
            const updated = applyWorkspaceDeltas(current, data.events);
            if (updated) {
              this.options.onPacketUpdate(updated);
              this.currentRevision = data.toRevision;
            }
          }
        }

        if (!data.events || data.events.length === 0) {
          this.currentRevision = Math.max(this.currentRevision, data.toRevision);
        }
        hasMore = data.hasMore;
      }

      this.setStatus('connected');
      return true;
    } catch {
      this.setStatus(prevStatus === 'connected' ? 'connected' : 'reconnecting');
      return false;
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Stops listeners and cleans up channel.
   */
  public destroy() {
    this.unmounted = true;
    clearTimeout(this.reconnectTimer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      document.removeEventListener('visibilitychange', this.handleVisibility);
    }
    if (this.channel) {
      try {
        this.channel.unsubscribe();
      } catch {}
      this.channel = null;
    }
  }
}
