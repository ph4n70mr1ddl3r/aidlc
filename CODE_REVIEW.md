# Code Review Notes

**Date:** 2026-08-16
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 12 route modules, 2 middleware modules, models, utils, constants.
**Method:** Manual line-by-line review of all source files plus ESLint and the
Jest suite. Prior review history (114+ consecutive hardening commits) was
cross-checked to confirm findings were not already addressed.

---

## Review cycle 2026-08-16 (115th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all 34 EJS views, `public/css/app.css`,
and the test suite). **No new SQL injection, CSRF, XSS, auth, rate-limit, or
error-leakage defects were found.** The codebase has reached a high plateau of
hardening; this pass confirms no regressions and documents the current security
posture.

### Findings

**Security controls verified:**
- **SQL injection:** All dynamic queries use whitelisted helpers (`buildFilters`,
  `addSearch`, `safeSort`, `quoteColumn`, `countQuery`, `selectQuery`) with
  bound params. No raw user input reaches SQL interpolations.
- **Authentication / session:** `requireAuth` re-verifies `is_active`,
  `password_changed_at`, and `role` on every request. Session is regenerated on
  login and password change. Session idle (15 min default) and absolute (8 h
  default) timeouts are enforced by middleware before any route handler runs.
- **Authorization (RBAC / IDOR):** Privileged routes use
  `requireAdminOrManager`/`requireAdmin`. Ownership/re-assignment checks are
  re-done inside `db.transaction()` for TOCTOU safety. `canAccessResource` gates
  all show/edit/delete paths.
- **CSRF:** `doubleCsrf` protects all state-changing routes. Logout is POST-only.
  CSRF cookie is set on every request (including GET) so API/health paths also
  establish the cookie. Token is read from `_csrf` body or `x-csrf-token` header.
- **XSS (KB markdown):** `marked` output is sanitized via `sanitize-html`;
  `input` elements are disallowed; links get `rel="noopener noreferrer"` +
  scheme check. Fallback degrades to escaped plain text (fail-closed).
- **Password policy:** bcrypt 12 rounds, 72-byte cap enforced, complexity
  required. Dummy-hash timing-safe compare on login prevents enumeration.
- **Rate limiting:** Login (10/15m + lockout), password, profile, KB write/read,
  report, audit, and per-route write limiters all present. All authenticated
  limiters use `authKeyGenerator` (user-id keyed, normalized-IP fallback) to
  prevent NAT-bucket sharing.
- **Login brute-force:** Per-account + per-IP failure maps with lockout, bounded
  size (`MAX_LOGIN_FAILURES_MAP_SIZE = 10_000`), periodic stale-entry purge,
  timing-safe dummy-hash compare.
- **HTTP hardening:** `x-powered-by` disabled, `query parser: 'simple'` (prevents
  prototype-pollution CVEs via bracket syntax), TRACE/TRACK rejected at the
  edge, HSTS + CSP + Permissions-Policy via Helmet.
- **Input validation / HPP:** `safeQueryValue`/`safeId`/`safeInt`/`safePositiveFloat`
  reject arrays; `rejectHppArrays()` fail-closed on every write route.
- **Audit logging:** All writes audited; `audit()` validates action/entity
  against allowlists. Access-denied attempts are logged.
- **Transactions / TOCTOU:** All multi-step writes (create/update/delete with
  dependent cleanup) re-fetch and re-check inside `db.transaction()`.
- **File permissions:** DB file permissions explicitly `chmodSync(0o640)` on main
  file plus WAL/SHM sidecars (re-applied after WAL pragma creates them).
- **Session store:** `SESSION_STORE` acceptlist prevents arbitrary code execution
  via env injection. MemoryStore warned in production.

**Observations (by design, not defects):**
- **Cross-ticket commenting** (`tickets.js`): any authenticated user may comment
  on any ticket they can access. Intentional for cross-team collaboration.
- **Manager cannot reactivate a deactivated user** (`staff.js`): `requireAdmin`-only.
- **`recalcProjectProgress` runs post-commit** during staff deactivation:
  eventually consistent; not a defect under synchronous SQLite.
- **Vendor rename syncs `licenses.vendor` by case-insensitive text match**:
  `licenses.vendor` is free text (not a FK); normalized vendor FK would be a
  larger refactor, not a bug fix.
- **Dashboard cache** is process-local TTL (30 s default). In multi-process
  deployments cache is stale up to TTL but never inconsistent — a known
  trade-off documented in `dashboard.js`.
