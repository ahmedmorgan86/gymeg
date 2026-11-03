export type ClubMessageSignal={id:string;side:'staff'|'member';branch:string;text:string};

/** Returns unseen incoming messages that belong to the active club branch. */
export function unseenIncomingMessages<T extends ClubMessageSignal>(
  previousIds:ReadonlySet<string>,
  messages:readonly T[],
  recipient:'staff'|'member',
  branch?:string,
):T[]{
  const incomingSide=recipient==='staff'?'member':'staff';
  return messages.filter(message=>message.side===incomingSide&&!previousIds.has(message.id)&&(!branch||message.branch===branch));
}

export function messageNotificationBody(text:string,maxLength=140):string{
  const normalized=text.replace(/\s+/g,' ').trim();
  return normalized.length>maxLength?normalized.slice(0,Math.max(0,maxLength-1))+'…':normalized;
}
