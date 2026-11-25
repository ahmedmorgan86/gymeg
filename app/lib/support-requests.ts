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
