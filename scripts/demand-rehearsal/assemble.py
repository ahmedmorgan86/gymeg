from pathlib import Path
import re,json,hashlib
root=Path('/tmp/support-isolated-adapter')
files=['20261121170000_workspace_entity_counters.sql','20261121180000_member_summary_inputs.sql','20261121190000_owner_change_version.sql','20261122010000_visit_effective_clock.sql','20261122020000_demand_strict_keys.sql','20261122030000_invoice_allocation_refs.sql','20261122070000_member_summary_branch.sql']
def split(s):
 out=[];start=i=0;quote=None;dollar=None;comment=False;block=False
 while i<len(s):
  if comment:
   if s[i]=='\n':comment=False
   i+=1;continue
  if block:
   if s[i:i+2]=='*/':block=False;i+=2
   else:i+=1
   continue
  if dollar:
   if s.startswith(dollar,i):i+=len(dollar);dollar=None
   else:i+=1
   continue
  if quote:
   if s[i]==quote:
    if i+1<len(s)and s[i+1]==quote:i+=2;continue
    quote=None
   i+=1;continue
  if s[i:i+2]=='--':comment=True;i+=2;continue
  if s[i:i+2]=='/*':block=True;i+=2;continue
  if s[i]in "'\"":quote=s[i];i+=1;continue
  if s[i]=='$':
   m=re.match(r'\$[A-Za-z_0-9]*\$',s[i:])
   if m:dollar=m.group();i+=len(dollar);continue
  if s[i]==';':out.append(s[start:i+1]);start=i+1
  i+=1
 if s[start:].strip():out.append(s[start:])
 assert not any([quote,dollar,block]),'unterminated SQL'
 return out
units=[];indexes=[];alters=[];sources=[]
for f in files:
 raw=(root/'supabase/migrations'/f).read_text();sources.append({'file':f,'sha256':hashlib.sha256(raw.encode()).hexdigest()})
 for stmt in split(raw):
  clean=re.sub(r'--[^\n]*','',stmt).strip()
  if not clean:continue
  if re.match(r'SET LOCAL (lock_timeout|statement_timeout)\s*=',clean,re.I):continue
  if re.match(r'CREATE(?: UNIQUE)? INDEX\b',clean,re.I):
   indexes.append(re.sub(r'\bINDEX\s+(?:CONCURRENTLY\s+)?', 'INDEX CONCURRENTLY ',clean,count=1,flags=re.I));continue
  if re.match(r'ALTER TABLE gymos\.gym_entities\s+ADD COLUMN',clean,re.I)and 'GENERATED ALWAYS' in clean:
   alters.append(clean);units.append(('alter_slot',None))if len(alters)==1 else None;continue
  units.append(('sql',stmt.strip()))
assert len(alters)==2
columns=[]
for a in alters:
 body=re.sub(r'^ALTER TABLE gymos\.gym_entities\s+','',a).rstrip(';');columns.append(body)
combined='ALTER TABLE gymos.gym_entities\n '+',\n '.join(columns)+';'
assert combined.count('GENERATED ALWAYS')==7
header='-- HELD CANDIDATE. GENERATED SOURCE FOR REVIEW/ISOLATED REHEARSAL ONLY. NOT PRODUCTION APPROVAL.\n'
phase1=header+"BEGIN;\nSET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s';\n"+'\n\n'.join(combined if kind=='alter_slot'else s for kind,s in units)+'\nCOMMIT;\n'
phase2=header+"-- Every statement MUST run independently, outside a transaction.\nSET lock_timeout='2s'; SET statement_timeout='60s';\n"+'\n\n'.join(indexes)+'\n'
out=Path('/tmp/held-demand-runner');(out/'01-schema-held.sql').write_text(phase1);(out/'02-indexes-held.sql').write_text(phase2);(out/'manifest.json').write_text(json.dumps({'state':'UNEXECUTED_HELD','sources':sources,'generated_columns':7,'rewrites':1,'concurrent_indexes':len(indexes),'rules':['new tables/functions/roles/policies/hooks only, existing source bodies require final capture','schema transaction 2s lock/15s statement, not whole transaction bound','indexes each outside transaction','postflight exact definitions/ACL/edges/readiness needed','no flags/backfill/recipients/sender in this artifact']},indent=2));print((out/'manifest.json').read_text())