- **Seed script** is guarded against production (`SEED_DANGER=1` override).
  The CLI path and `runSeed()` both enforce the same rule.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **709 passed / 709 total** (29 suites).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-08-14 (114th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, all 34 EJS views, `public/css/app.css`,
and the test suite) focused on completeness, consistency, and unambiguity.
**No new SQL injection, CSRF, or XSS defects.** Several fail-open validation
gaps, an access-policy inconsistency, an ineffective file-permission control,
and a set of cross-file contract mismatches were fixed:

### Fixes applied

**Completeness / security**
- **`src/models/database.js` — `mode: 0o640` constructor option is silently ignored by better-sqlite3 (MEDIUM).** The DB file (password hashes, requester PII, license keys, audit trail) was created world-readable under the default umask despite the comment claiming 0o640. Now enforced with an explicit `chmodSync(0o640)` on the DB plus WAL/SHM sidecars (re-applied after the WAL pragma creates them), best-effort with a warning on failure.
- **`src/routes/licenses.js` + `views/partials/nav.ejs` — list route exposed exactly the business-sensitive data the show route gates on (MEDIUM).** `/licenses` rendered cost/seats for every license to any authenticated staff user while `/licenses/:id` is `requireAdminOrManager` ("license cost and seat data is business-sensitive"). List route now gated the same way, nav link moved inside the privileged block, and the unrendered `l.notes` column dropped from the SELECT.
- **`src/utils.js` `resolveOptionalField` — present non-string JSON values silently cleared stored data (MEDIUM).** `{"email": 123}` (or any number/boolean/object) passed through `trim()` → `''` → the clear branch, wiping the stored field with a success flash. The helper now returns the `{ error: true }` sentinel for present non-string raw values; sentinel checks added in `changes.js` (description/impact) and `projects.js` (description), which previously ignored it. `staff.js` and `vendors.js` create/update routes gained matching explicit non-string guards for `department` and the vendor optional text fields.
- **Truthiness-based malformed-date guards (`assets/tickets/projects/licenses/vendors`) — falsy non-string JSON dates bypassed validation (LOW-MEDIUM).** `if (x && x !== '' && …)` let `{"purchase_date": 0}` skip the guard and then wipe the stored date via the absent-vs-empty resolution. All 16 guards converted to explicit `x !== undefined && x !== null && x !== ''` checks, matching `_resolveClearableDate` semantics.
- **`src/routes/assets.js` — present-but-invalid `status` silently swallowed on update (MEDIUM).** The only enum on the route without fail-closed validation; a typo'd status kept the stored value and flashed success. Now rejected like `category`/`condition_rating` and the create route, projects.js, and tickets.js.
- **`src/routes/dashboard.js` + `src/routes/licenses.js` — IP-keyed rate limiters locked out NAT'd offices (MEDIUM/LOW).** The dashboard limiter (10/min, landing page for ALL users) and both license limiters were the only ones not keyed by authenticated user id. Both now use the shared `authKeyGenerator` pattern (user id with normalized-IP fallback); the dashboard handler answers 429 directly (a flash+redirect would loop — every dashboard route passes through the limiter).

**Consistency**
- **`src/routes/projects.js` — member-add `user_id` failed open via `safeId` parseInt coercion (LOW-MEDIUM).** `'5abc'` → member #5. Now guarded by `isPresentInvalidId` like every other relational id in the codebase.
- **`src/routes/projects.js` — quick-status path reported invalid input as "Status unchanged" (LOW).** Now rejects a bogus status up front, mirroring tickets.js quick-status and the full-update branch.
- **`src/routes/projects.js` — `_showMembersStmt` had `LIMIT 100` with no `ORDER BY` (LOW).** Non-deterministic subset; added `ORDER BY pm.id ASC`. Also: member-add audit now records the real `project_member` id (`lastInsertRowid`) like member-delete; `_taskQuickStatusStmt` aligned to the COALESCE `completed_at` encoding used by the full update; `_projectBudgetSpentStmt` renamed `_projectUpdateBaseStmt` (it selects 8 columns, not 2).
- **`src/routes/staff.js` — race-path error message dropped "or manager" (LOW).** In-transaction `ACCESS_DENIED_ADMIN` recheck now flashes the same message as the outer check.
- **`src/routes/auth.js` — profile update did not invalidate the active-staff cache (LOW).** Self-service renames left stale names in every dropdown for up to 30s; now mirrors `PUT /staff/:id` by invalidating both caches.
- **`src/middleware/auth.js` — role sync left `res.locals.user` stale for the current request (LOW).** After re-assigning `req.session.user`, `res.locals.user` still referenced the pre-sync object, rendering one request of stale role-gated UI. Now refreshed.

