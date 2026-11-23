# Protected-preview first, held review correction

This supersedes the production-first sequence and the immediate-environment-disable wording in minimal-reader-canary-held.md. No effect is authorized or executed.

## Next proposed stage

Use an authenticated preview deployment of the ORIGINAL gymeg project only, from minimal commit 6cddcaf (or a reviewed successor carrying this document correction). Do not change main or production aliases, publish a new public host, disable protection, create bypass links, or use a new project. A preview is still a deployment with credentials and database effects, not a free local test. Obtain exact authority before pushing a preview branch, setting branch environment overrides or deploying.

Current live project settings, read November 23 at 22:37 Cairo, show Vercel Authentication enabled, Standard Protection, no active shareable links and no deployment-protection exceptions. Authentication protects preview URLs under the current standard scope. Password protection is a paid feature and is not needed or approved. No setting was changed.

Preview currently has DATABASE_URL and notification service account entries, plus shared Firebase/Google secrets. Names and targets were inspected, not secret values. Their targets and custody are NOT yet a safe preview specification. Do not copy production credentials into the preview. Review the exact selected database access needed, existing inherited secrets and ordinary app write routes. These two new reader guards restrict only candidate/detail routes, not the rest of the application.

Before requesting preview approval, close the inherited-credential plan: disable sender-capable configuration for that exact preview, retain only necessary auth/database settings, verify the database target read-only and block unrelated app mutations in the preview. If existing secrets cannot be safely overridden without affecting other previews, stop and ask with that precise choice. No production flags or environment targets change as part of a preview request.

Selected derived version/materialization remains a separate additional shared-database effect within any combined preview request. The previously reviewed source root is unchanged. It requires fresh selected identity/version/readiness admission and all-source/excluded-derived parity. Only selected Rehearsal list/detail read-only acceptance is intended. Do not edit source records to create a version, send notifications or use Morgan to test mutations.

## Correct recovery semantics

Vercel environment changes apply ONLY to new deployments, including server-only values. Editing GYMOS_MEMBER_SUMMARIES cannot stop an already deployed reader. A fast future production recovery would use routing rollback to the immediately previous artifact with that artifact's original environment. It would not reverse database preparation or delete summaries. Standard env cleanup still requires a later reviewed deployment.

Read-only live dashboard navigation reached the final Confirm Rollback screen, but never confirmed it. The current Hobby account can select only the immediately previous production artifact. At inspection current production was fa27d0e and the previous target was a04a749. A future production canary would need to verify fa27d0e is still the immediately previous artifact at that time. It cannot assume arbitrary history is available. The confirmation states original-build env is retained, previous cron definitions are restored, and automatic production promotion is suspended after rollback. Those consequences require scoped approval too. No rollback is necessary for an unpromoted protected preview; removing or disabling a preview is its own effect and needs authority.

## Verified sources

- Live protection: https://vercel.com/ahmedmorgan86s-projects/gymeg/settings/deployment-protection
- Live environment inventory: https://vercel.com/ahmedmorgan86s-projects/gymeg/settings/environment-variables
- Live rollback interface: https://vercel.com/ahmedmorgan86s-projects/gymeg
- Environment immutability and branch-specific preview overrides: https://vercel.com/docs/environment-variables
- Protection scope: https://vercel.com/docs/deployment-protection
- Rollback rules and consequences: https://vercel.com/docs/instant-rollback

Production canary consideration comes only AFTER protected-preview acceptance and a separate user decision. No whole-app completion or load-reduction claim follows from this reader preview.
