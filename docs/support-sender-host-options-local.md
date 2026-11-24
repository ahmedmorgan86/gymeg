# Support sender hosting review, 24 November 2026

Source review only. No account inventory recheck, host installation, secrets, workflow, credentials or sends. Existing public-repository/project status comes from earlier recorded research and must be revalidated before an action. Free-tier inclusion is not proof that this account has spare quota or permission to install.

## Recommendation

Do not request installation approval yet. Finish restricted adapter/operator state review and select the user consequence first. For best-effort delayed alerts, a dedicated GitHub scheduled job avoids placing a repository Actions-write dispatch credential into the tenant app, but alerts may take more than five minutes and scheduled runs may be dropped. For prompt-attempt delivery, investigate a genuinely secret-separated HTTP worker rather than describe GitHub dispatch as a narrow one-workflow permission. No option here establishes guaranteed notification arrival.

| Option | Current documented facts | Fit and remaining consequence |
| --- | --- | --- |
| GitHub standard hosted job in public repository | Standard runners free for public repositories. Schedule minimum5minutes, latest default-branch code, high-load delay/drop possible. Environment secrets available only to referencing jobs, with optional reviewers and branch/tag restrictions. | Most concrete reuse of earlier known resource. Scheduled-only avoids app dispatch credential, at cost of delayed/best-effort alerts. Deployment/ref protections and workflow change control must be verified, not assumed. A reviewer on every job would prevent unattended sending. |
| GitHub workflow dispatch | Fine-grained PAT Actions repository write permission required. API selects workflow ID and branch/tag ref. Permission is repository-wide, not a token restricted to this workflow. Same Actions-write category includes cancel/delete workflow runs and enable/disable workflows. | Dispatch can initiate a job after business commit, but no documented bounded queue latency found. Do not promise immediate start or delivery. Requires broader repository execution authority in the initiating process plus durable retry/sweep. |
| Supabase Edge Function on existing project | Free quota500,000invocations. Free worker wall150seconds, CPU2seconds. Secrets configured per project; functions inherit database URL and keys including RLS-bypassing secret/service role keys. | HTTP trigger avoids GitHub dispatch privilege, but existing-project function environment is not a clean sender-only credential boundary. Installing FCM/decryption secrets there broadens their exposure. Need verified function-level isolation solution or separate approved resource, not merely a restricted DB login in code. |
| Cloudflare Worker | Free100,000requests/day,10msCPU/invocation, secrets per Worker; separate environments available. HTTP-triggered candidate with recovery cron. | Potentially better credential boundary but account/resource availability unverified and new public endpoint/account effects not authorized.10msCPU budget needs measured FCM signing/decryption/runtime compatibility; do not assume this Node/PG candidate works unchanged. No paid upgrade assumed. |

## Permission and latency evidence

The current GitHub fine-grained PAT permission table explicitly lists POST workflow dispatch under Actions/write. This is stronger evidence than a workflow-specific endpoint path suggesting workflow-specific credential scope. Existing earlier claim about repository_dispatch Contents/write was not freshly confirmed by the fetched current permission table, so do not elevate it to a newly verified comparison. Avoid repository_dispatch regardless until its scope is independently established if it becomes a real candidate.

Some third-party scheduler search results claim a dispatch token can do nothing except start one workflow or imply dispatch guarantees start time. Those statements conflict with the official repository-level permission category and offer no bounded runner-start guarantee. They were not used as evidence.

Source-status suppression remains a local product proposal. No source/runtime selection, schema install or host plan is authorized by this report. The meaningful future question is whether occasional delays beyond five minutes are acceptable for Support alerts, or whether a separate tightly scoped always-available trigger is required. Technical implementation selection remains ours to prepare, not the user's burden.

## Official sources inspected

- GitHub billing/free public standard runners: https://docs.github.com/en/actions/concepts/billing-and-usage
- Workflow dispatch endpoint and branch/tag ref: https://docs.github.com/en/rest/actions/workflows
- Fine-grained PAT scope matrix: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- Schedule minimum5minutes/default branch: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- Scheduled delay/dropped runs: https://docs.github.com/en/actions/how-tos/troubleshoot-workflows
- Environment secret/ref/reviewer boundary: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- Supabase quota: https://supabase.com/docs/guides/functions/pricing
- Supabase runtime bounds: https://supabase.com/docs/guides/functions/limits
- Supabase default/project secrets: https://supabase.com/docs/guides/functions/secrets
- Cloudflare free bounds: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare secret boundary: https://developers.cloudflare.com/workers/configuration/secrets/

Official first-party documentation dominates because permissions, pricing and runtime constraints need vendor evidence. Third-party latency marketing was excluded. This is not a benchmark or account-readiness acceptance.
