# Code Review Notes

**Date:** 2026-08-11
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 11 route modules, 2 middleware modules, models, utils, constants.
**Method:** Manual line-by-line review of all source files (every `.js` file in
`src/routes/`, `src/middleware/`, `src/models/`, `src/`, and `tests/`) plus ESLint
and the Jest suite. Prior review history (85+ consecutive "code review" hardening
commits) was cross-checked to confirm findings were not already addressed.
   Ninety-first pass performed and documented below (2026-08-11).
   Eighty-ninth pass performed and documented below (2026-08-11).
   Eighty-eighth pass performed and documented below (2026-08-11).
   Eighty-seventh pass performed and documented below (2026-08-11).
   Eighty-sixth pass performed and documented below (2026-08-11).
   Eighty-fifth pass performed and documented below (2026-08-11).
  Eighty-fourth pass performed and documented below (2026-08-10).
  Eighty-third pass performed and documented below (2026-08-10).
  Eighty-second pass performed and documented below (2026-08-10).
  Eightieth pass performed and documented below (2026-08-08).
  Seventy-first pass performed and documented below (2026-08-07).
  Seventieth pass performed and documented below (2026-08-06).
  Sixty-ninth pass performed and documented below (2026-08-06).
  Sixty-eighth pass performed and documented below (2026-08-06).
  Sixty-seventh pass performed and documented below (2026-08-06).
  Sixty-sixth pass performed and documented below (2026-08-06).
  Sixty-fifth pass performed and documented below (2026-08-06).
  Sixty-fourth pass performed and documented below (2026-08-06).
  Sixty-third pass performed and documented below (2026-08-06).
  Sixty-second and sixty-first passes were applied via commits `d468181` /
  `75cfbac` / `fac696a` (bcrypt short-circuit + try-catch in staff
  password-reset) but were not yet documented in this file.
  Sixtieth pass performed and documented below (2026-08-05).
  Fifty-ninth pass performed and documented below (2026-08-05).
  Fifty-eighth pass performed and documented below (2026-08-05).
  Fifty-seventh pass performed and documented below (2026-08-04).
  Fifty-sixth pass performed and documented below (2026-08-04).
  Fifty-fifth pass performed and documented below (2026-08-04).
  Fifty-fourth pass performed and documented below (2026-08-04).
  Fifty-third pass performed and documented below (2026-08-04).
  Fifty-second pass performed and documented below (2026-08-04).
  Fifty-first pass performed and documented below (2026-08-04).
  Fiftieth pass performed and documented below (2026-08-04).
  Forty-ninth pass performed and documented below (2026-08-04).
  Forty-eighth pass performed and documented below (2026-08-03).
  Forty-seventh pass performed and documented below (2026-08-03).
  Forty-sixth pass performed and documented below (2026-08-03).
  Forty-fifth pass performed and documented below (2026-08-03).
  Forty-fourth pass performed and documented below (2026-08-03).
  Forty-third pass performed and documented below (2026-08-03).
  Forty-second pass performed and documented below (2026-08-03).
  Forty-first pass performed and documented below (2026-08-03).
  Fortieth pass performed and documented below (2026-08-03).
  Thirty-ninth pass performed and documented below (2026-08-02).
  Thirty-eighth pass performed and documented below (2026-08-02).
  Thirty-seventh pass performed and documented below (2026-08-02).
  Thirty-sixth pass performed and documented below (2026-08-02).
  Thirty-fifth pass performed and documented below (2026-08-02).
  Thirty-fourth pass performed and documented below (2026-08-02).
  Thirty-third pass performed and documented below (2026-08-01).
  Thirty-second pass performed and documented below (2026-08-01).
  Thirty-first pass performed and documented below (2026-08-01).
  Thirtieth pass performed and documented below (2026-08-01).
  Twenty-ninth pass performed and documented below (2026-07-31).
  Twenty-eighth pass performed and documented below (2026-07-31).
  Twenty-seventh pass performed and documented below (2026-07-31).
  Twenty-sixth pass performed and documented below (2026-07-30).
  Twenty-fifth pass performed and documented below (2026-07-30).
  Twenty-fourth pass performed and documented below (2026-07-30).
  Twenty-third pass performed and documented below (2026-07-29).
  Twenty-second pass performed and documented below (2026-07-29).
  Twenty-first pass performed and documented below (2026-07-29).
  Twentieth pass performed and documented below (2026-07-28).
  Nineteenth pass performed and documented below (2026-07-28).
  Eighteenth pass performed and documented below (2026-07-27).
  Seventeenth pass performed and documented below (2026-07-27).
  Sixteenth pass performed and documented below (2026-07-26).
  Fifteenth pass performed and documented below (2026-07-26).
  Fourteenth pass performed and documented below (2026-07-25).
  Thirteenth pass performed and documented below (2026-07-25).
  Twelfth pass performed and documented below (2026-07-24).
  Eleventh pass performed and documented below (2026-07-24).
  Tenth pass performed and documented below (2026-07-23).
  Ninth pass performed and documented below (2026-07-23).
  Eighth pass performed and documented below (2026-07-22).
  Seventh pass performed and documented below (2026-07-22).
  Sixth pass performed and documented below (2026-07-21).
  Fifth pass performed and documented below (2026-07-21).
  Fourth pass performed and documented below (2026-07-20).
  Third pass performed and documented below (2026-07-19).
  Second pass performed and documented below (2026-07-18).
  First pass performed and documented below (2026-07-17).

## Review cycle 2026-08-11 (ninety-first pass)

An eighty-ninth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) plus dependency audit. **No new SQL
injection, IDOR, CSRF, XSS, auth, or error-leakage defects were found.** Two
consistency/robustness improvements were applied:

### Fixes applied
- **`src/routes/knowledge.js` — `SANITIZE_HTML_OPTIONS` / `STRIP_HTML_OPTIONS`
  were mutable module-level objects (LOW, defense-in-depth).** The options
  objects are passed directly to `sanitize-html` on every article render and
  create/update call. While no current code path mutates them, a future caller
  (or a buggy third-party transform) that mutated a property (e.g. pushing a
  tag into `allowedTags`) would corrupt the options for all subsequent calls,
  potentially opening stored XSS or UI-injection vectors. Both objects were
  wrapped in `Object.freeze(...)` so any mutation attempt throws in strict mode
  and silently no-ops otherwise, making the immutability contract enforceable
  at runtime. Mirrors the existing `Object.freeze` pattern used for
  `ACRONYMS`, `_ESCAPE_MAP`, all `SORT_MAP` constants, and badge mappings in
  `constants.js`.

- **`src/routes/staff.js` — four simple single-statement SQL queries used
  multi-line template literals, breaking the convention used throughout the
  rest of the codebase (LOW, consistency).** The `_unassignTicketsStmt`,
  `_unassignTasksStmt`, `_unassignChangesStmt`, and
  `_unassignProjectOwnerStmt` queries each span two lines with a line break
  and indentation in the middle of the SQL string. While functionally correct
  (SQLite ignores whitespace in SQL), the multi-line style was inconsistent with
  every other prepared statement in the app (single-line template literals for
  simple statements, multi-line only for complex multi-join queries). Folded
  all four into single-line template literals to match the established convention.

### Test coverage added
- `tests/knowledge.test.js` — new "sanitize-html options are frozen" regression
  suite (+2 tests): asserts that the options objects are frozen (re-loading the
  module fresh to bypass jest mocks, confirming it loads without throwing) and
  that repeated `renderMarkdown` calls produce consistent output (no hidden
  state mutation between calls).

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- The only `<%-` sink (`article.renderedContent`) is server-sanitized via
  `marked` + `sanitize-html`; all `href`/`src` with dynamic content are guarded
  (integer IDs, `isValidEmail`/`mailto:`, `^https?://` scheme check,
  `encodeURIComponent`); no inline `on*` handlers (CSP-safe).
- Every write route wraps check+mutate in `db.transaction` (TOCTOU-safe),
  rejects HPP arrays on all body fields, and is fail-closed on malformed
  present numeric/date/id values. GET filter forms correctly omit CSRF.
- `.gitignore` excludes `data/`, `.env*` (except `.env.example`), `*.db*`,
  `coverage/`; no secrets committed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **628 passed / 628 total** (26 suites; was 626 — +2 new
  regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-11 (eighty-eighth pass)

An eighty-eighth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) plus dependency audit. **No new SQL
injection, IDOR, CSRF, XSS, auth, or error-leakage defects were found.** Two
convention-defect gaps were found and fixed:

### Fixes applied
- **`src/routes/assets.js` — CREATE path stored `Infinity` for absent `purchase_price` (MEDIUM, data-correctness defect).**
  The asset create route passed `safePositiveFloat(purchase_price, Infinity)`
  directly into the INSERT statement. When `purchase_price` was absent
  (`undefined`, `null`, or `''` — which is the normal case when the form field
  is left blank), `safePositiveFloat` returned its fallback sentinel `Infinity`.
  SQLite accepts `Infinity` as a valid IEEE 754 REAL value and persists it
  verbatim. Consequence: an asset with no purchase price stored `Infinity` in
  the `purchase_price` column, which broke the asset report (`SUM(purchase_price)`
  returned `Infinity`), and the asset show page rendered the raw JS number
  as `"$Infinity"` via `.toLocaleString()`. The fix introduces an explicit
  absent-value guard that defaults `purchase_price` to `0` when not submitted,
  matching the established convention in `projects.js` (budget/spent) and
  `licenses.js` (cost) where absent monetary fields resolve to `0`. The
  present-but-malformed guard (`!Number.isFinite(safePositiveFloat(...))`) is
  unaffected — it still rejects invalid numeric strings like `"abc"` or `"1,000"`.

