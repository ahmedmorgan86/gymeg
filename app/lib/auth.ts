import {createServerClient} from '@supabase/ssr';
import {cookies} from 'next/headers';
export async function serverAuth(){const store=await cookies();const url=process.env.NEXT_PUBLIC_SUPABASE_URL||'https://placeholder.supabase.co';const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY||'placeholder-anon-key';return createServerClient(url,key,{cookies:{getAll:()=>store.getAll(),setAll:values=>{try{values.forEach(({name,value,options})=>store.set(name,value,options));}catch{/* Server Components use proxy.ts for refresh. */}}}});}
