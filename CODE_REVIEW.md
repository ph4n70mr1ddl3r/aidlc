# Code Review Notes

**Date:** 2026-08-04
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 11 route modules, 2 middleware modules, models, utils, constants.
**Method:** Manual line-by-line review of all source files (every `.js` file in
`src/routes/`, `src/middleware/`, `src/models/`, `src/`, and `tests/`) plus ESLint
and the Jest suite. Prior review history (48+ consecutive "code review" hardening
commits) was cross-checked to confirm findings were not already addressed.

## Review cycle 2026-08-04 (forty-eighth pass)

A forty-eighth independent pass (full source re-read of all 11 route modules,
both middleware modules, utils, constants, models, all EJS views, `public/js`,
and all 20 test files) found **no new SQL injection, IDOR, CSRF, XSS, auth, or
error-leakage defects.** One correctness bug in `titleCase` was found and fixed:

### Fixes applied
- **`utils.js` — `titleCase` silently mangled mixed-case acronyms (LOW).** The
  `ACRONYMS` set contained four mixed-case entries — `IoT`, `NVMe`, `OAuth`,
  `PCIe` — but the lookup path in `titleCase` called `word.toUpperCase()` and
  checked `ACRONYMS.has(upper)`. Since `"NVME" !== "NVMe"`, these four
  acronyms were never matched: `titleCase('nvme_drive')` returned `"Nvme Drive"`,
  `titleCase('oauth_token')` returned `"Oauth Token"`, etc. Normalized all four
  set entries to their fully-uppercase forms (`'IOT'`, `'NVME'`, `'OAUTH'`,
  `'PCIE'`) so the `.toUpperCase()` lookup succeeds. The function renders
  acronyms in all-caps by design (the existing `SOP`, `API`, `DNS` entries
  already behaved this way), so the observable output is correct; only the
  previously-missing acronyms were affected.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; CSRF
  tokens on all state-changing forms; the only `<%-` sink is server-sanitized;
  login timing-oracle and all prior fixes intact.
- `resetCachedStatements` exists on every route module and middleware module for
  test isolation; all 20 test suites continue to pass.

### Test coverage added
- `tests/utils.test.js` — added a regression case asserting that
  `titleCase('nvme_drive')`, `titleCase('oauth_token')`, `titleCase('pcie_slot')`,
  and `titleCase('iot_device')` all render the acronym in all-caps, catching a
  future regression where mixed-case set entries would silently break the
  lookup again.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 407 passed / 407 total (baseline 405 + 2 new).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-08-03 (forty-seventh pass)

A forty-seventh independent pass (full source re-read of all 11 route modules,
both middleware modules, utils, constants, models, all EJS views, `public/js`,
and all 19 test files) found **no new SQL injection, IDOR, CSRF, XSS, auth, or
error-leakage defects.** Two data-preservation gaps (one medium, one low) were
found and fixed across all four assignee/owner resources:

### Fixes applied
- **`tickets.js` / `assets.js` / `projects.js` / `changes.js` — editing a record
  whose assignee/owner was later deactivated silently wiped the assignment
  (MEDIUM).** The edit forms build the assignee/owner `<select>` from
  `getActiveStaff()`, which only returns `is_active = 1` users. When the current
  assignee had since been deactivated, no `<option>` matched, the browser
  silently fell back to the first option ("Unassigned"/"Select owner"), and
  re-saving stored `NULL` — wiping the assignment with no user feedback.
  Deactivation deliberately keeps the assignee on resolved/closed records for
  historical attribution (staff.js `_unassignTicketsStmt` etc. only clear open/
  in-progress items), and assets are never unassigned, so this was reachable via
  normal usage (e.g. re-titling a resolved ticket or relocating an asset still
  assigned to a departed employee).
  - Added a shared pure helper `ensureAssigneeInList(staff, currentAssigneeId, db)`
    in `src/utils.js` (mirrors `ensureLinkedAssetInList` in tickets.js) that
    prepends the deactivated assignee/owner to the dropdown list so the select
    renders the current value as selected.
  - Each edit form route now passes its list through the helper: `tickets.js`
    (edit GET), `assets.js`, `projects.js`, `changes.js`.
  - The update transactions now preserve the current assignee/owner when the
    submitted id is **unchanged** even if inactive (so the new dropdown value is
    saveable), while still rejecting reassignment to a **different** inactive
    user (`ASSIGNEE_NOT_AVAILABLE` / `OWNER_NOT_AVAILABLE`, fail closed).
  - `projects.js` `_projectBudgetSpentStmt` now also selects `owner_id` so the
    transaction-consistent row exposes the current owner for the comparison.
- **`vendors.js` — partial update could persist `contract_end < contract_start`
  (LOW).** The update route validated the date range against only the *submitted*
  values, but contract dates resolve to the stored value when a field is absent.
  A partial PUT submitting only `contract_start` (past the stored `contract_end`)
  passed the outer check (submitted `contract_end` was null) and persisted an
  end-before-start pair. The check now runs inside the transaction against the
  **resolved** values (mirroring `changes.js` `SCHEDULED_END_BEFORE_START`),
  throwing `CONTRACT_END_BEFORE_START` and redirecting with the same user-facing
  message. The outer submitted-only check was removed.

### False positives / non-defects reconfirmed
- **Ticket-list visibility for regular staff (reviewed, not a defect).** All
  authenticated staff can enumerate ticket *metadata* on the list page, while
  detail routes enforce `canAccessResource()`. This matches the app's shared
  queue design: the dashboard's "Recent Tickets" and "Team Workload" panels are
  likewise visible to all staff, `requester_name` is not part of the app's
  redacted-PII set (only email/phone/department are redacted on detail routes),
  and the list never exposes requester email/phone/department.
- **Per-GET `req.audit('read', …)` inserts (reviewed, not a defect).** The 13
  read-audit call sites (detail pages, reports) are the intended audit trail for
  sensitive views (e.g. license-key reveals, staff profiles) and are bounded by
  audit-log retention/pruning; the app consistently rate-limits writes rather
  than reads.
- **`knowledge/show.ejs:28` `<%- article.renderedContent %>` (reviewed, not a
  defect).** The content is authored in-app by staff and run through
  `marked.parse` → `sanitize-html` (strict config) before rendering; the `<%-`
  sink is server-sanitized. Unrestricted full-HTML authoring is the knowledge
  feature's documented behavior, so escaping (not the sink) is the correct
  control.
- All SQL still flows through whitelisted helpers with bound params; IDOR/TOCTOU
  ownership rechecks remain inside `db.transaction`; CSRF tokens on all
  state-changing forms; the only `<%-` sink is server-sanitized; login
  timing-oracle and all prior fixes intact.

### Test coverage added
- `tests/partial_update.test.js` — 14 new tests: `ensureAssigneeInList` unit
  coverage (prepend inactive assignee / no dupe / null & unknown id); update-route
  preservation of an unchanged inactive assignee/owner for tickets, assets,
  changes, and projects (asserting the assignment survives the UPDATE, not just
  the redirect); rejection of reassignment to a different inactive user for all
  four; ticket edit form rendering the inactive assignee in the dropdown; and
  vendors partial-update date-range rejection (plus an in-range acceptance check).
  The projects tests locate the project-UPDATE `run` call by argument count to
  ignore the post-transaction `recalcProjectProgress` write.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 405 passed / 405 total (baseline 391 + 14 new).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-21 (forty-sixth pass)

A forty-sixth independent pass (full source re-read of all 11 route modules,
both middleware modules, utils, constants, models, all EJS views, `public/js`,
and all 18 test files) found **no new SQL injection, IDOR, CSRF, XSS, auth, or
error-leakage defects.** Three defense-in-depth and operational-observability
improvements were applied:

