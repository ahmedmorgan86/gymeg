# Server read inventory, held integration

All new flags below default OFF. This is an implementation inventory, not deployment or capacity acceptance.

| Path | Candidate state | Retained full-read cases / debt |
| --- | --- | --- |
| Automatic WhatsApp | GYMOS_WHATSAPP_READS. Paged reverse-day selector, durable atomic cursor/outbox batches, separate enumeration phase and delivery reserve. Fresh single-member send checks. | OFF retains legacy. ON defers instead of full fallback. Real PostgreSQL/pool/concurrency acceptance pending. |
| Phone/PIN session validation | GYMOS_MEMBER_SESSION_READS. Exact account member+branch slice and metadata. Auth/PIN/rate/license and matched-club disclosure unchanged. | Legacy layout / slice backend fallback still full. At most20 account candidates from existing login projection. |
| Device gateway ingest | GYMOS_DEVICE_EVENT_READS. After original HMAC gate, metadata mapping + revision-consistent existing hot hydration, global counts, byte proof and partial persist. | Full fallback on legacy/unready/caps/races/trim windows. Metadata still carries global engagement device replay list. No real device gateway mutated for testing. |
| Member financial detail | GYMOS_MEMBER_ACCOUNT_READS. GET /api/member-account-detail pins owner/member/branch to codeMemberIdentity. Query parameters never choose identity. | Unavailable503 for unsupported layout, version change, >5000 own rows or related allocation inputs, timeout. No partial result. No browser wiring in this change. |
| Member portal projection | Existing readMemberSpace/readMemberSlice already restricts entity inputs. | Loads all selected-member history and all history for open members to preserve latest-visit occupancy. Legacy/disabled/race fallback is full. Not a bounded page API yet. |
| Member message write | Existing full read / full persist. | Explicit retained full mutation: community validation checks all message-member links and global byte rule; partial write not yet proved. |

## Member-account API contract

GET /api/member-account-detail, flag GYMOS_MEMBER_ACCOUNT_READS=1. Authenticated code-member cookie required, pin_must_change rejected. Current club license must permit writes, as on the existing member portal. Firestore501. Missing member404; auth401; PIN/license403; unavailable503. Browser-selected member/owner/branch arguments are ignored.

Success: `{status:'ok', memberId, branch, revision, version, payments, invoices, credit, outstanding}`. Financial rows include own member and own branch only, retaining original order and voided records. No member profile, health, photo, settings, other owner, or other member financial rows are returned.

Credit follows the existing memberCredit/paymentAvailable function exactly. That function subtracts matching allocations from ANY non-void invoice, even an old malformed cross-member/branch reference. Those related allocation arrays are read privately in owner scope, in original invoice order, and are not returned. This probe currently has no allocation-specific index and may scan owner invoice rows. It has a remaining-budget statement cap and a5000-row output refusal, not a proven cheap plan. It must undergo generated-plan/load review before activation. Outstanding uses invoiceOutstanding over own-branch payment/invoice inputs.

This route is distinct from the staff `/api/workspace/member-detail` API, where authenticated staff may select a member in their authorized branches. `app/member-account.tsx` is a staff member-profile component, not proof of member-session authorization.
