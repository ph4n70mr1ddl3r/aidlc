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

---

## Review cycle 2026-07-18 (follow-up)

A second pass (4 parallel review agents covering all 11 route modules + core files)
re-identified one genuine HPP defect and two fail-open/consistency issues that were
then fixed and verified with tests:

### Fixes applied
- **`reports.js` — `resolveReportPeriod` HPP guard was dead code (HIGH).** The
  function's stated intent was to reject HTTP parameter pollution for `period`, but it
  called `safeQueryValue(raw)` *first*. `safeQueryValue` collapses an array to its
  first element, so `?period[]=999` was silently reduced to `"999"` before the
  `Array.isArray` check ever ran — the guard never fired. Fixed to check
  `Array.isArray(raw)` *before* `safeQueryValue`, so polluted input falls back to the
  default.
- **`licenses.js` — update route accepted HPP arrays (LOW-MEDIUM).** Every update body
  field was read through `safeQueryValue`, which collapses arrays to the first element
  rather than rejecting them. Unlike `vendors.js`/`knowledge.js`, no array rejection
  was performed, so a polluted `clear_key[]=1` would silently wipe the stored license
  key (fail-open destructive action). Added a fail-closed array-rejection loop over all
  update fields, matching the rest of the codebase.
- **`projects.js` — `budget`/`spent` failed open on invalid input (LOW).** A malformed
  or empty `budget`/`spent` was silently preserved at the old DB value via
  `safePositiveFloat(x, existing)`. This meant a typo'd value was ignored rather than
  rejected, and an empty field could never be reset to `0`. Now distinguishes "field
  not submitted" (preserve stored value) from "submitted invalid" (reject with a flash
  error), using `Infinity` as a sentinel so `0` is a legitimate value.

### Verified clean (no action)
- Per the second pass, `dashboard.js` cache invalidation is in fact wired into
  tickets/assets/projects/licenses/staff/vendors/knowledge/changes/auth writes (not
  only `changes.js`), so the earlier speculation about stale dashboard aggregates was a
  false positive. The 30 s TTL is just a fallback refresh window.
- `staff.js`, `assets.js`, `tickets.js`, `projects.js`, `knowledge.js`, `vendors.js`,
  `changes.js`, `audit.js`, `auth.js` middleware, `utils.js`, `models/database.js`,
  and `constants.js` were each checked for SQL injection, IDOR/authorization,
  CSRF, transaction/TOCTOU, audit logging, input validation, and sensitive-error
  leakage. No further defects found.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 252 passed / 252 total.
- Added a regression test in `tests/reports.test.js` asserting the `period` HPP array
  now falls back to the default (the previous test had incorrectly encoded the
  vulnerable collapse-to-`365` behavior as "correct").

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
