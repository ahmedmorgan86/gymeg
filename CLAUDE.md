@AGENTS.md

# GymEG — Architecture and Development Guidelines

## Commands
- **Test suite**: `npm test` (uses Node test runner `--test-isolation=none`)
- **Typecheck**: `npm run typecheck` (`tsc --noEmit`)
- **Dev server**: `npm run dev`
- **Build**: `npm run build`

## Key Architecture Principles
1. **Multi-Tenant Isolation**:
   - Every mutation and sensitive read MUST call `assertRequestTenant(request, ctx.tenantId, Boolean(ctx.license))`.
   - Never bypass origin checks (`sameOrigin(request)`).
2. **Branch Scoping**:
   - Staff roles (`manager`, `reception`) are strictly bounded by `ctx.branches`.
3. **Database Scope**:
   - PostgreSQL queries must use `withScope(owner, client => ...)` or explicit tenant filtering.
4. **Member Credentials & Privacy**:
   - PINs and member session tokens are hashed via `memberCodeHash`.
   - Never return plaintext member PINs to staff or unauthenticated endpoints.
5. **Android Shells**:
   - Android shells are restricted WebViews (no JS bridge, file access disabled, HTTPS only).
   - Source files in `android*/` require LF line endings.

