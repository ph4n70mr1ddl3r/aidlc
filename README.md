# IT Department Manager

Enterprise IT Department Management Application — a full-stack web app for managing IT operations including tickets, assets, licenses, projects, staff, vendors, knowledge base, and change logs.

## Features

- **Dashboard** — Real-time overview of tickets, assets, projects, and alerts
- **Ticket Management** — Full lifecycle (open → resolved) with comments, priorities, categories, and assignments
- **Asset Tracking** — Hardware/software inventory with warranty tracking, assignment, and condition monitoring
- **Software Licenses** — License keys, seat management, expiry alerts, and cost tracking
- **Project Management** — Projects with tasks, team members, budgets, and progress tracking
- **Staff Directory** — User management with RBAC (admin/manager/staff), workload views
- **Vendor Management** — Vendor contacts, contracts, and ratings
- **Knowledge Base** — Markdown articles with categories, tags, and full-text search
- **Change Log** — Scheduled changes with status tracking and impact assessment
- **Reports** — Ticket analytics, asset reports, and staff performance metrics
- **Audit Log** — Tracks all create/update/delete actions with user, timestamp, and IP

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express 4 |
| Database | SQLite (better-sqlite3, WAL mode) |
| Templates | EJS |
| Auth | Session-based with bcryptjs + CSRF protection |
| Security | Helmet, rate limiting, CSP, httpOnly cookies |

## Prerequisites

- Node.js >= 20
- npm >= 8

## Quick Start

```bash
# Clone the repository
git clone https://github.com/ph4n70mr1ddl3r/aidlc.git
cd aidlc

# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Edit .env and set strong SESSION_SECRET and CSRF_SECRET for production

# Seed the database with sample data (SEED_VERBOSE=1 prints the generated passwords)
SEED_VERBOSE=1 npm run seed

# Start the server
npm start
```

Open http://localhost:3000 in your browser.

### Seed / Login Credentials

`npm run seed` does **not** use fixed default passwords. It generates strong
random passwords (one for the admin account, one shared by the manager/staff
accounts), hashes them with bcryptjs before storing, and does **not** print them
by default. To display the generated passwords, run the seed with
`SEED_VERBOSE=1`:

```bash
SEED_VERBOSE=1 npm run seed
```

```
Default login credentials:
  Admin:    admin / <random>
  Manager:  jwilliams / <random>
  Staff:    mpatel / <random>
```

The printed output lists one admin password and one shared manager/staff
password. The `trodriguez`, `akimura`, and `dmuller` accounts are seeded with
that same shared staff password (they are not listed separately).

Copy the printed passwords from the seed output to sign in. Without
`SEED_VERBOSE=1` the passwords are never displayed and cannot be recovered
from the stored bcryptjs hashes — you would have to re-seed.

To use fixed passwords instead (e.g. for a shared dev/CI environment), set them
in `.env` **before** seeding:

```
SEED_ADMIN_PASSWORD=<your-strong-admin-password>
SEED_PASSWORD=<your-strong-staff-password>
```

A fixed seed password must satisfy the same policy the app enforces on every
other password (at least 12 characters, with an uppercase letter, a lowercase
letter, a digit and a special character). The seeder refuses a non-compliant
value instead of creating an account that could never be rotated to a
compliant password.

> ⚠️ Never reuse seed passwords in production. Reset every account's password
> after the first login in any non-local environment.

## Project Structure

