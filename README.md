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
| Auth | Session-based with bcrypt + CSRF protection |
| Security | Helmet, rate limiting, CSP, httpOnly cookies |

## Prerequisites

- Node.js >= 18
- npm >= 8

## Quick Start

```bash
# Clone the repository
git clone <repo-url>
cd aidlc

# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Edit .env and set strong SESSION_SECRET and CSRF_SECRET for production

# Seed the database with sample data
npm run seed

# Start the server
npm start
```

Open http://localhost:3000 in your browser.

### Default Login Credentials (after seeding)

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `Admin@2026!` |
| Manager | `jwilliams` | `Staff@2026!` |
| Staff | `mpatel` | `Staff@2026!` |

> ⚠️ Change these immediately in production by resetting passwords after first login.

## Project Structure

```
├── data/                   # SQLite database files (git-ignored)
├── public/
│   └── css/
│       └── app.css         # Extracted stylesheet
├── src/
│   ├── app.js              # Express app setup & server entry
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
│       └── reports.js      # Analytics & reports
└── views/
    ├── partials/            # Header, footer, nav, pagination
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
        └── reports/
```

## Configuration

Environment variables (set in `.env`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/itmanager.db` | SQLite database path |
| `SESSION_SECRET` | *required* | Secret for session cookies (auto-generated in dev) |
| `CSRF_SECRET` | *required* | Secret for CSRF tokens (auto-generated in dev) |
| `NODE_ENV` | `development` | `development` or `production` |
| `TRUST_PROXY` | `0` | Set to `1` when behind a reverse proxy (nginx, etc.) |

## Security

- **CSRF protection** on all state-changing requests
- **Helmet** for security headers (CSP, X-Frame-Options, etc.)
- **Rate limiting** on login (10 attempts per 15 min)
- **bcrypt** password hashing (12 salt rounds)
- **Session security**: httpOnly, sameSite=lax, secure in production
- **Input validation**: Whitelisted filter values, parameterized queries
- **HTML sanitization** on user-generated markdown content
- **Audit logging** of all data mutations (auto-growing table — consider periodic archival for long-running deployments)

## Scripts

```bash
npm start        # Start production server
npm run dev      # Start with nodemon (auto-reload)
npm run seed     # Seed database with sample data
```

## License

Private — internal use only.