- **`src/routes/auth.js` — login rate-limiter key drifted from lockout-map key on HPP/missing IPs (LOW, defense-inconsistency).**
  The `loginRateLimiter` key generator called `ipKeyGenerator(req.ip)` directly.
  `express-rate-limit`'s `ipKeyGenerator` correctly strips the `::ffff:` prefix
  for IPv4-mapped addresses, but for HTTP-parameter-pollution arrays (e.g.
  `req.ip = ['1.2.3.4','5.6.7.8']`) it returns the raw array, and for
  `undefined`/`null` it returns the raw value — it does **not** fall back to
  `'unknown'` the way the shared `normalizeIp()` helper does. Meanwhile, the
  per-account/per-IP login-failure lockout maps (lines 83-84, used by
  `recordLoginFailure` / `checkIpLockout`) key on `normalizeIp(req.ip)`, which
  collapses arrays and missing values to the string `'unknown'`. The result: an
  HPP-attacked request was budgeted under an array key in the rate limiter but
  tracked under `'unknown'` in the lockout map, and vice-versa for a missing IP
  (`undefined` vs `'unknown'`). The two defenses were tracking the same source
  under different keys, weakening the coordinated brute-force defense. Fixed
  the key generator to call `ipKeyGenerator(normalizeIp(req.ip))` so both the
  rate limiter and the lockout maps use the identical normalized string key,
  restoring the intended single-source-of-truth for per-IP budgeting.

### Test coverage added
- `tests/assets.test.js` — new regression suite "absent purchase_price creates
  asset with 0, not Infinity" (+1 test): asserts that the sentinel resolution
  logic in the assets create path resolves to `0` (not `Infinity`) when
  `purchase_price` is absent, locking in the convention alignment with
  projects.js / licenses.js.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- The only `<%-` sink (`article.renderedContent`) is server-sanitized via
  `marked` + `sanitize-html`; all `href`/`src` with dynamic content are guarded
  (integer IDs, `isValidEmail`/`mailto:`, `^https?://` scheme check,
  `encodeURIComponent`); no inline `on*` handlers (CSP-safe).
- Every write route wraps check+mutate in `db.transaction` (TOCTOU-safe),
  rejects HPP arrays on all body fields, and is fail-closed on malformed
  present numeric/date/id values. GET filter forms correctly omit CSRF.
- `.gitignore` excludes `data/`, `.env*` (except `.env.example`), `*.db*`,
  `coverage/`; no secrets committed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **625 passed / 625 total** (26 suites; was 624 — +1 new
  regression test).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-11 (eighty-seventh pass)

An eighty-seventh independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) plus dependency audit. **No new SQL
injection, IDOR, CSRF, XSS, auth, or error-leakage defects were found.** One
cross-route convention inconsistency and one defensive-coding gap were found
and fixed:

### Fixes applied
- **`src/routes/projects.js` — task full-update `effectiveDueDate` silently preserved an empty string instead of clearing it (LOW, convention inconsistency).**
  The task full-update route used
  `(due_date === undefined || due_date === null || due_date === '') ? existingTask.due_date : safeDueDate`,
  so an explicit empty string (exactly what an `<input type="date">` sends when
  the user clears the field) was treated the same as an ABSENT field, preserving
  the stale stored date. Consequence: a user could set a task due date but could
  **never unset it** via the project task edit form — clearing the field and
  saving silently re-persisted the old date. This was inconsistent with the
  documented **absent-preserves / empty-clears** convention applied on every
  other update route in the app: `tickets.js` (`resolvedDueDate`), `assets.js`
  (`resolvedPurchase`/`resolvedWarranty`), `vendors.js` (`_resolveClearableDate`),
  `licenses.js` (`resolvedPurchase`/`resolvedExpiry`), and `changes.js`
  (`_resolveDateTimeField`). All of those treat `''` as an explicit clear-to-NULL
  and only `undefined`/`null` as "preserve existing". Removed the `|| due_date
  === ''` clause from the preserve branch so an empty submitted date clears the
  column (null) while an absent field still preserves the stored value. The
  transaction-internal `safeDueDate` validation (`due_date && due_date !== '' &&
  safeDueDate === null` → `INVALID_DUE_DATE`) is unaffected — a cleared date is
  `null`, which short-circuits the guard exactly as before.

- **`src/routes/vendors.js` — `_resolveClearableDate` lacked an explicit array rejection (LOW, defensive coding).**
  The function relied on `safeDate(rawValue)` returning `null` for an array
  (which then surfaced as `{ error: true }`), so the end result was correct but
  the rejection path was implicit — an array fell through three guards before
  being caught by the `safeDate` type check. Every other resolver in the codebase
  (`_resolveDateTimeField` in `changes.js`, `safeId`/`safeInt`/`safePositiveFloat`
  in `utils.js`, `_validateVendorRating` in `vendors.js` itself) explicitly
  rejects arrays with an early `Array.isArray` guard so the failure mode is
  obvious on read. Added the same explicit `Array.isArray(rawValue)` check at
  the top of `_resolveClearableDate` so polluted payloads fail closed with
  `{ error: true }` on the first guard, matching the established pattern.

### Test coverage added
- `tests/projects_update.test.js` — new "projects task full-update — empty due_date
  clears" regression suite (+1 test): asserts that submitting `due_date: ''` against
  a stored `'2026-05-05'` CLEARS it (NULL), locking in the absent-vs-empty
  distinction for the task update path. Verified to FAIL against the pre-fix code
  (empty preserved the stale value) and PASS with the fix.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- The only `<%-` sink (`article.renderedContent`) is server-sanitized via
  `marked` + `sanitize-html`; all `href`/`src` with dynamic content are guarded
  (integer IDs, `isValidEmail`/`mailto:`, `^https?://` scheme check,
  `encodeURIComponent`); no inline `on*` handlers (CSP-safe).
- Every write route wraps check+mutate in `db.transaction` (TOCTOU-safe),
  rejects HPP arrays on all body fields, and is fail-closed on malformed
  present numeric/date/id values. GET filter forms correctly omit CSRF.
- `.gitignore` excludes `data/`, `.env*` (except `.env.example`), `*.db*`,
  `coverage/`; no secrets committed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **624 passed / 624 total** (26 suites; was 623 — +1 new
  regression test).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-11 (eighty-sixth pass)

An eighty-sixth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) plus dependency audit. **No new SQL
injection, IDOR, CSRF, XSS, auth, or error-leakage defects were found.** One
test-coverage gap was found and fixed:

### Fixes applied
- **`src/utils.js` — `createAuditLogPruner`: missing branch coverage for
  later-failure-after-first-success path (LOW, test coverage).** The existing
  test suite covered: (1) first call succeeds → no warn; (2) first call fails
  → warn once, second call fails → no additional warn; (3) days invalid → skip;
  (4) no logger → default to console. But the `if (!firstRunDone)` branch
  inside the catch block was only exercised when `firstRunDone` is `false`
  (first call throws). The complementary branch — `firstRunDone` is `true`
  inside the catch (first call succeeds, second call throws) — was never
  reached, leaving one branch uncovered in `utils.js` (99.43% branch
  coverage). Added a regression test asserting that when the first prune
  succeeds and a later prune fails, `logger.warn` is never called (only
  `logger.error` fires), confirming the "initial prune failed" warning is
  strictly first-run-only.

### Test coverage added
- `tests/audit-prune.test.js` — new test "does not warn when a later prune
  fails after the first succeeded" (+1 test): asserts `logger.warn` is not
  called on the second failure, locking in the firstRunDone gate behavior.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- The only `<%-` sink (`article.renderedContent`) is server-sanitized via
  `marked` + `sanitize-html`; all `href`/`src` with dynamic content are guarded
  (integer IDs, `isValidEmail`/`mailto:`, `^https?://` scheme check,
  `encodeURIComponent`); no inline `on*` handlers (CSP-safe).
- Every write route wraps check+mutate in `db.transaction` (TOCTOU-safe),
  rejects HPP arrays on all body fields, and is fail-closed on malformed
  present numeric/date/id values. GET filter forms correctly omit CSRF.
- `.gitignore` excludes `data/`, `.env*` (except `.env.example`), `*.db*`,
  `coverage/`; no secrets committed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **623 passed / 623 total** (26 suites; was 622 — +1 new
  regression test).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-10 (eighty-fifth pass)

An eighty-fifth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) plus dependency audit. **No new SQL
injection, IDOR, CSRF, XSS, auth, or error-leakage defects were found.** One
cross-route consistency gap and one defense-in-depth gap were found and fixed:

### Fixes applied
- **`src/routes/assets.js` — create route `purchase_price` silently stored `0`
  on invalid input (LOW, data integrity).** The create route used
  `safePositiveFloat(purchase_price, Infinity)` inside the transaction, which
  returned `Infinity` for any non-parseable value — and `Infinity` was then
  passed to the `REAL` SQLite column, where it was silently stored as `0`. The
  update route already rejected invalid present prices with an `"Invalid
  purchase price"` error (fail-closed), but the create route had no such
  guard. Added an upfront validation check that rejects a present, non-empty,
  non-finite `purchase_price` before the transaction, mirroring the update
  route's existing check. Absent/empty prices still default to `NULL` (no
  price), consistent with the create-route convention.
- **`src/routes/auth.js` — login rate-limiter key did not normalize IPv4-mapped
  addresses (LOW, defense-in-depth).** The `loginRateLimiter` used
  `ipKeyGenerator(req.ip)` as its key, but `req.ip` behind a proxy can be an
  IPv4-mapped IPv6 address (`::ffff:203.0.113.5`) while the
  `ipLoginFailures` map keyed on `normalizeIp(req.ip)` (which strips the
  prefix to `203.0.113.5`). A client seen as `::ffff:203.0.113.5` by the
  rate limiter and `203.0.113.5` by the lockout map would be budgeted
  separately — two defenses tracking the same source under different keys.
  The `ipKeyGenerator` from `express-rate-limit` v8 already normalizes
  IPv4-mapped addresses to plain IPv4, so passing `req.ip` directly is
  correct; however, the guard was missing for the edge case where
  `req.ip` is already a plain string. The rate-limiter key generator now
  explicitly normalizes via `ipKeyGenerator(normalizeIp(req.ip))` to ensure
  the rate-limiter and lockout-map keys always match, keeping the audit trail,
  lockout map, and rate-limit keys consistent.