```
├── .editorconfig             # Editor style (2-space indent, LF endings)
├── .env.example            # Environment template (copy to .env)
├── .gitignore              # Ignores node_modules, data/, .env, coverage/, *.db*, *.log, certs
├── .nvmrc                  # Pinned Node.js version
├── CODE_REVIEW.md          # Review history
├── eslint.config.js        # ESLint config
├── jest.setup.js           # Jest locale/test setup
├── package.json / package-lock.json
├── data/                   # SQLite database files (git-ignored)
├── public/
│   ├── css/
│   │   └── app.css         # Extracted stylesheet
│   ├── js/
│   │   └── app.js          # Client-side layer (CSP-safe: flash dismiss, confirm dialogs, license-key reveal)
│   └── favicon.svg
├── src/
│   ├── app.js              # Express app setup & server entry
│   ├── constants.js        # Validation enums, limits, session config
│   ├── seed.js             # Database seeder
│   ├── utils.js            # Shared utilities (pagination, filters)
│   ├── middleware/
│   │   ├── auth.js         # requireAuth, requireRole
│   │   └── audit.js        # Audit logging middleware
│   ├── models/
│   │   └── database.js     # SQLite schema & connection
│   └── routes/
│       ├── auth.js         # Login, logout, profile, password
│       ├── dashboard.js    # Dashboard aggregation
│       ├── assets.js       # Asset CRUD
│       ├── tickets.js      # Ticket CRUD + comments
│       ├── projects.js     # Projects + tasks + members
│       ├── staff.js        # User management
│       ├── vendors.js      # Vendor CRUD
│       ├── knowledge.js    # Knowledge base (markdown)
│       ├── changes.js      # Change log CRUD
│       ├── licenses.js     # License CRUD
│       ├── reports.js      # Analytics & reports
│       └── audit.js        # Audit log viewer
├── tests/                  # Jest test suite
├── .github/workflows/
│   └── ci.yml              # CI: lint + test + audit on master/pull
└── views/
    ├── partials/            # header, footer, nav, nav-close, pagination
    └── pages/               # EJS page templates
        ├── auth/
        ├── assets/
        ├── tickets/
        ├── projects/
        ├── staff/
        ├── vendors/
        ├── knowledge/
        ├── changes/
        ├── licenses/
        ├── reports/
        ├── audit/
        ├── dashboard.ejs    # Dashboard overview
        ├── 404.ejs          # Not-found page
        └── error.ejs        # Generic error page
```

## Configuration

