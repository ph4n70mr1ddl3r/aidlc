# Code Review Notes

**Date:** 2026-07-19
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 11 route modules, 2 middleware modules, models, utils, constants.
**Method:** Manual line-by-line review of all source files plus ESLint and the Jest
suite. Prior review history (16 consecutive "code review" hardening commits) was
cross-checked to confirm findings were not already addressed.

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
