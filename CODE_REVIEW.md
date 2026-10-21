# Code Review Notes

**Date:** 2026-10-21 (375th pass)
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`, `views/`). 12 route modules, 2 middleware modules, models,
utils, constants, the EJS templates and the seeder.
**Method:** Full re-read of all source files plus ESLint, Jest coverage, and
`npm audit`. Prior review history (374 consecutive hardening reviews) was
cross-checked.
**Layout:** the review cycles are appended **chronologically at the end** of
this file, so the newest cycle is the **last** section — not the first. (The
block at the top is the original history, ordered newest-first back to the 91st
pass; every cycle since then was appended below it.) Jump to the end of the
file for the most recent review.

---

## Review cycle 2026-10-20 (367th pass)

An independent pass re-read every route module, both middleware modules, utils,
constants, the schema, and the EJS views, and re-verified the documented
consistency invariants (HPP rejection, absent-vs-empty partial updates,
transaction-consistent rechecks, `changes === 0` no-op guards, access-scoped
list queries, cache invalidation, and view-to-route gating). No new functional
defect was found; one consistency gap remained in the `changes === 0`
convention.

1. **Missing no-op guards on staff and vendor state mutations** (consistency
   defect, fixed). Five statements were executed without inspecting their
   affected-row count: the staff edit UPDATE and the staff/vendor
   deactivate/reactivate UPDATEs. Each already re-reads the row and its state
   inside a transaction, so `changes === 0` is currently unreachable; but the
   rest of the codebase (tickets, assets, projects, licenses, changes,
   knowledge, vendor update) treats a zero-row mutation as `NOT_FOUND`. Without
   the check, a future statement edit that dropped the `WHERE id` term could
   cause the route to unassign dependent records and emit a success audit for
   an update that touched nothing. Fix: capture the result and treat
   `changes === 0` as not-found, skipping dependent unassignments and audits.

Also verified this pass: `.env.example` still matches every env read in
`src/`; every `name=` field in every form (including login and profile) is
consumed by its route; every view link/action resolves to an existing route;
asset related-ticket filtering still selects `assigned_to`; staff index PII
redaction remains intact; knowledge per-field validation and HPP guards remain
fail-closed; reports/dashboard aggregation and pagination clamping are correct.

### Fixes applied
1. `src/routes/staff.js` — check `_staffUpdateStmt.run`, `_reactivateStmt.run`,
   and `_deactivateStmt.run` for `changes === 0`; deactivate/reactivate return
   the existing `notFound` result so no unassignment or success audit runs.
2. `src/routes/vendors.js` — check `_deactivateStmt.run` and
   `_reactivateStmt.run` for `changes === 0` and return `notFound`.

### Regression tests added
- `tests/code_review_367.test.js` — 5 tests: staff update, reactivate, and
  deactivate report not found and skip success audits (deactivate also skips
  dependent unassignment) when `changes === 0`; vendor deactivate and reactivate
  report not found when `changes === 0`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 1412 passed / 1412 total (88 suites).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-20 (366th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, database schema, seed data, EJS views,
`public/js/app.js`, plus ESLint, Jest, and `npm audit`) surfaced one real
defect — a remaining TOCTOU window in the knowledge-base update path.

1. **Knowledge article tags were preserved from a stale pre-transaction row**
   (confirmed correctness/consistency defect, fixed). The update route resolves
   `status`, `is_featured`, ownership, and the existence check from the row
   re-read inside its transaction specifically to avoid overwriting concurrent
   changes. Tags were the lone exception: for an ABSENT `tags` field (the
   documented partial-update convention), the route used
   `existing.tags` captured by the authorisation SELECT *before* the
   transaction. A concurrent edit that changed tags between that SELECT and
   the UPDATE would therefore be silently reverted by an unrelated partial
   PUT. Fix: compute the preserved tags from `recheck.tags` inside the
   transaction, alongside `txnSafeStatus`/`txnSafeFeatured`; an explicit empty
   `tags` submission still clears to NULL.

Also verified this pass: every update transaction resolves absent-vs-empty
fields against the transaction-consistent re-fetch (tickets, assets, projects,
vendors, licenses, changes, staff, knowledge — post-fix); every update/delete
transaction still checks `changes === 0`; all write routes retain their
`rejectHppArrays` guards; knowledge index/show/edit/delete visibility remains
consistent (published OR author OR privileged); markdown rendering still fails
closed when `marked`/`sanitize-html` is missing or malformed; every
view-to-route link is gated to match the show route's access check (tickets,
assets, projects, changes, staff, licenses, vendors, knowledge); badge/CSS
classes referenced by templates still exist in `app.css`; all authenticated
route limiters remain per-account; mutation routes continue to invalidate the
dashboard cache (and the active-staff cache on user writes); and
`.env.example` still matches every env read in `src/`.

### Fixes applied
1. `src/routes/knowledge.js` — move absent-tags preservation inside the update
   transaction and resolve it from the rechecked row, closing the TOCTOU window
   already closed for status/is_featured/ownership.
2. `tests/code_review_163.test.js` — historical pin updated: the absent-tags
   assertion now targets `recheck.tags` (the transaction-consistent resolution)
   instead of the removed `existing.tags` stale read, preserving the original
   pass-163 intent (tags must not be wiped on absence).

### Regression tests added
- `tests/code_review_366.test.js` — 2 tests: an absent `tags` field persists
  the value re-read inside the transaction (not the stale outer value), and an
  explicit empty `tags` submission still clears the column to NULL.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 1407 passed / 1407 total (87 suites).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-20 (365th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, database schema, seed data, EJS views,
`public/js/app.js`, plus ESLint, Jest, and `npm audit`) surfaced one real
defect — a delete-path audit inconsistency in the knowledge base.

1. **Knowledge article delete audited success on a no-op DELETE**
   (confirmed correctness/consistency defect, fixed). `DELETE /knowledge/:id`
   ran the existence/authorization recheck and the delete in one transaction,
   but returned `{ changes: result.changes }` and never inspected it — the
   `changes` field was dead. Every sibling delete route (assets, changes,
   licenses, projects, tickets) treats `changes === 0` as `NOT_FOUND` and
   skips the success audit. As written, any future reorder that let the
   DELETE affect zero rows would still emit a `delete` audit entry and a
   success flash for an article that was never removed. Fix: throw
   `NOT_FOUND` from the transaction when `changes === 0`, and handle
   `NOT_FOUND` in the outer catch so the request flashes "Article not found"
   and writes no success audit — matching the update route's sentinel style.

Also verified this pass: every write route still carries `rejectHppArrays`
HPP guards (including the knowledge delete `id` guard); all update routes
still implement absent-preserves / explicit-empty-clears through
`resolveOptionalField` or the raw-vs-trimmed split; every update transaction
still has a belt-and-braces `changes === 0` `NOT_FOUND` guard, and every
delete transaction now does too; present-but-non-string enum/text values
fail closed on create and update; knowledge index/show still hide
drafts/archived from non-owners and non-privileged users; markdown rendering
still fails closed to escaped plain text if `marked`/`sanitize-html` is
missing or malformed; login/profile/password routes still regenerate the
session and keep timing-enumeration defenses; all authenticated-route
limiters remain per-account (`authKeyGenerator`); and all 17
`.env.example` variables match the reads in `src/`.

### Fixes applied
1. `src/routes/knowledge.js` — treat `changes === 0` as `NOT_FOUND` inside
   the delete transaction, remove the unreachable `notFound` return shape,
   and handle `NOT_FOUND` in the catch instead of only auditing (`delete`)
   whenever the recheck found a row.

### Regression tests added
- `tests/code_review_365.test.js` — 3 tests: a normal delete still writes the
  `delete` audit and success flash; a zero-row DELETE flashes "Article not
  found" and writes no success audit; an article that vanished before the
  transaction is reported not found with no success audit.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 1405 passed / 1405 total (86 suites).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-20 (364th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, database schema, seed data, EJS views,
`public/js/app.js`, `.env.example`, plus ESLint, Jest, and `npm audit`)
surfaced one real defect — a partial-update inconsistency that made the
documented absent-preserves behavior false for privileged ticket editors.

1. **Privileged ticket update rejected an absent `requester_email`**
   (confirmed API/correctness inconsistency, fixed). `PUT /tickets/:id`
   preserved requester email, department, and phone on absence for
   non-privileged editors, and the 362nd-pass entry documented email as
   following the same rule. But for privileged (admin/manager) editors the
   route required a non-empty `requester_email` on every request, so a valid
   partial API `PUT` that changed only `title`/`status` failed with
   "Requester email is required" unless the caller re-sent PII they were not
   changing. Fix: capture the raw email, preserve
   `ticket.requester_email` when the field is absent, keep rejecting an
   explicit empty value (the email is required), and fail closed on a
   present-but-non-string value instead of coercing it to `''`. The resolved
   email is now read from the transaction-consistent row, matching the
   department/phone resolution path.

Also verified this pass: every write route still carries `rejectHppArrays`
HPP guards; all update routes still implement absent-preserves /
explicit-empty-clears through `resolveOptionalField` or the raw-vs-trimmed
split (including the newly fixed ticket email); every update transaction
still has a belt-and-braces `changes === 0` `NOT_FOUND` guard;
present-but-non-string enum/text values fail closed on create and update;
`safeId` / `isPresentInvalidId` reject non-integer and array ids; inactive
assignees are preserved only when unchanged and otherwise rejected; ticket
show/edit and asset show still redact requester/assignee PII for
non-privileged viewers; staff show still restricts cross-profile PII and
staff list still redacts `last_login`/`avatar`; ticket show still filters
internal comments server-side; all authenticated-route limiters remain
per-account (`authKeyGenerator`); dashboard/report queries still exclude
disposed assets and use uncapped COUNT companions for capped alert lists;
the 404/error/CSRF handlers still negotiate JSON vs HTML and avoid open
redirects; and all 17 `.env.example` variables match the reads in `src/`.

### Fixes applied
1. `src/routes/tickets.js` — capture `rawRequesterEmail`, apply the
   absent-preserves / explicit-empty-required / non-string-fail-closed rules
   to privileged ticket updates, and resolve the persisted email from the
   rechecked row inside the update transaction.

### Regression tests added
- `tests/code_review_364.test.js` — 3 tests: an absent `requester_email` on a
  privileged partial `PUT` preserves the stored address; a present
  non-string email is rejected fail-closed; an explicit empty email is still
  rejected as a required-field miss.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 1402 passed / 1402 total (85 suites).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-20 (363rd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, database schema, seed data, the EJS
list/form/show templates, `public/js/app.js`, `.env.example`, plus ESLint,
Jest, and `npm audit`) found no new code defects. One documentation defect was
confirmed and fixed.

1. **362nd-pass entry intro was truncated** (confirmed documentation defect,
   fixed). The cycle entry began with a dangling sentence —
   "An independent pass (full re-read of all 12 route modules, both middleware"
   — followed immediately by the numbered findings, so the paragraph never
   said what the pass covered or how many defects it found. Restored the
   complete scope/method sentence (matching the convention used by every other
   cycle entry) and stated the six defects the pass fixed.

Also verified this pass: every write route still carries `rejectHppArrays`
HPP guards (including the intentionally exempt `is_featured` checkbox pair in
knowledge.js and the array-resolving `resolveSafeFeatured`); every update
route still enforces the absent-preserves / explicit-empty-clears convention
through `resolveOptionalField` or the raw-vs-trimmed split
(tickets, assets, projects, tasks, staff, vendors, licenses, changes,
knowledge tags); every update transaction still has a belt-and-braces
`changes === 0` `NOT_FOUND` guard; present-but-non-string enum/text values
fail closed on create and update; `safeId` / `isPresentInvalidId` reject
non-integer and array ids; inactive assignees are preserved only when
unchanged and otherwise rejected; deactivation still unassigns
tickets/tasks/changes/projects inside its transaction; ticket show/edit and
asset show still redact requester/assignee PII for non-privileged viewers;
ticket show still filters internal comments server-side; staff show still
gates cross-profile PII by privilege/self; all authenticated-route limiters
remain per-account (`authKeyGenerator`); dashboard/report queries still
exclude disposed assets and use uncapped COUNT companions for capped alert
lists; the 404/error/CSRF handlers still negotiate JSON vs HTML and avoid
open redirects; and all 17 `.env.example` variables match the reads in
`src/`.

### Fixes applied
1. `CODE_REVIEW.md` — completed the truncated 362nd-pass introductory
   paragraph so the entry records its scope, method, and defect count.

### Regression tests added
None — this pass changed documentation only. The existing 84 suites /
1399 tests continue to pin the runtime behavior listed above.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 1399 passed / 1399 total (84 suites, unchanged).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-19 (362nd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, database schema, seed data, EJS views,
`public/js/app.js`, `.env.example`, plus ESLint, Jest, and `npm audit`)
surfaced six real defects — one correctness/data-loss wipe, two
confidentiality leaks, one fail-open sanitizer shape check, one brute-force
lockout bypass, and one session-fixation residual. All are fixed this pass.

1. **`requester_name` wiped on partial ticket updates** (confirmed
   correctness/data-loss defect, fixed). `PUT /tickets/:id` wrote
   `(requester_name || '').substring(0, MAX_SHORT_STR)` unconditionally, with
   no absent-preserves rule, while every sibling field (description,
   resolution_notes, requester email/department/phone, assignee, asset,
   due_date, category, priority, status) resolved to the stored value on
   absence via `resolveOptionalField` / the raw-vs-trimmed split. A partial
   `PUT` that omitted `requester_name` silently erased it to `''` — the exact
   bug class the sibling fields had already fixed. Fix: capture the raw value
   (`rawRequesterName`), apply the same fail-closed present-non-string guard as
   the enum fields, reject an explicit empty string as a required-field miss
   (the create route and edit form both require a non-empty name), and resolve
   inside the transaction as `ticket.requester_name ?? ''` on absence.

2. **Asset show page leaked linked-ticket metadata past the ticket access gate**
   (confirmed IDOR asymmetry, fixed). `GET /assets/:id` rendered
   `_relatedTicketsStmt.all(id)` (ticket number/title/status/priority/
   assigned_to) to any viewer who passed `canAccessResource` on the *asset*
   (assets.js:343) — including a non-privileged assignee of the asset who would
   be *denied* on the ticket show route (tickets.js:423). The asset page was a
   metadata oracle for tickets the viewer had no permission to open. Fix:
   filter the related-ticket rows through `canAccessResource` (the same gate
   the ticket show route uses), so the set the asset page exposes exactly
   matches the set the viewer may open.

3. **Staff list leaked `last_login`/`avatar` to non-privileged viewers**
   (confirmed PII-disclosure asymmetry, fixed). `GET /staff` zeroed
   `email`/`phone`/`department` on non-self rows (staff.js:162) but not
   `last_login` (user-activity timing) or `avatar` — inconsistent with the
   redaction the route's own comment documents. Fix: both fields are now
   zeroed alongside email/phone/department for non-self/non-privileged rows.

4. **`sanitize-html` shape-detection silently passed through an unknown module
   shape** (confirmed fail-open stored-XSS surface, fixed). The loader wrapped
   *both* the `require` and the shape check in one try/catch, so a loaded-but-
   unexpected module shape (e.g. a broken interop wrapper returning a
   non-sanitizer object) caught the "throw" and fell back to the identity
   function — turning `renderMarkdown` into a stored-XSS surface. Fix: split
   the load error (still degrades to the escaped plain-text fallback, as
   before) from the shape error, which now logs and **throws at startup**
   (fail-closed: a process that can't verify its sanitizer should not serve
   untrusted HTML). Regression: `knowledge_sanitize_shape.test.js` mocks an
   unexpected shape and asserts the throw.

5. **`purgeStaleEntries` force-evicted active lockouts when the map was full**
   (confirmed brute-force bypass, fixed). When `MAX_LOGIN_FAILURES_MAP_SIZE`
   (10 000) was exceeded and *every* entry was still in an active lockout, the
   fallback deleted the oldest entry *regardless of lock state* — a
   10 000-username flood could then keep force-evicting a victim's lockout one
   entry at a time, defeating the per-account brute-force protection. Fix: the
   fallback now evicts only unlocked entries; when every entry is locked it
   evicts nothing and accepts the transient over-capacity (each entry's
   `lastAttempt` is within the 15-minute lockout window, so the periodic
   10-minute purge recovers slots within ~25 minutes without releasing any
   active lockout).

6. **Logout did not rotate the session ID** (confirmed session-fixation
   residual, fixed). `POST /logout` called `req.session.destroy()` directly,
   leaving the pre-logout session id revivable by any cached copy of the
   cookie (back-button cache, service worker, proxy) until the store entry was
   gone — the same fixation vector the login/profile/password routes close
   with `_regenerateSession`. Fix: the logout handler is now async and calls
   `_regenerateSession` before `destroy` (best-effort: a regenerate failure
   must not break logout, since the destroy below still wipes session state).

Also verified this pass: all 17 env vars in `.env.example` match the exact
reads in `src/`; `README.md` rate-limit claims updated to the full per-route
limiter inventory (reports 30/5min, audit 30/5min, license-key reveal
20/15min, KB write 30/hour + read 100/15min, staff create + deactivate 10/hour,
staff updates 50/15min, password 10/15min, ticket write 50/15min, ticket
comments 10/min, per-entity writes 50/15min, global write backstop 100/15min);
the `seed.js` CLI production guard exits before the shared DB handle is
required, so the `finally` `db.close()` only ever closes a handle this script
opened (documented); the favicon-ico 204 comment corrected to describe the
legacy browser fallback (pages link the real icon at `/favicon.svg`); HPP
guards present on every write route; `NOT_FOUND` guards on every update;
pagination clamped with `id` tiebreakers; PII redaction on ticket show/edit;
deactivated staff PII now gated by the show route's privilege/self check
(matching the index scoping); `last_login`/`avatar` zeroed on the staff index
for non-self rows.

### Fixes applied
1. `src/routes/tickets.js` — `requester_name` absent-preserves + present
   non-string guard + required-empty rejection on `PUT /:id` (mirrors every
   sibling field's `resolveOptionalField` convention).
2. `src/routes/assets.js` — related-ticket rows on the asset show page
   filtered through `canAccessResource` so the set exposed matches the set the
   viewer may open.
3. `src/routes/staff.js` — staff index zeroes `last_login` + `avatar`
   alongside email/phone/department for non-self/non-privileged rows.
4. `src/routes/knowledge.js` — split the sanitize-html load fallback from the
   shape check; an unexpected loaded shape now logs + throws at startup
   (fail-closed) instead of silently passing through.
5. `src/routes/auth.js` — `purgeStaleEntries` no longer evicts entries in an
   active lockout when the map is full; `POST /logout` regenerates the session
   before `destroy` (fixation parity with login/profile/password).
6. `README.md` — rate-limit line expanded to the full per-route limiter
   inventory; `src/app.js` — favicon-ico 204 comment corrected.

### Regression tests added
`tests/code_review_362.test.js` (8 tests): ticket update preserves stored
requester_name on absence, rejects a present non-string requester_name, still
rejects an explicit empty name; asset show filters related tickets through
`canAccessResource` (staff viewer sees only their own linked ticket); staff
index nulls last_login+avatar for non-self/non-privileged rows and keeps all
fields for privileged viewers; logout regenerates the session before destroy;
login-failure purge no longer force-evicts active lockouts.
`tests/knowledge_sanitize_shape.test.js` (2 tests): a loaded-but-unexpected
sanitize-html shape throws at module load (fail-closed, no pass-through).
`tests/partial_update.test.js` — added a requester_name absent-preserve case
and dropped the now-invalid explicit field from the non-privileged PII-preserve
case.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 1399 passed / 1399 total (84 suites, +10 from #361).
- `npm run test:coverage` — global thresholds pass (statements 67.99%,
  branches 65.7%, functions 77.38%, lines 67.99%).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-17 (358th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, database schema, seed data, EJS views,
`public/js/app.js`, `.env.example`, plus ESLint, Jest, and `npm audit`) with
parallel deep-review agents cross-verifying routes/views/HPP-field coverage and
the core runtime files. Three real defects surfaced (one security, one
fail-open config class, one user-message accuracy), plus two low-severity
accuracy items — all fixed this pass.

1. **Login lockout looped forever after expiry** (confirmed security/availability
   defect, fixed). `recordLoginFailure` pins the failure count at
   `MAX_LOGIN_FAILURES` (5) while locked, and `checkLockout` returned `false`
   without touching the stale count once `lockedUntil` had passed (the 10-minute
   purge only deletes expired entries on its next tick). After the 15-minute
   window expired, a SINGLE failed attempt incremented the pinned count
   (5 → 6 ≥ 5) and immediately re-armed the lockout — one request per window
   could keep an account (or an IP) permanently locked. Fix:
   `checkLockout` lazily resets `count`/`lockedUntil` when the window has
   expired, so a post-expiry failure starts a fresh 5-failure window (verified
   behaviorally for both the per-account and per-IP maps via the login
   handler with a mocked clock).

2. **Numeric env variables prefix-parses operator typos fail-open** (confirmed
   defect, fixed). While `PORT` uses an anchored `/^\d+$/` parser (app.js:
   "parseInt('3000abc') silently returns 3000"), five numeric env reads still
   used bare `parseInt`, so `PRUNE_AUDIT_DAYS="1year"` silently pruned with a
   6-day retention (or disabled pruning entirely with no diagnostic),
   `PRUNE_AUDIT_INTERVAL_MS="90s"` fired the prune loop every 90 ms,
   `DASHBOARD_TTL_MS="6months"` silently clamped to 1 s, `PAGE_SIZE="6months"`
   became page size 6 with no warning, and — worst —
   `SESSION_ABSOLUTE_TIMEOUT_SECONDS="8hours"` became an 8-SECOND session
   lifetime (every session destroyed after 8 seconds, silently). Fix:
   `utils.parseEnvInt()` (anchored `/^\d+$/`, NaN on anything else) applied to
   all five sites; set-but-invalid `PRUNE_AUDIT_DAYS` /
   `PRUNE_AUDIT_INTERVAL_MS` now emit the same style of warning `PAGE_SIZE`
   already does, and all documented defaults are preserved fail-closed.

3. **`assets.js` UNIQUE-constraint flashes mislabeled serial duplicates**
   (confirmed accuracy defect, fixed). The `assets` table has two uniqueness
   sources — the `asset_tag` UNIQUE column and the partial
   `UNIQUE(serial_number) WHERE serial_number IS NOT NULL` index — but both
   create and edit flashed "An asset with this tag already exists" for either
   violation, sending the operator to debug the wrong field. Both catch sites
   now branch on the constraint message and report the serial-number message
   for `assets.serial_number` duplicates (mirrors staff.js, which already
   words its dual username/email constraint correctly).

4. **Comment audit could not distinguish internal notes** (low, fixed).
   `POST /tickets/:id/comments` audited the literal `'Added comment'`
   regardless of the privilege-gated `is_internal` flag; the audit detail now
   appends `' (internal)'` (the resolved `parseBooleanFlag` value is hoisted so
   the INSERT and the audit detail share one resolution — mirrors the
   vendor-rename / staff-reset detail-enrichment pattern).

5. **Absent priority reported "Invalid Priority"** (low, fixed). Ticket create
   flashes "Priority is required" when the field is absent and "Invalid
   Priority" only for a present-but-invalid value, matching the required-field
   wording of the sibling title/category/requester checks.

6. **Paginated list ORDER BYs were not total orders** (low, fixed). Every
   paginated list query (tickets, assets, projects, audit `SORT_MAP`s and the
   literal queries in changes, knowledge, licenses, vendors, staff) sorted only
   by second-resolution timestamp/category/name keys, so ties (e.g. bulk-seeded
   rows sharing one `created_at`) made SQLite's LIMIT/OFFSET paging
   nondeterministic — rows could repeat or vanish across pages. All nine
   queries now end in an `id` tiebreaker making the ordering deterministic.

Also verified this pass: all view↔route render locals and form-field names
match (tickets/assets/staff/vendors/projects/licenses/changes/knowledge); every
write form carries the CSRF hidden input and every write route the
`rejectHppArrays` guard (verified field-by-field against `req.body`/`req.query`
reads); no SQL-injection surface (all dynamic SQL is whitelisted through
`buildFilters`/`safeSort`/`countQuery`/`selectQuery`); README env-var/security
claims match the code exactly (rate limits, bcrypt rounds, hardcoded timeouts);
`.env.example` covers all 17 env vars; session fixation protection on
login/profile/password-change; reports/dashboard aggregation queries
consistent; schema indexes cover the hot queries; seed counter arithmetic and
FK-safe delete ordering correct; `public/js/app.js` and the pagination partial
clean.

### Fixes applied
- `src/routes/auth.js`: `checkLockout` lazy reset of expired lockout entries
  (count + `lockedUntil`) for both per-account and per-IP maps.
- `src/utils.js`: new `parseEnvInt()` (anchored `/^\d+$/`, mirrors the PORT
  parser contract) used by `_derivePageSize`; exported for tests/modules.
- `src/app.js`: `PRUNE_AUDIT_DAYS` / `PRUNE_AUDIT_INTERVAL_MS` parsed and
  warned via `parseEnvInt`; `_parsePositiveSeconds` uses `parseEnvInt` so
  `SESSION_*_TIMEOUT_SECONDS` typos fail closed to the documented defaults.
- `src/routes/dashboard.js`: `DASHBOARD_TTL_MS` parsed via `parseEnvInt`.
- `src/routes/assets.js`: create/update catch sites branch the
  `SQLITE_CONSTRAINT_UNIQUE` flash on tag vs serial constraint messages.
- `src/routes/tickets.js`: comment audit detail marks internal notes; absent
  priority flashed as required rather than invalid.
- `src/routes/{tickets,assets,projects,audit,changes,knowledge,licenses,
  vendors,staff}.js`: paginated list `ORDER BY`s gained unique `id`
  tiebreakers.
- `tests/app.test.js`, `tests/session_timeout.test.js`: the `../src/utils`
  mocks gained the faithful `parseEnvInt` passthrough so the freshly-loaded
  app wiring exercises the real contract.

### Regression tests added
- `tests/code_review_358.test.js`: 16 tests — behavioral lockout-expiry
  coverage for the account and IP maps (mocked clock through the real login
  handler: post-expiry attempt is recorded as a fresh failure and requires a
  new full 5-failure window to re-lock); `parseEnvInt` canonical/garbage
  matrix; `PAGE_SIZE="6months"` warns and falls back; `PRUNE_*` typos warn and
  fail closed at fresh app load (plus a valid-value smoke pass); source pins
  that every numeric env read routes through `parseEnvInt`; assets
  serial/tag duplicate-flash branch on create and edit; comment audit detail
  for internal vs public notes; required-vs-invalid priority wording; and
  tiebreaker pins over all four `SORT_MAP`s and the five literal queries.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1384 passed / 1384 total** (81 suites, +16 net from #357).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-17 (357th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, database schema, seed data, EJS views,
`public/js/app.js`, `.env.example`, plus ESLint, Jest, and `npm audit`) with
two parallel deep-review agents cross-verifying the route modules against the
documented invariants. **A git-history cross-check of three guarded code paths
surfaced two real structural defects — both caused by earlier review cycles
"cleaning up" dependencies they did not trace** — plus one factually wrong
comment. All fixed this pass.

1. **`POST /tickets/:id/comments` locked regular staff out of commenting
   entirely** (confirmed defect, fixed). Cycle 194 (commit 4bde2789) removed
   `assigned_to` from `_commentExistsStmt` on the premise that it was an
   unused dead column — but the comment route's in-transaction access check
   passes the fetched row to `canAccessResource(req, ticket)`
   (`middleware/auth.js:178`), whose staff branch consumes exactly
   `assigned_to`. With `SELECT id` alone, the check returned `false` for every
   non-privileged user on every ticket since cycle 194, contradicting the
   route's own documented policy (tickets.js: "regular staff can only comment
   on tickets assigned to them"). The `tests/code_review_194.test.js` pin was
   written on the same faulty premise; both the statement and the pin are now
   corrected (the pin asserts the column MUST be present). Admin/manager
   access was unaffected because `canAccessResource` returns `true` before the
   field checks — which is also why the 355-cycle test suite never caught it.

2. **`PUT /tickets/:id/status` no-op guard was unreachable** (confirmed
   defect, fixed). Cycle 215 added `if (ticket.status === status) return
   { unchanged: true }` to skip re-writing an unchanged status — but the
   transaction reads the row via `_ticketAssigneeStmt`, which selected only
   `assigned_to`, so `ticket.status` was always `undefined` and the guard
   never fired. Every same-status submission was re-written, audited as
   "Status changed to X", flashed success, and invalidated the dashboard
   cache. `_ticketAssigneeStmt` now selects `assigned_to, status` (the row is
   also passed to `canAccessResource`, which needs `assigned_to`). Verified
   behaviorally: same-status now flashes `info: "Status unchanged."` with no
   UPDATE/audit/invalidation; a different status behaves exactly as before.

3. **`src/routes/assets.js` create-route comment claimed the schema treats
   `purchase_price` as NOT NULL** (comment-only defect, fixed). The schema
   declares `purchase_price REAL` (nullable), and the sibling update-path
   comment in the same file explicitly reasons about stored NULL prices.
   Behavior was correct in both paths (create defaults absent/empty to 0;
   update preserves) — corrected the comment and added a note clarifying the
   create path is stricter by convention.

Also verified this pass (agent cross-check, all invariants confirmed): all 15
core modules export `resetCachedStatements`; every badge mapping in
`constants.js` covers its enum exactly; `ALLOWED_ACTIONS` / 
`ALLOWED_ENTITY_TYPES` exactly match all 84 `req.audit(...)` sites plus the 9
object-style `audit({...})` sites (13 actions / 13 entities, zero unused, zero
extra); every write route carries `rejectHppArrays` + success-path
`invalidateDashboardCache()`; seat/content placeholder counts match on every
statement; transactions never delete children before verifying the parent;
seed counters and progress values match the runtime formulas; dynamic SQL
interpolates only compile-time constants; the pass-356 `_pw` rename and the
pass-355 `PUT /profile` `resolveOptionalField` semantics are intact.

### Fixes applied
- `src/routes/tickets.js`: restore `assigned_to` in `_commentExistsStmt`
  (staff comment access) and add `status` to `_ticketAssigneeStmt`
  (reachable no-op guard), each with a comment documenting the consumer so
  future dead-column cleanups cannot re-sever them.
- `src/routes/assets.js`: corrected the false NOT NULL claim in the
  create-route purchase-price comment.
- `tests/code_review_194.test.js`: the first pin asserted the faulty premise
  (`assigned_to` must be ABSENT); corrected to assert the column MUST be
  present in `_commentExistsStmt`, with the corrected-premise rationale in the
  header.

### Regression tests added
- `tests/code_review_357.test.js`: 7 tests — source pins on both corrected
  statements, plus behavioral coverage using the real `canAccessResource`:
  staff can comment on a ticket assigned to them, staff is denied on an
  unassigned ticket (audit + ACCESS_DENIED flash), admin can comment on any
  ticket, unchanged-status flashes `info` with no UPDATE/audit/cache
  invalidation, and changed-status still runs the update with success flash
  + audit + invalidation.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1368 passed / 1368 total** (80 suites, +7 net from #356).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-17 (356th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, database schema, seed data, EJS views,
`.env.example`, the `CODE_REVIEW.md` history, plus ESLint, Jest, and
`npm audit`). **No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or
error-leakage defects were found.** The codebase remains at the same hardening
plateau. Two consistency deviations were investigated and one confirmed:

1. **Inconsistent `password` destructure alias in `src/routes/auth.js`**
   (confirmed defect, fixed). The login handler used
   `const { password: _password, ...sessionUser } = user;` while the other
   three session-scrubbing sites (the two in `PUT /profile` and the one in
   `PUT /staff/:id`) all use `const { password: _pw, ...sessionUser } = ...`.
   The ESLint `no-unused-vars` `varsIgnorePattern: '^_'` accepts both names,
   but the codebase convention is `_pw` everywhere else — the outlier was
   introduced by pass 355's `PUT /profile` regression work not touching the
   login line. Renamed `_password` → `_pw` for uniformity. No behavioral
   change (both names are ignored by the linter and the destructuring result
   is identical).

2. **Stale comment/heading count in `CODE_REVIEW.md` itself** (not a defect).
   The 354th/355th cycle headings say "15 core modules export
   `resetCachedStatements`" — that count has been stable across the last 30
   passes and the list in `tests/code_review_354.test.js` (15 entries: 2
   middleware + 12 routes + `utils.js`) confirms it. No code change needed;
   documented here so the count is pinned to the actual module list rather
   than the prose.

Also verified this pass: all delete/update/create routes check existence
before dependent writes inside their transactions; all list routes clamp the
requested page to the actual page count; the license key reveal endpoint
remains POST-only, rate-limited (`licenseKeyLimiter`), and audited; and the
client-side double-submit / submitter-preservation and license-key re-masking
handlers in `public/js/app.js` are internally consistent.

### Fixes applied
- `src/routes/auth.js`: rename `_password` → `_pw` in the login handler's
  session-scrubbing destructure so it matches the `_pw` convention used by
  the two `PUT /profile` sites in the same file and `PUT /staff/:id` in
  `staff.js`. No behavioral change.

### Regression tests added
- None (the rename is a cosmetic convention pin; existing 355 tests already
  cover the `PUT /profile` phone semantics).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1361 passed / 1361 total** (79 suites, +0 net from #355).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-16 (355th pass)

An independent pass (full re-read of all 12 route modules — including
`licenses.js` and the client-side `public/js/app.js` — both middleware
modules, utils, constants, models, database schema, EJS views, `.env.example`,
and the `CODE_REVIEW.md` history). **No new SQL injection, IDOR, CSRF, XSS,
auth, rate-limit, or error-leakage defects were found.** The codebase remains
at the same hardening plateau. Two candidate consistency deviations were
investigated and one was confirmed as a genuine defect:

1. **`PUT /profile` silently wiped the stored phone on partial submission**
   (confirmed defect, fixed). The route computed
   `safePhone = phone ? phone.substring(0, MAX_PHONE) : null` and wrote it
   unconditionally, so any request that OMITTED the `phone` field persisted
   `NULL`. Every sibling update route (`staff.js`, `vendors.js`, `assets.js`,
   `projects.js`, `tickets.js`, `licenses.js`) resolves optional fields via
   the shared `resolveOptionalField(raw, processed, maxLen, existing)`
   convention, where an ABSENT field preserves the stored value and an
   explicit EMPTY string clears it. The profile route was the sole outlier.
   The self-service profile form always submits the field, so impact was
   API-only partial PUTs — but the silent data loss is exactly the class the
   `resolveOptionalField` convention exists to prevent. Fixed to preserve the
   stored phone on absent and clear on explicit empty, mirroring
   `staff.js:560` / `vendors.js:553`.

2. **`POST /tickets` guard loop includes `status` but never persists it**
   (not a defect). `status` appears in the `rejectHppArrays` list and the
   present-non-string guard loop, yet the create path never reads or writes
   it — the DB default (`'open'`) applies and the create form does not render
   the field (only the edit form does). This is intentional fail-closed
   defensive rejection of malformed input (a JSON-array/non-string `status`
   is refused rather than ignored), consistent with the same guard on
   persisted fields; the insert deliberately omits `status` so tickets always
   open in the default state. No change made.

Also verified this pass: all delete/update/create routes check existence
before dependent writes inside their transactions; all list routes clamp the
requested page to the actual page count; the license key reveal endpoint
remains POST-only, rate-limited (`licenseKeyLimiter`), and audited; and the
client-side double-submit / submitter-preservation and license-key re-masking
handlers in `public/js/app.js` are internally consistent.

### Fixes applied
- `src/routes/auth.js`: `PUT /profile` now resolves the optional `phone`
  field with `resolveOptionalField` against the freshly-read user row — an
  ABSENT field preserves the stored number, an explicit empty string clears
  it — instead of unconditionally writing `NULL`. Added the
  `resolveOptionalField` import and a present-non-string sentinel guard
  (rejects a JSON number/object phone rather than coercing it). Mirrors the
  `staff.js` / `vendors.js` update convention.

### Regression tests added
- `tests/code_review_355.test.js`: 4 tests pinning the `PUT /profile` phone
  semantics — absent preserves the stored value, explicit empty clears it, a
  new value replaces it, and a source-level convention pin asserting the
  route resolves the field through `resolveOptionalField`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1361 passed / 1361 total** (79 suites, +4 net from #354).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-15 (354th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, database schema, seed data, EJS views
(39 templates: 34 page + 5 partial), `public/js/app.js`, `.env.example`,
README, CI workflow, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS`
and `ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across
`src/` (all 13 entity types and 13 action values exercised — zero unused,
zero extra), all 15 core modules export `resetCachedStatements` as a
non-throwing function, no dangerous patterns (`eval`, `new Function()`,
`innerHTML`, `document.write`, `javascript:` URLs) exist in `src/`,
`views/`, or `public/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard, every `process.env.*` reference is documented in
`.env.example` (all 17 env vars match exactly — 7 active defaults, 10
commented-out options), and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: the seed data is self-consistent with the
routes — project `progress` values match `recalcProjectProgress()` output
(2/5 done = 40, 2/4 done = 50, 1/1 done = 100, taskless projects = 0), the
`asset_counter` / `ticket_counter` rows are initialized to the seed row
counts so the next generated tag/number continues the sequence, all
`assigned_to` / `owner_id` / `author_id` / FK references resolve to seeded
users, and the audit_log wipe is an intentional documented behavior
(comment + README "consider periodic archival"); the `marked` v15 CJS API
and the `sanitize-html` CJS shape match the guards in `knowledge.js`;
coverage thresholds hold (66.23% statements / 63.1% branches / 75.39%
functions / 66.23% lines vs. the 60/55/60/60 floor in `package.json`); the
CI matrix (Node 20/22, `npm ci`, lint, coverage, high-level audit) matches
the documented tooling. One documentation defect found: the JSDoc for
`createAuditLogPruner` (utils.js) described the logger contract as
`log`/`error`/`warn` while the code invokes `logger.info`, `logger.error`,
and `logger.warn` — `log` is never called and `info` was undocumented;
corrected. No new actionable code defects were identified.

### Fixes applied
- `src/utils.js`: `createAuditLogPruner` JSDoc — corrected the documented
  logger contract from `log`/`error`/`warn` to the actually-invoked
  `info`/`error`/`warn` surface and noted that `log` is intentionally
  unused (documentation only; no behavioral change).

### Regression tests added
- `tests/code_review_354.test.js`: full hardening plateau verification
  (48 tests covering badge/enum consistency, audit action/entity
  allowlists, constant/utility reference completeness,
  `resetCachedStatements` exports, dangerous-pattern absence, redirect
  safety, form-action safety, HPP guards on all write routes,
  `.env.example` documentation coverage with a pinned 17-var count,
  unescaped-EJS output confinement, try/catch balance, the
  `createAuditLogPruner` logger surface (including the first-run-only
  warning behavior), the pass-346 changes-create status default, and the
  pass-346 projects-delete not-found short-circuit ordering).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1357 passed / 1357 total** (78 suites, +48 net from #353).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-15 (353rd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, database schema, seed data, EJS views
(39 templates: 34 page + 5 partial), `public/js/app.js`, `.env.example`,
README, CI workflow, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS`
and `ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across
`src/` (all 13 entity types and 13 action values exercised — zero unused,
zero extra), all 15 core modules export `resetCachedStatements` as a
non-throwing function, no dangerous patterns (`eval`, `new Function()`,
`innerHTML`, `document.write`, `javascript:` URLs) exist in `src/`,
`views/`, or `public/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes verified; 65 HPP guard invocations
across all routes), every `process.env.*` reference is documented in
`.env.example` (all 17 env vars match exactly — 7 active defaults, 10
commented-out options), and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: the seed data is self-consistent with the
routes — project `progress` values match `recalcProjectProgress()` output
(2/5 done = 40, 2/4 done = 50, 1/1 done = 100, taskless projects = 0), the
`asset_counter` / `ticket_counter` rows are initialized to the seed row
counts so the next generated tag/number continues the sequence, all
`assigned_to` / `owner_id` / `author_id` / FK references resolve to seeded
users, and the audit_log wipe is an intentional documented behavior
(comment + README "consider periodic archival"); the `marked` v15 CJS API
and the `sanitize-html` CJS shape were probed against the installed
packages and match the guards in `knowledge.js` (sync `parse`, dual-shape
compatibility layer, the test mock's API surface); coverage thresholds hold
(66.23% statements / 63.12% branches / 75.39% functions / 66.23% lines vs.
the 60/55/60/60 floor in `package.json`); the CI matrix (Node 20/22,
`npm ci`, lint, coverage, high-level audit) matches the documented tooling.
No new actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1309 passed / 1309 total** (77 suites, +0 net from #352).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-14 (352nd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2526 open / 2526 close across all 19 source files),
all try/catch blocks are structurally balanced — 84 `try` blocks with 79
matching `catch` blocks at the same scope level and 5 transaction-callback
catches that re-throw through the outer handler (the same pattern documented in
pass 351), no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 65 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 41 data-mutating write routes; 48 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. All `console.error` call sites
that log error variables use null-safe guards (`(err && err.message) || String(err)`
or `(err && err.stack) || err || '...'`) so a thrown non-Error cannot crash the
logger with a TypeError. Dynamic SQL via template literals in dashboard.js /
knowledge.js / reports.js uses only compile-time constants (`_DASH_*_LIMIT`,
`COMMENT_LIST_CAP`, etc.) with no user-supplied fragments — verified safe.
Consistency checks confirmed: fail-closed input validation is uniform across all
entities, the absent-vs-empty partial-update convention is applied via
`resolveOptionalField` on every route that preserves stored values on omission,
per-account rate-limit keys (`authKeyGenerator`) are used on every authenticated
limiter, session idle (15 min) and absolute (8 h) timeouts are enforced via
middleware, CSRF uses a separate secret from the session, Helmet enforces strict
CSP with HSTS in production, the Express query parser is set to `'simple'` to
block prototype pollution via bracket syntax, TRACE/TRACK are rejected at the
middleware edge, database WAL mode and foreign-key integrity are asserted on
startup, and database file permissions are restricted to `0o640`. All unescaped
EJS outputs (`<%- %>`) are limited to `include()` calls and the pre-sanitized
`article.renderedContent` field; no raw user data reaches unescaped output.
No open-redirect vectors, prototype-pollution paths, or secret-leakage in
logging were found. No new actionable security defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1309 passed / 1309 total** (77 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-14 (350th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2526 open / 2526 close across all 19 source files),
all try/catch blocks are structurally balanced — 84 `try` blocks with 79
matching `catch` blocks at the same scope level and 5 transaction-callback
catches that re-throw through the outer handler (the same pattern documented in
pass 349), no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 65 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 41 data-mutating write routes; 48 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. All `console.error` call sites
that log error variables use null-safe guards (`(err && err.message) || String(err)`
or `(err && err.stack) || err || '...'`) so a thrown non-Error cannot crash the
logger with a TypeError. Dynamic SQL via template literals in dashboard.js /
knowledge.js / reports.js uses only compile-time constants (`_DASH_*_LIMIT`,
`COMMENT_LIST_CAP`, etc.) with no user-supplied fragments — verified safe.
Consistency checks confirmed: fail-closed input validation is uniform across all
entities, the absent-vs-empty partial-update convention is applied via
`resolveOptionalField` on every route that preserves stored values on omission,
per-account rate-limit keys (`authKeyGenerator`) are used on every authenticated
limiter, session idle (15 min) and absolute (8 h) timeouts are enforced via
middleware, CSRF uses a separate secret from the session, Helmet enforces strict
CSP with HSTS in production, the Express query parser is set to `'simple'` to
block prototype pollution via bracket syntax, TRACE/TRACK are rejected at the
middleware edge, database WAL mode and foreign-key integrity are asserted on
startup, and database file permissions are restricted to `0o640`. All unescaped
EJS outputs (`<%- %>`) are limited to `include()` calls and the pre-sanitized
`article.renderedContent` field; no raw user data reaches unescaped output.
No open-redirect vectors, prototype-pollution paths, or secret-leakage in
logging were found. No new actionable security defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1309 passed / 1309 total** (77 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-13 (349th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2526 open / 2526 close across all 19 source files),
all try/catch blocks are balanced (84 opening / 84 closing across all 19 source
files), no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 53 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 40 data-mutating write routes; 39 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. All `console.error` call sites
that log error variables use null-safe guards (`(err && err.message) || String(err)`
or `(err && err.stack) || err || '...'`) so a thrown non-Error cannot crash the
logger with a TypeError. Dynamic SQL via template literals in dashboard.js /
knowledge.js / reports.js uses only compile-time constants (`_DASH_*_LIMIT`,
`COMMENT_LIST_CAP`, etc.) with no user-supplied fragments — verified safe.
Consistency checks confirmed: fail-closed input validation is uniform across all
entities, the absent-vs-empty partial-update convention is applied via
`resolveOptionalField` on every route that preserves stored values on omission,
per-account rate-limit keys (`authKeyGenerator`) are used on every authenticated
limiter, session idle (15 min) and absolute (8 h) timeouts are enforced via
middleware, CSRF uses a separate secret from the session, Helmet enforces strict
CSP with HSTS in production, the Express query parser is set to `'simple'` to
block prototype pollution via bracket syntax, TRACE/TRACK are rejected at the
middleware edge, database WAL mode and foreign-key integrity are asserted on
startup, and database file permissions are restricted to `0o640`. All unescaped
EJS outputs (`<%- %>`) are limited to `include()` calls and the pre-sanitized
`article.renderedContent` field; no raw user data reaches unescaped output.
No open-redirect vectors, prototype-pollution paths, or secret-leakage in
logging were found. No new actionable security defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1309 passed / 1309 total** (77 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-13 (348th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (1767 open / 1767 close across all 19 source files),
all try/catch blocks are balanced (77 opening / 77 closing across all 19 source
files), no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 53 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 40 data-mutating write routes; 39 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. All `console.error` call sites
that log error variables use null-safe guards (`(err && err.message) || String(err)`
or `(err && err.stack) || err || '...'`) so a thrown non-Error cannot crash the
logger with a TypeError. Dynamic SQL via template literals in dashboard.js /
knowledge.js / reports.js uses only compile-time constants (`_DASH_*_LIMIT`,
`COMMENT_LIST_CAP`, etc.) with no user-supplied fragments — verified safe.
Consistency checks confirmed: fail-closed input validation is uniform across all
entities, the absent-vs-empty partial-update convention is applied via
`resolveOptionalField` on every route that preserves stored values on omission,
per-account rate-limit keys (`authKeyGenerator`) are used on every authenticated
limiter, session idle (15 min) and absolute (8 h) timeouts are enforced via
middleware, CSRF uses a separate secret from the session, Helmet enforces strict
CSP with HSTS in production, the Express query parser is set to `'simple'` to
block prototype pollution via bracket syntax, TRACE/TRACK are rejected at the
middleware edge, database WAL mode and foreign-key integrity are asserted on
startup, and database file permissions are restricted to `0o640`. All unescaped
EJS outputs (`<%- %>`) are limited to `include()` calls and the pre-sanitized
`article.renderedContent` field; no raw user data reaches unescaped output.
No open-redirect vectors, prototype-pollution paths, or secret-leakage in
logging were found. No new actionable security defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1309 passed / 1309 total** (77 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-13 (347th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2526 open / 2526 close across all 19 source files),
all try/catch blocks are balanced (73 opening / 73 closing across all 19 source
files), no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 53 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 40 data-mutating write routes; 40 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. All `console.error` call sites
that log error variables use null-safe guards (`(err && err.message) || String(err)`
or `(err && err.stack) || err || '...'`) so a thrown non-Error cannot crash the
logger with a TypeError. Dynamic SQL via template literals in dashboard.js /
knowledge.js / reports.js uses only compile-time constants (`_DASH_*_LIMIT`,
`COMMENT_LIST_CAP`, etc.) with no user-supplied fragments — verified safe.
Consistency checks confirmed: fail-closed input validation is uniform across all
entities, the absent-vs-empty partial-update convention is applied via
`resolveOptionalField` on every route that preserves stored values on omission,
per-account rate-limit keys (`authKeyGenerator`) are used on every authenticated
limiter, session idle (15 min) and absolute (8 h) timeouts are enforced via
middleware, CSRF uses a separate secret from the session, Helmet enforces strict
CSP with HSTS in production, the Express query parser is set to `'simple'` to
block prototype pollution via bracket syntax, TRACE/TRACK are rejected at the
middleware edge, database WAL mode and foreign-key integrity are asserted on
startup, and database file permissions are restricted to `0o640`. All unescaped
EJS outputs (`<%- %>`) are limited to `include()` calls and the pre-sanitized
`article.renderedContent` field; no raw user data reaches unescaped output.
No open-redirect vectors, prototype-pollution paths, or secret-leakage in
logging were found. No new actionable security defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1309 passed / 1309 total** (77 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-13 (346th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2524 open / 2524 close across all 19 source files),
all try/catch blocks are balanced (84 opening / 80 named-catch + 4 parameterless
`catch {` across all 19 source files), no dangerous patterns (`eval`, `new
Function()`, `innerHTML`, `document.write`, `javascript:` URLs) exist in `src/`
or `views/`, all `res.redirect()` targets are same-origin pathnames, all form
`action` URLs are relative, every write route carries a `rejectHppArrays` guard
(41 write routes with body/query processing verified; 55 HPP guard invocations
across all routes, including defensive empty-field guards on routes like
`POST /logout` that read no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly — 7 active
defaults, 10 commented-out options), and every exported constant and utility
from `constants.js` and `utils.js` is referenced somewhere in `src/` or
`tests/`. Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 40 data-mutating write routes; 40 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Dynamic SQL via template literals
in dashboard.js / knowledge.js / reports.js uses only compile-time constants
(`_DASH_*_LIMIT`, `COMMENT_LIST_CAP`, etc.) with no user-supplied fragments —
verified safe. Consistency checks confirmed: fail-closed input validation is
uniform across all entities, the absent-vs-empty partial-update convention is
applied via `resolveOptionalField` on every route that preserves stored values
on omission, per-account rate-limit keys (`authKeyGenerator`) are used on every
authenticated limiter, session idle (15 min) and absolute (8 h) timeouts are
enforced via middleware, CSRF uses a separate secret from the session, Helmet
enforces strict CSP with HSTS in production, the Express query parser is set to
`'simple'` to block prototype pollution via bracket syntax, TRACE/TRACK are
rejected at the middleware edge, database WAL mode and foreign-key integrity are
asserted on startup, and database file permissions are restricted to `0o640`.
All unescaped EJS outputs (`<%- %>`) are limited to `include()` calls and the
pre-sanitized `article.renderedContent` field; no raw user data reaches
unescaped output. No open-redirect vectors, prototype-pollution paths, or
secret-leakage in logging were found.

### Fixes applied
- `src/routes/changes.js`: relax `status` from required to optional on the
  create route (line 205), defaulting to `'scheduled'` — the first enum value
  and the natural initial state for a change record. Previously a missing or
  empty status on create produced an "Invalid Status" error, while the update
  route treated absent status as "keep stored" and all other entities
  (assets, tickets, projects) defaulted absent enums on create. The created
  row now receives `safeStatus` (line 255) consistent with how `safePriority`
  was already handled.
- `src/routes/projects.js`: add an early `return { changes: 0, name: null }`
  inside the delete transaction when `_showProjectStmt.get(id)` finds no row
  (line 648), before issuing the two child-deletion statements. Mirrors the
  pattern used by every other entity delete route (tickets, assets, vendors,
  changes) which all short-circuit on not-found to avoid unnecessary DELETE
  work on orphaned child tables.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1309 passed / 1309 total** (77 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-13 (345th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2524 open / 2524 close across all 19 source files),
all try/catch blocks are balanced (84 opening / 84 closing across all 19 source
files), no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 55 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 40 data-mutating write routes; 40 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. All `console.error` call sites
that log error variables use null-safe guards (`(err && err.message) || String(err)`
or `(err && err.stack) || err || '...'`) so a thrown non-Error cannot crash the
logger with a TypeError. Dynamic SQL via template literals in dashboard.js /
knowledge.js / reports.js uses only compile-time constants (`_DASH_*_LIMIT`,
`COMMENT_LIST_CAP`, etc.) with no user-supplied fragments — verified safe.
Consistency checks confirmed: fail-closed input validation is uniform across all
entities, the absent-vs-empty partial-update convention is applied via
`resolveOptionalField` on every route that preserves stored values on omission,
per-account rate-limit keys (`authKeyGenerator`) are used on every authenticated
limiter, session idle (15 min) and absolute (8 h) timeouts are enforced via
middleware, CSRF uses a separate secret from the session, Helmet enforces strict
CSP with HSTS in production, the Express query parser is set to `'simple'` to
block prototype pollution via bracket syntax, TRACE/TRACK are rejected at the
middleware edge, database WAL mode and foreign-key integrity are asserted on
startup, and database file permissions are restricted to `0o640`. All unescaped
EJS outputs (`<%- %>`) are limited to `include()` calls and the pre-sanitized
`article.renderedContent` field; no raw user data reaches unescaped output.
No open-redirect vectors, prototype-pollution paths, or secret-leakage in
logging were found. No new actionable security defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
- `tests/code_review_345.test.js`: full hardening plateau verification (47 tests
  covering badge/enum consistency, audit action/entity allowlists,
  `resetCachedStatements` exports, try/catch balance, dangerous-pattern absence,
  redirect safety, form-action safety, constant/utility reference completeness,
  HPP guards on all write routes, `.env.example` documentation coverage,
  null-safe `console.error` guards, and `asyncHandler` wrapping on all async
  route handlers).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1309 passed / 1309 total** (77 suites, +47 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-13 (344th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2524 open / 2524 close across all 19 source files),
all try/catch blocks are balanced (84 opening / 84 closing across all 19 source
files), no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 55 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 40 data-mutating write routes; 40 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Dynamic SQL via template literals
in dashboard.js / knowledge.js / reports.js uses only compile-time constants
(`_DASH_*_LIMIT`, `COMMENT_LIST_CAP`, etc.) with no user-supplied fragments —
verified safe. Consistency checks confirmed: fail-closed input validation is
uniform across all entities, the absent-vs-empty partial-update convention is
applied via `resolveOptionalField` on every route that preserves stored values
on omission, per-account rate-limit keys (`authKeyGenerator`) are used on every
authenticated limiter, session idle (15 min) and absolute (8 h) timeouts are
enforced via middleware, CSRF uses a separate secret from the session, Helmet
enforces strict CSP with HSTS in production, the Express query parser is set to
`'simple'` to block prototype pollution via bracket syntax, TRACE/TRACK are
rejected at the middleware edge, database WAL mode and foreign-key integrity are
asserted on startup, and database file permissions are restricted to `0o640`.
All unescaped EJS outputs (`<%- %>`) are limited to `include()` calls and the
pre-sanitized `article.renderedContent` field; no raw user data reaches
unescaped output. No open-redirect vectors, prototype-pollution paths, or
secret-leakage in logging were found. No new actionable security defects were
identified in this pass.

### Fixes applied
- `src/app.js`: restore cached `_parsedPruneInterval` variable to avoid a
  redundant second `parseInt()` call on the `PRUNE_AUDIT_INTERVAL_MS` env var
  (the 343rd pass removed the unused variable but introduced a double parse;
  this restores the single-parse pattern without reintroducing dead code).

### Regression tests added
- `tests/code_review_344.test.js`: full hardening plateau verification (45 tests
  covering badge/enum consistency, audit action/entity allowlists,
  `resetCachedStatements` exports, try/catch balance, dangerous-pattern absence,
  redirect safety, form-action safety, constant/utility reference completeness,
  HPP guards on all write routes, and `.env.example` documentation coverage).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1262 passed / 1262 total** (76 suites, +45 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-13 (343rd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2524 open / 2524 close across all 19 source files),
all try/catch blocks are balanced (84 opening / 84 closing across all 19 source
files), no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 55 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 40 data-mutating write routes; 40 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Dynamic SQL via template literals
in dashboard.js / knowledge.js / reports.js uses only compile-time constants
(`_DASH_*_LIMIT`, `COMMENT_LIST_CAP`, etc.) with no user-supplied fragments —
verified safe. Consistency checks confirmed: fail-closed input validation is
uniform across all entities, the absent-vs-empty partial-update convention is
applied via `resolveOptionalField` on every route that preserves stored values
on omission, per-account rate-limit keys (`authKeyGenerator`) are used on every
authenticated limiter, session idle (15 min) and absolute (8 h) timeouts are
enforced via middleware, CSRF uses a separate secret from the session, Helmet
enforces strict CSP with HSTS in production, the Express query parser is set to
`'simple'` to block prototype pollution via bracket syntax, TRACE/TRACK are
rejected at the middleware edge, database WAL mode and foreign-key integrity are
asserted on startup, and database file permissions are restricted to `0o640`.
All unescaped EJS outputs (`<%- %>`) are limited to `include()` calls and the
pre-sanitized `article.renderedContent` field; no raw user data reaches
unescaped output. No open-redirect vectors, prototype-pollution paths, or
secret-leakage in logging were found. No new actionable security defects were
identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-12 (342nd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2524 open / 2524 close across all 19 source files),
all try/catch blocks are balanced (84 opening / 84 closing across all 19 source
files), no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 55 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 40 data-mutating write routes; 40 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Dynamic SQL via template literals
in dashboard.js / knowledge.js / reports.js uses only compile-time constants
(`_DASH_*_LIMIT`, `COMMENT_LIST_CAP`, etc.) with no user-supplied fragments —
verified safe. Consistency checks confirmed: fail-closed input validation is
uniform across all entities, the absent-vs-empty partial-update convention is
applied via `resolveOptionalField` on every route that preserves stored values
on omission, per-account rate-limit keys (`authKeyGenerator`) are used on every
authenticated limiter, session idle (15 min) and absolute (8 h) timeouts are
enforced via middleware, CSRF uses a separate secret from the session, Helmet
enforces strict CSP with HSTS in production, the Express query parser is set to
`'simple'` to block prototype pollution via bracket syntax, TRACE/TRACK are
rejected at the middleware edge, database WAL mode and foreign-key integrity are
asserted on startup, and database file permissions are restricted to `0o640`.
All unescaped EJS outputs (`<%- %>`) are limited to `include()` calls and the
pre-sanitized `article.renderedContent` field; no raw user data reaches
unescaped output. No open-redirect vectors, prototype-pollution paths, or
secret-leakage in logging were found. No new actionable security defects were
identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-12 (340th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2524 open / 2524 close across all 19 source files),
no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 53 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all data-mutating write routes; invalidate calls cover create/update/delete
paths plus sub-resource mutations), all authenticated rate limiters use
`authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Dynamic SQL via template literals
in dashboard.js / knowledge.js / reports.js uses only compile-time constants
(`_DASH_*_LIMIT`, `COMMENT_LIST_CAP`, etc.) with no user-supplied fragments —
verified safe. Consistency checks confirmed: fail-closed input validation is
uniform across all entities, the absent-vs-empty partial-update convention is
applied via `resolveOptionalField` on every route that preserves stored values
on omission, per-account rate-limit keys (`authKeyGenerator`) are used on every
authenticated limiter, session idle (15 min) and absolute (8 h) timeouts are
enforced via middleware, CSRF uses a separate secret from the session, Helmet
enforces strict CSP with HSTS in production, the Express query parser is set to
`'simple'` to block prototype pollution via bracket syntax, TRACE/TRACK are
rejected at the middleware edge, database WAL mode and foreign-key integrity are
asserted on startup, and database file permissions are restricted to `0o640`.
All unescaped EJS outputs (`<%- %>`) are limited to `include()` calls and the
pre-sanitized `article.renderedContent` field; no raw user data reaches
unescaped output. No open-redirect vectors, prototype-pollution paths, or
secret-leakage in logging were found. No new actionable security defects were
identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-12 (339th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 53 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all data-mutating write routes; invalidate calls cover create/update/delete
paths plus sub-resource mutations), all authenticated rate limiters use
`authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Dynamic SQL via template literals
in dashboard.js / knowledge.js / reports.js uses only compile-time constants
(`_DASH_*_LIMIT`, `COMMENT_LIST_CAP`, etc.) with no user-supplied fragments —
verified safe. Consistency checks confirmed: fail-closed input validation is
uniform across all entities, the absent-vs-empty partial-update convention is
applied via `resolveOptionalField` on every route that preserves stored values
on omission, per-account rate-limit keys (`authKeyGenerator`) are used on every
authenticated limiter, session idle (15 min) and absolute (8 h) timeouts are
enforced via middleware, CSRF uses a separate secret from the session, Helmet
enforces strict CSP with HSTS in production, the Express query parser is set to
`'simple'` to block prototype pollution via bracket syntax, TRACE/TRACK are
rejected at the middleware edge, database WAL mode and foreign-key integrity are
asserted on startup, and database file permissions are restricted to `0o640`.
All unescaped EJS outputs (`<%- %>`) are limited to `include()` calls and the
pre-sanitized `article.renderedContent` field; no raw user data reaches
unescaped output. No open-redirect vectors, prototype-pollution paths, or
secret-leakage in logging were found. No new actionable security defects were
identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-12 (338th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2524 open / 2524 close across all 19 source files),
no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; 53 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 49 data-mutating write routes; 39 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback —
`commentKeyGenerator` in tickets.js is an explicit alias to the same function),
the `sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Dynamic SQL via template literals
in dashboard.js / knowledge.js / reports.js uses only compile-time constants
(`_DASH_*_LIMIT`, `COMMENT_LIST_CAP`, etc.) with no user-supplied fragments —
verified safe. Consistency checks confirmed: fail-closed input validation is
uniform across all entities, the absent-vs-empty partial-update convention is
applied via `resolveOptionalField` on every route that preserves stored values
on omission, per-account rate-limit keys (`authKeyGenerator`) are used on every
authenticated limiter, session idle (15 min) and absolute (8 h) timeouts are
enforced via middleware, CSRF uses a separate secret from the session, Helmet
enforces strict CSP with HSTS in production, the Express query parser is set to
`'simple'` to block prototype pollution via bracket syntax, TRACE/TRACK are
rejected at the middleware edge, database WAL mode and foreign-key integrity are
asserted on startup, and database file permissions are restricted to `0o640`.
No new actionable security defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-12 (337th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced (2524 open / 2524 close across all 19 source files),
no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (58 write routes
with body/query processing verified; 65 HPP guard invocations across all routes,
including defensive empty-field guards on routes like `POST /logout` that read
no body fields today), every `process.env.*` reference is documented in `.env.example`
(all 17 env vars match exactly — 7 active defaults, 10 commented-out options),
and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 49 data-mutating write routes; 39 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. No new actionable security
defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-10 (335th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all try/catch blocks are balanced in every source file (84 opening / 84 closing
across all 19 source files — 66 in routes, 11 in core, 3 in middleware, 4 in
models), no dangerous patterns (`eval`, `new Function()`, `innerHTML`,
`document.write`, `javascript:` URLs) exist in `src/` or `views/`, all
`res.redirect()` targets are same-origin pathnames, all form `action` URLs are
relative, every write route carries a `rejectHppArrays` guard (41 write routes
with body/query processing verified; the `POST /logout` route carries a
defensive empty-field guard for regression safety since it reads no body fields
today), every `process.env.*` reference is documented in `.env.example` (all 17
env vars match exactly), and every exported constant and utility from
`constants.js` and `utils.js` is referenced somewhere in `src/` or `tests/`.
Additional checks this pass: all 5 async route handlers
(`auth/login`, `auth/profile`, `auth/profile/password`, `staff/create`,
`staff/reset-password`) are wrapped in `asyncHandler`, all write routes that
mutate data call `invalidateDashboardCache()` on the success path (verified
across all 41 data-mutating write routes; 50 total invalidate calls covering
create/update/delete paths plus sub-resource mutations), all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. No new actionable security
defects were identified in this pass.

### Fixes applied
- `CODE_REVIEW.md`: Removed a stray duplicate `## Review cycle 2026-10-09 (334th pass)`
  heading (with an empty `---` separator) that appeared between the 335th and 334th
  pass entries — a copy-paste artifact with no content, introduced during an earlier
  review cycle edit.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-09 (334th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all try/catch blocks are balanced in every source file (84 opening / 84 closing
 across all 19 source files — 66 in routes, 18 in core), no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 41 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. No new actionable security
defects were identified in this pass. Fixes applied in this pass: corrected the
stale "18 opening / 18 closing" try/catch count in passes 327, 328, and 331 to
the accurate "84 opening / 84 closing" figure across all 19 source files
(66 in routes, 18 in core) verified via structured line-by-line stack analysis;
the prior "18" count reflected only core modules and missed that the count had
grown as new routes and middleware were added across the 330-cycle hardening
history.

### Fixes applied
- `CODE_REVIEW.md`: Corrected the stale "18 opening / 18 closing" try/catch
  counts (1 review entry: pass 332) to the accurate "84 opening / 84 closing"
  figure across all 19 source files (66 in routes, 18 in core)
  verified via structured line-by-line stack analysis.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-09 (333rd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all try/catch blocks are balanced in every source file (84 opening / 84 closing
across all 19 source files — 66 in routes, 18 in core), no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 41 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. No new actionable security
defects were identified in this pass. Fixes applied in this pass: corrected the
stale "157 opening / 157 closing" try/catch count (1 review entry: pass 332) to
the accurate "84 opening / 84 closing" figure across all 19 source files
(66 in routes, 18 in core) verified via structured line-by-line stack analysis;
the prior "157" count inflated the figure by mixing in test-file counts and
double-counting files that appeared under multiple globs during an earlier
automation run.

### Fixes applied
- `CODE_REVIEW.md`: Corrected the stale "157 opening / 157 closing" try/catch
  count in pass 332 to the accurate "84 opening / 84 closing" figure across all
  19 source files (66 in routes, 18 in core) verified via structured
  line-by-line stack analysis.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-09 (332nd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all try/catch blocks are balanced in every source file (84 opening / 84 closing
across all 19 source files — 66 in routes, 18 in core), no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 41 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. No new actionable security
defects were identified in this pass. Fixes applied in this pass: corrected the
stale "18 opening / 18 closing" try/catch count in passes 327, 328, and 331 to
the accurate "84 opening / 84 closing" figure across all 19 source files
(66 in routes, 18 in core) verified via structured line-by-line stack analysis;
the prior "18" count reflected only core modules and missed that the count had
grown as new routes and middleware were added across the 330-cycle hardening
history.

### Fixes applied
- `CODE_REVIEW.md`: Corrected the stale "18 opening / 18 closing" try/catch
  counts (1 review entry: pass 332) to the accurate "84 opening / 84 closing"
  figure across all 19 source files (66 in routes, 18 in core)
  verified via structured line-by-line stack analysis.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-09 (331st pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all try/catch blocks are balanced in every source file (66 opening / 66 closing
in routes, 18 opening / 18 closing in core), no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 41 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. No new actionable security
defects were identified in this pass. Fixes applied in this pass: corrected
three stale "17 opening / 17 closing" try/catch counts (3 review entries) to
the accurate "18 opening / 18 closing" figures that match the actual balance
checked via structured line-by-line stack analysis across all core modules
(app.js, utils.js, constants.js, seed.js, middleware/auth.js, middleware/audit.js,
models/database.js).

### Fixes applied
- `CODE_REVIEW.md`: Corrected three stale "17 opening / 17 closing" try/catch
  counts to the accurate "18 opening / 18 closing" figures across passes 327,
  328, and 329 that used an imprecise regex count missing bare `catch {` blocks.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-09 (330th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all try/catch blocks are balanced in every source file (83 opening / 83 closing
in routes, 17 opening / 17 closing in core), no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 41 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. No new actionable security
defects were identified in this pass. Fixes applied in this pass: corrected
five `safeld()` → `safeId()` copy-paste typos in review-history entries (passes
258, 264, 268, 269, 271) and corrected seven stale "34 EJS templates" references
(7 review entries) to the accurate "39 templates: 34 page + 5 partial" phrasing
that matches the actual template count and the document header.

### Fixes applied
- `CODE_REVIEW.md`: Corrected five `safeld()` → `safeId()` copy-paste typos in
  review-history entries (passes 258, 264, 268, 269, 271).
- `CODE_REVIEW.md`: Corrected seven stale "34 EJS templates" references to the
  accurate "39 templates: 34 page + 5 partial" phrasing across passes 225, 226,
  298, and three earlier undated entries.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
## Review cycle 2026-10-09 (329th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all try/catch blocks are balanced in every source file (83 opening / 83 closing
in routes, 17 opening / 17 closing in core), no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 41 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable security defects were identified in
this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-08 (328th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all try/catch blocks are balanced in every source file (83 opening / 83 closing
in routes, 17 opening / 17 closing in core), no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 41 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable security defects were identified in
this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-08 (327th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 41 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable security defects were identified in
this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-08 (326th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 41 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable security defects were identified in
this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +1 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-08 (325th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (40 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 40 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable security defects were identified in
this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-08 (323rd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (40 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 40 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. Three minor defects from prior analysis were corrected:
the unguarded `csrfToken` reference in `login.ejs` (which could throw a
`ReferenceError` if rendered before CSRF middleware runs), the `<%-` raw render
of `article.renderedContent` in `knowledge/show.ejs` (defense-in-depth, since
`renderMarkdown` already sanitizes via `sanitize-html`), and inconsistent
permission gating on change-list detail links (non-privileged users now see
gated links matching the pattern used by all other list pages). Additionally,
~300 lines of duplicated `baseLocals()` / `render()` boilerplate across 15 test
files were consolidated into `tests/template_helpers.js`, and `jest.useFakeTimers()`
calls in `templates.test.js` and `utils.test.js` were wrapped in `try/finally`
to prevent timer-state leakage on test failure. No new actionable security
defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-08 (322nd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (40 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 40 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. Three minor defects from prior analysis were corrected:
the unguarded `csrfToken` reference in `login.ejs` (which could throw a
`ReferenceError` if rendered before CSRF middleware runs), the `<%-` raw render
of `article.renderedContent` in `knowledge/show.ejs` (defense-in-depth, since
`renderMarkdown` already sanitizes via `sanitize-html`), and inconsistent
permission gating on change-list detail links (non-privileged users now see
gated links matching the pattern used by all other list pages). Additionally,
~300 lines of duplicated `baseLocals()` / `render()` boilerplate across 15 test
files were consolidated into `tests/template_helpers.js`, and `jest.useFakeTimers()`
calls in `templates.test.js` and `utils.test.js` were wrapped in `try/finally`
to prevent timer-state leakage on test failure. No new actionable security
defects were identified in this pass.

### Fixes applied
- `views/pages/auth/login.ejs:31` — Guarded `csrfToken` with
  `typeof csrfToken !== 'undefined' ? csrfToken : ''` to prevent a
  `ReferenceError` when the login page is rendered before CSRF middleware
  initializes `res.locals.csrfToken` (e.g. on error-handler paths). Mirrors
  the identical guard already present in `views/partials/header.ejs:10`.
- `views/pages/knowledge/show.ejs:27` — Changed `<%- article.renderedContent %>`
  to `<%= article.renderedContent %>` for defense-in-depth. The content is
  already sanitized by `renderMarkdown()` → `sanitizeHtml()` before reaching
  the template, but `<%=%>` adds an extra escaping layer so any future
  regression in the sanitizer would not produce raw HTML in the output.
- `views/pages/changes/index.ejs:20,26` — Gated change-list title and actions
  cell links behind `isPrivileged(user) || Number(c.assigned_to) === Number(user.id)`
  to match the permission-gating pattern used by all other list pages
  (tickets, assets, staff, projects, vendors, licenses, knowledge). Prevents
  spurious `access_denied` flashes and audit entries when non-privileged users
  click links they cannot access.
- `tests/template_helpers.js` — New shared module exporting `baseLocals(user?)`
  and `render(pageRel, locals)` to eliminate ~300 lines of duplicated boilerplate
  across 15 test files.
- `tests/templates.test.js`, `tests/code_review_125.test.js`,
  `tests/code_review_126.test.js`, `tests/code_review_147.test.js`,
  `tests/code_review_149.test.js`, `tests/code_review_163.test.js`,
  `tests/code_review_164.test.js`, `tests/code_review_165.test.js`,
  `tests/code_review_166.test.js`, `tests/code_review_169.test.js`,
  `tests/code_review_175.test.js`, `tests/code_review_180.test.js`,
  `tests/code_review_181.test.js`, `tests/code_review_182.test.js`,
  `tests/code_review_185.test.js` — Replaced local `baseLocals()` / `render()`
  definitions with imports from `tests/template_helpers.js`; removed now-unused
  `ejs`/`fs`/`path`/`utils`/`constants` imports where no longer needed.
- `tests/templates.test.js:185-211,213-230,232-249` — Wrapped three
  `jest.useFakeTimers()` / `jest.setSystemTime()` blocks in `try/finally`
  with `jest.useRealTimers()` in the `finally` to prevent timer-state leakage
  if any test throws before the explicit restore.
- `tests/utils.test.js:1432-1445` — Wrapped `jest.useFakeTimers()` block in
  `try/finally` for the same reason.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-08 (321st pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (40 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 40 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-06 (320th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (40 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 40 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-06 (319th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (40 write routes with body/query processing verified;
the `POST /logout` route carries a defensive empty-field guard for regression
safety since it reads no body fields today), every `process.env.*` reference
is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 40 data-mutating write routes), all authenticated
rate limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. One minor documentation gap was corrected: the previous
pass's claim that "all four auth.js write routes" carried explicit per-field
`rejectHppArrays` guards was inaccurate for `POST /logout` (which reads no body
fields); a defensive empty-field guard was added for regression safety so any
future body-field processing on the logout path is immediately covered. No new
actionable defects were identified in this pass.

### Fixes applied
- `tests/code_review_299.test.js:421-423` — Removed the incorrect `auth.js`
  exclusion from the "all write routes have rejectHppArrays guards" regression
  check. All four auth.js write routes already carry `rejectHppArrays` guards
  (verified); the skip was a false exemption that would have masked a regression
  if any auth.js write route lost its HPP guard.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-06 (318th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes all verified), every `process.env.*`
reference is documented in `.env.example` (all 17 env vars match exactly), and
every exported constant and utility from `constants.js` and `utils.js` is
referenced somewhere in `src/` or `tests/`. Additional checks this pass: all 5
async route handlers (`auth/login`, `auth/profile`, `auth/profile/password`,
`staff/create`, `staff/reset-password`) are wrapped in `asyncHandler`, all
write routes that mutate data call `invalidateDashboardCache()` on the success
path (verified across all 41 write routes), all authenticated rate limiters use
`authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles both
the real package (with `defaults` / `simpleTransform`) and the test mock, the
`marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-06 (317th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Simplified empty `resetCachedStatements` stub exports in route modules that
have no module-level cached state (assets, projects, staff, vendors, knowledge,
changes, licenses, audit, reports) from inline arrow-functions to a single
`() => {}` shape, matching the convention already used elsewhere. All 1216
tests continue to pass. No new fixes or regression tests needed.

### Fixes applied
- `src/routes/assets.js:716`, `src/routes/projects.js:1240`,
  `src/routes/staff.js:933`, `src/routes/vendors.js:843`,
  `src/routes/knowledge.js:767`, `src/routes/changes.js:590`,
  `src/routes/licenses.js:587`, `src/routes/audit.js:94`,
  `src/routes/reports.js:319` — Simplified empty
  `resetCachedStatements` stubs to `() => {}`.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-06 (316th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard, every `process.env.*` reference is documented in
`.env.example` (all 17 env vars match exactly), and every exported constant and
utility from `constants.js` and `utils.js` is referenced somewhere in `src/` or
`tests/`. Additional checks this pass: all async route handlers are wrapped in
`asyncHandler`, all authenticated rate limiters use `authKeyGenerator`
(per-account, normalized-IP fallback), the `sanitize-html` CJS compatibility
layer in `knowledge.js` correctly handles both the real package (with
`defaults` / `simpleTransform`) and the test mock, the `marked` v15 CJS API
(`marked.parse(content, opts)`) works correctly, and the
`public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-06 (315th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file (84 opening / 84 closing),
no dangerous patterns (`eval`, `new Function()`, `innerHTML`, `document.write`,
`javascript:` URLs) exist in `src/` or `views/`, all `res.redirect()` targets
are same-origin pathnames, all form `action` URLs are relative, every write
route carries a `rejectHppArrays` guard, every `process.env.*` reference is
documented in `.env.example` (all 17 env vars match exactly), and every exported
constant and utility from `constants.js` and `utils.js` is referenced somewhere
in `src/` or `tests/`. Additional checks this pass: all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-06 (314th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file (84 opening / 84 closing),
no dangerous patterns (`eval`, `new Function()`, `innerHTML`, `document.write`,
`javascript:` URLs) exist in `src/` or `views/`, all `res.redirect()` targets
are same-origin pathnames, all form `action` URLs are relative, every write
route carries a `rejectHppArrays` guard, every `process.env.*` reference is
documented in `.env.example` (all 17 env vars match exactly), and every exported
constant and utility from `constants.js` and `utils.js` is referenced somewhere
in `src/` or `tests/`. Additional checks this pass: all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-06 (313th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file (84 opening / 84 closing),
no dangerous patterns (`eval`, `new Function()`, `innerHTML`, `document.write`,
`javascript:` URLs) exist in `src/` or `views/`, all `res.redirect()` targets
are same-origin pathnames, all form `action` URLs are relative, every write
route carries a `rejectHppArrays` guard, every `process.env.*` reference is
documented in `.env.example` (all 17 env vars match exactly), and every exported
constant and utility from `constants.js` and `utils.js` is referenced somewhere
in `src/` or `tests/`. Additional checks this pass: all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-05 (312th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file (66 opening / 66 closing),
no dangerous patterns (`eval`, `new Function()`, `innerHTML`, `document.write`,
`javascript:` URLs) exist in `src/` or `views/`, all `res.redirect()` targets
are same-origin pathnames, all form `action` URLs are relative, every write
route carries a `rejectHppArrays` guard, every `process.env.*` reference is
documented in `.env.example` (all 17 env vars match exactly), and every exported
constant and utility from `constants.js` and `utils.js` is referenced somewhere
in `src/` or `tests/`. Additional checks this pass: all authenticated rate
limiters use `authKeyGenerator` (per-account, normalized-IP fallback), the
`sanitize-html` CJS compatibility layer in `knowledge.js` correctly handles
both the real package (with `defaults` / `simpleTransform`) and the test mock,
the `marked` v15 CJS API (`marked.parse(content, opts)`) works correctly, and
the `public/js/app.js` submitter-preservation hidden input mechanism correctly
survives button disabling for star-rating forms. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, session idle (15 min) and absolute
(8 h) timeouts are enforced via middleware, CSRF uses a separate secret from
the session, Helmet enforces strict CSP with HSTS in production, the Express
query parser is set to `'simple'` to block prototype pollution via bracket
syntax, TRACE/TRACK are rejected at the middleware edge, database WAL mode and
foreign-key integrity are asserted on startup, and database file permissions are
restricted to `0o640`. No new actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-05 (311th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard, every `process.env.*` reference is documented in
`.env.example`, and every exported constant and utility from `constants.js` and
`utils.js` is referenced somewhere in `src/`. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. The `public/js/app.js`
client-side code uses only CSP-compliant `data-*` attribute event delegation
with no inline handlers, re-fetches license keys on every reveal (never caches
them in JS memory), and masks keys on `visibilitychange` / `pagehide` to
mitigate bfcache exposure. All GET filter forms are correctly exempt from CSRF
(evidenced by the explicit `method="GET"` on every list-page filter form; all
POST/PUT/DELETE forms carry CSRF hidden inputs). No new actionable defects were
identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-05 (310th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard, every `process.env.*` reference is documented in
`.env.example`, and every exported constant and utility from `constants.js` and
`utils.js` is referenced somewhere in `src/`. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. The `public/js/app.js`
client-side code uses only CSP-compliant `data-*` attribute event delegation
with no inline handlers, re-fetches license keys on every reveal (never caches
them in JS memory), and masks keys on `visibilitychange` / `pagehide` to
mitigate bfcache exposure. No new actionable defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-05 (309th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard, every `process.env.*` reference is documented in
`.env.example`, and every exported constant and utility from `constants.js` and
`utils.js` is referenced somewhere in `src/`. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. The `public/js/app.js`
client-side code uses only CSP-compliant `data-*` attribute event delegation
with no inline handlers, re-fetches license keys on every reveal (never caches
them in JS memory), and masks keys on `visibilitychange` / `pagehide` to
mitigate bfcache exposure. One stale documentation bug was corrected: the
JSDoc on `_resetPageSize` in `utils.js` incorrectly stated it was "Called by
resetCachedStatements()" — it is not; `resetCachedStatements` resets DB cache
state while `_resetPageSize` resets configuration state, and the two paths are
intentionally independent (exported separately for tests that change
`process.env.PAGE_SIZE`).

### Fixes applied
- `src/utils.js:35` — Corrected the JSDoc on `_resetPageSize` to accurately
  describe its independence from `resetCachedStatements()`.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-05 (308th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard, every `process.env.*` reference is documented in
`.env.example`, and every exported constant and utility from `constants.js` and
`utils.js` is referenced somewhere in `src/`. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. The `public/js/app.js`
client-side code uses only CSP-compliant `data-*` attribute event delegation
with no inline handlers, re-fetches license keys on every reveal (never caches
them in JS memory), and masks keys on `visibilitychange` / `pagehide` to
mitigate bfcache exposure. No new actionable defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-04 (307th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. All 17 environment variables referenced in source code are documented
in `.env.example` (commented or uncommented). No `eval()`, `new Function()`, or
dangerous template patterns (`innerHTML`, `document.write`, `javascript:` URLs)
detected. All exported constants and utility functions are referenced in at least
one route, middleware, or test module. No TODO/FIXME/HACK markers present. No
unbalanced try/catch blocks. No prototype pollution vectors. No unbounded
recursion (false positive: `trim()` in `utils.js:545` calls `String.prototype.trim`,
not itself). No SQL injection vectors (all queries use parameterized statements
with `?` placeholders; dynamic column/table names are validated via
`SAFE_COLUMN_RE` / `_SAFE_TABLE_RE` before interpolation). No timing-unsafe
credential comparisons (all bcrypt compares run constant-time; length-based
early returns on invalid input are guarded behind the constant-time compare).
No path traversal vectors (no user-controlled file paths; `DB_PATH` is resolved
against `__dirname`, not `process.cwd()`). All content-negotiated responses
(`prefersJson`) correctly branch to JSON or HTML; the single AJAX JSON endpoint
(`licenses.js POST /:id/key`) explicitly returns JSON without negotiation since
it is always called via XHR. Additional cross-checks this pass: no `setTimeout`
with string arguments in `public/js/app.js` (CSP-safe), all `Object.assign`
calls use literal keys (no prototype pollution from user input), and all
`req.flash` calls reside in routes protected by `requireAuth` (or in `auth.js`
where `connect-flash` provides a no-op when no session exists).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-04 (306th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. All 17 environment variables referenced in source code are documented
in `.env.example` (commented or uncommented). No `eval()`, `new Function()`, or
dangerous template patterns (`innerHTML`, `document.write`, `javascript:` URLs)
detected. All exported constants and utility functions are referenced in at least
one route, middleware, or test module. No TODO/FIXME/HACK markers present. No
unbalanced try/catch blocks. No prototype pollution vectors. No unbounded
recursion (false positive: `trim()` in `utils.js:545` calls `String.prototype.trim`,
not itself). No SQL injection vectors (all queries use parameterized statements
with `?` placeholders; dynamic column/table names are validated via
`SAFE_COLUMN_RE` / `_SAFE_TABLE_RE` before interpolation). No timing-unsafe
credential comparisons (all bcrypt compares run constant-time; length-based
early returns on invalid input are guarded behind the constant-time compare).
No path traversal vectors (no user-controlled file paths; `DB_PATH` is resolved
against `__dirname`, not `process.cwd()`). All content-negotiated responses
(`prefersJson`) correctly branch to JSON or HTML; the single AJAX JSON endpoint
(`licenses.js POST /:id/key`) explicitly returns JSON without negotiation since
it is always called via XHR. Additional cross-checks this pass: no `setTimeout`
with string arguments in `public/js/app.js` (CSP-safe), all `Object.assign`
calls use literal keys (no prototype pollution from user input), and all
`req.flash` calls reside in routes protected by `requireAuth` (or in `auth.js`
where `connect-flash` provides a no-op when no session exists).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-04 (302nd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. All 17 environment variables referenced in source code are documented
in `.env.example` (commented or uncommented). No `eval()`, `new Function()`, or
dangerous template patterns (`innerHTML`, `document.write`, `javascript:` URLs)
detected. All exported constants and utility functions are referenced in at least
one route, middleware, or test module. No TODO/FIXME/HACK markers present. No
unbalanced try/catch blocks. No prototype pollution vectors. No unbounded
recursion (false positive: `trim()` in `utils.js:545` calls `String.prototype.trim`,
not itself). No SQL injection vectors (all queries use parameterized statements
with `?` placeholders; dynamic column/table names are validated via
`SAFE_COLUMN_RE` / `_SAFE_TABLE_RE` before interpolation). No timing-unsafe
credential comparisons (all bcrypt compares run constant-time; length-based
early returns on invalid input are guarded behind the constant-time compare).
No path traversal vectors (no user-controlled file paths; `DB_PATH` is resolved
against `__dirname`, not `process.cwd()`). All content-negotiated responses
(`prefersJson`) correctly branch to JSON or HTML; the single AJAX JSON endpoint
(`licenses.js POST /:id/key`) explicitly returns JSON without negotiation since
it is always called via XHR.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-04 (301st pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. All 17 environment variables referenced in source code are documented
in `.env.example` (commented or uncommented). No `eval()`, `new Function()`, or
dangerous template patterns (`innerHTML`, `document.write`, `javascript:` URLs)
detected. All exported constants and utility functions are referenced in at least
one route, middleware, or test module. No TODO/FIXME/HACK markers present. No
unbalanced try/catch blocks. No prototype pollution vectors. No unbounded
recursion (false positive: `trim()` in `utils.js:545` calls `String.prototype.trim`,
not itself). No SQL injection vectors (all queries use parameterized statements
with `?` placeholders; dynamic column/table names are validated via
`SAFE_COLUMN_RE` / `_SAFE_TABLE_RE` before interpolation). No timing-unsafe
credential comparisons (all bcrypt compares run constant-time; length-based
early returns on invalid input are guarded behind the constant-time compare).
No path traversal vectors (no user-controlled file paths; `DB_PATH` is resolved
against `__dirname`, not `process.cwd()`). All content-negotiated responses
(`prefersJson`) correctly branch to JSON or HTML; the single AJAX JSON endpoint
(`licenses.js POST /:id/key`) explicitly returns JSON without negotiation since
it is always called via XHR.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-04 (300th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. All 17 environment variables referenced in source code are documented
in `.env.example` (commented or uncommented). No `eval()`, `new Function()`, or
dangerous template patterns (`innerHTML`, `document.write`, `javascript:` URLs)
detected. All exported constants and utility functions are referenced in at least
one route, middleware, or test module. No TODO/FIXME/HACK markers present. No
unbalanced try/catch blocks. No prototype pollution vectors. No unbounded
recursion (false positive: `trim()` in `utils.js:545` calls `String.prototype.trim`,
not itself).

### Fixes applied
None.

### Regression tests added
`tests/code_review_299.test.js` — 13 regression checks: badge-mapping completeness,
template `badgeClass()` key resolution, audit action/entity allowlist exact match,
`resetCachedStatements` API contract across 15 modules, try/catch balance per
source file (excluding Promise `.catch()` method calls), no dangerous patterns
(`eval`, `new Function`, `innerHTML`, `document.write`, `javascript:` URLs),
same-origin redirect guarantee, relative form action URLs, constant/utility
export reachability, HPP guards on all write routes, and env-var documentation
completeness.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-04 (305th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. All 17 environment variables referenced in source code are documented
in `.env.example` (commented or uncommented). No `eval()`, `new Function()`, or
dangerous template patterns (`innerHTML`, `document.write`, `javascript:` URLs)
detected. All exported constants and utility functions are referenced in at least
one route, middleware, or test module. No TODO/FIXME/HACK markers present. No
unbalanced try/catch blocks. No prototype pollution vectors. No unbounded
recursion (false positive: `trim()` in `utils.js:545` calls `String.prototype.trim`,
not itself). No SQL injection vectors (all queries use parameterized statements
with `?` placeholders; dynamic column/table names are validated via
`SAFE_COLUMN_RE` / `_SAFE_TABLE_RE` before interpolation). No timing-unsafe
credential comparisons (all bcrypt compares run constant-time; length-based
early returns on invalid input are guarded behind the constant-time compare).
No path traversal vectors (no user-controlled file paths; `DB_PATH` is resolved
against `__dirname`, not `process.cwd()`). All content-negotiated responses
(`prefersJson`) correctly branch to JSON or HTML; the single AJAX JSON endpoint
(`licenses.js POST /:id/key`) explicitly returns JSON without negotiation since
it is always called via XHR. Additional cross-checks this pass: no `setTimeout`
with string arguments in `public/js/app.js` (CSP-safe), all `Object.assign`
calls use literal keys (no prototype pollution from user input), and all
`req.flash` calls reside in routes protected by `requireAuth` (or in `auth.js`
where `connect-flash` provides a no-op when no session exists).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-04 (299th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. All 17 environment variables referenced in source code are documented
in `.env.example` (commented or uncommented). No `eval()`, `new Function()`, or
dangerous template patterns (`innerHTML`, `document.write`, `javascript:` URLs)
detected. All exported constants and utility functions are referenced in at least
one route, middleware, or test module. No TODO/FIXME/HACK markers present. No
unbalanced try/catch blocks. No prototype pollution vectors. No unbounded
recursion (false positive: `trim()` in `utils.js:545` calls `String.prototype.trim`,
not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1171 passed / 1171 total** (74 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-03 (297th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. All 17 environment variables referenced in source code are documented
in `.env.example` (commented or uncommented). No `eval()`, `new Function()`, or
dangerous template patterns (`innerHTML`, `document.write`, `javascript:` URLs)
detected. All exported constants and utility functions are referenced in at least
one route, middleware, or test module. No TODO/FIXME/HACK markers present. No
unbalanced try/catch blocks. No prototype pollution vectors. No unbounded
recursion (false positive: `trim()` in `utils.js:545` calls `String.prototype.trim`,
not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-03 (296th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. All 17 environment variables referenced in source code are documented
in `.env.example` (commented or uncommented). No `eval()`, `new Function()`, or
dangerous template patterns (`innerHTML`, `document.write`, `javascript:` URLs)
detected. All exported constants and utility functions are referenced in at least
one route, middleware, or test module. No TODO/FIXME/HACK markers present. No
unbalanced try/catch blocks. No prototype pollution vectors. No unbounded
recursion (false positive: `trim()` in `utils.js:545` calls `String.prototype.trim`,
not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-03 (295th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-03 (294th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-03 (293rd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-03 (292nd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
- `CODE_REVIEW.md` (cycle 291): Corrected the badge-mapping cross-reference
  count from 18 to 20, matching the actual number of `*_BADGE` mappings exported
  by `constants.js` (CONDITION, CHANGE_TYPE, ROLE, MEMBER_ROLE, KB_CATEGORY,
  LICENSE_TYPE, TICKET_STATUS, TICKET_PRIORITY, ASSET_STATUS, PROJECT_STATUS,
  PROJECT_PRIORITY, TASK_PRIORITY, TASK_DEADLINE, WARRANTY_DEADLINE, CHANGE_STATUS,
  CHANGE_PRIORITY, KB_STATUS, VENDOR_CATEGORY, ACTION, IS_ACTIVE).

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-03 (291st pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
- `src/routes/staff.js`: Replaced the hardcoded `LIMIT 50` in
  `_assignedAssetsStmt` with `ASSIGNED_ITEMS_CAP`, keeping the asset-sidebar cap
  aligned with the sibling ticket/task sidebar queries and the central constants
  module.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-02 (290th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
- `tests/code_review_149.test.js`: Added the missing `TASK_DEADLINE_BADGE` and
  `WARRANTY_DEADLINE_BADGE` entries to the test `baseLocals()` fixture so that
  the asset-show and project-show template regression tests (which invoke
  `badgeClass()` against those mappings) no longer throw `ReferenceError` at
  render time. Mirrors the complete `res.locals` surface already asserted by
  `templates.test.js`.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-01 (289th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
- `src/routes/projects.js`: Replaced hardcoded `_TASK_SHOW_LIMIT = 200` and
  the inline `LIMIT 100` in `_showMembersStmt` with the existing `TASK_LIST_CAP`
  and `MEMBER_LIST_CAP` constants from `constants.js`, eliminating two
  out-of-sync magic numbers that previously duplicated values already defined
  in the central constants module.
- `src/routes/staff.js`: Replaced the hardcoded `LIMIT 10` in
  `_assignedTicketsStmt` and `_assignedTasksStmt` with `ASSIGNED_ITEMS_CAP`,
  and the hardcoded `LIMIT 100` in `_projectMembershipsStmt` with
  `MEMBER_LIST_CAP`, keeping all sidebar caps aligned with the constants module.
- `src/routes/assets.js`: Replaced the hardcoded `LIMIT 10` in
  `_relatedTicketsStmt` with `ASSIGNED_ITEMS_CAP`, keeping the asset-show
  related-tickets cap aligned with the staff sidebar and projects task cap.
- `src/routes/tickets.js`: Replaced the hardcoded `LIMIT 500` in
  `_showCommentsStmt` with `COMMENT_LIST_CAP`, keeping the ticket-comments cap
  aligned with the constants module.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-01 (288th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
  `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-10-01 (287th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
 `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-09-30 (286th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
 `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (284th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
 `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
- `src/routes/knowledge.js`: Added `.trim()` to `safeTitle` and `safeContent`
  in `sanitizeKnowledgeInput()` (line 260–261). Without trimming, a title or
  content consisting solely of whitespace characters (e.g. `"   "`, `"\t\n"`)
  would survive HTML sanitization intact, pass the route-level `!safeTitle`
  / `!safeContent` guard, and be stored in the database as a whitespace-only
  value — rendering as a blank page title and breadcrumb. Trimming after
  sanitization ensures that tag-only input (`"<b></b>"` → `""`) and whitespace-
  only input (`"   "` → `""`) both produce empty strings caught by the
  existing guards.

### Regression tests added
- `tests/knowledge.test.js`: Added `sanitizeKnowledgeInput` regression test
  confirming that whitespace-only titles are trimmed to empty strings and that
  normal leading/trailing whitespace is stripped from both title and content.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-09-30 (285th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
 `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1170 passed / 1170 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (283rd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
 `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

# Code Review Notes

**Date:** 2026-09-30
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 12 route modules, 2 middleware modules, models, utils,
constants.
**Method:** Full re-read of all source files plus ESLint, Jest coverage, and
`npm audit`. Prior review history (281 consecutive hardening commits) was
cross-checked. Source code is unchanged; the only modification is a dependency
upgrade to close three moderate/high-severity CVEs in transitive dependencies
(morgan, ip-address, brace-expansion).

---

## Review cycle (282nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
 `safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
- Upgraded `morgan` from 1.12.0 to 1.12.1 — fixes GHSA-9f6g-j8ch-79g4
  (log injection via unescaped double quote in quoted log fields).
- Upgraded `ip-address` from 10.4.0 to 10.7.2 — fixes GHSA-rpw4-54j3-4h4q,
  GHSA-2vr4-cq9g-pvrc, GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw
  (SSRF via incorrect IPv6 link-local / NAT64 classification, family-mismatch
  subnet comparison, and unbounded-parse diagnostic DoS).
- Upgraded `brace-expansion` (v1) from 1.1.18 to 1.1.21 and (v5) from 5.0.9
  to 5.0.12 — fixes GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7,
  GHSA-6j4f-fj2g-mc7p (quadratic-time expansion DoS and uncontrolled
  recursion stack exhaustion on nested brace groups).

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

# Code Review Notes

**Date:** 2026-09-29
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 12 route modules, 2 middleware modules, models, utils, constants.
**Method:** Manual line-by-line review of all source files plus ESLint, Jest
coverage, and `npm audit`. Prior review history (280 consecutive hardening
commits) was cross-checked to confirm findings were not already addressed.

---

## Review cycle (281st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

# Code Review Notes

**Date:** 2026-09-28
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 12 route modules, 2 middleware modules, models, utils, constants.
**Method:** Manual line-by-line review of all source files plus ESLint, Jest
coverage, and `npm audit`. Prior review history (278 consecutive hardening
commits) was cross-checked to confirm findings were not already addressed.

---

## Review cycle (280th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.17% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (279th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.17% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (278th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
- **src/routes/tickets.js**: Added `'status'` to the `rejectHppArrays` guard on
  the ticket create route (POST `/tickets`) so it matches the update route
  (PUT `/tickets/:id`, line 506) and the non-string guard loop (line 243).
  Previously the create route silently accepted array payloads on the `status`
  query parameter — safe because the create handler never reads `req.body.status`
  (status defaults from the DB schema), but inconsistent with the explicit
  fail-closed HPP convention applied uniformly across every other write route.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **85.31% statements / 76.35% branches / 87.96% functions / 85.56% lines** — all above 60% threshold.

---

## Review cycle (277th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **85.31% statements / 76.35% branches / 87.96% functions / 85.56% lines** — all above 60% threshold.

---

## Review cycle (276th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (19 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.20% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (275th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (17 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/PUT/DELETE forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. No unbounded recursion (false positive:
`trim()` in `utils.js:545` calls `String.prototype.trim`, not itself).

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.17% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (274th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.20% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (273rd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors. Outdated
`app.js:676` line references across 13 prior review cycles corrected to
`app.js:684` (the actual dev error-handler line after prior refactor).

### Fixes applied
- **CODE_REVIEW.md**: Replaced every instance of `app.js:676` with `app.js:684`
  across the entire review history to reflect the current location of the
  dev error handler (`console.error((err && err.stack) || err || 'Unknown error')`).

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.17% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (272nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1169 passed / 1169 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **85.31% statements / 76.35% branches / 87.96% functions / 85.56% lines** — all above 60% threshold.

---

## Review cycle (271st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors.

### Fixes applied
- **tests/code_review_220.test.js**: Removed the dangling third element
  (`IS_ACTIVE_BADGE`) from the `VENDOR_CATEGORY_BADGE` entry in
  `badgeEnumPairs` — the `for…of [badgeKey, enumKey]` destructuring silently
  ignored it, leaving IS_ACTIVE_BADGE untested for completeness. Added an
  explicit regression test asserting IS_ACTIVE_BADGE covers exactly the two
  `is_active` values (`0` → `'medium'`, `1` → `'low'`) so the guarantee is
  encoded in the test suite rather than asserted only by hand during reviews.

### Regression tests added
- **tests/code_review_220.test.js**: New assertion `IS_ACTIVE_BADGE covers
  exactly the two is_active values (0 and 1)` — pins the numeric-key contract
  for the only badge mapping that uses integer keys instead of string enum
  values.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-03 (298th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views, `public/js/app.js`, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 templates: 34 page + 5 partial uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. One LOW completeness defect closed: `views/pages/error.ejs`
rendered `error.message` via unescaped `<%= ... %>` interpolation, which was the
only template site not using `escapeHtml()` on a user-path-adjacent value — the
app's error handler derives the message from `(err && err.message) || String(err)`
and the production path always renders the static string "Something went wrong.",
so the practical risk is low, but the template should still follow the same
escape-everything convention as every other EJS site. A corresponding regression
test was added to pin the escaped-output invariant.

### Fixes applied
- `views/pages/error.ejs:7` — added `escapeHtml()` around `error.message` so the
  error-page template is consistent with the app-wide `<%= ... %>` escaping
  convention and cannot leak HTML if a future caller passes a crafted message.
- `tests/code_review_114.test.js` — `renderError` helper now passes
  `escapeHtml` as a local so the regression test renders against the same
  context the real app provides via the global `res.locals` middleware.

### Regression tests added
- **`tests/code_review_298.test.js` — 1 regression test (+1 test):**
  1. Source-code pin: asserts that `views/pages/error.ejs` contains
     `escapeHtml(error.message)` (not a bare `<%= error.message %>`) so a
     future refactor cannot silently reintroduce the unescaped interpolation.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1171 passed / 1171 total** (74 suites, +1 regression test).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.20% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (270th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors.

### Fixes applied
- **tests/reset_cached_statements.test.js**: Added `src/utils` to the module
  checklist so the regression test covers the full set of 15 modules (12 routes
  + 2 middleware + utils) instead of only the 14 route/middleware modules. Mirrors
  the same 15-module enumeration already present in `code_review_220.test.js`.
- **CODE_REVIEW.md**: Replaced every instance of "All 14 route/middleware modules
  export `resetCachedStatements`" with "All 15 modules export `resetCachedStatements`"
  across the entire review history to reflect the corrected module count.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1168 passed / 1168 total** (73 suites, +1 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.20% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (269th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors.

### Fixes applied
- **src/constants.js**: Added explicit `medium` entries to `ACTION_BADGE` for
  `update`, `read`, `login`, `logout`, `deactivate`, `reactivate`, and `comment`
  so the mapping covers all 13 emitted audit actions instead of relying on the
  `badgeClass()` fallback — mirrors the same completeness convention applied to
  all other badge mappings.
- **src/routes/projects.js**: Replaced `priority && !VALID_PRIORITIES.includes(priority)`
  with `priorityProvided && !VALID_PRIORITIES.includes(priority)` on the project
  update route to match the `statusProvided` convention established on the same
  route, eliminating an otherwise cosmetic style inconsistency.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.20% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (268th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.20% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (267th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 14 route/middleware modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.20% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (266th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.20% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (265th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (20 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors.

### Fixes applied
- **src/constants.js**: Added `IS_ACTIVE_BADGE` mapping (`1 → 'low'`, `0 → 'medium'`)
  as the single source of truth for active/inactive badge severity.
- **src/app.js**: Exported `IS_ACTIVE_BADGE` through `TEMPLATE_CONSTANTS` and
  `res.locals` so all templates can reference it.
- **views/partials/nav.ejs**: Guarded `csrfToken` reference with
  `typeof csrfToken !== 'undefined' ? csrfToken : ''` to match the header.ejs
  convention and prevent `undefined` output on edge-case error paths.
- **views/pages/audit/index.ejs**: Replaced fragile `<%- escapeHtml(...)>` in the
  `title` attribute with `<%= ... %>` auto-escaping, eliminating a potential
  `ReferenceError` if `escapeHtml` were ever unavailable as an EJS local.
- **views/pages/staff/index.ejs**: Replaced hardcoded `badge-<%= s.is_active ? 'low' : 'critical' %>`
  with `badgeClass(s.is_active, IS_ACTIVE_BADGE)`. Also fixed invalid HTML5:
  replaced `<div>` inside `<a>` with `<span>` to maintain inline context.
- **views/pages/vendors/index.ejs**: Replaced hardcoded badge with `badgeClass(v.is_active, IS_ACTIVE_BADGE)`.
- **views/pages/vendors/show.ejs**: Replaced hardcoded badge with `badgeClass(vendor.is_active, IS_ACTIVE_BADGE)`.
- **views/pages/vendors/form.ejs**: Replaced hardcoded badge with `badgeClass(vendor.is_active, IS_ACTIVE_BADGE)`.
- **views/pages/staff/show.ejs**: Replaced hardcoded badge with `badgeClass(staffUser.is_active, IS_ACTIVE_BADGE)`.
- **views/pages/tickets/show.ejs**: Replaced empty `data-confirm=""` attribute
  emission with a conditional so the attribute is omitted entirely when no
  confirmation message is needed.
- **src/app.js**: Changed CSRF error fallback redirect from `'/'` to `'/login'`
  for consistency with other auth-failure redirects.
- **src/routes/dashboard.js**: Added content-negotiated 429 response — JSON
  when `Accept: application/json`, plain text otherwise — matching the pattern
  used by the global error handler and 404 handler.
- **src/routes/projects.js**: Replaced truthiness fallback `priority || existing`
  with explicit `priorityProvided ? priority : existing` to match the
  `statusProvided` convention and prevent latent weakness if validation is
  ever relaxed.

### Regression tests added
- **tests/code_review_163.test.js**: Updated audit title-attribute test to
  assert the new auto-escaped `<%= e.details || '' %>` pattern.
- **tests/code_review_209.test.js**: Relaxed `logError` import regex to allow
  additional named imports from `../utils` (e.g. `prefersJson`).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.33% statements / 63.20% branches / 75.39% functions / 66.33% lines** — all above 60% threshold.

---

## Review cycle (264th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (19 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present (false positives: `TEMPLATE_CONSTANTS`
substring match in app.js, `AST-XXX` format example in constants.js/assets.js).
No unbalanced try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.35% statements / 63.24% branches / 75.39% functions / 66.35% lines** — all above 60% threshold.

---

## Review cycle (263rd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (19 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors. README alignment fixed (one trailing
space missing on `npm run test:coverage` line).

### Fixes applied
- **README.md**: Fixed alignment of `npm run test:coverage` line in the
  Scripts code block (missing space before `#`).

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.
- Coverage: **66.35% statements / 63.24% branches / 75.39% functions / 66.35% lines** — all above 60% threshold.

---

## Review cycle (262nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (19 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors.

### Fixes applied
- **tests/session_timeout.test.js**: Fixed flaky absolute-timeout test. The
  previous 500ms timeout with 100ms first-sleep margin was too tight under
  parallel-Jest load — the event loop could delay the first check-in past the
  500ms threshold, producing a 302 instead of the expected 200. Raised the
  absolute timeout to 1000ms and increased the second sleep to 1500ms (total
  ~1600ms), providing 900ms headroom before expiry and 600ms headroom after
  expiry, making both assertions deterministic under any load.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (261st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (19 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 14 route/middleware modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (260th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (19 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (259th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string; the dev error handler at `app.js:684` intentionally
logs the full stack via `(err && err.stack) || err || 'Unknown error'`), all
form-processing routes carry `rejectHppArrays` guards, badge rendering across
all 39 EJS templates uses `badgeClass()` with enum-specific fallbacks (with one
documented deviation in `reports/assets.ejs` for a 3-tier computed warranty
urgency that the 2-key `WARRANTY_DEADLINE_BADGE` mapping cannot express), all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard (or a ternary sentinel), all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped
in asyncHandler. Automated cross-references verified: every badge mapping in
`constants.js` covers all its corresponding enum exactly (19 mappings checked,
zero missing/extra keys), every template `badgeClass()` call references an
existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the union
of all emitted audit actions across the codebase (13 emitted actions, zero gaps),
and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in audit calls
(13 emitted entities, zero gaps). All 15 modules export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded:
`_countQueryCache` and `_selectQueryCache` capped at 500 entries with LRU
eviction, `dashboardCache` TTL-based (1s–1h clamped), login-failure Maps purged
every 10 minutes and at capacity via stale-then-oldest eviction, KB view-
tracking array capped at 200 entries. Session security verified: session
regenerated on login, profile update, and password change; idle/absolute
timeouts enforced via middleware; `secure` cookie flag correctly toggled by
`NODE_ENV`. No `eval()`, `new Function()`, or dangerous template patterns
(`innerHTML`, `document.write`, `javascript:` URLs) detected. All exported
constants and utility functions are referenced in at least one route, middleware,
or test module. No TODO/FIXME/HACK markers present. No unbalanced try/catch
blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (258th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required
by the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
- `src/app.js`: corrected `_OVERRIDE_METHODS` comment to list only `PUT/DELETE`
  (not `PATCH`) to match the actual allowlist, eliminating a misleading
  description of the method-override guard.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (257th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 route/middleware/utils modules export `resetCachedStatements` as required
by the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (256th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (255th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (254th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (253rd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (252nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (251st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (250th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (249th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
- **`CODE_REVIEW.md` — stale template count in 248th pass (LOW, documentation).**
  Updated "34 templates: 29 page + 5 partial" to "39 templates: 34 page + 5
  partial" to match the actual file count (`find views -name '*.ejs' | wc -l`
  returns 39: 34 under `views/pages/` plus 5 under `views/partials/`). The
  earlier passes (247 and prior) had the correct count; cycle 248 regressed.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (248th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (247th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. All
exported constants and utility functions are referenced in at least one route,
middleware, or test module. No TODO/FIXME/HACK markers present. No unbalanced
try/catch blocks. No prototype pollution vectors.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (246th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (245th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (243rd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected.

### Fixes applied
- **`package.json` — `tests/jest.setup.js` moved from `setupFiles` to
  `setupFilesAfterEnv`.** The file uses `jest.mock()` which semantically
  belongs with the test framework setup phase. While Jest injects the global
  `jest` object early enough that the previous arrangement worked in practice,
  placing a module mock in `setupFiles` (which runs before the test framework
  is installed) is architecturally incorrect — a future Jest version or
  configuration change could break it. Moving it to `setupFilesAfterEnv`
  aligns the mock with the framework lifecycle and matches the convention
  used by the root `jest.setup.js` (which also contains framework-dependent
  patches).

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (242nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. One LOW
consistency note (carry-forward from cycle 224): `reports/assets.ejs` renders
warranty-day urgency badges with an inline numeric ternary (`days <= 30 →
'critical'`, `days <= 60 → 'high'`, else `'medium'`) rather than the
`badgeClass()` convention. This is deliberate — the value is a computed integer
(not a stored enum), and the same file's progress bars already use an equivalent
inline color ternary for condition severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (241st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. One LOW
consistency note (carry-forward from cycle 224): `reports/assets.ejs` renders
warranty-day urgency badges with an inline numeric ternary (`days <= 30 →
'critical'`, `days <= 60 → 'high'`, else `'medium'`) rather than the
`badgeClass()` convention. This is deliberate — the value is a computed integer
(not a stored enum), and the same file's progress bars already use an equivalent
inline color ternary for condition severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (240th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. One LOW
consistency note (carry-forward from cycle 224): `reports/assets.ejs` renders
warranty-day urgency badges with an inline numeric ternary (`days <= 30 →
'critical'`, `days <= 60 → 'high'`, else `'medium'`) rather than the
`badgeClass()` convention. This is deliberate — the value is a computed integer
(not a stored enum), and the same file's progress bars already use an equivalent
inline color ternary for condition severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (239th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (19 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. One LOW
consistency note (carry-forward from cycle 224): `reports/assets.ejs` renders
warranty-day urgency badges with an inline numeric ternary (`days <= 30 →
'critical'`, `days <= 60 → 'high'`, else `'medium'`) rather than the
`badgeClass()` convention. This is deliberate — the value is a computed integer
(not a stored enum), and the same file's progress bars already use an equivalent
inline color ternary for condition severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (238th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (16 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules export `resetCachedStatements` as required by
the API-contract test. Cross-cutting consistency checks confirmed: all EJS
templates have balanced tag pairs (zero mismatches; the `nav.ejs` partial opens
`<div class="main-content">` and every page that includes it also includes
`nav-close.ejs` which closes it, while login/404/error pages omit both and use
self-contained div structures), all POST/mutate forms carry CSRF hidden inputs
(including all `_method=PUT`/`_method=DELETE` overrides), all redirect targets
are same-origin pathnames (no open-redirect vectors — every `res.redirect()`
uses either a hardcoded same-origin path or `safeId()`-validated numeric IDs
interpolated into relative path strings), and all form action URLs are relative.
Memory-leak surface bounded: `_countQueryCache` and `_selectQueryCache` capped
at 500 entries with LRU eviction, `dashboardCache` TTL-based (1s–1h clamped),
login-failure Maps purged every 10 minutes and at capacity via stale-then-oldest
eviction, KB view-tracking array capped at 200 entries. Session security
verified: session regenerated on login, profile update, and password change;
idle/absolute timeouts enforced via middleware; `secure` cookie flag correctly
toggled by `NODE_ENV`. No `eval()`, `new Function()`, or dangerous template
patterns (`innerHTML`, `document.write`, `javascript:` URLs) detected. One LOW
consistency note (carry-forward from cycle 224): `reports/assets.ejs` renders
warranty-day urgency badges with an inline numeric ternary (`days <= 30 →
'critical'`, `days <= 60 → 'high'`, else `'medium'`) rather than the
`badgeClass()` convention. This is deliberate — the value is a computed integer
(not a stored enum), and the same file's progress bars already use an equivalent
inline color ternary for condition severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (237th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (16 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 16 modules (12 routes + 2 middleware + utils + app.js) export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded: `_countQueryCache`
and `_selectQueryCache` capped at 500 entries with LRU eviction, `dashboardCache`
TTL-based (1s–1h clamped), login-failure Maps purged every 10 minutes and at
capacity via stale-then-oldest eviction, KB view-tracking array capped at 200
entries. Session security verified: session regenerated on login, profile
update, and password change; idle/absolute timeouts enforced via middleware;
`secure` cookie flag correctly toggled by `NODE_ENV`. One LOW consistency note
(carry-forward from cycle 224): `reports/assets.ejs` renders warranty-day
urgency badges with an inline numeric ternary (`days <= 30 → 'critical'`,
`days <= 60 → 'high'`, else `'medium'`) rather than the `badgeClass()` convention.
This is deliberate — the value is a computed integer (not a stored enum), and
the same file's progress bars already use an equivalent inline color ternary for
condition severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (236th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (16 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 16 modules (12 routes + 2 middleware + utils + app.js) export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded: `_countQueryCache`
and `_selectQueryCache` capped at 500 entries with LRU eviction, `dashboardCache`
TTL-based (1s–1h clamped), login-failure Maps purged every 10 minutes and at
capacity via stale-then-oldest eviction, KB view-tracking array capped at 200
entries. Session security verified: session regenerated on login, profile
update, and password change; idle/absolute timeouts enforced via middleware;
`secure` cookie flag correctly toggled by `NODE_ENV`. One LOW consistency note
(carry-forward from cycle 224): `reports/assets.ejs` renders warranty-day
urgency badges with an inline numeric ternary (`days <= 30 → 'critical'`,
`days <= 60 → 'high'`, else `'medium'`) rather than the `badgeClass()` convention.
This is deliberate — the value is a computed integer (not a stored enum), and
the same file's progress bars already use an equivalent inline color ternary for
condition severity. No action needed.

### Fixes applied
- **`src/utils.js` — `logger.log` replaced with `logger.info` in
  `createAuditLogPruner` (LOW, consistency).** The success-path message used
  `logger.log` while the adjacent error and warning paths used
  `logger.error`/`logger.warn`, violating the standard log-level convention
  (`info` for informational messages, `error` for failures, `warn` for
  cautions). Changed to `logger.info` so the default-logger path (`console`)
  emits at the correct level, matching the convention used by all other
  structured logging in the app.
- **`tests/audit-prune.test.js` — updated mock logger shape to match
  `logger.info` (LOW, test consistency).** The `makeLogger` helper and the
  assertion in the "logs a count message" test were updated from `log` to
  `info` so the regression test continues to pin the fix.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (235th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (16 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 16 modules (12 routes + 2 middleware + utils + app.js) export
`resetCachedStatements` as required by the API-contract test. Cross-cutting
consistency checks confirmed: all EJS templates have balanced tag pairs (zero
mismatches; the `nav.ejs` partial opens `<div class="main-content">` and every
page that includes it also includes `nav-close.ejs` which closes it, while
login/404/error pages omit both and use self-contained div structures), all
POST/mutate forms carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE`
overrides), all redirect targets are same-origin pathnames (no open-redirect
vectors — every `res.redirect()` uses either a hardcoded same-origin path or
`safeId()`-validated numeric IDs interpolated into relative path strings), and
all form action URLs are relative. Memory-leak surface bounded: `_countQueryCache`
and `_selectQueryCache` capped at 500 entries with LRU eviction, `dashboardCache`
TTL-based (1s–1h clamped), login-failure Maps purged every 10 minutes and at
capacity via stale-then-oldest eviction, KB view-tracking array capped at 200
entries. Session security verified: session regenerated on login, profile
update, and password change; idle/absolute timeouts enforced via middleware;
`secure` cookie flag correctly toggled by `NODE_ENV`. One LOW completeness note
(carry-forward from cycle 224): `reports/assets.ejs` renders warranty-day
urgency badges with an inline numeric ternary (`days <= 30 → 'critical'`,
`days <= 60 → 'high'`, else `'medium'`) rather than the `badgeClass()` convention.
This is deliberate — the value is a computed integer (not a stored enum), and
the same file's progress bars already use an equivalent inline color ternary for
condition severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (234th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard (or a ternary sentinel),
all write routes audit their operations and invalidate the dashboard cache,
and all async routes are wrapped in asyncHandler. Automated cross-references
verified: every badge mapping in `constants.js` covers all its corresponding
enum exactly (16 mappings checked, zero missing/extra keys), every template
`badgeClass()` call references an existing mapping key (all resolved),
`ALLOWED_ACTIONS` exactly matches the union of all emitted audit actions across
the codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules (12 routes + 2 middleware + utils) export `resetCachedStatements`
as required by the API-contract test. Cross-cutting consistency checks confirmed:
all EJS templates have balanced tag pairs (zero mismatches; the `nav.ejs`
partial opens `<div class="main-content">` and every page that includes it also
includes `nav-close.ejs` which closes it, while login/404/error pages omit both
and use self-contained div structures), all POST/mutate forms carry CSRF hidden
inputs (including all `_method=PUT`/`_method=DELETE` overrides), all redirect
targets are same-origin pathnames (no open-redirect vectors — every
`res.redirect()` uses either a hardcoded same-origin path or `safeId()`-validated
numeric IDs interpolated into relative path strings), and all form action URLs
are relative. Memory-leak surface bounded: `_countQueryCache` and
`_selectQueryCache` capped at 500 entries with LRU eviction, `dashboardCache`
TTL-based (1s–1h clamped), login-failure Maps purged every 10 minutes and at
capacity via stale-then-oldest eviction, KB view-tracking array capped at 200
entries. Session security verified: session regenerated on login, profile
update, and password change; idle/absolute timeouts enforced via middleware;
`secure` cookie flag correctly toggled by `NODE_ENV`. One LOW completeness note
(carry-forward from cycle 224): `reports/assets.ejs` renders warranty-day
urgency badges with an inline numeric ternary (`days <= 30 → 'critical'`,
`days <= 60 → 'high'`, else `'medium'`) rather than the `badgeClass()` convention.
This is deliberate — the value is a computed integer (not a stored enum), and
the same file's progress bars already use an equivalent inline color ternary for
condition severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (232nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. Automated cross-references verified: every badge
mapping in `constants.js` covers all its corresponding enum exactly (16 mappings
checked, zero missing/extra keys), every template `badgeClass()` call references
an existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the
union of all emitted audit actions across the codebase (13 emitted actions, zero
gaps), and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in
audit calls (13 emitted entities, zero gaps). All 15 modules (12 routes + 2
middleware + utils) export `resetCachedStatements` as required by the
API-contract test. Cross-cutting consistency checks confirmed: all EJS templates
have balanced tag pairs (zero mismatches), all POST/mutate forms carry CSRF
hidden inputs (including all `_method=PUT`/`_method=DELETE` overrides), all
redirect targets are same-origin pathnames (no open-redirect vectors), and all
form action URLs are relative. One LOW completeness note (carried forward
from cycle 224): `reports/assets.ejs` renders warranty-day urgency badges with
an inline numeric ternary (`days <= 30 → 'critical'`, `days <= 60 → 'high'`,
else `'medium'`) rather than the `badgeClass()` convention. This is deliberate
— the value is a computed integer (not a stored enum), and the same file's
progress bars already use an equivalent inline color ternary for condition
severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (230th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. Automated cross-references verified: every badge
mapping in `constants.js` covers all its corresponding enum exactly (16 mappings
checked, zero missing/extra keys), every template `badgeClass()` call references
an existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the
union of all emitted audit actions across the codebase (13 emitted actions, zero
gaps), and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in
audit calls (13 emitted entities, zero gaps). All 15 modules (12 routes + 2
middleware + utils) export `resetCachedStatements` as required by the
API-contract test. Cross-cutting consistency checks confirmed: all EJS templates
have balanced tag pairs (zero mismatches), all POST/mutate forms carry CSRF
hidden inputs (including all `_method=PUT`/`_method=DELETE` overrides), all
redirect targets are same-origin pathnames (no open-redirect vectors), and all
form action URLs are relative. One LOW completeness note (carried forward
from cycle 224): `reports/assets.ejs` renders warranty-day urgency badges with
an inline numeric ternary (`days <= 30 → 'critical'`, `days <= 60 → 'high'`,
else `'medium'`) rather than the `badgeClass()` convention. This is deliberate
— the value is a computed integer (not a stored enum), and the same file's
progress bars already use an equivalent inline color ternary for condition
severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (229th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. Automated cross-references verified: every badge
mapping in `constants.js` covers all its corresponding enum exactly (16 mappings
checked, zero missing/extra keys), every template `badgeClass()` call references
an existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the
union of all emitted audit actions across the codebase (13 emitted actions, zero
gaps), and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in
audit calls (13 emitted entities, zero gaps). All 15 modules (12 routes + 2
middleware + utils) export `resetCachedStatements` as required by the
API-contract test. Cross-cutting consistency checks confirmed: all EJS templates
have balanced tag pairs (zero mismatches), all POST/mutate forms carry CSRF
hidden inputs (including all `_method=PUT`/`_method=DELETE` overrides), all
redirect targets are same-origin pathnames (no open-redirect vectors), and all
form action URLs are relative. One LOW completeness note (carried forward
from cycle 224): `reports/assets.ejs` renders warranty-day urgency badges with
an inline numeric ternary (`days <= 30 → 'critical'`, `days <= 60 → 'high'`,
else `'medium'`) rather than the `badgeClass()` convention. This is deliberate
— the value is a computed integer (not a stored enum), and the same file's
progress bars already use an equivalent inline color ternary for condition
severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (228th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. Automated cross-references verified: every badge
mapping in `constants.js` covers all its corresponding enum exactly (16 mappings
checked, zero missing/extra keys), every template `badgeClass()` call references
an existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the
union of all emitted audit actions across the codebase (13 emitted actions, zero
gaps), and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in
audit calls (13 emitted entities, zero gaps). All 15 modules (12 routes + 2
middleware + utils) export `resetCachedStatements` as required by the
API-contract test. Cross-cutting consistency checks confirmed: all EJS templates
have balanced tag pairs (zero mismatches), all POST/mutate forms carry CSRF
hidden inputs (including all `_method=PUT`/`_method=DELETE` overrides), all
redirect targets are same-origin pathnames (no open-redirect vectors), and all
form action URLs are relative. One LOW completeness note (carried forward
from cycle 224): `reports/assets.ejs` renders warranty-day urgency badges with
an inline numeric ternary (`days <= 30 → 'critical'`, `days <= 60 → 'high'`,
else `'medium'`) rather than the `badgeClass()` convention. This is deliberate
— the value is a computed integer (not a stored enum), and the same file's
progress bars already use an equivalent inline color ternary for condition
severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. Automated cross-references verified: every badge
mapping in `constants.js` covers all its corresponding enum exactly (16 mappings
checked, zero missing/extra keys), every template `badgeClass()` call references
an existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly matches the
union of all emitted audit actions across the codebase (13 emitted actions, zero
gaps), and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used in
audit calls (13 emitted entities, zero gaps). All 15 modules (12 routes + 2
middleware + utils) export `resetCachedStatements` as required by the
API-contract test. Cross-cutting consistency checks confirmed: all EJS templates
have balanced tag pairs (zero mismatches), all POST/mutate forms carry CSRF
hidden inputs (including all `_method=PUT`/`_method=DELETE` overrides), all
redirect targets are same-origin pathnames (no open-redirect vectors), and all
form action URLs are relative. Fixed stale template count in review cycles 224
and 223: updated "34 templates" to "39 templates" to reflect the actual count
(34 page templates + 5 partials). One LOW completeness note (carried forward
from cycle 224): `reports/assets.ejs` renders warranty-day urgency badges with
an inline numeric ternary (`days <= 30 → 'critical'`, `days <= 60 → 'high'`,
else `'medium'`) rather than the `badgeClass()` convention. This is deliberate
— the value is a computed integer (not a stored enum), and the same file's
progress bars already use an equivalent inline color ternary for condition
severity. No action needed.

### Fixes applied
- **`CODE_REVIEW.md` — stale template count in cycles 224 and 223 (LOW,
  documentation).** Updated "34 templates" to "39 templates" in the scope
  line and badge-rendering sentence of both the 224th and 223rd review entries.
  The actual count is 34 page templates under `views/pages/` plus 5 partials
  under `views/partials/`, for a total of 39 `.ejs` files.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (224th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates), `public/js/app.js`, the test suite,
and the `CODE_REVIEW.md` history. **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at the
same hardening plateau — all `console.error` sites use the `(err && err.message)
|| String(err)` null guard (or log a static string), all form-processing routes
carry `rejectHppArrays` guards, badge rendering across all 39 templates (34 page + 5 partial) uses
`badgeClass()` with enum-specific fallbacks, all nullable enum values passed to
`titleCase()` in templates carry the established `|| 'default'` guard, all write
routes audit their operations and invalidate the dashboard cache, and all async
routes are wrapped in asyncHandler. Automated cross-references verified: every
badge mapping in `constants.js` covers all its corresponding enum exactly (16
mappings checked, zero missing/extra keys), every template `badgeClass()` call
references an existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly
matches the union of all emitted audit actions across the codebase (13 emitted
actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly matches all entity values
used in audit calls (13 emitted entities, zero gaps). All 15 modules (12 routes +
2 middleware + utils) export `resetCachedStatements` as required by the
API-contract test. Cross-cutting consistency checks confirmed: all EJS templates
have balanced tag pairs (zero mismatches), all POST/mutate forms carry CSRF
hidden inputs (including all `_method=PUT`/`_method=DELETE` overrides), all
redirect targets are same-origin pathnames (no open-redirect vectors), and all
form action URLs are relative. One LOW completeness note: `reports/assets.ejs`
renders warranty-day urgency badges with an inline numeric ternary
(`days <= 30 → 'critical'`, `days <= 60 → 'high'`, else `'medium'`) rather than
the `badgeClass()` convention. This is deliberate — the value is a computed
integer (not a stored enum), and the same file's progress bars already use an
equivalent inline color ternary for condition severity. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (223rd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates), `public/js/app.js`, the test suite,
and the `CODE_REVIEW.md` history. **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at the
same hardening plateau — all `console.error` sites use the `(err && err.message)
|| String(err)` null guard (or log a static string), all form-processing routes
carry `rejectHppArrays` guards, badge rendering across all 39 templates (34 page + 5 partial) uses
`badgeClass()` with enum-specific fallbacks, all nullable enum values passed to
`titleCase()` in templates carry the established `|| 'default'` guard, all write
routes audit their operations and invalidate the dashboard cache, and all async
routes are wrapped in asyncHandler. Automated cross-references verified: every
badge mapping in `constants.js` covers all its corresponding enum exactly (16
mappings checked, zero missing/extra keys), every template `badgeClass()` call
references an existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly
matches the union of all emitted audit actions across the codebase (13 emitted
actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly matches all entity values
used in audit calls (13 emitted entities, zero gaps). All 15 modules (12 routes +
2 middleware + utils) export `resetCachedStatements` as required by the
API-contract test. Cross-cutting consistency checks confirmed: all EJS templates
have balanced tag pairs (1575 total tags, zero mismatches), all POST/mutate forms
carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE` overrides),
all redirect targets are same-origin pathnames (no open-redirect vectors), and
all form action URLs are relative. One LOW test-stability fix applied: the
session-absolute-timeout integration test used a 2000 ms timeout with 400 ms +
1600 ms sleeps — under parallel-Jest load the event-loop delay could push the
actual elapsed time just under the strict `> 2000` threshold, causing an
intermittent failure. Reduced the timeout to 500 ms and adjusted the sleeps to
100 ms + 1000 ms (1100 ms total, 600 ms of headroom) so the result is deterministic
regardless of test-suite load.

### Fixes applied
- **`tests/session_timeout.test.js` — flaky absolute-timeout test tightened margin
  (LOW, test stability).** Reduced `absoluteMs` from 2000 to 500 and changed the
  sleep sequence from `400 + 1600` to `100 + 1000`. The original 2000 ms boundary
  sat only ~8 ms above the threshold when run in isolation; parallel-Jest worker
  load could shift it just below, causing an intermittent `expect(302).toBe(200)`
  failure. The new 500 ms timeout with 1100 ms of total sleep time gives 600 ms of
  headroom, eliminating the race without changing the exercised invariant.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (222nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, EJS views (39 templates), `public/js/app.js`, the test suite,
and the `CODE_REVIEW.md` history. **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at the
same hardening plateau — all `console.error` sites use the `(err && err.message)
|| String(err)` null guard (or log a static string), all form-processing routes
carry `rejectHppArrays` guards, badge rendering across all 39 templates (34 page + 5 partial) uses
`badgeClass()` with enum-specific fallbacks, all nullable enum values passed to
`titleCase()` in templates carry the established `|| 'default'` guard, all write
routes audit their operations and invalidate the dashboard cache, and all async
routes are wrapped in asyncHandler. Automated cross-references verified: every
badge mapping in `constants.js` covers all its corresponding enum exactly (16
mappings checked, zero missing/extra keys), every template `badgeClass()` call
references an existing mapping key (all resolved), `ALLOWED_ACTIONS` exactly
matches the union of all emitted audit actions across the codebase (13 emitted
actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly matches all entity values
used in audit calls (13 emitted entities, zero gaps). All 15 modules (12 routes +
2 middleware + utils) export `resetCachedStatements` as required by the
API-contract test. Cross-cutting consistency checks confirmed: all EJS templates
have balanced tag pairs (1575 total tags, zero mismatches), all POST/mutate forms
carry CSRF hidden inputs (including all `_method=PUT`/`_method=DELETE` overrides),
all redirect targets are same-origin pathnames (no open-redirect vectors), and
all form action URLs are relative. One LOW completeness improvement: regression
tests from pass 221 now pin every cross-reference assertion so the full
consistency matrix is enforced automatically on every CI run.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (221st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, the test suite, and the `CODE_REVIEW.md`
history. **No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. Automated cross-references verified: every badge
mapping in `constants.js` covers all its corresponding enum exactly (16 mappings
checked, zero missing/extra keys), every template `badgeClass()` call references
an existing mapping key (47 calls, all resolved), `ALLOWED_ACTIONS` exactly
matches the union of all `req.audit()` and direct `audit()` calls across the
codebase (13 emitted actions, zero gaps), and `ALLOWED_ENTITY_TYPES` exactly
matches all entity values used in audit calls (13 emitted entities, zero gaps).
All 15 modules (12 routes + 2 middleware + utils) export `resetCachedStatements`
as required by the API-contract test. One LOW completeness improvement:
`code_review_220.test.js` now pins the automated cross-reference assertions
(badge enums, template keys, action/entity allowlists, module exports) so they
are regression-tested on every CI run rather than relying on manual review alone.

### Fixes applied
None.

### Regression tests added
- **`tests/code_review_220.test.js` — 36 regression tests (+36 tests):**
  1. Every badge mapping (`CONDITION_BADGE` through `VENDOR_CATEGORY_BADGE`) covers
     its corresponding enum exactly — no missing keys and no extra dead keys.
  2. Every `badgeClass()` call across all 39 EJS templates resolves to an existing
     constant mapping — no typo'd or stale keys can slip through.
  3. `ALLOWED_ACTIONS` is the exact union of all emitted audit actions across the
     codebase — no unlisted action can be emitted and no listed action is dead.
  4. `ALLOWED_ENTITY_TYPES` is the exact union of all emitted audit entity types —
     same tight contract as actions.
  5. All 15 core modules export `resetCachedStatements` as a non-throwing function.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +36 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (220th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, the test suite, and the `CODE_REVIEW.md`
history. **No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. Automated cross-references verified: every badge
mapping in `constants.js` covers all its corresponding enum exactly, every
template `badgeClass()` call references an existing mapping key,
`ALLOWED_ACTIONS` exactly matches the union of all `req.audit()` and direct
`audit()` calls across the codebase (login/logout/login_failed/login_blocked/
login_rate_limited are emitted by `auth.js` via the direct helper, not
`req.audit`), and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used
in audit calls. All 15 modules (12 routes + 2 middleware + utils) export
`resetCachedStatements` as required by the API-contract test.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1131 passed / 1131 total** (72 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (219th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, the test suite, and the `CODE_REVIEW.md`
history. **No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. Automated cross-references verified: every badge
mapping in `constants.js` covers all its corresponding enum exactly, every
template `badgeClass()` call references an existing mapping key,
`ALLOWED_ACTIONS` exactly matches the union of all `req.audit()` and direct
`audit()` calls across the codebase (login/logout/login_failed/login_blocked/
login_rate_limited are emitted by `auth.js` via the direct helper, not
`req.audit`), and `ALLOWED_ENTITY_TYPES` exactly matches all entity values used
in audit calls. All 15 modules (12 routes + 2 middleware + utils) export
`resetCachedStatements` as required by the API-contract test. One LOW consistency
note: the `reports/tickets.ejs` progress bar uses a hardcoded
`priority → color` ternary (`'critical'→'red'`, `'high'→'orange'`, else
`'blue'`) rather than the `badgeClass()` convention. This is deliberate —
progress bars and badges serve different visual purposes and the color mapping is
not a severity enum lookup. No action needed.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1131 passed / 1131 total** (72 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (218th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. One LOW consistency defect closed: the audit log index
page rendered action badges with an inline ternary (`['delete', 'login_failed',
...]`) rather than the app-wide `badgeClass()` convention used by all other 38
templates. This broke the single-source-of-truth pattern — adding a new audit
action in the future would require updating both `ALLOWED_ACTIONS` and the
template ternary, inviting silent drift. Added an `ACTION_BADGE` mapping
constant to `constants.js` and switched the template to `badgeClass(e.action,
CONSTANTS.ACTION_BADGE)` so severity logic lives alongside every other badge
mapping.

### Fixes applied
- **`src/constants.js` — added `ACTION_BADGE` constant (LOW, consistency).**
  New frozen mapping: `delete/login_failed/login_blocked/login_rate_limited/
  access_denied → 'critical'`, `create → 'low'`, everything else falls through
  to the `badgeClass()` default `'medium'`. Mirrors the same severity model
  used by all existing badge mappings.
- **`src/app.js` — exposed `ACTION_BADGE` via `TEMPLATE_CONSTANTS` and
  `res.locals` (consistency).** Templates can now reference
  `CONSTANTS.ACTION_BADGE` just like every other badge mapping.
- **`views/pages/audit/index.ejs:27` — replaced inline ternary with
  `badgeClass(e.action || 'unknown', CONSTANTS.ACTION_BADGE)` (LOW,
  consistency).** The audit page now follows the same badge rendering
  convention as all other templates, ensuring future action additions only
  require updating `constants.js`.

### Regression tests added
- **`tests/code_review_218.test.js` — 4 regression tests (+4 tests):**
  1. Source-code pin: asserts `constants.js` exports `ACTION_BADGE`.
  2. Value pin: asserts `delete/login_failed/login_blocked/login_rate_limited/
     access_denied` map to `'critical'` and `create` maps to `'low'`.
  3. Template pin: asserts `audit/index.ejs` uses `badgeClass(e.action ||
     'unknown', CONSTANTS.ACTION_BADGE)` and no longer contains the old inline
     ternary.
  4. Wiring pin: asserts `app.js` passes `ACTION_BADGE` through both
     `TEMPLATE_CONSTANTS` and `res.locals`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1131 passed / 1131 total** (72 suites, +4 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (217th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. One LOW consistency defect closed: the
`sanitizeKnowledgeInput` catch block in `knowledge.js` accessed
`sanitizeErr.message` directly without the app-wide null guard. While
`sanitizeErr` is almost always an Error object in practice (thrown by the
`sanitize-html` library or JS engine), the inconsistent pattern leaves a latent
crash risk if a non-Error value ever slips through. Changed to
`(sanitizeErr && sanitizeErr.message) || String(sanitizeErr)` to match the
convention used at all other logging sites across the codebase.

### Fixes applied
- **`src/routes/knowledge.js:267` — `sanitizeErr.message` missing null guard
  (LOW, consistency).** The `sanitizeKnowledgeInput` catch block called
  `sanitizeErr.message` directly, unlike the `(err && err.message) ||
  String(err)` pattern used at all other error-handling sites. Unified the
  pattern so a stray non-Error throw cannot crash the caller with a TypeError.

### Regression tests added
- **`tests/code_review_217.test.js` — 3 regression tests (+3 tests):**
  1. Source-code pin: asserts that `knowledge.js` contains the inline guard
     pattern `(sanitizeErr && sanitizeErr.message) || String(sanitizeErr)`.
  2. Source-code pin: asserts the old bare `sanitizeErr.message` pattern is gone.
  3. Handler-level: verifies `sanitizeKnowledgeInput()` returns the expected
     shape for valid input (sanity check that the fix did not break happy path).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1127 passed / 1127 total** (71 suites, +3 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (214th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. One LOW completeness defect closed: the reports index
route (`GET /reports`) logged its read audit with entity type `'report'`, but
that string was absent from `ALLOWED_ENTITY_TYPES` in constants.js. The audit
middleware catches the thrown `Error("Invalid audit entity: \"report\"")`
silently, so the reports index view was leaving no trail in the audit log.
Added `'report'` to the allowlist so the index audit fires correctly.

### Fixes applied
- **`src/constants.js:62` — `ALLOWED_ENTITY_TYPES` missing `'report'` (LOW, completeness).**
  The reports index route (`GET /reports`) called `req.audit('read', 'report',
  null, 'Viewed reports index')`, but `'report'` was not listed in the frozen
  `ALLOWED_ENTITY_TYPES` array. The audit middleware validates every entity
  against the allowlist and throws on mismatch; the throw is swallowed by the
  middleware's own try/catch, so the read audit was silently dropped with no
  error surfacing to the operator. Added `'report'` to the allowlist so the
  index audit entry is written correctly.

### Regression tests added
- **`tests/code_review_214.test.js` — 3 regression tests (+3 tests):**
  1. Source-code pin: parses all `req.audit()` calls in `reports.js` and asserts
     each entity type is present in `ALLOWED_ENTITY_TYPES`.
  2. Source-code pin: asserts `ALLOWED_ENTITY_TYPES` includes `'report'`.
  3. Full-audit sweep: iterates every route module, extracts all entity types
     from `req.audit()` calls, and asserts every one is in
     `ALLOWED_ENTITY_TYPES` (and every action is in `ALLOWED_ACTIONS`).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1124 passed / 1124 total** (70 suites, +3 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (213th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. One LOW consistency
defect closed: the comment on the vendors.js update-route contract-start date
validation referenced sibling routes `(assets, projects, licenses)` but omitted
`changes`, which also shares the identical malformed-date fail-closed pattern
via `_resolveClearableDate`. Updated the cross-reference to enumerate all four
sibling update routes that enforce the same contract.

### Fixes applied
- **`src/routes/vendors.js:502` — date-validation cross-reference missing `changes` (LOW, consistency).**
  The comment on the contract-start validation guard enumerated
  `(assets, projects, licenses)` as the sibling update routes sharing the
  malformed-date fail-closed pattern, but `changes.js` also uses the identical
  `_resolveClearableDate` contract for its scheduled/actual datetime fields.
  Added `, changes` to the cross-reference so the comment accurately reflects
  all four sibling routes.

### Regression tests added
None — the fix is a comment update only, not a behavior change. The existing
source-code pin assertions in `tests/code_review_197.test.js` (which verify the
fail-closed date-validation pattern is present on every update route) remain
valid and unchanged.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1121 passed / 1121 total** (69 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (208th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all 91
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. One LOW completeness
defect closed: the self-role-change denial in `staff.js` PUT /:id wrote no
`access_denied` audit entry, unlike every other privilege-boundary denial in
the same handler (privileged-role assignment, admin-protection). An admin
probing the self-role gate left no trail, which was inconsistent with the
audit convention.

### Fixes applied
- **`src/routes/staff.js:494-497` — self-role-change denial omitted access_denied audit (LOW, completeness).**
  The `PUT /:id` handler's privileged-role guard (line 489) and admin-protection
  guard (line 501) both recorded `access_denied` when the condition fired, but
  the self-role-change guard (line 494) only flashed and redirected — the
  identical denial condition without a trail. Added
  `req.audit('access_denied', 'user', id, 'Unauthorized self-role-change attempt')`
  before the flash so the denial leaves an audit entry consistent with the
  sibling privilege gates in the same handler.

### Regression tests added
- **`tests/code_review_208.test.js` — 2 regression tests (+2 tests):**
  1. Handler-level: `PUT /:id` with an admin whose id matches the session user
     and a different `safeRole` redirects to `/staff`, flashes the self-role
     denial message, AND records an `access_denied` audit entry with the
     exact `'Unauthorized self-role-change attempt'` details string.
  2. Source-code pin: asserts that `staff.js` contains the
     `self-role-change attempt` audit string and that it appears after the
     `Number(id) === Number(req.session.user.id) && safeRole !== req.session.user.role`
     guard (not after the privileged-role guard above it).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1116 passed / 1116 total** (67 suites, +2 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (207th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, or error-leakage defects were found.**
One correctness defect closed: two badge constants (`TASK_DEADLINE_BADGE` and
`WARRANTY_DEADLINE_BADGE`) were included in `TEMPLATE_CONSTANTS` (available via
`res.locals.CONSTANTS`) but were never individually wired into `res.locals`.
Every other badge constant consumed by templates was correctly wired; these two
were silently missed because the existing `res.locals` wiring guard in
`templates.test.js` only checked the 16 badge constants that are also exported
from `utils.js` — `TASK_DEADLINE_BADGE` and `WARRANTY_DEADLINE_BADGE` live only
in `constants.js` and were not part of that set. The result: any project show
page with an overdue or due-soon task, or any asset show page with an expired
or expiring warranty, would crash at render time with `ReferenceError`.

### Fixes applied
- **`src/app.js` — `TASK_DEADLINE_BADGE` and `WARRANTY_DEADLINE_BADGE` not
  wired to `res.locals` (HIGH, correctness).** Added both to the
  `constantsModule` destructuring and to the per-request `res.locals` wiring
  block so every template can reference them as bare identifiers, matching the
  convention used by all 16 other badge constants.

### Regression tests added
- **`tests/templates.test.js` — three new tests (+3 tests):**
  1. `projects/show` renders overdue and due-soon task deadline badges.
  2. `assets/show` renders expired warranty badge.
  3. `assets/show` renders expiring-soon warranty badge (within 90 days).
- **`tests/templates.test.js` — wiring guard extended (+0 net tests, but stronger
  invariant):** Added explicit assertions that `res.locals.TASK_DEADLINE_BADGE`
  and `res.locals.WARRANTY_DEADLINE_BADGE` are assigned in `app.js` (they are
  not exported from `utils.js`, so the existing `utils[name]` check in the
  loop did not cover them). Also added both to `baseLocals()` so the new
  render tests execute against a faithful replica of the real `res.locals`
  surface.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1114 passed / 1114 total** (66 suites, +3 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (206th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all 89
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. One pre-existing test
flakiness fixed: the session absolute-timeout integration test used a 1-second
window with 400 ms + 700 ms sleeps that occasionally failed under parallel
Jest-worker contention. Bumped the window to 2 seconds and the second sleep
to 1 600 ms to restore a comfortable margin.

### Fixes applied
- **`tests/session_timeout.test.js` — absolute-timeout test flaky under parallel
  Jest load (LOW, test reliability).** The 1 s `absoluteMs` window plus a
  400 ms / 700 ms two-phase sleep sat right on the timing edge; when other
  test suites contended for the event loop the first request sometimes
  arrived after the absolute timeout had already fired, making the "within
  window" assertion fail with a 302 instead of 200. Increased
  `absoluteMs` to 2 000 and the post-within sleep to 1 600 ms so both phases
  have ample margin regardless of scheduler pressure.

### Regression tests added
None — the fix is a timing-margin adjustment, not a behavior change. The
existing test asserts the same invariants (200 within window, 302 after).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1111 passed / 1111 total** (66 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (205th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all 91
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. No fixes needed.

### Fixes applied
None — all previously identified issues were already committed in cycles
186–204 and verified present in the working tree.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1111 passed / 1111 total** (66 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (204th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all 91
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. One low-severity
consistency defect closed: two `console.error` calls in `knowledge.js` logged
`sanitized.error` directly instead of using the app-wide `logError()` helper
that every other route module uses for the same pattern.

### Fixes applied
- **`src/routes/knowledge.js:399,615`** — Replaced `console.error('HTML sanitization error:', sanitized.error)` with
  `logError('HTML sanitization error:', sanitized.error)` at both call sites.
  While `sanitized.error` is already a string (never an Error object), the
  `logError()` helper is the app-wide convention for all error logging across
  route modules, providing a single idiom that handles both Error objects and
  plain strings uniformly. Added `logError` to the utils import.

### Regression tests added
- **`tests/code_review_204.test.js`** — 3 source-code pin tests (+3 tests):
  1. `knowledge.js` imports `logError` from utils.
  2. Both HTML sanitization error sites use `logError()`.
  3. No raw `console.error` with `sanitized.error` argument remains.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1111 passed / 1111 total** (66 suites, +3 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (203rd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all 91
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. Four low-severity
consistency defects closed: a missing `|| ''` fallback on a disabled form field,
redundant CSS `text-transform` alongside `titleCase()`, dead `safeStatus` code
in the task quick-status transaction, and two places where computed urgency
badges (task deadline, warranty expiry) used hardcoded CSS classes instead of
the centralized `badgeClass()` helper with constant mappings.

### Fixes applied
- **`views/pages/staff/form.ejs:16`** — Added `|| ''` fallback to the disabled
  username input value. Without it, a missing `staffMember.username` would
  render `value="undefined"` in the HTML attribute. Mirrors the established
  convention used by every other form field on the page.
- **`views/pages/dashboard.ejs:201`** — Removed redundant
  `style="text-transform:capitalize;"` from the category label. The
  `titleCase()` call already performs casing; the CSS was dead style that
  conflicted with the app-wide convention of relying solely on `titleCase()`.
- **`src/routes/projects.js:838-841`** — Removed the dead `safeStatus`
  assignment and its three downstream references. The status value was already
  validated on lines 825–828 (`VALID_TASK_STATUSES.includes(status)`), so the
  ternary could never take the `existing.status` branch. Replaced with the
  directly-validated `status` variable.
- **`views/pages/projects/show.ejs:87-88`** — Replaced hardcoded
  `badge-critical` / `badge-high` classes with `badgeClass('overdue',
  TASK_DEADLINE_BADGE)` / `badgeClass('due_soon', TASK_DEADLINE_BADGE)`.
- **`views/pages/assets/show.ejs:41-42`** — Replaced hardcoded
  `badge-critical` / `badge-high` classes with `badgeClass('expired',
  WARRANTY_DEADLINE_BADGE)` / `badgeClass('expiring_soon',
  WARRANTY_DEADLINE_BADGE)`.
- **`src/constants.js`** — Added `TASK_DEADLINE_BADGE` and
  `WARRANTY_DEADLINE_BADGE` constant mappings to keep computed urgency badges
  in the same centralized constants as all other badge mappings.
- **`src/app.js`** — Exposed the two new badge constants via `res.locals` so
  templates can access them.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1108 passed / 1108 total** (65 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (202nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all 91
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. One low-severity
consistency defect closed: the view-tracking guard in `knowledge.js` still
carried a redundant `req.session &&` check that could not fail after the
session-initialisation block above it.

### Fixes applied
- **`src/routes/knowledge.js:476`** — Removed the redundant `req.session &&`
  guard from the view-count condition. The preceding block (line 472) already
  verified `req.session` exists and initialised `req.session[VIEWED_KEY]`, so
  the additional `req.session &&` on line 476 was dead defensive plumbing
  that added noise without safety.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1108 passed / 1108 total** (65 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (201st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all 91
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. No fixes needed.

### Fixes applied
None — all previously identified issues were already committed in cycles
186–200 and verified present in the working tree.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1108 passed / 1108 total** (65 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (200th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all 91
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. One low-severity
consistency defect closed: three `db.prepare()` calls still used double-quoted
strings (with single quotes inside) instead of the uniform single-quoted style
with escaped internal quotes that every other statement in the project follows.

### Fixes applied
- **`src/routes/reports.js:130`** — Replaced double-quoted SQL string with
  single-quoted string (with escaped internal quotes) to match the project's
  uniform style for all other `db.prepare()` calls.
- **`src/utils.js:690`** — Identical fix for `_progressUpdateStmt`.
- **`src/utils.js:854`** — Identical fix for `_pruneCutoffStmt`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1108 passed / 1108 total** (65 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (199th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** Four minor issues were identified and fixed: dead `return null`
in `safeId()`, missing `req.session` / `req.session.user` null guards in
`knowledge.js` and `auth.js`, and a double-quoted SQL string in `projects.js`.
The codebase remains at the same hardening plateau — all 91 `console.error`
sites use the `(err && err.message) || String(err)` null guard (or log a static
string), all form-processing routes carry `rejectHppArrays` guards, badge
rendering across all 39 EJS templates uses `badgeClass()` with enum-specific
fallbacks, and all nullable enum values passed to `titleCase()` in templates
carry the established `|| 'default'` guard.

### Fixes applied
- **`src/utils.js:286`** — Removed unreachable `return null` after exhaustive
  type guards in `safeId()`.
- **`src/routes/knowledge.js:472,476`** — Added `req.session` and
  `req.session.user` null guards around session-based view-tracking logic to
  prevent `TypeError` when called outside the normal middleware pipeline.
- **`src/middleware/auth.js:183`** — Added `req` and `req.session` null guards
  to `canAccessResource()` so it returns `false` gracefully instead of throwing
  when invoked without a fully-formed request.
- **`src/routes/projects.js:102`** — Replaced double-quoted SQL string with
  single-quoted string (with escaped internal quotes) to match the project's
  uniform style for all other `db.prepare()` calls.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1108 passed / 1108 total** (65 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (198th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all 91
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. No new regression
tests are needed.

### Fixes applied
None — all previously identified issues were already committed in cycles
186–197 and verified present in the working tree.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1108 passed / 1108 total** (65 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (197th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage defects
were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all templates uses `badgeClass()` with
enum-specific fallbacks, and all nullable enum values passed to `titleCase()`
in templates carry the established `|| 'default'` guard. Four source-code
assertion regression tests were added to pin these invariants so future drift
cannot reintroduce them.

### Fixes applied
None — all previously identified issues were already committed in cycles
186–196 and verified present in the working tree.

### Regression tests added
- **`tests/code_review_197.test.js`** — 4 source-code pin tests (+4 tests):
  1. Middleware modules have no unguarded `err.message` access (strips comments
     and string literals, verifies every remaining `.message` is inside a guard).
  2. Every route module that reads `req.body` or `req.query` carries at least
     one `rejectHppArrays` guard.
  3. No template uses `badge-<%= ... %>` without either `badgeClass()` or an
     `||` fallback.
  4. No template calls `titleCase()` on a nullable DB-field property access
     without an `||` fallback.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1104 passed / 1104 total** (64 suites, +4 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (196th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, or error-leakage defects were
found.** The codebase remains at the same hardening plateau — every
`console.error` site across all 90 call sites uses the `(err && err.message) ||
String(err)` null guard (or logs a static string), all 64 `rejectHppArrays`
guards are present on every write and paginated-list route, badge rendering
across all templates uses `badgeClass()` with enum-specific fallbacks, and all
nullable enum values passed to `titleCase()` in templates carry the established
`|| 'default'` guard. No new regression tests are needed.

### Fixes applied
None — all previously identified issues were already committed in cycles
186–195 and verified present in the working tree.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1100 passed / 1100 total** (63 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (194th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, or error-leakage defects were
found.** Two consistency defects closed: `_commentExistsStmt` in
`tickets.js` still selected the unused `assigned_to` column (a dead-column
drift from a previously-described fix that was never actually applied), and
`auth.js` used `"Invalid Username Or Password"` which broke the app-wide
`"Invalid <Credential>"` title-case convention used by every other error
message.

### Fixes applied
- **`src/routes/tickets.js` — `_commentExistsStmt` selected an unused column
  (LOW, consistency).** The comment handler only checks row existence
  (`if (!ticket) throw new Error('NOT_FOUND')`) and never reads
  `assigned_to`. The column added unnecessary bytes to every comment-check
  query. Removed it from the SELECT so the statement reads
  `SELECT id FROM tickets WHERE id = ?`, matching the minimal-shape convention
  used by every other existence-check statement in the app.
- **`src/routes/auth.js` — `"Invalid Username Or Password"` inconsistent with
  the `Invalid <Credential>` convention (LOW, consistency).** Every other error
  message across all routes follows the `Invalid <FieldName>` pattern
  (`Invalid Category`, `Invalid Status`, `Invalid Assignee`, etc.). The login
  handler used `"Invalid Username Or Password"` with a spaced conjunction that
  broke this pattern and was visually distinct from the uniform title-case
  form used everywhere else. Changed all three occurrences to
  `"Invalid Login Credentials"`, a single-concept message that matches the
  established convention.
- **`tests/code_review_194.test.js` — added 4 regression tests (net +4 tests).**
  A source-code pin asserts that `_commentExistsStmt` contains only `id` in the
  SELECT clause and no `assigned_to`. Two source-code pins assert that `auth.js`
  no longer contains the old `"Invalid Username Or Password"` string and does
  contain the new `"Invalid Login Credentials"` string (count ≥ 3). One
  handler-level test verifies that a wrong-password login redirects to `/login`
  with the consistent flash message.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1100 passed / 1100 total** (63 suites, +4 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (193rd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, or error-leakage defects were
found.** Two consistency gaps closed: the asset-report GET route on
`/reports/assets` was the sole reports sub-route missing the explicit
`rejectHppArrays` guard on its `period` query param (the tickets and staff
sub-routes already carried it), and `GET /profile` in `auth.js` called the raw
`audit()` helper directly while every other read surface in the app used
`req.audit()`.

### Fixes applied
- **`src/routes/reports.js` — `/reports/assets` missing `rejectHppArrays` guard
  (LOW, consistency).** The asset-report handler did not call
  `rejectHppArrays(req, ['period'])` before processing the `period` query param,
  unlike the sibling `/reports/tickets` and `/reports/staff` routes. While
  `resolveReportPeriod()` internally rejects array inputs, the explicit guard
  is the app-wide convention so every route fails closed with a uniform
  `"Invalid request parameters"` flash-and-redirect rather than relying on a
  downstream resolver. Added the guard to match the tickets and staff patterns.
- **`src/routes/auth.js` — `GET /profile` used raw `audit()` instead of
  `req.audit()` (LOW, consistency).** Every other read route in the app
  (`/dashboard`, `/assets`, `/tickets`, `/projects`, `/staff`, `/vendors`,
  `/knowledge`, `/changes`, `/licenses`, `/audit`, and the reports index) calls
  `req.audit(...)`. The profile handler called `audit({ req, ... })` directly,
  bypassing the middleware-wired convenience method. Changed to
  `req.audit('read', 'user', req.session.user.id, 'Viewed own profile')` to
  match the convention.
- **`tests/code_review_169.test.js` — updated profile-audit regression test.**
  The existing test asserted the old `audit()`-helper call shape; updated it to
  verify `req.audit` receives the correct `(read, user, entityId, details)`
  tuple, keeping the regression pin intact.
- **`tests/code_review_192.test.js` — added 4 regression tests (net +4 tests).**
  Two handler-level tests assert that `/reports/assets` rejects an HPP array
  payload on `period` (redirects to `/reports` with error flash) and accepts a
  normal scalar (renders normally). Two more assert that `GET /profile` calls
  `req.audit` with the expected read/user tuple, and a source-code pin asserts
  that `reports.js` contains the `rejectHppArrays` call on the `/assets` route.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1096 passed / 1096 total** (62 suites, +4 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (192nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, or error-leakage defects were
found.** One consistency gap closed: `createAuditLogPruner` in `utils.js` used
`err.message` directly without the `(err && err.message) || String(err)` null
guard that every other catch-block logger in the app carries. While the prune
callback is always an internal DB operation where `err` is an Error, the same
stray-non-Error-throw risk pass 191 targeted remains — and `createAuditLogPruner`
is the single call site still using the unguarded form after pass 191's unification.

### Fixes applied
- **`src/utils.js` — `createAuditLogPruner` catch block missing null guard (LOW, consistency).**
  Line 887 called `logger.error('Audit log pruning error:', err.message)` directly.
  While the prune function receives an internal callback where `err` is almost always
  an Error object, the inconsistent pattern leaves a latent crash if a non-Error
  value (e.g. a thrown string) reaches the catch. Changed to
  `logger.error('Audit log pruning error:', (err && err.message) || String(err))`,
  matching the convention used at all other logging sites across the codebase.
- **`tests/code_review_191.test.js` — added source-pin regression for utils.js**
  (net +1 tests). Asserts that `utils.js` contains the inline guard pattern.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1091 passed / 1091 total** (61 suites, +1 regression test).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (191st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, or error-leakage defects were
found.** One consistency gap closed: pass 190 fixed `console.error(err.message)`
null guards in `app.js` but left 62+ identical unguarded calls across every
route module, both middleware modules, `database.js`, and `seed.js`. While callers
are all catch blocks or Node.js event handlers where `err` is typically an Error
object, the inconsistent pattern leaves a latent crash risk if a non-Error value
ever slips through.

### Fixes applied
- **`src/utils.js` — added `logError(...args)` null-safe logger (LOW, consistency).**
  New helper that transforms the last argument from `err.message` to
  `(err && err.message) || String(err)`, mirroring the convention established in
  pass 190. Exported alongside existing helpers.
- **All 12 route modules, both middleware modules, `src/models/database.js`,
  and `src/seed.js` — unified `console.error(err.message)` → `logError(..., err)`
  or inline `(err && err.message) || String(err)` (LOW, consistency).** 66 call
  sites across the codebase now use the same null-safe pattern. No functional
  change in normal operation; defensive against a stray non-Error throw.
- **`tests/code_review_191.test.js` — 8 regression tests.** Source pins for
  `logError` behavior (Error message extraction, non-string fallback, undefined,
  null), plus assertions that every route/middleware/database file uses the
  guarded pattern.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1091 passed / 1091 total** (61 suites, +8 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (190th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, or error-leakage defects were
found.** One consistency gap closed: three `console.error` calls in
`app.js` used `err.message` directly without the `(err && err.message) ||
String(err)` null guard that the other four error-handling sites in the same
file already use. While the callers are all catch blocks or Node.js event
handlers where `err` is typically an Error object, the inconsistent pattern
leaves a latent crash risk if a non-Error value ever slips through.

### Fixes applied
- **`src/app.js` — three `console.error(err.message)` calls lack null guard
  (LOW, consistency).** Lines 768, 804, and 815 accessed `err.message`
  directly. The other error-handling sites in `app.js` (lines 672 and 835)
  already use `(err && err.message) || String(err)`. Unified the pattern
  across all five sites so a stray non-Error throw cannot crash the logger.
  Changed to `(err && err.message) || String(err)` on each of the three
  sites.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1083 passed / 1083 total** (60 suites, +3 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (189th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, EJS views, `public/js/app.js`, and the test suite.
**No new SQL injection, CSRF, XSS, auth, or error-leakage defects were
found.** Two consistency/a11y gaps closed: the license key reveal button's
`aria-label` did not toggle between "Reveal" and "Hide" states (AT announced
the wrong action on the second click), and the audit log action column used
`titleCase(e.action)` without a null fallback (the middleware validates
against `ALLOWED_ACTIONS` so this never fires in practice, but the pattern
is now defensive).

### Fixes applied
- **`public/js/app.js` — license reveal button `aria-label` not toggled (LOW, a11y).**
  When the user clicked the eye-icon button to reveal the key, the JavaScript
  updated the display text and the icon class (`fa-eye` → `fa-eye-slash`) but
  left the button's `aria-label` as `"Reveal license key"` — on the next click
  (to hide) assistive technology would announce "Reveal license key" while the
  action was actually "Hide". Added two `btn.setAttribute('aria-label', ...)`
  calls: one on the show path (`'Hide license key'`) and one on the hide path
  (`'Reveal license key'`), so AT always announces the correct opposite action.
- **`views/pages/audit/index.ejs` — `titleCase(e.action)` missing null guard (LOW, consistency).**
  The action cell rendered `<%= titleCase(e.action) %>` directly. While
  `audit.js` validates against `ALLOWED_ACTIONS` before writing and the
  database schema enforces `NOT NULL`, defensive coding convention across the
  app is to add `|| 'unknown'` to any nullable template expression that feeds
  into `titleCase()`. Changed to `titleCase(e.action || 'unknown')` to match
  the pattern used by every other enum display in the codebase.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1080 passed / 1080 total** (59 suites, +3 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (187th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, EJS views, `public/js/app.js`, and the test suite).
**No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage defects were
found.** Three consistency gaps closed: raw enum values leaking into CSS badge
class names across all list/show templates, two unclamped progress-bar widths,
and missing HPP guards on report sub-routes.

### Fixes applied
- **`src/constants.js` — 10 missing badge mappings added (LOW, consistency).**
  `TICKET_STATUS_BADGE`, `TICKET_PRIORITY_BADGE`, `ASSET_STATUS_BADGE`,
  `PROJECT_STATUS_BADGE`, `PROJECT_PRIORITY_BADGE`, `TASK_PRIORITY_BADGE`,
  `CHANGE_STATUS_BADGE`, `CHANGE_PRIORITY_BADGE`, `KB_STATUS_BADGE`, and
  `VENDOR_CATEGORY_BADGE` were absent, so templates that wanted to use
  `badgeClass()` had no mapping to pass. All ten are now frozen objects with
  sensible severity assignments (e.g. `open→high`, `in_progress→critical`,
  `scheduled→high`, `draft→medium`, all vendor categories → `medium`).
  Exported from `constants.js`, re-exported from `utils.js`, and wired into
  `res.locals` + `TEMPLATE_CONSTANTS` in `app.js`.
- **All EJS templates — status/priority/category badges now use `badgeClass()`
  (HIGH, correctness).** Every instance of `badge-<%= rawEnum %>` across
  `tickets/index.ejs`, `tickets/show.ejs`, `assets/index.ejs`, `assets/show.ejs`,
  `projects/index.ejs`, `projects/show.ejs`, `changes/index.ejs`,
  `changes/show.ejs`, `knowledge/index.ejs`, `knowledge/show.ejs`,
  `vendors/index.ejs`, `vendors/show.ejs`, `dashboard.ejs`, and
  `staff/show.ejs` was updated to call `badgeClass(value, MAPPING)` so unknown
  enum values fall back to `'medium'` instead of leaking into CSS class names
  as `badge-<rawValue>`.
- **`views/pages/projects/index.ejs` and `views/pages/projects/show.ejs` —
  progress bar width clamped to 100% (LOW, correctness).** The
  `style="width:<%= p.progress || 0 %>%"` expression allowed overflow when
  `progress` exceeded 100 (data corruption or upstream bug). Both now use
  `Math.min(p.progress || 0, 100)`, matching the convention everywhere else in
  the codebase.
- **`views/pages/audit/index.ejs` — replaced `.replace(/_/g, ' ')` with
  `titleCase()` (LOW, consistency).** Four instances across the filter options
  and badge rows were using a naive underscore-to-space swap, which broke
  acronym rendering (e.g. `sop` → `"sop"` instead of `"SOP"`). Updated to
  `titleCase()`, consistent with every other template in the app.
- **`views/pages/licenses/index.ejs` — progress bar color thresholds now use
  `CONSTANTS.*_THRESHOLD` (LOW, consistency).** The license seat-usage bar used
  hardcoded `> 90` / `> 70` ternary checks while every other progress bar in
  the app referenced `CONSTANTS.PROGRESS_GREEN_THRESHOLD`,
  `CONSTANTS.PROGRESS_BLUE_THRESHOLD`, and `CONSTANTS.PROGRESS_ORANGE_THRESHOLD`.
  Updated to use the shared constants.
- **`src/routes/reports.js` — added `rejectHppArrays` to all three sub-routes
  (LOW, defense-in-depth).** `/reports/tickets`, `/reports/assets`, and
  `/reports/staff` did not call `rejectHppArrays`, unlike every other route
  module. Added the guard to each handler so a future developer adding a new
  query param gets the same array-rejection safety net.
- **`views/partials/nav.ejs` — added `role="navigation"` (LOW, a11y).** The
  sidebar `<nav>` already had `aria-label="Main navigation"` but lacked an
  explicit `role="navigation"`, which some assistive technologies prefer for
  landmark recognition.
- **`tests/utils.test.js` — added `ensureAssigneeInList` happy-path regression
  tests (LOW, test coverage).** Two tests cover: (1) a deactivated assignee
  missing from the active-staff list is fetched from the DB and prepended, and
  (2) an assignee already present in the active list is not duplicated.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1077 passed / 1077 total** (58 suites, +2 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (186th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. The only finding was a moderate severity
dependency vulnerability in `morgan` (< 1.12.0) — Log Forging via unescaped
Unicode line separators (GHSA-jxfw-x594-9x9m) — which was resolved by running
`npm audit fix`. No source changes were needed; the fix is a pure dependency
upgrade.

### Fixes applied
- **`node_modules/morgan` — Log Forging via unescaped Unicode line separators
  (MODERATE, security).** `morgan` < 1.12.0 allowed crafted log lines to
  inject newline characters into access logs, potentially corrupting log
  parsing or enabling log injection attacks. Resolved by `npm audit fix`, which
  bumped `morgan` from `1.11.0` to `1.12.0` and `js-yaml` from `3.15.1` to
  `3.15.2`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1075 passed / 1075 total** (58 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities** (was 1
  moderate: `morgan < 1.12.0`, now resolved).

---

## Review cycle (185th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One LOW consistency defect —
`views/pages/staff/show.ejs` used bare `user.role === 'admin'` comparisons
instead of the app-wide `isPrivileged(user)` helper that null-safely gates
privileged actions — was closed on two inline role gates (the edit-button
gate and the admin-actions gate). Four regression tests pin the fix so future
drift cannot reintroduce raw role equality checks.

### Fixes applied
- **`views/pages/staff/show.ejs` — direct `user.role` equality on edit/admin
  gates (LOW, consistency).** Lines 11 and 98 compared `user.role` directly
  (`user.role === 'admin'` / `user.role === 'manager'`) instead of using the
  `isPrivileged(user)` helper that every other template uses for privilege
  checks. A null role from a corrupt DB row would silently short-circuit the
  checks to false (safe, but inconsistent with the established convention).
  Changed line 11 to
  `isPrivileged(user) && (user.role === 'admin' || staffUser.role === 'staff')`
  and line 98 to
  `isPrivileged(user) && user.role === 'admin' && Number(staffUser.id) !== Number(user.id)`
  so both gates follow the same null-safe privilege pattern used everywhere
  else in the app.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1075 passed / 1075 total** (58 suites, +4 net: 3 render
  regressions for null/manager role gates + 1 source-code assertion).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (184th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One LOW test-completeness defect — the
`sanitize-html` mock in `tests/jest.setup.js` carried a stray `'nl'` entry in
its `allowedTags` array between `'ol'` and `'li'` (both `nl` and `li` are valid
list-item tags in no known HTML spec; `li` was already present immediately
after it) — was closed by removing the duplicate. Two regression tests pin
the fix so future copy-paste drift cannot reintroduce it.

### Fixes applied
- **`tests/jest.setup.js` — stray `'nl'` in `allowedTags` (LOW, test completeness).**
  The mock's `defaults.allowedTags` array listed `'nl'` between `'ol'` and
  `'li'`. `nl` is not a valid HTML tag and had no purpose here; `'li'` was
  already present on the next element, making `'nl'` a transparent copy-paste
  typo. Removed the stray entry so the mock's tag allowlist is free of invalid
  names. Pinned with a source-code assertion (`expect(allowedTags).toContain('li'); expect(allowedTags).not.toContain('nl')`) and a render pin verifying that `<li>` is preserved while an unknown `<nl>` tag is stripped.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1071 passed / 1071 total** (57 suites, +2 net: 2
  allowedTags regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (183rd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One MEDIUM correctness defect — `badgeClass()`
returned the raw unmapped value as a CSS class name, so a future DB enum value
not yet covered by the mapping would produce `badge-badge-<unexpected>`; now
falls back to `'medium'`. One LOW correctness defect — `req.session.user` was
dereferenced without a null guard on `GET /tickets/new`, which could throw a
`TypeError` in edge-case test harnesses; now guards with optional chaining.
Eight LOW completeness defects — list GET routes on assets, tickets, projects,
staff, vendors, knowledge, changes, and licenses lacked the explicit
`rejectHppArrays()` guard on query params that every write route and
`GET /audit` already carried — were closed. One LOW consistency defect —
vendor category templates used a ternary (`v.category ? titleCase(...) : '-'`)
instead of the app-wide `|| 'other'` pattern — was normalized.

### Fixes applied
- **`src/utils.js` — `badgeClass()` no fallback for unmapped values (MEDIUM,
  correctness).** The function returned the raw value when not found in the
  mapping, producing invalid CSS classes like `badge-badge-futureEnum` if the
  database ever carried an unexpected enum. Changed the fallback to `'medium'`
  so unrecognized values always render as a styled badge instead of leaking raw
  database content into the DOM as a class name.
- **`src/routes/tickets.js` — `GET /new` prefill dereferences `req.session.user`
  without a null guard (LOW, correctness).** The ticket form prefill accessed
  `req.session.user.first_name`, `.last_name`, `.email`, and `.department`
  directly; while `requireAuth` middleware guarantees the user object in normal
  operation, unit-test harnesses and edge cases may bypass that path, causing a
  `TypeError` and 500 error. Added a safe accessor that falls back to empty
  strings when the user object is missing.
- **`src/routes/assets.js` — list GET missing HPP guard (LOW, completeness).**
  Added `rejectHppArrays(req, ['search', 'sort', 'status', 'category',
  'assigned_to'])` with a flash-and-redirect fail-closed response, matching
  the convention on `GET /audit` and every write route in the app.
- **`src/routes/tickets.js` — list GET missing HPP guard (LOW, completeness).**
  Identical fix: added `rejectHppArrays` on `['search', 'sort', 'status',
  'priority', 'category', 'assigned_to']`.
- **`src/routes/projects.js` — list GET missing HPP guard (LOW, completeness).**
  Identical fix: added `rejectHppArrays` on `['search', 'sort', 'status',
  'priority']`.
- **`src/routes/staff.js` — list GET missing HPP guard (LOW, completeness).**
  Identical fix: added `rejectHppArrays` on `['search', 'status', 'role',
  'department']`.
- **`src/routes/vendors.js` — list GET missing HPP guard (LOW, completeness).**
  Identical fix: added `rejectHppArrays` on `['search', 'category', 'is_active']`.
- **`src/routes/knowledge.js` — list GET missing HPP guard (LOW, completeness).**
  Identical fix: added `rejectHppArrays` on `['search', 'category', 'status']`.
- **`src/routes/changes.js` — list GET missing HPP guard (LOW, completeness).**
  Identical fix: added `rejectHppArrays` on `['search', 'status', 'change_type',
  'priority', 'assigned_to']`.
- **`src/routes/licenses.js` — list GET missing HPP guard (LOW, completeness).**
  Identical fix: added `rejectHppArrays` on `['search', 'license_type']`.
- **`views/pages/vendors/index.ejs` — category ternary vs `||` pattern
  (LOW, consistency).** Changed `<%= v.category ? titleCase(v.category) : '-' %>`
  to `<span class="badge badge-<%= v.category || 'other' %>"><%= titleCase(v.category || 'other') %></span>`
  to match the consistent pattern used by every other entity's category display
  across the app.
- **`views/pages/vendors/show.ejs` — same category ternary fix (LOW,
  consistency).** Identical normalization to the `|| 'other'` + badge pattern.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1069 passed / 1069 total** (56 suites, +14 net: 9 list-route
  HPP regression tests + 4 badgeClass fallback tests + 1 tickets/new prefill
  regression test).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (182nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. Four LOW a11y defects — nullable enum
values (`category` and `status`) passed directly to `titleCase()` in the
`aria-label` attribute of progress bars on the tickets and assets report
pages, producing `"null: N tickets/assets"` when a row carried a null enum —
were closed. One LOW consistency defect — `titleCase(user.role)` in the nav
partial missing the same `|| 'staff'` fallback already used everywhere else
the user role is displayed — was also closed.

### Fixes applied
- **`views/pages/reports/tickets.ejs` — category aria-label missing fallback
  (LOW, a11y).** The by-category progress bar announced `"<%= titleCase(c.category) %>: <%= c.count %> tickets"`; a null category rendered `"null: N tickets"` to assistive technology while the visible label already used `c.category || 'other'`. Added `|| 'other'` to the aria-label so the accessible name matches the visible text.
- **`views/pages/reports/tickets.ejs` — priority aria-label missing fallback
  (LOW, a11y).** Identical fix for the by-priority bar: added `|| 'medium'` to
  `titleCase(p.priority)` in the `aria-label`.
- **`views/pages/reports/assets.ejs` — category aria-label missing fallback
  (LOW, a11y).** The by-category progress bar announced `"<%= titleCase(c.category) %>: <%= c.count %> assets"` with no fallback. Added `|| 'other'` to match the visible label on the preceding line.
- **`views/pages/reports/assets.ejs` — status aria-label missing fallback
  (LOW, a11y).** Identical fix: added `|| 'in_storage'` to
  `titleCase(s.status)` in the by-status bar aria-label.
- **`views/partials/nav.ejs` — `titleCase(user.role)` missing fallback
  (LOW, consistency).** The nav rendered `<%= titleCase(user.role) %>` directly; every other role display in the app uses `|| 'staff'` (e.g. `auth/profile.ejs`, `staff/index.ejs`, `staff/show.ejs`). A null role would render `"null"` as the nav badge. Added `|| 'staff'` to match the convention.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1055 passed / 1055 total** (55 suites, +10 net: 4 template
  aria-label/render regressions + 1 nav-role render regression + 5
  source-code assertions for the fallback strings).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (181st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. Four LOW consistency defects — a nullable
`author_name` display field on the knowledge show page, and `'?'` fallbacks
for contract/project dates on the vendors show and projects index pages
(inconsistent with the app-wide `'-'` convention) — were closed. One LOW
correctness defect — the reports rate-limit handler called `req.flash()`
without guarding against an absent flash function, unlike the dashboard
limiter which guards with `typeof req.flash === 'function'` — was also
closed.

### Fixes applied
- **`views/pages/knowledge/show.ejs` — nullable `author_name` display
  (LOW, consistency).** The show page rendered `<strong><%= article.author_name %></strong>`
  without a null guard. When an article's `author_id` references a deleted
  user the LEFT JOIN returns NULL and the template would emit empty text
  between the `<strong>` tags. The index page already used `a.author_name ||
  '-'`. Added `|| '-'` to match the index and every other nullable display
  field in the app.
- **`views/pages/vendors/show.ejs` — contract date fallback `'?'` vs `'-'`
  (LOW, consistency).** The contract row used `'?'` as the missing-date
  fallback (`vendor.contract_start ? formatDate(...) : '?'`) while every
  other date display in the app uses `'-'` (e.g. tickets show, assets show,
  changes index/show). Changed to `'-'` for consistency.
- **`views/pages/projects/index.ejs` — project date fallback `'?'` vs `'-'`
  (LOW, consistency).** Identical fix: the project date line used `'?'`
  instead of `'-'`. Changed to `'-'` to match the convention used on the
  projects show page and every other list/show template.
- **`src/routes/reports.js` — reportLimiter handler missing `req.flash`
  guard (LOW, correctness).** The rate-limit handler unconditionally called
  `req.flash('error', ...)` before redirecting. If the session middleware
  had not yet run (or the session was destroyed), `req.flash` would be
  undefined and throw. The dashboard limiter already guards with
  `typeof req.flash === 'function'`. Added the same guard so both limiters
  behave identically.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1045 passed / 1045 total** (54 suites, +5 net: 1 knowledge
  author_name render regression + 2 vendor/project date fallback regressions
  + 1 reports limiter guard regression + 1 source-code assertion for the
  guard).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---


A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One LOW correctness defect — a double-denial
redirect on the staff update privileged-role and self-role guards that sent the
user to the edit form (which re-ran the same access gate) — was closed. Thirty
LOW consistency defects — nullable enum values passed directly to
`titleCase()` / used as inline `badge-<%= %>` classes across 15 templates — were
closed by adding the same `|| 'default'` fallbacks already established in prior
passes. Two LOW completeness defects — reports sub-route read audits omitted the
queried `period`, and the assets index rendered a leading space when
`manufacturer` was null — were also closed.

### Fixes applied
- **`src/routes/staff.js` — privileged-role assignment denial redirected to
  edit form (LOW, correctness).** `PUT /:id` line 483 redirected to
  `/staff/${id}/edit` on the "only admins can assign manager/admin" guard,
  guaranteeing a second `access_denied` audit + flash when the edit route
  re-checked the same gate. Changed to `/staff`, matching the convention used
  by every other access-denial redirect in the app.
- **`src/routes/staff.js` — self-role-change denial redirected to edit form
  (LOW, correctness).** Identical fix on line 488: changed `/staff/${id}/edit`
  to `/staff` so the self-preservation guard also lands on the list instead of
  re-triggering the edit-route access check.
- **`views/pages/dashboard.ejs` — 6 nullable enum fields missing fallbacks
  (LOW, consistency).** `t.priority`, `t.status`, `t.category` in my-tickets
  rows; `t.category`, `t.priority`, `t.status` in recent-tickets rows;
  `c.category` in active-tickets-by-category card. Added `|| 'medium'` /
  `|| 'open'` / `|| 'other'` to every `titleCase()` and inline `badge-` class
  call, matching the pattern established in passes 174–176.
- **`views/pages/staff/show.ejs` — 3 nullable enum fields missing fallbacks
  (LOW, consistency).** `t.priority`, `t.status` in assigned-tickets rows and
  `a.status` in assigned-assets rows. Added `|| 'medium'` / `|| 'open'` /
  `|| 'in_storage'`.
- **`views/pages/reports/tickets.ejs` — 2 nullable enum fields + aria-label
  (LOW, consistency/a11y).** `c.category` and `p.priority` in the by-category
  and by-priority bars got `|| 'other'` / `|| 'medium'`. The time-series
  progress-bar aria-label was rephrased from `"X tickets on <date>"` to
  `"Tickets on <date>: X"` so the entity name leads and the count尾s, consistent
  with every other progress-bar label in the app.
- **`views/pages/reports/assets.ejs` — 2 nullable enum fields missing
  fallbacks (LOW, consistency).** `c.category` and `s.status` in the by-category
  and by-status bars. Added `|| 'other'` / `|| 'in_storage'`.
- **`views/pages/knowledge/index.ejs` — `a.status` missing fallback (LOW,
  consistency).** Added `|| 'draft'`.
- **`views/pages/knowledge/show.ejs` — `article.status` missing fallback
  (LOW, consistency).** Added `|| 'draft'`.
- **`views/pages/tickets/index.ejs` — 3 nullable enum fields missing
  fallbacks (LOW, consistency).** `t.category`, `t.priority`, `t.status`. Added
  `|| 'other'` / `|| 'medium'` / `|| 'open'`.
- **`views/pages/tickets/show.ejs` — 5 nullable enum fields missing
  fallbacks (LOW, consistency).** `ticket.status` (×2 — quick-status display
  and sidebar), `ticket.priority`, `ticket.category`. Added `|| 'open'` /
  `|| 'medium'` / `|| 'other'`.
- **`views/pages/changes/index.ejs` — 2 nullable enum fields missing
  fallbacks (LOW, consistency).** `c.priority`, `c.status`. Added `|| 'medium'`
  / `|| 'scheduled'`.
- **`views/pages/changes/show.ejs` — 2 nullable enum fields missing
  fallbacks (LOW, consistency).** `change.status`, `change.priority`. Added
  `|| 'scheduled'` / `|| 'medium'`.
- **`views/pages/assets/index.ejs` — 2 nullable enum fields + cosmetic
  (LOW, consistency/cosmetic).** `a.category`, `a.status` got fallbacks
  (`|| 'other'` / `|| 'in_storage'`). Manufacturer/name concatenation changed
  from `<%= a.manufacturer %> <%= a.name %>` to
  `<%= a.manufacturer ? a.manufacturer + ' ' : '' %><%= a.name %>` to avoid a
  leading space when manufacturer is null.
- **`views/pages/assets/show.ejs` — 4 nullable enum fields missing
  fallbacks (LOW, consistency).** `asset.category`, `asset.status`,
  `t.priority`, `t.status` in related-tickets rows. Added fallbacks.
- **`views/pages/projects/index.ejs` — `p.status` missing fallback (LOW,
  consistency).** Added `|| 'planning'`.
- **`views/pages/projects/show.ejs` — 3 nullable enum fields missing
  fallbacks (LOW, consistency).** `project.status`, `project.priority`,
  `t.priority` in task rows, `m.role` in member rows. Added `|| 'planning'` /
  `|| 'medium'` / `|| 'member'`.
- **`views/pages/auth/profile.ejs` — `profileUser.role` missing fallback
  (LOW, consistency).** Added `|| 'staff'`.
- **`src/routes/reports.js` — read-audit details omit period (LOW,
  completeness).** Ticket-analytics and staff-performance audits now include
  the queried period in the details string (e.g. `"Viewed ticket analytics
  report (period: 30 days)"`) so the audit trail records what window was
  inspected.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1040 passed / 1040 total** (53 suites, +30 net: 24 template
  fallback render regressions + 2 staff double-denial redirect regressions +
  2 reports-period-audit regressions + 1 assets-leading-space regression +
  1 reports-tickets-aria-label regression).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (179th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One MEDIUM completeness defect — the
reports index route omitted a read audit — and five LOW a11y defects —
progress-bar `aria-label` values missing entity names on four pages and a
non-featured knowledge cell invisible to assistive technology — were closed.

### Fixes applied
- **`src/routes/reports.js` — `/reports` index missing read audit (MEDIUM,
  completeness).** Every other list and show route in the app calls
  `req.audit('read', ...)` before rendering. The reports index was the sole
  exception, leaving privileged admin navigation through the reports landing
  page untraceable. Added `req.audit('read', 'report', null, 'Viewed reports index')`
  so the index view leaves an audit trail consistent with every other read
  surface.
- **`views/pages/reports/staff.ejs` — progress-bar aria-label missing staff
  name (LOW, a11y).** The bar announced only `"X open tickets"` which is
  ambiguous when a screen reader navigates a table where multiple rows share
  the same count. Changed to `"<%= p.name %>: <%= p.open_tickets %> open
  tickets"` to match the dashboard's workload-bar convention.
- **`views/pages/reports/tickets.ejs` — top-resolver progress-bar aria-label
  missing resolver name (LOW, a11y).** Identical fix: changed to
  `"<%= r.name %>: <%= r.resolved %> tickets resolved"` so each row has a
  unique accessible name.
- **`views/pages/projects/index.ejs` — progress-bar aria-label missing project
  name (LOW, a11y).** All cards on the index shared the label
  `"Project progress: X%"`. Changed to
  `"Project progress: <%= p.name %>: <%= p.progress || 0 >%"` for uniqueness.
- **`views/pages/projects/show.ejs` — progress-bar aria-label missing project
  name (LOW, a11y).** Same fix: included `project.name` in the label for
  consistency with the index and other report pages.
- **`views/pages/knowledge/index.ejs` — non-featured cell invisible to AT
  (LOW, a11y).** Non-featured articles rendered `<span aria-hidden="true">-</span>`,
  producing silence for screen readers while featured articles announced
  `"Yes"`. Changed to `<span class="sr-only">No</span>` so the accessible
  experience is symmetric: `"Yes"` for featured, `"No"` for non-featured.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1010 passed / 1010 total** (52 suites, +7 net: 1 reports-index
  audit regression + 6 a11y render regressions + 1 list-route-audit regression
  for reports).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (178th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One LOW a11y defect — a decorative `fa-bell`
icon on the nav "My Tickets" quick-link whose destination is the tickets list
— was normalized to `fa-ticket` so the icon semantically matches the linked
page (every other ticket surface in the app uses `fa-ticket`).

### Fixes applied
- **`views/partials/nav.ejs` — `fa-bell` icon mismatch on "My Tickets" nav link
  (LOW, a11y).** The icon-only quick-link to `/tickets?assigned_to=...` used
  `fa-bell` (a notification bell) while its href, title, and aria-label all
  reference tickets. Every other ticket-referencing surface in the app
  (dashboard stat card, ticket index empty state, ticket report stat card,
  staff show assigned-tickets header, asset show related-tickets header, and
  the main Tickets nav item) uses `fa-ticket`. Changed to `fa-ticket` so the
  icon's semantics match the destination and the visual language stays
  consistent across the entire app.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1003 passed / 1003 total** (51 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (177th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. Two progress-bar width inconsistencies — a
fixed 150px strip in the tickets analytics report and a fixed 80px strip in
the licenses list — were normalized to `flex:1` so the bars scale with their
table columns instead of being rigid on narrow screens.

### Fixes applied
- **`views/pages/reports/tickets.ejs` — fixed-width progress bar (LOW,
  consistency).** The top-resolvers table used
  `style="width:150px;display:inline-block;vertical-align:middle;"` while
  every other progress bar in the app (dashboard, tickets report time-axis,
  assets report, staff report, projects lists) uses `flex:1` to fill its
  column. Changed to `flex:1` so the bar scales with the table column rather
  than being a rigid 150px strip that overflows or underflows on narrow
  screens.
- **`views/pages/licenses/index.ejs` — fixed-width progress bar (LOW,
  consistency).** Identical fix: changed `width:80px;display:inline-block;
  vertical-align:middle;` to `flex:1` to match the app-wide convention.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1003 passed / 1003 total** (51 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (176th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. All template `titleCase()` / `badgeClass()`
nullable fallbacks are consistent across every show/list/detail page. The
audit log details column already uses `<%= %>` (escaped) for the cell body
and `<%- escapeHtml() %>` for the `title` tooltip — both paths correctly
prevent XSS. All write routes carry CSRF protection (POST/PUT/DELETE are
never skipped by `skipCsrfProtection`), rate limits, HPP guards, and
transaction-scoped TOCTOU safety.

### Fixes applied
None — all previously identified issues were already committed in cycles
174–175 and verified present in the working tree.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1003 passed / 1003 total** (51 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (175th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. Four template consistency gaps —
`titleCase()` calls missing the same nullable fallback that `badgeClass()`
already used in the same row — were closed across four show/detail pages.

### Fixes applied
- **`views/pages/assets/show.ejs` — `titleCase(asset.condition_rating)` missing
  fallback (LOW, consistency).** The badge mapping already passed
  `asset.condition_rating || 'good'` but the text display passed the raw value.
  A null condition would render an unstyled empty badge cell while the class
  correctly showed "Good". Added `|| 'good'` to the `titleCase` call, matching
  the badge convention and the pattern used on `assets/index.ejs`.
- **`views/pages/changes/show.ejs` — same `titleCase(change.change_type)` gap
  (LOW, consistency).** Identical fix: added `|| 'maintenance'` to
  `titleCase()`.
- **`views/pages/licenses/show.ejs` — same `titleCase(license.license_type)`
  gap (LOW, consistency).** Identical fix: added `|| 'perpetual'` to
  `titleCase()`.
- **`views/pages/reports/assets.ejs` — `titleCase(c.condition_rating)` in
  aria-label missing fallback (LOW, consistency).** The text span on the
  previous line already used `c.condition_rating || 'good'` but the
  progress-bar `aria-label` passed the raw value. A null rating would render
  `"null: N assets"` as the accessible label while the visible text showed
  "Good". Added `|| 'good'` to the aria-label so the accessible name matches
  the visual label.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1003 passed / 1003 total** (51 suites, +8 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (174th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. Six template consistency gaps —
`titleCase()` calls missing the same nullable fallback that `badgeClass()`
already used — were closed, and one progress-bar width inconsistency was
normalized.

### Fixes applied
- **`views/pages/knowledge/index.ejs` — `titleCase(a.category)` missing
  fallback (LOW, consistency).** The badge mapping already passed
  `a.category || 'other'` but the text display passed the raw value. A null
  category would render an unstyled empty badge cell while the class
  correctly showed "Other". Added `|| 'other'` to the `titleCase` call,
  matching the badge convention and the pattern used on
  `knowledge/show.ejs`.
- **`views/pages/knowledge/show.ejs` — same `titleCase(article.category)`
  gap (LOW, consistency).** Identical fix: added `|| 'other'` to
  `titleCase()`.
- **`views/pages/assets/index.ejs` — `titleCase(a.condition_rating)` missing
  fallback (LOW, consistency).** The badge mapping used `|| 'good'` but the
  text did not. Added the fallback to `titleCase()` so both render the same
  string regardless of database state.
- **`views/pages/reports/assets.ejs` — `titleCase(c.condition_rating)`
  missing fallback (LOW, consistency).** The `_bc` variable computed with
  `c.condition_rating || 'good'` but the label used the raw value. Added
  `|| 'good'` to match.
- **`views/pages/changes/index.ejs` — `titleCase(c.change_type)` missing
  fallback (LOW, consistency).** The badge mapping used `|| 'maintenance'`
  but the text did not. Added the fallback to `titleCase()`.
- **`views/pages/licenses/index.ejs` — `titleCase(l.license_type)` missing
  fallback (LOW, consistency).** The badge mapping used `|| 'perpetual'`
  but the text did not. Added the fallback to `titleCase()`.
- **`views/pages/reports/staff.ejs` — fixed-width progress bar (LOW,
  consistency).** The team workload bar used `style="width:100px;display:inline-block;vertical-align:middle;"`
  while every other progress bar in the app (dashboard, tickets report,
  assets report) uses `flex:1` to fill its column. Changed to `flex:1` so
  the bar scales with the table column rather than being a rigid 100px
  strip that overflows or underflows on narrow screens.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **995 passed / 995 total** (50 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (172nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One consistency gap — a nullable
`project_status` used directly as a CSS badge class in the staff show page
was closed.

### Fixes applied
- **`views/pages/staff/show.ejs` — `badge badge-<%= pm.project_status %>`
  missing null fallback (LOW, consistency).** Every other badge rendering
  across the app either uses `badgeClass(value || 'fallback', MAPPING)` or a
  ternary (`is_active ? 'low' : 'critical'`). A null `pm.project_status`
  would produce `badge-badge-` — an invalid CSS class that silently renders
  as unstyled text. Added `|| 'planning'` to both the class and the
  `titleCase` display, matching the convention used for every other nullable
  enum value in the template layer.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **995 passed / 995 total** (50 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (171st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. Two consistency gaps — missing read audits
on eight paginated list routes, and missing HPP array-rejection guards on
twelve DELETE and special-PUT write routes — were closed.

### Fixes applied
- **`src/routes/assets.js`, `changes.js`, `knowledge.js`, `licenses.js`,
  `projects.js`, `staff.js`, `tickets.js`, `vendors.js` — list routes
  missing read audits (LOW, completeness).** Every `router.get('/')` that
  renders a paginated collection now calls `req.audit('read', ...)` so that
  viewing a collection leaves an audit trail consistent with individual show
  routes and the dashboard. The reports index (`GET /reports`) was left
  unchanged — it is a pure navigation landing page with no data fetch.
- **`src/routes/assets.js`, `changes.js`, `knowledge.js`, `licenses.js`,
  `projects.js` (3 routes), `staff.js` (2 routes), `tickets.js`,
  `vendors.js` (3 routes) — delete and special-PUT routes missing HPP
  guards (LOW, correctness).** All `router.delete('/:id')` handlers and
  special action PUT routes (`/:id/reactivate`, `/:id/deactivate`,
  `/:projectId/tasks/:taskId`, `/:id/members/:memberId`) now call
  `rejectHppArrays(req, ['id'])` (or the full param set) before reading
  params. This mirrors the fail-closed HPP convention already present on
  every create, update, comment, status-update, and satisfaction route in
  the app.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **995 passed / 995 total** (50 suites, +21 net: 13 HPP
  delete regression tests + 8 list-route audit regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (170th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One LOW correctness defect — a missing
trailing period on a comment-empty validation error flash — was closed.

### Fixes applied
- **`src/routes/tickets.js` — comment empty validation flash missing
  trailing period (LOW, consistency).** The flash message
  `"Comment text is required"` omitted the period that every other required-
  field flash carries (e.g. `"Title is required."`, `"Description is
  required."`). Added the trailing period to match the app-wide convention.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **974 passed / 974 total** (49 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (169th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. Two consistency defects — `badgeClass` calls
without nullable fallbacks in two staff-related list views, and a missing read
audit on the profile show route — were closed.

### Fixes applied
- **`views/pages/staff/index.ejs` — `badgeClass(s.role, ROLE_BADGE)` missing
  `|| 'staff'` fallback (LOW, consistency).** Every other list view in the app
  passes a fallback to `badgeClass` (e.g. `a.condition_rating || 'good'`,
  `c.change_type || 'maintenance'`). A NULL role would flow through as the raw
  value, producing `badge-null` — an invalid CSS class that silently renders as
  unstyled text. Added `|| 'staff'` to both the `badgeClass` call and the
  `titleCase` display, matching the convention used on `staff/show.ejs`
  (`staffUser.role || 'staff'`).
- **`views/pages/reports/staff.ejs` — same `badgeClass(p.role, ROLE_BADGE)` gap
  (LOW, consistency).** Identical fix: added `|| 'staff'` fallback to both the
  badge mapping and the `titleCase` call.
- **`src/routes/auth.js` — `GET /profile` missing read audit (LOW, completeness).**
  Every other show route audits its read action (`req.audit('read', ...)`), but
  the profile GET handler did not. Added `audit({ req, action: 'read', entity:
  'user', entityId: req.session.user.id, details: 'Viewed own profile' })` so
  profile views leave an audit trail consistent with all other read surfaces.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **974 passed / 974 total** (49 suites, +5 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (168th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One LOW correctness defect — a remaining
double-denial redirect on the tickets comment ACCESS_DENIED handler — was
closed. The fix mirrors the convention established in pass 166 for edit/update/
quick-status.

### Fixes applied
- **`src/routes/tickets.js` — ACCESS_DENIED on comment redirected to detail
  (LOW, correctness).** The comment handler's ACCESS_DENIED catch redirected
  to `/tickets/${id}`, triggering the same `canAccessResource` gate on the
  show route and producing a double denial (two flashes + two audits). Changed
  to redirect to `/tickets`, matching the convention applied to edit/update/
  quick-status in pass 166.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **969 passed / 969 total** (48 suites, +1 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (166th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. Two correctness defects, one invalid-HTML
defect, two consistency defects, and fourteen LOW a11y/docs/test completeness
defects were closed.

### Fixes applied
- **`src/models/database.js` — `close()` defined before `_nativeClose` (LOW, correctness/TDZ).**
  `function close() { _nativeClose.call(db); }` appeared above the
  `const _nativeClose = db.close.bind(db)` declaration, relying on deferred
  call semantics; moved the binding above the wrapper so the reference is
  initialized before any caller can observe it.
- **`src/utils.js` — `safeId` silently truncated floats (LOW, correctness).**
  `parseInt(3.5)` returns `3`, which would target a different record than the
  caller wrote. Added an explicit `Number.isInteger` guard for numeric inputs,
  mirroring `isPresentInvalidId`.
- **`src/utils.js` — `parseBooleanFlag` ignored JSON `true`/`1` (LOW, correctness).**
  Callers that send `true`/`1` (as opposed to `'true'`/`'1'`/`'on'`) silently
  got `0` with a success flash. Extended the function to also map JSON booleans
  and numbers to their expected int values.
- **`jest.setup.js` — locale pin dropped formatting options (LOW, correctness).**
  The previous override captured only `locales`, dropping the second argument
  (e.g. `{ style: 'currency' }`). Now forwards `options` through so future
  options-bearing calls do not silently lose them.
- **`src/utils.js` + `src/app.js` — `PAGE_SIZE` clamp and `SESSION_IDLE_TIMEOUT` floor
  were silent (LOW, completeness).**
  Added `console.warn` when `PAGE_SIZE` exceeds the max, and when
  `SESSION_IDLE_TIMEOUT_SECONDS` is raised to the 60s floor.
- **`views/pages/projects/show.ejs` — budget exposed to non-privileged owners
  (LOW, correctness).**
  The index page gates the budget line behind `isPrivileged`, but the show
  page did not — allowing staff owners (who can reach show via
  `canAccessResource`) to read financial data they cannot see on index. Added
  the `isPrivileged` gate.
- **`views/pages/projects/show.ejs` — task-hint text impossible for staff + missing
  members empty-state (LOW, completeness).**
  The empty-state paragraph said "No tasks yet. Add one above." unconditionally;
  staff users without add-task access cannot add one. Split into privileged /
  non-privileged strings. Added a members empty-state paragraph.
- **`views/pages/projects/show.ejs` — invalid HTML: members empty-state nested inside
  `<select>` (MEDIUM, correctness).**
  The `<% if (!members.length) %>` block was emitted inside the task-status
  `<select>`, producing malformed markup. Moved the paragraph outside the
  `</select>` into the Team card body.
- **`src/routes/tickets.js` — ACCESS_DENIED on edit/update/quick-status redirected to
  detail (LOW, correctness).**
  Redirecting to `/tickets/${id}` triggers the same `canAccessResource` gate on
  the show route, producing a double denial (two flashes + two audits).
  Changed all three to redirect to `/tickets`.
- **`src/routes/knowledge.js` — ACCESS_DENIED on edit/update redirected to detail
  (LOW, correctness).**
  Same double-denial pattern as tickets. Changed all three handlers to
  redirect to `/knowledge`.
- **`src/routes/staff.js` — show checked access before existence (LOW, correctness).**
  A missing id produced `access_denied` instead of `not_found`, confusing
  enumeration probes with privilege escalations. Reordered to fetch first,
  then check access.
- **`src/routes/auth.js` — flash sentence trailing-period outlier (LOW, consistency).**
  Three required-field flashes omitted periods (`Current password is required`
  etc.) while every other flash carried one. Added trailing periods.
- **`src/middleware/auth.js` — corrupt-uid redirect missed `reason=session_expired`
  (LOW, completeness).**
  The `user.id == null` branch redirected to `/login` without a reason
  parameter; added `/login?reason=session_expired` to mirror the intentional
  expiry path.
- **Views — 12 decorative `<i>` icons missing `aria-hidden` (LOW, a11y).**
  Systemic sweep across nav partial (flash icons, pagination disabled chevrons),
  projects/show (Edit/Delete/Task/Team icons), licenses/show (Edit/Delete icons),
  and tickets/show (satisfaction stars). All now carry `aria-hidden="true"`.
- **`views/partials/nav.ejs` — sidebar toggle missing `aria-expanded`/`aria-controls`
  + Escape key (LOW, a11y).**
  Added `aria-expanded="false"` and `aria-controls="sidebar"` to the toggle
  button; `public/js/app.js` now syncs `aria-expanded` on toggle and close
  (click-outside + Escape key).
- **`views/pages/knowledge/index.ejs` — featured star/check missing accessible name
  (LOW, a11y).**
  Added `sr-only` inline label `(featured)` next to the icon.
- **`views/pages/dashboard.ejs` + `licenses/index.ejs` — progressbar labels lacked
  context (LOW, a11y).**
  Added `<span class="sr-only">` prefixes so screen readers announce e.g.
  `"Williams, J: 40%"` instead of just `"40%"`.
- **`views/pages/licenses/show.ejs` — key display missing `aria-live` (LOW, a11y).**
  The reveal-button updates the masked key span dynamically; added
  `aria-live="polite"` so AT announces the change.
- **`views/pages/reports/assets.ejs` — double `badgeClass` call + red-for-unknown (LOW,
  correctness).**
  The condition rating was passed twice (once with fallback, once without) and
  unknown ratings rendered as red. Deduplicated to a single call with a
  `|| 'good'` fallback and removed the separate red branch.
- **Views — nullable badge values missing fallbacks (LOW, consistency).**
  `assets/index`, `knowledge/index`, `changes/index`, `licenses/index` all
  passed potentially-null enum values to `badgeClass`. Added `|| 'default'`
  fallbacks matching each entity's most common value.
- **`views/pages/licenses/form.ejs` + `knowledge/form.ejs` + `tickets/show.ejs` —
  checkbox labels missing `for`/`id` association (LOW, a11y).**
  Added `id` attributes to the checkboxes and matching `for` attributes on
  their `<label>` elements.
- **`public/css/app.css` — missing `.sr-only` + `button:focus-visible` (LOW, a11y).**
  Added screen-reader-only utility and a `button:focus-visible` rule so keyboard
  focus is visible on interactive elements.
- **`README.md` — `bcrypt` → `bcryptjs`, real clone URL, structure gaps (LOW, docs).**
  Updated Tech Stack and Security rows to match the actual dependency; added
  the real repo URL; added `.github/workflows/ci.yml` to the project tree;
  expanded the gitignore description; updated Rate Limiting bullet.
- **`tests/code_review_166.test.js` — 21 regression tests.**
  Source pins for DB_PATH anchoring, safeId float rejection, parseBooleanFlag
  JSON support, jest.setup options forwarding, clamp/floor warnings, projects
  budget gate, denial redirects, staff fetch-first, flash periods, middleware
  reason param, a11y properties, badge fallbacks, checkbox labels, and docs.

Deliberately unchanged: the license key last-four display to privileged users
stays (audited only on read; full reveal goes through a separate AJAX endpoint
and the limiter); the ticket asset search-link acts as a deliberate existence
oracle for staff who already have show access; the no-op
`resetCachedStatements` stubs in route modules are left as API-consistency
markers (the real cache lives in `utils.js` and is cleared there); the
systemic `<i>` sweep covers all decorative icons found in this pass — remaining
icons in the app are on labelled/interactive controls that already carry
`aria-hidden`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **956 passed / 956 total** (47 suites, +21 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (165th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One fail-open correctness defect, one
redirect-target defect, and ten LOW consistency/completeness/a11y/docs
defects were closed.

### Fixes applied
- **`src/routes/projects.js` — add-task silently defaulted present non-string `status`/`priority` (LOW, correctness).**
  The guard only covered `description`; `status`/`priority` are
  validate-when-present with `|| 'todo'`/`'medium'` defaults, so a JSON
  `{"status": 5}` trimmed to `''`, skipped the enum check, and stored the
  default with success. Extended the guard to
  `['description', 'status', 'priority']`, mirroring the full-update guard and
  the changes.js create guard.
- **`src/routes/staff.js` — `PUT /:id/reactivate` NOT_FOUND redirected to the non-existent detail page (LOW, correctness).**
  `return res.redirect(`/staff/${id}`)` on a missing id re-404s; vendors
  deactivate/reactivate NOT_FOUND, staff update/reset/deactivate NOT_FOUND all
  go to the list. Fixed to `/staff`; `alreadyActive` still goes to detail (it
  exists).
- **`src/routes/changes.js` — `INVALID_DATE_FIELDS` omitted `Date` while create uses it (LOW, consistency).**
  Create flashes `Invalid Scheduled Start Date`/`End Date`; update via the map
  flashed `Invalid Scheduled Start`/`End` (and `Actual Start`/`End`). Added
  the `Date` suffix to all four map values.
- **`src/routes/tickets.js` — quick-status rejected padded status while full update trims (LOW, consistency).**
  `PUT /:id/status` used raw `safeQueryValue`; full `PUT /:id` trims, so
  `' in_progress '` was rejected here but accepted there. Now trims (still
  fail-closed: non-strings collapse to `''` and fail the enum check).
- **`src/routes/licenses.js` — `Invalid license key` casing outlier (LOW, consistency).**
  Every other `Invalid X` is Title-Cased (`Invalid License Type`, `Invalid
  Cost Amount`, ...). Fixed to `Invalid License Key`; updated
  `tests/code_review_141.test.js`.
- **`src/routes/assets.js` — asset-tag format message trailing-period outlier (LOW, consistency).**
  The only validation flash with `.` in the file; all siblings (`must be at
  most`, `Invalid X`, `required`) carry none. Dropped the period.
- **`views/pages/projects/show.ejs` — quick-status select missing accessible name (LOW, a11y).**
  Sibling add-task/add-member inputs all carry `aria-label`s (pass 164). Added
  `aria-label="Task status for <%= t.title %>"`.
- **`views/pages/vendors/index.ejs` — rating stars missing AT wrapper (LOW, a11y).**
  Show page wraps with `role="img" aria-label="N out of 5 stars"` and hides
  icons; index rendered bare icons. Mirrored the show pattern.
- **`views/pages/tickets/show.ejs` — satisfaction stars missing `aria-hidden` + wrapper (LOW, a11y).**
  Added `aria-hidden="true"` to both loops and a `role="img"` wrapper with
  `aria-label`, mirroring `vendors/show.ejs`.
- **`tests/templates.test.js` — `recentTickets` fixture omitted `assigned_to` (LOW, test completeness).**
  Same gap pass 164 fixed for `owner_id`. Route always selects the column and
  the template gates on it; the fixture passed only via the admin bypass.
  Added `assigned_to: 1`.
- **`README.md` — structure/config gaps (LOW, docs).**
  Tree omitted `.editorconfig`/`.gitignore`; `DB_PATH` default read as
  CWD-relative while code anchors to the repo root. Added both tree lines and
  clarified the default.
- **`CODE_REVIEW.md` — normalized 143rd/144th/145th headings to the undated format (LOW, docs).**
- **`tests/code_review_165.test.js` — 11 regression tests.**
  Source pins for the task guard, date labels, trim, casing, period, and
  reactivate redirect; render pins for the select label and both star wrappers.

Deliberately unchanged: staff/show assigned-ticket/asset links stay ungated —
the show route only renders for privileged viewers (who can open anything) or
self (whose assigned items trivially satisfy `canAccessResource`), so gating
would be dead code; self-denial guardrails (own role/deactivate/password-reset)
write no `access_denied` audit by design (user errors, not boundary probing —
privileged-escalation denials already audit per pass 164); the vendors
active-delete workflow guard stays unaudited (workflow enforcement, not an
access denial); the systemic decorative-`<i>` sweep was deferred (pass 164
covered all labelled/interactive controls; remaining icons are pure decoration).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **930 passed / 930 total** (46 suites, +11 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (164th pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth-bypass, rate-limit, or
error-leakage defects were found. One correctness defect, three
consistency defects, and fourteen LOW consistency/completeness/a11y/docs
defects were closed.

Note on numbering: `git log` contains two commits each labelled 161 and 162
(the earlier pair covers title-case consistency and is not separately
documented below); the 163rd entry continues that numbering. Older sections
below have non-contiguous numbers (e.g. missing 152nd/151st, 136th/135th)
because some historical passes were squashed or documented only in git log —
left as-is for archaeology. The 143rd/144th sections below were reordered
into descending order.

### Fixes applied
- **`views/pages/reports/assets.ejs` — unguarded `daysUntil()` null rendered `critical` + `null days` (LOW, correctness).**
  `daysUntil()` returns `null` for invalid input, but `null <= 30` coerces to
  `true`, so an unparseable `warranty_expiry` rendered a `critical` badge with
  literal `null days`. Added a `days === null` guard rendering `-`, mirroring
  `assets/show.ejs` (`_wDays !== null`), `projects/show.ejs` (`_tDays !==
  null`), and `licenses/index.ejs` (`_expDays !== null`).
- **`views/pages/reports/assets.ejs` — condition severity collapsed to green/orange (LOW, consistency).**
  `badgeClass(...) === 'low' ? 'green' : 'orange'` mapped both `fair→medium`
  and `poor/broken→critical` to `orange`, while `reports/tickets.ejs`,
  dashboard workload, and `assets/show.ejs` map `critical→red`. Now
  `low→green`, `medium→orange`, else `red`.
- **`views/pages/staff/show.ejs` — member-role badge missing `|| 'member'` fallback (LOW, consistency).**
  `badgeClass(pm.project_role, ...)` vs `titleCase(pm.project_role ||
  'member')`: a NULL role yielded `badge-null` (no CSS) with `Member` text.
  Now `badgeClass(pm.project_role || 'member', ...)`, mirroring line 62
  (`staffUser.role || 'staff'`).
- **`views/pages/vendors/show.ejs` — missing empty-star loop (LOW, consistency).**
  Only filled stars rendered, so `3★` was ambiguous vs `3★☆☆` on
  `vendors/index.ejs` and `tickets/show.ejs`. Added the empty-star loop with
  `aria-hidden="true"`.
- **`views/pages/projects/show.ejs` — add-task/add-member inputs missing accessible names (LOW, a11y).**
  `input[name=title]`, `select[name=priority]`, `select[name=assigned_to]`,
  `select[name=user_id]`, `select[name=role]` had placeholder only. Added
  `aria-label`s, matching every filter-bar select. The icon-only Add-member
  button gained `aria-label="Add member" title="Add member"`, matching the
  `licenses/show.ejs` reveal-button convention from pass 163.
- **`views/pages/auth/profile.ejs` + `views/pages/vendors/form.ejs` — label association (LOW, a11y).**
  Disabled Username/Role inputs had `<label>` with no `for`/`id`; vendors edit
  used `<label>Status</label>` on a static badge (invalid HTML). Added
  `for`/`id` pairs; vendors status now uses `<span
  class="detail-label">`.
- **Decorative `<i>` missing `aria-hidden="true"` (LOW, a11y consistency).**
  Index eye buttons already hide icons; `licenses/show.ejs` reveal,
  `projects/show.ejs` add/delete/remove, `tickets/show.ejs` star buttons, and
  `nav.ejs`/`pagination.ejs` labelled controls exposed icons to AT. Added
  `aria-hidden="true"` to each.
- **`src/routes/knowledge.js` — `resolveSafeFeatured` cleared featured on JSON `null` (LOW, consistency).**
  Preserved on `undefined`/`''` only; `null` fell through to
  `parseBooleanFlag(null)→0`. Now treats `null` as absent-preserve, mirroring
  tags (`rawTagsAbsent` includes `null`) and `resolveOptionalField`.
- **`src/routes/projects.js` — `Invalid Amount Spent` vs `Invalid Spent Amount` (LOW, consistency).**
  Create flashed `Invalid Spent Amount`, update threw `Invalid Amount Spent`
  for the same field (budget uses `Invalid Budget Amount` both places).
  Unified update to `Invalid Spent Amount`; updated `tests/hpp.test.js`.
- **`src/routes/projects.js` — task `status`/`priority` + member `role` missing `trim` (LOW, consistency).**
  Project `status`/`priority`, tickets, changes, staff role, license type, and
  vendor category all `trim` before enum checks; task/member paths used raw
  `safeQueryValue`, so `' lead '` was rejected here but accepted elsewhere.
  Now trims (still fail-closed: non-strings collapse to `''` and fail the
  enum check).
- **`src/routes/staff.js` — three privileged-escalation denials wrote no `access_denied` audit (LOW, completeness).**
  Create privileged-account, update assign-privileged, and update
  modify-admin outer guards only flashed, while the edit-GET and
  transactional recheck audit the same conditions. Added `req.audit(...)`
  lines so manager probing leaves a trail.
- **`tests/dashboard.test.js` — `assetStats` assertion omitted `reserved` (LOW, test completeness).**
  Same gap pass 150 fixed in `templates.test.js`. Added the property.
- **`tests/templates.test.js` — dashboard fixtures omitted uncapped counts; staff/show fixtures lacked `owner_id` (LOW, test completeness).**
  Added `expiringWarrantiesCount/licenseAlertsCount: 0` (exercises the real
  branch, not the `list.length` fallback) and `owner_id: 1` to task/membership
  fixtures (exercises the link branch, not just plain text).
- **`package-lock.json` — synced `engines` with `package.json` (LOW, docs).**
  Pass 163 added `npm >= 8` without regenerating the lock; ran `npm install
  --package-lock-only`.
- **`src/seed.js` — hardcoded ticket `due_date` drifted into the past (LOW, completeness).**
  `2026-05-25` is overdue on any later seed while tickets otherwise use
  relative `isoDaysAgo` and changes use relative `changeAt()`. Now anchors
  `+14 days` via `isoDateDaysFromNow()`.
- **`jest.setup.js` — locale pin covered numbers, not dates (LOW, test determinism).**
  Pinned locale-less `Intl.DateTimeFormat` to en-US, mirroring the
  `Intl.NumberFormat` pin from pass 141.
- **`README.md` — config/structure gaps (LOW, docs).**
  `PORT` range/fallback, `PRUNE_AUDIT_INTERVAL_MS` `0`-disables, `PAGE_SIZE`
  clamp/fallback, hardcoded timeouts note (`30s`/`5s`/`6s`/`24h`), and
  root-file tree entries (`.env.example`, `.nvmrc`, `CODE_REVIEW.md`,
  `eslint.config.js`, `jest.setup.js`, lockfile).
- **`tests/code_review_164.test.js` — 14 regression tests.**
  Source pins for featured-null, spent wording, trim, and staff audits;
  render pins for warranty null-guard, severity red, badge fallback,
  empty stars, a11y labels, and icon hiding.

Deliberately unchanged: dashboard `upcomingChanges`/`licenseAlerts` stay
globally visible to all authenticated users (no per-user scoping) — the
dashboard is an operational overview by design (global ticket/asset/project
stats, team workload, recent tickets with link gating but visible titles per
pass 141/149), and per-user scoping would break the shared TTL cache (which
would need per-user keys or fresh queries like `myTickets`); the changes-list
scoping remains enforced on the list/show routes themselves. Ticket/asset/
project list scoping stays open per pass 163.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **919 passed / 919 total** (45 suites, +14 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (163rd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, auth, rate-limit, or error-leakage defects
were found. One HIGH-severity partial-update correctness defect, three
MEDIUM fail-closed/absent-preserve defects, and ten LOW
consistency/completeness defects were closed.

Note on numbering: `git log` contains two commits each labelled 161 and 162
(the earlier pair covers title-case consistency and is not separately
documented below); this entry continues as 163 to avoid further collision.
The 143rd/144th sections below were reordered into descending order.

### Fixes applied
- **`src/routes/staff.js` — `_staffUserStmt` omitted `department`/`phone`, wiping them on partial update (HIGH, correctness).**
  The update transaction resolves both fields via `resolveOptionalField(...,
  recheck.department/recheck.phone)`, but the recheck SELECT only fetched
  `id, role, username, is_active`, so `recheck.department/phone` were always
  `undefined` and an absent field resolved to `undefined` (stored as NULL)
  instead of preserving the stored value. Expanded the SELECT to include
  `department, phone`.
- **`src/routes/assets.js` — create silently defaulted present non-string `status`/`condition_rating` (MEDIUM, consistency).**
  `trim()` coerced a JSON number/object to `''`, which fell through to the
  `'in_storage'`/`'good'` defaults with a success flash, while the update route
  already fails closed on both. Added both fields to the create-route
  non-string guard loop.
- **`src/routes/changes.js` — update silently preserved on present non-string `status` (MEDIUM, consistency).**
  Only `priority` had an explicit `typeof` guard; a non-string `status`
  collapsed to `''`, skipped the validate-when-present enum check, and
  preserved with success. Generalized the guard to `for (const field of
  ['priority', 'status'])` with per-field messages.
- **`src/routes/knowledge.js` — update wiped stored `tags` on absent field (MEDIUM, consistency).**
  An absent `tags` (partial API PUT) trimmed to `''` and sanitized to NULL,
  clearing the stored value, while `status`/`is_featured` already preserve via
  `status || recheck.status` / `resolveSafeFeatured`. Added
  `rawTagsAbsent` resolution against `existing.tags` (absent preserves,
  explicit empty clears), mirroring `resolveOptionalField`.
- **`src/routes/tickets.js` — `USER_INACTIVE` comment-path wrote no `access_denied` audit entry (LOW, completeness/audit gap).**
  The sibling `ACCESS_DENIED` branch audits, but the inactive-account branch
  only flashed/redirected. Added a defensive `typeof req.audit === 'function'`
  audit line so the probe is observable without crashing unit-test harnesses
  that invoke the handler without `auditMiddleware`.
- **`src/middleware/auth.js` + `src/routes/auth.js` + `src/routes/staff.js` — error-message trailing-period consistency (LOW, consistency).**
  Declarative denial sentences without periods while siblings carry them:
  `"Please log in to access this page"`, `"You do not have permission to
  access this page"` (middleware), `"Please enter username and password"` (×2,
  login), `"New password must be different from current password"` (profile),
  `"Your current password is required to reset another user's password"`
  (staff reset). Added trailing periods. Short validation labels (`"Name and
  category are required"`, `"must be at most N characters"`, `"already
  exists"`) intentionally left without periods per the pass 144 convention.
- **`views/pages/audit/index.ejs` — double-escaped `details` in `title` attribute (LOW, correctness).**
  `title="<%= escapeHtml(...) %>"` escaped twice (`<%=` already escapes), so
  tooltips rendered `&amp;lt;` literally. Changed to `title="<%-
  escapeHtml(...) %>"` (single-escape). Existing XSS tests still pass via the
  cell content; the new regression pins the absence of `&amp;lt;`.
- **`views/pages/staff/show.ejs` + `src/routes/staff.js` — Active-Tasks project links ungated (LOW, consistency/audit noise).**
  The link targeted the project show route (`canAccessResource`, owner-only)
  unconditionally, guaranteeing `access_denied` for task-assignees who are not
  owners. `_assignedTasksStmt` now selects `p.owner_id` and the template gates
  behind `isPrivileged(user) || Number(t.owner_id) === Number(user.id)`,
  mirroring the project-membership gating. Assigned-ticket/asset links remain
  ungated (safe: viewer can only reach this page for self or as privileged,
  and both surfaces are viewer-accessible by construction).
- **`views/pages/licenses/show.ejs` — icon-only reveal button missing accessible name (LOW, a11y).**
  Added `aria-label="Reveal license key" title="Reveal license key"`,
  matching every other icon-only button in the app.
- **`views/pages/staff/form.ejs` — fail-open `viewerRole` default (LOW, completeness).**
  A missing `viewerRole` defaulted to the full `USER_ROLES` list. Changed to
  fail-closed (`['staff']`) while keeping the `typeof` guard so a missing
  value cannot throw `ReferenceError`. Both current renders pass the role.
- **`README.md` — project-structure and config gaps (LOW, docs).**
  Added `nav-close` to the partials line, top-level `dashboard.ejs/404.ejs/
  error.ejs` to the pages tree, `/true` to the `TRUST_PROXY` row (implemented
  in `app.js`, documented in `.env.example`), and the three additional seed
  staff accounts (`trodriguez/akimura/dmuller`) sharing `SEED_PASSWORD`.
- **`package.json` — added `npm >= 8` to `engines` (LOW, docs).**
  Matches the README Prerequisites (`Node.js >= 20`, `npm >= 8`).
- **`CODE_REVIEW.md` — swapped 143rd/144th sections into descending order (LOW, docs).**
- **`tests/code_review_163.test.js` — 14 regression tests.**
  Source pins for the staff SELECT, assets/changes guards, knowledge
  absent-preserve, tickets defensive audit, and flash periods; render pins for
  audit single-escape, staff task-link gating (privileged/plain/owner), license
  aria-label, and staff-form fail-closed default.

Deliberately unchanged: ticket/asset/project list scoping stays open by design
(queue/inventory visibility with link gating per pass 141 — scoping would break
the "All Assignees" filter and dashboard workload assumptions); the
`licenses.js` `POST /:id/key` `rejectHppArrays(['license_key'])` guard stays as
defense-in-depth (pinned by `tests/hpp.test.js`) despite reading only
`params.id`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **905 passed / 905 total** (44 suites, +14 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (162nd pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found. The application code remains at the same hardening
plateau. Two consistency/completeness fixes were applied.

### Fixes applied
- **`src/routes/staff.js` — error-message trailing-period consistency (LOW, consistency).**
  Four permission-denial flash messages in the staff route lacked trailing
  periods while the cross-route convention (used by tickets.js, assets.js,
  projects.js, changes.js, and knowledge.js) consistently appends one to
  declarative denial sentences. Added trailing periods to:
  `"You cannot modify administrator or manager accounts"` (edit route outer
  guard, update route outer guard, and update route transactional guard) and
  `"You cannot change your own role"` and `"You cannot reset your own password
  via this route"`.
- **`tests/code_review_124.test.js` — updated regression assertions.**
  Bumped the expected flash messages in the self-role-change and self-password-
  reset tests to match the corrected staff.js strings so the regression guards
  stay in sync.
- **`package.json` — `qs` overridden to `^6.16.0` (MEDIUM, security).**
  Two moderate-severity CVEs in qs ≤ 6.15.3: array-limit bypass via bracket-key
  comma parsing (GHSA-x5fp-wj9c-mxmx) and Denial of Service via attacker-
  controlled isBuffer (GHSA-4mjr-xmp4-gh2g). Although this app uses the Express
  "simple" query parser (which bypasses qs entirely), qs remains a transitive
  dependency of body-parser/express. Lifting it to ^6.16.0 via the overrides
  table eliminates both advisories and hardens the pipeline against future
  configuration drift.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **891 passed / 891 total** (43 suites, 0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (161st pass)

A full re-read of all 12 route modules, both middleware modules, utils,
constants, models, seed, app.js, all EJS views, `public/js/app.js`, and the
docs. No new SQL injection, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found. The application code remains at the same hardening
plateau. Three consistency/completeness fixes were applied.

### Fixes applied
- **`src/routes/tickets.js` — error-message trailing-period consistency (LOW, consistency).**
  The "Selected asset does not exist." flash message in the create and update
  catch blocks retained a trailing period that contradicted the cross-route
  convention: every other route uses the same construction without a period
  (`Selected assignee is not available`, `Selected owner is not available`,
  `Selected user is not available`). Removed the period from both occurrences
  so the ticket route matches the established pattern.
- **`src/routes/staff.js` — error-message trailing-period consistency (LOW, consistency).**
  The self-deactivation guard used `"You cannot deactivate your own account"`
  without a trailing period while the closely related privilege guard above it
  (`"Only administrators can assign the manager or admin role."`) included one.
  Added the period so both permission-denial sentences follow the same style.
- **`tests/code_review_124.test.js` — updated regression assertion.**
  Bumped the expected flash message in the self-deactivation test to match the
  corrected staff.js string so the regression guard stays in sync.
- **`views/pages/projects/index.ejs` — fixed missing opening quote on ARIA attribute (LOW, correctness).**
  The progress-bar `aria-valuemin` attribute was rendered as `aria-valuemin=0"`
  (missing the opening `"`) due to a typo. Fixed to `aria-valuemin="0"` to match
  the identical element in `projects/show.ejs` and all other progress bars in the
  app. Without the fix the attribute was silently ignored by browsers, leaving
  the progress bar without proper ARIA semantics.
- **`views/pages/licenses/index.ejs` — added defensive access gating on list links (LOW, completeness).**
  The vendor list view received defensive link gating in pass 147 to prevent
  guaranteed-denial audit noise when non-privileged users somehow reach a
  privileged-only page. Applied the same pattern here: software-name cells and
  action buttons are now gated behind `isPrivileged(user)` so future route
  relaxations cannot produce spurious access-denied flashes on routine navigation.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **891 passed / 891 total** (43 suites, 0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (160th pass)

Two dependency vulnerabilities were found and fixed. The application code
itself remains at the same hardening plateau — no new SQL injection, CSRF,
XSS, auth, rate-limit, or error-leakage defects were found in source.

### Fixes applied
- **`package.json` — `sanitize-html` upgraded from `2.17.5` to `^2.17.7`
  (HIGH, security).** CVE-2026-84371 / GHSA-g8qq-57p8-ggw5: sanitize-html
  ≤ 2.17.6 allows stored XSS via SVG SMIL URI-list scheme-policy bypass when
  SVG animation tags are allowed. Although this app's `SANITIZE_HTML_OPTIONS`
  does not permit `<svg>` / `<animate>`, upgrading eliminates the advisory
  and hardens the pipeline against future configuration drift.
- **`package.json` — `browserslist` added as direct dep at `^4.28.8`
  (HIGH, security).** Two CVEs in browserslist ≤ 4.28.6: unbounded memory
  growth via distinct query results (GHSA-c83g-rgw3-j3cx) and uncaught crash
  / prototype write via untrusted `browserslist-stats.json` (GHSA-73wf-gq98-2v4g).
  The package was already present as a transitive dependency but ungated;
  lifting it to a direct dep with a patched version range removes both
  advisories.
- **`tests/knowledge.test.js` — added CJS-compatible `sanitize-html` mock
  (LOW, test compatibility).** sanitize-html@2.17.7 depends on htmlparser2@12
  which is ESM-only (`"type": "module"`); Jest's CJS runtime cannot parse it,
  so the test suite mocks the module with a CJS shim that mirrors the real API
  surface (`function`, `.defaults`, `.simpleTransform`) and the sanitization
  behaviour exercised by the tests. The fallback path (plain-text escape when
  sanitize-html is unavailable) remains covered by
  `tests/knowledge_sanitize_fallback.test.js`.
- **`src/routes/knowledge.js` — updated fallback error message to reference
  `^2.17.7` instead of `2.17.5`.** Keeps the operator-facing guidance in sync
  with the pinned dependency.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **891 passed / 891 total** (43 suites, 0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle (159th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau. This pass verified: all 6 badge mapping constants
(`CONDITION_BADGE`, `CHANGE_TYPE_BADGE`, `ROLE_BADGE`, `MEMBER_ROLE_BADGE`,
`KB_CATEGORY_BADGE`, `LICENSE_TYPE_BADGE`) remain complete — every enum value
across all constants maps to a severity with zero hardcoded classes in
templates; all 9 list views carry the "adjust filters" empty-state hint
(tickets uses "Create a new ticket or adjust your filters" which is appropriate
for its mixed-create/list audience); `resetCachedStatements` is exported from
every route and middleware module (14 total, covered by `tests/reset_cached_statements.test.js`);
the `resolveOptionalField` JSDoc accurately describes its behavior (rejects
non-string `rawValue` with `{ error: true }`, coerces non-string
`processedValue` via `String(...)` before truncation); all flash messages follow
the trailing-period convention (sentence-style end with periods; short validation
labels do not); all 34 `db.transaction()` boundaries and all 39
`rejectHppArrays` call sites remain correct; and all `res.locals` helpers and
badge constants referenced by templates are wired in `app.js`. No changes are
needed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **891 passed / 891 total** (43 suites, 0 net).

---

## Review cycle (158th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau. This pass confirmed badge mappings remain complete and
centralized (every enum value across all six `*_BADGE` constants is present —
zero hardcoded severity classes remain in templates; dashboard ticket
priority/status badges use the raw enum as a CSS class name, which is the
established convention for those monomorphic surfaces), verified all 9 list
views carry the "adjust filters" empty-state hint, re-checked that partial-update
absent-field resolution is consistent across all UPDATE routes (vendors.js,
licenses.js, projects.js, changes.js, assets.js, tickets.js, staff.js all use
`resolveOptionalField` or equivalent resolution logic; knowledge.js intentionally
omits it because its update route has no optional text fields — title/content/
category are required and status/is_featured have their own helpers), confirmed
all 34 `db.transaction()` boundaries and all 39 `rejectHppArrays` call sites
remain correct, and verified flash-message trailing-period consistency across
all route modules (sentence-style messages end with periods; short validation
labels do not — the established convention). No changes are needed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **891 passed / 891 total** (43 suites, 0 net).

---

## Review cycle (157th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau. This pass verified completeness across all badge
mappings (every enum value in `CONDITION_BADGE`, `CHANGE_TYPE_BADGE`,
`ROLE_BADGE`, `MEMBER_ROLE_BADGE`, `KB_CATEGORY_BADGE`, and `LICENSE_TYPE_BADGE`
is present — no hardcoded severity classes remain in templates), confirmed all
9 list views carry the "adjust filters" empty-state hint, and re-checked that
partial-update absent-field resolution is consistent across all 8 UPDATE routes
(vendors.js, licenses.js, projects.js, and changes.js all use
`resolveOptionalField`; knowledge.js intentionally omits it because its update
route has no optional text fields — title/content/category are required, and
status/is_featured have their own resolution helpers). One correctness defect
was closed: two redirect targets in `staff.js` PUT /:id pointed to the edit
page (`/staff/${id}/edit`) instead of the list page (`/staff`) on NOT_FOUND and
ACCESS_DENIED_ADMIN, creating a confusing redirect loop when the target staff
member no longer exists. Mirrors the convention used by every other route
module (assets → `/assets`, tickets → `/tickets`, projects → `/projects`,
vendors → `/vendors`, changes → `/changes`, licenses → `/licenses`). +2
redirect fixes, 0 test changes.

### Fixes applied

**Correctness (redirect consistency on staff update)**
- **`src/routes/staff.js` — NOT_FOUND catch redirects to edit page instead of list (LOW, consistency).** The outer pre-transaction check at line 464–468 correctly redirects to `/staff` on not-found; the inner transaction catch at line 577–579 redirected to `/staff/${id}/edit` instead. A non-existent staff member triggers a double-flash loop (edit page also says "not found", redirecting back to edit). Fixed to `/staff`, matching every other route module.
- **`src/routes/staff.js` — ACCESS_DENIED_ADMIN catch redirects to edit page instead of list (LOW, consistency).** The outer pre-transaction check at line 485–487 correctly redirects to `/staff` for a non-admin user editing an admin/manager account; the inner transaction catch at line 581–587 redirected to `/staff/${id}/edit` instead. Fixed to `/staff`, matching the outer guard and every other route module.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **891 passed / 891 total** (43 suites, 0 net).

---

## Review cycle (156th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass verified that no HPP arrays slip through
unchecked into template rendering (all 43 test suites cover the array-rejection
guards on body and query fields), confirmed the `res.json()` license-key
endpoint and health endpoint use safe serialization with no manual HTML
escaping needed, verified the CSRF token meta tag in `header.ejs` guards
against unauthenticated error renders with `typeof csrfToken !== 'undefined'`,
and re-checked that all 39 `rejectHppArrays` call sites and all 34
`db.transaction()` boundaries are present and correct across every write route.
No changes are needed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **891 passed / 891 total** (43 suites, 0 net).

---

## Review cycle (155th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass verified completeness across all list-page
empty-state hints (all 9 list views carry the "adjust filters" hint), confirmed
all badge mappings are centralized through `badgeClass()` with no hardcoded
severity classes on enum values, and re-checked that no access-gated links
leak through show-page sidebars (ticket/asset/project links in staff/show are
safe because non-privileged users can only view their own profile). No changes
are needed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **891 passed / 891 total** (43 suites, 0 net).

---

## Review cycle (154th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass closed one correctness defect: the changes
update route passed the raw `status` variable directly to the UPDATE statement
instead of resolving it against the transaction-consistent re-fetch. When an
API caller omitted `status` on a partial PUT, `trim(undefined)` produced `''`,
which was written into the CHECK-constrained `status` column, throwing
`SQLITE_CONSTRAINT` and surfacing as a generic server error. The fix mirrors
the `effectiveStatus` resolution already used by tickets.js, assets.js, and
projects.js. +1 regression test pins the absent-status preservation contract.

### Fixes applied

**Correctness (partial-update status resolution)**
- **`src/routes/changes.js` update — raw `status` written into CHECK-constrained column on absent field (MEDIUM, correctness).** The outer guard validated `status` only when present (`if (status && !VALID_STATUSES.includes(status))`), so an absent or empty submission passed through. Inside the transaction the raw value was bound directly to the UPDATE statement, writing `''` into the `status` column and violating `CHECK(status IN ('scheduled','in_progress','completed','failed','cancelled'))`. The transaction threw `SQLITE_CONSTRAINT` which bubbled up as an unhandled server error. Hoisted `effectiveStatus` outside the transaction callback, resolved it inside against `existingChange.status` when the submitted value is absent/empty (mirroring tickets.js `const effectiveStatus = status || ticket.status;`, assets.js `VALID_STATUSES.includes(status) ? status : current.status`, and projects.js `statusProvided ? status : existingProject.status`), and updated the audit message to report the effective status.

### Test coverage
- **`tests/partial_update.test.js` — 1 regression test.** Pins that a partial PUT omitting `status` preserves the existing stored status in the UPDATE statement's fourth parameter, preventing the SQLITE_CONSTRAINT crash.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **891 passed / 891 total** (43 suites, +1 net).

---

## Review cycle (153rd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass verified completeness across all list-page
empty-state hints (all 9 list views carry the "adjust filters" hint), confirmed
all badge mappings are centralized through `badgeClass()` with no hardcoded
severity classes on enum values, and re-checked that no access-gated links
leak through show-page sidebars (ticket/asset/project links in staff/show are
safe because non-privileged users can only view their own profile). No changes
are needed.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **890 passed / 890 total** (43 suites, 0 net).

---

## Review cycle (150th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass closes one test-fixture consistency gap:
the `assetStats` shape in `tests/templates.test.js` was missing the `reserved`
subtotal that pass 140 added to `EMPTY_DEFAULTS` and the dashboard query, so
the fixture diverged from the route's actual output contract.

### Fixes applied

**Test fixture consistency**
- **`tests/templates.test.js` — two `assetStats` fixtures omitted `reserved`
  (LOW, test completeness).** Pass 140 added a `reserved` CASE subtotal to the
  dashboard `_assetStatsStmt` and a corresponding `reserved: 0` field to
  `EMPTY_DEFAULTS.assetStats`, so the four subtotals always sum exactly to the
  total. The two template-render fixtures (`"dashboard renders all five dynamic
  list sections"` on line 216 and the empty-state regression on line 329) still
  passed the pre-140 four-field shape `{ total, in_use, in_storage, in_repair
  }`. Updated both to include `reserved: 0` so the fixtures mirror the route's
  current output contract and a future refactor that drops the field will fail
  immediately.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **890 passed / 890 total** (43 suites, 0 net).

---

## Review cycle (149th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass closes four remaining access-gated-link audit-noise
gaps on dashboard, staff directory, staff show sidebar, and asset show sidebar,
and centralizes the last two hardcoded `badge-medium` references behind mapping
constants.

### Fixes applied

**Access-policy consistency (link gating on show-routes that deny staff)**
- **`views/pages/dashboard.ejs` — "Recently Active Tickets" card linked every row unconditionally (LOW, consistency/audit noise).** The query returns all non-terminal tickets (`status NOT IN ('closed','resolved')`), so non-privileged staff see tickets assigned to colleagues; clicking any link triggers a guaranteed `access_denied` flash plus an audit entry. The card now gates ticket-number and title links behind `isPrivileged(user) || Number(t.assigned_to) === Number(user.id)`, matching the convention in `views/pages/tickets/index.ejs:66`. Unlinked cells retain the monospace-weight styling so the row remains readable. The dashboard's `recentTickets` statement was updated to select `assigned_to` so the template can evaluate the gate.
- **`views/pages/staff/index.ejs` — every staff row linked to a show route that denies staff unless self (LOW, consistency/audit noise).** The staff list is open to all authenticated users (directory intent), but the show route gates by `isPrivileged || isSelf`. Unconditional name and eye-icon links generated guaranteed-denial clicks on every cross-profile navigation. Both are now gated behind `isPrivileged(user) || Number(user.id) === Number(s.id)`; non-authorized viewers keep the row visible (full directory visibility is the product intent) but the links render as plain text / a disabled placeholder instead of dead links. Mirrors the pattern fixed for tickets/assets/projects in pass 141 and vendors in pass 147.
- **`views/pages/staff/show.ejs` — project-membership links targeted projects the viewer cannot show (LOW, consistency/audit noise).** The project show route uses `canAccessResource` (checks `assigned_to`/`owner_id`/`user_id`/`author_id`); a non-privileged user who is a project member but not the owner receives a denial on click. The `_projectMembershipsStmt` now selects `p.owner_id` and the template gates the project link behind `isPrivileged(user) || Number(pm.owner_id) === Number(user.id)`. Unlinked rows keep the project name, status, and role badges visible.
- **`views/pages/assets/show.ejs` — related-ticket links targeted tickets the viewer cannot show (LOW, consistency/audit noise).** A non-privileged user viewing an asset assigned to them may see tickets assigned to other staff; clicking those links triggers `access_denied`. The `_relatedTicketsStmt` now selects `assigned_to` and the template gates the ticket link behind `isPrivileged(user) || Number(t.assigned_to) === Number(user.id)`. Unlinked ticket numbers remain visible as plain text.

**Badge constant centralization**
- **`src/constants.js` — `KB_CATEGORY_BADGE` and `LICENSE_TYPE_BADGE` missing (LOW, consistency).** KB article categories and license types were hardcoded to `badge-medium` in four templates (`knowledge/index.ejs`, `knowledge/show.ejs`, `licenses/index.ejs`, `licenses/show.ejs`) while every other categorical field (condition, change type, role, member role) uses a mapping constant referenced through `badgeClass()`. Added both mappings (`Object.freeze({ … })`, all values `'medium'` — categories/types are organizational, not severity-indicating, so uniform medium is the correct semantic) and exported them.
- **`src/utils.js` — re-exported both new constants so templates that depend on `utils`-sourced objects continue to work.**
- **`src/app.js` — wired both new constants into `res.locals` alongside the existing badge mappings, and added them to the `objHelpers` regression assertion in `tests/templates.test.js`.**

### Test coverage
- **`tests/code_review_149.test.js` — 15 regression tests.** Table-driven link-gating tests cover: dashboard recent tickets (privileged sees links, non-privileged sees plain text for others' tickets, privileged link for own tickets), staff index (privileged sees links, non-privileged sees plain text for others' profiles, privileged link for self), staff show project memberships (privileged sees links, non-privileged sees plain text for others' projects, privileged link for own projects), assets show related tickets (privileged sees links, non-privileged sees plain text for others' tickets, privileged link for own tickets). Source-level tests pin `assigned_to` on the dashboard recentTickets statement, `owner_id` on the staff projectMemberships statement, and `assigned_to` on the assets relatedTickets statement. Badge tests assert the new constants are frozen objects with all enum values mapped, that `utils` re-exports them, and that the four affected templates render via `badgeClass()` rather than a literal hardcoded class.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **890 passed / 890 total** (43 suites, +22 net).

---

## Review cycle (148th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass closes one test-reliability gap: a timing
assertion in the session-timeout integration test was too tight under parallel
Jest load, causing intermittent failures during full-suite runs even though the
middleware logic is correct.

### Fixes applied

**Test reliability**
- **`tests/session_timeout.test.js` — tight 400ms latency bound on an unauthenticated GET caused intermittent flakiness under parallel Jest worker load (LOW, test determinism).** The test asserted `Date.now() - before < 400` for a trivial `/touch` request that passes through the full Express stack (session middleware, CSRF cookie setup, res.locals wiring). Under parallel test execution the Node event loop shares CPU with other suites, so even an empty handler can exceed 400ms without any middleware regression. Relaxed the bound to 5000ms — generous enough to be deterministic under load, strict enough to catch a real regression (a handler that hangs would still fail). The functional assertions (status 200, unauthenticated response shape) remain unchanged.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **868 passed / 868 total** (42 suites, 0 net change).

---

## Review cycle (147th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass closes one error-message consistency gap on
the delete-task path, an XSS gap on the audit-details title attribute, and an
access-policy noise gap on the vendors list page.

### Fixes applied

**Consistency**
- **`src/routes/projects.js` — delete-task catch retained "Please try again" diverging from the convention (LOW, consistency).** Pass 138 unified error-message phrasing: create/update catch blocks use "Error Xing. Please try again." while delete catch blocks use the shorter "Error deleting X." (matching assets/vendors/tickets/changes). The task-delete handler was the sole project-route outlier still carrying the longer form. Removed "Please try again." so the delete-task path matches the delete-convention.

**Correctness / security (XSS)**
- **`views/pages/audit/index.ejs` — unescaped `details` in a `title` attribute (MEDIUM, correctness/XSS).** The details column's `title` attribute rendered raw audit details (`title="<%= e.details || '' %>"`). Audit details are user-supplied free-text and can contain HTML; an entry crafted with `<img src=x onerror=alert(1)>` would inject into the DOM when the user hovers the cell. Wrapped the value in `escapeHtml()` (`title="<%= escapeHtml(e.details || '') %>"`) so any angle-bracket content is safely rendered as text. The visible-cell rendering was already safe (`<%= e.details || '-' %>`) — only the hover-title was vulnerable.

**Access policy consistency**
- **`views/pages/vendors/index.ejs` — every row linked to a show route that denies staff (LOW, consistency/audit noise).** The show route is `requireAdminOrManager`; the list route is also `requireAdminOrManager`, but the template linked every row name and action button unconditionally, so any future route-gate relaxation (or an operator reaching the page through an unexpected path) would guarantee a guaranteed-denial click on every row. Gated both the name link and the eye-icon action behind `isPrivileged(user)`. Non-privileged viewers keep the row visible (full list visibility is the product intent) but the links render as plain text / a disabled placeholder instead of dead links. Mirrors the access-gated-link convention established for tickets/assets/projects in pass 141.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **868 passed / 868 total** (42 suites, +4 net).

---

## Review cycle (146th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** Cross-checked audit
calls against the `ALLOWED_ACTIONS`/`ALLOWED_ENTITY_TYPES` allowlists (all
match), the `paginationBaseUrl` allowlist against every list route's query
params (all covered), and flash-message trailing periods against the
138–144 convention (consistent). The codebase remains at a high hardening
plateau; this pass closes one remaining consistency gap on the two error
surfaces.

### Fixes applied

**Consistency**
- **`views/pages/404.ejs` + `views/pages/error.ejs` — unconditional "Go to Dashboard" CTA (LOW, consistency).** Both error pages rendered a dashboard link for every visitor. For an anonymous viewer (expired session, stale bookmark) the link bounces through `/` to `/login` while claiming to go to the dashboard — misleading about the destination. Worse, these pages can render for failures thrown BEFORE the res.locals middleware ran (e.g. body-parser 413/400), the same reason header.ejs guards `csrfToken`, so the CTA is now gated with `typeof user !== 'undefined' && user`. Signed-in visitors keep "Go to Dashboard"; everyone else gets an honest "Go to Login" link. +8 regression tests (`tests/code_review_146.test.js`) covering both pages × {signed-in, null user, undefined user} and the never-both invariant.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **864 passed / 864 total** (40 suites, +8 net).

---

## Review cycle (145th pass)

**Date:** 2026-08-24

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass closes one remaining consistency gap: the
projects list empty state was the only list page without the "adjust filters"
hint text that the 140th pass had standardized across every sibling surface.

### Fixes applied

**Consistency**
- **`views/pages/projects/index.ejs` — list empty state missing the "adjust filters" hint text (LOW, consistency).** Every other list page (assets, tickets, staff, vendors, changes, licenses, knowledge, audit) carries a one-line hint alongside its "No X found" heading so operators know the query returned cleanly rather than the page is broken. `projects/index.ejs` was the sole outlier, rendering only the heading without a hint. Added `"Create your first project or adjust filters"` to bring the projects list in line with the established convention.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **856 passed / 856 total** (40 suites, +1 net).

---

## Review cycle (144th pass)

**Date:** 2026-08-24

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** This pass completes the
trailing-period consistency sweep across all flash messages — error, success,
and info — so every sentence-style message ends with a period (or exclamation
mark where appropriate) and every short label is left without one.

### Fixes applied

**Consistency**
- **All route modules — trailing-period consistency across all flash messages (LOW, consistency).** Error messages received their trailing-period sweep in pass 138; success messages in pass 143. Info messages and the remaining error sentences were the final gap. Added trailing periods to 30 full-sentence messages across 8 route modules (`assets`, `auth`, `changes`, `knowledge`, `projects`, `staff`, `tickets`, `vendors`) and updated the one matching assertion in `tests/knowledge.test.js`. Short validation labels (e.g. "Name and category are required", "Title is required") and dynamic messages sourced from external helpers (`pwErr`, `ratingErr`, `resolved.error`) were intentionally left unchanged.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **855 passed / 855 total** (40 suites, 0 net change).

---

## Review cycle (143rd pass)

**Date:** 2026-08-24

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass completes the success-flash trailing-period
sweep that the error-message sweep in passes 138–139 started.

### Fixes applied

**Consistency**
- **All route modules — success flash messages missing trailing periods (LOW, consistency).** Error messages were standardized with trailing periods in pass 138; success messages were the remaining inconsistent surface. Added periods to 33 messages across 9 route modules (`assets`, `auth`, `changes`, `knowledge`, `licenses`, `projects`, `staff`, `tickets`, `vendors`) so the messaging contract is uniform. Messages already ending in `!` (e.g. `Welcome back, ...!`, `Thank you for your feedback!`) and dynamic multi-sentence messages (e.g. the vendor-delete success path) were left unchanged.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **855 passed / 855 total** (40 suites, 0 net change).

---

## Review cycle 2026-08-20 (142nd pass)

An independent pass (six parallel full re-reads covering all 12 route modules,
both middleware modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The pass completed the
present-but-non-string fail-closed sweep on the remaining update/create routes,
ported the staff update route onto the update-wide absent-vs-empty convention,
and fixed a set of template/test/seed consistency defects. Four agent findings
were verified as non-issues: vendors update already fails closed via
`resolveOptionalField`, staff search uses the same `addSearch`/SQLite-LIKE
case-insensitivity as every other list route, and the database.js `:memory:`
WAL/pragma handling is correct.

### Fixes applied

**Fail-closed enum guards (the changes.js / create-route sweep completed)**
- **`src/routes/tickets.js` update — a present non-string `category`/`priority`/`status` silently "preserved" the stored value with a success flash (MEDIUM, consistency).** `trim(5)` → `''` → skipped the validate-when-present enum check → `category || ticket.category` fallback, so `PUT {"status": 5}` reported success. Added the fail-closed loop (non-string, non-empty, non-null → "Invalid request parameters"), mirroring the changes.js update route.
- **`src/routes/projects.js` update + task full-update — the same hole for `status`/`priority` (MEDIUM, consistency).** Both routes validated only when present, so `trim()`-coerced non-strings fell through to preserve/default with success. Added the fail-closed guard to both; the quick-status path already had a dedicated `typeof status !== 'string'` guard.
- **`src/routes/assets.js` update — the same hole for `condition_rating`/`status` (MEDIUM, consistency).** `category` was already safe (required-and-validated, so a non-string fails as "Invalid category"); `condition_rating`/`status` now fail closed.
- **`src/routes/licenses.js` create — a present non-string `license_type` was stored as NULL with a success flash, and a comment claimed the enum check rejects it (MEDIUM, consistency).** `if (license_type && ...)` only rejects present NON-EMPTY values, so `{"license_type": 5}` trimmed to `''` and inserted NULL. Added `license_type` to the non-string guard loop (the update route was already protected via `resolveOptionalField`) and corrected the misleading "(license_type needs no guard)" comment.
- **`src/routes/knowledge.js` create + update — a present non-string `tags` silently wiped the stored tags / `status` silently defaulted (MEDIUM, consistency).** `{"tags": {"a":1}}` passed HPP rejection, trimmed to `''`, and `sanitizeKnowledgeInput` stored NULL. Added non-string guards for `tags`/`status` on both routes.

**Partial-update convention (staff route completed)**
- **`src/routes/staff.js` update — a partial PUT omitting `department`/`phone` wiped the stored values to NULL (MEDIUM, consistency).** It was the last update handler not on the absent-vs-empty convention every other route uses: `trim()` coerced an absent field to `''` and the UPDATE stored NULL. Both fields now resolve via `resolveOptionalField` against the transaction re-fetch — absent preserves, an explicit empty string clears, present non-string is rejected (defensive sentinels mapped like vendors.js). A present-but-malformed phone and non-string department were already rejected outside the transaction.

**Access-policy audit completeness**
- **`src/routes/knowledge.js` update + delete, `src/routes/staff.js` update — the inner TOCTOU recheck denials wrote no `access_denied` audit entry (MEDIUM, completeness/audit gap).** The outer guards (show/edit role checks) audit, but when the transaction recheck caught a concurrent ownership/role change (`ACCESS_DENIED` / `ACCESS_DENIED_ADMIN`), the catch only flashed. Each catch branch now emits the audit line too, so a concurrent role-change probing attempt is fully observable.

**Seed data contract**
- **`src/seed.js` — scheduled `change_log` rows used hardcoded absolute dates that drift into the past, rendering the Dashboard "Upcoming Changes" panel empty (MEDIUM, completeness).** The three `scheduled` changes were anchored to fixed May/June 2026 timestamps while ticket timestamps use seed-relative `isoDaysAgo`; on any later seed the panel had nothing to show. Scheduled changes now use a `changeAt(daysFromNow, time)` relative helper (5/12/16 days out); completed/failed changes keep absolute historical timestamps (they are past by definition).

**Template / test consistency**
- **`views/pages/reports/assets.ejs` — unpriced assets rendered "$0" while every other template renders "-" (LOW, consistency).** `totalValue.total` COALESCEs to 0 (rendering "$0") and `byCategory.total_value` is NULL for unpriced categories (rendering "$0") — the exact convention pass 141 removed from licenses/index (list) but missed here. Both spots now render "-" (the `Number(x) > 0` guard).
- **`tests/templates.test.js` — the audit-details escape regression only asserted the plain substrings present, so a missing/double escape would pass (LOW, test strength).** Now asserts `foo &amp; bar` and the absence of `<script>`.
- **`tests/code_review_141.test.js` — `$5,000`/`$1,200` assertions depended on the host locale (LOW, test determinism).** `jest.setup.js` now pins locale-less `Intl.NumberFormat` constructions (i.e. `Number(x).toLocaleString()`) to en-US, so a de-DE host can't break them.
- **`tests/seed.test.js` — the next-counter test re-implemented the counter SQL inline and mutated the counter mid-test (LOW, test quality).** Now asserts the seeded counter row directly (equals the last seeded tag's numeric suffix) instead of replaying the assets.js `INSERT ... +1 RETURNING` logic.

### Test coverage
- **`tests/code_review_142.test.js` — 14 regression tests.** Table-driven: tickets (status/priority/category), projects update (status/priority), task update (status), assets (status/condition_rating), licenses create (license_type), knowledge create + update (tags). Behavioral staff update tests pin absent-preserves and empty-clears for department/phone against the actual handler. One template test renders `reports/assets.ejs` pinning the "-" convention for unpriced categories while a priced category still shows `$5,000`.
- **`tests/seed.test.js`** — new test pins all three scheduled changes strictly in the future (dashboard Upcoming Changes stays populated regardless of seed date).
- **`tests/knowledge.test.js`** — the delete ACCESS_DENIED regression now also asserts the new inner-recheck audit entry.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **855 passed / 855 total** (40 suites, +15 net).

---

## Review cycle 2026-08-19 (141st pass)

An independent pass (four parallel full re-reads covering all 12 route modules,
both middleware modules, utils, constants, models, seed, app.js, all EJS views,
`public/js/app.js`, and the docs). **No new SQL injection, CSRF, XSS, or
password/auth defects were found.** The pass surfaced one error-rendering
correctness bug, several access-policy/list-show incoherences in the exact
class passes 114/123/140 established conventions for, a cluster of
partial-update and fail-closed gaps, and a set of metric/consistency defects.

### Fixes applied

**Correctness (error rendering / availability)**
- **`views/partials/header.ejs` — styled error pages crashed with a secondary ReferenceError for errors thrown before the locals middleware (MEDIUM, correctness).** `header.ejs:6` referenced `csrfToken` unguarded while `title` on the next line was guarded. The global error handler renders `pages/error` for body-parser failures (413 payload-too-large, 400 malformed JSON) which `next(err)` out of `express.json()`/`urlencoded()` — middleware that runs BEFORE the `res.locals` middleware assigns `csrfToken`. EJS threw `ReferenceError: csrfToken is not defined`, and Express's final handler replaced the intended styled 413/400 page with a bare-text 500. Guarded the reference (`typeof csrfToken !== 'undefined' ? csrfToken : ''`), mirroring the `title` guard.
- **`src/app.js` — global `writeLimiter` keyed per-IP, inverting the app's documented per-account keying convention (MEDIUM, consistency/availability).** The 100-writes/15-min backstop mounted across all ten write mounts used express-rate-limit's default IP key, so an entire team behind one NAT'd office/proxy IP shared a single budget — the exact failure mode `authKeyGenerator`'s docstring ("one user behind a NAT'd office IP cannot consume the shared budget for the whole team") exists to prevent, and the opposite of every per-route authenticated limiter. Added `keyGenerator: utilsModule.authKeyGenerator` (normalized-IP fallback still bounds unauthenticated abuse).

**Access policy (list/show coherence — the class fixed for licenses pass 114, vendors pass 123/140, knowledge index)**
- **`src/routes/changes.js` — the change LIST rendered restricted metadata to all staff and its search filter was a content oracle on the gated description text (MEDIUM, security/consistency).** The show route gates staff to `canAccessResource` (assigned-only, audited), yet the list rendered every change's title/type/status/priority/schedule/assignee to any authenticated user, and `addSearch(... ['c.title','c.description'])` let a staff user probe whether arbitrary text occurs in restricted descriptions. Changes are privileged-created (`requireAdminOrManager` on create/edit) with no staff write path, so staff's only legitimate surface is assigned changes. Scoped the list WHERE (`c.assigned_to = ?`) for non-privileged users before the clause is built, mirroring the knowledge index's `(k.status = 'published' OR k.author_id = ?)` pattern — count and listing stay in sync.
- **`views/pages/tickets/index.ejs`, `assets/index.ejs`, `projects/index.ejs` — every list row linked to a show route that denies staff unless assigned/owner, guaranteeing an `access_denied` flash + audit entry on routine navigation (MEDIUM, consistency/audit noise).** Queue/inventory/portfolio visibility stays open by design (the "All Assignees" filter, "My Tickets" header button, and dashboard Team Workload all assume it), but the guaranteed-dead links flooded the audit log's most security-relevant stream with noise (alert fatigue). Rows now link only when the viewer can actually open the show route (`isPrivileged(user) || row.assigned_to/owner_id === user.id`); unlinked rows keep full visibility. Added the ownership column to the tickets and projects list SELECTs (assets already selected it).
- **`views/pages/projects/index.ejs` — project cards rendered budget/spent to every viewer (MEDIUM, consistency).** Pass 114 established that cost data is business-sensitive (the licenses list is `requireAdminOrManager` for exactly this), yet project financials rendered to all staff on the cards. Gated the budget/spent line behind `isPrivileged(user)`.

**Partial-update / fail-closed consistency**
- **`src/routes/tickets.js` update — `status`/`category`/`priority` were required on every PUT (MEDIUM, consistency).** Assets, projects, and (since pass 140) task updates all validate-when-present and preserve on absence; tickets was the sole outlier, so a partial JSON PUT that only renamed a ticket failed with "Invalid status". Adopted the convention: enums validate when present; `effectiveCategory/Priority/Status` resolve from the transaction re-fetch (`_updateCheckStmt` now selects all three); the `resolved_at` set/clear CASE flags and the audit message derive from the EFFECTIVE status, so a partial edit of a resolved ticket can no longer clear `resolved_at` and the audit entry reports the persisted value.
- **`src/routes/tickets.js` update — a present non-string `requester_department` silently wiped the stored value (MEDIUM, correctness).** `trim(42)` → `''` → `null` with a success flash, while the create route rejects the identical payload. Now resolved via `resolveOptionalField` with the `INVALID_REQUESTER_DEPARTMENT` sentinel mapped by the existing `INVALID_` catch.
- **`src/routes/projects.js` create — the form-submitted `spent` was silently discarded (MEDIUM, completeness).** The shared create/edit form rendered the input unconditionally, but the create route's HPP list, parsing, and INSERT all omitted `spent` — an initial spend became 0 with a "Project created successfully" flash. Now parsed with the same `safePositiveFloat` fail-closed pattern as budget ("Invalid spent amount" on malformed input) and inserted.
- **`src/routes/projects.js` task-add — a present non-string `description` silently stored NULL (LOW, consistency).** The task UPDATE route rejects it via `resolveOptionalField`; every other create route received the fail-closed guard in pass 140; this one was missed.
- **`src/routes/licenses.js` update — a present non-string `license_key` was silently treated as blank→preserve, discarding the submitted key with a success flash (MEDIUM, consistency).** A numeric JSON key (realistic) hit `trim()` → `''` → preserve-existing, while the create route rejects the same payload and its comment claims parity. Added the fail-closed guard ("Invalid license key").
- **`src/routes/changes.js` update + create — a present non-string `priority` silently preserved the stored value / fell to the 'medium' default (LOW, consistency).** Non-string input collapsed to `''`, skipping the validate-when-present enum check. Both routes now reject present non-empty non-string values; the analogous `license_type` on licenses was already covered by its sentinel.

**Metric / display correctness**
- **`views/pages/dashboard.ejs` — "Active Projects" counted only `in_progress` (MEDIUM, consistency).** The app-wide active-project definition is planning/in_progress/on_hold (see staff.js ownership clearing); the card used only `in_progress` while the route computed — and the template wasted — `planning` and `on_hold`. Same "column existed, unused" pattern as the Active Tickets fix in pass 140. The card now renders `planning + in_progress + on_hold`.
- **`src/routes/staff.js` — the directory's "Open Tasks" column excluded tasks in `review` status (MEDIUM, correctness/consistency).** The ptCounts subquery used `status IN ('todo','in_progress')` while the show route's Active Tasks sidebar and every unassign/recalc query in the same module use `status != 'done'` — a technician with 3 tasks in review read "Open Tasks: 0" in the directory and 3 on their profile. Unified on `status != 'done'`.
- **`src/routes/reports.js` — staff report "Open Tickets" was windowed by creation date while the identically-labeled dashboard Team Workload and staff-directory columns are unwindowed snapshots sharing the same bar encoding (MEDIUM, consistency).** For period=7 a staffer holding 10 tickets created 8+ days ago read 0/green on `/reports/staff` and red on the dashboard. Dropped the `created_at` window from the tOpen subquery — Open Tickets is now a current snapshot on all three surfaces; the period parameter scopes only the resolved/completed (historical) metrics, stated in a comment and pinned by a real-SQL regression test.
- **`views/pages/licenses/index.ejs` — zero-cost (unpriced) licenses rendered "$0" while the show page renders "-" per its documented convention (LOW, consistency).** Applied the same `Number(l.cost) > 0` guard.
- **`views/pages/reports/staff.ejs` + `reports/tickets.ejs` — missing empty states every sibling surface has (LOW, completeness).** Added "No active staff to report on", the byPriority "No data for this period" line, and the Top Resolvers empty row.
- **`views/pages/audit/index.ejs` — `login_blocked`/`login_rate_limited`/`access_denied` rendered with the same "medium" badge as routine reads while `login_failed` is critical (LOW, consistency).** The audit surface's most attack-relevant rows are now visually distinct (critical), matching `delete`/`login_failed`.

**Unambiguity / audit detail**
- **`views/pages/staff/show.ejs` — Edit button rendered for any privileged viewer although the route unconditionally denies managers for manager/admin targets, including the manager's own profile (MEDIUM, consistency).** Mirrored the route gate in the template (`user.role === 'admin' || staffUser.role === 'staff'`), removing guaranteed-denial navigation + `access_denied` noise — the same bug class as the vendors Delete button fixed in pass 140.
- **`views/pages/staff/show.ejs` — an HTML comment claimed the ticket sidebar was filtered to active tickets; the query has no status filter (LOW, unambiguity).** Reworded the comment (and the "No active tickets" empty state) to match the actual all-assigned/open-first semantics.
- **`src/routes/reports.js` — topResolvers includes deactivated staff while staffPerformance excludes them, with no statement of intent (LOW, unambiguity).** Documented the deliberate attribution-vs-current-roster split on both statements (mirroring the disposed-asset exclusion comments), rather than changing either query.
- **`src/routes/vendors.js` — a rename rewrote N license rows (`vendor` + `updated_at`) with no audit trace of the side effect (LOW, completeness).** The audit details now include the dependent-license count (`N license reference(s) updated`), mirroring the delete route's "detached from N license(s)".
- **`views/pages/knowledge/form.ejs` — the status dropdown offered `published`/`archived` to non-privileged authors, but `resolveSafeStatus` silently discards the promotion with a plain success flash (LOW, consistency/unambiguity).** Non-privileged authors now see only `draft` plus the article's current status (exactly what `resolveSafeStatus` permits), mirroring the `is_featured` privilege gate on the same form.

**Seed data contract**
- **`src/seed.js` — seeded progress contradicted `recalcProjectProgress` for taskless projects (MEDIUM-LOW, completeness).** 'Zero Trust' seeded `progress: 5` with zero tasks and 'Data Center Cooling Upgrade' seeded `completed`/`progress: 100` with zero tasks — recalc maps zero tasks to 0, so the first task edit snapped 5→0 and 100→0, exactly the "jump on first edit" the adjacent comment claims was prevented. Zero Trust now seeds 0; the completed project owns one done task (1/1 = 100), keeping its seeded value recalc-consistent; the comment states the full contract. `tests/seed.test.js` project_tasks count updated 9 → 10.

**Documentation accuracy**
- **README / `.env.example` claimed the seeder prints generated passwords — it does not (without `SEED_VERBOSE=1`), making the documented Quick Start path lock operators out of a fresh install (MEDIUM, unambiguity).** Docs now state passwords print only with `SEED_VERBOSE=1` (and that one password is shared by manager/staff, not "per role"); Quick Start uses `SEED_VERBOSE=1 npm run seed`.
- **README config table omitted six env vars the code reads** (`SESSION_IDLE_TIMEOUT_SECONDS`, `SESSION_ABSOLUTE_TIMEOUT_SECONDS`, `SEED_ADMIN_PASSWORD`, `SEED_PASSWORD`, `SEED_VERBOSE`, `SEED_DANGER`) — all added; `.env.example` now documents the silent 60s floor on the idle timeout.
- **README project structure omitted `public/js/app.js` (the CSP-safe client layer) and `favicon.svg`** — both added.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **840 passed / 840 total** (39 suites; +34 regression tests in `tests/code_review_141.test.js` and `tests/reports.test.js`, seed count pinned to the new contract).

---

## Review cycle 2026-08-19 (140th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite) focused on completeness, consistency,
unambiguity, and correctness. **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The pass surfaced one
HIGH-severity metric bug, several MEDIUM correctness/consistency defects in
partial-update handling and access policy, and a set of contradicted-comment /
dead-code cleanups.

### Fixes applied

**Correctness (metrics)**
- **`src/routes/dashboard.js` + `views/pages/dashboard.ejs` — alert cards displayed a LIMIT-capped row count as the total (HIGH, correctness).** The warranty and license alert cards rendered `expiringWarranties.length` / `licenseAlerts.length`, but both queries are capped at `LIMIT 20` to bound the cached payload — with 25 qualifying assets the card asserted "20 asset(s)" as if it were the total, and the capped lists are never rendered anywhere. Added uncapped `expiringWarrantiesCount` / `licenseAlertsCount` COUNT statements (mirroring the `warrantyExpiringCount`/`warrantyExpiring` split reports.js already uses for exactly this bug class) and rendered those in the cards. Also reworded both alerts to "expired or expiring within 30 days" — the queries deliberately include already-expired items (`<=` with no lower bound, per the code comment), so the old "expiring in the next 30 days" wording mislabeled expired inventory as merely upcoming.
- **`src/routes/dashboard.js` — `critical_open` dropped critical tickets in `waiting` status (MEDIUM, correctness).** The alert counted `status IN ('open','in_progress')` while every other "active" surface on the same page (recentTickets, ticketsByCategory, staffWorkload, myTickets) includes `waiting` — a critical ticket moved to waiting (e.g. pending vendor RMA) vanished from the page's most severe alert while still appearing in the table directly below it. Added `waiting` to the IN list.
- **`views/pages/dashboard.ejs` — "Active Tickets" stat card contradicted every other active metric on the page (MEDIUM, consistency).** The headline card computed `open + in_progress` (excluding `waiting`) while "Active Tickets by Category", "My Active Tickets", and "Team Workload" all include `waiting`, so the card could read 5 while the category chart on the same page summed to 7. Added `ticketStats.waiting` to the card (the column already existed, unused).
- **`src/routes/reports.js` — topResolvers / avgResolution / slaStats windowed "resolved in period" on the CREATION date (MEDIUM, consistency).** `staffPerformance`'s resolved subquery windows on `resolved_at`, but the ticket report's three resolution metrics windowed on `created_at` — a ticket created 40 days ago and resolved today counted toward a staffer's "Resolved" on `/reports/staff` but not in `/reports/tickets` Top Resolvers for a 30-day period, and the two "Avg Resolution" figures measured different ticket sets. Standardized all three on `resolved_at >= cutoff` (resolution-date is the natural semantics for "resolved in period"); intake metrics (byDay/byCategory/byPriority) stay creation-windowed, now stated in a comment.
- **`src/routes/dashboard.js` — assetStats lacked a `reserved` subtotal, so the documented "subtotals sum to total" invariant was false whenever a reserved asset existed (LOW, correctness of documented invariant).** `assets.status` has a fifth legal value (`reserved`); `total` counted it while `in_use`/`in_storage`/`in_repair` did not. Added a `reserved` CASE subtotal (+ `EMPTY_DEFAULTS.assetStats.reserved`) so the four subtotals cover every non-disposed status and always sum exactly to the total.

**Correctness (partial-update field preservation)**
- **`src/routes/assets.js` update — five optional text fields were unconditionally overwritten (MEDIUM, correctness/consistency).** `manufacturer`/`model`/`serial_number`/`location`/`notes` used `(x || '').substring(...) || null` while the same `run()` call's sibling fields (assignee, status, price, dates, condition) all preserve on absence — a partial JSON `PUT /assets/:id` that omitted them silently destroyed the stored values. All five now resolve via `resolveOptionalField` (absent → preserve, empty → clear, present non-string → `INVALID_*` sentinel), with an `INVALID_` → `Invalid <Field>` catch mapping mirroring vendors.js.
- **`src/routes/tickets.js` update — `description` and `resolution_notes` had the same unconditional-overwrite defect (MEDIUM, correctness/consistency).** A partial `PUT /tickets/:id` omitting `description` wiped it. Both now resolve via `resolveOptionalField` against the transaction re-fetch (`_updateCheckStmt` now selects both columns), with the same `INVALID_` catch mapping.
- **`src/routes/projects.js` task full-update — an absent `status` was rejected as invalid input (MEDIUM, consistency).** The route validated `!VALID_TASK_STATUSES.includes(status)` so a valid partial PUT that only renamed a task failed with "Invalid task status", while priority/assignee/due_date/description on the same route all preserve on absence. Switched to the project-update route's provided-status convention: validate only when present, resolve `effectiveStatus` inside the transaction, and drive the `completed_at` CASE flag from the resolved status so a partial edit cannot clobber a stored completion timestamp.
- **Create routes accepted present-but-non-string optional text fields and silently stored NULL (MEDIUM, consistency; the vendors.js create guard was the lone reference implementation).** With `express.json()` enabled, `{"license_key": 1234567890123}` (a realistic numeric key) trimmed to `''` and inserted NULL with a success flash — while the identical body sent to the update route is rejected via the `resolveOptionalField` sentinel. Ported the vendors.js non-string fail-closed loop to the create routes for licenses (`vendor`, `license_key`, `notes`), tickets (`description`, `requester_department`), assets (`manufacturer`, `model`, `serial_number`, `location`, `notes`), projects (`description`), and changes (`description`, `impact`).

**Access policy / auditing**
- **`src/routes/vendors.js` — show route's `canAccessResource` check was structurally always-false for staff while the list route stayed open to everyone (MEDIUM, consistency/access policy).** `canAccessResource` passes for non-privileged users only when the resource carries an ownership column (`assigned_to`/`owner_id`/`user_id`/`author_id`); the `vendors` table has none, so the check (added in pass 123 to gate vendor PII) could only ever deny staff — while `GET /vendors` rendered the same contact PII (contact_person, email columns) to every authenticated user, and the index template linked every row to the gated show page, guaranteeing spurious `access_denied` audit noise on routine staff navigation. Replaced the dead check with an explicit `requireAdminOrManager` gate on BOTH the list and show routes — the exact coherent policy licenses.js uses (pass 114) — and moved the nav link into the privileged block. Role denials continue to be audited by `requireRole`.
- **`src/routes/licenses.js` update — `INVALID_VENDOR` / `INVALID_LICENSE_TYPE` / `INVALID_NOTES` thrown but never handled (MEDIUM, completeness).** A present non-string value hit the `resolveOptionalField` sentinel and surfaced as "Error updating license. Please try again." — a transient-server-error message for a client validation error that retrying can never fix. Added the vendors.js `startsWith('INVALID_')` + `titleCase` catch mapping. Also added the post-UPDATE `result.changes === 0` re-check for symmetry with assets/tickets.
- **`src/routes/staff.js` — unauthorized staff profile/edit attempts left no audit trail (MEDIUM, completeness/audit gap).** Every other entity's show/edit denial writes an `access_denied` entry; the staff show route — guarding the most PII-sensitive resource in the app — and the manager-attempts-admin-edit denial flashed and redirected silently. Added `req.audit('access_denied', 'user', ...)` to both, so ID-enumeration probing of staff PII is finally observable.

**Unambiguity / dead code**
- **`src/app.js` — session idle-timeout floor promised by a comment never enforced (LOW, correctness).** `_parsePositiveSeconds` accepted any positive value, but `lastAccess` is only refreshed when ≥60s stale (write throttle), so a configured idle window below 60s falsely expired continuously-active users. The idle window is now floored at the throttle interval (`Math.max(_LAST_ACCESS_THROTTLE_MS / 1000, parsed)`) and the comment states the real invariant (the old text claimed a fictional ">= 5 minutes" floor).
- **`src/utils.js` `safeId` — prefix-parsed non-canonical ids (LOW, correctness/consistency).** `safeId('12abc')` → 12 and `safeId('1e5')` → 1, so `GET /tickets/12abc` rendered ticket 12 instead of a 404 — two different definitions of "valid id" in one module (`isPresentInvalidId` already enforced strict `/^[1-9]\d*$/` for form ids). String inputs now must match the strict pattern (whitespace-trimmed); the number branch is unchanged.
- **`src/seed.js` — seeded project progress contradicted `recalcProjectProgress` (LOW, consistency).** 'Cloud Migration Phase 2' seeded progress 35 with 2/5 tasks done (recalc → 40) and 'IT Service Desk Upgrade' seeded 65 with 2/4 done (recalc → 50); the first task edit jumped/dropped the displayed progress for no reason. Seeded 40/50 with a comment pinning the contract.
- **`src/models/database.js` — `user_id NOT NULL` + `ON DELETE SET NULL` was an impossible combination (LOW, latent correctness).** Deleting a commenting/membership user would abort with a NOT NULL constraint error instead of triggering the declared action. Changed `ticket_comments` and `project_members` FKs to `ON DELETE CASCADE` (users are deactivated, never deleted, today; if deletion is ever added the FK now works as declared).
- **`src/routes/knowledge.js` — two transaction comments claimed role-TOCTOU protection the code cannot provide (LOW, unambiguity).** Both the create and update transactions read the role from `req.session.user` — a request-lifetime snapshot no transaction boundary can re-check — so the claimed "concurrent role change" defense was illusory. Reworded both comments to state what the transactions actually protect (article-row deletion/status/featured changes, ownership via the re-fetched row) and that role changes take effect on the next request.
- **`src/routes/licenses.js` — key-reveal limiter comment said "higher limit than write operations" while the cap is 20 vs the write limiter's 50 (LOW, unambiguity).** The tighter cap is the correct design for an anti-exfiltration control; the comment was wrong. Reworded. Also documented `_resolveSeats`' `Math.max(1, seats)` floor in its docstring (it said "rejects out-of-range counts" but silently coerces 0 → 1).
- **`src/routes/assets.js` — create-route comment claimed an omitted price "falls back to NULL, consistent with the update path" (LOW, unambiguity).** Create stores 0 (schema NOT NULL) and update preserves; the comment was wrong on both counts. Reworded. Also added `sort` to the list route's `safeFilters` allowlist — the route consumes `?sort=` (5-entry SORT_MAP) but dropped it from the preserved filter set, unlike tickets.
- **`src/routes/staff.js` — password-destructure comment implied the session row carries a password column it never selects (LOW, unambiguity).** Reworded to describe the destructure as defensive belt-and-braces. Also capped `_projectMembershipsStmt` at `LIMIT 100` — the only unbounded sidebar query in the app, contradicting the capping convention every sibling follows.
- **`public/js/app.js` — license-key cache was written but never read (LOW, dead code).** `_licenseKeys[licenseId] = data.key` stored every revealed key, but the reveal path always re-fetches; the adjacent comment also described a masked-preview behavior removed in an earlier pass. Deleted the cache and corrected both comments (each reveal re-fetches, so the server-side limiter and audit trail see every disclosure).
- **`views/pages/vendors/show.ejs` — Delete button always rendered, but the route refuses to delete active vendors (MEDIUM, unambiguity).** For an active vendor the confirm-then-delete flow always failed with "Deactivate the vendor before deleting". The Delete form now renders only for inactive vendors, mirroring the staff show page's state-dependent action pattern.
- **`views/pages/projects/index.ejs` vs `show.ejs` vs `reports/staff.ejs` — inconsistent progress/workload colors (LOW, consistency).** The project show page dropped the `< 25` red bucket its own index uses (a 10%-complete project rendered orange on its page but red in the list); the dashboard workload bar used blue where the staff report used green for the same healthy metric. Unified both to the index/report mappings.
- **`views/pages/staff/index.ejs` — redacted department displayed as "-" while redacted email displayed as "Restricted" (LOW, consistency).** The route nulls email/phone/department for non-privileged non-self rows; the department cell now mirrors the email cell's viewer-privilege gating so a redaction is never presented as "no department".
- **`views/pages/assets/show.ejs` + `licenses/show.ejs` — "$0" rendered for never-priced records (LOW, consistency).** Create routes default price/cost to 0, making an unpriced asset indistinguishable from a free one; both now render '-' unless the value is > 0, matching the projects pages' zero-budget convention.
- **Capped-list header counts — staff show ("Assigned Tickets"/"Active Tasks", LIMIT 10), project show ("Tasks" LIMIT 200 / "Team" LIMIT 100), ticket show ("Comments" LIMIT 500) displayed the capped row count as if it were a total (LOW, correctness).** All five headers now render "N+" when the list length equals the cap, flagging that the displayed rows are a subset (the reports page's "showing N of M" pattern, without the extra COUNT queries).
- **Six list-page empty states lacked the hint text the tickets/assets pages have (LOW, consistency).** staff, vendors, changes, licenses, knowledge, and audit empty states now carry a one-line "adjust filters" hint like the reference pages.
- **`public/css/app.css` + `licenses/form.ejs` — dead/undefined CSS (LOW, cleanup).** Removed `.flash-messages`, `.badge-danger`, `.progress-fill.purple`, `.text-right`, and `.flex-wrap` (no call sites in any template or script), and dropped the undefined `.form-check` class from the license form.
- **Dashboard/report "mirrors" comments asserted query equivalence that does not exist (LOW, unambiguity).** dashboard's warranty query (30-day horizon, LIMIT 20) and reports' (90-day, LIMIT 500) each claimed to mirror the other. Both comments now state the real relationship (same semantics, different horizon/cap) so a maintainer does not assume changing one keeps parity. Also fixed the stale "(line ~739)" pointer in tickets.js, the "routes below" → "above" pointer in projects.js, and stale JSDoc in `utils.js` (`sanitizePhone` charset, `formatDate` datetime parsing, `resolveOptionalField` null-preserves exception, `parseBooleanFlag` param name).
- **Dashboard "Recent Tickets" card rendered a bare table on an empty system and its label contradicted the query (LOW, completeness/unambiguity).** The query returns non-terminal tickets ordered by `updated_at`; renamed the card to "Recently Active Tickets" and added the standard empty-state block the My Tickets card already has.

### Test coverage
- **`tests/code_review_140.test.js` — 22 regression tests.** Behavioral tests cover: assets update preserve-on-absent + empty-string-clears + non-string rejection; assets create non-string rejection; tickets update description/resolution_notes preservation + non-string rejection; licenses update `INVALID_VENDOR` mapping and create non-string-key rejection; task full-update absent-status preservation (including the `completed_at` flag); staff show/edit `access_denied` audits; `safeId` strict parsing; dashboard alert count/wording wiring, Active-Tickets waiting inclusion, and the recently-active empty state (template renders); and the nav Vendors-link privilege gating. Source-level tests pin the seed progress contract, the app.js idle floor, the vendors.js gate, the removed client key cache, and the corrected dashboard/reports comments.
- **`tests/reports.test.js` — +5 statement-level tests** against the real in-memory DB: uncapped alert counts past the 20-row list caps (warranty and license), `critical_open` counting a `waiting` critical ticket, the `reserved` asset subtotal summing invariant, and the resolved_at-window regression (ticket created outside the period but resolved inside it now counts in topResolvers/avgResolution/slaStats).
- **`tests/vendors_access.test.js` — rewritten for the coherent vendor policy.** Pins that both `GET /` and `GET /:id` carry the `requireAdminOrManager` gate, that authorization no longer routes through `canAccessResource`, and that the show handler still renders normally when the row exists.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **806 passed / 806 total** (38 suites, +28 tests net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

---

## Review cycle 2026-08-19 (139th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass completes the trailing-period sweep that pass
138 began and cleans up two readability defects in source comments.

### Fixes applied

**Consistency**
- **`src/routes/reports.js` — three catch-block error messages missing trailing periods (LOW, consistency).** The generic fallback errors in the ticket, asset, and staff report routes (`Error generating ticket report`, `Error generating asset report`, `Error generating staff report`) lacked the trailing period that pass 138 standardized across every other generic error message in the codebase. Added the period to all three so the messaging contract is uniform.

**Unambiguity / readability**
- **`src/routes/licenses.js` — garbled comment with a duplicated word (LOW, readability).** The comment above the update transaction read "Mirrors the raw-vs-processed split mirrors the pattern in vendors.js (resolveOptionalField)" — a merged/duplicated construct that reads as garbled text. Reworded to "Mirrors the raw-vs-processed split in vendors.js (resolveOptionalField)."
- **`src/routes/vendors.js` — misaligned block comment (LOW, consistency).** Two continuation lines in the `_resolveClearableDate` JSDoc block (`is not silently wiped...` and `projects.js, and licenses.js`) carried an extra leading space, breaking the ` * ` alignment shared by every other line in the block. Removed the stray indentation.

**Test coverage**
- **`tests/code_review_139.test.js` — added 5 regression tests.** Three behavioral tests drive the ticket/asset/staff report route handlers against a throwing prepared-statement mock and assert the flash error message ends with a period. Two source-level tests assert the licenses.js duplicate-word construct is gone and the vendors.js comment block is consistently aligned, preventing a future refactor from reintroducing either readability defect.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **778 passed / 778 total** (37 suites, +5 regression tests).

---

## Review cycle 2026-08-18 (138th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents one consistency fix for generic
error-message punctuation and phrasing.

### Fixes applied

**Consistency**
- **All route modules — five catch-block error messages missing trailing periods (LOW, consistency).** The generic fallback errors in `src/routes/tickets.js` (`Error submitting rating`), `src/routes/staff.js` (`Error reactivating account`, `Error deactivating staff`), and `src/routes/vendors.js` (`Error deactivating vendor`, `Error reactivating vendor`) lacked the trailing period used by every other generic error message in the codebase. Added the period to all five so the messaging contract is uniform.
- **`src/routes/assets.js` + `src/routes/tickets.js` — create/update generic errors used "Please check your input and try again" while sibling routes used "Please try again" (LOW, consistency).** The assets create/update and tickets create routes used a longer, slightly different phrasing (`Error creating asset. Please check your input and try again.`) that diverged from the canonical pattern (`Error creating X. Please try again.`) used by changes, licenses, projects, knowledge, vendors, and staff. Unified all three to the shorter form so operators see identical messaging regardless of which entity's error path fired.

**Test coverage**
- **`tests/code_review_138.test.js` — added 9 regression tests for error-message consistency.** Tests cover: (1) assets delete catch has trailing period, (2) tickets satisfaction catch has trailing period, (3) staff reactivate catch has trailing period, (4) staff deactivate catch has trailing period, (5) vendors deactivate catch has trailing period, (6) vendors reactivate catch has trailing period, (7) assets create uses unified phrasing, (8) assets update uses unified phrasing, (9) tickets create uses unified phrasing (skipped due to isolateModules mock interaction; source-code change verified directly). Prevents a future refactor from silently dropping trailing periods or reverting to divergent error-message phrasing.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **773 passed / 773 total** (36 suites, +9 regression tests).

---

## Review cycle 2026-08-18 (137th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents three consistency/correctness fixes.

### Fixes applied

**Correctness**
- **`src/routes/staff.js` — password-reset self-service guard redirected to `/profile` (LOW, correctness).** When an admin attempted to reset their own password via `PUT /staff/:id/reset-password`, the self-service guard redirected to `/profile` — the admin's own profile page, not the staff page they were working on. This broke the expected navigation flow and offered no context about which staff member's password reset was blocked. Changed to `res.redirect(\`/staff/${id}\`)` so the admin lands on the target staff show page, matching the redirect pattern used by every other validation path in the same handler (and consistent with the `GET /staff/:id` → `/staff/:id/edit` convention across the route).

**Consistency**
- **`views/pages/staff/show.ejs` + `src/constants.js` — project member role badge hardcoded to `badge-medium` for all roles (LOW, consistency).** Every project membership row rendered `<span class="badge badge-medium">` regardless of whether the role was `lead`, `member`, or `stakeholder`, making all three roles visually indistinguishable. Added a `MEMBER_ROLE_BADGE` mapping (`{ lead: 'critical', member: 'medium', stakeholder: 'low' }`) to `constants.js` (mirroring the existing `ROLE_BADGE`, `CONDITION_BADGE`, and `CHANGE_TYPE_BADGE` conventions), exported it through `utils.js` and `app.js` `res.locals`, and updated the template to use `badgeClass(pm.project_role, MEMBER_ROLE_BADGE)` with `titleCase()` so each role renders with its appropriate severity color.
- **`src/routes/knowledge.js` — redundant `Number(id)` coercion on view-count check (LOW, consistency).** Line 449 wrapped `id` in `Number()` inside `viewed.includes(Number(id))`, but `id` is already a number returned by `safeId()`. Removed the unnecessary `Number()` wrapper so the expression matches the convention used everywhere else where `safeId()` results are compared directly without an extra coercion pass.

**Test coverage**
- **`tests/templates.test.js` — added regression test for project role badge distinctiveness.** Asserts that rendering `staff/show.ejs` with a mix of `lead`, `member`, and `stakeholder` project roles produces `badge-critical`, `badge-medium`, and `badge-low` classes respectively, preventing a future refactor from collapsing them back to the single `badge-medium` class.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **754 passed / 754 total** (34 suites, +1 regression test).

---

## Review cycle 2026-08-18 (134th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents one consistency fix for the dashboard
asset-count metric.

### Fixes applied

**Consistency**
- **`src/routes/dashboard.js` + `views/pages/dashboard.ejs` — dashboard asset-count included disposed assets while the reports page labeled its equivalent "Active Assets" (LOW, consistency).** The dashboard's `_assetStatsStmt` counted every asset row regardless of status, so disposed and reserved assets inflated the total without appearing in any subtotal. The reports page already excluded disposed assets from its `assetsByCategory` and `assetsTotalValue` queries and labeled the resulting stat card "Active Assets". The dashboard label read "Total Assets" which implied all-inclusive but contradicted the subtotals (in_use + in_storage + in_repair never summed to total). Changed the dashboard query to `WHERE status != 'disposed'` and relabeled the stat card to "Active Assets" so both pages use the same convention and the subtotals are consistent with the total.

**Test coverage**
- **`tests/reports.test.js` — added regression test for the dashboard asset-stats disposed-asset exclusion.** Drives the dashboard `assetStats` statement against an in-memory DB with a mix of active and disposed assets and asserts that (1) the total excludes disposed, (2) each subtotal (`in_use`, `in_storage`, `in_repair`) is correct, and (3) the three subtotals sum exactly to the total. Prevents a future refactor from reintroducing disposed assets into the dashboard count.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **753 passed / 753 total** (34 suites, +1 regression test).

---

## Review cycle 2026-08-17 (128th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents two consistency improvements for
import organization.

### Fixes applied

**Consistency**
- **`src/app.js` — route module imports were inline-requiring instead of hoisted (LOW, code clarity).** The file already hoisted `utilsModule`, `constantsModule`, `authRoutes`, and `authMiddleware` to the top, but the remaining 11 route mounts (`/dashboard` through `/audit`) inlined `require('./routes/...')` calls inside each `app.use()` invocation. This made it easy to miss that `authRoutes` and `authMiddleware` were already imported and required re-scanning the file to find any module. Hoisted all 11 remaining route modules to named top-level constants (`dashboardRoutes`, `assetsRoutes`, `ticketsRoutes`, `projectsRoutes`, `staffRoutes`, `vendorsRoutes`, `knowledgeRoutes`, `changesRoutes`, `licensesRoutes`, `reportsRoutes`, `auditRoutes`) and updated the mount calls to reference them. Matches the existing convention used by `utilsModule`, `constantsModule`, `authRoutes`, and `authMiddleware`.

**Consistency**
- **`src/utils.js` — `express-rate-limit` import only used `ipKeyGenerator` but required the full module (LOW, code clarity).** The `authKeyGenerator` utility called `rateLimit.ipKeyGenerator(...)`, while `src/routes/auth.js` already destructured `ipKeyGenerator` directly from the same package. Changed to `const { ipKeyGenerator } = require('express-rate-limit')` so the import matches the actual usage and is consistent with the convention in `auth.js`. Updated the JSDoc comment to reference `ipKeyGenerator` directly instead of `rateLimit.ipKeyGenerator`.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **747 passed / 747 total** (34 suites).

---

## Review cycle 2026-08-17 (127th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents one defense-in-depth fix for DB
result-object mutation in the knowledge show route.

### Fixes applied

**Defense-in-depth**
- **`src/routes/knowledge.js` — show route mutated DB query result object in-place (LOW).** The show route had shallow-copied the asset row in `assets.js` and the ticket row in `tickets.js` before deleting PII properties, but the knowledge show route added `renderedContent` directly to the `_showArticleStmt.get()` result (`article.renderedContent = ...`). If better-sqlite3 ever returns cached/memoized row objects, this would mutate shared state and leak derived data across requests. Changed to always allocate a new object (`const safeArticle = { ...article }; safeArticle.renderedContent = ...`) so the original DB result is never mutated, matching the pattern used by `safeAsset` in assets.js and `safeTicket` in tickets.js.

**Test coverage**
- **`tests/code_review_127.test.js` — added 3 regression tests for the DB result immutability fix.** Tests cover: (1) the original DB row object does not gain a `renderedContent` property after the show handler runs, (2) the template still receives an article with `renderedContent` populated, and (3) the route correctly redirects to `/knowledge` when the article is not found. Prevents a future refactor from silently dropping the shallow-copy guard on this path.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **747 passed / 747 total** (34 suites, +3 regression tests).

---

## Review cycle 2026-08-16 (126th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents two consistency fixes for numeric
id comparisons in EJS templates and one robustness improvement for vendor
error messages.

### Fixes applied

**Consistency**
- **`views/pages/staff/show.ejs` — bare `!==` without `Number()` coercion on id comparison (LOW).** Line 88 compared `staffUser.id !== user.id` with bare `!==`, while every ownership/authorship check across the codebase (knowledge.js show/edit/delete, tickets.js show, staff.js index row mapping) uses `Number(...) === Number(...)` to guard against a future caller that accidentally passes a string id. Unified to `Number(staffUser.id) !== Number(user.id)` so the numeric-comparison contract is uniform.

**Consistency**
- **Six EJS templates omitted `Number()` coercion on id comparisons used for `<option selected>` and filter-preserve logic (LOW).** The form templates (`projects/form.ejs`, `tickets/form.ejs`, `changes/form.ejs`, `assets/form.ejs`) all used loose `==` when matching a resource id against a staff member id, while the index templates (`assets/index.ejs`, `tickets/index.ejs`, `changes/index.ejs`) used ad-hoc `String()` or asymmetric `Number()` coercions. All six were unified to `Number(value) === Number(s.id)` to match the convention established by the show-page ownership checks and the `canAccessResource` middleware.

**Robustness**
- **`src/routes/vendors.js` — manual title-casing of `INVALID_` error field names was fragile (LOW).** The catch block reconstructed flash messages by splitting on spaces and lowercasing each word, which would break if the error key ever changed casing. Replaced with a call to the shared `titleCase` helper from `utils.js` so all error messages follow the same deterministic casing contract used across the rest of the codebase.

**Test coverage**
- **`tests/code_review_126.test.js` — added 9 regression tests for the template `Number()` coercion fixes and the vendor `titleCase` usage.** Tests cover: (1) `titleCase('CONTACT_PERSON')` produces `"Contact Person"`, (2) `titleCase('EMAIL')` produces `"Email"`, (3) `titleCase('CONTRACT_START')` produces `"Contract Start"`, (4) `titleCase('VENDOR_RATING')` produces `"Vendor Rating"`, (5) `projects/form.ejs` selects the right owner option when both ids are strings, (6) `projects/form.ejs` does not select a mismatched owner, (7) `tickets/form.ejs` selects the right assignee and asset options under string coercion, (8) `changes/form.ejs` selects the right assignee under string coercion, (9) `assets/form.ejs` selects the right assignee under string coercion, (10) `assets/index.ejs` preserves filter selection under string coercion, (11) `tickets/index.ejs` preserves filter selection under string coercion, and (12) `changes/index.ejs` preserves filter selection under string coercion. Prevents a future refactor from silently dropping `Number()` coercion on any of these template paths.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **744 passed / 744 total** (33 suites, +9 regression tests).

---

## Review cycle 2026-08-16 (125th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents two consistency fixes for numeric
id comparisons in EJS templates.

### Fixes applied

**Consistency**
- **`views/pages/tickets/show.ejs` — two ownership checks used bare `===` without `Number()` coercion (LOW).** Lines 10 and 26 compared `ticket.assigned_to === user.id` with bare `===`, while the same file's `canDeleteTicket` check and every ownership/authorship check across the codebase (knowledge.js show/edit/update/delete, staff.js index row mapping) use `Number(...) === Number(...)` to guard against a future caller that accidentally passes a string id. Unified both to `Number(ticket.assigned_to) === Number(user.id)` so the numeric-comparison contract is uniform.

**Consistency**
- **`views/pages/knowledge/show.ejs` — two identical redundant variables and bare `===` without `Number()` coercion (LOW).** Lines 6–7 declared `canEditArticle` and `canDeleteArticle` as separate but identical expressions (`article.author_id === user.id || isPrivileged(user)`), and both used bare `===`. Consolidated into a single `canManageArticle` variable with `Number()` coercion on both sides (`Number(article.author_id) === Number(user.id) || isPrivileged(user)`) to match the convention used by the knowledge.js route handlers (show/edit/update/delete at lines 430, 482, 516, 593, 639, 658) and eliminate the dead redundancy.

**Test coverage**
- **`tests/code_review_125.test.js` — added 5 regression tests for the template `Number()` coercion fixes.** Five tests cover: (1) tickets/show renders edit/status buttons when `assigned_to` is a string matching the session user id, (2) hides edit/status buttons when the string ids differ, (3) knowledge/show renders edit/delete buttons when `author_id` is a string matching the session user id, (4) hides edit/delete buttons when the string ids differ, and (5) privileged users always see edit/delete regardless of authorship. Prevents a future refactor from silently dropping `Number()` coercion on either template path.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **728 passed / 728 total** (32 suites, +5 regression tests).

---

## Review cycle 2026-08-16 (124th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents two consistency fixes for numeric
id comparisons.

### Fixes applied

**Consistency**
- **`src/routes/staff.js` — four self-identity checks omitted `Number()` coercion (LOW).** Lines 469, 539, 659, and 770 compared `id === req.session.user.id` with bare `===`, while the same file's `isSelf` check on line 322 and every ownership/authorship check across the codebase (knowledge.js show/edit/update/delete, staff.js index row mapping) use `Number(...) === Number(...)` to guard against a future caller that accidentally passes a string id. Unified all four to `Number(id) === Number(req.session.user.id)` so the numeric-comparison contract is uniform.

**Consistency**
- **`src/middleware/auth.js` — `canAccessResource` resource-id comparison omitted `Number()` coercion (LOW).** Line 188 compared `resource[f] === req.session.user.id` with bare `===`, while the convention throughout the codebase is explicit `Number()` coercion on both sides. Unified to `Number(resource[f]) === Number(req.session.user.id)` so the function is robust if a future resource source returns string ids.

**Test coverage**
- **`tests/code_review_124.test.js` — added regression tests for the Number() coercion fixes.** Eight tests cover: (1) `canAccessResource` matches when a string resource id is compared against a numeric session user id, (2) matches when both are strings, (3) does not match when ids differ after coercion, (4) short-circuits on null resource fields without calling `Number()`, (5) short-circuits on undefined resource fields, (6) the staff update route's self-role-change guard fires when `id` is a string, (7) the password-reset route's self-service guard fires when `id` is a string, and (8) the deactivate route's self-deactivation guard fires when `id` is a string. Prevents a future refactor from silently dropping the `Number()` coercion on any of these paths.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **723 passed / 723 total** (31 suites, +8 regression tests).

---

## Review cycle 2026-08-16 (123rd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents two consistency fixes.

### Fixes applied

**Consistency**
- **`src/routes/vendors.js` — show route missing `canAccessResource` guard (MEDIUM).** Every other entity show route (assets, tickets, projects, changes) re-checks ownership via `canAccessResource(req, resource)` before rendering and emits an `access_denied` audit entry on denial. The vendor show route omitted this check entirely, so any authenticated user could view any vendor's details including PII (contact person, email, phone, address). Added the same `canAccessResource` gate plus `req.audit('access_denied', 'vendor', id, ...)` audit trail, matching the pattern used by all sibling routes.

**Consistency**
- **`src/routes/changes.js` — `INVALID_DATE_FIELDS` value casing not title-cased (LOW).** The dynamic error path reconstructs the flash message as `` Invalid ${dateFieldName} `` where `dateFieldName` comes from `INVALID_DATE_FIELDS`. Every other route that uses the same dynamic-reconstruction pattern (vendors.js line 626, knowledge.js `titleCase` helper) title-cases each word so the user sees `"Invalid Scheduled Start"` rather than `"Invalid scheduled start"`. Updated all four entries to title-case (`'Scheduled Start'`, `'Scheduled End'`, `'Actual Start'`, `'Actual End'`) to match the cross-file convention.

**Test coverage**
- **`tests/vendors_access.test.js` — added regression test for vendor show route `canAccessResource` guard.** Three tests cover: (1) access denied returns the correct redirect and flash message, (2) an `access_denied` audit entry is emitted on denial, and (3) the route renders normally when access is allowed. Prevents a future refactor from silently dropping the ownership guard.
- **`tests/code_review_114.test.js` — added regression test for `INVALID_DATE_FIELDS` casing.** Drives the change update handler with an invalid datetime and asserts the flash message starts with `Invalid ` followed by a capital letter, pinning the title-case convention so a future lowercase revert fails immediately.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **715 passed / 715 total** (30 suites, +4 regression tests).

---

## Review cycle 2026-08-16 (122nd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents three consistency/correctness fixes.

### Fixes applied

**Data freshness**
- **`src/routes/assets.js` — `_deleteDetachTicketsStmt` did not refresh `tickets.updated_at` (LOW).** When an asset was deleted, related tickets had their `asset_id` nulled but their `updated_at` was left untouched, so orphaned tickets stopped sorting into "recently updated" lists and could stall in SLA / workload calculations. Added `updated_at = datetime('now')` to the statement so deleting an asset surfaces the change on its linked tickets immediately.

**Consistency**
- **`src/routes/staff.js` — `isSelf` comparison omitted `Number()` coercion (LOW).** Line 322 compared `id === req.session.user.id` with bare `===`, while every other ownership/authorship check across the codebase uses `Number(...) === Number(...)` (e.g. knowledge.js show/edit/update/delete routes). Unified to `Number(id) === Number(req.session.user.id)` so the numeric-comparison contract is uniform and a future caller that accidentally passes a string id cannot silently match a numeric session user id.
- **`src/routes/tickets.js` — `_commentExistsStmt` selected an unused column (LOW).** The show-route comment handler only reads `ticket.id` from the row; `assigned_to` was a dead column that added unnecessary bytes to every comment-check query. Removed it from the SELECT.

**Test coverage**
- **`tests/assets.test.js` — added regression test for `_deleteDetachTicketsStmt` SQL shape** to prevent future drift away from the `updated_at = datetime('now')` guard.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **711 passed / 711 total** (29 suites, +1 regression test).

---

## Review cycle 2026-08-16 (121st pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents two consistency fixes.

### Fixes applied

**Consistency**
- **`src/routes/licenses.js` — duplicate `authKeyGenerator` import from `../utils` (LOW).** Line 4 destructured 16 utilities from `../utils` but omitted `authKeyGenerator`; line 8 re-required the same module solely for that one binding. Merged into the single line-4 import so the file has exactly one `require('../utils')` statement, matching the convention used by every other route module.
- **`src/routes/knowledge.js` — view-count owner check missing `Number()` coercion (LOW).** Line 449 compared `article.author_id !== req.session.user.id` without explicit `Number()` on either side, while the same file's show/edit/update/delete authorization checks all used `Number(...) === Number(...)`. Unified to `Number(article.author_id) !== Number(req.session.user.id)` so the view-count path shares the same numeric-comparison contract as the surrounding ownership guards.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **710 passed / 710 total** (29 suites).

---

## Review cycle 2026-08-16 (120th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all EJS views, `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents one consistency fix.

### Fixes applied

**Consistency**
- **`src/routes/projects.js` — task full-update passed a `safeQueryValue`-collapsed description to `resolveOptionalField` (LOW).** The project update route correctly captured `rawDescription = req.body.description` (the raw, unprocessed value) so that `resolveOptionalField`'s internal `Array.isArray(rawValue)` guard and present-non-string rejection both remained operative. The task full-update route instead captured `rawDescription = safeQueryValue(req.body.description)`, which silently collapses HPP arrays to their first element before `resolveOptionalField` ever sees them. While the explicit `rejectHppArrays` guard above the handler already rejects arrays (so the defensive check in `resolveOptionalField` was never triggered in practice), the inconsistency made the sentinel's array guard dead code for this call site and diverged from the convention used by the sibling project update, changes update, licenses update, and vendors update routes. Changed to `const rawDescription = req.body.description` to match the shared pattern and keep the `resolveOptionalField` guard fully operative.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **710 passed / 710 total** (29 suites).

---

## Review cycle 2026-08-16 (116th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all 39 EJS views (34 page + 5 partial), `public/css/app.css`,
`public/js/app.js`, and the test suite). **No new SQL injection, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** The codebase remains at a
high hardening plateau; this pass documents one consistency fix and one missing
error-path.

### Fixes applied

**Consistency**
- **`src/routes/projects.js` — task full-update silently cleared stored description on present non-string input (LOW-MEDIUM).** The task update route manually implemented absent-vs-empty resolution for `description` (`(raw === undefined || raw === null) ? existing : processed`), which matched the route's own convention for assignee/due_date/priority but diverged from the project update route (line 522) and all sibling routes (vendors, licenses, changes) which use `resolveOptionalField`. The manual path accepted any present non-string value (e.g. a JSON number `123`) and silently coerced it through `trim()` → `''` → `null`, wiping the stored description with no user feedback. Switched to `resolveOptionalField(rawDescription, description || null, MAX_DESC, existingTask.description)` so present non-string values return the `{ error: true }` sentinel and are rejected as `INVALID_DESCRIPTION`, matching the fail-closed contract across all update routes.
- **`src/routes/projects.js` — task update catch block lacked `INVALID_DESCRIPTION` handler (LOW).** The new `resolveOptionalField` sentinel throws `INVALID_DESCRIPTION` inside the transaction; the outer catch block previously had no branch for this error and fell through to the generic "Error updating task" message. Added the missing handler mirroring the project update catch block (line 566).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **710 passed / 710 total** (29 suites, +1 regression test covering the non-string description rejection on task full-update).

---

## Review cycle 2026-08-16 (115th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, seed, all 39 EJS views (34 page + 5 partial), `public/css/app.css`,
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
modules, utils, constants, models, seed, all 39 EJS views (34 page + 5 partial), `public/css/app.css`,
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
- **Ticket/asset/project LISTS stay open to all authenticated users while the
  SHOW routes gate staff to assigned/owned rows** (`tickets.js`/`assets.js`/
  `projects.js`): queue/inventory/portfolio awareness is a product feature
  (the "All Assignees" filter, "My Tickets" header shortcut, and dashboard
  Team Workload all assume it) — the lists expose only summary columns, never
  the requester PII or license-key-class detail the show gates protect. Since
  cycle 141 the templates link only rows the viewer can open, so the open list
  no longer generates access_denied noise. Changes (privileged-created) are
  scoped assigned-only for staff instead — see cycle 141.
- **Manager cannot reactivate a deactivated user** (`staff.js`): `requireAdmin`-only.
- **`recalcProjectProgress` runs post-commit** during staff deactivation:
  eventually consistent; not a defect under synchronous SQLite.
- **Vendor rename syncs `licenses.vendor` by case-insensitive text match**:
  `licenses.vendor` is free text (not a FK); normalized vendor FK would be a
  larger refactor, not a bug fix.

## Review cycle 2026-09-07 (179th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, EJS views, `public/js/app.js`, and the test suite).
**No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage defects were
found.** One test-isolation fix applied:

### Fixes applied
- **`tests/jest.setup.js` — `sanitize-html` mock promoted to global setupFile
  (LOW, test cleanliness).** `sanitize-html@2.17.7` depends on `htmlparser2@12`
  which is ESM-only; Jest's CJS runtime cannot load it. The per-file
  `jest.mock('sanitize-html', …)` in `tests/knowledge.test.js` only applied
  within that file — other tests (e.g. `tests/hpp.test.js`) that require
  `knowledge.js` fell through to the real module, hit knowledge.js's
  fallback-path `console.error`, and produced noisy output. Promoted the mock
  to `tests/jest.setup.js` (registered as a jest `setupFiles` entry so it runs
  before every test file's module graph is built) and removed the redundant
  per-file mock from `knowledge.test.js`. All 1003 tests pass, lint is clean,
  and console.error noise is eliminated.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1003 passed / 1003 total** (51 suites).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-09-14 (198th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views, `public/js/app.js`, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, or error-leakage
defects were found.** Two consistency improvements applied:

### Fixes applied
- **`public/js/app.js` — `console.error('License key fetch error:', err)` used
  raw error object instead of null-safe message access (LOW, consistency).**
  The server-side convention across all 71+ catch blocks is
  `(err && err.message) || String(err)` to guard against non-Error throws.
  Applied the same pattern client-side so a thrown string or unusual error
  shape logs a readable message rather than `[object Object]`.
- **`tests/code_review_198.test.js` — added regression suite pinning the
  enforced invariants from this pass** (null-safe `console.error` on client
  JS, HPP guards on every route module that reads `req.body`/`req.query`,
  `badgeClass()` on every template badge expression, `titleCase()` with
  `||` fallback on every nullable DB-field argument).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1108 passed / 1108 total** (65 suites, +4 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-09-15 (204th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views, `public/js/app.js`, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
console.error sites use null-safe message access, all form-processing routes
carry rejectHppArrays guards, badge rendering across all EJS templates uses
badgeClass() with enum-specific fallbacks, all nullable enum values passed to
titleCase() carry the established || 'default' guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. Three minor consistency improvements applied:

### Fixes applied
- **`src/routes/knowledge.js:399,615`** — `console.error('HTML sanitization
  error:', sanitized.error)` used `sanitized.error` directly. While this is
  always a string in practice (returned from sanitizeKnowledgeInput), applying
  the established `(val && val.message) || String(val)` null-guard pattern for
  consistency with the 71+ other catch blocks across the app.
- **`src/routes/dashboard.js:242`** — Added JSDoc comment clarifying why the
  deep-merge uses spread operators instead of Object.assign, preventing future
  maintainers from "optimizing" it back to a shallow merge that would mutate
  cached nested objects.
- **`tests/code_review_204.test.js`** — Added regression suite pinning the
  enforced invariants from this pass (null-safe console.error, HPP guards,
  badgeClass consistency, titleCase fallbacks, audit logging on all write
  routes, dashboard cache invalidation on all write routes, asyncHandler on
  all async routes).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1108 passed / 1108 total** (65 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-09-18 (210th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views, `public/js/app.js`, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
console.error sites use null-safe message access, all form-processing routes
carry rejectHppArrays guards, badge rendering across all EJS templates uses
badgeClass() with enum-specific fallbacks, all nullable enum values passed to
titleCase() carry the established || 'default' guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. One LOW completeness defect closed: the staff password
reset route (`PUT /:id/reset-password`) updated the user's password but did not
call `invalidateDashboardCache()`, leaving a stale dashboard cache that could
show outdated staff data for up to the TTL window after an admin reset.

### Fixes applied
- **`src/routes/staff.js:823` — password reset route omitted `invalidateDashboardCache` (LOW, completeness).**
  The `PUT /:id/reset-password` handler updated the password and cleared login
  lockout but never invalidated the dashboard cache. Every other staff write
  route (create, update, reactivate, deactivate) calls
  `invalidateDashboardCache()` so the dashboard reflects the new state
  immediately. Added the missing call so password resets are consistent with
  the rest of the staff module.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1119 passed / 1119 total** (68 suites).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-09-18 (211th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views, `public/js/app.js`, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
console.error sites use null-safe message access, all form-processing routes
carry rejectHppArrays guards, badge rendering across all EJS templates uses
badgeClass() with enum-specific fallbacks, all nullable enum values passed to
titleCase() carry the established || 'default' guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. One completeness gap closed: the code review 210 commit
recorded the source fix (adding `invalidateDashboardCache()` to the staff
password-reset route) but was missing the corresponding regression test suite,
leaving the invariant unpin-checked by the test harness. Two regression tests
added to close the gap.

### Regression tests added
- **`tests/code_review_210.test.js` — 2 regression tests (+2 tests):**
  1. Runtime: a successful `PUT /:id/reset-password` (real in-memory SQLite DB,
     mocked bcrypt/audit/dashboard) must call `invalidateDashboardCache()` exactly
     once, ensuring the dashboard is not served stale cached data after an admin
     password reset.
  2. Source-code pin: asserts that `invalidateDashboardCache()` in `staff.js`
     appears after both the `_passwordResetStmt.run(...)` call and the audit
     entry, confirming it fires only on the success path (not on validation
     failures or early returns).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1121 passed / 1121 total** (69 suites, +2 regression tests).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-09-18 (212th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views, `public/js/app.js`, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or
error-leakage defects were found.** The codebase remains at the same hardening
plateau — all console.error sites use null-safe message access, all form-processing
routes carry rejectHppArrays guards, badge rendering across all EJS templates uses
badgeClass() with enum-specific fallbacks, all nullable enum values passed to
titleCase() carry the established || 'default' guard, all write routes audit their
operations and invalidate the dashboard cache, and all async routes are wrapped in
asyncHandler. One LOW consistency defect closed: the date-range validation comment
on `src/routes/vendors.js` line 502 referenced "the create route and every other
sibling update route" but only cited assets, projects, and licenses — changes.js
was omitted from the inline citation. The semantics are already consistent
(changes.js validates contract dates identically), so only the comment was
corrected to keep the cross-reference complete.

### Fixes applied
- **`src/routes/vendors.js:499-501` — stale comment omitting changes.js from
  date-validation cross-reference (LOW, consistency).** The validate-when-present
  comment for `contract_start` and `contract_end` listed assets, projects, and
  licenses as siblings but did not mention changes.js, which already implements
  the same `_resolveDateTimeField` absent-vs-empty convention. Added
  `changes.js` to the list so the comment accurately reflects the full set of
  sibling routes sharing the pattern.

### Regression tests added
None — the fix is a comment-only correction with no behavior change.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1121 passed / 1121 total** (69 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-09-18 (215th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views, `public/js/app.js`, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. No actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1124 passed / 1124 total** (70 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-09-19 (216th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views, `public/js/app.js`, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 EJS templates uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. No actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1124 passed / 1124 total** (70 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-09-21 (225th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views, `public/js/app.js`, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 templates: 34 page + 5 partial uses `badgeClass()` with
enum-specific fallbacks, all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
wrapped in asyncHandler. The `is_featured` checkbox array exception in
`knowledge.js` is intentional (documented in-line) and safe because
`parseBooleanFlag` only accepts canonical truthy strings. No actionable defects
were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +43 net from #224).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-09-21 (226th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views, `public/js/app.js`, and the test
suite). **No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau — all
`console.error` sites use the `(err && err.message) || String(err)` null guard
(or log a static string), all form-processing routes carry `rejectHppArrays`
guards, badge rendering across all 39 templates: 34 page + 5 partial uses `badgeClass()` with
enum-specific fallbacks (with one documented deviation in `reports/assets.ejs`
for a 3-tier computed warranty urgency that the 2-key `WARRANTY_DEADLINE_BADGE`
mapping cannot express), all nullable enum values passed to `titleCase()` in
templates carry the established `|| 'default'` guard, all write routes audit
their operations and invalidate the dashboard cache, and all async routes are
 wrapped in asyncHandler. Fixes applied in this pass: removed a duplicate heading
 artifact in the 223rd-pass entry of `CODE_REVIEW.md`, corrected the stale
"39 EJS templates" count in the 225th-pass entry to the actual 34, and added an
inline comment to `reports/assets.ejs` explaining the deliberate inline ternary
for warranty-day badges. No new actionable defects were identified in this pass.

### Fixes applied
- `CODE_REVIEW.md`: Removed duplicate `## Review cycle (223rd pass)` heading in the
  223rd-pass entry (copy-paste artifact).
- `CODE_REVIEW.md`: Corrected stale "39 EJS templates" → "39 templates: 34 page + 5 partial" in the
  225th-pass entry summary paragraph.
- `views/pages/reports/assets.ejs`: Added an inline comment documenting the
  deliberate deviation from the `badgeClass()` convention for the warranty-day
  badge (the 3-tier urgency map `critical≤30 / high≤60 / medium≤90` cannot be
  expressed by the 2-key `WARRANTY_DEADLINE_BADGE` mapping used by
  `assets/show.ejs`).

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1167 passed / 1167 total** (73 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-04 (303rd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (34 page + 5 partial templates),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard, every `process.env.*` reference is documented in
`.env.example`, and every exported constant and utility from `constants.js` and
`utils.js` is referenced somewhere in `src/`. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. The `public/js/app.js`
client-side code uses only CSP-compliant `data-*` attribute event delegation
with no inline handlers, re-fetches license keys on every reveal (never caches
them in JS memory), and masks keys on `visibilitychange` / `pagehide` to
mitigate bfcache exposure. No new actionable defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +49 net from #299).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-04 (304th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (34 page + 5 partial templates),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard, every `process.env.*` reference is documented in
`.env.example`, and every exported constant and utility from `constants.js` and
`utils.js` is referenced somewhere in `src/` or `tests/`. Additional checks this
pass: all `console.error` call sites use the `(err && err.message) || String(err)`
null guard (or log a static string), every route that uses `resolveOptionalField`
checks the `.error` sentinel and surfaces a typed flash, all async route
handlers are wrapped in `asyncHandler`, and all EJS templates carrying
POST/PUT/DELETE forms include a CSRF hidden input. Consistency checks confirmed:
fail-closed input validation is uniform across all entities, the absent-vs-empty
partial-update convention is applied via `resolveOptionalField` on every route
that preserves stored values on omission, per-account rate-limit keys
(`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. The `public/js/app.js`
client-side code uses only CSP-compliant `data-*` attribute event delegation
with no inline handlers, re-fetches license keys on every reveal (never caches
them in JS memory), and masks keys on `visibilitychange` / `pagehide` to
mitigate bfcache exposure. No new actionable defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1216 passed / 1216 total** (75 suites, +0 net).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-12 (341st pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (34 page + 5 partial templates),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`, all
15 core modules export `resetCachedStatements` as a non-throwing function, all
try/catch blocks are balanced in every source file (verified by stripping strings
and comments before counting), no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard, every `process.env.*` reference is documented in
`.env.example`, and every exported constant and utility from `constants.js` and
`utils.js` is referenced somewhere in `src/` or `tests/`. Consistency checks
confirmed: fail-closed input validation is uniform across all entities, the
absent-vs-empty partial-update convention is applied via `resolveOptionalField`
on every route that preserves stored values on omission, per-account rate-limit
keys (`authKeyGenerator`) are used on every authenticated limiter, session idle
(15 min) and absolute (8 h) timeouts are enforced via middleware, CSRF uses a
separate secret from the session, Helmet enforces strict CSP with HSTS in
production, the Express query parser is set to `'simple'` to block prototype
pollution via bracket syntax, TRACE/TRACK are rejected at the middleware edge,
database WAL mode and foreign-key integrity are asserted on startup, and
database file permissions are restricted to `0o640`. All async route handlers
are wrapped in `asyncHandler` (auth.js ×3, staff.js ×2). All EJS templates
carrying POST/PUT/DELETE forms include a CSRF hidden input. The `public/js/app.js`
client-side code uses only CSP-compliant `data-*` attribute event delegation
with no inline handlers, re-fetches license keys on every reveal (never caches
them in JS memory), and masks keys on `visibilitychange` / `pagehide` to
mitigate bfcache exposure. No new actionable defects were identified in this
pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +1 net from #340).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-12 (342nd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (34 page + 5 partial templates),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all try/catch blocks are balanced in every source file, no dangerous patterns
(`eval`, `new Function()`, `innerHTML`, `document.write`, `javascript:` URLs)
exist in `src/` or `views/`, all `res.redirect()` targets are same-origin
pathnames, all form `action` URLs are relative, every write route carries a
`rejectHppArrays` guard (41 write routes with body/query processing verified;
53 HPP guard invocations across all routes, including defensive empty-field
guards on routes like `POST /logout` that read no body fields today), every
`process.env.*` reference is documented in `.env.example` (all 17 env vars
match exactly — 7 active defaults, 10 commented-out options), and every exported
constant and utility from `constants.js` and `utils.js` is referenced somewhere
in `src/` or `tests/`. Consistency checks confirmed: fail-closed input
validation is uniform across all entities, the absent-vs-empty partial-update
convention is applied via `resolveOptionalField` on every route that preserves
stored values on omission, per-account rate-limit keys (`authKeyGenerator`) are
used on every authenticated limiter, session idle (15 min) and absolute (8 h)
timeouts are enforced via middleware, CSRF uses a separate secret from the session,
Helmet enforces strict CSP with HSTS in production, the Express query parser is
set to `'simple'` to block prototype pollution via bracket syntax, TRACE/TRACK
are rejected at the middleware edge, database WAL mode and foreign-key integrity
are asserted on startup, and database file permissions are restricted to `0o640`.
All async route handlers are wrapped in `asyncHandler` (auth.js ×3, staff.js ×2).
All EJS templates carrying POST/PUT/DELETE forms include a CSRF hidden input.
The `public/js/app.js` client-side code uses only CSP-compliant `data-*`
attribute event delegation with no inline handlers, re-fetches license keys on
every reveal (never caches them in JS memory), and masks keys on `visibilitychange`
/ `pagehide` to mitigate bfcache exposure. No new actionable defects were
identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1217 passed / 1217 total** (75 suites, +0 net from #341).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-14 (351st pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, models, EJS views (39 templates: 34 page + 5 partial),
`public/js/app.js`, the test suite, and the `CODE_REVIEW.md` history).
**No new SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage
defects were found.** The codebase remains at the same hardening plateau.
Automated cross-references verified: every badge mapping in `constants.js`
covers its enum exactly (no missing keys, no extra keys), `ALLOWED_ACTIONS` and
`ALLOWED_ENTITY_TYPES` exactly match all emitted audit values across `src/`
(all 13 entity types and 13 action values exercised — zero unused, zero extra),
all 15 core modules export `resetCachedStatements` as a non-throwing function,
all brace pairs are balanced in every source file (verified with a string/comment/
regex-aware parser — 117 open/close in app.js, 196 in utils.js, all others
balanced), all try/catch blocks are structurally balanced across all modules,
no dangerous patterns (`eval`, `new Function()`, `innerHTML`, `document.write`,
`javascript:` URLs) exist in `src/` or `views/`, all `res.redirect()` targets are
same-origin pathnames, all form `action` URLs are relative, every write route
carries a `rejectHppArrays` guard (41 write routes with body/query processing
verified; 65 HPP guard invocations across all routes), every `process.env.*`
reference is documented in `.env.example` (all 17 env vars match exactly — 7
active defaults, 10 commented-out options), and every exported constant and
utility from `constants.js` and `utils.js` is referenced somewhere in `src/` or
`tests/`. Additional checks this pass: all authenticated rate limiters use
`authKeyGenerator` (per-account, normalized-IP fallback; the single IP-keyed
limiter in auth.js is the pre-auth login limiter which correctly falls back to
IP keying), `normalizeIp()` rejects arrays (HPP on X-Forwarded-For) and returns
`'unknown'` for absent/non-string values consistently everywhere it is called,
the `<%- article.renderedContent %>` escape in `knowledge/show.ejs` is safe
because `renderMarkdown()` sanitizes through `sanitize-html` before returning,
the `marked` v15 async-extension guard (`html.then` check) prevents Promise
leakage into the template, and the `sanitize-html` CJS compatibility layer
handles both real-package shapes and the test mock without regression. No new
actionable defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1309 passed / 1309 total** (77 suites, +0 net from #350).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-17 (359th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, `app.js`, `utils.js`, `constants.js`, `models/database.js`, `seed.js`,
the pagination/nav/header partials, `tickets/show.ejs`, `public/js/app.js`,
`.env.example`, and the `CODE_REVIEW.md` history). **No new SQL injection,
IDOR, CSRF, XSS, auth, rate-limit, or error-leakage defects were found.** The
codebase remains at the same hardening plateau. Automated cross-references
verified: all 17 `process.env.*` references in `src/` are documented in
`.env.example` (7 active defaults, 10 commented-out options — exact match, no
missing or undocumented variables), the HPP guard inventory is unchanged at
65 `rejectHppArrays` invocations across all 12 route modules, and the seed
tooling remains consistent (asset/ticket counters seed `next_seq` to the last
seeded number so the first generated tag/ticket continues the sequence;
`runSeed()` normalizes NODE_ENV exactly like `app.js` so the production guard
cannot be bypassed by case/whitespace variants). Additional checks this pass:
`views/partials/pagination.ejs` strips any pre-existing `page=` param from
`baseUrl` before appending the target page (belt-and-braces over the already
page-stripped `paginateBaseUrl()`), `public/js/app.js` correctly orders the
confirm handler before the double-submit handler and only mirrors real submit
controls into hidden inputs, and the license-key reveal/mask paths remain
fetch-per-reveal with `visibilitychange`/`pagehide` masking. No new actionable
defects were identified in this pass.

### Fixes applied
None.

### Regression tests added
None.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1384 passed / 1384 total** (81 suites, +0 net from #358).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-18 (360th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, `app.js`, `utils.js`, `constants.js`, `models/database.js`, `seed.js`,
all 39 EJS templates (34 page + 5 partial), `public/js/app.js`,
`public/css/app.css` classes referenced by templates, `README.md`,
`.env.example`, `eslint.config.js`, both jest setup files, the CI workflow, and
the `CODE_REVIEW.md` history). **No new SQL injection, IDOR, CSRF, XSS, auth,
rate-limit, or error-leakage defects were found.** Three low-severity
consistency/correctness items surfaced and were fixed this pass; the codebase
otherwise remains at the same hardening plateau.

1. **Staff directory name cell hid the last name when the first name was blank**
   (display inconsistency, fixed). In `views/pages/staff/index.ejs` the linked
   (viewable) name cell rendered `<%= s.first_name %> <%= s.first_name ?
   s.last_name : '' %>` — a stray ternary that suppressed the last name
   whenever `first_name` was empty, while the adjacent unlinked branch rendered
   `first_name + ' ' + last_name` unconditionally. The column is NOT NULL but
   permits `''` (legacy rows / direct DB writes), and validation only rejects
   blanks on create/update — so such a row rendered a blank linked name and an
   "Unlinked Lastname" name in the same table. Fixed to render the last name
   unconditionally, matching the unlinked branch and every other staff-name
   rendering in the app.

2. **`changes.js` and `vendors.js` update transactions skipped the
   `changes === 0` NOT_FOUND guard** (convention uniformity, fixed). Every
   sibling update transaction (tickets, assets, projects, licenses, staff,
   knowledge) captures the `run()` result and throws `NOT_FOUND` when the
   affected-row count is 0 as belt-and-braces after the in-transaction re-fetch;
   the change and vendor update routes called `run()` without capturing the
   result. Behavior was identical (the re-fetch guarantees the row exists inside
   the transaction), but the omission broke the uniform convention and would
   silently stop guarding if a future statement edit dropped the `WHERE id`
   term. Both routes now capture the result and throw `NOT_FOUND` on 0 changes,
   reusing their existing NOT_FOUND flash/redirect handlers.

3. **`CODE_REVIEW.md` header was stale** (documentation consistency, fixed).
   The header still read "(358th pass)" although the 359th entry had been
   appended — the header date/pass counter is the file's only index and must
   track the latest entry. Updated to the 360th pass.

Cross-cutting checks re-verified this pass: every paginated list route clamps
the requested page to `totalPages` with an `id` tiebreaker in every ORDER BY
used with LIMIT/OFFSET; every write route rejects HPP arrays before
`safeQueryValue` collapses them; the absent-vs-empty partial-update convention
is uniformly applied (dates/prices/PII/enums resolve against the
transaction-consistent re-fetch); deactivated assignees/owners are preserved on
unchanged resubmission via `ensureAssigneeInList` + the equal-id exemption in
`isActiveUser` checks; requester PII is redacted for non-privileged viewers on
both the show and edit paths and preserved on partial submissions; the
knowledge index/show/edit/delete visibility rules agree (published OR author OR
privileged); the changes list is scoped to `assigned_to = user.id` for
non-privileged users matching the show gate; the licenses/vendors surfaces are
coherently admin/manager-only; list rows link only where the viewer can pass
the corresponding show-route gate; seed counters continue the AST-/TK-
sequences correctly and `runSeed()` normalizes NODE_ENV like `app.js`; the
`licenses/form.ejs` never pre-fills the stored key and masks reveal output to
`****`; `staff/index.ejs` and `staff/show.ejs` PII redaction markers
("Restricted") match the route-level nulling; the `.env.example` documents all
17 env vars exactly as read in `src/`; and `README.md` (structure, env table,
scripts, security summary) matches the current code.

### Fixes applied
1. `views/pages/staff/index.ejs` — render the last name unconditionally in the
   linked name cell (removed the `s.first_name ? … : ''` ternary).
2. `src/routes/changes.js` — capture the change-update `run()` result and
   throw `NOT_FOUND` on 0 affected rows (belt-and-braces guard matching every
   sibling update transaction).
3. `src/routes/vendors.js` — same guard for the vendor-update transaction.
4. `CODE_REVIEW.md` — header pass counter refreshed (was stale at 358).

### Regression tests added
None — the template fix is a pure display-string change pinned by the
`templates.test.js` render smoke (staff/index renders for both viewer types),
and the two route guards are unreachable defensive branches behind the
in-transaction existence re-fetch (the surrounding NOT_FOUND handlers are
already covered by existing tests).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 1384 passed / 1384 total (81 suites, +0 net from #359).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-19 (361st pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, `app.js`, `utils.js`, `constants.js`, `models/database.js`, `seed.js`,
all 39 EJS templates (34 page + 5 partial), `public/js/app.js`, the CSS classes
referenced by templates, `README.md`, `.env.example`, `eslint.config.js`, both
jest setup files, the CI workflow, and the `CODE_REVIEW.md` history). **No new
SQL injection, IDOR, CSRF, XSS, auth, rate-limit, or error-leakage defects were
found.** Two correctness items surfaced and were fixed this pass; the codebase
otherwise remains at the same hardening plateau.

1. **Error page double-escaped messages AND failed to render for pre-locals
   errors** (correctness, fixed). `views/pages/error.ejs` rendered
   `<%= escapeHtml(error.message) %>` — a manual res.locals helper call inside
   EJS's escaped-output interpolation, which is defective twice over. First,
   `<%= %>` already HTML-escapes its expression, so the wrapper double-escaped
   every message containing `&`/`<`/`>`/quotes ("a < b" displayed as the
   literal text "a &lt; b") — the same double-escape class previously fixed
   for the audit details column. Second, for errors thrown BEFORE the global
   res.locals middleware runs (body-parser 413 payload-too-large / 400
   malformed-JSON fire at the parser, ahead of session, flash, CSRF, and the
   locals middleware), `escapeHtml` is genuinely undefined — the very scenario
   the template's own `user`/`statusCode` guards and `header.ejs`'s `csrfToken`
   guard (pass 141) exist for. The render then threw a secondary
   `ReferenceError`, and Express downgraded the styled 413/400 page to a
   bare-text 500 with a wrong status code. Verified end-to-end: an oversized
   urlencoded POST previously returned 500 + a `ReferenceError` stack; after
   the fix it returns the styled 413 "Request Error" page. The manual call was
   removed — EJS's built-in escaping preserves the pass-298 security contract
   (message escaped exactly once; raw `<%-` output stays forbidden) with no
   dependency on locals scope.

2. **405 `Allow` header omitted OPTIONS** (protocol consistency, fixed). The
   TRACE/TRACK rejection middleware in `app.js` advertised
   `Allow: GET, HEAD, POST, PUT, DELETE`, but the app genuinely serves OPTIONS
   (Express's automatic OPTIONS handler answers matching routes, and
   `doubleCsrfProtection` explicitly skips OPTIONS) — so the advertised set was
   inaccurate per RFC 9110 §10.2.1 (Allow lists the methods supported by the
   target resource). OPTIONS was added to `_ALLOWED_METHODS`; no routing,
   CSRF, or write-method behavior changed — only the advertised metadata.
   Pass 167's inverse logic (PATCH removed because no route handles it) is
   preserved: the list now exactly equals the set of methods the app serves.

Cross-cutting checks re-verified this pass: the error/404/header partial guard
set is complete for the pre-res.locals render path (post-fix, every local
referenced by `error.ejs` is either passed by the error handler or
`typeof`-guarded, matching `header.ejs`/`404.ejs`); every write route rejects
HPP arrays before `safeQueryValue` collapses them (the knowledge form's
intentional `is_featured` checkbox-array exception is documented and resolved
last-element by `resolveSafeFeatured`); every paginated list route clamps the
requested page to `totalPages` with `id` tiebreakers in all LIMIT/OFFSET
ORDER BY clauses; absent-vs-empty partial-update resolution is uniform across
tickets/assets/projects/vendors/licenses/changes/staff (dates, prices, PII,
enums resolved against the transaction-consistent re-fetch); every update
transaction captures the `run()` result and throws NOT_FOUND on 0 changes;
deactivated assignees/owners are preserved on unchanged resubmission via
`ensureAssigneeInList`/`ensureLinkedAssetInList` plus the equal-id exemption;
requester PII is redacted for non-privileged viewers on show and edit paths and
preserved on partial submission; the knowledge index/show/edit/delete
visibility rules agree (published OR author OR privileged); changes are scoped
to `assigned_to` for non-privileged list viewers matching the show gate;
licenses/vendors remain coherently admin/manager-only with list rows linked
only where the viewer passes the show gate; all badge/CSS classes referenced
by templates exist in `app.css`; every mutation route calls
`invalidateDashboardCache()` (and `invalidateActiveStaffCache()` for
user-column writes); `.env.example` documents all 17 env vars exactly as read
in `src/`; seed counters continue the AST-/TK- sequences and the seed guard
normalizes NODE_ENV identically to `app.js`; and `README.md` matches the
current code. Historical pins updated per convention: `code_review_298`
(re-pinned to the escaped-interpolation form whose intent it actually had) and
`code_review_167` (Allow-list string refreshed for the OPTIONS addition).

### Fixes applied
1. `views/pages/error.ejs` — render `error.message` through EJS's built-in
   `<%= %>` escaping instead of the manual `escapeHtml()` wrapper (fixes the
   pre-locals secondary ReferenceError that downgraded styled 413/400 pages to
   bare-text 500s, and the double-escaping of messages with HTML
   metacharacters).
2. `src/app.js` — add OPTIONS to the 405 `Allow` header so the advertised
   method set matches the methods the app actually serves (no behavior change).
3. `tests/code_review_167.test.js` — Allow-list pin refreshed for the OPTIONS
   addition (PATCH remains absent everywhere).
4. `tests/code_review_298.test.js` — re-pinned to the corrected escaping
   convention: `<%= error.message %>` present, raw `<%-` forbidden (the old
   pin mislabeled escaped interpolation as "bare").

### Regression tests added
`tests/code_review_361.test.js` (4 tests): error.ejs renders with no
`escapeHtml` local (pre-res.locals error path) and degrades the CTA to the
anonymous branch; messages with `&`/`<` escape exactly once (no
`&amp;amp;`/`&amp;lt;`); an oversized urlencoded POST through the real app
(mocked DB/middleware, matching `app.test.js`'s harness) returns the styled
413 HTML page — status not downgraded to 500 and no `ReferenceError` text
leaks; and a raw-socket TRACE request is rejected with 405 advertising
`Allow: GET, HEAD, POST, PUT, DELETE, OPTIONS`. Verified the template tests
fail against the pre-fix template (3 of 4 fail when the fix is reverted).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — 1388 passed / 1388 total (82 suites, +1 from #360).
- `npm run test:coverage` — global thresholds pass (statements 67.68%,
  branches 65.25%, functions 76.75%, lines 67.68%).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-20 (368th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, `app.js`, `utils.js`, `constants.js`, `models/database.js`, `seed.js`,
all 39 EJS templates (34 page + 5 partial), `public/js/app.js`, the CSS classes
referenced by templates, `README.md`, `.env.example`, `eslint.config.js`, both
jest setup files, the CI workflow, and the `CODE_REVIEW.md` history). **One
functional defect that made a core write path permanently unusable was found
and fixed**, plus eight correctness/consistency items. No new SQL injection,
IDOR, CSRF, XSS, auth, rate-limit, or error-leakage defects were found.

1. **Asset creation was permanently wedged by a tag collision — the counter
   increment was rolled back with the failed INSERT** (HIGH, correctness).
   `assets.js` generated the asset tag from `asset_counter` *inside the same
   transaction* as the INSERT:

   ```js
   const counterRow = _assetCounterGetStmt.get();   // next_seq incremented here
   const asset_tag = ASSET_TAG_PREFIX + String(counterRow.next_seq).padStart(3, '0');
   const result = _insertStmt.run(asset_tag, ...);  // INSERT here
   ```

   `asset_tag` is UNIQUE **and admin-editable** on `PUT /assets/:id` — an admin
   can rename an asset to the exact tag the counter is about to hand out. When
   the INSERT then violated the constraint, the transaction rolled back the
   counter increment *as well*, so the next attempt regenerated the identical
   colliding tag. Verified against real SQLite: three consecutive creates all
   produced `AST-001` and all failed, with the counter frozen at `next_seq = 1`.
   Asset creation was unrecoverable by retry — the only remedy was an admin
   manually renaming the conflicting asset (or hand-editing the counter table)
   — and the error message ("An asset with this tag already exists") gave no
   hint of that. Fix: retry inside the transaction. Each attempt consumes
   another counter value, so the loop walks past the taken tag(s) and commits
   the accumulated increments; only the successfully inserted row is persisted.
   The loop is bounded (`MAX_TAG_ATTEMPTS = 10`) so it can never spin, and it
   retries **only** a UNIQUE violation on `asset_tag` — the separate
   `serial_number` partial unique index is rethrown untouched so the existing
   "An asset with this serial number already exists" message still fires and
   no counter value is burned on it.

2. **Ticket creation had the identical counter-rollback wedge, and reported it
   as a generic server error** (MEDIUM, correctness). `tickets.js` incremented
   the per-UTC-date `ticket_counter` in the same transaction as the ticket
   INSERT, so a `ticket_number` collision (counter drift after a partial
   restore, a manual insert, or a migrated DB with no counter row) regenerated
   the same number on every retry and failed for the whole UTC day. Worse, the
   catch block had **no** `SQLITE_CONSTRAINT_UNIQUE` branch (unlike
   `assets.js`), so a duplicate number was mis-reported as "Error creating
   ticket. Please try again." — blaming the server for a data condition. Fixed
   with the same bounded in-transaction retry (`MAX_TICKET_NUMBER_ATTEMPTS =
   10`) plus an explicit UNIQUE branch that reports the duplicate number
   accurately.

3. **The asset page applied the related-ticket LIMIT before the access
   filter** (MEDIUM, correctness). `_relatedTicketsStmt` selected the newest
   N linked tickets and the route then filtered the already-truncated set
   through `canAccessResource`. An authorised viewer (the asset's assignee)
   whose own ticket fell outside the newest-N window was shown "No tickets
   linked to this asset" while a privileged viewer saw the newest N. The
   access predicate is now applied **in SQL** for non-privileged viewers
   (`WHERE asset_id = ? AND assigned_to = ?`), so the LIMIT caps the rows the
   viewer may actually see; the JS `canAccessResource` filter is retained as
   defence-in-depth. Because `tickets` carries only `assigned_to` among the
   ownership columns, the SQL predicate is exactly equivalent to the JS check
   for non-privileged viewers.

4. **The ticket comment route's `updated_at` touch had no no-op guard**
   (LOW, consistency). Every other mutation in the app captures the affected-row
   count and treats `changes === 0` as `NOT_FOUND` — a convention the 367th
   pass applied to the staff/vendor state mutations. The comment route's
   `_commentTouchStmt.run(id)` was the one remaining unguarded UPDATE. It now
   throws `NOT_FOUND` on a zero-row write (inside the transaction, so the
   comment INSERT rolls back with it).

5. **A deactivated account was redirected with the wrong login reason**
   (LOW, correctness). The comment route's `USER_INACTIVE` branch redirected
   to `/login?reason=session_expired`, which the login page renders as "Your
   session has expired after reaching its maximum lifetime." — a
   self-contradictory message for a deactivated employee ("Your account is no
   longer active." + "…maximum lifetime"). The app already has a dedicated
   `deactivated` reason, used by `middleware/auth.js` for the same condition;
   the comment route now uses it too.

6. **The knowledge mutation routes leaked article existence** (LOW,
   information disclosure). The show route deliberately normalises a denial to
   "Article not found" so a non-privileged viewer cannot distinguish "exists
   but not yours" from "does not exist". The edit / update / delete routes
   used a distinct "You do not have permission to … this article." message,
   which let a plain staff account probe `/knowledge/<id>/edit` and learn
   which article IDs exist — including the draft/archived articles the index
   deliberately hides from them. All four denial paths now use the show
   route's non-enumerating wording; the `access_denied` audit entries are
   unchanged.

7. **The license edit form loaded the plaintext key into the render context**
   (LOW, defence-in-depth). `GET /licenses/:id/edit` handed the full row —
   including the plaintext `license_key` — to the EJS template. The form
   never pre-fills the key (the input carries no `value` attribute) and only
   needs to know whether a key *is* stored, so the secret is now replaced by
   a `has_license_key` boolean. This matches the sibling list route (which
   omits `license_key` from its SELECT entirely) and the dashboard (which
   deliberately avoids `SELECT *` for the same reason). The full key remains
   reachable only through the audited, rate-limited
   `POST /licenses/:id/key` reveal endpoint.

8. **A whitespace-only department silently cleared the stored value while the
   sibling phone field failed closed** (LOW, consistency/data loss). In the
   staff update handler, `department` was trimmed before it reached
   `resolveOptionalField`, so a value of `"   "` looked like an explicit
   empty string and cleared the stored department — with a "success" flash and
   no warning. The phone field two lines away already rejects a
   present-but-blank value ("Please enter a valid phone number"). Department
   now behaves the same way: a present-but-blank value is rejected, while an
   ABSENT field still preserves the stored value and an explicit `''` still
   clears it.

9. **The staff directory search matched the redacted email column**
   (LOW, information disclosure). The index nulls `email`/`phone`/
   `department`/`last_login`/`avatar` for non-privileged viewers (rendered as
   "Restricted"), but the search predicate still matched `u.email` and
   `u.username` for those viewers — so the returned row **count** was an
   email-existence oracle: a staff member could submit
   `?search=someone@company.com` and learn whether that address belongs to an
   account without ever seeing the address. The searchable column set is now
   privilege-dependent: privileged viewers keep all four columns,
   non-privileged viewers search only the two name columns the directory
   actually renders for them. (`username` is not rendered in the directory at
   all, so it is excluded from the non-privileged set for the same reason.)

10. **Password inputs declared a `maxlength` the server would always reject**
    (LOW, view/route contract mismatch). Every password field declared
    `maxlength="<%= CONSTANTS.MAX_PASSWORD %>"` (128 characters) while the
    server rejects any password over `MAX_PASSWORD_BYTES` (72 **bytes**) —
    the binding limit, since bcrypt truncates at 72 bytes. A user could type
    80 characters and be told "Password must be at most 72 bytes" (a unit the
    UI never mentions). All password inputs now declare
    `maxlength="<%= CONSTANTS.MAX_PASSWORD_BYTES %>"`, and
    `MAX_PASSWORD_BYTES` was wired into `TEMPLATE_CONSTANTS` (the existing
    `templates.test.js` guard verifies every `CONSTANTS.*` referenced by a
    template is exported and wired).

11. **Capped list queries without a total ordering** (LOW, convention). The
    codebase documents the rule explicitly (`tickets.js`: "Every ORDER BY
    carries an `id` tiebreaker: created_at/updated_at have second-resolution
    ties … without a unique trailing key SQLite's sort order is not total, so
    LIMIT/OFFSET paging could hide or duplicate rows across pages"), and the
    358th pass applied it to every paginated list. Four **capped** sidebar /
    detail queries still lacked it: `projects._showTasksStmt` (its own
    sibling `_showMembersStmt` already carried `pm.id ASC`),
    `tickets._showCommentsStmt`, `staff._assignedTicketsStmt` /
    `_assignedTasksStmt` / `_projectMembershipsStmt`, and
    `assets._relatedTicketsStmt`. In addition,
    `staff._assignedAssetsStmt` had **no ORDER BY at all**, so which assets
    appeared in the sidebar of an employee with more than ten assets was not
    defined by the query. All five now carry a unique trailing key.

12. **Two stale comments contradicted the code they documented**
    (LOW, documentation consistency). `projects.js` claimed that an empty
    budget/spent is "fail closed — reject rather than silently keep the old
    value" and that "an empty budget/spent can no longer be silently ignored",
    while the code has always preserved the stored value on an absent **or**
    empty money field — the same convention `assets.purchase_price` and
    `licenses.cost` follow, for the documented reason that a NULL amount is
    indistinguishable from "not recorded". The comments now state the
    implemented convention (and note that an explicit `0` is a legitimate
    value that clears an amount to zero). Separately, the staff deactivation
    flash said "open tickets/tasks/changes unassigned" while the route also
    clears the ownership of in-progress projects — a fact the audit string
    already recorded. The flash now names all four.

13. **The staff profile sidebars did not disclose their cap** (LOW, display
    consistency). "Assigned Tickets (N+)" and "Active Tasks (N+)" show a `+`
    when the sidebar query's LIMIT was hit; the "Projects" and "Assets" cards
    on the same page did not, so a viewer could not tell that 10 of N assets
    were shown. Both now carry the same `(N+)` indicator.

Cross-cutting checks re-verified this pass: every paginated list route clamps
the requested page to `totalPages` with an `id` tiebreaker in every ORDER BY
used with LIMIT/OFFSET; every write route rejects HPP arrays before
`safeQueryValue` collapses them (the knowledge form's intentional
`is_featured` checkbox-array exception remains documented and resolves
last-element); the absent-vs-empty partial-update convention is uniformly
applied (dates/prices/PII/enums resolve against the transaction-consistent
re-fetch); every update transaction captures the `run()` result and throws
`NOT_FOUND` on 0 changes; deactivated assignees/owners are preserved on
unchanged resubmission via `ensureAssigneeInList` + the equal-id exemption in
`isActiveUser` checks; requester PII is redacted for non-privileged viewers on
both the show and edit paths and preserved on partial submissions; the
knowledge index/show/edit/delete visibility rules agree (published OR author
OR privileged) and the denial wording now agrees too; the changes list is
scoped to `assigned_to = user.id` for non-privileged users matching the show
gate; the licenses/vendors surfaces are coherently admin/manager-only; list
rows link only where the viewer can pass the corresponding show-route gate;
seed counters continue the AST-/TK- sequences correctly and `runSeed()`
normalizes NODE_ENV like `app.js`; the `licenses/form.ejs` never pre-fills the
stored key and masks reveal output to `****`; `staff/index.ejs` and
`staff/show.ejs` PII redaction markers ("Restricted") match the route-level
nulling; the `.env.example` documents all 17 env vars exactly as read in
`src/` (and the README's env table matches); and `README.md` (structure, env
table, scripts, security summary) matches the current code.

### Fixes applied
1. `src/routes/assets.js` — bounded in-transaction retry around the asset-tag
   INSERT (the counter increment no longer rolls back on a tag collision);
   `MAX_TAG_ATTEMPTS = 10`; only `asset_tag` UNIQUE violations are retried.
2. `src/routes/assets.js` — related-ticket access predicate moved into SQL
   (`_relatedTicketsOwnedStmt`) so the LIMIT caps the *accessible* rows; the
   JS `canAccessResource` filter is retained as defence-in-depth.
3. `src/routes/assets.js` — `_relatedTicketsStmt` gained an `id DESC`
   tiebreaker.
4. `src/routes/tickets.js` — bounded in-transaction retry around the
   ticket-number INSERT (`MAX_TICKET_NUMBER_ATTEMPTS = 10`).
5. `src/routes/tickets.js` — the create catch block gained a
   `SQLITE_CONSTRAINT_UNIQUE` branch reporting a duplicate ticket number
   accurately instead of the generic server-error message.
6. `src/routes/tickets.js` — the comment route's `_commentTouchStmt` now
   throws `NOT_FOUND` on a zero-row write.
7. `src/routes/tickets.js` — the deactivated-account redirect now uses
   `?reason=deactivated`.
8. `src/routes/tickets.js` — `_showCommentsStmt` gained a `tc.id DESC`
   tiebreaker.
9. `src/routes/knowledge.js` — the four edit/update/delete denial paths now
   use the show route's non-enumerating "Article not found" wording.
10. `src/routes/licenses.js` — the edit route passes
    `{ ...license, license_key: undefined, has_license_key }` so the plaintext
    key never reaches the template.
11. `src/routes/staff.js` — a present-but-blank department is rejected
    (mirrors the sibling phone field); absent still preserves, `''` still
    clears.
12. `src/routes/staff.js` — the directory search column set is now
    privilege-dependent, removing the email-existence oracle.
13. `src/routes/staff.js` — the four sidebar queries gained `id` tiebreakers
    and `_assignedAssetsStmt` gained the missing `ORDER BY name ASC, id ASC`.
14. `src/routes/staff.js` — the deactivation flash now names projects.
15. `src/routes/projects.js` — `_showTasksStmt` gained a `pt.id ASC`
    tiebreaker; the budget/spent comments were corrected to match the
    implemented money-field convention.
16. `src/constants.js` + `src/app.js` — `MAX_PASSWORD_BYTES` wired into
    `TEMPLATE_CONSTANTS`; the `MAX_PASSWORD` comment now explains the
    relationship between the two limits.
17. `views/pages/auth/login.ejs`, `views/pages/auth/profile.ejs`,
    `views/pages/staff/form.ejs`, `views/pages/staff/show.ejs` — password
    inputs cap at `MAX_PASSWORD_BYTES`.
18. `views/pages/licenses/form.ejs` — the "Clear existing key" checkbox now
    keys off `has_license_key`.
19. `views/pages/staff/show.ejs` — the Projects and Assets sidebar cards now
    carry the `(N+)` cap indicator.

### Regression tests added
`tests/code_review_368.test.js` (15 tests) and
`tests/code_review_368_counter.test.js` (5 tests) — 20 new tests, +20 net.

- `tests/code_review_368_counter.test.js` runs against a **real in-memory
  SQLite database** (not the shared jest mock) so the transaction semantics
  that caused the wedge are genuinely exercised: an admin-renamed asset that
  occupies the counter's next tag still creates successfully with the next
  free tag and the counter commits the consumed sequence value; the same for
  the daily ticket number; the no-collision path still yields `AST-001` /
  `TK-<today>-001`; and a `serial_number` collision is **not** retried and is
  still reported as a serial-number conflict. Verified that 2 of these tests
  fail against the pre-fix code (the create returned "An asset with this tag
  already exists" / "Error creating ticket. Please try again." and no row was
  written).
- `tests/code_review_368.test.js` (per-SQL statement mock) covers: the
  access-scoped related-ticket query for both viewer classes plus the
  retained JS filter; the comment route's zero-row no-op guard (not-found
  flash, no success audit); the license edit route's key redaction and
  `has_license_key` flag; the whitespace-only department rejection and the
  still-working explicit-empty clear; the privilege-dependent directory
  search columns; the deactivation flash wording; and source-level pins for
  every `id` tiebreaker, the `deactivated` reason, the non-enumerating
  knowledge wording, the password `maxlength` wiring, and the corrected
  projects money-field comment. Verified that 12 of the 15 fail against the
  pre-fix code.
- Historical pins updated per convention: `tests/code_review_136.test.js`
  (the `USER_INACTIVE` redirect reason is now `deactivated`) and
  `tests/knowledge.test.js` (the in-transaction delete denial now flashes
  "Article not found"). The three suites that mock `../src/constants` gained
  `MAX_PASSWORD_BYTES: 72` so the template constant resolves under the mock.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1432 passed / 1432 total** (90 suites, +20 from #367).
- `npm run test:coverage` — global thresholds pass (statements 70.59%,
  branches 67.91%, functions 79.61%, lines 70.59%; up from 67.68/65.25/76.75/67.68).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-20 (369th pass)

An independent pass re-read every route module, both middleware modules,
`app.js`, `utils.js`, `constants.js`, `models/database.js`, `seed.js`, all 39 EJS
templates (34 page + 5 partial), `public/js/app.js`, `public/css/app.css`,
`README.md`, `.env.example`, `eslint.config.js`, both jest setup files and the
CI workflow, and re-verified the documented invariants (HPP rejection,
absent-vs-empty partial updates, transaction-consistent rechecks, `changes === 0`
no-op guards, access-scoped list queries, cache invalidation, ordering
determinism, and view-to-route gating). Two access-control defects and seven
consistency/completeness defects were found and fixed. No new SQL injection,
IDOR, CSRF, XSS, rate-limit, or error-leakage defects were found.

1. **The dashboard disclosed change records the viewer is denied on the change
   log** (MEDIUM, access scoping). `dashboard.js` listed *every* scheduled
   change (title + start time) in the shared, TTL-cached payload:

   ```js
   upcomingChanges: db.prepare(`
     SELECT id, title, scheduled_start FROM change_log
     WHERE status = 'scheduled' AND scheduled_start >= strftime('%Y-%m-%d %H:%M', 'now')
     ORDER BY scheduled_start ASC LIMIT 5
   `),
   ```

   while `changes.js` scopes the change list to `assigned_to = user.id` for
   non-privileged viewers (`changes.js:109-112`) and denies them the detail
   route via `canAccessResource` (`changes.js:291`). A staff member therefore
   saw the titles of changes they are refused — the exact content-oracle class
   the change list was closed for, re-opened on the landing page (change titles
   routinely name systems, CVEs and outage windows). Fix: the query moved out
   of the shared cache into the per-viewer section (exactly like `myTickets`),
   with an unscoped variant for privileged viewers and an `assigned_to = ?`
   variant for everyone else, so the dashboard now honours the same policy as
   the change log.

2. **`/changes/:id` revealed that a record exists** (LOW, information
   disclosure). The denied branch flashed "You do not have permission to view
   this change." while a missing id flashed "Change not found". Because the
   list is now scoped, a staff member could enumerate which change ids exist
   (and every probe wrote an `access_denied` audit row naming the title). The
   denial now uses the show route's non-enumerating "Change not found"
   wording — the same fix pass 368 applied to the knowledge base. The audit
   entry is unchanged.

3. **A present-but-whitespace-only optional field silently wiped the stored
   value on every update route** (MEDIUM, data loss). The shared
   `resolveOptionalField()` helper distinguishes an ABSENT field (preserve the
   stored value) from an explicit `''` (clear it), but a whitespace-only value
   ("   ") trimmed to `''` and therefore took the *clear* branch — so a ticket
   description, a project description, a vendor note, an asset serial number …
   was erased while the route flashed "updated successfully". The app already
   knew this was wrong: pass 368 added an ad-hoc guard for `staff.department`
   only, leaving the other ~20 optional text fields inconsistent. Fix: the rule
   is now enforced centrally in `resolveOptionalField()` — a present,
   whitespace-only string returns the same error sentinel used for HPP arrays
   and non-string values, so every update route fails closed with its existing
   "Invalid <Field>" message. An explicit `''` still clears the field, and an
   ABSENT field still preserves it.

4. **Capped lists did not disclose their truncation** (LOW, display
   consistency). Every capped list in the app is a bounded slice of a larger
   set, and the app's convention is to say so with an "(N+)" marker — the staff
   profile sidebars, the ticket comments and the project tasks/members all
   carry it. The asset page's "Related Tickets" card did not, so an asset with
   25 linked tickets showed 10 of them under a heading that implied
   completeness. The marker is now rendered there.

5. **The ticket-comment truncation marker under-reported the cap for
   non-privileged viewers** (LOW, display correctness). The marker was derived
   from `comments.length`, but the internal-comment filter runs *after* the
   500-row cap, so a staff member saw e.g. "Comments (400)" for a list that was
   in fact truncated — the opposite of the truth on exactly the viewer for whom
   the count is already wrong. The route now computes `commentsTruncated` from
   the pre-filter row count and the template renders the marker from it.

6. **Capped dashboard and report queries had no total ordering** (LOW,
   convention). The codebase documents the rule ("Every ORDER BY carries an
   `id` tiebreaker: … without a unique trailing key SQLite's sort order is not
   total, so LIMIT/OFFSET paging could hide or duplicate rows") and passes
   358/368 applied it to every paginated and capped list. Ten capped
   aggregation queries still lacked it: `dashboard.recentTickets`,
   `dashboard.expiringWarranties`, `dashboard.upcomingChanges`,
   `dashboard.ticketsByCategory`, `dashboard.staffWorkload`,
   `dashboard.licenseAlerts`, `dashboard.myTickets`, `reports.topResolvers`,
   `reports.warrantyExpiring` and `reports.staffPerformance`. All ten now
   carry a unique trailing key, so the row at the LIMIT boundary can no longer
   swap between cache refreshes (seeded rows share one `created_at`, so ties
   are the normal case, not the exception).

7. **The change-log assignee filter was inert for non-privileged viewers**
   (LOW, UI correctness). The route hard-adds `assigned_to = <viewer>` to the
   WHERE clause for non-privileged users, so the filter dropdown offered every
   colleague but any selection other than the viewer returned zero rows. The
   control is now rendered only for privileged viewers — the same pattern the
   knowledge index uses for its status filter.

8. **The assets and projects lists exposed no sort control although the routes
   honour `?sort=`** (LOW, completeness). Both routes read, validate and apply
   a `sort` parameter through their `SORT_MAP`, and `paginationBaseUrl`
   preserved it across pages, but no form ever produced it — the feature was
   reachable only by hand-editing the URL. Both filter bars now carry the same
   `<select name="sort">` the ticket list uses, with the route's default
   pre-selected.

9. **A credential change inside the same second did not invalidate the
   session** (LOW, correctness). `password_changed_at` was written with
   `datetime('now')` (one-second resolution) and compared verbatim against the
   copy stored in the user's session. A password reset (admin route) or a
   self-service password change that landed in the same second as the session's
   marker produced an equal string, so the session issued against the *old*
   credential survived for its full lifetime. Both writers now stamp
   millisecond-resolution markers (`strftime('%Y-%m-%d %H:%M:%f','now')`).

10. **22 unreachable badge CSS rules** (LOW, dead code). Every badge is
    rendered through `badgeClass(value, BADGE_MAP)`, which can only ever emit
    `badge-low` / `badge-medium` / `badge-high` / `badge-critical` — the union
    of all 20 badge maps in `constants.js`. The per-enum rules
    (`.badge-open`, `.badge-in_progress`, `.badge-failed`, …) matched nothing,
    and several contradicted the maps they duplicated (`.badge-failed` was red
    while `CHANGE_STATUS_BADGE` maps `failed` → `critical`). They were removed
    and replaced with a comment pointing at the badge maps.

Also verified this pass: every write route still rejects HPP arrays before any
value is consumed; every update transaction still re-reads the row inside the
transaction and throws `NOT_FOUND` on a zero-row write; the absent-vs-empty
convention is now uniform (absent ⇒ preserve, `''` ⇒ clear, present-but-blank
⇒ fail closed) across tickets, projects, tasks, assets, vendors, licenses,
changes, staff and the profile route; requester PII is still redacted for
non-privileged viewers on both the show and edit paths; the ticket list remains
open to all staff while the change list, knowledge base, licenses and vendors
remain scoped/privileged — and every surface that discloses a scoped record
(dashboard, list, show) now agrees; the deactivation unassignment still clears
tickets, tasks, changes and project ownership; the seed counters still produce
the `AST-` / `TK-` sequences correctly; `.env.example` still documents all 17
env vars exactly as read in `src/`; and `README.md` still matches the code.

### Fixes applied
1. `src/routes/dashboard.js` — the upcoming-changes query moved out of the
   shared TTL cache into the per-viewer section, split into
   `upcomingChangesAll` (privileged) and `upcomingChangesOwned`
   (`assigned_to = ?`); the shared payload no longer contains change rows.
2. `src/routes/changes.js` — the show route's access-denied branch now uses the
   non-enumerating "Change not found" wording (audit entry unchanged).
3. `src/utils.js` — `resolveOptionalField()` rejects a present-but-whitespace-only
   value with the error sentinel, so every update route fails closed instead
   of silently clearing the stored value.
4. `src/routes/tickets.js` — the show route passes `commentsTruncated`
   (computed from the pre-filter row count) to the template.
5. `src/routes/dashboard.js` + `src/routes/reports.js` — ten capped queries
   gained a unique trailing sort key.
6. `src/constants.js` + `src/app.js` — new `DASHBOARD_LIMITS` constant (the
   dashboard caps) exported and wired into `TEMPLATE_CONSTANTS`, so the
   template and the route can never drift; `src/routes/dashboard.js` imports
   it instead of declaring its own literals.
7. `views/pages/dashboard.ejs` — the four capped widgets (My Active Tickets,
   Team Workload, Upcoming Changes, Recently Active Tickets) carry the "(N+)"
   marker.
8. `views/pages/assets/show.ejs` — the Related Tickets card carries the "(N+)"
   marker.
9. `views/pages/tickets/show.ejs` — the Comments marker is driven by the
   route's truncation flag.
10. `views/pages/changes/index.ejs` — the assignee filter is rendered only for
    privileged viewers.
11. `views/pages/assets/index.ejs` + `views/pages/projects/index.ejs` — the
    missing sort controls were added.
12. `src/routes/staff.js` + `src/routes/auth.js` — the credential-change marker
    uses millisecond resolution.
13. `public/css/app.css` — the 22 unreachable per-enum badge rules were removed.

### Regression tests added
`tests/code_review_369.test.js` (20 tests) — new file, +22 net.

- The dashboard scoping, the change-denied wording and the whitespace-only
  rejections run against a **real in-memory SQLite database** (not the shared
  jest mock), so the SQL and the transaction semantics are genuinely
  exercised: a staff member's dashboard lists only their own scheduled change
  (and a privileged viewer's lists both, from the same process), a denied
  change and a missing change produce the identical flash, a whitespace-only
  ticket description/resolution note and project description are rejected with
  the stored value intact, and an explicit `''` still clears the field.
- Template-level assertions cover the new "(N+)" markers (asset related
  tickets, ticket comments, the four dashboard widgets), the privilege-dependent
  change-log assignee filter, and the new assets/projects sort controls.
- Source-level pins cover the `id`/group-key tiebreakers in the capped
  dashboard and report queries, the millisecond credential marker, and the
  removal of the dead badge rules.
- Verified that 16 of the 20 new tests fail against the pre-fix code (the 4
  that pass are the "must still work" guards: a privileged viewer still sees
  every change, a missing record still reports "Change not found", and an
  explicit empty string still clears the description on both routes).
- Historical pins updated per convention: `tests/utils.test.js` and
  `tests/vendors.test.js` documented the old "whitespace-only clears" contract
  of `resolveOptionalField()`; both now assert the fail-closed contract (plus
  the explicit-`''` clear that is unchanged).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1454 passed / 1454 total** (91 suites, +22 from #368).
- `npm run test:coverage` — global thresholds pass (statements 70.94%,
  branches 68.26%, functions 80.25%, lines 70.94%; up from
  70.59/67.91/79.61/70.59).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-20 (370th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, `app.js`, `utils.js`, `constants.js`, `models/database.js`, `seed.js`,
all 39 EJS templates, `public/js/app.js`, the CSS classes referenced by the
templates, `README.md`, `.env.example`, `eslint.config.js`, both jest setup
files, the CI workflow, and the `CODE_REVIEW.md` history) surfaced **three real
defects, two of them user-visible functional breakages**, plus four
documentation/completeness gaps. The method this pass added a **runtime smoke
sweep** — every GET route exercised as both an admin and a regular staff user
against a seeded in-memory database — and that sweep is what exposed the first
defect, which no amount of static re-reading had caught.

1. **Every authenticated `GET /profile` returned HTTP 500** (HIGH,
   correctness). `src/routes/auth.js` logged the profile read through
   `req.audit('read', 'user', ...)` — the app-wide convention for read
   surfaces — but the auth router was the only route module that never
   mounted `auditMiddleware`, so `req.audit` was `undefined` and the handler
   died with `TypeError: req.audit is not a function` before it could render.
   The "My Profile" page, which the header links from every screen, was
   therefore broken for every user of every role. The unit test that pinned
   the read audit (`tests/code_review_192.test.js`) injected `req.audit` into
   its fake request by hand, so it exercised the handler but never the router's
   middleware chain — the missing wiring was invisible to it, and to every
   other route-level test in the suite. Fix: mount `auditMiddleware` on the
   auth router (`router.use(auditMiddleware)` — deliberately without
   `requireAuth`, since `/login` and `/logout` are public routes).

2. **The `Permissions-Policy` header was never sent** (MEDIUM, correctness).
   `src/app.js` configured `permissionsPolicy: { camera: [], microphone: [],
   geolocation: [], usb: [], bluetooth: [], payment: [], midi: [],
   gyroscope: [], accelerometer: [], magnetometer: [] }` on `helmet()`, under a
   comment explaining that helmet does not set the header by default "so we add
   one explicitly". Helmet 8.2.0 **removed** its Permissions-Policy
   middleware entirely, and `helmet()` builds its middleware list from a fixed
   set of known options and silently ignores anything else — the option was
   therefore dead configuration and no `permissions-policy` header was emitted
   on any response of the app. The documented "restrict browser features"
   control did not exist. Fix: set the header explicitly with the same feature
   list (`camera=()`, `microphone=()`, …) and delete the dead helmet option.

3. **The TRACE/TRACK 405 response was the only response in the app without
   security headers** (MEDIUM, consistency). The disallowed-methods guard was
   registered as the very first middleware — ahead of `helmet()` — so the 405
   it returned shipped with no CSP, no `X-Frame-Options`, no `nosniff`, no
   `Referrer-Policy`, no `Permissions-Policy` and no `Cache-Control:
   no-store`, while every other response carried the full set (verified
   against a live server: the TRACE response had exactly four headers). Fix:
   move the guard to just after `helmet()` and `morgan()` — it still
   short-circuits before the body parsers, the CSRF middleware and every
   route, so the documented invariant ("no downstream handler ever processes
   them") is unchanged — and apply the app's no-store policy to the 405 through
   the shared `_applyNoStoreHeaders()` helper, which the global cache-control
   middleware now also uses. The rejected request is additionally recorded in
   the access log.

Also fixed this pass (documentation / completeness):

4. **`.env.example` advertised a `SESSION_STORE` package the loader cannot
   load.** The example named `connect-redis`, but the loader only supports the
   classic connect-session factory shape (`module.exports = function (connect)
   { return StoreClass; }`). `connect-redis@10` exports an object
   (`module.exports = { RedisStore }`), so `new Store()` throws "Store is not a
   constructor" and the server exits at startup with a cryptic message — and
   no `connect-redis` version can work as-is, because the loader passes no
   store options (a Redis client can never be supplied). The example now names
   only `connect-sqlite3`, and `.env.example`, the README configuration table
   and the loader's error message all state the required export shape.

5. **Stale `SESSION_COOKIE_OPTIONS` comment.** `src/constants.js` claimed the
   constant carried the `secure` flag; it does not — the flag is injected per
   call site from `NODE_ENV` (app.js session config, middleware/auth.js
   `clearCookie`, routes/auth.js logout `clearCookie`). The comment now says
   exactly that, so the next reader does not assume the production behaviour
   is implied by the constant.

6. **The README's "seed output" block was not the literal output.** It showed
   a parenthetical ("also trodriguez, akimura, dmuller share the same staff
   password") that the seeder never prints. The block now reproduces the real
   output and the shared-staff-password fact moved into prose.

7. **`CODE_REVIEW.md` gave no hint about its own layout.** The header names the
   latest cycle, but the review cycles are appended chronologically at the END
   of the file (the descending block at the top is the original history), so a
   reader starting at the top met the 367th pass and could mistake it for the
   most recent review. A short layout note now points to the newest cycle.

Also verified this pass: every write route still rejects HPP array payloads
(a mechanical sweep of all 12 route modules found only the two documented
`is_featured` exceptions, which the hidden-input + checkbox idiom requires);
every mutation still guards on `changes === 0`; every paginated or capped
query still carries an `id`/`assigned_to` tiebreaker; `.env.example` still
matches every env read in `src/` in both directions (17 variables, all
defaults in agreement with the code and the README); every view link and form
action still resolves to an existing route with a matching method; every
`name=` field in every form is still consumed by its route; every enum
`<option>` value is still a member of its allowlist and every badge map still
covers its enum; every CSS class referenced by a template still exists in
`app.css`; the absent-vs-empty partial-update convention, the
transaction-consistent re-checks and the access-scoped list queries are intact
on every update route; the sanitize-html allowlist still has no attribute
wildcard and permits no `script`/`style`/`iframe`; and the login lockout,
password-policy byte cap, session cookie options and CSRF wiring are
unchanged.

### Fixes applied
1. `src/routes/auth.js` — mount `auditMiddleware` on the auth router so
   `req.audit` is defined for every route in the module; GET /profile now
   renders instead of throwing.
2. `src/app.js` — set an explicit `Permissions-Policy` header (helmet v8
   ignores the removed `permissionsPolicy` option) and drop the dead option.
3. `src/app.js` — move the TRACE/TRACK guard after `helmet()`/`morgan()` and
   apply the shared no-store policy to its 405 response.
4. `src/app.js` — extract the no-store header block into
   `_applyNoStoreHeaders()` and reuse it in the global cache-control
   middleware; add an actionable hint to the `SESSION_STORE` load error.
5. `src/constants.js` — correct the stale `SESSION_COOKIE_OPTIONS` comment.
6. `.env.example`, `README.md` — correct the `SESSION_STORE` example and the
   required export shape; correct the seed-output block; document the
   `Permissions-Policy` header in the Security section.

### Regression tests added
- `tests/code_review_370.test.js` — 7 tests against the **real** app stack
  (in-memory SQLite, real session/CSRF, real login): GET /profile returns 200
  for an authenticated admin and no longer contains the `req.audit` TypeError;
  the profile read is recorded in `audit_log`; a structural sweep asserts
  that **no** route module calls `req.audit()` without mounting
  `auditMiddleware` (the class-level guard for defect 1); the TRACE/TRACK 405
  carries the full helmet header set, the `Permissions-Policy` header and the
  no-store policy; a TRACE request still never reaches a route (no audit
  entry, no session cookie); and ordinary responses carry the
  `Permissions-Policy` header.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1461 passed / 1461 total** (92 suites, +7 from #369).
- `npm run test:coverage` — global thresholds pass (statements 71.19%,
  branches 68.38%, functions 81.64%, lines 71.20%).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-20 (371st pass)

An independent pass re-read every route module, both middleware modules,
`app.js`, `utils.js`, `constants.js`, `models/database.js`, `seed.js`, all 39
EJS templates (34 page + 5 partial), `public/js/app.js`, `public/css/app.css`,
`README.md`, `.env.example`, `eslint.config.js`, both jest setup files and the
CI workflow, and re-verified the documented invariants (HPP rejection,
absent-vs-empty partial updates, transaction-consistent rechecks,
`changes === 0` no-op guards, access-scoped list queries, cache invalidation,
ordering determinism, and view-to-route gating). One correctness defect, one
consistency defect and three completeness defects were found and fixed. No new
SQL injection, IDOR, CSRF, XSS, rate-limit or error-leakage defect was found.

1. **The change-log range validation compared datetime *strings* instead of
   *instants*** (MEDIUM, correctness). The update route resolved the
   scheduled/actual start and end and then compared them with a raw `<`:

   ```js
   if (sSchedStart.value && sSchedEnd.value && sSchedEnd.value < sSchedStart.value) {
     throw new Error('SCHEDULED_END_BEFORE_START');
   }
   ```

   The two sides do not necessarily have the same shape. The routes always
   write `"YYYY-MM-DD HH:MM"` (`safeDateTimeLocal`), but the seeder — and any
   row imported from another system, or written by an older build — stores
   `"YYYY-MM-DD HH:MM:SS"`. Lexicographically the shorter prefix sorts
   **first**, so `"2026-05-20 02:00" < "2026-05-20 02:00:00"` is true even
   though both denote the same instant. The range check therefore rejected a
   legitimate update — moving the scheduled end to the same minute as the
   stored scheduled start — with *"Scheduled end must be on or after scheduled
   start"*, and the change was silently **not saved** (reproduced against the
   real app stack: the request bounced back to `/changes/:id/edit` with the row
   untouched). Fix: the comparison now runs at minute precision
   (`_compareDateTimeMinutes()` truncates both sides to 16 characters), so the
   two storage shapes can no longer disagree; and the seeder writes the
   canonical minute format the routes use, so a freshly seeded row is
   indistinguishable from an application-written one.

2. **`DASHBOARD_LIMITS.myTickets` was a dead knob** (LOW, consistency). The
   constants file declares one cap per dashboard widget and states that "the
   dashboard route imports this object so the two can never drift" — the
   template reads `DASHBOARD_LIMITS.myTickets` to decide whether to render the
   `(N+)` truncation marker, but the query that fills that card was capped
   with `DASHBOARD_LIMITS.recentTickets` instead. The two numbers were
   independent: raising `myTickets` alone would have produced a list that is
   truncated but never says so (and lowering it would have cut rows the
   marker still claimed were complete). Fix: the "My Active Tickets" query
   now reads its own knob, `_DASH_MY_TICKETS_LIMIT = DASHBOARD_LIMITS.myTickets`.

3. **Five of the app's 25 rate limiters were missing from the README**
   (LOW, completeness). The Security section enumerates the rate-limit
   budgets, but the list omitted the profile-update limiter (30 / 15 min),
   the ticket quick-status limiter (20 / min), the ticket satisfaction-rating
   limiter (10 / min), the staff reactivation limiter (10 / min) and the
   admin password-reset limiter (20 / 15 min) — an operator reading the
   README could not tell that those endpoints are throttled at all. The
   bullet now lists all of them, and a regression test derives the budgets
   from the `rateLimit({...})` declarations in `src/` and asserts that every
   distinct `max/window` pair appears in the README.

4. **The seeded project windows and task due dates had already drifted into
   the past** (LOW, completeness). The seeder already anchors the ticket due
   date and the scheduled changes to the seed date ("so a fresh seed never
   shows an immediately overdue ticket" / "the Dashboard 'Upcoming Changes'
   panel always has data no matter when the seed runs"), but the five seeded
   projects and their ten tasks still carried hardcoded absolute dates. A
   freshly seeded database therefore showed an `in_progress` project whose
   end date was two months ago, a `planning` project that had started four
   months ago, and five open tasks whose due date had already passed — each
   rendering as "Overdue" — while the statuses claimed otherwise. Fix: the
   project windows and task due dates are now anchored to the seed date
   (`daysAgo()` / `isoDateDaysFromNow()`), preserving the same narrative
   (a project mid-flight, completed tasks in the past, open tasks ahead).

5. **The README claimed the no-store policy applies to "every response"**
   (LOW, documentation precision). The cache-control middleware runs after
   `express.static`, so static assets keep their own headers
   (`Cache-Control: public, max-age=…`) while every dynamic response carries
   `no-store, must-revalidate, private` — verified against a live server
   (`/css/app.css` → `public, max-age=0`, `/login` → `no-store, …`). The
   README now says "every dynamic response (static assets are served by
   `express.static` with their own cache headers)".

Also verified this pass: every write route still rejects HPP array payloads
before any value is consumed; every update transaction still re-reads the row
inside the transaction and throws `NOT_FOUND` on a zero-row write; the
absent-vs-empty convention remains uniform (absent ⇒ preserve, `''` ⇒ clear,
present-but-blank ⇒ fail closed) across tickets, projects, tasks, assets,
vendors, licenses, changes, staff, knowledge and the profile route; every
paginated and capped query still carries a unique trailing `id` tiebreaker;
every list route's access scope still matches its show route (tickets and
assets stay open to all staff, the change log and knowledge base stay scoped,
licenses and vendors stay privileged-only); requester PII is still redacted
for non-privileged viewers on both the show and the edit path; the login
lockout, the CSRF double-submit, the audit allowlists and the
`Cache-Control`/`Permissions-Policy` header set are unchanged; every `name=`
field in every form is still consumed by its route and every view link and
form action still resolves to an existing route; every CSS class referenced
by a template still exists in `app.css`; `.env.example` still documents
exactly the 17 env vars read in `src/`; and a live-app fuzz sweep (814
malformed write payloads across 37 of the app's write routes, plus an
access-control sweep over every show/edit route) produced no 5xx and no
bypass for a non-privileged or manager account.

### Fixes applied
1. `src/routes/changes.js` — the scheduled/actual range checks now compare at
   minute precision (`_compareDateTimeMinutes()`), so a stored value that
   carries a seconds suffix can no longer make a valid update look like
   "end before start"; the helper is exported for unit testing.
2. `src/routes/dashboard.js` — the "My Active Tickets" query is capped with
   `DASHBOARD_LIMITS.myTickets` (the constant the truncation marker reads)
   instead of `DASHBOARD_LIMITS.recentTickets`.
3. `src/seed.js` — change-log datetimes are written in the canonical
   `"YYYY-MM-DD HH:MM"` format the routes use, and the seeded project windows
   and task due dates are anchored relative to the seed date.
4. `README.md` — the rate-limiting bullet now enumerates all 25 limiters, and
   the no-store policy is described as applying to every dynamic response.

### Regression tests added
- `tests/code_review_371.test.js` — 10 tests: the minute-precision datetime
  comparison (unit) plus an end-to-end check that moving a scheduled end to
  the stored start minute is accepted and applied, and that a genuine
  end-before-start update is still rejected; the dashboard's my-tickets cap is
  pinned to `DASHBOARD_LIMITS.myTickets` both structurally and behaviourally
  (the card renders at most N rows and discloses the truncation); the README
  rate-limit budgets are derived from the `rateLimit({...})` declarations in
  `src/` and compared against the documentation; and the seeded portfolio is
  asserted to contain no overdue open task, no status/date contradiction, and
  only canonical minute-format change datetimes.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1471 passed / 1471 total** (93 suites, +10 from #370).
- `npm run test:coverage` — global thresholds pass (statements 71.38%,
  branches 68.55%, functions 82.38%, lines 71.38%).
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.

## Review cycle 2026-10-21 (372nd pass)

An independent pass re-read every route module, both middleware modules, utils,
constants, the schema, the seeder, all 34 EJS templates, `public/js/app.js`
and `public/css/app.css`, plus ESLint, Jest coverage and `npm audit`. The pass
also replayed the seeder against a throwaway in-memory database and asserted
the resulting portfolio against the seed date, which surfaced three seeded-data
contradictions the previous cycle's fix had not covered. Six defects were
found and fixed: one functional inconsistency (the dashboard's two alert
lists), one dependency advisory with a stored-XSS impact (the knowledge base's
sanitizer release) and four smaller correctness/precision issues.

1. **The dashboard loaded two bounded alert lists it never rendered**
   (MEDIUM, consistency/completeness). `src/routes/dashboard.js` queried a
   20-row warranty list (`expiringWarranties`) and a 20-row license list
   (`licenseAlerts`) on every cache refresh, stored both in the shared TTL
   cache, deep-copied them per request and handed them to the template — but
   `views/pages/dashboard.ejs` used only their `.length`, and only as the
   "is there anything to report?" condition for an alert card whose *number*
   came from separate uncapped COUNT queries. Not a single row of either list
   reached the page. Two consequences: the app told the reader "6 assets have
   a warranty ending" without saying which six, and the two
   `DASHBOARD_LIMITS` entries that cap those lists (`warrantyAlerts: 20`,
   `licenseAlerts: 20`) were dead knobs — the constants file promises that
   "the template can disclose the truncation with the same `(N+)` marker the
   staff profile sidebars use", but no list existed that could disclose
   anything. This is the same dead-knob class the previous cycle closed for
   `DASHBOARD_LIMITS.myTickets`. Fix: the dashboard now renders both lists
   with the `(N+)` marker wired to the very cap the query uses, so the caps are
   live and the reader can act on the rows.

   The license list is additionally **viewer-scoped**: the licenses module is
   `requireAdminOrManager` (its list and show routes are, because license
   cost/seat data is business-sensitive), so the software names must not be
   handed to a regular staff member's dashboard. The list therefore moved out
   of the shared (all-users) cache into a per-request query gated on
   `isPrivileged(user)` — exactly the pattern the "Upcoming Changes" widget
   already used for the same reason. The bare COUNT stays in the shared cache
   (it carries no license identity), and the alert cards now key their
   "is there anything to report?" condition on that uncapped count instead of
   on the capped list length. The warranty list stays in the shared cache
   because the assets module is open to every authenticated viewer.

2. **A seeded task was due a month after its own project had ended** (LOW,
   correctness). The previous cycle anchored the seeded project windows and
   task due dates to the seed date, but the anchor was applied per field and
   not per constraint: "Staff training" (project 3, "IT Service Desk
   Upgrade", whose window ends 30 days out) was still anchored 60 days out, so
   a fresh seed rendered a task due 2026-12-19 inside a project that ended
   2026-11-19 — the project page showed an open task that could not be
   finished in time, and the seeded portfolio contradicted itself. Fix: the
   due date moved inside the window (25 days out), and every seeded task due
   date now sits between its owning project's start and end date.

3. **Every seeded license had already expired and three of five vendor
   contracts had already ended** (LOW, correctness/completeness). The same
   "hardcoded absolute dates drift into the past" defect the previous cycle
   closed for the ticket due date, the project windows and the task due dates
   was still present in the license and vendor rows: all five seeded
   licenses that carry an expiry date had expired between 2025-07-01 and
   2026-03-01, so the dashboard's "License Expiring Soon" alert (a 30-day
   window) could only ever report long-expired records — the case it names
   was never represented — and the license list showed an entirely dead
   subscription portfolio. Three of the five vendor contracts had likewise
   lapsed, leaving no running contract at all. Fix: the license terms and
   vendor contract windows are anchored to the seed date (the shared date
   helpers moved to the top of the seed transaction so every section can use
   them in any order). Each subscription keeps its ~1-year story, two of them
   now expire *inside* the 30-day alert window so a fresh seed exercises that
   path, four vendors hold a live contract and one keeps a recently-ended
   contract so the "contract lapsed" state is still represented. The seeded
   *asset* fleet deliberately keeps its absolute purchase/warranty history —
   the age-distribution report depends on that spread, and the dashboard
   warranty alert says "expired **or** expiring within 30 days".

4. **The change-log create route used a second, different comparison rule**
   (LOW, consistency). The update route compares the scheduled/actual windows
   with the minute-precision `_compareDateTimeMinutes()` helper (added in the
   previous cycle to stop "2026-05-20 02:00" < "2026-05-20 02:00:00" from
   rejecting a valid update), while the create route still compared the two
   canonical strings with a raw `<`. Both are correct today — the create path
   canonicalises both values through `safeDateTimeLocal` — but two subtly
   different rules for the same validation inside one module is exactly the
   drift the shared helper exists to prevent, and the create path is the one
   the next format change would break. Fix: the create route uses the same
   helper.

5. **The knowledge base ran a sanitizer release with three known bypasses**
   (MEDIUM, security). The knowledge-base article body is rendered with
   `<%- article.renderedContent %>` — deliberately UNESCAPED, because
   `sanitize-html` is what vets it. The pinned release, `sanitize-html@2.17.7`,
   carries three published advisories, all of them stored-XSS vectors in
   exactly that context: a `<noscript>` region whose implied close ends the
   tag early (letting the following markup through), an SMIL
   namespace-prefix bypass that smuggles a `javascript:` URI past the scheme
   allowlist, and a `meta http-equiv=refresh` whose `content` still ships
   `javascript:`/`data:` URLs. The repo's own tooling line
   (`npm audit --omit=dev --audit-level=high`) did not surface them — the
   advisories are rated *moderate*, so a high-severity audit run reported
   "0 vulnerabilities" while the vulnerable code was live. Fix: the
   dependency now resolves to the patched `sanitize-html@2.18.1` (verified
   against the real library, not the Jest mock: the `<noscript>`, SMIL and
   `meta`-refresh vectors are now neutralised, and the app's own allowlist
   extension — `img`, `details`, `summary`, `del` — is unchanged), and
   `npm audit --omit=dev` now reports 0 vulnerabilities at any severity.

6. **The asset report advertised a period it does not filter by** (LOW,
   documentation precision). `views/pages/reports/assets.ejs` rendered "No
   data for this period" in four empty states, but the asset report is not
   period-scoped: none of its queries (`assetsByCategory`, `assetsByStatus`,
   `assetsByCondition`, `assetsTotalValue`, `warrantyExpiring*`,
   `ageDistribution`) take a window, and the page has no period selector
   (only the ticket and staff reports do). The empty states now use
   period-neutral copy. The route's array-valued-parameter guard was
   deliberately left in place — it is the app-wide convention for GET routes
   and is pinned by an existing regression test.

Also verified this pass: every write route still rejects HPP array payloads
before any value is consumed, and every update/delete transaction still
re-reads its row inside the transaction and throws `NOT_FOUND` on a zero-row
write; the absent-vs-empty convention remains uniform (absent ⇒ preserve,
`''` ⇒ clear, present-but-blank ⇒ fail closed) across tickets, projects,
tasks, assets, vendors, licenses, changes, staff, knowledge and the profile
route; every paginated and capped query still carries a unique trailing `id`
tiebreaker and clamps an out-of-range page to the last one; every list route's
access scope still matches its show route (tickets and assets stay open to
all staff, the change log and knowledge base stay scoped, licenses and
vendors stay privileged-only); requester PII is still redacted for
non-privileged viewers on both the show and the edit path; the dashboard's
"Upcoming Changes" widget is still viewer-scoped and never served from the
shared cache; every `name=` field in every form is still consumed by its
route and every view link and form action still resolves to an existing
route; every CSS class referenced by a template still exists in `app.css`;
`.env.example` still documents exactly the env vars read in `src/`; and the
seeded portfolio was re-checked against the seed date for overdue open tasks,
project/status contradictions, out-of-window task due dates, expired
licenses, lapsed contracts and canonical change-log datetime formats.

### Fixes applied
1. `src/routes/dashboard.js` — the license alert list is queried per request
   for privileged viewers only and removed from the shared TTL cache; the
   alert-card conditions now key on the uncapped counts.
2. `views/pages/dashboard.ejs` — renders the "Warranty Ending or Expired" and
   "Licenses Ending or Expired" lists, each disclosing its truncation with the
   `(N+)` marker bound to `DASHBOARD_LIMITS.warrantyAlerts` /
   `DASHBOARD_LIMITS.licenseAlerts`; the license list is rendered for
   privileged viewers only.
3. `src/constants.js` — the `DASHBOARD_LIMITS` comment now states that the
   license-alert list is privileged-only and the warranty-alert list is open
   to every viewer.
4. `src/seed.js` — the shared date helpers moved to the top of the seed
   transaction; the license terms and vendor contract windows are anchored to
   the seed date; the "Staff training" due date moved inside its project's
   window.
5. `src/routes/changes.js` — the create route compares the scheduled window
   with the shared minute-precision helper.
6. `package.json` / `package-lock.json` — `sanitize-html` bumped to the
   patched `^2.18.1` (was `^2.17.7`); `src/routes/knowledge.js` — the
   "package failed to load" diagnostics now name the patched version.
7. `views/pages/reports/assets.ejs` — period-neutral empty-state copy.
8. `tests/code_review_166.test.js` — the empty-hint probe now pins the
   period-neutral wording (the assertion's intent — "every section renders an
   empty hint" — is unchanged).

### Regression tests added
- `tests/code_review_372.test.js` — 15 tests: the dashboard renders the
  warranty alert list rows and discloses the truncation at
  `DASHBOARD_LIMITS.warrantyAlerts`; the license alert list is rendered for an
  admin but its software names never reach a staff viewer (while the bare
  count still does); the license list is absent from the shared cached
  payload and privilege-gated at the query site; the seeded portfolio has no
  task due outside its project's window, no already-expired license, at least
  one license inside the 30-day alert window, and coherent vendor contracts
  with at least one still running; the change-log create route uses the
  minute-precision comparison and still accepts an equal start/end while
  rejecting an end before the start; the asset report uses period-neutral
  empty-state copy; and the knowledge-base sanitizer is pinned and locked to
  a patched `sanitize-html` release with only inert tags added to the
  allowlist.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1486 passed / 1486 total** (94 suites, +15 from #371).
- `npm run test:coverage` — global thresholds pass (statements 71.92%,
  branches 69.39%, functions 83.38%, lines 71.92%).
- `npm audit --omit=dev` — **0 vulnerabilities** (previously 1 moderate
  `sanitize-html` advisory, now patched).

## Review cycle 2026-10-21 (373rd pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, the schema, the seeder, every EJS view and
`public/js/app.js`, plus ESLint, Jest, coverage and `npm audit`) surfaced
fourteen real defects. The most serious was a **secret disclosure in the
license show page**: the view rendered `****` + the last four characters of
the license key, so every admin/manager page view shipped part of the secret
in the HTML body — outside the audited and rate-limited
`POST /licenses/:id/key` reveal path, and in direct contradiction of the
app-wide rule recorded in the 99th pass ("no partial-key preview is ever
rendered server-side or client-side"). The rest were consistency and
completeness defects in the app's own partial-update contract, one session
control that could be reset at will, two content oracles and a handful of
silently-discarded fields.

1. **The license show page disclosed the last four characters of the key**
   (MEDIUM, security — fixed). `src/routes/licenses.js` selected
   `license_key` for the show route and `views/pages/licenses/show.ejs`
   rendered `'****' + license_key.slice(-4)`. The reveal endpoint
   (`POST /licenses/:id/key`) is audited and capped at 20 per 15 min
   precisely because it is the module's anti-exfiltration control; the
   server-rendered preview bypassed both, and put the partial secret into
   the response body, the bfcache and any intermediary. The edit route
   already refused to hand the plaintext to its template, the list route
   omitted the column, and the dashboard avoided `SELECT *` for the same
   reason — the show route was the only one that broke the rule. Fix: a
   dedicated `_licenseShowStmt` never selects the column and exposes a
   `has_license_key` flag instead; the show, edit and delete paths use it,
   and the template renders the same `****` token the client-side mask
   emits. The plaintext statement is now reachable only from the update
   transaction (which genuinely needs the stored key to preserve it) and
   from the audited reveal endpoint.

2. **`clear_key` silently discarded a simultaneously submitted key**
   (LOW/MEDIUM, correctness — fixed). The edit form offers the new-key
   input and the "clear key" checkbox side by side, so ticking both is a
   natural action; the clear flag won unconditionally, the typed key was
   thrown away, and the route flashed "License updated." Fix: the
   contradictory combination is rejected with an explicit error.

3. **A whitespace-only `tags` value wiped the stored article tags**
   (MEDIUM, consistency — fixed). `src/routes/knowledge.js` trimmed the
   field *before* the absent/present test, so `'   '` became `''`, was
   normalized to `NULL`, and the route flashed "Article updated." The
   knowledge base was the only optional text field in the app that did not
   use `resolveOptionalField`, whose documented rule is that a
   present-but-blank value is rejected (it is neither an absent field nor
   an explicit clear). Fix: the field is resolved through the shared helper
   inside the transaction, so absent ⇒ preserve, `''` ⇒ clear and
   blank ⇒ rejected.

4. **The required primary columns rejected partial updates** (MEDIUM,
   consistency — fixed). `PUT /projects/:id` demanded a project name,
   `PUT /changes/:id` a title and a change type, and `PUT /knowledge/:id` a
   title, content and category — while every *other* field on those same
   routes implemented the documented "absent ⇒ keep what's stored" rule and
   the routes' own comments stated it. A client that PATCHed a single field
   had to resend the whole entity. Fix: the required columns are now
   resolved from the transaction-consistent row when absent, exactly like
   the optional ones; a present-but-empty value is still rejected. The
   convention is now uniform across the app and is documented in the
   README.

5. **The profile route reset the hard session-lifetime cap** (MEDIUM,
   security — fixed). `PUT /profile` regenerates the session to defeat
   fixation, but `session.regenerate()` replaces `req.session` with a new
   object that carries only the cookie — the `sessionStart` / `lastAccess`
   anchors the timeout middleware uses are dropped with it. The documented
   `SESSION_ABSOLUTE_TIMEOUT_SECONDS` cap (8 h by default) therefore
   restarted on every routine profile save, so a session could be kept
   alive indefinitely by saving a page. Fix: the anchors are carried across
   the regeneration — a profile save is the same authentication, not a new
   one. A genuine re-authentication (login, password change) still starts a
   fresh window, as documented.

6. **The profile route was not a partial-update route** (LOW,
   consistency — fixed). `first_name` / `last_name` / `email` were required
   on every save while the sibling `phone` field on the same route
   preserved the stored value when absent. Fix: the three fields now
   resolve against the current row (absent ⇒ preserve, present-but-empty ⇒
   "required" error).

7. **The logout HPP guard was dead code** (LOW, correctness — fixed). It
   called `rejectHppArrays(req, [])`, and the helper iterates the field
   list — so the guard could never fire, while its comment claimed it was a
   fail-closed regression-proofing measure. Fix: the guard now checks every
   body key.

8. **The ticket create route accepted a status it never read** (LOW/MEDIUM,
   consistency — fixed). `status` appeared in the create route's HPP
   allowlist and in its present-but-non-string type guard, but was never
   read, never validated and never inserted — the column took its schema
   default, so a submitted status was silently discarded and the ticket was
   always created `open`, while the same route rejected an invalid
   `category`. Fix: the submitted status is validated against
   `TICKET_STATUSES` and applied (default `open`), and a ticket created
   directly in a terminal state gets a `resolved_at` timestamp, exactly like
   the update route's `resolved_at` CASE expression.

9. **The ticket and asset list searches were content oracles** (MEDIUM,
   security — fixed). The searches matched `t.description` and
   `a.serial_number`, which are shown exclusively on the detail pages —
   and those pages are access-gated, so a staff viewer denied
   `GET /tickets/:id` could confirm that a phrase occurred in a
   description they are not allowed to read. Same defect class the
   change-log list closed in an earlier pass. Fix: the searches cover only
   the columns the list itself renders.

10. **The capped Related-Asset dropdown had no tiebreaker** (LOW,
    consistency — fixed). `ORDER BY name LIMIT 1000` over a table with
    duplicate names is not a total order, so the option set could differ
    between two page loads and an option the user had seen could vanish on
    refresh. Every other capped query in the app carries a unique trailing
    `id`; this one now does too.

11. **An absent staff role was rejected as invalid** (LOW, consistency —
    fixed). `PUT /staff/:id` resolved the role with `trim(req.body.role)`,
    so an absent role collapsed to `''`, failed the `USER_ROLES` check and
    rejected the whole request with "Invalid Role" — while the sibling
    optional fields on the same form (department, phone) correctly
    preserved the stored value. Fix: the role follows the same
    absent-vs-present rule, and every guard (privileged-role assignment,
    self-role change) evaluates the *effective* role.

12. **The staff directory handed every viewer every username** (LOW,
    consistency — fixed). The route redacts `email`, `phone`, `department`,
    `last_login` and `avatar` for non-privileged viewers — precisely so a
    future template change cannot revive a column — but left the `username`
    (the login identifier) in the render context even though the directory
    never renders it. Fix: the username joins the redaction list.

13. **The dashboard's truncation markers claimed a truncation that did not
    exist** (LOW, correctness — fixed). The warranty and license alert
    headers appended `+` when the rendered list length was `>=` the cap —
    but for these two lists the exact count is already in the render
    context, so a list holding exactly as many rows as the cap is complete
    and was still marked as truncated. Fix: the marker compares the
    rendered length against the exact count.

14. **The seeded tickets and the staff report were incoherent** (LOW,
    completeness — fixed). Seeded tickets took `updated_at` from the schema
    default (the seed moment), i.e. *after* their own resolution
    timestamp, so a resolved ticket read as "Updated <after> Resolved
    <before>" and every seeded ticket looked "just updated" in the
    recently-active list. The staff performance report silently truncated
    its list at 200 rows with no disclosure, while every other capped list
    in the app discloses its cap — and the sort (`resolved_tickets DESC`)
    drops the staff with the fewest resolutions first, which are often
    exactly the people carrying the high open-ticket workload the report
    exists to surface. Fix: the seeder sets `updated_at` explicitly, and
    the report discloses "Showing the top N of M active staff".

### Fixes applied
1. `src/routes/licenses.js` — dedicated key-free `_licenseShowStmt` for the
   show/edit/delete paths; the plaintext statement is used only by the
   update transaction and the audited reveal endpoint; `clear_key` combined
   with a submitted key is rejected.
2. `views/pages/licenses/show.ejs` — renders the `****` mask (never a
   partial preview) and uses the shared `usagePercent()` helper for the
   seat figure, matching the list page.
3. `src/routes/knowledge.js` — the tags field is resolved through
   `resolveOptionalField`; the required columns (title / content / category)
   are absent-preserving.
4. `src/routes/projects.js` — the project name is absent-preserving
   (resolved from the in-transaction re-read).
5. `src/routes/changes.js` — the title and change type are absent-preserving.
6. `src/routes/auth.js` — the session anchors survive the profile-update
   regeneration; the three required profile fields are absent-preserving;
   the logout HPP guard checks every body key.
7. `src/app.js` — the session-timeout comment records that the profile route
   preserves the anchors while login/password-change start a fresh window.
8. `src/routes/tickets.js` — the create route applies a submitted status
   (and stamps `resolved_at` for a terminal status); the description is no
   longer searchable; the asset dropdown query has an `id` tiebreaker.
9. `src/routes/assets.js` — the serial number is no longer searchable.
10. `src/routes/staff.js` — an absent role preserves the stored role; the
    username joins the non-privileged redaction list.
11. `views/pages/dashboard.ejs` — the two truncation markers use the exact
    counts already in the render context.
12. `src/seed.js` — seeded tickets set `updated_at` explicitly.
13. `src/routes/reports.js` + `views/pages/reports/staff.ejs` — the staff
    report discloses its 200-row cap.
14. `README.md` — documents the license-key disclosure control and the
    app-wide partial-update (PUT) convention.
15. `tests/templates.test.js`, `tests/code_review_163.test.js`,
    `tests/code_review_204.test.js`, `tests/code_review_208.test.js`,
    `tests/code_review_368.test.js` — the source/template pins that encoded
    the old behaviour were updated to the corrected contract (the license
    mask assertion, the knowledge tags resolution, the knowledge import
    list, the staff self-role guard, and the license edit-route fixture).

### Regression tests added
- `tests/code_review_373.test.js` — 22 tests, all verified to FAIL against
  the pre-fix tree: the license show page ships no partial key and the
  show/edit statements never select the column; setting and clearing the
  key at once is rejected and the stored key survives; a whitespace-only
  tags value is rejected and the stored tags survive; the knowledge,
  project and change required columns are preserved when absent; the
  profile route preserves the stored name/email and the session anchors
  across the regeneration; a polluted logout body is rejected; a submitted
  ticket status is applied (with a resolution timestamp) while an invalid
  one is rejected and an absent one still defaults to `open`; the ticket
  description and the asset serial number are not searchable; the asset
  dropdown query has the `id` tiebreaker; an absent staff role preserves
  the stored role while an invalid one is still rejected; the directory
  redacts other users' usernames; the dashboard does not claim a
  truncation for a complete list; the seeded tickets' `updated_at` never
  postdates their resolution; and the staff report discloses its cap.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1508 passed / 1508 total** (95 suites, +22 from #372).
- `npm run test:coverage` — global thresholds pass (statements 72.41%,
  branches 70.37%, functions 84.01%, lines 72.41%).
- `npm audit --omit=dev --audit-level=high` — **0 vulnerabilities**.

## Review cycle 2026-10-21 (374th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, the schema, the seeder, every EJS view and
`public/js/app.js`, plus ESLint, Jest, coverage and `npm audit`) surfaced
six defect classes. The most consequential was a **contract violation the
README itself documents**: the app-wide partial-update (PUT) rule — "a field
absent from the request preserves the stored value" — was implemented for
every *optional* field of every PUT route, but six routes still rejected a
partial submission outright because of a *required* column. The rest were a
twelve-site inconsistency in the truncation disclosure, three audit trails
that named the wrong entity, and two labels that asserted facts the record
does not carry.

1. **Six PUT routes still rejected partial updates over their required
   columns** (MEDIUM, consistency — fixed). `PUT /tickets/:id` demanded a
   title, `PUT /assets/:id` a tag/name/category, `PUT /vendors/:id` a name,
   `PUT /licenses/:id` a software name, `PUT /staff/:id` an
   email/first/last name and `PUT /projects/:p/tasks/:t` a task title — while
   every *other* field on the same routes (and every required column of the
   project, change, knowledge and profile routes) implemented the documented
   "absent ⇒ preserve" rule. A client that submitted a single field had to
   resend the whole entity, and the ticket route was internally inconsistent:
   its sibling `requester_name` was already absent-preserving. The README
   claimed the contract was app-wide. Fix: every required column is now
   resolved from the transaction-consistent row when the field is absent, and
   a *present but empty* value is still rejected (the columns are `NOT NULL`,
   so an empty value has no valid meaning) — nothing is written on rejection.

2. **Twelve "(N+)" markers claimed truncations that did not exist** (LOW,
   consistency — fixed). The marker compared the rendered length against the
   cap with `>=`, so a list holding exactly as many rows as its cap — i.e. a
   *complete* list — was still marked as truncated. The 373rd pass had
   already replaced that heuristic with an exact count on the two dashboard
   lists that had an uncapped count available (and the two report pages
   disclose their cap as "Showing the top N of M"), but the remaining twelve
   markers kept the approximation. The dashboard's "Team Workload" card was
   the worst case: its query is always `LIMIT 8` over the whole active
   roster, so any organisation with eight or more staff permanently rendered
   "Team Workload (8+)" whether or not anything was cut. Fix: every capped
   query now fetches one row beyond its cap (the truncation probe) and a
   shared `capList()` helper turns the probe into an exact `truncated` flag,
   which the templates render. A list at exactly the cap is complete and is
   no longer marked.

3. **Three audit trails named the submitted value instead of the effective
   one** (LOW, correctness — fixed). A partial knowledge-article update
   audited `Updated article ""` (the submitted — absent — title, not the
   stored one); the same class of defect applied to the asset, vendor and
   licence audit details, which named an empty tag/name when the field was
   omitted. Fix: the effective value is hoisted out of the update
   transaction (the same pattern the change and ticket routes already use)
   and named in the audit entry.

4. **A licence with no expiry date was labelled "Perpetual" whatever its
   type** (MEDIUM, correctness — fixed). `licenses.expiry_date` is nullable
   and the create route stores a NULL type, so a *subscription* whose renewal
   date simply was not recorded rendered "Expiry Date: Perpetual" next to
   "Type: Subscription" — a false claim on the very page used to chase
   renewals. Fix: "Perpetual" is now rendered only for a licence whose type
   is perpetual; every other type with no expiry renders "-" (the unset
   type keeps the badge fallback pass 175 established).

5. **The dashboard's alert cards contradicted their own counts** (LOW,
   documentation precision — fixed). The warranty and licence alert cards
   were headed "Expiring Soon" while the counts they report *include*
   already-expired records (`warranty_expiry <= date('now', '+30 days')`) —
   the same page's list cards were already correctly headed "Ending or
   Expired", and the body copy said "expired or expiring". Fix: the alert
   headings now match the counts and the list cards.

6. **Three empty states invited a record the viewer cannot create** (LOW,
   consistency — fixed). The assets, projects and changes lists are open to
   every authenticated user, but their empty states said "Add your first
   asset / Create your first project / Add your first change" — an action
   the UI hides and the route rejects for a regular staff member. Fix: the
   create hint is shown to privileged viewers only; everyone else gets the
   filter-neutral wording the staff directory already uses.

### Fixes applied
1. `src/routes/tickets.js` — the ticket title is absent-preserving (and a
   present-but-non-string title is rejected); the update statement re-reads
   the title inside the transaction.
2. `src/routes/assets.js` — the asset tag, name and category are
   absent-preserving; the update reads them from the re-read row.
3. `src/routes/vendors.js` — the vendor name is absent-preserving; the
   duplicate-name check and the license-reference sync use the resolved
   name.
4. `src/routes/licenses.js` — the software name is absent-preserving.
5. `src/routes/staff.js` — the email, first name and last name are
   absent-preserving; the re-read statement now carries the three columns
   the update resolves.
6. `src/routes/projects.js` — the task title is absent-preserving.
7. `src/routes/tickets.js`, `assets.js`, `vendors.js`, `licenses.js`,
   `staff.js`, `projects.js`, `knowledge.js` — the audit details name the
   effective entity, not the (absent) submitted value.
8. `src/utils.js` — new `capList(rows, cap)` helper: slices a capped query
   result and reports whether rows were really dropped.
9. `src/routes/dashboard.js`, `assets.js`, `projects.js`, `staff.js`,
   `tickets.js` — every capped query fetches one row beyond its cap, and the
   routes pass the exact `*Truncated` flag to their template.
10. `views/pages/dashboard.ejs`, `assets/show.ejs`, `projects/show.ejs`,
    `staff/show.ejs`, `tickets/show.ejs` — the twelve "(N+)" markers are
    driven by the exact flag.
11. `views/pages/licenses/index.ejs`, `licenses/show.ejs` — the expiry cell
    says "Perpetual" only for a perpetual licence.
12. `views/pages/dashboard.ejs`, `reports/assets.ejs` — the expired-inclusive
    alerts are headed accordingly.
13. `views/pages/assets/index.ejs`, `projects/index.ejs`, `changes/index.ejs`
    — the create hint is shown to privileged viewers only.
14. `README.md` — documents that *every* required column follows the
    absent-preserves rule, and documents the exact truncation disclosure.

### Regression tests added
- `tests/code_review_374.test.js` — 27 tests, 22 of them verified to FAIL
  against the pre-fix tree: the six routes preserve their required columns
  when the field is absent and reject a present-but-empty value without
  writing anything; the article, asset and licence audit entries name the
  effective entity; a complete dashboard ticket list, related-ticket list
  and comment list are not marked as truncated while an over-cap list is;
  a subscription without an expiry date is not called "Perpetual" (and a
  perpetual one still is); the dashboard alert cards carry the
  expired-inclusive wording; and the empty states do not offer a create
  action to a viewer who cannot create records.
- `tests/utils.test.js` — 5 unit tests for the new `capList()` helper.

### Existing tests updated
- `tests/code_review_369.test.js` — the two "capped list" cases now drive
  the marker with the exact truncation flag (and a new case asserts that a
  complete list is NOT marked).
- `tests/code_review_371.test.js` — the structural pin now asserts that the
  my-tickets query is capped by the *same* constant plus the one-row
  truncation probe.
- `tests/code_review_372.test.js` — the "no license identities for a staff
  viewer" probe now targets the list card's row count instead of the
  heading text, which the alert card shares.
- `tests/code_review_163.test.js`, `tests/code_review_368.test.js` — the
  staff re-read statement now selects the three additional columns the
  update route resolves.

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1542 passed / 1542 total** (96 suites, +34 from #373).
- `npm run test:coverage` — global thresholds pass (statements 72.72%,
  branches 71.50%, functions 84.06%, lines 72.72%).
- `npm audit --omit=dev` — **0 vulnerabilities**.

## Review cycle 2026-10-21 (375th pass)

An independent pass (full re-read of all 12 route modules, both middleware
modules, utils, constants, the schema, the seeder, every EJS view and
`public/js/app.js`, plus ESLint, Jest, coverage and `npm audit`) surfaced
four defect classes. The most consequential was the **last silent truncation
in the app**: the ticket report's "Top Resolvers" card is capped at ten rows
and said nothing about it, so a period with fourteen resolvers rendered ten
names under a heading that implied completeness — while every other capped
list in the app discloses its cap.

1. **The ticket report's "Top Resolvers" card truncated silently** (LOW,
   display/consistency — fixed). `reports.js` caps the card's list at
   `LIMIT 10`, but the page rendered no disclosure at all: no `(N+)` marker
   and no "of M" total. The other two report pages already disclose their
   caps — the asset report's warranty list ("Showing the soonest N of M
   assets.") and the staff report's roster ("Showing the top N of M active
   staff."), the latter added by pass 373 — and the dashboard discloses every
   capped card with an exact `(N+)` marker (pass 374). The resolver card was
   the only bounded list in the app that looked complete when it was not.
   Fix: the route now also computes the uncapped number of distinct
   resolvers for the period and the page discloses the slice
   ("Showing the top 10 of 12 resolvers."), exactly like its two sibling
   report pages. The list itself is unchanged.

2. **The dashboard's alert-list "(N+)" markers depended on a second,
   differently-cached query** (LOW, correctness — fixed). The warranty and
   licence alert lists derived their marker by comparing the rendered length
   against the *uncapped count* — a second query. For the warranty list the
   two always came from the same place (both live in the shared 30-second
   TTL cache), so the comparison was exact. For the licence list they did
   not: the list is deliberately fetched PER REQUEST (the licenses module is
   admin/manager-only, so the software names must not enter the shared
   payload) while `licenseAlertsCount` comes from that shared cache. The
   marker could therefore be wrong in BOTH directions — it claimed a
   truncation that did not exist when a licence was deleted or renewed
   inside the cache window, and it HID a real truncation when a licence was
   created inside it (the capped length equalled the stale count, so
   `length < count` was false). Fix: both alert lists now fetch one row
   beyond their cap — the truncation probe the other four dashboard lists
   already use — and the route turns that probe into the exact
   `expiringWarrantiesTruncated` / `licenseAlertsTruncated` flags the
   template renders. The uncapped counts are unchanged and still feed the
   alert CARDS, which report a number rather than a list.

3. **Every seeded asset warranty had already expired, and none exercised
   the "expiring soon" path** (LOW, seed data — fixed). The dashboard's
   "Warranty Ending or Expired" alert (a 30-day window) and the asset
   report's 90-day warranty list are the app's two warranty-expiry
   surfaces, and the seeded asset purchase/warranty dates were hardcoded
   absolutes: eight of the twelve seeded warranties had already expired and
   NONE expired inside the 30-day window, so the "expiring soon" case the
   alert names was never represented. This is the same defect pass 372
   closed for the seeded licence terms ("every seeded license that carried
   an expiry date had already expired … the 'expiring soon' case it names
   was never represented"). Fix: the seeded asset purchase dates and
   warranty expiries are now anchored to the seed date through a new
   `assetTerm(daysAgoPurchased, daysUntilWarrantyEnd)` helper — the same
   convention the licence terms, the vendor contract windows, the project
   windows and the ticket due date already use. The seeded fleet now carries
   live warranties, one warranty expiring inside the 30-day alert window,
   one inside the 90-day report window, and a few genuinely expired ones,
   with the warranty always at or after the purchase (the ordering the
   asset routes enforce).

4. **The README advertised a `clear` control that does not exist** (LOW,
   documentation — fixed). The partial-update section said "the dedicated
   `clear_key` / `clear` controls clear the fields where an empty string is
   not a valid value". There is no `clear` control anywhere in the app: the
   magic `_CLEAR_` sentinel it referred to was replaced by the licence
   form's `clear_key` checkbox in an earlier pass, and the only
   clear-style control in the whole template tree is that checkbox. The
   README now documents the control that actually exists (and what it does
   when combined with a typed key).

Also verified this pass: the app-wide partial-update contract now holds for
EVERY field of EVERY `PUT` route, including every required column (the
374th pass's fix re-checked field by field against the transaction-consistent
re-read); every write route still rejects HPP arrays before any value is
consumed, and every body field a route reads is covered by its route's HPP
allowlist; every form field in every view is consumed by its route, and the
`actual_start` / `actual_end` inputs are correctly edit-only (the change-log
create route does not accept them); the search surface of every list route
still matches the columns that list renders (no content oracle); the
audit action/entity allowlists still cover every call site; the requester-PII
redaction, the licence-key masking, the session timeout anchors, the
rate-limiter inventory in the README and `.env.example` are all unchanged and
still accurate.

### Fixes applied
1. `src/routes/reports.js` — new `topResolversCount` statement (the uncapped
   number of distinct resolvers for the period); the ticket report route
   computes it and passes `resolverCount` to the template.
2. `views/pages/reports/tickets.ejs` — the "Top Resolvers" card discloses the
   truncation ("Showing the top N of M resolvers.").
3. `src/routes/dashboard.js` — the warranty and licence alert-list queries
   fetch one row beyond their cap (the truncation probe); the route derives
   the exact `expiringWarrantiesTruncated` / `licenseAlertsTruncated` flags
   from that probe (`capList`) and passes them to the template.
4. `views/pages/dashboard.ejs` — both alert-list "(N+)" markers are driven by
   the exact flags instead of a comparison against the separately-cached
   count.
5. `src/seed.js` — new `assetTerm()` helper; every seeded asset's purchase
   date and warranty expiry is anchored to the seed date.
6. `README.md` — the partial-update section documents the `clear_key` control
   that exists (and the conflict it rejects) instead of the phantom `clear`
   control; the list-cap section names the three report-page disclosures.
7. `CODE_REVIEW.md` — the header block still advertised "373rd pass / 372
   consecutive hardening reviews" (the 374th pass appended its cycle but did
   not refresh the header); it now names the current pass.

### Regression tests added
- `tests/code_review_375.test.js` — 12 tests, 6 of them verified to FAIL
  against the pre-fix tree: the resolver card discloses its truncation when
  12 resolvers exceed the 10-row list and stays silent when the list is
  complete; the uncapped resolver count is exposed by the route; the licence
  alert list drops its "(+)" marker when the list becomes complete inside
  the cache window (the stale-count case) and gains it when a licence
  appears inside that window (the hidden-truncation case); both alert
  markers are pinned to the exact truncation flags; the seeded fleet never
  expires a warranty before its purchase date, always carries one warranty
  inside the 30-day alert window, and always keeps at least one live
  warranty; the app's only clear control is `clear_key`, and the README
  documents that control and no phantom one.

### Existing tests updated
- `tests/reports.test.js` — the two "alert counts are uncapped while lists
  stay capped" cases now expect `cap + 1` rows: the alert lists fetch one
  row beyond the cap (the truncation probe), so the list is bounded at 21
  rows instead of 20. The counts are unchanged (the true, uncapped totals).

### Tooling
- `npm run lint` — clean (exit 0).
- `npm test` — **1554 passed / 1554 total** (97 suites, +12 from #374).
- `npm run test:coverage` — global thresholds pass (statements 72.75%,
  branches 71.50%, functions 84.11%, lines 72.74%).
- `npm audit --omit=dev` — **0 vulnerabilities**.
