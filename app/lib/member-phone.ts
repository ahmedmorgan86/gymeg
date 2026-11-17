import {randomInt} from 'node:crypto';
export {latinDigits,normalizeMemberPhone,normalizeMemberPin} from './member-phone-format.ts';
// These values were issued or accepted as shared defaults in older versions.
// They must never be generated or chosen as a private member PIN again.
const SHARED_LEGACY_PINS=new Set(['000000','111111','123456','654321']);
export const isSharedLegacyPin=(value:unknown):boolean=>typeof value==='string'&&SHARED_LEGACY_PINS.has(value);
export function newMemberPin(...exclude:(string|null|undefined)[]):string{
  const blocked=new Set<string>(SHARED_LEGACY_PINS);
  for(const value of exclude)if(typeof value==='string'&&/^[0-9]{6}$/.test(value))blocked.add(value);
  let pin:string;
  do pin=String(randomInt(1_000_000)).padStart(6,'0');
  while(blocked.has(pin));
  return pin;
}