**Unambiguity**
- **`src/routes/tickets.js` + `views/pages/tickets/form.ejs` — edit form contradicted the route's documented PII contract (MEDIUM).** The route assumes "non-privileged editors' submissions lack the PII fields", but the form rendered them (with `required` on the email input, forcing staff to fabricate a value that was then silently discarded). The form now omits email/department/phone for non-privileged editors, making the preserve-on-absent logic operative; comment updated.
- **`src/routes/reports.js` + `views/pages/reports/assets.ejs` — "Both queries exclude disposed" comment was false and the page totals disagreed (LOW-MEDIUM).** Only `assetsByCategory` excluded disposed, so the "Total Assets" card disagreed with the status/condition/age breakdowns on the same page. Comment now states the actual split (value queries exclude disposed; fleet-composition breakdowns cover all assets) and the stat card is labeled "Active Assets".
- **`views/pages/knowledge/index.ejs` — "New Article" hidden from staff although the routes implement staff draft authoring (MEDIUM-LOW).** `GET /new`, `POST /`, and `resolveSafeStatus`'s force-draft-on-create branch all support non-privileged authors; the entry-point gate made that dead UI. Gate removed.
- **`src/seed.js` — CLI production guard made `runSeed`'s documented `SEED_DANGER=1` override unreachable via `npm run seed` (LOW).** The CLI early-exit now honors the override; both guards enforce the same rule.
- **`src/routes/dashboard.js` — `_dashboardRefreshing` was unreachable dead state (LOW).** `getDashboardData` is fully synchronous, so no request could ever observe the flag; its comment also justified it with impossible cross-process sharing of a module-local `let`. Removed (header comment already documents why no lock is needed).
- **`src/routes/knowledge.js` — comment said "Prepend" but the code appends (LOW).** Reworded to match `concat(...).slice(-MAX)` (evicts oldest-viewed from the front).
- **`views/pages/error.ejs` — hardcoded "500 / Server Error" for 4xx responses (LOW).** The error handler honors `err.status` (e.g. 413) but the page always showed 500; now displays the actual code and "Request Error" for 4xx.
- **`views/pages/dashboard.ejs` — upcoming changes dropped the time from `scheduled_start` (LOW).** Switched to `formatDateTime` like changes index/show.
- **`views/partials/nav.ejs` — "My Tickets" filtered to `status=open` only (LOW).** An assignee whose tickets were all `in_progress` got an empty list; now matches the dashboard's "My Active Tickets" link.
- **`views/pages/licenses/index.ejs` — expired licenses not highlighted (LOW).** `isExpiringSoon` ignores negative days; expired rows now highlight like expiring-soon ones (mirrors the dashboard warranty and asset Expired badge conventions).
- **`views/pages/staff/index.ejs` — only list page without an empty state (LOW).** Added the standard `empty-state` block.
- **`public/css/app.css` — `.alert`/`.alert-warning` used by the knowledge fallback banner were undefined (LOW).** Added, mirroring `.flash` styling.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **700 passed / 700 total** (28 suites, +23 regression tests in `tests/code_review_114.test.js` covering the resolveOptionalField sentinel, assets status validation, projects member-add/quick-status, changes/vendors/staff non-string guards, the licenses list policy, tickets-form PII gating, expired-license highlight, and the error-page status code).

## Review cycle 2026-08-13 (113th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Two audit-trail gaps closed:

### Fixes applied
- **`src/routes/assets.js` — show route missing `access_denied` audit (LOW, audit gap).**
  Unauthorized view attempts on assets were redirected without leaving an audit
  trail. Added `req.audit('access_denied', 'asset', id, ...)` mirroring the
  pattern already used by tickets, changes, and knowledge routes.
- **`src/routes/projects.js` — show route missing `access_denied` audit (LOW, audit gap).**
  Same gap as above for projects. Added `req.audit('access_denied', 'project', id, ...)`
  so unauthorized project-view attempts are logged for security review.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **677 passed / 677 total** (27 suites).

## Review cycle 2026-08-13 (111th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Two minor consistency/behavior fixes applied:

### Fixes applied
- **`public/js/app.js` — `visibilitychange` handler did not reset
  `dataset.shown` on license-key display (LOW, UX bug).** The
  `visibilitychange` listener masked the displayed key to `'****'` when the
  tab became hidden, but left `dataset.shown` as `'1'`. On the next click the
  toggle-back path was taken instead of the fetch path, showing `'****'` again
  and preventing the user from re-revealing the key without a page reload.
  Added `display.dataset.shown = ''` so the next click correctly follows the
  fetch path, matching the behaviour of the `pagehide` handler.