### Fixes applied
- **`public/js/app.js` — license keys not cleared on bfcache navigation (LOW).**
  The `visibilitychange` listener re-masks displayed license keys when the tab
  becomes hidden, but the browser's bfcache (back-forward cache) can persist the
  page without firing `visibilitychange` when the user navigates away. Added a
  `pagehide` listener that re-masks any visible license-key display and clears the
  in-memory `_licenseKeys` store, so keys cannot be accessed from a bfcached page.
- **`src/app.js` — `/health` endpoint required at least one user in the DB (LOW).**
  The health check verified DB connectivity AND that the `users` table contained
  at least one row. A fresh install (before seeding) or a state where all users
  were deactivated would report unhealthy, confusing load-balancer probes and
  auto-scaling health checks. Removed the user-existence check; `/health` now
  only verifies DB connectivity (the `SELECT 1` probe). The unused `_healthUserCheckStmt`
  prepared statement was also removed.
- **`src/utils.js` — invalid `PAGE_SIZE` env silently fell back to default with
  no signal to the operator (LOW).** `_derivePageSize()` silently ignored any
  non-numeric or non-positive `PAGE_SIZE` value. Added a `console.warn` that
  fires only when the parsed value is non-finite or non-positive (clamped values
  like `PAGE_SIZE=9999` still silently cap to `MAX_PAGE_SIZE` without noise), so
  misconfiguration is visible in startup logs.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; CSRF
  tokens on all state-changing forms; the only `<%-` sink (`renderedContent`) is
  server-sanitized; `target=_blank` links carry `rel="noopener noreferrer"` +
  scheme check; login timing-oracle and all prior fixes intact.
- `resetCachedStatements` exists on every route module and middleware module for
  test isolation; all 18 test suites continue to pass.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 360 passed / 360 total.
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-21 (forty-fifth pass)

A forty-fifth independent pass (full source re-read of all 11 route modules,
both middleware modules, utils, constants, models, all EJS views, and all test
files) found **no new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects.** One fail-open field-preservation gap was found and fixed:

### Fixes applied
- **`projects.js` — partial update silently wiped stored `start_date`/`end_date`/
  `status`/`priority` when those fields were absent from the request (MEDIUM).**
  The update route's `_projectBudgetSpentStmt` only selected `budget, spent`, but
  inside the transaction the code referenced `existingProject.status` and
  `existingProject.priority` — both `undefined` because the query never loaded
  them. A hand-crafted PUT omitting `status`/`priority`/`start_date`/`end_date`
  would set those columns to NULL in the DB, silently destroying stored data.
  (Browser form submissions always include every field, so this could not trigger
  through normal usage, but API clients or programmatic PATCH calls were
  vulnerable.) The query now selects `budget, spent, status, priority, start_date,
  end_date`, and the transaction resolves absent date fields to the stored value
  (mirroring the `resolvedPurchase`/`resolvedWarranty` pattern in `assets.js`).
  The `status` and `priority` fallback-to-existing now correctly reads from the
  freshly-returned row instead of `undefined`.

### Test coverage gaps closed
- `tests/templates.test.js` — `baseLocals()` now includes `isValidEmail` so the
  wired-in-`res.locals` guard correctly reflects the template surface (three EJS
  templates — staff/show, tickets/show, vendors/show — use `isValidEmail` for
  mailto: link rendering).
- `tests/hpp.test.js` — `_projectBudgetSpentStmt` mock now returns the
  additional `status`, `priority`, `start_date`, `end_date` columns so the
  regression test continues to match the new query shape.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; CSRF
  tokens on all state-changing forms; the only `<%-` sink (`renderedContent`) is
  server-sanitized; `target=_blank` links carry `rel="noopener noreferrer"` +
  scheme check; login timing-oracle and all prior fixes intact.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 315 passed / 315 total (no new tests added; existing coverage
  verified on changed paths).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-21 (forty-fourth pass)

A forty-fourth independent pass (full source re-read of all 11 route modules,
both middleware modules, utils, constants, models, all 38 EJS views, and all 13
test files) found **no new SQL injection, IDOR, CSRF, XSS, auth, error-leakage,
or TOCTOU defects.** Two consistency gaps and one latent runtime crash were found
and fixed:

### Fixes applied
- **`audit/index.ejs` — `escapeHtml()` called from template context (BUG / would
  crash at runtime).** The template at line 26 used `<%= escapeHtml(e.details ||
  '') %>` but `escapeHtml` was not exposed in `res.locals` (missing from `app.js`
  global template variables). Visiting `/audit` would throw `ReferenceError:
  escapeHtml is not defined`. Additionally, `<%= %>` already HTML-escapes, so the
  manual `escapeHtml()` wrapper produced a double-escape bug in tooltips for
  entries containing special characters (e.g. `&` → `&amp;amp;`). Removed the
  `escapeHtml()` wrapper (relying on `<%= %>` escaping), and added `escapeHtml`
  to `res.locals` in `app.js` for future use.
- **`knowledge.js` — `console.error` used `String(err)` instead of `err.message`
  (LOW, consistency).** Lines 144 (primary markdown render) and 149 (secondary
  sanitize) logged errors with `String(err)`, while every other error handler in
  the codebase uses `err.message`. Changed both to `err.message`.

### Test coverage gaps closed
- `tests/templates.test.js` — `baseLocals()` now includes `escapeHtml` so the
  wired-in-`res.locals` guard correctly reflects the template surface.
- `tests/templates.test.js` — added an `audit/index` rendering test (with an
  entry containing `& <script>` in details) to catch future ReferenceErrors or
  double-escapes in tooltips.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; CSRF
  tokens on all state-changing forms; the only `<%-` sink (`renderedContent`) is
  server-sanitized; `target=_blank` links carry `rel="noopener noreferrer"` +
  scheme check; login timing-oracle and all prior fixes intact.
- `escapeHtml` and `isValidUsername` unit tests already exist in `utils.test.js`
  (contrary to an earlier preliminary analysis — confirmed covered), so no new
  unit tests were needed.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 315 passed / 315 total (added 1 template regression case).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-20 (forty-third pass)

A forty-third independent pass (full source re-read of all 11 route modules,
both middleware modules, utils, constants, models, and all 13 test files) found
**no new SQL injection, IDOR, CSRF, XSS, auth, error-leakage, or TOCTOU defects.**
One minor consistency gap was found and fixed:

### Fixes applied
- **`vendors.js` — `rating` omitted from the create-route HPP array-rejection
  guard (LOW).** The `POST /` handler's `_hppCreateFields` array listed every
  other body field but not `rating`, while `PUT /:id`'s `_hppUpdateFields` did
  include it. The rating value was still fail-closed against arrays via
  `_validateVendorRating`'s internal `Array.isArray` check, but the guard was
  inconsistent with the update route and every other codebase convention. Added
  `'rating'` to the create-route array-rejection loop so both paths uniformly
  reject array payloads before field extraction.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; CSRF tokens
  on all state-changing forms; the only `<%-` sink (`renderedContent`) is
  server-sanitized; `target=_blank` links carry `rel="noopener noreferrer"` +
  scheme check; login timing-oracle, `entityId == null` coercion, and all
  prior fixes intact.
- Every write route rejects HPP arrays on all body fields; every numeric/date
  field is fail-closed on malformed present values. Consistent across all routes.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 314 passed / 314 total.
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-19 (sixteenth pass)

A sixteenth independent pass (2 parallel review agents: one over route modules
batch 1 [assets/projects/vendors/licenses/changes], one over route modules batch 2
[tickets/staff/knowledge/auth/dashboard/reports/audit] plus a manual re-read of
`utils.js`, `constants.js`, `app.js`, the middleware modules, and `models/database.js`)
found **no new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage defects**.
(An agent-flagged "missing CSRF" finding was a false positive — `doubleCsrfProtection`
is wired in `app.js` and every state-changing form carries a `_csrf` token; a
flagged in-memory login-lockout `Map` was reconfirmed as the documented
single-instance limitation, not a defect.) One genuine, previously-unaddressed
**fail-open validation bug** was found and fixed:

