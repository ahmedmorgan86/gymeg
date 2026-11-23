// Pure derivation of the Overview numbers from per-day visit counts. Mirrors the legacy packet expressions exactly (see visit-trend-page.ts).
import {addDays} from './domain.ts';
export type TrendNumbers={values:number[];weekVisits:number;prevWeek:number;todayVisits:number};
export function deriveTrend(days:Record<string,number>,today:string,period:number):TrendNumbers{
  const n=(d:string)=>days[d]??0;
  const values=Array.from({length:period},(_,i)=>n(addDays(today,i-period+1)));
  const prevWeek=Array.from({length:period},(_,i)=>n(addDays(today,1-2*period+i))).reduce((a,b)=>a+b,0);
  return{values,weekVisits:values.reduce((a,b)=>a+b,0),prevWeek,todayVisits:n(today)};
}
