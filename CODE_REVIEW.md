# Code Review Notes

**Date:** 2026-07-18
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 11 route modules, 2 middleware modules, models, utils, constants.
**Method:** Manual line-by-line review of all source files plus ESLint and the Jest
suite (252 tests, all passing). Prior review history (15 consecutive "code review"
hardening commits) was cross-checked to confirm findings were not already addressed.

## Verdict

**No genuine security or correctness defects found.** The codebase is in strong shape
and follows a consistent, defense-in-depth security model. The recommendations below
are observations and by-design clarifications rather than required fixes.

## Security controls verified

| Control | Status | Notes |
|---|---|---|
| SQL injection | PASS | Every dynamic query is built through whitelisted helpers (`buildFilters`, `addSearch`, `safeSort`, `quoteColumn`, `countQuery`, `selectQuery`). All user values are bound parameters. No string-concatenated SQL with raw input found. |
| Authentication / session | PASS | `requireAuth` re-verifies active status, `password_changed_at`, and role sync per request. Session regenerated on login/password change. Session fixation prevented. |
| Authorization (RBAC / IDOR) | PASS | Privileged write routes (`assets`, `projects`, `vendors`, `licenses`, `changes`, staff admin) use `requireAdminOrManager`/`requireAdmin`. Ownership re-checked **inside** the transaction for ticket/knowledge writes (TOCTOU-safe). |
| CSRF | PASS | `doubleCsrf` on all state-changing routes; method-override restricted to POST body; logout is POST-only. |
| XSS (KB markdown) | PASS | `marked` output passed through `sanitize-html` with `input` disallowed, link `rel=noopener noreferrer`, schemes restricted to http/https/mailto (data: URIs blocked on `img src`). |
| Password policy | PASS | bcrypt (12 rounds), 72-byte cap enforced (avoids silent truncation collision), complexity enforced, current-password check on change. |
| Rate limiting | PASS | Login (10/15m + per-account/IP lockout), password, profile, KB write, report, change, status, comment limiters all present. |
| Login brute-force | PASS | Per-account and per-IP failure maps with lockout, bounded size, purge interval, timing-safe dummy-hash comparison (no username enumeration). |
| HTTP hardening | PASS | `x-powered-by` disabled, `query parser: 'simple'` (prototype-pollution safe), TRACE/TRACK rejected, HSTS + CSP + Permissions-Policy via Helmet. |
| Input validation / HPP | PASS | `safeQueryValue`/`safeId`/`safeInt`/etc. reject arrays (HTTP parameter pollution) and non-finite values fail-closed. |
| Audit logging | PASS | All writes audited; `audit()` validates action/entity against allowlists and truncates details. |
| Transactions / TOCTOU | PASS | Writes that depend on fetched state re-fetch and re-check inside `db.transaction()`. SQLite WAL + foreign_keys pragmas asserted at startup. |

## Observations (by design, not defects)

- **Cross-ticket commenting** (`tickets.js` `POST /:id/comments`): any authenticated
  user may comment on any ticket. This is intentional and documented in-code
  (cross-team collaboration). Non-privileged users cannot mark comments internal.
  Acceptable for an internal IT tool; revisit only if tighter scoping is desired.
- **Manager cannot reactivate a deactivated user** (`staff.js`): the Reactivate route
  is `requireAdmin`-only; the edit route preserves `is_active` via self-assignment to
  avoid silent reactivation. Safe and intentional.
- **`recalcProjectProgress` runs post-commit** during staff deactivation
  (`staff.js` → `utils.recalcProjectProgress`): each recalc is its own implicit
  transaction and reads the committed (post-unassign) state, so it is eventually
  consistent. Not a defect under synchronous SQLite.
- **Vendor rename syncs `licenses.vendor` by exact case-insensitive text match**
  (`vendors.js`): `licenses.vendor` is free text (not a FK), so this is the only way
  to keep references in sync. Low collision risk given exact-match semantics. A
  normalized vendor FK would be a larger refactor, not a bug fix.

## Tooling

- `npx eslint .` — clean (exit 0).
- `npx jest` — 252 passed / 252 total.
- `.env.example` contains only placeholders; no secrets committed.
