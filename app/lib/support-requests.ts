import { randomBytes } from 'node:crypto';

export type SupportRequestStatus = 'open' | 'in_progress' | 'resolved';

export type SupportRequest = {
  requester: string;
  assignee: string | null;
  title: string;
  status: SupportRequestStatus;
  updatedAt: string;
};

type Actor = { id: string; platform: boolean };
export type RequestAction = 'read' | 'reply' | 'claim' | 'resolve';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const SUPPORT_REQUEST_ID_RE = /^[A-Za-z0-9]{20}$/;

export function newSupportRequestId(): string {
  const bytes = randomBytes(20);
  let id = '';
  for (let i = 0; i < 20; i++) id += ALPHABET[bytes[i]! % ALPHABET.length];
  return id;
}

export class SupportRequestError extends Error {
  declare readonly code: string;
  declare readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function canAccessSupportRequest(ticket: SupportRequest, actor: Actor, action: RequestAction): boolean {
  const requester = ticket.requester === actor.id;
  const assigned = actor.platform && ticket.assignee === actor.id;
  switch (action) {
    case 'read': return requester || actor.platform;
    case 'reply': return ticket.status !== 'resolved' && (requester || assigned);
    case 'claim': return actor.platform && ticket.assignee === null && ticket.status === 'open';
    case 'resolve': return assigned && ticket.status === 'in_progress';
  }
}

export function supportRequestUpdateRecipient(ticket: SupportRequest, actorId: string, action: Exclude<RequestAction, 'read'>) {
  const recipient = action === 'reply' && actorId === ticket.requester ? ticket.assignee : ticket.requester;
  return recipient === actorId ? null : recipient;
}
