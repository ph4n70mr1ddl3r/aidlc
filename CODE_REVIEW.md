# Code Review Notes

**Date:** 2026-08-13
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 11 route modules, 2 middleware modules, models, utils, constants.
**Method:** Manual line-by-line review of all source files plus ESLint and the
Jest suite. Prior review history (100+ consecutive hardening commits) was
cross-checked to confirm findings were not already addressed.

---

## Review cycle 2026-08-13 (104th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Three minor consistency/cleanup fixes applied:

### Fixes applied
- **`src/utils.js` — `resolveOptionalField` JSDoc return type was misleading
  (LOW, documentation).** The `@returns` annotation claimed `{error: boolean}`
  but the function never returns `{error: false}` — it only returns
  `{error: true}` for HPP arrays. Updated to `{error: true}` to match the
  actual runtime contract so callers and readers understand the shape correctly.
- **`src/routes/audit.js` — dead `'search'` in HPP rejection list (LOW, code
  clarity).** The route rejects HPP arrays on `['action', 'entity_type', 'sort',
  'search']` but never reads `req.query.search` anywhere in the handler or in
  `safeFilters`. Removed `'search'` from the list so the HPP guard reflects the
  actual filtered params and avoids confusing future readers into thinking a
  search filter exists on this route.
- **`src/routes/knowledge.js` — `renderMarkdown` fallback used Bootstrap
  classes that don't exist in the app (LOW, consistency).** The fail-closed
  markdown-render error fallback emitted `<div class="alert alert-info">…</div>`
  which references Bootstrap classes (`alert`, `alert-info`) not present in
  this project's CSS. Replaced with plain `<div>` wrappers so the fallback
  renders without relying on missing utility classes.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **671 passed / 671 total** (27 suites).

## Review cycle 2026-08-13 (103rd pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, and the test suite). **No new
SQL injection, IDOR, CSRF, auth, or error-leakage defects were found.** Five
defensive-coding gaps closed:

### Fixes applied
- **`src/routes/licenses.js` — update route missing resolved-value date-ordering
  check (MED, data integrity).** The submitted-only `expiry >= purchase` check
  ran before the transaction, but the update resolves dates against the stored
  row (absent field preserves). A partial edit moving `purchase_date` forward
  while leaving `expiry_date` empty passed the submitted-only check yet persisted
  an expiry preceding the preserved purchase date. Added a resolved-value check
  inside the transaction (mirrors assets.js / projects.js).
- **`src/routes/tickets.js` — comment query kept the oldest 500 comments (MED).**
  `_showCommentsStmt` used `ORDER BY tc.created_at ASC LIMIT 500`, so a ticket
  with >500 comments silently dropped the newest comments, including one just
  posted. Changed to `ORDER BY ... DESC LIMIT 500` and reversed the list in the
  show route so display stays chronological while retaining the most recent
  activity.
- **`src/routes/projects.js` / `src/routes/changes.js` — absent `description`
  (and `impact`) wiped stored values to NULL on partial updates (MED).** The
  update statements used `(description || '').substring(...) || null`, so an
  absent field cleared the stored value — inconsistent with these routes' own
  absent-vs-empty convention for dates/budget/spent/owner/assignee. Switched to
  `resolveOptionalField` so absent preserves and explicit empty clears.
- **`src/routes/knowledge.js` — sanitize-html fallback was fail-open (LOW,
  defense-in-depth).** The load-failure fallback was a no-op (`html => html`),
  which would turn `renderMarkdown` into a stored-XSS surface if sanitize-html
  were ever missing/broken. The fallback now escapes all output (fail-closed),
  mirroring the marked fallback's plain-text degradation.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **671 passed / 671 total** (27 suites, +9 regression tests).

## Review cycle 2026-08-12 (102nd pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Three defensive-coding gaps closed and one consistency
issue corrected:

### Fixes applied
- **`src/routes/tickets.js` — edit route mutated DB result object in-place for PII
  redaction (LOW, defense-in-depth).** The show route had already shallow-copied
  the row before deleting `requester_email`/`requester_phone`/`requester_department`
  for non-privileged viewers, but the edit route did not. If better-sqlite3 ever
  returns cached/memoized result objects, the edit route's `delete` would mutate
  the shared row and leak PII on subsequent requests. Added a shallow copy
  (`const safeTicket = { ...ticket }`) matching the show-route pattern, and
  switched the render call to pass `safeTicket`.
- **`src/routes/assets.js` — show route mutated DB result object in-place for
  PII redaction (LOW, defense-in-depth).** Same class of issue as above:
  `asset.assigned_email = null` mutated the query result directly. Replaced with
  a shallow copy (`const safeAsset = { ...asset }`) so the original row stays
  pristine.
- **`src/routes/licenses.js` — dead `isPrivileged` branch on show route
  (LOW, code clarity).** The show route is gated by `requireAdminOrManager`, so
  `isPrivileged(req.session.user)` is always true and the nulling branch was
  unreachable. Removed the dead code and the now-unused `isPrivileged` import.