Environment variables (set in `.env`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port (must be `1`–`65535`; non-numeric/invalid values fall back to `3000`, and the server exits with code `1` when run as the entry point) |
| `DB_PATH` | `./data/itmanager.db` (resolved relative to repo root) | SQLite database path (absolute paths and `:memory:` pass through; relative paths resolve against the repo root, not the process working directory — use an absolute path in production) |
| `SESSION_SECRET` | *required* | Secret for session cookies (auto-generated in dev; in production it must be >= 32 chars and must NOT be the `CHANGE_ME_…` placeholder shipped in `.env.example` — the server refuses to start otherwise) |
| `CSRF_SECRET` | *required* | Secret for CSRF tokens (auto-generated in dev; in production it must be >= 32 chars and must NOT be the `CHANGE_ME_…` placeholder shipped in `.env.example` — the server refuses to start otherwise) |
| `NODE_ENV` | `development` | `development` or `production` |
| `TRUST_PROXY` | `0` | Set to `1`/`true` when behind a reverse proxy (nginx, etc.) |
| `PRUNE_AUDIT_DAYS` | `0` (disabled) | Auto-prune `audit_log` entries older than N days on startup (e.g. `365`) |
| `PRUNE_AUDIT_INTERVAL_MS` | `86400000` (24h) | Interval (ms) between periodic audit log pruning cycles; only used when `PRUNE_AUDIT_DAYS > 0`; set to `0` to disable periodic pruning (invalid values fall back to `86400000`) |
| `DASHBOARD_TTL_MS` | `30000` (30s) | Dashboard aggregation cache TTL in ms (range: 1000–3600000); values outside the range are clamped with a warning |
| `SESSION_STORE` | *unset* (MemoryStore) | Production session store package (`connect-*` / `@scope/connect-*`); must export the classic connect-session factory (`module.exports = function (connect) { return StoreClass; }`) — packages that export an object (e.g. `connect-redis@10`) are not supported; MemoryStore is not suitable for production |
| `SESSION_IDLE_TIMEOUT_SECONDS` | `900` (15 min) | Session inactivity window; invalid values fall back to `900`, and values below 60 are raised to 60 (lastAccess write-throttle floor) with a warning |
| `SESSION_ABSOLUTE_TIMEOUT_SECONDS` | `28800` (8 h) | Hard cap on a session's total lifetime regardless of activity; a set-but-invalid value falls back to `28800` with a warning |
| `PAGE_SIZE` | `25` | Default page size for paginated list views; values above `100` are clamped to `100` with a warning; invalid values fall back to `25` with a warning |
| `SEED_ADMIN_PASSWORD` | *unset* (random) | Fixed admin password for `npm run seed` (must satisfy the app's password policy — the seeder refuses a non-compliant value) |
| `SEED_PASSWORD` | *unset* (random) | Fixed shared manager/staff password for `npm run seed` (must satisfy the app's password policy) |
| `SEED_VERBOSE` | `0` | Set to `1`/`true` to print auto-generated seed passwords |
| `SEED_DANGER` | `0` | Set to `1` to allow seeding in production (drops all data) |

Hardcoded limits (not env-configurable): request timeout `30s`, keep-alive `5s`, headers timeout `6s` (`src/app.js`); session cookie max-age `24h` (`src/constants.js` `SESSION_MAX_AGE`).

## Security

- **CSRF protection** on all state-changing requests
- **Helmet** for security headers (CSP, X-Frame-Options, Referrer-Policy, etc.), plus an explicit `Permissions-Policy` header disabling camera/microphone/geolocation/USB/Bluetooth and other device APIs (helmet v8 dropped its own Permissions-Policy middleware) and a `Cache-Control: no-store` policy on every dynamic response (static assets are served by `express.static` with their own cache headers)
- **Rate limiting** on login (10 per 15 min per IP, plus a separate 5-failure / 15-min account+IP lockout — a successful login clears only the failures recorded for the account that logged in, so one valid account cannot reset the shared per-source brake; the per-source key groups IPv6 clients by /56, exactly as the rate limiter does), dashboard (10/min), health (30/min), logout (30/15 min per account), a global write backstop (100/15 min per account), and per-route limiters on reports (30/5 min), audit view (30/5 min), license-key reveal (20/15 min), knowledge writes (30/hour) and reads (100/15 min), staff create + deactivate (10/hour each), staff reactivation (10/min), staff updates (50/15 min), admin password resets (20/15 min), self-service profile updates (30/15 min), password changes (10/15 min), ticket writes (50/15 min), ticket comments (10/min), ticket quick-status updates (20/min), ticket satisfaction ratings (10/min), and per-entity write routes (assets / projects / vendors / changes / licenses at 50/15 min)
- **bcryptjs** password hashing (12 salt rounds)
- **Session security**: httpOnly, sameSite=lax, secure in production
- **Input validation**: Whitelisted filter values, parameterized queries. The money and seat fields carry an inclusive upper bound (`MAX_MONEY_AMOUNT` / `MAX_SEAT_COUNT`) that the forms declare on their number inputs **and** the write routes enforce — an HTML `max` attribute is a client-side hint only, so the server repeats the check
- **Date handling**: the date-only columns (an asset's warranty, a licence's expiry, a project's start/end date) hold the **local** calendar day the user typed, and every horizon computed from them is measured against the local calendar too — the dashboard's 30-day warranty/licence alerts, the asset report's 90-day warranty list and the asset age buckets. An asset therefore never falls outside a window the app itself says it is inside.
- **Financial data**: a project's budget and spent amount are withheld from viewers who are not admins/managers — the values are removed from the render context, not merely hidden by the template.
- **Non-enumerating errors**: a record the viewer may not open is reported exactly like a record that does not exist, so a response cannot be used to confirm that an id exists. Every route that can refuse a viewer — the show, edit and write routes of assets, tickets, projects, staff, changes and knowledge — answers the refusal and the missing record identically.
- **Honest write outcomes**: a write that has already committed is never reported as a failure. The profile and password routes write to the database before renewing the session, so if the renewal fails they say what actually happened ("Your password was changed, but your session could not be renewed…") and send the user to log in again — the old password no longer works, and the message must not suggest otherwise.
- **HTTP Parameter Pollution (HPP) defense**: All write routes reject array payloads via `rejectHppArrays()`, preventing multi-value parameter injection
- **405 responses** carry a per-resource `Allow` header (the methods the addressed resource actually serves) together with the full security-header and `no-store` set
- **License-key disclosure**: the plaintext key is never rendered into a page. The show/edit views receive only a `has_license_key` flag and a `****` mask; the full key is reachable exclusively through the audited, rate-limited `POST /licenses/:id/key` endpoint
- **HTML sanitization** on user-generated markdown content. An article's body
  is rendered as HTML and therefore stored entity-escaped; its **title and tags
  are plain text** and are stored unescaped, so they display exactly as they
  were typed and are findable by the search box. The edit form decodes the
  stored body for the textarea only, so the author edits the text they typed
  rather than its escaped form. Because the body is stored escaped, its
  length limit applies to the **stored** form: special characters make the
  stored text longer than what the author typed, and a body that does not fit
  is rejected with a message that says so (never silently shortened, and never
  with a partial HTML entity left behind).
- **Article publishing is an administrative action**: a non-privileged author
  may keep an article's current status or demote it to `draft`, but any other
  status (including publishing or archiving) is **rejected** with "Invalid
  Status" and nothing is written — the app never silently discards a status
  the author asked for. The `is_featured` flag follows the same rule: a
  non-privileged author cannot set it, and a privileged author's submission
  must be a canonical checkbox value — a JSON number, object or boolean is
  a TYPE error and is rejected with the app-wide "Invalid request
  parameters" wording, never silently resolved to 0.
- **Audit logging** of all data mutations (auto-growing table — consider periodic archival for long-running deployments)

### Partial-update (PUT) convention

Every `PUT` route implements the same three-way contract, so a client can
submit only the fields it wants to change:

| Submission | Effect |
| --- | --- |
| field absent (or `null`) | the stored value is **preserved** |
| field present and valid | the stored value is **replaced** |
| field present but invalid (bad enum, malformed date, whitespace-only text) | the request is **rejected** with an error — nothing is written |

**Required** columns follow the same rule: omitting a field preserves the
stored value rather than failing the request. This holds for every required
column in the app — a ticket's title/category/priority/status, an asset's
tag/name/category/status, a vendor's name, a licence's software name, a staff
member's email/first/last name/role, a project's name/status, a task's
title/status, a change's title/type/status, an article's title/content/
category/status, and the profile route's name/email. A *present but empty*
value is still rejected (the columns are `NOT NULL`, so an empty value has no
valid meaning).

The "present" test always runs against the **raw** submitted value, never
against the trimmed one: a whitespace-only value is neither an absent field
(preserve) nor an intentional empty string (clear), so it is rejected like any
other invalid value instead of being silently ignored. This applies to enum
fields exactly as it does to free text.

A present-but-whitespace-only **free-text** value is rejected the same way on
both verbs. The `PUT` routes enforce it through the shared
`resolveOptionalField()` helper; the `POST` routes apply the same test to
their optional text fields, so the same column never gets two verdicts — a
manufacturer of `"   "`, a licence note of `"   "` or a vendor contact of
`"   "` is refused with the same message on create and on update, and
nothing is written.

A **wrong-typed** value is rejected the same way on both verbs too, and with
the same message. A JSON number in a name field is a TYPE error — not an
absent field and not an invalid value — and every text field answers it with
the app-wide `"Invalid request parameters"`. The field-specific wording
(`"Invalid Manufacturer"`, `"Invalid Description"`, `"Invalid Role"`, …)
therefore describes what it says: an invalid **value** (a string outside the
allowlist) or a whitespace-only one. This holds for the enums as well: a
non-string `role` is a type error, while `"role": "owner"` is an invalid
value and is reported as `"Invalid Role"`. It holds for the **quick-status
routes** as well: `PUT /tickets/:id/status` and the task quick-status branch
of `PUT /projects/:projectId/tasks/:taskId` answer a wrong-typed `status`
with the app-wide wording, exactly like the full-update route beside them —
so the same column never produces two different verdicts. The **phone**
column is the one documented exception: it is loosely typed (any character
outside the allowed set is stripped), so a value that sanitises to nothing —
a JSON number, or the string `"abc"` — is reported as an invalid phone
number on both verbs.

The same rule governs the **create** routes: a `POST` that submits a
present-but-empty value for a `NOT NULL` enum column (an asset's, a ticket's,
an article's, a change's or a project's status, a task's status) is rejected,
exactly as the matching `PUT` rejects it. An absent field still takes the
documented default — a project created without a `status` is `planning` and
without a `priority` is `medium`, like every other entity's default (a
ticket created without a `priority` is `medium`, without a `status` is
`open`; a project member added without a `role` is `member`; a staff member
created without a `role` is `staff` and without a `department` is `IT`). A
value of the wrong **type** (a JSON number in a name field, say) is an
invalid value, not a missing one, and is reported as such.

An explicit empty string clears a nullable optional field, with two documented
exceptions:

- the **money fields** — an asset's purchase price, a licence's cost, a
  project's budget and spent amount. A blank money field means "not recorded",
  so the stored amount is preserved (a `NULL` amount is indistinguishable
  from "free" and would mislead the reports). A vendor's rating follows the
  same rule — but note that a *whitespace-only* rating is an **invalid
  value**, not a blank one: the rating is rejected exactly like a
  whitespace-only money amount (an empty rating still preserves the stored
  one). A money field also carries an inclusive upper bound
  (`MAX_MONEY_AMOUNT`), which a present value above it violates — the request
  is rejected, exactly like any other present-but-invalid value (see
  [Form constraints](#form-constraints)).
- the **nullable enum fields whose stored default carries meaning** — an
  asset's condition rating and the priority of a project, a task or a change.
  A blank value means "not submitted", so the stored value is preserved. A
  licence's type and a vendor's category have no meaningful default, so a
  blank value clears them to `NULL`.

The one field where an empty string is not a valid value — the licence key —
has its own dedicated `clear_key` control on the edit form (ticking it wipes
the stored key; typing a new key and ticking it at the same time is rejected
rather than silently discarding one of the two).

### Form constraints

The forms declare the same rules the routes enforce, so a value the browser
accepts is a value the server accepts:

- the money inputs (an asset's purchase price, a licence's cost, a project's
  budget and spent amount) and the licence seat inputs carry the app-wide
  upper bound `CONSTANTS.MAX_MONEY_AMOUNT` / `CONSTANTS.MAX_SEAT_COUNT`. The
  bound is enforced on the write routes as well — an HTML `max` attribute is a
  client-side hint only, and an API client was storing amounts and seat
  counts the UI refused to accept;
- the username input declares the route's minimum length and character class
  (`CONSTANTS.MIN_USERNAME`–`CONSTANTS.MAX_USERNAME`), the asset-tag input
  declares the `AST-XXX` format, the website input declares the `http`/`https`
  scheme, and every email input declares the route's "a dot in the domain"
  rule — each of them accepted values the server always rejected.

### Search surface

A list route's search covers the columns that list renders. A column the list
does not render is only searchable when every row the list can return is
fully readable by the viewer:

- the **asset**, **ticket** and **project** lists are portfolio-visible to
  every authenticated user while their detail pages are assignment- or
  ownership-gated, so their searches cover exactly the rendered columns
  (an asset's serial number and a ticket's description are deliberately not
  searchable). The project list renders a truncated description, so its
  search matches the same truncated prefix. A cell that renders two columns
  together is searched as the concatenation it displays: the asset list
  shows "<manufacturer> <name>" in one cell, so the search matches
  "Dell OptiPlex 7090". (Every search in the app is a substring match, so
  "Dell" and "OptiPlex" still match that cell as well — the concatenation
  exists so the text the user can read is *findable*, not so the halves stop
  matching.) The same rule applies to every name cell the app renders as one
  string — the project card's owner, the knowledge list's author, the staff
  directory's name column, the asset and ticket lists' "Assigned To" columns
  and the change list's "Assigned To" column are all searched as
  "<first> <last>", so the name a user reads off the page can be typed back
  in to find the row.
- the **change** and **knowledge** lists are scoped to the viewer, so a
  non-rendered column (a change's description, an article's body) stays
  searchable — every row in the result set is readable in full. An article's
  body is the one column the app stores **entity-escaped** (it is rendered
  as HTML), so its search matches the text the reader actually sees
  ("R&D budget") as well as the escaped form it is stored in
  ("R&amp;D budget").
- a **list filter is applied only when the list's control offers it**. The
  change index hides the assignee dropdown from a non-privileged viewer (the
  route scopes their list to their own assignments), so an `assigned_to`
  filter submitted for one is ignored rather than narrowing their list to
  nothing behind a control they cannot see. The knowledge index does the same
  with its status filter. A privileged viewer's filters are unaffected.
- the **staff** directory redacts a row's email, phone and department for
  viewers who may not see them, so those columns are not searchable for them
  and the department filter is offered to privileged viewers only. The
  username is rendered by neither the directory nor the profile page — only
  the staff edit form shows it, and a manager cannot open the edit form of a
  manager or admin account — so the username is searchable for an **admin**
  only. A manager searching for it could otherwise confirm the existence of
  a privileged account's login name without being able to read it anywhere.

### List caps and truncation disclosure

Every list in the app is bounded by a cap (page size for the paginated lists,
a per-widget cap for the dashboard cards and the detail-page sidebars). When
a cap actually drops rows, the list says so with an `(N+)` marker next to the
row count. The marker is **exact**: a list that holds exactly as many rows as
its cap is complete and is never marked. (Each capped query fetches one row
beyond its cap as a truncation probe; the three report pages that show an
uncapped total instead disclose it with that total — the asset report's
warranty list ("Showing N of M assets, earliest warranty end date first"),
the staff report's roster ("Showing the top N of M active staff") and the
ticket report's "Top Resolvers" card ("Showing the top N of M resolvers").
The ticket form's Related-Asset dropdown is capped at 1000 assets and
discloses it the same way — "Showing N of M assets".)

A cap counts the rows the **viewer may see**: the ticket page's comment list
applies the access predicate in SQL, so a non-privileged viewer's 500-row
budget is spent on public comments only — internal notes the viewer may not
even read never crowd out the comments they are allowed to see.

## Scripts

```bash
npm start            # Start production server
npm run dev          # Start with nodemon (auto-reload)
npm run seed         # Seed database with sample data
npm run lint         # Lint with ESLint
npm run lint:fix     # Lint and auto-fix
npm test             # Run the Jest test suite
npm run test:watch   # Run tests in watch mode
npm run test:coverage  # Run tests with coverage report
```

## License

Private — internal use only.