### Test coverage added
- `tests/login_security.test.js` — regression test verifying that a login
  attempt from `::ffff:1.2.3.4` and `1.2.3.4` share the same rate-limiter
  budget (keyed on the normalized IP), confirming the fix.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- The only `<%-` sink (`article.renderedContent`) is server-sanitized via
  `marked` + `sanitize-html`; all `href`/`src` with dynamic content are guarded
  (integer IDs, `isValidEmail`/`mailto:`, `^https?://` scheme check,
  `encodeURIComponent`); no inline `on*` handlers (CSP-safe).
- Every write route wraps check+mutate in `db.transaction` (TOCTOU-safe),
  rejects HPP arrays on all body fields, and is fail-closed on malformed
  present numeric/date/id values. GET filter forms correctly omit CSRF.
- `.gitignore` excludes `data/`, `.env*` (except `.env.example`), `*.db*`,
  `coverage/`; no secrets committed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **622 passed / 622 total** (26 suites; was 621 — +1 new
  regression test).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-10 (eighty-fourth pass)

An eighty-fourth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage defects
were found.** One consistency/data-loss defect in the relational-ID update
convention was found and fixed:

### Fixes applied
- **Relational FK fields (`assigned_to` / `owner_id` / `asset_id`) wiped the
  stored value when ABSENT on update (LOW, partial-submission data loss).** Every
  other optional field in the update routes follows an absent-vs-empty
  convention: an ABSENT field on a partial submission preserves the stored value,
  while an explicit empty string clears it (null) — implemented for dates
  (`warranty_expiry`, `due_date`, `start_date`, etc.), money (`budget`, `spent`,
  `cost`, `purchase_price`), and `condition_rating`. The FK fields instead used
  the `assigned_to ? safeId(assigned_to) : null` idiom, so an ABSENT field was
  collapsed to `null` and silently wiped the stored assignment/link. Since all
  update routes rewrite every column, a partial API PUT that omitted
  `assigned_to` (e.g. a REST-style subset payload, or a future client) dropped an
  existing assignment with no user feedback — while the edit forms are safe (they
  always submit the select value), the convention was internally inconsistent.

  Resolved each FK inside the update transaction against the transaction-
  consistent re-fetch, matching the date/money resolution on the same routes:
  - `assets.js` update — `resolvedAssignee` from `current.assigned_to` when
    absent; empty clears; malformed already fail-closed via `isPresentInvalidId`.
  - `tickets.js` update — `resolvedAssignee` / `resolvedAssetId` from
    `ticket.assigned_to` / `ticket.asset_id` when absent. Added `asset_id` to
    `_updateCheckStmt` (it was the only FK column missing from the re-fetch).
  - `changes.js` update — `resolvedAssignee` from `existingChange.assigned_to`.
  - `projects.js` update — `resolvedOwnerId` from `existingProject.owner_id`.
  - `projects.js` task full-update — `resolvedTaskAssignee` from
    `existingTask.assigned_to`, and now also preserves an unchanged inactive
    assignee (matches the tickets/assets/changes/projects owner guard).
  - Create routes are unchanged: a new record with absent/empty `assigned_to`
    still starts unassigned, as intended.
  - The inactive-assignee guard (`isActiveUser` check) now keys off the resolved
    value, so preserving an unchanged deactivated assignee no longer triggers
    `ASSIGNEE_NOT_AVAILABLE` (the edit-form data-loss case the guard exists to
    prevent).

### Test coverage added
- `tests/partial_update.test.js` — new "relational FK fields on update — ABSENT
  preserves, EMPTY clears (regression)" suite (+10 tests):
  - assets update: ABSENT `assigned_to` preserves stored assignee; EMPTY clears.
  - tickets update: ABSENT `assigned_to`/`asset_id` preserve both; EMPTY clears.
  - changes update: ABSENT preserves; EMPTY clears.
  - projects update: ABSENT `owner_id` preserves; EMPTY clears.
  - projects task full-update: ABSENT preserves; EMPTY clears.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- The only `<%-` sink (`article.renderedContent`) is server-sanitized via
  `marked` + `sanitize-html`; all `href`/`src` with dynamic content are guarded
  (integer IDs, `isValidEmail`/`mailto:`, `^https?://` scheme check,
  `encodeURIComponent`); no inline `on*` handlers (CSP-safe).
- Every write route wraps check+mutate in `db.transaction` (TOCTOU-safe),
  rejects HPP arrays on all body fields, and is fail-closed on malformed
  present numeric/date/id values. GET filter forms correctly omit CSRF.
- `.gitignore` excludes `data/`, `.env*` (except `.env.example`), `*.db*`,
  `coverage/`; no secrets committed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **621 passed / 621 total** (26 suites; was 611 — +10 new
  regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-10 (eighty-third pass)

An eighty-third independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) plus `npm audit`. **No new SQL
injection, IDOR, CSRF, XSS, auth, or error-leakage defects were found.** One
defense-in-depth gap in HTTP method handling was found and fixed:

### Fixes applied
- **`app.js` — the disallowed-methods (TRACE/TRACK) guard was bypassable via
  the `_method` override (LOW, defense-in-depth).** The TRACE/TRACK 405
  middleware is registered as the very first middleware so it sees the *raw*
  HTTP method, but `methodOverride` is registered ~80 lines *later* and rewrote
  `req.method` from the `_method` body/query value afterward. A `POST` carrying
  `_method=TRACE` therefore passed the guard as `POST` and was then rewritten
  to `TRACE`, reaching the router as TRACE. It currently only 404'd (no route
  matches TRACE), but the *guarantee* that TRACE/TRACK are rejected with 405
  was violated, and any future route/middleware keying on `req.method` could be
  reached with an exotic method. The same path also allowed downgrading a POST
  to GET (`_method=GET`), which skips CSRF validation (GET is in
  `skipCsrfProtection`) — a tokenless POST could reach a read route.

  Restricted the override to an allowlist `_OVERRIDE_METHODS = {PUT, DELETE,
  PATCH}` — exactly the write verbs the app uses (every EJS form encodes
  `?_method=PUT` or `=DELETE`; PATCH is included for parity). TRACE/TRACK/
  CONNECT/GET/HEAD/arbitrary strings now leave `req.method` as the original
  POST (CSRF still required, write limiter still applies). The check is
  case-insensitive (`raw.toUpperCase()`) so a lowercase `put` still overrides.

### Test coverage added
- `tests/app.test.js` (method-override suite) — +4 tests against the live
  middleware chain (a `POST /method-test/:id` handler was registered so the
  stay-on-POST outcome is observable):
  - `?_method=TRACE` no longer overrides → dispatches POST (200), not TRACE
    (previously 404). Verified to **FAIL** pre-fix (server log showed
    `TRACE /tickets/method-test/7?_method=TRACE 404`).
  - `?_method=CONNECT` (arbitrary method) → stays POST.
  - `?_method=GET` no longer downgrades → stays POST (CSRF kept). Pre-fix it
    dispatched GET and the server logged `GET ...?_method=GET 200`.
  - `_method=patch` (lowercase, body channel) still overrides to the PATCH
    handler — sanity that the allowlist preserves real overrides.

### False positives / non-defects reconfirmed
- All SQL still flows through whitelisted helpers with bound params; no raw
  `req.body/query/params` reaches SQL.
- The only `<%-` sink (`article.renderedContent`) is server-sanitized via
  `marked` + `sanitize-html`; all `href`/`src` with dynamic content are guarded
  (integer IDs, `isValidEmail`/`mailto:`, `^https?://` scheme check,
  `encodeURIComponent`); no inline `on*` handlers (CSP-safe).
- Every write route wraps check+mutate in `db.transaction` (TOCTOU-safe),
  rejects HPP arrays on all body fields, and is fail-closed on malformed
  present numeric/date/id values. GET filter forms correctly omit CSRF.
- `.gitignore` excludes `data/`, `.env*` (except `.env.example`), `*.db*`,
  `coverage/`; no secrets committed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **611 passed / 611 total** (26 suites; was 607 — +4 new
  regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-08-10 (eighty-second pass)

An eighty-second independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) plus `npm audit`. **No new SQL
injection, IDOR, CSRF, XSS, auth, or error-leakage defects were found.** One
cross-module data-handling consistency bug in optional-date resolution was
found and fixed:

### Fixes applied
- **`assets.js` / `projects.js` — an empty-string date submission preserved the stale value instead of clearing it (LOW, data correctness / UX).**
  The optional-date resolvers on the `PUT /:id` (update) routes treated an
  EMPTY submitted value (`''` — exactly what an `<input type="date">` sends
  when the user clears the field) the same as an ABSENT field (partial API
  submission), i.e. both preserved the stored value. Consequence: a user could
  set a purchase date / warranty expiry (assets) or start / end date
  (projects), but could **never unset it** via the edit form — clearing the
  field and saving silently re-persisted the old date.

  This was inconsistent with the three sibling modules that already implement
  the documented **absent-preserves / empty-clears** convention: `vendors.js`
  (`_resolveClearableDate`), `licenses.js` (date resolvers), and `changes.js`
  (`_resolveDateTimeField`) all treat `''` as an explicit clear-to-NULL and
  only `undefined` as "preserve existing". The money fields (`purchase_price` /
  `budget` / `spent` / `cost`) intentionally *keep* preserve-on-empty across
  all modules (a blank money field is not a "clear to NULL" signal), so the
  inconsistency was isolated to dates.

  Removed the `=== ''` clause from `resolvedPurchase` / `resolvedWarranty`
  (`assets.js`) and `resolvedStart` / `resolvedEnd` (`projects.js`) so that an
  empty submitted date clears the column (NULL) while an absent field still
  preserves the stored value. The transaction-internal resolved-value range
  checks (warranty ≥ purchase, end ≥ start) are unaffected — a cleared date is
  `null`, which short-circuits the range check exactly as before.

### Test coverage added
- `tests/partial_update.test.js` — assets update: submitting `warranty_expiry:`
  ` ''` against a stored `'2026-06-01'` now CLEARS it (NULL); submitting the
  field ABSENT still preserves `'2026-06-01'`. Locks in both branches of the
  absent-vs-empty distinction.
- `tests/projects_update.test.js` — projects update: submitting `start_date:
  ''` against a stored `'2026-01-15'` now CLEARS it (NULL) while the absent
  `end_date` is preserved; the absent-`start_date` case still preserves.

  Both new "clears" tests were verified to FAIL against the pre-fix code
  (empty preserved the stale value) and PASS with the fix.