- **`src/routes/knowledge.js` — inconsistent `Number()` coercion on authorship
  check (LOW, consistency).** The update route's `isOwner` comparison used bare
  `===` while the show/edit/delete routes in the same file used
  `Number(...author_id) === Number(...user.id)`. Unified to `Number()` on both
  sides for consistency.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **662 passed / 662 total** (26 suites, +3 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-12 (101st pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Sixty+ lines of historically-detailed JSDoc and inline
comments across `src/utils.js`, `src/app.js`, `src/routes/auth.js`,
`src/routes/vendors.js`, `src/routes/tickets.js`, `src/routes/knowledge.js`,
and `src/routes/licenses.js` were condensed to focus on current behavior rather
than past bug-fix narratives, improving readability without losing safety context.

### Fixes applied
- **Condensed verbose JSDoc/comments** across 7 source files — removed ~80 lines
  of historical bug-fix narrative from JSDoc blocks and inline comments that
  described prior review passes rather than current behavior.
- **Fixed indentation** in `src/utils.js` `paginationBaseUrl` comment block
  ( ESLint `@stylistic/indent` error from pass 100 edit).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **659 passed / 659 total** (26 suites).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-12 (100th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Two JSDoc formatting issues corrected:

### Fixes applied
- **`src/utils.js` — `resolveOptionalField` JSDoc indentation inconsistent (LOW, documentation).**
  Lines 653–660 used 4-space indentation while the surrounding JSDoc block used 2-space
  indentation. Unified all lines in the `@param` annotations to match the surrounding
  block's 2-space convention. Also removed a duplicate `@param {*} existingValue` line
  that was accidentally introduced.
- **`src/routes/vendors.js` — `_resolveClearableDate` JSDoc wording misleading (LOW, documentation).**
  The phrase "the same malformed-date fail-open the assets/projects update fixes addressed"
  was grammatically unclear and mixed "fail-closed" with "fail-open" terminology.
  Reworded to: "the same malformed-date handling that was previously fail-open (silently
  storing NULL) and has since been fixed in the assets/projects update paths."

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **659 passed / 659 total** (26 suites).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-12 (99th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Three minor issues corrected:

### Fixes applied
- **`public/js/app.js` — license-key toggle-back masked inconsistently (LOW, consistency).**
  The toggle-back path (`display.dataset.shown === '1'`) showed
  `'****' + storedKey.slice(-4)`, leaking the full key for short keys (≤ 4
  characters) and diverging from the `visibilitychange` / `pagehide` handlers
  which mask to `'****'` only. Unified to `'****'` across all three paths so
  no partial-key preview is ever rendered server-side or client-side.
- **`src/utils.js` — `resolveOptionalField` JSDoc indentation (LOW, documentation).**
  Line 653 had 3 leading spaces instead of 2 in the `@param` annotation block.
  Also expanded the `(NOT collapsed by safeQueryValue)` note into a proper
  multi-line description explaining the HPP-array rejection contract.
- **`src/routes/vendors.js` — `_resolveVendorRatingOnUpdate` JSDoc was misleading
  (LOW, documentation).** The param description claimed the caller passes the
  raw body value so arrays are visible, but the update route actually passes
  `safeQueryValue(req.body.rating)`. Clarified that the function defensively
  handles any shape while callers typically pre-collapse via `safeQueryValue`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **659 passed / 659 total** (26 suites, +1 regression test).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-12 (98th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Two JSDoc inconsistencies were corrected:

### Fixes applied
- **`src/utils.js` — `resolveOptionalField` JSDoc was stale (LOW, documentation).**
  The `processedValue` parameter type was annotated as `{string|null}` even though
  pass 97 added a runtime guard that coerces non-string values via `String(...)`
  before truncation. Updated the annotation to `{*}` and added a note explaining
  the coercion behavior so callers understand the defensive contract.
- **`src/routes/vendors.js` — `_resolveVendorRatingOnUpdate` and
  `_resolveClearableDate` JSDoc improvements (LOW, documentation).**
  The `rawValue` param for `_resolveVendorRatingOnUpdate` incorrectly stated
  "(from safeQueryValue)" when the caller actually passes the raw body value
  (`req.body.rating`) so that array payloads from HTTP parameter pollution are
  visible to the function. Clarified the description. Added `@param` / `@returns`
  annotations to `_resolveClearableDate` so the `{ error: true }` / `{ error: false, value }`
  return shape is documented.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **658 passed / 658 total** (26 suites).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-11 (97th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** One latent bug fixed:

### Fixes applied
- **`src/utils.js` — `resolveOptionalField` crashed on non-string
  `processedValue` (LOW, latent crash).** When `maxLen` was provided and
  `processedValue` was a number or boolean, `processedValue.substring(...)`
  threw `TypeError: processedValue.substring is not a function`. The current
  callers always pass strings (via `trim(safeQueryValue(...))`), so this was
  latent rather than exploitable, but a future caller passing a numeric value
  would crash the request. Added a `typeof` guard that coerces non-string
  values to strings via `String(...)` before truncating. Added two regression
  tests covering numeric and boolean inputs.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **658 passed / 658 total** (26 suites, +1 regression test).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

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
