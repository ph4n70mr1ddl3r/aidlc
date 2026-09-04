# Code Review Notes

**Date:** 2026-09-04
**Scope:** Full-stack Express.js + better-sqlite3 IT Department Manager app
(`src/`, `tests/`). 12 route modules, 2 middleware modules, models, utils, constants.
**Method:** Manual line-by-line review of all source files plus ESLint and the
Jest suite. Prior review history (168 consecutive hardening commits) was
cross-checked to confirm findings were not already addressed.

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
modules, utils, constants, models, seed, all 34 EJS views, `public/css/app.css`,
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