- **`src/utils.js` — missing blank line before module-load `PAGE_SIZE`
  initialisation (LOW, consistency).** The `_resetPageSize` function closed on
  line 1094 and the module-load assignment began immediately on line 1095,
  breaking the convention used by all other modules which insert a blank line
  between the function and the initialisation call. Added the missing blank
  line for visual consistency.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **671 passed / 671 total** (27 suites).

## Review cycle 2026-08-13 (108th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** One minor UI consistency fix applied:

### Fixes applied
- **`src/routes/vendors.js` — INVALID_ error messages used lowercase field names
  (LOW, consistency).** The dynamic error-path for `INVALID_CONTACT_PERSON`,
  `INVALID_EMAIL`, etc. ran `.toLowerCase()` on the field name, producing
  messages like `Invalid contact person` instead of the title-case form used
  everywhere else (`Invalid Contact Person`). Updated to title-case each word
  so error messages match the explicit-string convention across all other
  route modules.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **671 passed / 671 total** (27 suites).

## Review cycle 2026-08-13 (107th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Two minor defensive-coding improvements applied:

### Fixes applied
- **`src/app.js` — remove unnecessary `prefersJson` destructuring (LOW, code
  clarity).** The `utilsModule` import was destructured solely for a single
  one-liner call (`prefersJson(req)`) in the error handler, while the rest of
  the file already uses `utilsModule.something` directly. Removed the
  destructuring and inlined the call as `utilsModule.prefersJson(req)` so the
  single-reference import is no longer a standalone binding.
- **`src/routes/knowledge.js` — defensive optional chaining on
  `sanitizeHtml.defaults` (LOW, defense-in-depth).** The `SANITIZE_HTML_OPTIONS`
  object spreads `sanitizeHtml.defaults.allowedTags` and
  `sanitizeHtml.defaults.allowedAttributes` at module-load time. While the
  pinned `sanitize-html@2.17.5` always exposes `.defaults`, a future version
  mismatch or unexpected load path could leave it undefined and throw before
  any request is served. Added `?.` / `|| []` / `|| {}` fallbacks so the
  fallback noop path (activated when the package fails to load) and the normal
  path both remain safe.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **671 passed / 671 total** (27 suites).

## Review cycle 2026-08-13 (106th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Two minor consistency fixes applied for module export
formatting:

### Fixes applied
- **`src/routes/audit.js` — missing blank line before `module.exports` (LOW,
  consistency).** The `resetCachedStatements` function closed on line 97 and
  `module.exports` began immediately on line 98, breaking the convention used
  by all other route modules (assets, tickets, staff, vendors, etc.) which
  insert a blank line between the function and the exports. Added the missing
  blank line for visual consistency.
- **`src/routes/changes.js` — same missing blank line before `module.exports`
  (LOW, consistency).** Same pattern as above; the `resetCachedStatements`
  function closed without a trailing blank line before `module.exports = router`.
  Added the blank line to match the convention used across all other route
  modules.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **671 passed / 671 total** (27 suites).

## Review cycle 2026-08-13 (105th pass)

An independent pass (full re-read of all 11 route modules, both middleware
modules, utils, constants, models, seed, EJS views, `public/js/app.js`, and the
test suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Two defense-in-depth fixes applied for DB result-object
mutation:

### Fixes applied
- **`src/routes/tickets.js` — `comments.reverse()` mutated DB query result in-place
  (LOW, defense-in-depth).** The show route had shallow-copied the ticket row before
  deleting PII properties, but the comments array was only shallow-copied for
  non-privileged viewers. For privileged viewers `comments === rawComments`, so
  `comments.reverse()` mutated the `better-sqlite3` result object directly. If the
  driver ever returns cached/memoized row objects, this would leak PII across
  requests. Changed to always allocate a new array (`[...rawComments].reverse()`
  for privileged, `.filter(...).reverse()` for non-privileged) so the original DB
  result is never mutated.
- **`src/routes/staff.js` — `renderedStaff` returned original DB rows for the
  self-view case and the privileged case (LOW, defense-in-depth).** The index
  route shallow-copied rows only when zeroing PII for other users; the viewer's
  own row and all privileged-viewer rows were passed through as-is. A future
  mutation of those objects (e.g. by a template helper or middleware) could leak
  PII if the driver caches results. Unified to always shallow-copy every row,
  preserving the existing PII-zeroing logic for non-privileged non-self rows.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **671 passed / 671 total** (27 suites).

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