### Fixes applied
- **`licenses.js` — `_resolveSeats` silently coerced malformed `total_seats` /
  `used_seats` to the default/stored count (HIGH).** The helper called
  `safePositiveInt(raw, fallback)`, which returns the fallback for *any*
  non-parseable input, so a present-but-garbage value (`"abc"`, `"12.5"`, a polluted
  array that `safeQueryValue` collapses to a string, or a negative number) was
  silently stored as the default (`1` total / `0` used on create) or the existing
  stored count on update — without an error. This is exactly the fail-open pattern
  the prior passes fixed for `cost` (9th pass), `budget`/`spent` (2nd pass), and the
  various malformed-date fields (8th/11th/12th/14th passes), but seats had been
  missed. Now the helper distinguishes "absent/empty" (preserves the stored/default
  value) from "present-but-non-numeric" (rejected with a `"Invalid total seats"` /
  `"Invalid used seats"` error, fail-closed), mirroring the `cost` guard. The create
  route surfaces the error before the transaction; the update route throws
  `SEAT_VALIDATION` (already caught and redirected to the edit page with a flash).

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; CSRF tokens on all
  state-changing forms (verified `doubleCsrfProtection` is active in `app.js`);
  the only `<%-` sink (`renderedContent`) is server-sanitized; `target=_blank` links
  carry `rel="noopener noreferrer"` + scheme check; login timing-oracle,
  `entityId == null` coercion, `recalcProjectProgress` guards, dashboard PII
  over-fetch (explicit column lists), and the `audit_log` self-trail fix all intact.
- Every write route rejects HPP arrays on all body fields; every numeric/date
  field is fail-closed on malformed present values (now consistent across all of
  assets/projects/vendors/licenses/changes). Verified cross-route for consistency.

### Test coverage gaps closed
- `tests/licenses.test.js` corrected and extended its `resolveSeats` block:
  - Garbled present `total_seats`/`used_seats` (`"abc"`, `"12.5"`) now assert a
    `"Invalid total seats"` / `"Invalid used seats"` error (fail-closed) instead of
    silently coercing to the default/existing count.
  - A present negative `total_seats` (`"-5"`) now asserts `"Invalid total seats"`
    (previously it silently clamped to `1`).
  - A present garbled value on a *partial update* (with an existing row) now asserts
    rejection rather than being coerced to the stored count.
  - The HPP-array case now asserts fail-closed rejection rather than silent fallback.
  - Absent/empty partial submissions still preserve the stored count (unchanged).

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 313 passed / 313 total (added 4 regression cases).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-19 (fifteenth pass)

A fifteenth independent pass (3 parallel review agents: one over route modules batch 1
[assets/projects/vendors/licenses/changes], one over route modules batch 2
[tickets/staff/knowledge/auth/dashboard/reports/audit], and one over all 42 EJS views
and `public/js/app.js`, plus a manual re-read of `app.js`, `utils.js`, `constants.js`,
`dashboard.js`, `middleware/audit.js`, and `seed.js`) found **no new SQL injection,
IDOR, CSRF, XSS, auth, or error-leakage defects**. One genuine, previously-unaddressed
**boolean-flag coercion bug** was found and fixed:

### Fixes applied
- **`tickets.js` comment `is_internal` and `knowledge.js` `is_featured` coerced
  non-canonical strings to truthy (LOW).** Both flags used the idiom
  `(x && x !== '0')`, which treats *any* non-empty string that is not exactly `'0'`
  as truthy — so a privileged caller submitting `is_internal=false`, `off`, or `no`
  (e.g. via an API client or a hand-built form) would silently store the flag as `1`.
  Extracted the canonical allowlist (`'1'`/`'true'`/`'on'`) into a single shared
  `parseBooleanFlag(value, privileged)` helper in `utils.js`, used by both routes
  (with the privilege gate folded in). Now only the three canonical checked values
  set the flag; every other value maps to `0`. No security boundary was crossed
  (only privileged users can set these flags), but the coercion was incorrect and
  inconsistent with strict-input intent, so it is fixed.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; CSRF tokens on all
  state-changing forms; the only `<%-` sink (`renderedContent`) is server-sanitized;
  `target=_blank` links carry `rel="noopener noreferrer"` + scheme check; login
  timing-oracle, `entityId == null` coercion, `recalcProjectProgress` guards, dashboard
  PII over-fetch (explicit column lists), and the `audit_log` self-trail fix all intact.
- Every write route rejects HPP arrays on all text body fields; every numeric/date
  field is fail-closed on malformed present values (consistent across all create/update
  routes). Verified cross-route for consistency.

### Test coverage gaps closed
- `tests/utils.test.js` extended with a `parseBooleanFlag` unit block asserting canonical
  checked values map to `1`, missing/empty map to `0`, non-canonical strings (`false`/
  `off`/`no`/`0`) map to `0`, and a non-privileged caller always gets `0`.
- `tests/knowledge.test.js` extended with regression cases asserting `resolveSafeFeatured`
  no longer coerces `false`/`off`/`no` to featured.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 309 passed / 309 total (added 9 regression cases).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-19 (fourteenth pass)

A fourteenth independent pass (3 parallel review agents: one over the route modules
batch 1 [assets/projects/vendors/licenses], one over route modules batch 2
[tickets/staff/changes/knowledge/auth/dashboard/reports/audit], and one over the
core files, all EJS views, and `public/js`) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects**. Two genuine, previously-unaddressed
fail-open validation defects and one defense-in-depth PII over-fetch were found and
fixed; all are sibling-path inconsistencies where the codebase's established
"fail-closed" convention had been applied elsewhere but missed on these paths.

### Fixes applied
- **`licenses.js` create/update — malformed `purchase_date`/`expiry_date` silently
  stored NULL (LOW / MEDIUM on update).** Both routes validated only date *ordering*;
  a present-but-unparseable date (e.g. `2026-13-45`) flowed through `safeDate()` to
  `NULL` with no error and no user feedback. On update this silently overwrote a
  legitimate stored date. This is exactly the fail-open malformed-date pattern already
  fixed fail-closed on `projects.js` (8th pass), `assets.js` (11th/12th passes), and
  `vendors.js` (12th pass), but `licenses.js` was only given the `cost` treatment (9th
  pass). Added the present-non-empty-malformed-date rejection (`purchase_date !== '' &&
  sPurchase === null` → "Invalid purchase date", same for expiry) before the ordering
  check in both `POST /` and `PUT /:id`, mirroring the sibling routes.
- **`tickets.js` create/update — `due_date` failed open on malformed present value
  (MEDIUM).** Both routes passed `due_date` straight through `safeDate()` into the
  INSERT/UPDATE with no "present-but-invalid" rejection — so editing *any other field*
  while `due_date` was corrupted/malformed silently wiped a valid stored due date to
  `NULL`, with no error and no audit of the loss. This is the same fail-open date
  scenario the 11th-pass `assets.js` update-date fix explicitly called out. Added a
  `safeDueDate` variable and, before the transaction, a `due_date && due_date !== '' &&
  safeDueDate === null` rejection ("Invalid due date") in both `POST /` and `PUT /:id`,
  mirroring `changes.js`/`projects.js`.
- **`dashboard.js` — `recentTickets`/`myTickets` `SELECT *` over-fetched requester PII
  (LOW, defense-in-depth).** Both prepared statements loaded the full `tickets` row
  (including `requester_email`, `requester_phone`, `requester_department`, and
  `due_date`) into the module-level **shared, cached dashboard object**
  (`dashboardCache.data`), which is spread into the rendered context and re-used across
  requests. The template only reads `id`, `ticket_number`, `title`, `category`,
  `priority`, `status`, `created_at`, and `assigned_name` — the PII columns are never
  rendered. This widens the PII-exposure surface of the shared cache exactly as the
  10th-pass `licenseAlerts` fix (which changed `SELECT *` to explicit columns to keep
  `license_key` out of the cached payload) warned against. Changed both statements to
  select only the rendered columns (joining `users` for `assigned_name`), shrinking the
  cached PII footprint. No current leak (template does not render it); this is
  consistency with the established defense-in-depth model.

