-- HELD DRAFT (review-only, additive, not applied anywhere; remote schema reconciliation required first): branch-scoped member-summary reads.
-- Why: the request-side readers (quota-issues, member candidates) are for ONE branch, but the summary and dirty tables are keyed by owner only, so their joins and the dirty scan
-- depend on the whole owner's rows. A branch column plus (owner_id,branch...) indexes lets a request touch only its branch's marks and summaries.
-- Semantics preserved: a dirty mark is still written for EVERY affected member, including members that no longer exist (their invoices keep the dues-only v:0 row, see recompute).
-- branch of a mark = the member row's CURRENT branch (a move rewrites it through the update trigger); for a member with no row it is the branch of the row that caused the mark.
-- Summary rows carry the branch of the member they were computed for; dues-only v:0 rows keep NULL (they are never candidates). NULL-branch rows are visible only to owner-wide refreshers.
ALTER TABLE gymos.gym_member_summaries ADD COLUMN IF NOT EXISTS branch text;
ALTER TABLE gymos.gym_member_summary_dirty ADD COLUMN IF NOT EXISTS branch text;
UPDATE gymos.gym_member_summaries s SET branch=e.branch FROM gymos.gym_entities e WHERE s.branch IS NULL AND e.owner_id=s.owner_id AND e.collection='members' AND e.entity_id=s.member_id AND (s.stored->>'v')::int<>0;
UPDATE gymos.gym_member_summary_dirty d SET branch=e.branch FROM gymos.gym_entities e WHERE d.branch IS NULL AND e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id;
CREATE INDEX IF NOT EXISTS gym_member_summaries_branch ON gymos.gym_member_summaries(owner_id,branch,member_id);
CREATE INDEX IF NOT EXISTS gym_member_summary_dirty_branch ON gymos.gym_member_summary_dirty(owner_id,branch,gen);

-- One writer for the three triggers: (owner, member, branch of the triggering row) triples.
CREATE OR REPLACE FUNCTION gymos.msum_mark(owners text[],members text[],branches text[]) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen,branch)
  SELECT g.o,g.m,nextval('gymos.member_summary_gen'),COALESCE(max(e.branch),max(g.b))
  FROM unnest(owners,members,branches) AS g(o,m,b) LEFT JOIN gymos.gym_entities e ON e.owner_id=g.o AND e.collection='members' AND e.entity_id=g.m
  WHERE g.m IS NOT NULL AND NOT gymos.msum_oversize(g.m) GROUP BY g.o,g.m
  ON CONFLICT(owner_id,member_id) DO UPDATE SET gen=EXCLUDED.gen,branch=EXCLUDED.branch
$$;
REVOKE ALL ON FUNCTION gymos.msum_mark(text[],text[],text[]) FROM PUBLIC;
CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 DELETE FROM gymos.gym_member_summary_ready WHERE owner_id IN (SELECT owner_id FROM newrows WHERE collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END));
 PERFORM gymos.msum_mark(array_agg(owner_id),array_agg(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END),array_agg(branch)) FROM newrows WHERE collection IN ('members','visits','payments','invoices');
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 DELETE FROM gymos.gym_member_summary_ready WHERE owner_id IN (SELECT owner_id FROM oldrows WHERE collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END));
 PERFORM gymos.msum_mark(array_agg(owner_id),array_agg(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END),array_agg(branch)) FROM oldrows WHERE collection IN ('members','visits','payments','invoices');
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 DELETE FROM gymos.gym_member_summary_ready WHERE owner_id IN (SELECT owner_id FROM newrows WHERE collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END));
 PERFORM gymos.msum_mark(array_agg(owner_id),array_agg(mid),array_agg(branch)) FROM (
   SELECT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END AS mid,branch FROM newrows WHERE collection IN ('members','visits','payments','invoices')
   UNION ALL
   SELECT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END,branch FROM oldrows WHERE collection IN ('members','visits','payments','invoices')) x;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_ins() FROM PUBLIC;REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_del() FROM PUBLIC;REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_upd() FROM PUBLIC;

CREATE OR REPLACE FUNCTION gymos.backfill_member_summaries(target text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 PERFORM 1 FROM gymos.gym_states WHERE user_id=target FOR UPDATE;
 DELETE FROM gymos.gym_member_summaries WHERE owner_id=target;DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=target;
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen,branch) SELECT owner_id,entity_id,nextval('gymos.member_summary_gen'),branch FROM gymos.gym_entities WHERE owner_id=target AND collection='members' AND NOT gymos.msum_oversize(entity_id);
 IF NOT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=target AND collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END)) THEN INSERT INTO gymos.gym_member_summary_ready(owner_id) VALUES(target) ON CONFLICT DO NOTHING; END IF;
END $$;
REVOKE ALL ON FUNCTION gymos.backfill_member_summaries(text) FROM PUBLIC;
