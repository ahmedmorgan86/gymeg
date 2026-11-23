import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {redirectAuthFlow} from '../lib/auth-flow-origin';
import Login from './login';
import {WORKSPACE_PATH} from '../lib/navigation';
const oauthErrors=new Set(['google_failed','google_unavailable','email_not_confirmed','confirmation','confirmation_same_browser']);
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){const query=await searchParams;if(query.register==='1'){const origin=redirectAuthFlow((await headers()).get('host'));if(origin)redirect(origin+'/sign-in?register=1');}const error=typeof query.error==='string'&&oauthErrors.has(query.error)?query.error:'';return <Login returnTo={process.env.GYMOS_REHEARSAL_PREVIEW==='1'&&process.env.VERCEL_ENV==='preview'?WORKSPACE_PATH:undefined} initialSignup={query.register==='1'} initialError={error}/>;}