### Non-defects / deliberately-by-design reconfirmed
- `assets.js` update `status` preserve-existing-on-invalid (documented by-design) and
  dead `Array.isArray` guards inside `_resolveClearableDate` (defense-in-depth)
  reconfirmed unchanged.
- Reports `SELECT *` on warranty/assets remains legitimate (admin/manager-only and its
  columns are rendered); `expiringWarranties`/`upcomingChanges` `SELECT *` only read
  `.length`/rendered columns.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; CSRF tokens on all
  state-changing forms; the only `<%-` sink (`renderedContent`) is server-sanitized;
  `target=_blank` links carry `rel="noopener noreferrer"` + scheme check; login
  timing-oracle, `entityId == null` coercion, `recalcProjectProgress` guards, and the
  `audit_log` self-trail fix all intact.

### Test coverage gaps closed
- `tests/hpp.test.js` extended with regression cases asserting `licenses.js` create
  (`purchase_date='2026-13-45'`) and update (`expiry_date='not-a-date'`) now reject
  malformed dates fail-closed (redirect to the form + error flash) instead of silently
  persisting NULL.
- `tests/hpp.test.js` extended with regression cases asserting `tickets.js` create
  (`due_date='2026-13-45'`) and update (`due_date='not-a-date'`) now reject malformed
  dates fail-closed instead of silently storing/wiping NULL.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 304 passed / 304 total (added 4 regression cases).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-19 (thirteenth pass)

A thirteenth independent pass (2 parallel review agents: one over all route modules +
utils/constants/middleware, one over every EJS view + `public/js`) found **no new SQL
injection, IDOR, CSRF, XSS, auth, or error-leakage defects**. Two genuine,
previously-unaddressed defects were found and fixed; both are sibling-path
inconsistencies where the codebase's established "fail-closed" convention had been
applied elsewhere but missed on these paths.

