import json
from pathlib import Path
b=json.loads(Path('/tmp/rollout-readonly/affected-baseline.json').read_text());c=json.loads(Path('/tmp/rollout-readonly/catalog.json').read_text());tables=['gym_states','gym_entities','gym_photos','membership_cards']
def qi(s):return '"'+s.replace('"','""')+'"'
sql=['CREATE SCHEMA gymos AUTHORIZATION postgres;','REVOKE ALL ON SCHEMA gymos FROM PUBLIC;','GRANT USAGE ON SCHEMA gymos TO gymos_app;']
for t in tables:
 cols=[qi(x['attname'])+' '+x['type']+(' NOT NULL'if x['attnotnull']else'')+(' DEFAULT '+x['default_expr']if x['default_expr']else'')for x in b['columns']if x['relname']==t];cons=['CONSTRAINT '+qi(x['conname'])+' '+x['definition']for x in b['constraints']if x['relname']==t]
 sql+=['CREATE TABLE gymos.'+qi(t)+'('+','.join(cols+cons)+');','ALTER TABLE gymos.'+qi(t)+' ENABLE ROW LEVEL SECURITY;','ALTER TABLE gymos.'+qi(t)+' FORCE ROW LEVEL SECURITY;','REVOKE ALL ON gymos.'+qi(t)+' FROM PUBLIC;','GRANT SELECT,INSERT,UPDATE'+(''if t=='membership_cards'else',DELETE')+' ON gymos.'+qi(t)+' TO gymos_app;']
for x in c['indexes']:
 if any((' ON gymos.'+t+' ')in x['definition']for t in tables)and not x['relname'].endswith('_pkey'):sql.append(x['definition']+';')
for x in c['policies']:
 if x['tablename']in tables:sql.append('CREATE POLICY '+qi(x['policyname'])+' ON gymos.'+qi(x['tablename'])+' FOR '+x['cmd']+' TO gymos_app'+(' USING('+x['qual']+')'if x['qual']else'')+(' WITH CHECK('+x['with_check']+')'if x['with_check']else'')+';')
for x in b['functions']:sql +=[x['definition']+';','REVOKE ALL ON FUNCTION gymos.'+qi(x['proname'])+'() FROM PUBLIC;','GRANT EXECUTE ON FUNCTION gymos.'+qi(x['proname'])+'() TO gymos_app;']
for x in c['triggers']:
 if x['relname']in tables:sql.append(x['definition']+';')
Path('/tmp/faithful-demand/baseline.sql').write_text('\n'.join(sql)+'\n')
