# Code Review Notes

**Date:** 2026-08-11
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 11 route modules, 2 middleware modules, models, utils, constants.
**Method:** Manual line-by-line review of all source files plus ESLint and the
Jest suite. Prior review history (93+ consecutive hardening commits) was
cross-checked to confirm findings were not already addressed.

---

## Review cycle 2026-08-11 (96th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** One minor test coverage gap closed:

### Fixes applied
- **`tests/audit-prune.test.js` — `createAuditLogPruner` lacked a regression
  test for the `= {}` default-options branch (LOW, test coverage).** The
  factory accepts an optional second argument that defaults to `{}`; all
  existing tests passed an explicit options object, leaving the no-args path
  uncovered. Added a test that calls `createAuditLogPruner(pruneFn)` with no
  second argument and asserts it runs without throwing and skips pruning when
  `days` is absent (non-finite).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **657 passed / 657 total** (26 suites, +1 regression test).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-11 (95th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** One minor consistency fix applied:

### Fixes applied
- **`src/routes/vendors.js` — `_validateVendorRating` range-check path used a
  different error message than the array-HPP / length / non-integer paths
  (LOW, consistency).** The previous pass (93) unified the array-HPP and
  length-guard messages but missed the out-of-range path on line 64. Unified
  all four error paths to `'Rating must be a whole number between 1 and 5'` and
  updated the three corresponding assertions in `tests/vendors.test.js`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **656 passed / 656 total** (26 suites).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-11 (94th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Two minor consistency/DRY improvements applied:

### Fixes applied
- **`src/routes/vendors.js` — `resolveOptionalTextField` was a redundant alias
  for `resolveOptionalField` from utils (LOW, code clarity).** The vendor route
  exported `resolveOptionalField` (imported from `../utils`) under the local
  name `resolveOptionalTextField`, creating confusion about whether it was a
  vendor-specific helper or the shared utility. Tests in `tests/vendors.test.js`
  updated to import `resolveOptionalField` directly from `../utils`; the alias
  export removed from vendors.js.
- **`src/routes/vendors.js` — `_validateVendorRating` had inconsistent error
  messages between the array-HPP guard and the length-guard (LOW, consistency).**
  Unified both paths to `'Rating must be a whole number between 1 and 5'`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **656 passed / 656 total** (26 suites).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-11 (92nd pass)

### Fixes applied
- **`src/routes/knowledge.js` — `deepFreeze` lacked a circular-reference guard
  (LOW, defense-in-depth).** Added a module-level `WeakSet` (`seen`) so each
  object/array is visited at most once; circular references are frozen at first
  encounter and skipped on re-encounter, preventing infinite recursion.
- **`tests/utils.test.js` — three exported utility functions were untested
  (LOW, test coverage gap).** Added 12 regression tests covering `normalizeIp`,
  `safeFilters`, and `paginationBaseUrl`.

### Tooling
- `npm test` — **656 passed / 656 total** (+15 new regression tests).

## Review cycle 2026-08-11 (91st pass)

### Fixes applied
- **`src/routes/knowledge.js` — `SANITIZE_HTML_OPTIONS` / `STRIP_HTML_OPTIONS`
  were mutable module-level objects (LOW, defense-in-depth).** Both wrapped in
  `Object.freeze(...)` so any mutation throws in strict mode and silently no-ops
  otherwise.
- **`src/routes/staff.js` — four single-statement SQL queries used multi-line
  template literals, breaking the convention (LOW, consistency).** Folded
  `_unassignTicketsStmt`, `_unassignTasksStmt`, `_unassignChangesStmt`, and
  `_unassignProjectOwnerStmt` into single-line template literals.

### Tooling
- `npm test` — **628 passed / 628 total** (+2 new regression tests).

---

## Security Controls Verified

| Control | Status |
|---|---|
| SQL injection | PASS — All dynamic queries use whitelisted helpers (`buildFilters`, `addSearch`, `safeSort`, `quoteColumn`, `countQuery`, `selectQuery`) with bound params |
| Authentication / session | PASS — `requireAuth` re-verifies active status per request; session regenerated on login/password change |
| Authorization (RBAC / IDOR) | PASS — Privileged routes use `requireAdminOrManager`/`requireAdmin`; ownership rechecked inside `db.transaction` for TOCTOU safety |
| CSRF | PASS — `doubleCsrf` on all state-changing routes; logout is POST-only |
| XSS (KB markdown) | PASS — `marked` output sanitized via `sanitize-html`; `input` disallowed; links get `rel="noopener noreferrer"` + scheme check |
| Password policy | PASS — bcrypt 12 rounds, 72-byte cap enforced, complexity required |
| Rate limiting | PASS — Login (10/15m + lockout), password, profile, KB write, report, audit limiters all present |
| Login brute-force | PASS — Per-account + per-IP failure maps with lockout, bounded size, timing-safe dummy-hash compare |
| HTTP hardening | PASS — `x-powered-by` disabled, `query parser: 'simple'`, TRACE/TRACK rejected, HSTS + CSP + Permissions-Policy via Helmet |
| Input validation / HPP | PASS — `safeQueryValue`/`safeId`/`safeInt` reject arrays; `rejectHppArrays()` fail-closed on every write route |
| Audit logging | PASS — All writes audited; `audit()` validates action/entity against allowlists |
| Transactions / TOCTOU | PASS — Writes re-fetch and re-check inside `db.transaction()` |

## Observations (by design, not defects)

- **Cross-ticket commenting** (`tickets.js`): any authenticated user may comment
  on any ticket they can access. Intentional for cross-team collaboration.
- **Manager cannot reactivate a deactivated user** (`staff.js`): `requireAdmin`-only.
- **`recalcProjectProgress` runs post-commit** during staff deactivation:
  eventually consistent; not a defect under synchronous SQLite.
- **Vendor rename syncs `licenses.vendor` by case-insensitive text match**:
  `licenses.vendor` is free text (not a FK); normalized vendor FK would be a
  larger refactor, not a bug fix.