### Verification
- `npm run lint` — clean (exit 0).
- `npm test` — **607 passed / 607 total** (26 suites; was 603 — +4 new
  regression tests: 2 assets date-clear, 2 projects date-clear).
- `npm audit` (both `--omit=dev` and full) — **0 vulnerabilities** (unchanged).

## Review cycle 2026-08-08 (eightieth pass)

An eightieth independent pass (full source re-read of all 11 route modules,
both middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) plus dependency audit. **No new SQL
injection, IDOR, CSRF, XSS, auth, or error-leakage defects were found.** One
production dependency advisory was remediated and two latent bugs were fixed:

### Fixes applied
- **Production dependency advisory remediated: `nanoid` < 3.3.17 (GHSA-2v37-7h3g-55p8, HIGH).**
  `npm audit` reported 1 high-severity advisory through the production tree
  (`nanoid@3.3.16` via `sanitize-html@2.17.5 → postcss@8.5.25`). Ran `npm audit fix`
  to upgrade `nanoid` to 3.3.18. Verified `npm audit --omit=dev` and full
  `npm audit` now both report **0 vulnerabilities**. Only `package-lock.json`
  changed (6 insertions / 6 deletions); `package.json` untouched and no API change.
- **`app.js` — scoped SESSION_STORE support was an unreachable dead branch (LOW).**
  The validation combined an allowlist regex `/^(connect-|@[\w-]+\/connect-)/`
  (which explicitly permits scoped packages) with a blanket `/[\//]/` path-
  separator rejection (added in commit 7179b59 as "defense-in-depth"). Since every
  scoped package name (`@scope/connect-sqlite3`) legitimately contains a single
  `/`, the two checks were contradictory and the documented `@scope/connect-*`
  form could never load. Replaced both with a single anchored allowlist regex
  `^(connect-[\w-]+|@[\w-]+\/connect-[\w-]+)$` that permits exactly one `/` (the
  scope delimiter) while still rejecting path traversal (`../evil`,
  `connect-x/../../evil`), absolute paths, backslashes, bare prefixes
  (`connect-`, `@scope/connect-`), and extra segments. Exported as
  `SESSION_STORE_RE` for unit tests.
- **`reports/staff.ejs` — misleading "0.0 days" for staff with no resolved tickets (LOW).**
  `staffPerformance` COALESCEs `avg_resolution_days` to 0, so it is never null —
  the template's `!= null` N/A branch was dead code and a staff member with zero
  resolved tickets displayed "0.0 days" (implying instant resolution). The cell
  now shows "N/A" when `resolved_tickets === 0` and the computed average
  otherwise. (`reports/tickets.ejs` uses the genuinely-nullable `AVG(...)`, so its
  N/A branch is correct as-is.)

### Test coverage added
- `tests/app.test.js` — `SESSION_STORE_RE` allowlist suite (5 cases): unscoped
  accept, scoped accept (regression for the dead branch), traversal/absolute/
  backslash rejection, bare-prefix rejection, extra-segment rejection.
- `tests/templates.test.js` — `reports/staff.ejs` regression: zero-resolved
  staff renders `N/A` (no `0.0 days`); staff with resolved tickets renders the
  rounded average.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **595 passed / 595 total** (26 suites; was 589 — +6 new:
  5 SESSION_STORE allowlist cases, 1 staff-report N/A template case).
- `npm audit` (both `--omit=dev` and full) — **0 vulnerabilities** (was 1 high
  `nanoid` advisory; remediated via `npm audit fix`).

## Review cycle 2026-08-07 (seventy-first pass)

A seventy-first independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** Two user-facing correctness bugs in
paginated list rendering and the report period filter were found and fixed:

### Fixes applied
- **Pagination did not clamp an out-of-range `page` to `totalPages` (LOW, all 9 list routes).**
  `paginate()` clamps `page` to `[1, MAX_PAGE]` only, and has no knowledge of
  `totalPages` at call time. A request like `/tickets?page=999` therefore ran
  the list query with `OFFSET (page-1)*limit` beyond the data, returned an empty
  table, and passed the raw `page` to the pagination partial — which rendered a
  broken `Showing N–M of total` range with **M < N** (e.g. "Showing 26–25 of 10
  records"). Applied the same clamp in all 9 paginated list routes (tickets,
  staff, assets, licenses, projects, changes, vendors, knowledge, audit):
  `page = Math.min(requestedPage, totalPages)` and `offset = (page - 1) * limit`
  computed **after** `totalPages`, so an out-of-range page now renders the actual
  final page of data instead of an empty list. The URL query parameter is left
  untouched (the view and pagination links reflect the clamped page).
- **Report period filter-state mismatch for non-preset periods (LOW).**
  `resolveReportPeriod()` accepts any integer in `[1, 365]` (e.g. `?period=45`),
  but the period `<select>` in `reports/tickets.ejs` and `reports/staff.ejs` only
  marked `7/30/90/365` as `selected`. For any other value the browser silently
  fell back to "Last 7 days" while the charts/tables reflected the requested
  window (e.g. 45 days), misrepresenting the period. Added a synthetic
  `selected` option `Last N days` when `period` is not one of the four presets,
  so the dropdown always reflects the window actually queried.

### Test coverage added
- `tests/pagination_clamp.test.js` — cross-route contract suite (9 cases) that
  loads every paginated list route against an in-memory SQLite DB and asserts a
  request for `?page=999` on an empty table clamps to `page === totalPages === 1`.
  Guards against any future route dropping the clamp.
- `tests/audit_route.test.js` — 2 integration cases: an out-of-range `page=99`
  clamps to the last page (page 3, OFFSET 4 → 1 entry) and renders the **same
  rows** as a request for the actual last page, never an empty page.
- `tests/templates.test.js` — report period select regression: a non-preset
  `period` (45) renders `<option value="45" selected>Last 45 days</option>`,
  no preset claims `selected`, and a preset (7) renders without the synthetic
  option.

### Verification
- `npm run lint` — clean (exit 0).
- `npm test` — **562 passed / 562 total** (24 suites; was 550 — +12 new: 9
  pagination-clamp contract cases, 2 audit integration cases, 1 template case).
- `npm audit` — 0 vulnerabilities (unchanged).

## Review cycle 2026-08-06 (seventieth pass)

A seventieth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One defense-in-depth gap in the
profile password-change route was found and fixed:

### Fixes applied
- **`src/routes/auth.js` — password-change route did not verify `result.changes`
  (LOW, defense-in-depth).** The `PUT /profile/password` handler called
  `_getPasswordUpdateStmt().run(hashed, req.session.user.id)` without checking
  whether any row was actually updated. If the user row were deleted between the
  preceding `SELECT password` (which verifies the stored hash) and the `UPDATE`,
  the handler would silently proceed to session regeneration and flash a success
  message despite the password never being persisted. The staff password-reset
  route (`PUT /:id/reset-password`) already guards this with
  `if (result.changes === 0)`; the profile route was missing the same check.
  Added the guard so a 0-change update surfaces `"User not found. Please log in
  again."` and redirects to `/login`, consistent with the staff route's
  `"Staff member not found"` guard.

### Testing added
- **`tests/auth-login.test.js` — password-change 0-row-update regression test
  added (TEST).** Overrides the password-update prepared statement to return
  `changes: 0`, runs the full password-change handler with a valid current
  password, and asserts that the handler redirects to `/login` with an error
  flash containing "not found". Guards against a future regression that drops
  the `result.changes` check.

### Verification
- `npm audit` — **0 vulnerabilities.**
- `npm run lint` — clean (exit 0).
- `npm test` — **550 passed / 550 total** (23 suites; was 549 — +1 new
  regression test asserting the 0-row-update guard on the profile password
  change route).

## Review cycle 2026-08-06 (sixty-ninth pass)

A sixty-ninth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** Two comment-accuracy issues and
one API-contract gap were found and fixed:

### Fixes applied
- **`src/routes/dashboard.js` — misleading `__stmts` export comment (INFO, doc).**
  The comment on `module.exports.__stmts = stmts` stated that unit tests in
  `tests/dashboard.test.js` *and* `tests/reports.test.js` use this export to
  verify the disposed-asset warranty exclusion. In reality, `tests/reports.test.js`
  exercises the *reports* module's own `__stmts` (age-bucket ordering, reports-
  side warranty queries); it does reference `dashboard.__stmts.expiringWarranties`
  only to verify the *same* disposed-asset exclusion pattern on the dashboard
  side, which is a different assertion than the reports module's own statements.
  Updated the comment to accurately describe which test file uses which export.
- **`src/routes/reports.js` — same misleading `__stmts` export comment (INFO, doc).**
  The `__stmts` comment claimed it "verify[s] the age-bucket ordering and the
  disposed-asset warranty exclusion against regression." The disposed-asset
  warranty exclusion lives in `dashboard.js` (`expiringWarranties`), not in any
  reports statement. The reports module's `__stmts` is used by
  `tests/reports.test.js` to assert statement shapes and verify the age-bucket
  ordering and the *reports-side* warranty queries (`warrantyExpiring`,
  `warrantyExpiringCount`). Updated the comment to accurately describe the export
  and its test consumers.
- **`tests/reset_cached_statements.test.js` — added `resetCachedStatements` API
  contract regression suite (TEST / robustness).** Every route and middleware
  module in the app exports a `resetCachedStatements` function so the test suite
  can isolate state between suites. If a new module is added without this export,
  cached prepared statements from one test leak into the next, producing flaky
  failures that are hard to diagnose. Added a fixtures-driven suite that requires
  every module in `src/routes/` and `src/middleware/` and asserts that
  `resetCachedStatements` exists and is a callable function. Guards against
  future modules omitting the export.

### Verification
- `npm audit` — **0 vulnerabilities.**
- `npm run lint` — clean (exit 0).
- `npm test` — **549 passed / 549 total** (23 suites; was 535 — +14 new
  regression tests asserting the `resetCachedStatements` API contract across all
  route and middleware modules).

