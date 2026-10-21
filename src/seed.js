require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { BCRYPT_SALT_ROUNDS } = require('./constants');

function _generateSeedPassword(label) {
  const pw = crypto.randomBytes(12).toString('base64') + 'Aa1!';
  console.warn(`WARNING: No ${label} set via environment — using a randomly generated password.`);
  console.warn(`  Set ${label} in .env to suppress this warning and use a fixed password.`);
  return pw;
}

function _seedTransaction(db, seedAdminPw, seedStaffPw) {
  // Wrap entire seed in a transaction
  const seed = db.transaction(() => {
    // Clear existing data (children first, parents last — respects foreign keys)
    db.exec(`
      DELETE FROM ticket_comments;
      DELETE FROM project_tasks;
      DELETE FROM project_members;
      DELETE FROM tickets;
      DELETE FROM assets;
      DELETE FROM licenses;
      DELETE FROM knowledge_articles;
      DELETE FROM change_log;
      DELETE FROM projects;
      DELETE FROM vendors;
      -- WARNING: audit_log is also cleared. This destroys forensic evidence.
      -- In production, consider preserving audit logs or using a separate
      -- archival strategy before seeding.
      DELETE FROM audit_log;
      DELETE FROM users;
      DELETE FROM ticket_counter;
      DELETE FROM asset_counter;
      DELETE FROM sqlite_sequence WHERE name = 'users';
      DELETE FROM sqlite_sequence WHERE name = 'assets';
      DELETE FROM sqlite_sequence WHERE name = 'licenses';
      DELETE FROM sqlite_sequence WHERE name = 'tickets';
      DELETE FROM sqlite_sequence WHERE name = 'ticket_comments';
      DELETE FROM sqlite_sequence WHERE name = 'projects';
      DELETE FROM sqlite_sequence WHERE name = 'project_tasks';
      DELETE FROM sqlite_sequence WHERE name = 'project_members';
      DELETE FROM sqlite_sequence WHERE name = 'vendors';
      DELETE FROM sqlite_sequence WHERE name = 'knowledge_articles';
      DELETE FROM sqlite_sequence WHERE name = 'change_log';
      DELETE FROM sqlite_sequence WHERE name = 'audit_log';
    `);

    // -----------------------------------------------------------------------
    // Shared date helpers.
    //
    // Every seeded date that must stay meaningful whenever the seed runs is
    // derived from the seed moment instead of a hardcoded literal: a literal
    // drifts into the past, and a fresh seed then contradicts itself (a
    // ticket that is born overdue, a project that ended two months ago, a
    // license that expired a year ago). The helpers are declared HERE, at the
    // top of the transaction, because the sections below use them in
    // different orders (licenses before tickets, vendors last) and a
    // `const` declared further down would still be in its temporal dead zone
    // when an earlier section calls it.
    //
    // All of them work in UTC, matching the DB's datetime('now') /
    // date('now') and the routes' UTC-based ticket counter.
    // -----------------------------------------------------------------------
    const now = new Date();
    const today = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    // Full timestamp "YYYY-MM-DD HH:MM:SS", N days in the past.
    const isoDaysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    // Calendar date "YYYY-MM-DD", N days in the future (negative = past).
    const isoDateDaysFromNow = (days) => new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
    // Convenience alias for a calendar date N days in the past.
    const daysAgo = (days) => isoDateDaysFromNow(-days);

    // ========================
    // USERS
    // ========================
    const users = [
      { username: 'admin', password: seedAdminPw, email: 'admin@company.com', first_name: 'Sarah', last_name: 'Chen', role: 'admin', department: 'IT', phone: '555-0101' },
      { username: 'jwilliams', password: seedStaffPw, email: 'j.williams@company.com', first_name: 'James', last_name: 'Williams', role: 'manager', department: 'IT', phone: '555-0102' },
      { username: 'mpatel', password: seedStaffPw, email: 'm.patel@company.com', first_name: 'Maya', last_name: 'Patel', role: 'staff', department: 'IT', phone: '555-0103' },
      { username: 'trodriguez', password: seedStaffPw, email: 't.rodriguez@company.com', first_name: 'Tomás', last_name: 'Rodriguez', role: 'staff', department: 'IT', phone: '555-0104' },
      { username: 'akimura', password: seedStaffPw, email: 'a.kimura@company.com', first_name: 'Aiko', last_name: 'Kimura', role: 'staff', department: 'IT', phone: '555-0105' },
      { username: 'dmuller', password: seedStaffPw, email: 'd.muller@company.com', first_name: 'Dieter', last_name: 'Müller', role: 'staff', department: 'IT', phone: '555-0106' }
    ];

    const insertUser = db.prepare(`
      INSERT INTO users (username, password, email, first_name, last_name, role, department, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const u of users) {
      const hash = bcrypt.hashSync(u.password, BCRYPT_SALT_ROUNDS);
      insertUser.run(u.username, hash, u.email, u.first_name, u.last_name, u.role, u.department, u.phone);
    }

    // ========================
    // ASSETS
    // ========================
    // Asset purchase dates and warranty expiries are anchored to the seed date
    // for the same reason as the license terms, the vendor contract windows and
    // the project windows below: a hardcoded absolute date drifts into the
    // past, and every seeded warranty had ALREADY expired — the dashboard's
    // "Warranty Ending or Expired" alert (a 30-day window) therefore only ever
    // reported long-expired records, and the "expiring soon" case it names was
    // never represented. The seeded portfolio now exercises all three states:
    // live warranties, one expiring inside the 30-day alert window, and a few
    // genuinely expired ones.
    //
    // `assetTerm(daysAgoPurchased, daysUntilWarrantyEnd)` returns a purchase
    // date in the past and a warranty expiry relative to the seed date. The
    // warranty always ends at or after the purchase — the same ordering the
    // asset routes enforce ("Warranty expiry must be on or after purchase
    // date").
    const assetTerm = (daysAgoPurchased, daysUntilWarrantyEnd) => ({
      purchase_date: isoDateDaysFromNow(-daysAgoPurchased),
      warranty_expiry: isoDateDaysFromNow(daysUntilWarrantyEnd)
    });
    const assets = [
      { asset_tag: 'AST-001', name: 'MacBook Pro 16"', category: 'laptop', manufacturer: 'Apple', model: 'M3 Max', serial_number: 'SN-APL-001', status: 'in_use', condition_rating: 'new', ...assetTerm(400, 700), purchase_price: 3499, assigned_to: 1, location: 'HQ Office' },
      { asset_tag: 'AST-002', name: 'Dell OptiPlex 7090', category: 'desktop', manufacturer: 'Dell', model: '7090 SFF', serial_number: 'SN-DEL-002', status: 'in_use', condition_rating: 'good', ...assetTerm(300, 20), purchase_price: 1299, assigned_to: 2, location: 'HQ Office' },
      { asset_tag: 'AST-003', name: 'ThinkPad X1 Carbon', category: 'laptop', manufacturer: 'Lenovo', model: 'Gen 11', serial_number: 'SN-LEN-003', status: 'in_use', condition_rating: 'good', ...assetTerm(280, -10), purchase_price: 1899, assigned_to: 3, location: 'Remote' },
      { asset_tag: 'AST-004', name: 'HP ProLiant DL380', category: 'server', manufacturer: 'HP', model: 'DL380 Gen10', serial_number: 'SN-HP-004', status: 'in_use', condition_rating: 'good', ...assetTerm(700, -300), purchase_price: 8999, assigned_to: null, location: 'Data Center A' },
      { asset_tag: 'AST-005', name: 'Dell PowerEdge R740', category: 'server', manufacturer: 'Dell', model: 'R740', serial_number: 'SN-DEL-005', status: 'in_use', condition_rating: 'good', ...assetTerm(620, -400), purchase_price: 12500, assigned_to: null, location: 'Data Center A' },
      { asset_tag: 'AST-006', name: 'Cisco Catalyst 9300', category: 'network', manufacturer: 'Cisco', model: 'C9300-48T', serial_number: 'SN-CSC-006', status: 'in_use', condition_rating: 'good', ...assetTerm(500, 75), purchase_price: 6500, assigned_to: null, location: 'Server Room' },
      { asset_tag: 'AST-007', name: 'HP LaserJet Pro', category: 'printer', manufacturer: 'HP', model: 'M404dn', serial_number: 'SN-HP-007', status: 'in_storage', condition_rating: 'fair', ...assetTerm(900, -600), purchase_price: 399, assigned_to: null, location: 'Storage Room B' },
      { asset_tag: 'AST-008', name: 'Dell UltraSharp 27"', category: 'monitor', manufacturer: 'Dell', model: 'U2723QE', serial_number: 'SN-DEL-008', status: 'in_use', condition_rating: 'new', ...assetTerm(450, 650), purchase_price: 619, assigned_to: 4, location: 'HQ Office' },
      { asset_tag: 'AST-009', name: 'iPhone 15 Pro', category: 'phone', manufacturer: 'Apple', model: 'A2848', serial_number: 'SN-APL-009', status: 'in_use', condition_rating: 'good', ...assetTerm(200, 400), purchase_price: 1199, assigned_to: 1, location: 'HQ Office' },
      { asset_tag: 'AST-010', name: 'Surface Pro 9', category: 'tablet', manufacturer: 'Microsoft', model: 'QEZ-00001', serial_number: 'SN-MSF-010', status: 'in_repair', condition_rating: 'fair', ...assetTerm(600, -500), purchase_price: 1599, assigned_to: 5, location: 'Repair Shop' },
      { asset_tag: 'AST-011', name: 'MacBook Air M2', category: 'laptop', manufacturer: 'Apple', model: 'MLY33LL/A', serial_number: 'SN-APL-011', status: 'in_use', condition_rating: 'good', ...assetTerm(420, 670), purchase_price: 1299, assigned_to: 5, location: 'HQ Office' },
      { asset_tag: 'AST-012', name: 'Logitech MX Keys', category: 'peripheral', manufacturer: 'Logitech', model: 'MX Keys Advanced', serial_number: 'SN-LOG-012', status: 'in_storage', condition_rating: 'new', ...assetTerm(380, 340), purchase_price: 119, assigned_to: null, location: 'Storage Room A' }
    ];

    const insertAsset = db.prepare(`
      INSERT INTO assets (asset_tag, name, category, manufacturer, model, serial_number, status, condition_rating, purchase_date, purchase_price, warranty_expiry, assigned_to, location)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const a of assets) {
      insertAsset.run(a.asset_tag, a.name, a.category, a.manufacturer, a.model, a.serial_number,
        a.status, a.condition_rating, a.purchase_date, a.purchase_price, a.warranty_expiry,
        a.assigned_to, a.location);
    }
    // Initialize asset counter so the first auto-generated tag after seeding
    // is AST-013 (next after the last seeded AST-012). On re-seed the ON
    // CONFLICT clause resets the counter to the seed value so the next
    // generated tag is always AST-013 regardless of prior creations.
    const initAssetCounter = db.prepare('INSERT INTO asset_counter (counter_key, next_seq) VALUES (\'asset_tag\', ?) ON CONFLICT(counter_key) DO UPDATE SET next_seq = ?');
    initAssetCounter.run(assets.length, assets.length);

    // ========================
    // LICENSES
    // ========================
    // License terms are anchored to the seed date for the same reason as the
    // ticket due date and the project windows below: hardcoded absolute dates
    // drift into the past, and every seeded license that carried an expiry
    // date had already expired — the dashboard's "License Expiring Soon"
    // alert (a 30-day window) therefore only ever reported long-expired
    // records, and the "expiring soon" case it names was never represented.
    // Each entry keeps its original ~1-year subscription story, and two
    // subscriptions now expire INSIDE the 30-day alert window so a fresh
    // seed exercises that path.
    const licenseTerm = (daysAgoPurchased, daysUntilExpiry) => ({
      purchase_date: isoDateDaysFromNow(-daysAgoPurchased),
      expiry_date: isoDateDaysFromNow(daysUntilExpiry)
    });
    const licenses = [
      { software_name: 'Microsoft 365 E3', vendor: 'Microsoft', license_key: 'MS365-E3-VOL-001', license_type: 'subscription', total_seats: 200, used_seats: 187, ...licenseTerm(330, 12), cost: 28000 },
      { software_name: 'Adobe Creative Cloud', vendor: 'Adobe', license_key: 'ADB-CC-ENT-050', license_type: 'subscription', total_seats: 50, used_seats: 42, ...licenseTerm(200, 165), cost: 15000 },
      { software_name: 'Jira Software', vendor: 'Atlassian', license_key: 'ATL-JIRA-500', license_type: 'subscription', total_seats: 500, used_seats: 323, ...licenseTerm(300, 65), cost: 18000 },
      { software_name: 'Windows Server 2022', vendor: 'Microsoft', license_key: 'MS-WS2022-DATA', license_type: 'perpetual', total_seats: 10, used_seats: 8, purchase_date: isoDateDaysFromNow(-1600), expiry_date: null, cost: 6200 },
      { software_name: 'VMware vSphere', vendor: 'Broadcom', license_key: 'VMW-VSP-ENT-020', license_type: 'perpetual', total_seats: 3, used_seats: 3, purchase_date: isoDateDaysFromNow(-1000), expiry_date: null, cost: 12500 },
      { software_name: 'CrowdStrike Falcon', vendor: 'CrowdStrike', license_key: 'CS-FALC-EP-500', license_type: 'subscription', total_seats: 500, used_seats: 480, ...licenseTerm(350, 15), cost: 35000 },
      { software_name: 'Slack Business+', vendor: 'Salesforce', license_key: 'SLK-BIZ-0300', license_type: 'subscription', total_seats: 300, used_seats: 287, ...licenseTerm(320, 45), cost: 10800 }
    ];

    const insertLicense = db.prepare(`
      INSERT INTO licenses (software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const l of licenses) {
      insertLicense.run(l.software_name, l.vendor, l.license_key, l.license_type, l.total_seats,
        l.used_seats, l.purchase_date, l.expiry_date, l.cost, '');
    }

    // ========================
    // TICKETS
    // ========================
    const tickets = [
      { title: 'VPN connection drops intermittently', description: 'Multiple users reporting VPN disconnects during peak hours. Affects remote workers primarily.', category: 'network', priority: 'high', status: 'in_progress', requester_name: 'Lisa Park', requester_email: 'l.park@company.com', requester_department: 'Marketing', assigned_to: 3, asset_id: 6, due_date: '2026-05-25' },
      { title: 'Email not syncing on mobile device', description: 'Outlook app on iPhone not syncing emails since this morning. Tried reinstalling the app.', category: 'email', priority: 'medium', status: 'open', requester_name: 'Mark Johnson', requester_email: 'm.johnson@company.com', requester_department: 'Sales', assigned_to: 4 },
      { title: 'New employee workstation setup', description: 'Need workstation prepared for new hire starting June 1st. Standard developer setup required.', category: 'hardware', priority: 'medium', status: 'open', requester_name: 'HR Department', requester_email: 'hr@company.com', requester_department: 'HR', assigned_to: 5 },
      { title: 'Server room temperature alert', description: 'Temperature sensor showing 28°C in server room A. Normal is 20-22°C. HVAC may need attention.', category: 'hardware', priority: 'critical', status: 'in_progress', requester_name: 'Monitoring System', requester_email: 'alerts@company.com', requester_department: 'IT', assigned_to: 2, asset_id: 4 },
      { title: 'Access request for SharePoint site', description: 'Need access to the Marketing shared SharePoint site for the new campaign project.', category: 'access', priority: 'low', status: 'waiting', requester_name: 'David Kim', requester_email: 'd.kim@company.com', requester_department: 'Marketing', assigned_to: 4 },
      { title: 'Printer jammed on 3rd floor', description: 'HP LaserJet on 3rd floor has a paper jam. Unable to clear it following standard procedure.', category: 'hardware', priority: 'low', status: 'open', requester_name: 'Anna Smith', requester_email: 'a.smith@company.com', requester_department: 'Finance', assigned_to: 5, asset_id: 7 },
      { title: 'Suspicious email reported', description: 'Phishing email received by multiple staff. Sender pretending to be CEO requesting wire transfer.', category: 'security', priority: 'critical', status: 'in_progress', requester_name: 'Sarah Chen', requester_email: 'admin@company.com', requester_department: 'IT', assigned_to: 2 },
      { title: 'SAP GUI installation request', description: 'Need SAP GUI installed on my workstation for the new accounting module access.', category: 'software', priority: 'medium', status: 'resolved', requester_name: 'Robert Chen', requester_email: 'r.chen@company.com', requester_department: 'Finance', assigned_to: 3, resolution_notes: 'SAP GUI 7.70 installed and configured. Connection profiles set up.' },
      { title: 'WiFi slow in conference room B', description: 'Video calls keep freezing in Conference Room B. Other rooms seem fine.', category: 'network', priority: 'medium', status: 'open', requester_name: 'Emily Davis', requester_email: 'e.davis@company.com', requester_department: 'Operations', assigned_to: 3 },
      { title: 'Password reset for service account', description: 'Service account svc_backup has password expiring. Need coordinated rotation.', category: 'access', priority: 'high', status: 'resolved', requester_name: 'Tomás Rodriguez', requester_email: 't.rodriguez@company.com', requester_department: 'IT', assigned_to: 6, resolution_notes: 'Password rotated during maintenance window. All dependent services updated.' }
    ];

    const insertTicket = db.prepare(`
      INSERT INTO tickets (ticket_number, title, description, category, priority, status,
        requester_name, requester_email, requester_department, assigned_to, asset_id, due_date, resolution_notes, resolved_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Relative due date (14 days out) so a fresh seed never shows an immediately
    // overdue ticket — mirrors the relative changeAt() helper for scheduled changes.
    // Anchor the single seeded due date relative to now (was a hardcoded
    // 2026-05-25 that drifted into the past).
    tickets[0].due_date = isoDateDaysFromNow(14);
    const insertCounter = db.prepare('INSERT INTO ticket_counter (counter_date, next_seq) VALUES (?, ?) ON CONFLICT(counter_date) DO UPDATE SET next_seq = ?');
    for (const [i, t] of tickets.entries()) {
      const num = `TK-${today}-${String(i + 1).padStart(3, '0')}`;
      const isResolved = t.status === 'resolved' || t.status === 'closed';
      // Seed explicit created_at older than resolved_at so resolution-time / SLA
      // metrics stay positive. Without this, resolved_at defaulted to 1 day ago
      // while created_at defaulted to datetime('now'), yielding negative duration.
      const createdAt = isResolved ? isoDaysAgo(3) : isoDaysAgo(2);
      const resolvedAt = isResolved ? isoDaysAgo(1) : null;
      // updated_at is set explicitly instead of taking the schema default
      // (datetime('now') = the seed moment). The default made every seeded
      // ticket read as "Updated <seed time>", i.e. AFTER its own resolution
      // timestamp, so the ticket show page rendered "Created … / Updated … /
      // Resolved …" with the update after the resolution — the ticket looked
      // as if it had been edited after it was closed, and every seeded ticket
      // looked "just updated" in the dashboard's recently-active list. The
      // last meaningful event is the resolution for a closed ticket and the
      // creation for an open one.
      const updatedAt = resolvedAt || createdAt;
      insertTicket.run(num, t.title, t.description, t.category, t.priority, t.status,
        t.requester_name, t.requester_email, t.requester_department, t.assigned_to,
        t.asset_id || null, t.due_date || null, t.resolution_notes || null, resolvedAt, createdAt, updatedAt);
    }
    insertCounter.run(today, tickets.length, tickets.length);

    // ========================
    // PROJECTS
    // ========================
    // progress values are pre-computed to match recalcProjectProgress()
    // (done/total rounded) — a stale value would jump on the first task edit:
    // project 1 has 2/5 tasks done (40), project 3 has 2/4 done (50), project
    // 5 has 1/1 done (100). Taskless projects seed progress 0 — recalc maps a
    // zero task count to 0, so any other seeded value would visibly jump.
    // Project windows and task due dates are anchored relative to seed time,
    // exactly like the ticket due date above and the scheduled changes below.
    // The hardcoded windows had already drifted into the past: a fresh seed
    // showed an "in_progress" project whose end date was two months ago, a
    // "planning" project that started four months ago, and five open tasks
    // whose due date had already passed (every one of them rendered as
    // "Overdue"). The relative anchors keep the seeded portfolio coherent
    // whenever the seed runs.
    const projects = [
      { name: 'Cloud Migration Phase 2', description: 'Migrate remaining on-premises workloads to AWS. Includes database migration and CDN setup.', status: 'in_progress', priority: 'high', start_date: daysAgo(270), end_date: isoDateDaysFromNow(90), budget: 150000, spent: 45000, progress: 40, owner_id: 2 },
      { name: 'Zero Trust Network Implementation', description: 'Implement Zero Trust security architecture across all network segments.', status: 'planning', priority: 'critical', start_date: isoDateDaysFromNow(60), end_date: isoDateDaysFromNow(240), budget: 200000, spent: 5000, progress: 0, owner_id: 2 },
      { name: 'IT Service Desk Upgrade', description: 'Migrate from legacy ticketing system to modern ITSM platform with automation.', status: 'in_progress', priority: 'medium', start_date: daysAgo(210), end_date: isoDateDaysFromNow(30), budget: 50000, spent: 32000, progress: 50, owner_id: 3 },
      { name: 'Office 365 Copilot Rollout', description: 'Deploy Microsoft Copilot to all departments with training and governance policies.', status: 'planning', priority: 'high', start_date: isoDateDaysFromNow(21), end_date: isoDateDaysFromNow(120), budget: 75000, spent: 0, progress: 0, owner_id: 1 },
      { name: 'Data Center Cooling Upgrade', description: 'Replace aging HVAC units in Data Center A with efficient cooling system.', status: 'completed', priority: 'high', start_date: daysAgo(240), end_date: daysAgo(150), budget: 85000, spent: 82000, progress: 100, owner_id: 6 }
    ];

    const insertProject = db.prepare(`
      INSERT INTO projects (name, description, status, priority, start_date, end_date, budget, spent, progress, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const p of projects) {
      insertProject.run(p.name, p.description, p.status, p.priority, p.start_date, p.end_date,
        p.budget, p.spent, p.progress, p.owner_id);
    }

    // Project tasks
    // Project tasks — due dates anchored relative to seed time for the same
    // reason as the project windows above: a task that is still open must not
    // be born overdue. Completed tasks keep a due date in the past and a
    // completion date just before it.
    //
    // A task due date must also fall INSIDE its own project's window. The
    // relative anchoring alone was not enough: 'Staff training' (project 3,
    // which ends 30 days out) was still anchored 60 days out, so a fresh seed
    // showed a task due a month after the project it belongs to had already
    // finished. Every due date below now sits between the owning project's
    // start and end date.
    const tasks = [
      { project_id: 1, title: 'Assessment of current workloads', description: 'Document all on-prem workloads and dependencies', status: 'done', priority: 'high', assigned_to: 3, due_date: daysAgo(240), completed_at: daysAgo(243) },
      { project_id: 1, title: 'AWS Landing Zone setup', description: 'Configure multi-account AWS environment', status: 'done', priority: 'high', assigned_to: 6, due_date: daysAgo(210), completed_at: daysAgo(213) },
      { project_id: 1, title: 'Database migration planning', description: 'Plan PostgreSQL to RDS migration strategy', status: 'in_progress', priority: 'high', assigned_to: 3, due_date: isoDateDaysFromNow(10) },
      { project_id: 1, title: 'CDN configuration', description: 'Set up CloudFront distributions', status: 'todo', priority: 'medium', assigned_to: 6, due_date: isoDateDaysFromNow(45) },
      { project_id: 1, title: 'Testing & validation', description: 'Full regression testing of migrated workloads', status: 'todo', priority: 'high', assigned_to: 4, due_date: isoDateDaysFromNow(75) },
      { project_id: 3, title: 'Vendor evaluation', description: 'Evaluate ServiceNow vs Jira Service Management', status: 'done', priority: 'high', assigned_to: 3, due_date: daysAgo(180), completed_at: daysAgo(183) },
      { project_id: 3, title: 'Data migration scripts', description: 'Write scripts to migrate data from old system', status: 'done', priority: 'high', assigned_to: 5, due_date: daysAgo(150), completed_at: daysAgo(152) },
      { project_id: 3, title: 'Workflow automation setup', description: 'Configure automated workflows and SLAs', status: 'in_progress', priority: 'medium', assigned_to: 3, due_date: isoDateDaysFromNow(20) },
      { project_id: 3, title: 'Staff training', description: 'Train IT staff on new platform', status: 'todo', priority: 'medium', assigned_to: 4, due_date: isoDateDaysFromNow(25) },
      // Project 5 ('completed', progress 100) needs at least one done task so
      // its seeded progress matches recalcProjectProgress (1/1 = 100) — a
      // taskless completed project would snap from 100% to 0% on its first
      // task edit (recalc maps zero tasks to 0).
      { project_id: 5, title: 'HVAC unit replacement', description: 'Replace all aging HVAC units and commission the new cooling system', status: 'done', priority: 'high', assigned_to: 6, due_date: daysAgo(160), completed_at: daysAgo(163) }
    ];

    const insertTask = db.prepare(`
      INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, due_date, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const t of tasks) {
      insertTask.run(t.project_id, t.title, t.description, t.status, t.priority, t.assigned_to, t.due_date, t.completed_at || null);
    }

    // Project members
    const projectMembers = [
      { project_id: 1, user_id: 2, role: 'lead' },
      { project_id: 1, user_id: 3, role: 'member' },
      { project_id: 1, user_id: 6, role: 'member' },
      { project_id: 2, user_id: 2, role: 'lead' },
      { project_id: 2, user_id: 4, role: 'member' },
      { project_id: 3, user_id: 3, role: 'lead' },
      { project_id: 3, user_id: 4, role: 'member' },
      { project_id: 3, user_id: 5, role: 'member' },
      { project_id: 4, user_id: 1, role: 'lead' },
      { project_id: 5, user_id: 6, role: 'lead' },
      { project_id: 5, user_id: 4, role: 'member' }
    ];

    const insertMember = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
    for (const m of projectMembers) {
      insertMember.run(m.project_id, m.user_id, m.role);
    }

    // ========================
    // VENDORS
    // ========================
    // Contract windows are anchored to the seed date for the same reason as
    // the license terms above: the hardcoded literals had all drifted into
    // the past, so a fresh seed showed three of the five vendors with a
    // contract that had already ended and no running contract at all. Four
    // vendors now hold a live contract and one (TechCorp Support) keeps a
    // recently-ended contract so the "contract lapsed" state is represented.
    const vendors = [
      { name: 'Dell Technologies', contact_person: 'Mike Thompson', email: 'mike.t@dell.com', phone: '800-555-1234', category: 'hardware', contract_start: daysAgo(400), contract_end: isoDateDaysFromNow(320), rating: 4 },
      { name: 'Amazon Web Services', contact_person: 'Jennifer Liu', email: 'j.liu@aws.amazon.com', phone: '800-555-2345', category: 'cloud', contract_start: daysAgo(200), contract_end: isoDateDaysFromNow(530), rating: 5 },
      { name: 'CrowdStrike', contact_person: 'Alex Rivera', email: 'a.rivera@crowdstrike.com', phone: '800-555-3456', category: 'security', contract_start: daysAgo(300), contract_end: isoDateDaysFromNow(65), rating: 4 },
      { name: 'Cisco Systems', contact_person: 'Patricia Nguyen', email: 'p.nguyen@cisco.com', phone: '800-555-4567', category: 'network', contract_start: daysAgo(300), contract_end: isoDateDaysFromNow(240), rating: 5 },
      { name: 'TechCorp Support', contact_person: 'Frank Miller', email: 'f.miller@techcorp.com', phone: '800-555-5678', category: 'maintenance', contract_start: daysAgo(500), contract_end: daysAgo(20), rating: 3 }
    ];

    const insertVendor = db.prepare(`
      INSERT INTO vendors (name, contact_person, email, phone, category, contract_start, contract_end, rating, notes, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    for (const v of vendors) {
      insertVendor.run(v.name, v.contact_person, v.email, v.phone, v.category,
        v.contract_start, v.contract_end, v.rating, '');
    }

    // ========================
    // KNOWLEDGE BASE
    // ========================
    const articles = [
      { title: 'How to Connect to Corporate VPN', content: '# VPN Connection Guide\n\n## Prerequisites\n- Company laptop with VPN client installed\n- Active directory credentials\n\n## Steps\n1. Open Cisco AnyConnect from Start Menu\n2. Enter server: vpn.company.com\n3. Click Connect\n4. Enter your AD username and password\n5. Enter MFA code from Authenticator app\n6. Click OK\n\n## Troubleshooting\n- If connection fails, try restarting the VPN service\n- Clear DNS cache: `ipconfig /flushdns`\n- Contact IT if issues persist', category: 'how_to', tags: 'vpn,network,remote', status: 'published', is_featured: 1, author_id: 2 },
      { title: 'Printer Setup on macOS', content: '# Setting up Network Printers on macOS\n\n1. Open System Settings → Printers & Scanners\n2. Click "+" to add printer\n3. Select "IP" tab\n4. Enter printer IP address from the printer list\n5. Select protocol: IPP\n6. Choose driver: Generic PostScript\n7. Click Add\n\nSee the printer IP list in the IT shared drive.', category: 'how_to', tags: 'printer,macos,setup', status: 'published', is_featured: 0, author_id: 5 },
      { title: 'Password Policy Requirements', content: '# Corporate Password Policy\n\n## Requirements\n- Minimum 12 characters\n- Must include: uppercase, lowercase, number, special character\n- Cannot reuse last 10 passwords\n- Must be changed every 90 days\n\n## MFA\n- All accounts require MFA\n- Use Microsoft Authenticator app\n- Backup codes should be stored securely', category: 'policy', tags: 'security,password,policy', status: 'published', is_featured: 1, author_id: 1 },
      { title: 'Troubleshooting Network Connectivity', content: '# Network Troubleshooting SOP\n\n## Quick Checks\n1. Check cable connections\n2. Restart computer\n3. Try a different network port\n\n## Diagnostics\n```bash\nping 8.8.8.8\ntracert google.com\nipconfig /all\n```\n\n## Common Issues\n- IP conflict: Release/renew IP\n- DNS issues: Flush DNS cache\n- Proxy issues: Check proxy settings', category: 'troubleshooting', tags: 'network,troubleshooting', status: 'published', is_featured: 0, author_id: 3 },
      { title: 'New Employee IT Onboarding Checklist', content: '# IT Onboarding Checklist\n\n## Day Before\n- [ ] Create AD account\n- [ ] Create email account\n- [ ] Assign licenses (M365, etc.)\n- [ ] Prepare laptop with standard image\n- [ ] Configure VPN access\n- [ ] Add to relevant distribution lists\n\n## Day 1\n- [ ] Issue laptop and peripherals\n- [ ] Set up accounts with employee\n- [ ] Configure email on mobile\n- [ ] Brief on security policies\n- [ ] Provide IT support contact info', category: 'sop', tags: 'onboarding,hr,process', status: 'published', is_featured: 1, author_id: 2 },
      { title: 'Incident Response Procedure', content: '# Security Incident Response\n\n## Severity Levels\n- **Critical**: Active breach, data exfiltration\n- **High**: Vulnerability being exploited\n- **Medium**: Suspicious activity detected\n- **Low**: Potential risk identified\n\n## Steps\n1. Identify and contain\n2. Assess impact\n3. Notify security team lead\n4. Eradicate threat\n5. Recover systems\n6. Post-incident review', category: 'sop', tags: 'security,incident,response', status: 'draft', is_featured: 0, author_id: 1 }
    ];

    const insertArticle = db.prepare(`
      INSERT INTO knowledge_articles (title, content, category, tags, author_id, status, is_featured)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const a of articles) {
      insertArticle.run(a.title, a.content, a.category, a.tags, a.author_id, a.status, a.is_featured);
    }

    // ========================
    // CHANGE LOG
    // ========================
    // Scheduled changes are anchored relative to seed time (like ticket
    // timestamps above) so the Dashboard "Upcoming Changes" panel always has
    // data no matter when the seed runs — hardcoded absolute dates would drift
    // into the past and render that panel empty. Completed/failed changes keep
    // absolute historical timestamps (they are past by definition).
    const changeAt = (daysFromNow, time) => {
      const d = new Date(now.getTime() + daysFromNow * 86400000);
      const [hours, minutes] = time.split(':');
      d.setUTCHours(Number(hours), Number(minutes), 0, 0);
      // Minute precision ("YYYY-MM-DD HH:MM") — the exact shape the routes
      // write (safeDateTimeLocal). The seeder used to append ":SS", which made
      // every seeded row a different shape from every application-written row:
      // the change route compares a stored datetime against a submitted one as
      // strings, and "2026-05-20 02:00" sorts BEFORE "2026-05-20 02:00:00"
      // even though both denote the same instant, so the range validation
      // rejected valid updates on seeded records. Canonical format on both
      // sides removes the ambiguity entirely.
      return d.toISOString().replace('T', ' ').slice(0, 16);
    };
    const changes = [
      { title: 'Firewall Rule Update - Block New Threat IPs', description: 'Update firewall rules to block newly identified threat actor IP ranges.', change_type: 'security', status: 'completed', priority: 'critical', scheduled_start: '2026-05-20 02:00', scheduled_end: '2026-05-20 03:00', actual_start: '2026-05-20 02:00', actual_end: '2026-05-20 02:35', impact: 'No user impact expected', assigned_to: 6 },
      { title: 'Exchange Server Patching', description: 'Install latest security patches for on-prem Exchange servers.', change_type: 'maintenance', status: 'scheduled', priority: 'high', scheduled_start: changeAt(5, '22:00'), scheduled_end: changeAt(6, '02:00'), impact: 'Email may be unavailable for up to 30 minutes during failover', assigned_to: 6 },
      { title: 'Network Switch Firmware Upgrade', description: 'Upgrade firmware on core switches to fix VLAN routing issues.', change_type: 'upgrade', status: 'scheduled', priority: 'high', scheduled_start: changeAt(12, '06:00'), scheduled_end: changeAt(12, '08:00'), impact: 'Brief network interruptions possible during failover', assigned_to: 3 },
      { title: 'Active Directory Schema Update', description: 'Apply schema extension for new MFA attributes.', change_type: 'configuration', status: 'scheduled', priority: 'medium', scheduled_start: changeAt(16, '21:00'), scheduled_end: changeAt(16, '22:00'), impact: 'AD replication delay possible', assigned_to: 2 },
      { title: 'Storage Array Maintenance', description: 'Replace failed drive in SAN array Bay 7.', change_type: 'maintenance', status: 'completed', priority: 'medium', scheduled_start: '2026-05-18 23:00', scheduled_end: '2026-05-19 01:00', actual_start: '2026-05-18 23:00', actual_end: '2026-05-18 23:45', impact: 'No impact - hot spare active', assigned_to: 6 }
    ];

    const insertChange = db.prepare(`
      INSERT INTO change_log (title, description, change_type, status, priority, scheduled_start, scheduled_end, actual_start, actual_end, impact, assigned_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of changes) {
      insertChange.run(c.title, c.description, c.change_type, c.status, c.priority,
        c.scheduled_start, c.scheduled_end, c.actual_start || null, c.actual_end || null,
        c.impact, c.assigned_to);
    }

    // Add some ticket comments
    const comments = [
      { ticket_id: 1, user_id: 3, comment: 'Investigating the VPN concentrator logs. Seeing high CPU utilization during peak hours.', is_internal: 0 },
      { ticket_id: 1, user_id: 2, comment: 'May need to schedule a capacity upgrade. Check with vendor about licensing for additional tunnels.', is_internal: 1 },
      { ticket_id: 4, user_id: 6, comment: 'HVAC technician dispatched. ETA 1 hour. Monitoring temperature in the meantime.', is_internal: 0 },
      { ticket_id: 7, user_id: 2, comment: 'Email samples forwarded to security team. Blocking sender domain at gateway.', is_internal: 1 },
      { ticket_id: 7, user_id: 1, comment: 'Company-wide alert sent. All staff advised to not click any suspicious links.', is_internal: 0 }
    ];

    const insertComment = db.prepare(`
      INSERT INTO ticket_comments (ticket_id, user_id, comment, is_internal)
      VALUES (?, ?, ?, ?)
    `);

    for (const c of comments) {
      insertComment.run(c.ticket_id, c.user_id, c.comment, c.is_internal);
    }
  });
  seed();
}

/**
 * Run the seed logic against the given database connection.
 * Exported so tests can verify seed behavior without re-executing the full script.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [adminPw]
 * @param {string} [staffPw]
 */
function runSeed(db, adminPw, staffPw) {
  // Guard against accidental data destruction — audit_log and all tables are
  // wiped in a single transaction. Requiring an explicit env var prevents
  // someone from running `npm run seed` on production by mistake.
  // Normalize NODE_ENV the same way app.js does (trim + lowercase) so the
  // guard cannot be bypassed by case/whitespace variants (e.g. NODE_ENV="Production "):
  // app.js treats those as production, so seeding must refuse to run too —
  // otherwise a programmatic caller could wipe data in an environment the rest
  // of the app considers production. The CLI path below already normalizes for
  // its own early-exit; this keeps runSeed() itself safe for any caller.
  const env = (!process.env.NODE_ENV ? 'development' : process.env.NODE_ENV.trim().toLowerCase());
  if (env === 'production' && process.env.SEED_DANGER !== '1') {
    throw new Error(
      'Seeding in production is disabled. Set SEED_DANGER=1 to override.'
    );
  }

  const SEED_ADMIN_PW = adminPw || (process.env.SEED_ADMIN_PASSWORD || '').trim() || _generateSeedPassword('SEED_ADMIN_PASSWORD');
  const SEED_STAFF_PW = staffPw || (process.env.SEED_PASSWORD || '').trim() || _generateSeedPassword('SEED_PASSWORD');
  _seedTransaction(db, SEED_ADMIN_PW, SEED_STAFF_PW);
  return { SEED_ADMIN_PW, SEED_STAFF_PW };
}

// Execute the transaction when run directly
if (require.main === module) {
  // Honor the same SEED_DANGER=1 override runSeed() documents — the CLI is
  // the only user-facing entry point (npm run seed), so an unconditional
  // early-exit here would make runSeed's own override instruction unfollowable.
  const env = (!process.env.NODE_ENV ? 'development' : process.env.NODE_ENV.trim().toLowerCase());
  if (env === 'production' && process.env.SEED_DANGER !== '1') {
    console.error('ERROR: Refusing to seed database in production');
    process.exit(1);
  }

  const db = require('./models/database');

  console.log('Seeding database...\n');

  try {
    const { SEED_ADMIN_PW, SEED_STAFF_PW } = runSeed(db);
    console.log('\nSeeding complete!\n');
    const adminIsGenerated = !(process.env.SEED_ADMIN_PASSWORD || '').trim();
    const staffIsGenerated = !(process.env.SEED_PASSWORD || '').trim();
    const anyGenerated = adminIsGenerated || staffIsGenerated;
    if (process.env.SEED_VERBOSE === '1' || process.env.SEED_VERBOSE === 'true') {
      if (anyGenerated) {
        const lines = ['Default login credentials:'];
        if (adminIsGenerated) {
          lines.push('  Admin:    admin / ' + SEED_ADMIN_PW);
        }
        if (staffIsGenerated) {
          lines.push('  Manager:  jwilliams / ' + SEED_STAFF_PW);
          lines.push('  Staff:    mpatel / ' + SEED_STAFF_PW);
        }
        console.log(lines.join('\n') + '\n');
      }
    } else if (anyGenerated) {
      console.log('One or more seed passwords were auto-generated. Re-run with SEED_VERBOSE=1 to display them.\n');
    }
  } catch (err) {
    console.error('Seeding failed:', (err && err.message) || String(err));
    process.exitCode = 1;
    // Still close on failure — the script owns this handle for its whole
    // lifetime (it opened the shared module here, nothing else is running in
    // this process), and leaving it open keeps the event loop blocked.
    // (The CLI production guard above exits BEFORE the db is required, so
    // the only in-try failures are genuine seeding failures — always close.)
  } finally {
    db.close();
  }
}

module.exports = { runSeed };
