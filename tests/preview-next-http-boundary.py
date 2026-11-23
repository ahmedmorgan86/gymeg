import subprocess,os,time,http.client,json
node=os.environ.get('NODE_BINARY','node')
env={**os.environ,**({'NODE_ENV':'production'} if os.environ.get('PRODUCTION_BOUNDARY')=='1' else {}),'GYMOS_REHEARSAL_PREVIEW':'1','VERCEL_ENV':'preview','GYMOS_AUTH_BACKEND':'supabase','GYMOS_DATA_BACKEND':'postgres','GYMOS_COMMERCIAL':'1','NEXT_PUBLIC_SUPABASE_URL':'http://127.0.0.1:9','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY':'fixture-only','DATABASE_URL':'postgresql://fixture:fixture@127.0.0.1:9/fixture','NEXT_TELEMETRY_DISABLED':'1','NODE_OPTIONS':'--max-old-space-size=768'}
log=open('/downloads/preview-next-http-server.log','w')
p=subprocess.Popen([node,'node_modules/next/dist/bin/next',*(['start'] if os.environ.get('PRODUCTION_BOUNDARY')=='1' else ['dev','--webpack']),'-H','127.0.0.1','-p','3117'],env=env,stdout=log,stderr=log,start_new_session=True)
def req(path,method='GET',headers={}):
 c=http.client.HTTPConnection('127.0.0.1',3117,timeout=70);c.request(method,path,headers=headers);r=c.getresponse();data=r.read();c.close();return r.status,data[:160].decode(errors='replace')
try:
 for i in range(50):
  try: req('/api/cron/whatsapp');break
  except ConnectionRefusedError:time.sleep(.3)
 cases=[('/api/workspace','POST',{}),('/api/workspace','PUT',{}),('/','POST',{'Next-Action':'fixture'}),('/sign-in','POST',{'Next-Action':'fixture'}),('/api/cron/whatsapp','HEAD',{}),('/api/cron/whatsapp','GET',{'RSC':'1'}),('/api/commercial.json','GET',{}),('/icons/../api/cron/whatsapp','GET',{}),('/icons/%2e%2e/api/cron/whatsapp','GET',{}),('/api/%63ron/whatsapp','GET',{}),('/api%2fcron%2fwhatsapp','GET',{}),('/_next/data/build/api/cron/whatsapp.json','GET',{}),('/_next/image?url=%2Fapi%2Fcron%2Fwhatsapp&w=64&q=75','GET',{}),('/favicon.ico/api/cron/whatsapp','GET',{}),('/api/cron/whatsapp','GET',{'x-middleware-subrequest':'proxy:proxy:proxy:proxy:proxy'})]
 out=[]
 for path,method,h in cases:
  status,body=req(path,method,h);out.append({'path':path,'method':method,'headers':h,'status':status,'body':body});assert status==403,(path,method,status,body)
 # Normalized duplicate separators are redirected by framework before proxy. Follow-up denied.
 status,body=req('//api//cron/whatsapp');out.append({'path':'//api//cron/whatsapp','status':status});assert status in (307,308,403)
 status,body=req('/api/cron/whatsapp');assert status==403
 print(json.dumps({'checks':out,'pass':True},indent=2))
finally:
 import signal
 os.killpg(p.pid,signal.SIGTERM)
 try:p.wait(timeout=8)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 log.close()
