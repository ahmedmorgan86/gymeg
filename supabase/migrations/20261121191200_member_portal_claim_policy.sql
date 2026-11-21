-- Claim transition for single-use member portal invites.
-- member_portal_member_link only covers rows already bound to the member's
-- account (user_id = app.actor). A fresh invite row has user_id NULL, so on
-- real Postgres (which applies UPDATE USING policies to SELECT ... FOR UPDATE
-- row locks) the claim query could never see the pending invite and every
-- claim failed with invalidInvite. PGlite-based suites mask this because they
-- do not enforce UPDATE USING expressions on locking reads.
-- The claim is permitted only while the presented token hash matches
-- (app.member_invite), the row is still pending, and the outcome binds the
-- caller's account and clears the hash. Email matching and single-use stay
-- enforced by the claim route inside the same transaction.
CREATE POLICY member_portal_claim ON gymos.member_portal_access FOR UPDATE TO gymos_app
 USING(invite_hash=current_setting('app.member_invite',true) AND user_id IS NULL AND NOT revoked AND expires_at>now())
 WITH CHECK(user_id=current_setting('app.actor',true) AND invite_hash IS NULL AND NOT revoked);