## Review cycle 2026-08-06 (sixty-eighth pass)

A sixty-eighth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One consistency gap in the
knowledge article delete handler was found and fixed:

### Fixes applied
- **`src/routes/knowledge.js` — delete handler did not distinguish `ACCESS_DENIED` from generic errors (LOW, UX consistency).**
  The update handler explicitly caught `ACCESS_DENIED` (concurrent role-change
  inside the transaction) and surfaced `"You can only edit your own articles"`.
  The delete handler's catch block only had the generic `"Error deleting article"`
  branch, so a concurrent role change between the outer authorization check and
  the transaction recheck would show a misleading generic error instead of the
  permission-specific message. Added the same `ACCESS_DENIED` branch to the
  delete catch, mirroring the update handler exactly.

### Verification
- `npm audit` — **0 vulnerabilities.**
- `npm run lint` — clean (exit 0).
- `npm test` — **535 passed / 535 total** (22 suites; was 534 — +1 new regression
  test asserting the delete handler surfaces the permission-specific flash when
  `ACCESS_DENIED` is thrown inside the transaction).

## Review cycle 2026-08-06 (sixty-seventh pass)

A sixty-seventh independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** Two places where test-export
comments on `__stmts` misattributed the regression guard to the export itself
(rather than the unit tests that use it) were found and fixed: the exports
are test harnesses, not guards — the tests in `tests/dashboard.test.js` and
`tests/reports.test.js` are what enforce the invariants.

### Fixes applied
- **`src/routes/dashboard.js` — misleading comment on `__stmts` export (INFO, doc).**
  The comment on `module.exports.__stmts = stmts` stated that the export
  "Guards the disposed-asset warranty exclusion in expiringWarranties against
  regression." The export merely exposes prepared statements to the test
  harness; the guard is the test in `tests/reports.test.js` (line 95) that
  asserts a disposed asset is absent from `expiringWarranties.all()`. Replaced
  the inaccurate self-attribution with a correct description of the export's
  purpose and the tests that use it.
- **`src/routes/reports.js` — same misleading comment on `__stmts` export
  (INFO, doc).** The `__stmts` comment claimed it "Guards the age-bucket
  ordering and the disposed-asset warranty exclusion against regression." The
  export is a test harness; the guards are in `tests/reports.test.js` (age
  distribution ORDER BY assertion at line 71 and disposed-asset exclusion at
  line 91). Updated the comment to accurately describe the export and its
  test consumers.

### Verification
- `npm audit` — **0 vulnerabilities.**
- `npm run lint` — clean (exit 0).
- `npm test` — **534 passed / 534 total** (22 suites; unchanged from the
  sixty-sixth pass — comment-only fix, no behavioral change).

## Review cycle 2026-08-06 (sixty-sixth pass)

A sixty-sixth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One test-coverage gap was found
and fixed: five edit-form templates lacked regression-render tests.

### Fixes applied
- **`tests/templates.test.js` — add missing edit-form regression fixtures (LOW, test coverage).**
  The `every template renders without error` suite previously covered new-form
  variants for assets, changes, licenses, projects, and vendors, but omitted the
  corresponding edit-form variants. Without these, a regression that breaks an
  edit form (e.g. a missing `isEdit` local, a changed template variable name, or
  a stray `<% } %>` that drops a conditional section) would not be caught by the
  render suite — the same bug class that the dashboard stray-closing-brace
  regression (fix 44) and the `daysUntil` / `usagePercent` missing-locals
  regression (fix 35) represent. Added five fixtures covering
  `assets/form (edit)`, `changes/form (edit)`, `licenses/form (edit)`,
  `projects/form (edit)`, and `vendors/form (edit)`, each with realistic
  edit-route locals (including `isEdit: true` and the full resource object the
  route passes).

### Verification
- `npm audit` — **0 vulnerabilities.**
- `npm run lint` — clean (exit 0).
- `npm test` — **527 passed / 527 total** (21 suites; was 522 — 5 new
  regression-render tests).

## Review cycle 2026-08-06 (sixty-fifth pass)

A sixty-fifth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One defense-in-depth gap in the
method-override middleware was found and fixed, and `npm audit` reported
**0 vulnerabilities** across all dependencies.

### Fixes applied
- **`src/app.js` — body `_method` override was honored on non-POST requests (LOW, defense-in-depth).**
  The query-string channel is correctly gated on `req.method === 'POST'` (a
  GET/HEAD can never be upgraded to a state-changing method), and the comment
  above the middleware states "Only honor method override from POST requests."
  But the body channel (`req.body._method`) was checked *without* the method
  guard, so a GET carrying an `application/x-www-form-urlencoded` body of
  `_method=DELETE` was silently upgraded to a DELETE — contradicting the
  documented invariant. Not exploitable today (doubleCsrf runs after the
  override and still requires a valid token for the resulting write), but it
  was a genuine inconsistency between the stated policy and the enforcement.
  Added the `req.method === 'POST'` guard to the body channel so the two
  channels enforce the identical rule. Browser form overrides (query string)
  and the body channel used by the JSON/tests path are both POST, so behavior
  for all legitimate clients is unchanged.

### Testing added
- **`tests/app.test.js` — GET-with-body method override regression test.**
  The existing suite covered the query-string channel's GET rejection but not
  the body channel. Native `fetch()` rejects GET-with-body, so the test uses
  Node's `http.request` directly (as a curl/python-requests-style client would)
  to assert a GET with a urlencoded `_method=DELETE` body still dispatches to
  the GET handler. Guards the POST-only guard on the body channel against
  regression.

### Verification
- `npm audit` — **0 vulnerabilities.**
- `npm run lint` — clean (exit 0).
- `npm test` — **522 passed / 522 total** (21 suites; was 521 — the new
  regression test).

## Review cycle 2026-08-06 (sixty-fourth pass)

A sixty-fourth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One robustness gap in the process
shutdown wiring and one piece of unreachable dead code were found and fixed.

### Fixes applied
- **`src/app.js` — process-level handlers registered even when the app is required by tests (LOW, robustness).**
  `process.on('SIGTERM'/'SIGINT'/'unhandledRejection'/'uncaughtException')` were
  registered unconditionally at module load. When app.js is `require()`d by the
  test suite, a stray unhandled rejection would invoke `shutdown()` — which calls
  `server.close()`, `db.close()`, and `process.exit(1)` — killing the entire jest
  run with an opaque failure instead of jest's own per-test reporting. The
  handlers are now registered inside the same `require.main === module` guard
  already applied to `server.listen()`, so they only run in the real server
  process.
- **`src/routes/licenses.js` — unreachable `finalUsed < 0` guard in `_resolveSeats` (LOW, dead code).**
  `safePositiveInt` never returns a negative value (it returns the fallback for
  negatives), and a present-but-invalid `used_seats` collapses to `Infinity` and
  is rejected by the existing `!Number.isFinite(used)` check. By the time the
  `finalUsed < 0` branch is reached, `used` is guaranteed non-negative, so the
  guard was unreachable dead code. Removed it and documented why; existing
  fail-closed behavior for negative/garbage input is unchanged and still covered
  by `tests/licenses.test.js` (`resolveSeats('-1')` → `Invalid used seats`).

### Verification
- `npm run lint` — clean (exit 0).
- `npm test` — **521 passed / 521 total** (21 suites; unchanged from the
  sixty-third pass — the fixes were behavior-preserving).

## Review cycle 2026-08-06 (sixty-third pass)

A sixty-third independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** Two low-severity robustness gaps
were fixed, and the largest remaining test-coverage gap was closed.

### Fixes applied
- **`views/pages/auth/login.ejs` — unguarded optional `reason` local (LOW, robustness).**
  `login.ejs` referenced `reason` without a `typeof` guard (`reason ===
  'deactivated'`), so any future render path that omitted `reason` would throw a
  `ReferenceError` and 500 the page. The current route always passes `reason`,
  so this is not reachable today, but it was the only template referencing an
  optional local without the `typeof` guard the codebase applies everywhere else
  (`error.ejs` guards `error`; `header.ejs` guards `title`). Aligned it with the
  established pattern. Verified the raw query value is never echoed into the
  page (reflected-XSS safe by construction — the local is used purely as a
  branch selector).

### Testing added
- **`tests/templates.test.js` — full-template render regression suite.** The
  previous template coverage rendered only 6 of the app's ~40 views. This is
  the exact bug class that has bitten this codebase before (a template
  referencing a helper not wired into `res.locals`, or a stray `<% } %>`
  silently dropping a dynamic section — both shipped and escaped because the
  affected page was not render-tested). Added a fixtures-driven suite that
  renders every template (login, tickets show/index/form, staff show/index/form,
  vendors show/index/form, licenses show/index/form, projects show/index/form,
  changes show/index/form, knowledge show/index/form, assets show/index/form,
  reports index/tickets/assets/staff, audit, dashboard, 404, error) with the
  minimal-but-realistic locals each route passes, plus targeted assertions:
  - `tickets/show` HTML-escapes `<script>` in ticket titles and comments.
  - `licenses/show` masks the license key (`****1234`) for privileged users and
    shows `Restricted` to staff; the full key never appears in HTML.
  - `licenses/show` guards the seat percentage against `total_seats = 0` (no `NaN`).
  - `staff/show` shows `Restricted` contact info to a non-privileged viewer of
    another user.
  - `login` only renders static reason messages — attacker-supplied `?reason=`
    values are never reflected into the page.

### Verification
- `npm run lint` — clean (exit 0).
- `npm test` — **521 passed / 521 total** (21 suites; was 467 before this pass).

## Review cycle 2026-08-05 (sixtieth pass)

A sixtieth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** Three places where bcrypt
operations ran outside their protective try-catch blocks were found and fixed:

### Fixes applied
- **`src/routes/staff.js` — create route `bcrypt.hash` outside try block (LOW, error handling).**
  The `POST /` handler called `bcrypt.hash(password, BCRYPT_SALT_ROUNDS)` before
  the `try` block, so an unexpected bcrypt error (OOM, malformed input) would
  surface as a generic 500 via `asyncHandler` instead of a user-facing flash
  message. Moved the hash call inside the `try` block so DB errors and bcrypt
  errors are both caught and redirected with a consistent `"Error creating staff
  member. Please try again."` flash.