### Fixes applied
- **`projects.js` update — malformed `budget`/`spent` error message silently
  dropped (HIGH).** The update route throws `INVALID_BUDGET` / `INVALID_SPENT`
  *inside* the transaction carrying an attached `err.flash` ("Invalid budget
  amount" / "Invalid amount spent"), mirroring the `licenses.js` seat-validation
  pattern. But the `catch` block only handled `NOT_FOUND` and `OWNER_NOT_AVAILABLE`
  and fell through to a generic "Error updating project. Please try again." — it
  never read `err.flash`. A user submitting a typo'd budget/spent on a partial edit
  was therefore rejected fail-closed (no data corruption) yet shown a misleading
  generic error instead of the real reason. Added the `INVALID_BUDGET` /
  `INVALID_SPENT` branch to the catch block so the specific flash is surfaced and
  the handler redirects back to the edit page, exactly as `licenses.js` does.
- **`vendors.js` create/update — `contract_start` / `contract_end` omitted from the
  HPP array-rejection guards (LOW).** Every other vendor text field is fail-closed
  against HTTP parameter pollution arrays via the `_hppFields` loops, but the two
  contract date fields were not listed, so a polluted `contract_start[]=a&...=b`
  collapsed to its first element via `safeQueryValue` (fail-open) — inconsistent
  with the rest of the codebase. Added both fields to the `_hppFields` arrays in
  both `POST /` and `PUT /:id` so array payloads are rejected before parsing.

### Non-defects / deliberately-by-design reconfirmed
- **`assets.js` update `status` preserves the existing value on an invalid non-empty
  value (LOW, flagged by the agent).** This is intentional and documented in-code:
  it mirrors the vendor/project/license "preserve existing on partial submit"
  convention and never applies an attacker-chosen status, so it is not a fail-open
  defect. Left unchanged.
- **Dead `Array.isArray` guards inside `_resolveClearableDate` (LOW, flagged).** The
  date resolver receives values already collapsed by `safeQueryValue`, so its
  internal array check can never fire — the real protection is the new route-level
  HPP guard. Left as defense-in-depth (the helper is also unit-tested directly with
  array input, so removing it would regress `tests/vendors.test.js`).

### False positives / non-defects reconfirmed
- All SQL dynamic queries still flow through the whitelisted helpers with bound
  params; no raw `req.body/query/params` reaches SQL.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; CSRF tokens
  present on all state-changing forms; the only `<%-` sink (`renderedContent`) is
  server-sanitized; `target=_blank` links carry `rel="noopener noreferrer"` +
  scheme check; login timing-oracle and `entityId == null` coercion fixes intact.

### Test coverage gaps closed
- `tests/hpp.test.js` extended with regression cases asserting the `projects.js`
  update route now surfaces the specific "Invalid budget amount" / "Invalid amount
  spent" flash (not the generic error) and redirects to the edit page for malformed
  `budget`/`spent`.
- `tests/hpp.test.js` extended with fail-closed HPP regression cases asserting
  `vendors.js` create (`contract_start[]`) and update (`contract_end[]`) reject
  array payloads with an error flash.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 300 passed / 300 total (added 4 regression cases).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-19 (twelfth pass)

A twelfth independent pass (full source re-read + 2 parallel review agents: one
over the route/middleware write surface, one over all EJS views + `public/js`)
found no SQL injection, IDOR, CSRF, XSS, auth, or TOCTOU defects. The one class
of genuine, previously-unaddressed defects was a **fail-open inconsistency** on
several CREATE paths: malformed (but non-empty) optional numeric/date fields
were silently stored as NULL/0 instead of being rejected, contradicting the
codebase's established "malformed non-empty input must fail closed" convention
already enforced on the sibling UPDATE paths.

### Fixes applied
- **`assets.js` create — malformed `purchase_date` / `warranty_expiry` silently
  stored NULL (LOW).** A present-but-unparseable date fell through `safeDate()`
  to NULL, discarding user input without feedback. Now rejects with an error
  flash, mirroring the update path.
- **`assets.js` create — malformed `purchase_price` silently stored NULL (LOW).**
  A present-but-unparseable price (e.g. `100abc`) was dropped to NULL. Now
  fails closed, mirroring the update path.
- **`projects.js` create — malformed `budget` silently coerced to 0 (LOW).**
  `safePositiveFloat(budget, 0)` turned `"abc"` into a stored budget of 0. Now
  uses an out-of-band sentinel to distinguish empty (allowed) from malformed
  (rejected), mirroring the update path.
- **`vendors.js` create — malformed `contract_start` / `contract_end` silently
  stored NULL (LOW).** Same date fall-through as assets. Now rejects malformed
  present values.
- **`vendors.js` update — `_resolveClearableDate` silently wiped a stored date
  to NULL on an unparseable present value (LOW).** Editing an unrelated field
  with a corrupt/polluted date payload could destroy a legitimate stored
  contract date. The helper now returns `{ error: true }` for an unparseable
  present value (empty string still clears to NULL, as intended).

### Defense-in-depth (consistency) additions
- **`views/*/show.ejs` mailto: links (LOW, defense-in-depth).** The three
  `mailto:` links (vendors, tickets, staff) rendered the stored email into an
  `href` without the scheme/format guard used by the sibling website link.
  Server-side `isValidEmail` already gates writes, so this is not exploitable,
  but for consistency `isValidEmail` is now exposed to `res.locals` and each
  link only renders as an anchor when the value validates (otherwise plain
  text).

### False positives / non-defects reconfirmed
- No raw `req.body/query/params` reaches SQL (all via parameterized statements /
  `safeQueryValue`); every state-changing form carries `_csrf`; the only `<%-`
  interpolation remains the `sanitize-html`-cleaned `renderedContent`.

### Test coverage gaps closed
- `tests/hpp.test.js` extended with fail-closed regression cases for the assets
  create (price/date), projects create (budget), and vendors create (contract
  dates) paths.
- `tests/vendors.test.js` `resolveClearableDate` case updated to assert a
  malformed present date now returns `{ error: true }` (fail closed) rather than
  clearing to NULL.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 296 passed / 296 total (added 6 create-path fail-closed
  regression cases; updated 1 update-path case).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-19 (eleventh pass)

An eleventh independent pass (4 parallel review agents over the auth/security
middleware + core files, route modules batch 1, route modules batch 2, and the
utils/templates surface, cross-checked against the prior 10 passes) found **no new
SQL injection, IDOR, CSRF, XSS, login brute-force, or error-leakage defects**.
However, it surfaced **4 genuine, previously-unaddressed defects** in the
fail-closed validation and HPP-consistency classes that the prior passes had fixed
elsewhere but missed here. All four were fixed and regression-tested:

### Fixes applied
- **`assets.js` — `purchase_price` failed open on update (MEDIUM).** The update
  route passed `purchase_price` through `safePositiveFloat` (default `null`), so a
  blank or malformed price silently overwrote a legitimate stored price with `NULL`
  whenever any other field was edited. This is the exact fail-open bug pattern the
  `licenses.cost` (9th pass) and `projects.budget/spent` (2nd pass) fixes addressed,
  but `assets.js` was never given the same treatment. Now: an empty/omitted price
  preserves the stored value (read inside the transaction, TOCTOU-safe), while an
  invalid price is rejected with an "Invalid purchase price" flash (fail-closed).
- **`assets.js` — `purchase_date`/`warranty_expiry` failed open on update (MEDIUM).**
  The update route parsed these through `safeDate`, which returns `NULL` for any
  unparseable value, with no "present-but-invalid" rejection like the one added to
  `projects.js` (8th pass). Editing any other field while a date was cleared or
  malformed silently wiped the stored date. Now a present, non-empty date that fails
  to parse is rejected (fail-closed), while an empty date still falls back to the
  stored value — mirroring `projects.js`.
- **`audit.js` — self-audit of "viewed audit log" was silently dropped (MEDIUM).**
  The audit index route called `req.audit('read', 'audit_log', null, 'Viewed audit
  log')` to leave a detective trace of a compromised privileged account reading the
  full log. But `audit()` validates `entity` against `ALLOWED_ENTITY_TYPES`, which did
  not contain `'audit_log'`, so the call hit `console.error(...); return;` and never
  inserted a row — the intended control was completely non-functional. Added
  `'audit_log'` to `ALLOWED_ENTITY_TYPES` in `constants.js`.
- **`staff.js` / `tickets.js` — two write routes omitted HPP array rejection (LOW).**
  Every other write route rejects HTTP parameter pollution arrays, but `staff.js`
  `PUT /:id/reset-password` (admin resetting another user's password — the most
  security-sensitive route) and `tickets.js` `PUT /:id/status` read the relevant
  fields through `safeQueryValue`, which collapses `field[]=a&field[]=b` to its first
  element (fail-open). Added fail-closed array-rejection loops matching the codebase
  pattern. Practical impact is low (the collapsed value must still pass validation,
  and authorization is unaffected), but both closed the last remaining gaps in the
  adopted fail-closed HPP model.

### False positives / non-defects reconfirmed
- All SQL dynamic queries still flow through the whitelisted helpers
  (`buildFilters`/`addSearch`/`safeSort`/`quoteColumn`/`countQuery`/`selectQuery`) with
  bound params; no raw-concatenation injection.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; PII redaction for
  non-privileged staff viewers intact.
- KB `renderedContent` remains the only unescaped (`<%-`) sink and is server-sanitized;
  `_csrf` present on all state-changing forms; `target=_blank` links carry
  `rel="noopener noreferrer"` + scheme check.
- Login timing-oracle, `entityId == null` coercion, and `recalcProjectProgress` guards
  all intact.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 290 passed / 290 total (added 7 regression cases: assets malformed
  `purchase_price` update fail-closed, assets malformed `purchase_date` update
  fail-closed, staff `reset-password` HPP on `new_password` + `current_password`,
  tickets `status` HPP, audit `audit_log` self-trail now persists).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-19 (tenth pass)

A tenth independent pass (full re-read of `auth.js`, `dashboard.js`,
`reports.js`, both middleware modules, and `utils.js`/`constants.js`, plus a
parallel subagent over all 13 route modules and `models/database.js`/`seed.js`)
found **no new SQL injection, IDOR, CSRF, XSS, login brute-force, or
error-leakage defects**. The codebase's defense-in-depth model remains
internally consistent. One genuine, previously-unaddressed **over-fetch /
exposure-surface issue** was fixed and regression-tested:

### Fixes applied
- **`dashboard.js` — `licenseAlerts` over-fetched the sensitive `license_key`
  column (LOW).** The dashboard query used `SELECT * FROM licenses`, loading the
  encrypted `license_key` of every expiring license into the shared,
  cache-resident dashboard data object that is later spread into the rendered
  template context. The template only reads `licenseAlerts.length`, so the key
  was never rendered — but it widened the credential-exposure surface of the
  cached dashboard payload (and of any future handler that serializes the same
  `shared` object). Changed to `SELECT id, software_name, vendor, expiry_date`
  so the secret column is never loaded into the dashboard data object.
  Verified: no template consumes any other license column on the dashboard.

### False positives / non-defects reconfirmed
- `auth.js` login re-verified: constant-time `bcrypt.compare` runs before the
  oversized-password early-return and before lockout checks, so the
  username-enumeration timing oracle stays closed; HPP array rejection on
  `username`/`password` intact; session regenerated on login/password change.
- `reports.js` `resolveReportPeriod` HPP guard (array rejected before
  `safeQueryValue`) and `middleware/audit.js` `entityId == null` coercion fix
  both intact.
- All 13 route modules re-verified clean for SQL injection (whitelisted helpers
  + bound params), IDOR/TOCTOU (ownership rechecked inside `db.transaction`),
  CSRF, date/number strictness, audit coverage, and error leakage.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 284 passed / 284 total.

## Verdict

**No genuine security or correctness defects found.** The codebase is in strong shape
and follows a consistent, defense-in-depth security model. The recommendations below
are observations and by-design clarifications rather than required fixes.

---

## Review cycle 2026-07-19 (ninth pass)

A ninth independent pass (4 parallel review agents over the auth/security
middleware + core files, all 11 route modules, the EJS template + frontend
layer, and the test suite, cross-checked against the prior 8 passes) found **no
new SQL injection, IDOR, CSRF, XSS, login brute-force, or error-leakage
defects**. The codebase's defense-in-depth model remains internally consistent.
One genuine, previously-unaddressed **fail-open consistency bug** and one **HPP
gap** were fixed and regression-tested:

### Fixes applied
- **`licenses.js` — `cost` field failed open on invalid input (MEDIUM).** Both
  the create (`safePositiveFloat(cost)` → default `null`) and update
  (`safePositiveFloat(cost)` → default `null`) routes silently stored `NULL`
  when a malformed/garbage cost was submitted, wiping a legitimate stored cost
  with no error. This is exactly the fail-open bug pattern the `projects.js`
  `budget`/`spent` fix addressed (using an `Infinity` sentinel to distinguish
  "not submitted" from "submitted invalid") — but `cost` was never given the
  same treatment. Now:
  - create: absent/empty cost → `0`; invalid cost → reject with "Invalid cost
    amount" flash (fail-closed).
  - update: absent/empty cost → preserve the stored value (read inside the
    transaction, TOCTOU-safe, mirroring `_resolveSeats`); invalid cost → reject
    with flash (fail-closed) before the transaction.
- **`tickets.js` — `satisfaction_rating` omitted HPP array rejection (LOW).**
  Every other write route rejects HTTP parameter pollution arrays; the
  `PUT /:id/satisfaction` handler collapsed `satisfaction_rating[]=a&...=b`
  via `safeInt(safeQueryValue(...), 0)` to its first element (fail-open). Added
  an explicit `Array.isArray` rejection before `safeQueryValue`, matching the
  codebase's adopted fail-closed HPP pattern.

### False positives / non-defects reconfirmed
- Middleware (`auth.js`, `audit.js`) confirmed not to read raw `req.body/
  query/params`; HPP defense correctly lives at the route layer.
- All 11 route modules re-verified clean for SQL injection (whitelisted helpers
  + bound params), IDOR/TOCTOU (ownership rechecked inside `db.transaction`),
  CSRF, date/number strictness, audit coverage, and error leakage.
- All 42 EJS templates re-verified: only `article.renderedContent` is unescaped
  (server-sanitized); every state-changing form carries `_csrf`;
  `target=_blank` is scheme-checked + `rel="noopener noreferrer"`; `app.js`
  uses only `textContent` (no `innerHTML`/eval). No XSS/CSRF/link defects.
- `safeQueryValue`/`safeId`/`safeInt`/`safePositiveFloat` unchanged and correct;
  login timing-oracle fix and `entityId == null` coercion fix intact.

### Test coverage gaps closed (observations, not defects)
- The prior test suite concentrated on HPP unit rejection and helper functions;
  authorization at route level and transaction/TOCTOU rollback were not
  exercised (handlers mock the DB, so `db.transaction` is a passthrough). Not
  changed here, but flagged for a future integration pass (a `reports.test.js`/
  `audit.test.js`-style real-DB harness would cover it).
- HPP coverage was sampled (1–2 fields per route), not exhaustive; the new
  `cost`/`satisfaction_rating` cases begin closing that.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 284 passed / 284 total (added 5 regression cases: licenses
  `cost` HPP create+update, licenses malformed `cost` create+update fail-closed,
  tickets `satisfaction_rating` HPP).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-19 (eighth pass)

An eighth independent pass (2 parallel review agents over all route modules,
core files, middleware, utils, constants, and the test suite) found no SQL
injection, IDOR, CSRF, or XSS defects. The prior review history was re-verified
and the following genuine, previously-unaddressed correctness issues were fixed
and regression-tested:

### Fixes applied
- **`middleware/audit.js` — `entityId || null` falsy coercion (LOW).** The audit
  `INSERT` used `entityId || null`, which coerces a legitimate `entityId` of `0`
  to `NULL`, silently dropping the audit link for any entity whose row id is `0`.
  Autoincrement IDs start at 1 so live risk is nil, but it is a latent correctness
  bug. Changed to `entityId == null ? null : entityId` so `0` is preserved.
- **`utils.js` — `recalcProjectProgress` unguarded against invalid input (LOW).**
  The function called `_getProgressSelectStmt(db).get(projectId)` directly; an
  invalid `projectId` (e.g. `undefined`) makes `.get()` return `undefined`, and
  `row.total` then throws `TypeError`. Callers pass validated IDs today, but the
  helper now guards `Number.isInteger(projectId) && projectId > 0` and returns
  early when the project row is missing — fail-closed rather than crash-prone.
- **`projects.js` — malformed dates silently stored as NULL (MEDIUM).** The
  create and update routes passed `start_date`/`end_date` through `safeDate`,
  which returns `NULL` for any unparseable value, so a garbage date like
  `2026-13-45` was stored as `NULL` with only the ordering check. This is
  inconsistent with `changes.js` (`_resolveDateTimeField` errors on bad input)
  and `licenses.js` (strict). Now a present, non-empty date that fails to parse
  surfaces as an "Invalid start/end date" flash error, while empty input is still
  allowed to fall back to `NULL`.

### False positives / non-defects reconfirmed
- All 11 route modules re-verified clean for SQL injection, IDOR, CSRF, XSS,
  error leakage, race/TOCTOU, HPP guards (login/profile/password/CRUD all covered),
  and seed/production safety.
- `seed.js` transaction is atomic, so a mid-run failure cannot leave the DB
  half-seeded; re-seed on the same UTC day is safe because the `DELETE` at the top
  of the transaction removes prior rows before re-inserting.

### Test coverage updated
- `tests/audit.test.js` extended with a regression case asserting that
  `audit()` preserves a legitimate `entityId` of `0` (no falsy coercion to `NULL`).

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 279 passed / 279 total (added 1 audit regression case).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-19 (seventh pass)

A seventh independent pass (3 parallel review agents over all 11 route modules,
core files, middleware, utils, constants, and the test suite) found no SQL
injection, IDOR, CSRF, or XSS defects. The prior review history was re-verified
and the following genuine, previously-unaddressed issues were fixed and
regression-tested:

### Fixes applied
- **`vendors.js` — `name` field omitted from HPP array rejection (LOW-MEDIUM).**
  Every other write route rejects HTTP parameter pollution arrays, but the `name`
  field in both the create and update handlers was not included in the `_hppFields`
  array. A polluted `name[]=A&name[]=B` would silently collapse to `"A"` via
  `safeQueryValue`, bypassing the duplicate-name check. Added `name` to the HPP
  guard loop in both `POST /` and `PUT /:id`, matching the pattern used by all
  other write routes.
- **Delete audit messages lacked entity names (LOW).** The `assets.js`,
  `knowledge.js`, and `changes.js` delete routes logged generic audit messages
  (`"Deleted asset"`, `"Deleted article"`, `"Deleted change record"`) without
  including the entity name. This makes auditing less actionable. Changed each
  handler to fetch the entity inside the transaction and include its name in the
  audit details string (e.g. `"Deleted asset \"MacBook Pro 16\""`).

### False positives / non-defects reconfirmed
- All other modules re-verified clean for SQL injection, IDOR, CSRF, XSS,
  error leakage, race/TOCTOU, HPP guards, and seed/production safety.
- ESLint `no-unused-vars` and `no-shadow` bumped from `warn` to `error` for
  consistency with the project's strict approach.

### Test coverage updated
- `tests/hpp.test.js` extended with a regression case asserting that `vendors.js`
  `PUT /:id` rejects array payloads on the `name` field (fail-closed redirect
  + error flash).

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — all tests passing.
- `.env.example` contains only placeholders; no secrets committed.

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
- `npx jest` — 256 passed / 256 total.
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
## Review cycle 2026-07-18 (third pass)

A third independent pass (3 parallel review agents over the route modules, core
files, and auth/tests) found no SQL injection, IDOR, CSRF, or XSS defects. The
prior review history was re-verified and the following genuine, previously
unaddressed issues were fixed and regression-tested:

### Fixes applied
- **`assets.js` — create/update routes omitted HPP array rejection (LOW).** Every
  other write route (`vendors`, `licenses`, `knowledge`, `tickets`, `projects`,
  `changes`, `staff`) rejects HTTP parameter pollution arrays for free-text body
  fields, but `assets.js` collapsed `name[]=a&name[]=b` via `safeQueryValue` to
  its first element (fail-open). Added a fail-closed array-rejection loop over
  every text body field in both `POST /` and `PUT /:id`, matching the
  `licenses.js`/`vendors.js` pattern.
- **`staff.js` — create/update routes omitted HPP array rejection (LOW).** The
  update route's `role` field (and `email`, `first_name`, etc.) was collapsed by
  `safeQueryValue` rather than rejected. Escalation was still blocked by the
  `requireAdmin`/in-transaction recheck guards, but the omission was inconsistent
  with the rest of the codebase. Added fail-closed array-rejection loops in both
  `POST /` and `PUT /:id`.
- **`seed.js` — auto-generated passwords printed to stdout (LOW-MEDIUM).** Seed
  already refuses to run in production, but generated credentials were echoed to
  stdout where they can leak into aggregated logs. Credentials are now only
  printed when `SEED_VERBOSE=1` is set, or when the operator supplied their own
  passwords via `SEED_ADMIN_PASSWORD`/`SEED_PASSWORD` (in which case the value is
  already known). Otherwise a non-disclosing message is shown.

### False positives rejected
- **`app.js` CSRF `httpOnly: true` cookie (agent-flagged HIGH):** not a defect.
  `csrf-csrf`'s `doubleCsrf` uses a two-cookie model; the token is delivered via
  `req.csrfToken()` / `res.locals.csrfToken`, so `httpOnly` on the secret cookie
  is the recommended, correct configuration.
- **Login rate limiting (agent-flagged):** handled by the per-account/IP lockout
  maps in `routes/auth.js`; the global write limiter excludes `/login` by design.
- **In-memory lockout map across processes:** a known deployment limitation, not
  addressed here (out of scope for a single-instance internal tool).

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 256 passed / 256 total (added `tests/hpp.test.js` asserting that
  array payloads on asset/staff create+update fall back to a redirect with an
  error flash, rather than being silently collapsed).

## Tooling

- `npx eslint .` — clean (exit 0).
- `npx jest` — 256 passed / 256 total.
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-18 (fourth pass)

A fourth independent pass (2 parallel review agents over the route modules,
core files, `app.js`/`auth.js`/`seed.js`, and the test suite) found no SQL
injection, IDOR, CSRF, or error-leakage defects. The prior review history was
re-verified and the following genuine, previously unaddressed issues were fixed
and regression-tested:

### Fixes applied
- **`auth.js` — profile & password-change routes omitted HPP array rejection
  (MEDIUM).** Every other self-service and privileged write route rejects HTTP
  parameter pollution arrays, but `PUT /profile` and `PUT /profile/password`
  read `first_name`/`last_name`/`email`/`phone`/`current_password`/
  `new_password`/`confirm_password` through `safeQueryValue`, which collapses an
  array to its first element (fail-open). A polluted `email[]=a&email[]=b` was
  silently reduced to `a` and the UPDATE proceeded. Added a fail-closed
  array-rejection loop over all text body fields in both handlers, matching the
  `staff.js`/`assets.js` pattern. These are the most security-sensitive
  (account) write routes, so the omission was the highest-priority gap.
- **`seed.js` — operator-supplied secrets echoed to stdout (LOW).** The code
  claimed credentials were only printed with `SEED_VERBOSE=1`, but the branch
  `(!adminIsGenerated && !staffIsGenerated)` also printed plaintext
  admin/staff passwords whenever *both* `SEED_ADMIN_PASSWORD` and `SEED_PASSWORD`
  were supplied via env — i.e. exactly the prod-like case where the value may
  live in CI secrets and be captured by aggregated logs. Now only
  auto-generated credentials are disclosed, and only when `SEED_VERBOSE=1`.

### False positives / non-defects reconsidered
- **`app.js` `writeLimiter` prefix list** omits `/audit` and `/reports`; these
  are privileged read/export routes, low risk. Noted as a minor hardening gap
  but not changed (out of scope; no exploitable impact).
- **`seed.js` shared staff password** across 5 seeded accounts is a documented
  seeding convenience, not a code defect.
- **`app.js` error handlers, `middleware/auth.js`, `middleware/audit.js`,
  `models/database.js`, `utils.js`, `constants.js`** re-verified clean for SQL
  injection, error leakage, session fixation, audit allowlisting, and injection
  safety.

### Test coverage gap closed
- `tests/hpp.test.js` previously covered only `assets` and `staff` create/update
  HPP rejections. It now also asserts that `auth.js` `PUT /profile` and
  `PUT /profile/password` reject array payloads on `email`, `phone`, and
  `new_password` (fail-closed redirect + error flash).

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 259 passed / 259 total (added 3 `auth` HPP regression cases).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-18 (fifth pass)

A fifth independent pass (2 parallel review agents over all route modules,
core files, `app.js`/`auth.js`/`seed.js`, and the test suite) found no new SQL
injection, IDOR, CSRF, or error-leakage defects. The prior review history was
re-verified and the following genuine, previously-unaddressed issues were fixed
and regression-tested:

### Fixes applied
- **`auth.js` — login username-enumeration timing oracle (MEDIUM).** The
  password `> MAX_PASSWORD_BYTES` early-return executed *before* the constant-time
  `bcrypt.compare` that was specifically added to prevent username enumeration.
  For a non-existent account with an oversized password the handler returned
  instantly, while an existing account ran the full ~200–300 ms compare —
  leaking which usernames exist via response time. The byte-length reject was
  moved to *after* the `bcrypt.compare` call (which still runs against
  `DUMMY_HASH` for unknown users), so the expensive comparison always executes
  regardless of whether the account exists. The reject remains fail-closed (an
  oversized password cannot match, since bcrypt caps input at 72 bytes).
- **`projects.js`, `changes.js`, `knowledge.js` — missing HPP array rejection
  (LOW-MEDIUM).** Every other privileged write route rejects HTTP parameter
  pollution arrays for free-text body fields, but these three modules' create
  and update handlers (plus `projects.js` task/member add handlers) read fields
  through `safeQueryValue`, which collapses arrays to the first element
  (fail-open). Added fail-closed array-rejection loops over every body field in
  each affected handler, matching the `assets.js`/`staff.js`/`licenses.js`/
  `vendors.js`/`auth.js` pattern. Low-severity (non-destructive) but closes the
  last remaining gap in the codebase's HPP defense.

### False positives / non-defects reconsidered
- **`app.js` `reportLimiter` prefix list** omits the `/reports` index GET and
  `/reports/assets`. The index is a non-data landing page and `/reports/assets`
  is already covered by the `['/tickets','/assets','/staff']` prefix list, so
  there is no un-limited expensive aggregation endpoint. Left unchanged.
- **`knowledge.js` `GET /knowledge/:id` view counter** (CSRF-exempt GET with a
  server-side side effect) and **`tickets.js` `GET /tickets/:id` read without
  ownership check** were re-confirmed as intentional, documented behavior
  (cross-team collaboration; PII redacted for non-privileged viewers). Not
  defects.
- All other modules re-verified clean for SQL injection, IDOR, CSRF, XSS,
  error leakage, race/TOCTOU, and seed/production safety.

### Test coverage gaps closed
- `tests/hpp.test.js` extended with regression cases asserting that
  `projects.js` (project/task create+update, member add), `changes.js`
  (create+update), and `knowledge.js` (create+update) reject array payloads with
  a fail-closed redirect + error flash.
- Added `tests/auth-login.test.js` asserting the login handler still invokes
  `bcrypt.compare` (against `DUMMY_HASH`) for a non-existent user with an
  oversized password, locking in the timing-oracle fix.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 270 passed / 270 total (added 11 HPP regression cases + 2 login
  timing-oracle regression cases).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-18 (sixth pass)

A sixth independent pass (full source re-read + a dedicated template/EJS audit
agent over all 42 views and `public/js/app.js`, plus targeted greps confirming
no raw `req.body/query/params` values reach SQL) found no SQL injection, IDOR,
CSRF, XSS, auth, or TOCTOU defects. The codebase's defense-in-depth model is
internally consistent. The following genuine, previously-unaddressed gaps were
closed (no exploitable defects were outstanding — these are consistency /
defense-in-depth additions):

### Fixes applied
- **`app.js` — write-rate backstop omitted `/audit` and `/reports` (LOW).**
  Prior passes noted these privileged export/aggregation mounts were not covered
  by the global `writeLimiter` mount list (they relied solely on their own
  per-route limiters). Added both to the write-limited mount list so state-
  changing calls on those mounts are uniformly throttled.
- **`auth.js` — login route omitted fail-closed HPP rejection (LOW).** Every
  other write route rejects HTTP parameter pollution arrays; the login handler
  read `username`/`password` through `safeQueryValue`, which silently collapses
  a `username[]=a&username[]=b` array to its first element (fail-open). The
  timing-oracle defense already neutralized any exploitation, but the omission
  was inconsistent with the rest of the codebase. Added an explicit array
  rejection before `safeQueryValue`, matching the adopted pattern.

### False positives / non-defects reconfirmed
- **All 42 EJS templates**: the only dynamic (`<%-`) interpolation is
  `article.renderedContent`, which is server-side sanitized via `sanitize-html`;
  every state-changing form carries `_csrf`; `target=_blank` links use
  `rel="noopener noreferrer"` + a scheme regex. No XSS/CSRF/link defects.
- **`public/js/app.js`**: no injection of unsanitized DOM/user input; CSRF token
  handling is correct.
- No raw `req.body/query/params` values flow into SQL (grep-verified).

### Test coverage gaps closed
- `tests/auth-login.test.js` extended with two cases asserting the login handler
  fail-closed rejects `username`/`password` array payloads (redirect to
  `/login` + error flash, and `bcrypt.compare` is never reached).

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 272 passed / 272 total (added 2 login HPP regression cases).
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-07-26 (forty-sixth pass)

A forty-sixth re-read of all route modules found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One structural bug in the projects
update handler was found and fixed:

### Fixes applied
- **`projects.js:480` — success `res.redirect()` outside `try` block caused
  `ERR_HTTP_HEADERS_SENT` on error paths (HIGH).** The success redirect was
  placed **after** the `try/catch` block. All specific error paths
  (`NOT_FOUND`, `OWNER_NOT_AVAILABLE`, `INVALID_BUDGET`/`INVALID_SPENT`)
  called `return res.redirect(...)` inside the `catch` block, which exited the
  `catch` but then fell through to line 480, attempting a second
  `res.redirect()`. Express silently logs `ERR_HTTP_HEADERS_SENT` in this
  scenario, leaving the client with the first redirect's response but wasting
  server resources and spamming logs. All other route modules (assets,
  tickets, licenses, vendors, changes, staff) place the success redirect
  **inside** the `try` block. The fix moves `res.redirect()` into the `try`
  block (after `invalidateDashboardCache()`) and adds a fallback redirect to
  `/edit` in the generic-error branch of the `catch`.
  - New regression file: `tests/projects_update.test.js` (2 cases — NOT_FOUND
    and generic error each assert exactly one `res.redirect()` call).

### Test coverage gaps closed
- `tests/projects_update.test.js` — dedicated test file verifying the
  `projects` update handler never double-redirects on error paths.

### Tooling
- `npx eslint .` — clean (exit 0).
- `npx jest` — 354 passed / 354 total (2 new projects_update regression cases).

## Review cycle 2026-07-31 (forty-seventh pass)

A forty-seventh pass (full re-read of `app.js`, routes, middleware, models,
tests; fresh `npm audit`) found **no new SQL injection, IDOR, CSRF, XSS, auth,
or error-leakage defects.** The production audit gate in
`.github/workflows/ci.yml` (`npm audit --production --audit-level=high`) was
**failing**: 6 high-severity production advisories through two chains —
`ejs@3.1.10` → `jake` → `filelist` → `minimatch` → `brace-expansion` (regex
ReDoS in `brace-expansion`), and `postcss@8.5.15` via `sanitize-html` (Path
Traversal / source-map disclosure, GHSA-r28c-9q8g-f849).

### Fixes applied
- **`ejs` `^3.1.10` → `^6.0.1` (HIGH production advisory).** ejs 6 ships with
  **zero runtime dependencies**, removing the entire `jake`/`filelist`/
  `minimatch`/`brace-expansion` chain at its root. Verified ejs 6 still exposes
  `ejs.renderFile` and the Express-compatible `ejs.__express` alias
  (`lib/cjs/ejs.js`), so the `res.render()` view engine contract is unchanged.
  The full Jest suite (which renders every EJS template) passes unchanged.
- **`postcss` patched in lockfile via `npm audit fix` (HIGH production
  advisory).** `sanitize-html` declares `postcss ^8.3.11`, so `npm audit fix`
  resolves to the patched `postcss@8.5.25` with no source change. `sanitize-html`
  was **not** bumped to 2.17.6 on purpose: 2.17.6 switches to
  `htmlparser2@12`, which is ESM-only and crashes Jest's CommonJS runtime
  (`Cannot use import statement outside a module` in `tests/hpp.test.js` and
  `tests/knowledge.test.js`). Keeping `^2.17.4` avoids that, and the patched
  postcss satisfies the advisory.
- **`app.js` error handler — body-parser errors misreported as 500 (LOW).**
  `express.json({ limit: '1mb' })` / `express.urlencoded` reject oversized or
  malformed bodies with `err.status` = 413/400, but the final error handler
  hard-coded 500, so oversized payloads and malformed JSON produced 500
  "Something went wrong" (and a spurious stack-log line) instead of an accurate
  4xx. The handler now honors `err.status`/`err.statusCode` clamped to a valid
  `400–599` integer, returning 413 for `entity.too.large` and 400 for
  `entity.parse.failed`. Verified end-to-end with a live Express smoke test
  (400/413 observed). Production still returns the generic message; only the
  status code changes.
- **`app.js` health check — stale comment removed (cleanup).** The comment at
  `GET /health` claimed the handler re-set `Cache-Control`/`Surrogate-Control`,
  but it does not (the global middleware at `app.js:396-408` already sets
  `no-store` for every response). The comment contradicted the code.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 356 passed / 356 total (18 suites).
- `npm audit --production --audit-level=high` — **exit 0** (CI gate now passes).
- Remaining `npm audit` findings are **dev-only** (20 high through the
  jest/@babel chain, e.g. `braces`, `send`, `path-to-regexp`); they are outside
  the CI production gate and were left untouched to avoid a breaking Jest major
  upgrade with no production exposure.

## Review cycle 2026-07-31 (forty-eighth pass)

A forty-eighth independent pass (full source re-read of all 11 route modules,
both middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One documentation-inaccuracy fix
was applied:

### Fixes applied
- **`utils.js` — `safeQueryValue` comment was misleading (LOW).** The JSDoc
  claimed the helper "guards against HTTP parameter pollution (HPP)" but the
  function actually **collapses** arrays to their first element (a fail-open
  behavior). The real fail-closed HPP defense lives at the route layer via
  `rejectHppArrays()`, which runs *before* `safeQueryValue` on every write
  handler. Updated the comment to accurately describe the fail-open collapse
  behavior and to direct callers that need fail-closed HPP defense to use
  `rejectHppArrays()` instead.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- IDOR/TOCTOU ownership/role rechecks remain inside `db.transaction`; CSRF
  tokens on all state-changing forms; the only `<%-` sink (`renderedContent`)
  is server-sanitized; `target=_blank` links carry `rel="noopener noreferrer"`
  + scheme check; login timing-oracle, `entityId == null` coercion,
  `recalcProjectProgress` guards, dashboard PII over-fetch (explicit column
  lists), and the `audit_log` self-trail fix all intact.
- Every write route rejects HPP arrays on all body fields; every numeric/date
  field is fail-closed on malformed present values. Consistent across all routes.
- `npm audit --production --audit-level=high` — exit 0 (no production
  vulnerabilities).
- `npm run lint` — clean (exit 0).
- `npm test` — 359 passed / 359 total (18 suites).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 359 passed / 359 total (18 suites).
- `npm audit --production --audit-level=high` — **exit 0**.
- `.env.example` contains only placeholders; no secrets committed.
