import {LAZY_STRICT} from './use-attendance';
/** Every reader that replaces a packet-visits consumer must be ON in the same build. Literal env reads (the bundler inlines only these). */
export const OMIT_READER_FLAGS={
  attendance:process.env.NEXT_PUBLIC_GYMOS_ATTENDANCE==='1',
  todayVisits:process.env.NEXT_PUBLIC_GYMOS_TODAY_VISITS==='1',
  lastVisits:process.env.NEXT_PUBLIC_GYMOS_LAST_VISITS==='1',
  openVisits:process.env.NEXT_PUBLIC_GYMOS_OPEN_VISITS==='1',
  visitTrend:process.env.NEXT_PUBLIC_GYMOS_VISIT_TREND==='1',
  memberSummaries:process.env.NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES==='1',
  memberHistory:process.env.NEXT_PUBLIC_GYMOS_MEMBER_HISTORY==='1',
};
/**
 * Readers that DO NOT EXIST YET (all-member quota/active aggregate for the Overview ring and renewals, the QuickVisit gate, full-report/whatsapp/device-bridge consumers).
 * Hard false in code: no env variable can turn the capability on while this is false. Flip it only in the change that adds those readers with their evidence.
 */
export const OMIT_READERS_COMPLETE=false as boolean;
export const omitCapable=(flags:Record<string,boolean>,strict:boolean,optIn:boolean,readersComplete:boolean)=>strict&&optIn&&readersComplete&&Object.values(flags).every(Boolean);
/** Default OFF and, today, impossible: see OMIT_READERS_COMPLETE. Every packet fetch/POST of a capable build sends the header, so one session never mixes variants by accident. */
export const OMIT_CAPABLE=omitCapable(OMIT_READER_FLAGS,LAZY_STRICT,process.env.NEXT_PUBLIC_GYMOS_PACKET_OMIT==='1',OMIT_READERS_COMPLETE);
