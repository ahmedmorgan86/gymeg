# Demand loading: what changed, what is measured, what is left

Local synthetic fixtures only (PGlite and a Firestore double). No production reads, no real backups.

## Done in this branch
- `app/lib/workspace-slice.ts`: bounded reads for Postgres (`gym_entities`) and Firestore. Revision only, settings only, a collection page, entity ids, rows keyed by member, branch scope pushed into the query. A read with no page limit fails loudly above 250,000 rows instead of truncating.
- `GET /api/workspace?since=N`: the unchanged check reads one row/document (the revision) instead of the whole club.
- `GET /api/workspace`: reads only the collections the packet ships to that caller (their branches and role). `events` and `receipts` are no longer read or shipped (the client never used `state.events`; the activity log pages `/api/activity`; receipts were already blanked). Photos are read as a 16-char hash computed in SQL on Postgres, not as bytes.
- Member portal, member access, member code, barcode, member photo and member phone login read one member (plus that member's own rows) instead of the whole club. The portal view is checked equal to the full-state view for every member.
- `administrator()` reads settings only.
- Tests: `tests/workspace-slice.test.mjs` (equality against full-state output for portal and for 5 caller roles, row counts, cross-club and cross-branch isolation, paging, caps, legacy fallback).

## Measured (synthetic club, rows read per call)
- unchanged poll: 1 row (was every row).
- member portal view, 12 members: 51 of 405 rows.
- packet, owner: 408 of 908; manager (1 branch): 206; reception without grants: 160. The gap grows with `events` (up to 2000) and `receipts` (up to 1000) per club, and with branch count.

## Not done (needs its own focused work)
1. Boot split with lazy screens. The client holds the whole club (`app/workspace.tsx`) and 15+ screens compute over `members`, `visits`, `payments`. Moving them to paged endpoints (members search + cursor, visits by date, payments by range) is a client rewrite and needs UI verification in a browser.
2. Mutations still read the whole club (`applyOperation` needs it, and persistence diffs full lists). Needs per-operation read sets.
3. Visits and payments still ship in full. They grow fastest and are the main read cost for a mature club.
4. Photo bytes are still read on a full read (backup, mutations). A stored photo version on the member row would remove that.
5. Firestore activity path still reads all events (events are unbounded there).
6. Classes for the member portal are read for the whole branch.
7. Deploy `firestore.indexes.json` (3 new `gym_entities` indexes) and the new migration before enabling on those backends.