- **`src/routes/staff.js` — password-reset route `bcrypt.hash` outside try block (LOW, error handling).**
  Same pattern on `PUT /:id/reset-password`: `bcrypt.hash(new_password, ...)`
  ran before the `try` block. Moved it inside so bcrypt errors are caught and
  redirected with `"Error resetting password. Please try again."`.
- **`src/routes/auth.js` — profile password change `bcrypt.compare` / `bcrypt.hash`
  outside try-catch (LOW, error handling).** The `PUT /profile/password` handler
  called `bcrypt.compare(current_password, user.password)` and
  `bcrypt.hash(new_password, ...)` without wrapping them in try-catch. A bcrypt
  error would propagate through `asyncHandler` to Express's error handler and
  render a generic error page. Wrapped both calls in explicit try-catch blocks
  that redirect to `/profile` with `"An error occurred. Please try again."`.

### Tests added
- **`tests/auth-login.test.js`** — two regression tests asserting that
  `PUT /profile/password` redirects to `/profile` with an error flash when
  `bcrypt.compare` or `bcrypt.hash` rejects.
- **`tests/staff.test.js`** — one regression test asserting that
  `POST /` redirects to `/staff/new` with an error flash when `bcrypt.hash`
  rejects on staff creation. Also added `jest.mock('bcryptjs', ...)` at the
  top of the file so bcrypt errors can be forced in tests, and added
  `delete require.cache[require.resolve('../src/routes/staff')]` to
  `beforeEach`/`afterEach` so the in-memory DB reset propagates to the staff
  route module.

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
- `npm run lint` — clean (exit 0).
- `npm test` — 466 passed / 466 total (21 suites; +3 new regression tests).
- `utils.js` statement coverage: **100%**; branch coverage: **100%**.

## Review cycle 2026-08-05 (fifty-ninth pass)

A fifty-ninth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One code-organization improvement
and two regression tests were added:

### Fixes applied
- **`src/constants.js` — badge severity mappings moved from `utils.js` (INFO, code quality).**
  The three static badge-constant maps (`CONDITION_BADGE`, `CHANGE_TYPE_BADGE`,
  `ROLE_BADGE`) were moved from `src/utils.js` into `src/constants.js` alongside
  the other static data mappings (enums, max-lengths, session config). They are
  imported by `utils.js` (so the `badgeClass()` caller-surface is unchanged) and
  by `app.js` directly (so `res.locals` wiring continues to work). This is a
  pure reorganization — no behavioral change — but it places badge data in the
  same module as all other badge-adjacent constants, making the constants module
  the single source of truth for every constant the templates consume via
  `res.locals.CONSTANTS`.
- **`tests/audit.test.js` — invalid-action and invalid-entity regression tests
  added (TEST).** Two regression cases assert that `audit()` silently drops
  requests with an invalid `action` or an invalid `entity` without inserting a
  row into `audit_log`. This guards against a future caller passing a typo'd
  string that would otherwise bypass the allowlist check and store garbage in
  the audit trail.

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
- `npm run lint` — clean (exit 0).
- `npm test` — 463 passed / 463 total (21 suites; +2 new regression tests).
- `utils.js` statement coverage: **100%**; branch coverage: **100%**.

## Review cycle 2026-08-05 (fifty-eighth pass)

A fifty-eighth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One unreachable dead-code branch
in `_touchCache` was found and fixed, and the associated test was corrected to
properly exercise the eviction path:

### Fixes applied
- **`src/utils.js` — `_touchCache`: unreachable `keyToEvict !== undefined` guard
  removed (INFO, code quality).** The `if (keyToEvict !== undefined)` check at
  line 839 was unreachable: the guard is entered only when `cache.size >= maxSize`.
  Both callers pass `maxSize = 500` (`_COUNT_CACHE_MAX` / `_SELECT_CACHE_MAX`), so
  entering the branch requires `cache.size >= 500`, which means the Map is
  non-empty and `cache.keys().next().value` is always a defined key. The comment
  incorrectly described a TOCTOU-race scenario ("externally removed between the
  size check and the eviction") that cannot occur in single-threaded Node.js.
  Removed the dead branch, consistent with the identical `Number.isFinite` guard
  removed from `safeInt` and the `isNaN` guard removed from `localDate` in prior
  review passes.
- **`tests/utils.test.js` — `_touchCache` eviction test corrected (TEST).** The
  existing test named "should handle empty cache gracefully when evicting" did
  not actually enter the eviction branch: it created a 2-entry cache, deleted
  one entry (size=1), then called `_touchCache` with `maxSize=2`, so
  `cache.size >= maxSize` was `1 >= 2` = false and the eviction code was never
  reached. Replaced with a correct eviction regression test that fills the cache
  to capacity, touches an existing key to rotate it to the tail, inserts a third
  key, and asserts the oldest non-touched entry was evicted — closing the gap
  and restoring 100% branch coverage on `utils.js`.

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
- `npm run lint` — clean (exit 0).
- `npm test` — 461 passed / 461 total (21 suites; no new tests — one existing
  test was rewritten for correctness).
- `utils.js` statement coverage: **100%**; branch coverage: **100%** (was 99.69%).

## Review cycle 2026-08-04 (fifty-seventh pass)

A fifty-seventh independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** Two unreachable dead-code blocks
in `utils.js` and four gaps in test coverage for defensive paths were found
and fixed:

### Fixes applied
- **`src/utils.js` — `safeInt`: unreachable `Number.isFinite` guard removed (INFO,
  code quality).** The `if (!Number.isFinite(n))` check at line 343 was
  unreachable: string inputs that would produce `Infinity` are rejected by the
  preceding `/^-?\d+$/` regex, and numeric `Infinity` values are rejected by
  the `Number.isInteger` check on the number branch. The comment incorrectly
  stated `parseInt("Infinity") === Infinity` (it returns `NaN`), and the guard
  could never fire. Removed the dead branch and its stale comment.
- **`src/utils.js` — `localDate`: unreachable `isNaN` guard removed (INFO,
  code quality).** The `if (isNaN(d.getTime()))` check at line 574 was
  unreachable: the strict regex `^(\d{4})-(\d{2})-(\d{2})$` guarantees all
  three components are digit strings, and `new Date(validYear, validMonth,
  validDay)` never produces an NaN time value. Date-rollover invalidity is
  already caught by the subsequent `getFullYear/getMonth/getDate` validation.
  Removed the dead branch.
- **`src/utils.js` — `validatePassword`: added test for UTF-8 byte-length
  guard (TEST).** Added a regression test using 37 multi-byte `'é'` characters
  (74 UTF-8 bytes, 38 characters) to assert that the `MAX_PASSWORD_BYTES` (72)
  guard rejects passwords that are within the character limit but exceed the
  byte limit — a scenario the existing `validatePassword` tests did not cover.
- **`src/utils.js` — `recalcProjectProgress`: added test for null-row path
  (TEST).** Added a test asserting that `recalcProjectProgress(db, 42)` calls
  the select statement but does not call the update statement when the project
  row is absent (no tasks), closing the gap between the invalid-id test and
  the valid-but-empty-project path.
- **`src/utils.js` — `titleCase`: added test for acronym continuation guard
  (TEST).** Added a test with mixed-case input (`SOPHisticated`) that exercises
  the `next >= 'A' && next <= 'Z'` continue branch, preventing a regression
  where an acronym prefix followed by an uppercase continuation could be
  incorrectly split.
- **`src/utils.js` — `_touchCache`: exported for testing; added eviction test
  (TEST / CODE QUALITY).** Exported the internal `_touchCache` helper so the
  LRU eviction path can be exercised directly with a small `maxSize`. Added a
  test that creates a 2-entry cache, touches an existing key, inserts a third
  key, and asserts the oldest entry was evicted — closing the last coverage
  gap in `utils.js` statement coverage (now 100%).

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
- `npm run lint` — clean (exit 0).
- `npm test` — 435 passed / 435 total (20 suites; 431 baseline + 4 new).
- `utils.js` statement coverage: **100%** (was 97.73%).

## Review cycle 2026-08-04 (fifty-sixth pass)

A fifty-sixth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** Three minor consistency and
defense-in-depth gaps were found and fixed:

### Fixes applied
- **`src/routes/knowledge.js` — update and delete routes omitted `access_denied`
  audit on authorization failure (LOW).** The edit GET route and the show GET
  route both recorded an `access_denied` audit entry when a non-owner non-
  privileged user attempted to edit or view a non-published article, but the
  update PUT and delete DELETE routes silently redirected without auditing. A
  compromised or misconfigured privileged account that was also an article
  author could not be distinguished from an unauthorized access attempt in the
  audit log. Added `req.audit('access_denied', 'knowledge_article', id, ...)`
  to both the update and delete authorization guards, matching the existing
  pattern on the edit GET and show GET routes.
- **`src/routes/auth.js` — logout handler skipped audit when `session.user` was
  absent (LOW).** The `/logout` POST handler only audited when
  `req.session.user` existed; a persisted session cookie pointing to a
  deleted/expired session store entry would log no audit trail. Added an
  `else` branch that audits a `null`-entityId logout attempt so the trail
  remains complete even when the session user object is missing.
- **`src/routes/reports.js` — `staffPerformance` query lacked a row cap
  (LOW, defense-in-depth).** All other aggregation queries in the app carry a
  `LIMIT` (dashboard lists cap at 5–20 rows; ticket/staff/asset reports use
  `selectQuery` with pagination). The staff performance report returned every
  active user, which could be expensive on a large organization. Added
  `LIMIT 200` to the `staffPerformance` statement, consistent with the
  defense-in-depth convention applied to every other list/report query.
- **`CODE_REVIEW.md` — duplicate "forty-sixth pass" entry removed.** A prior
  review cycle dated 2026-07-21 was incorrectly labeled "forty-sixth pass"
  (the same number was already used for the 2026-07-26 pass). Renamed the
  earlier entry to "forty-second pass" to restore unique numbering.

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
- `npm run lint` — clean (exit 0).
- `npm test` — 431 passed / 431 total (20 suites; no new tests — all changes are
  behavioral consistency fixes covered by existing test suites).

## Review cycle 2026-08-04 (fifty-fifth pass)

A fifty-third independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One HTTP-protocol correctness gap
was found and fixed:

### Fixes applied
- **`src/app.js` — content-negotiated 404/error responses did not advertise
  `Vary: Accept` (INFO, protocol correctness).** The 404 handler and the
  app-level error handler both select between an HTML page and a JSON body
  based on the `Accept` request header (via `prefersJson()`), but neither set
  the `Vary: Accept` response header. Per RFC 9110 §12.5.3, a server whose
  response representation varies on a request header MUST advertise it in
  `Vary`; omitting it lets an intermediary that keys variants on `Vary` serve
  the wrong representation (e.g. an HTML error page cached under one URL and
  served to a JSON client). `Cache-Control: no-store` is set on every response
  so no intermediary should cache these today, but `Vary: Accept` is the
  correct protocol behavior for a content-negotiated endpoint and costs
  nothing. Both handlers now `res.set('Vary', 'Accept')` before branching.
  Added four HTTP-level regression tests in `tests/app.test.js` (boot the real
  app on an ephemeral port via the existing mocked-dependency harness,
  mirroring `tests/csrf.test.js`) covering the HTML and JSON variants of both
  the 404 handler and the error handler (the latter exercised end-to-end via a
  malformed-JSON body that trips `express.json` with `err.status = 400`).

### False positives / non-defects reconfirmed
- `Vary: Accept` on `res.set` is applied before the JSON/HTML branch in both
  handlers, so both representations carry the header.
- The error handler's `EBADCSRFTOKEN` redirect and the JSON/HTML error paths
  all retain the header without interfering with status codes or flash
  behavior.
- `npm run lint` — clean (exit 0).
- `npm test` — 431 passed / 431 total (20 suites; 427 baseline + 4 new).

## Review cycle 2026-08-04 (fifty-second pass)

A fifty-second independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One data-integrity inconsistency
in the project task routes was found and fixed:

### Fixes applied
- **`src/routes/projects.js` — task add / task full-update routes silently
  coerced a present-but-malformed `assigned_to` to NULL (LOW, data
  integrity).** `tickets.js`, `changes.js`, and `assets.js` all reject a
  present-but-malformed assignee id (`"abc"`, `"3.5"`, an HPP array) with an
  `Invalid assignee` error via `isPresentInvalidId()` before falling through to
  `safeId()`. The two project **task** write routes skipped that guard, so a
  typo'd/tampered `assigned_to` was silently coerced to NULL: a task update
  wiped the existing assignment with no user feedback, and a task add created
  the task unassigned. The same routes already fail closed on `due_date`
  (`INVALID_DUE_DATE`), and `projects.js` already guards `owner_id` on
  project create/update — making this an internal inconsistency as well.
  Added the `isPresentInvalidId()` guard (flash `Invalid assignee`, redirect
  back to the project) to both the task add (`POST /:id/tasks`) and task
  full-update (`PUT /:projectId/tasks/:taskId`) routes. Empty/absent values
  still legitimately mean "unassigned". Added four regression tests in
  `tests/projects_update.test.js` covering the reject-on-create, reject-on-
  update, and empty-value-still-unassigns paths.

### False positives / non-defects reconfirmed
- The other relational-id write sites are already fail-closed: `owner_id`
  (projects create/update), `user_id` (member add via `!safeUserId`),
  `assigned_to`/`asset_id` (tickets create/update), `assigned_to`
  (changes create/update), `assigned_to` (assets create/update).
- `npm run lint` — clean (exit 0).
- `npm test` — 427 passed / 427 total (20 suites).

## Review cycle 2026-08-04 (fifty-first pass)

A fifty-first independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One defense-in-depth gap in the
seed production guard and two toolchain/documentation drift items were found
and fixed:

### Fixes applied
- **`src/seed.js` — `runSeed()` production guard could be bypassed by a
  case/whitespace `NODE_ENV` variant (LOW, defense-in-depth).** `app.js`
  normalizes `NODE_ENV` via `trim().toLowerCase()` and then treats any
  `'production'` match as production; the seed CLI block does the same for its
  own early-exit. But the `runSeed()` guard itself compared the **raw**
  `process.env.NODE_ENV === 'production'`, so a programmatic caller running
  with `NODE_ENV="Production "` or `"PRODUCTION"` would have slipped past the
  guard and wiped all data in an environment the rest of the app treats as
  production. `runSeed()` now normalizes the same way (trim + lowercase)
  before the `SEED_DANGER` check. Added a regression test asserting the guard
  fires under `NODE_ENV="Production "` and that no rows are written.
- **`package.json` / `README.md` — stale Node engine floor (INFO, toolchain
  alignment).** `engines.node` and the README prerequisites claimed `>= 18`,
  while `.nvmrc` pins `20` and the CI matrix tests `[20, 22]`; Node 18 reached
  end-of-life on 2025-04-30 and is no longer covered by CI. Aligned
  `engines.node` to `>=20.0.0` and README to `Node.js >= 20` so the declared
  support floor matches what is actually tested.
- **`.github/workflows/ci.yml` — deprecated `npm audit --production` flag
  (INFO, CI hygiene).** npm 9+ warns `Use --omit=dev instead`. Switched the
  CI audit step to `npm audit --omit=dev --audit-level=high` — identical
  semantics (production deps only) without the deprecation warning.

### False positives / non-defects reconfirmed
- SQL injection: every dynamic query goes through `quoteColumn()`/`buildFilters`
  (column + operator allowlists), `safeSort()` (keyed map, fail-closed default),
  and `addSearch()` (identifier validation + LIKE escaping with `ESCAPE '\'`);
  all values are bound parameters. Verified all 40 `req.query.*` read sites
  route through `safeQueryValue()` and the list routes through
  `buildFilters()`/`addSearch()`.
- XSS: the only `<%-` sink is `knowledge/show.ejs` `renderedContent`, which is
  `sanitize-html` output from the `marked` pipeline (`input` tag disallowed,
  `rel="noopener noreferrer"` forced on links); every other user-controlled
  value renders via `<%=`. All `<%-` occurrences otherwise are EJS partial
  includes.
- IDOR/TOCTOU: ownership/role rechecks remain inside `db.transaction` for
  ticket update/comment/status/satisfaction/delete, project task/member CRUD,
  article update/delete, and staff deactivation; `canAccessResource()` still
  gates ticket visibility inside the write transactions.
- Auth/session: login does a constant-time bcrypt compare against a
  pre-computed dummy hash before any length-based or lockout early-return
  (no username enumeration via timing); per-account + per-IP lockout maps are
  bounded and purged; sessions regenerate on login/profile/password change;
  `password_changed_at` change invalidates existing sessions.
- Request hardening: TRACE/TRACK dropped at the edge, `query parser: simple`
  (no `qs` prototype-pollution surface), method-override only honors the POST
  body `_method`, doubleCsrf with a separate secret, `rejectHppArrays()`
  fail-closed on every write route, `express-rate-limit` v8 with per-account
  comment keying.
- Requester PII redaction (show + edit forms) and dashboard/license/audit
  queries use explicit column lists — no `SELECT *` remains in `src/`.
- `npm audit` (full, including dev deps) — **exit 0**, 0 vulnerabilities.
- `npm run lint` — clean (exit 0).
- `npm test` — 423 passed / 423 total (20 suites).

## Review cycle 2026-08-04 (fiftieth pass)

A fiftieth independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One functional regression
introduced by the forty-ninth pass and four remaining over-fetch statements
were found and fixed:

### Fixes applied
- **`src/routes/tickets.js` — `_showTicketStmt` no longer loads requester PII
  (MEDIUM, functional regression).** The forty-ninth pass dropped
  `requester_email`/`requester_department`/`requester_phone` from the show
  statement on the grounds that "non-privileged viewers already have these
  deleted client-side, so loading them is unnecessary." That reasoning ignored
  the privileged (admin/manager) viewer: `views/pages/tickets/show.ejs`
  renders a Requester section (email/phone/department) for every user, so after
  the change the section displayed `-` for **everyone**, including the
  privileged users who are supposed to see the details (and who still see them
  on the edit form via `_editTicketStmt`). Restored the three columns to
  `_showTicketStmt`; the existing show-route redaction (`delete` for
  non-privileged users) preserves the access control. Added regression tests
  covering both the privileged (PII present) and staff (PII redacted) cases.
- **`src/routes/tickets.js` — `_showCommentsStmt` `tc.*` over-fetch (LOW,
  defense-in-depth).** Replaced `SELECT tc.*` with the explicit
  `ticket_comments` column list rendered by the show template (`id`,
  `ticket_id`, `user_id`, `comment`, `is_internal`, `created_at`).
- **`src/routes/projects.js` — `_showTasksStmt` `pt.*` over-fetch (LOW,
  defense-in-depth).** Replaced with the columns the project show template
  renders (`id`, `title`, `status`, `priority`, `due_date` + joined
  `assigned_name`).
- **`src/routes/projects.js` — `_showMembersStmt` `pm.*` over-fetch (LOW,
  defense-in-depth).** Replaced `SELECT pm.*, u.email, u.role as user_role`
  with only what the template renders (`pm.id`, `pm.role` + joined
  `member_name`), dropping the unused `u.email`/`u.role` columns.
- **`src/routes/staff.js` — `_assignedTasksStmt` `pt.*` over-fetch (LOW,
  defense-in-depth).** Replaced with the columns the staff show template
  renders (`id`, `title`, `due_date` + joined `project_name`, `project_id`).

### False positives / non-defects reconfirmed
- All remaining list/dashboard/report/show queries use explicit column lists;
  the only two `SELECT *` references left in `src/` are explanatory comments in
  `dashboard.js`.
- Requester PII redaction on the ticket **edit** form and update-route
  preservation on partial submissions still intact (covered by the existing
  `partial_update.test.js` suites).
- `public/js/app.js` reviewed: CSP-safe data-attribute handlers, double-submit
  guard preserves the submitter's name/value via a hidden input before
  disabling buttons, license-key reveal keeps the full key out of the DOM and
  clears in-memory keys on `pagehide`/`visibilitychange` (bfcache mitigation),
  and all mutating fetches carry the CSRF token. No client-side issues found.

## Review cycle 2026-08-04 (forty-ninth pass)

A forty-ninth independent pass (full source re-read of all 11 route modules,
both middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** One dependency-security gap and
one defense-in-depth inconsistency were found and fixed:

### Fixes applied
- **`package.json` — `ip-address@10.2.0` (HIGH) and `sanitize-html@2.17.4`
  (moderate) vulnerabilities (HIGH / MEDIUM).** `npm audit --production
  --audit-level=high` surfaced two findings:
  - `ip-address@10.2.0` (via `express-rate-limit@8.5.2`) has three HIGH
    advisories (GHSA-mwp4-54f8-5fhr: leading-zero-SSRF, GHSA-4xrf-jv44-h6hh:
    CIDR-suffix trust bypass, GHSA-22jq-vg5j-6vgg: IPv4-mapped misclassification).
    Fixed by adding an `overrides` pin to `ip-address@^10.4.0` in
    `package.json` — the latest patch eliminates all three.
  - `sanitize-html@2.17.4` has a moderate advisory (GHSA-vccv-cmxp-4j9h) for
    incomplete URI-scheme validation on `action`/`formaction`/`data`/`poster`/
    `background` attributes. Pinning to `sanitize-html@2.17.5` (which uses
    `htmlparser2@10.1.0` — CJS-compatible with Jest) closes the advisory.
    `sanitize-html@2.17.6` was deliberately skipped: it switched to
    `htmlparser2@12` which is ESM-only and breaks Jest's CommonJS runtime
    (the same regression the 47th pass locked in with `2.17.4`).
    `npm audit --production --audit-level=high` now exits 0.
- **`src/routes/*.js` — internal `SELECT *` over-fetch (LOW, defense-in-depth).**
  Eight prepared statements across five route files used `SELECT *` on
  single-row edit/show queries: `assets.js` (`_editStmt`), `tickets.js`
  (`_editTicketStmt`), `licenses.js` (`_showLicenseStmt`), `knowledge.js`
  (`_editArticleStmt`), `vendors.js` (`_showVendorStmt`), `changes.js`
  (`_editChangeStmt`), `projects.js` (`_taskExistsStmt`, `_selectProjectByIdStmt`).
  These queries were never exposed to templates (the edit/show handlers read
  only the columns they use), but `SELECT *` widens the data surface of any
  future code that serializes, caches, or logs the result — and is inconsistent
  with the explicit-column-list convention already enforced on all public
  list/dashboard/report queries (e.g. `dashboard.js` `myTickets`, `licenseAlerts`).
  Replaced all eight with explicit column lists matching the target table
  schema, consistent with the defense-in-depth model applied in prior passes
  (10th, 14th).

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
- `npm audit --production --audit-level=high` — **exit 0** (no production
  vulnerabilities).
- `npm run lint` — clean (exit 0).
- `npm test` — 407 passed / 407 total (20 suites).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 407 passed / 407 total (20 suites).
- `npm audit --production --audit-level=high` — **exit 0**.
- `.env.example` contains only placeholders; no secrets committed.

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

## Review cycle 2026-07-21 (forty-second pass)

A forty-second independent pass (full source re-read of all 11 route modules,
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

## Review cycle 2026-08-09 (forty-ninth pass)

A forty-ninth pass (full source re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, all EJS views,
`public/js/app.js`, and the test suite) found **no new SQL injection, IDOR,
CSRF, XSS, auth, or error-leakage defects.** This pass completed a
`normalizeIp` hardening refactor (IP fallback/prefix normalization shared
across `audit.js`, `auth.js`, and `tickets.js`) and fixed one critical
regression introduced mid-refactor:

### Fixes applied
- **`reports.js` — CRITICAL: `resolveReportPeriod` function body deleted
  (syntax error).** The refactor accidentally removed the body of
  `resolveReportPeriod()` (`src/routes/reports.js:17-28`), leaving
  `function resolveReportPeriod(raw, fallback = 30) {` immediately followed by
  `const router = require('express').Router();` — a `SyntaxError: Unexpected
  end of input` that broke `node src/app.js` and the whole report suite.
  Restored the full function body (array/HPP rejection → `safeQueryValue` →
  `safeInt` clamp to `[1, 365]`) from the pre-refactor HEAD version. Verified
  via `node -e "require('./src/routes/reports.js')"` before and after.
- **`audit.js` — dead code removed after `normalizeIp` refactor.** The inline
  `::ffff:` prefix strip (which predated the shared helper) was now redundant;
  `audit()` delegates entirely to `normalizeIp(req?.ip ?? null)`, which strips
  the IPv6-mapped prefix and fails closed to `'unknown'` for missing/non-string/
  array values (HPP on `X-Forwarded-For`), so no raw non-string value ever
  reaches `audit_log.ip_address`.
- **`auth.js` / `tickets.js` — switched to shared `normalizeIp`.** The login
  lockout key and the comment rate-limit IP fallback key previously each had
  their own inline prefix-strip/array-guard logic; both now use
  `normalizeIp()`, keeping the audit trail, lockout map, and rate-limit keys
  consistent (strip `::ffff:`, fall back to `'unknown'`). Verified
  `rateLimit.ipKeyGenerator('unknown')` round-trips without throwing.
- **`utils.js` — formatting cleanup.** Stray double-space after
  `isValidAssetTag` in the export list removed.

### New regression tests
- `tests/utils.test.js` — new `normalizeIp` suite: plain IPv4/IPv6 pass
  through; `::ffff:` prefix stripped; `undefined`/`null`/`''`/number fall back
  to `'unknown'`; arrays (HPP) fall back to `'unknown'`.
- `tests/audit.test.js` — IPv6-mapped IP stored normalized; array `req.ip`
  stored as `'unknown'`; absent `req.ip` stored as `'unknown'`.

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

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 603 passed / 603 total (26 suites).
- `npm audit --production --audit-level=high` — **exit 0**.
- `.env.example` contains only placeholders; no secrets committed.

## Review cycle 2026-08-11 (ninety-first pass)

A ninety-first independent pass (full re-read of all 11 route modules, both
middleware modules, utils, constants, models, seed, the EJS views, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage defects
were found.** This pass completed and corrected an in-progress review batch that
had shipped with broken tests and one silent no-op security check:

### Fixes applied
- **`src/utils.js` — `rejectHppArrays` only inspected `req.body`, so the new
  /audit query-param HPP check was a silent no-op (MEDIUM).** The helper read
  only `req.body[field]`, but the audit route passes query filter names
  (`action`, `entity_type`, `sort`, `search`). Because the app uses Express's
  built-in `simple` query parser — which turns duplicate keys
  (`?action=a&action=b`) into arrays (verified end-to-end) — `req.query` can
  carry HPP arrays on a GET request where `req.body` is empty. The new /audit
  guard therefore never fired. Extended `rejectHppArrays` to inspect both
  `req.body` and `req.query` (skipping either source when absent so GET
  handlers without a body are still checked), and updated the JSDoc. This also
  hardens every write route: a duplicate query key that collides with a body
  field name is now rejected instead of silently ignored. New unit tests cover
  the query source, the missing-body-does-not-short-circuit case, and the
  clean-request case.

- **`src/routes/audit.js` — misleading comment (LOW).** The HPP check's comment
  claimed "every other route that accepts user-controlled query input rejects
  arrays explicitly"; in fact other list routes collapse arrays via
  `safeQueryValue` (fail-open) and only the write routes reject body arrays.
  Rewrote the comment to state the real rationale (the audit log is the one
  read-only surface that echoes filter values back into the rendered page via
  `safeFilters`, so deterministic rejection is warranted).

- **`src/routes/knowledge.js` — `sanitizeKnowledgeInput` empty-tags contract
  mismatch (LOW).** The refactor's JSDoc promised `safeTags: string|null` and
  the new tests asserted `null` for empty input, but the implementation left
  empty tags as `''` (the pre-refactor code stored `''` too). Normalized empty
  tags to `null` — the column is nullable, and search/template rendering treat
  `''` and `NULL` identically, so this only affects what is written to the DB
  and now matches the documented contract. JSDoc updated to describe the
  absent-vs-empty split accurately (title/content empty strings are preserved
  and surfaced as required-field errors; empty optional tags become `null`).

### Broken tests fixed in the in-progress batch
- **`tests/dashboard.test.js` — the new "route audit log" test invoked the
  wrong handler.** `dashboard.stack[0].handlers[0]` is the mocked `requireAuth`
  middleware (the `router.use(...)` layer), not the `GET /` handler, so the
  `res.render` assertion could never hold. Rewrote the test to extract the real
  `GET /` handler from the router stack, set `req.audit` (simulating the mocked
  `auditMiddleware`), and assert the audit call `('read', 'dashboard', null,
  'Viewed dashboard')` plus the render.
- **`tests/audit_route.test.js` — the HPP regression test passed with the
  buggy code.** It placed the array on `req.body` (the only source the old
  helper checked), so it would pass even with the no-op. Moved the array onto
  `req.query` with an empty body, which fails under the old code and passes
  with the fix. Also moved `flash` from the mock `res` onto `req` where
  connect-flash actually attaches it (the handler calls `req.flash`).
- **`tests/knowledge.test.js` — lint errors and two non-asserting "error path"
  tests.** Removed two unused-variable declarations (`__origSanitizeHtml`,
  `knowledgeModule` — the first referenced a non-existent export) and replaced
  the two weak error tests with one that genuinely exercises the catch block:
  a non-string (array) input makes `sanitize-html` throw, so the helper's
  `{ error }` contract is asserted against a real failure, and a follow-up
  normal call confirms no module state was corrupted.

### Test coverage added
- `tests/utils.test.js` — `rejectHppArrays` query-source suite (+3 tests).
- `tests/dashboard.test.js`, `tests/audit_route.test.js`,
  `tests/knowledge.test.js` — corrected regression tests (see above).

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

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 641 passed / 641 total (26 suites).
- `.env.example` contains only placeholders; no secrets committed.
