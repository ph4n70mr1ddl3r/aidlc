require('dotenv').config();

if (process.env.NODE_ENV) {
  process.env.NODE_ENV = process.env.NODE_ENV.toLowerCase();
}
if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: Refusing to seed database in production');
  process.exit(1);
}

const db = require('./models/database');
const bcrypt = require('bcryptjs');

// Seed passwords: prefer env vars, otherwise generate strong random passwords.
// NEVER hardcode default passwords — they would be visible to everyone with repo access.
const crypto = require('crypto');

function _generateSeedPassword(label) {
  const pw = crypto.randomBytes(12).toString('base64') + 'Aa1!';
  console.warn(`WARNING: No ${label} set via environment. Generated random password: ${pw}`);
  console.warn(`  Set ${label} in .env to suppress this warning and use a fixed password.`);
  return pw;
}

const SEED_ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || _generateSeedPassword('SEED_ADMIN_PASSWORD');
const SEED_STAFF_PW = process.env.SEED_PASSWORD || _generateSeedPassword('SEED_PASSWORD');

console.log('Seeding database...\n');

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
    DELETE FROM audit_log;
    DELETE FROM users;
    DELETE FROM ticket_counter;
    DELETE FROM sqlite_sequence WHERE name IN ('users','assets','licenses','tickets','ticket_comments','projects','project_tasks','project_members','vendors','knowledge_articles','change_log','audit_log');
  `);

  // ========================
  // USERS
  // ========================
  const users = [
    { username: 'admin', password: SEED_ADMIN_PW, email: 'admin@company.com', first_name: 'Sarah', last_name: 'Chen', role: 'admin', department: 'IT', phone: '555-0101' },
    { username: 'jwilliams', password: SEED_STAFF_PW, email: 'j.williams@company.com', first_name: 'James', last_name: 'Williams', role: 'manager', department: 'IT', phone: '555-0102' },
    { username: 'mpatel', password: SEED_STAFF_PW, email: 'm.patel@company.com', first_name: 'Maya', last_name: 'Patel', role: 'staff', department: 'IT', phone: '555-0103' },
    { username: 'trodriguez', password: SEED_STAFF_PW, email: 't.rodriguez@company.com', first_name: 'Tomás', last_name: 'Rodriguez', role: 'staff', department: 'IT', phone: '555-0104' },
    { username: 'akimura', password: SEED_STAFF_PW, email: 'a.kimura@company.com', first_name: 'Aiko', last_name: 'Kimura', role: 'staff', department: 'IT', phone: '555-0105' },
    { username: 'dmuller', password: SEED_STAFF_PW, email: 'd.muller@company.com', first_name: 'Dieter', last_name: 'Müller', role: 'staff', department: 'IT', phone: '555-0106' }
  ];

  const insertUser = db.prepare(`
    INSERT INTO users (username, password, email, first_name, last_name, role, department, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const u of users) {
    const hash = bcrypt.hashSync(u.password, 12);
    insertUser.run(u.username, hash, u.email, u.first_name, u.last_name, u.role, u.department, u.phone);
  }
  console.log(`✅ Created ${users.length} users`);

  // ========================
  // ASSETS
  // ========================
  const assets = [
    { asset_tag: 'AST-001', name: 'MacBook Pro 16"', category: 'laptop', manufacturer: 'Apple', model: 'M3 Max', serial_number: 'SN-APL-001', status: 'in_use', condition_rating: 'new', purchase_date: '2025-01-15', purchase_price: 3499, warranty_expiry: '2028-01-15', assigned_to: 1, location: 'HQ Office' },
    { asset_tag: 'AST-002', name: 'Dell OptiPlex 7090', category: 'desktop', manufacturer: 'Dell', model: '7090 SFF', serial_number: 'SN-DEL-002', status: 'in_use', condition_rating: 'good', purchase_date: '2023-06-20', purchase_price: 1299, warranty_expiry: '2026-06-20', assigned_to: 2, location: 'HQ Office' },
    { asset_tag: 'AST-003', name: 'ThinkPad X1 Carbon', category: 'laptop', manufacturer: 'Lenovo', model: 'Gen 11', serial_number: 'SN-LEN-003', status: 'in_use', condition_rating: 'good', purchase_date: '2023-09-10', purchase_price: 1899, warranty_expiry: '2026-09-10', assigned_to: 3, location: 'Remote' },
    { asset_tag: 'AST-004', name: 'HP ProLiant DL380', category: 'server', manufacturer: 'HP', model: 'DL380 Gen10', serial_number: 'SN-HP-004', status: 'in_use', condition_rating: 'good', purchase_date: '2022-03-15', purchase_price: 8999, warranty_expiry: '2025-03-15', assigned_to: null, location: 'Data Center A' },
    { asset_tag: 'AST-005', name: 'Dell PowerEdge R740', category: 'server', manufacturer: 'Dell', model: 'R740', serial_number: 'SN-DEL-005', status: 'in_use', condition_rating: 'good', purchase_date: '2022-08-22', purchase_price: 12500, warranty_expiry: '2025-08-22', assigned_to: null, location: 'Data Center A' },
    { asset_tag: 'AST-006', name: 'Cisco Catalyst 9300', category: 'network', manufacturer: 'Cisco', model: 'C9300-48T', serial_number: 'SN-CSC-006', status: 'in_use', condition_rating: 'good', purchase_date: '2023-01-10', purchase_price: 6500, warranty_expiry: '2026-01-10', assigned_to: null, location: 'Server Room' },
    { asset_tag: 'AST-007', name: 'HP LaserJet Pro', category: 'printer', manufacturer: 'HP', model: 'M404dn', serial_number: 'SN-HP-007', status: 'in_storage', condition_rating: 'fair', purchase_date: '2020-11-05', purchase_price: 399, warranty_expiry: '2023-11-05', assigned_to: null, location: 'Storage Room B' },
    { asset_tag: 'AST-008', name: 'Dell UltraSharp 27"', category: 'monitor', manufacturer: 'Dell', model: 'U2723QE', serial_number: 'SN-DEL-008', status: 'in_use', condition_rating: 'new', purchase_date: '2024-02-14', purchase_price: 619, warranty_expiry: '2027-02-14', assigned_to: 4, location: 'HQ Office' },
    { asset_tag: 'AST-009', name: 'iPhone 15 Pro', category: 'phone', manufacturer: 'Apple', model: 'A2848', serial_number: 'SN-APL-009', status: 'in_use', condition_rating: 'good', purchase_date: '2024-09-22', purchase_price: 1199, warranty_expiry: '2026-09-22', assigned_to: 1, location: 'HQ Office' },
    { asset_tag: 'AST-010', name: 'Surface Pro 9', category: 'tablet', manufacturer: 'Microsoft', model: 'QEZ-00001', serial_number: 'SN-MSF-010', status: 'in_repair', condition_rating: 'fair', purchase_date: '2023-04-18', purchase_price: 1599, warranty_expiry: '2025-04-18', assigned_to: 5, location: 'Repair Shop' },
    { asset_tag: 'AST-011', name: 'MacBook Air M2', category: 'laptop', manufacturer: 'Apple', model: 'MLY33LL/A', serial_number: 'SN-APL-011', status: 'in_use', condition_rating: 'good', purchase_date: '2024-01-08', purchase_price: 1299, warranty_expiry: '2027-01-08', assigned_to: 5, location: 'HQ Office' },
    { asset_tag: 'AST-012', name: 'Logitech MX Keys', category: 'peripheral', manufacturer: 'Logitech', model: 'MX Keys Advanced', serial_number: 'SN-LOG-012', status: 'in_storage', condition_rating: 'new', purchase_date: '2025-02-01', purchase_price: 119, warranty_expiry: '2027-02-01', assigned_to: null, location: 'Storage Room A' }
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
  // Initialize asset counter to prevent AST-001 collision with the next created asset
  const initAssetCounter = db.prepare('INSERT INTO asset_counter (counter_key, next_seq) VALUES (\'asset_tag\', ?) ON CONFLICT(counter_key) DO UPDATE SET next_seq = ?');
  initAssetCounter.run(assets.length, assets.length);
  console.log(`✅ Created ${assets.length} assets`);

  // ========================
  // LICENSES
  // ========================
  const licenses = [
    { software_name: 'Microsoft 365 E3', vendor: 'Microsoft', license_key: 'MS365-E3-VOL-001', license_type: 'subscription', total_seats: 200, used_seats: 187, purchase_date: '2025-01-01', expiry_date: '2026-01-01', cost: 28000 },
    { software_name: 'Adobe Creative Cloud', vendor: 'Adobe', license_key: 'ADB-CC-ENT-050', license_type: 'subscription', total_seats: 50, used_seats: 42, purchase_date: '2025-03-01', expiry_date: '2026-03-01', cost: 15000 },
    { software_name: 'Jira Software', vendor: 'Atlassian', license_key: 'ATL-JIRA-500', license_type: 'subscription', total_seats: 500, used_seats: 323, purchase_date: '2024-07-01', expiry_date: '2025-07-01', cost: 18000 },
    { software_name: 'Windows Server 2022', vendor: 'Microsoft', license_key: 'MS-WS2022-DATA', license_type: 'perpetual', total_seats: 10, used_seats: 8, purchase_date: '2022-05-15', expiry_date: null, cost: 6200 },
    { software_name: 'VMware vSphere', vendor: 'Broadcom', license_key: 'VMW-VSP-ENT-020', license_type: 'perpetual', total_seats: 3, used_seats: 3, purchase_date: '2023-11-01', expiry_date: null, cost: 12500 },
    { software_name: 'CrowdStrike Falcon', vendor: 'CrowdStrike', license_key: 'CS-FALC-EP-500', license_type: 'subscription', total_seats: 500, used_seats: 480, purchase_date: '2025-01-15', expiry_date: '2026-01-15', cost: 35000 },
    { software_name: 'Slack Business+', vendor: 'Salesforce', license_key: 'SLK-BIZ-0300', license_type: 'subscription', total_seats: 300, used_seats: 287, purchase_date: '2025-02-01', expiry_date: '2026-02-01', cost: 10800 }
  ];

  const insertLicense = db.prepare(`
    INSERT INTO licenses (software_name, vendor, license_key, license_type, total_seats, used_seats, purchase_date, expiry_date, cost, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const l of licenses) {
    insertLicense.run(l.software_name, l.vendor, l.license_key, l.license_type, l.total_seats,
      l.used_seats, l.purchase_date, l.expiry_date, l.cost, '');
  }
  console.log(`✅ Created ${licenses.length} licenses`);

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
      requester_name, requester_email, requester_department, assigned_to, asset_id, due_date, resolution_notes, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date();
  const today = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const insertCounter = db.prepare('INSERT INTO ticket_counter (counter_date, next_seq) VALUES (?, ?)');
  tickets.forEach((t, i) => {
    const num = `TK-${today}-${String(i + 1).padStart(3, '0')}`;
    const resolvedAt = t.status === 'resolved' || t.status === 'closed'
      ? new Date(Date.now() - 86400000).toISOString().replace('T', ' ').slice(0, 19)
      : null;
    insertTicket.run(num, t.title, t.description, t.category, t.priority, t.status,
      t.requester_name, t.requester_email, t.requester_department, t.assigned_to,
      t.asset_id || null, t.due_date || null, t.resolution_notes || null, resolvedAt);
  });
  insertCounter.run(today, tickets.length);
  console.log(`✅ Created ${tickets.length} tickets`);

  // ========================
  // PROJECTS
  // ========================
  const projects = [
    { name: 'Cloud Migration Phase 2', description: 'Migrate remaining on-premises workloads to AWS. Includes database migration and CDN setup.', status: 'in_progress', priority: 'high', start_date: '2026-01-15', end_date: '2026-08-30', budget: 150000, spent: 45000, progress: 35, owner_id: 2 },
    { name: 'Zero Trust Network Implementation', description: 'Implement Zero Trust security architecture across all network segments.', status: 'planning', priority: 'critical', start_date: '2026-06-01', end_date: '2026-12-31', budget: 200000, spent: 5000, progress: 5, owner_id: 2 },
    { name: 'IT Service Desk Upgrade', description: 'Migrate from legacy ticketing system to modern ITSM platform with automation.', status: 'in_progress', priority: 'medium', start_date: '2026-03-01', end_date: '2026-07-31', budget: 50000, spent: 32000, progress: 65, owner_id: 3 },
    { name: 'Office 365 Copilot Rollout', description: 'Deploy Microsoft Copilot to all departments with training and governance policies.', status: 'planning', priority: 'high', start_date: '2026-07-01', end_date: '2026-09-30', budget: 75000, spent: 0, progress: 0, owner_id: 1 },
    { name: 'Data Center Cooling Upgrade', description: 'Replace aging HVAC units in Data Center A with efficient cooling system.', status: 'completed', priority: 'high', start_date: '2026-02-01', end_date: '2026-04-30', budget: 85000, spent: 82000, progress: 100, owner_id: 6 }
  ];

  const insertProject = db.prepare(`
    INSERT INTO projects (name, description, status, priority, start_date, end_date, budget, spent, progress, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const p of projects) {
    insertProject.run(p.name, p.description, p.status, p.priority, p.start_date, p.end_date,
      p.budget, p.spent, p.progress, p.owner_id);
  }
  console.log(`✅ Created ${projects.length} projects`);

  // Project tasks
  const tasks = [
    { project_id: 1, title: 'Assessment of current workloads', description: 'Document all on-prem workloads and dependencies', status: 'done', priority: 'high', assigned_to: 3, due_date: '2026-02-15', completed_at: '2026-02-14' },
    { project_id: 1, title: 'AWS Landing Zone setup', description: 'Configure multi-account AWS environment', status: 'done', priority: 'high', assigned_to: 6, due_date: '2026-03-01', completed_at: '2026-02-28' },
    { project_id: 1, title: 'Database migration planning', description: 'Plan PostgreSQL to RDS migration strategy', status: 'in_progress', priority: 'high', assigned_to: 3, due_date: '2026-05-15' },
    { project_id: 1, title: 'CDN configuration', description: 'Set up CloudFront distributions', status: 'todo', priority: 'medium', assigned_to: 6, due_date: '2026-06-01' },
    { project_id: 1, title: 'Testing & validation', description: 'Full regression testing of migrated workloads', status: 'todo', priority: 'high', assigned_to: 4, due_date: '2026-07-15' },
    { project_id: 3, title: 'Vendor evaluation', description: 'Evaluate ServiceNow vs Jira Service Management', status: 'done', priority: 'high', assigned_to: 3, due_date: '2026-03-15', completed_at: '2026-03-14' },
    { project_id: 3, title: 'Data migration scripts', description: 'Write scripts to migrate data from old system', status: 'done', priority: 'high', assigned_to: 5, due_date: '2026-04-30', completed_at: '2026-04-29' },
    { project_id: 3, title: 'Workflow automation setup', description: 'Configure automated workflows and SLAs', status: 'in_progress', priority: 'medium', assigned_to: 3, due_date: '2026-06-15' },
    { project_id: 3, title: 'Staff training', description: 'Train IT staff on new platform', status: 'todo', priority: 'medium', assigned_to: 4, due_date: '2026-07-15' }
  ];

  const insertTask = db.prepare(`
    INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, due_date, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const t of tasks) {
    insertTask.run(t.project_id, t.title, t.description, t.status, t.priority, t.assigned_to, t.due_date, t.completed_at || null);
  }
  console.log(`✅ Created ${tasks.length} project tasks`);

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
  console.log(`✅ Created ${projectMembers.length} project memberships`);

  // ========================
  // VENDORS
  // ========================
  const vendors = [
    { name: 'Dell Technologies', contact_person: 'Mike Thompson', email: 'mike.t@dell.com', phone: '800-555-1234', category: 'hardware', contract_start: '2024-01-01', contract_end: '2026-12-31', rating: 4 },
    { name: 'Amazon Web Services', contact_person: 'Jennifer Liu', email: 'j.liu@aws.amazon.com', phone: '800-555-2345', category: 'cloud', contract_start: '2025-01-01', contract_end: '2027-12-31', rating: 5 },
    { name: 'CrowdStrike', contact_person: 'Alex Rivera', email: 'a.rivera@crowdstrike.com', phone: '800-555-3456', category: 'security', contract_start: '2025-01-15', contract_end: '2026-01-15', rating: 4 },
    { name: 'Cisco Systems', contact_person: 'Patricia Nguyen', email: 'p.nguyen@cisco.com', phone: '800-555-4567', category: 'network', contract_start: '2023-06-01', contract_end: '2026-06-01', rating: 5 },
    { name: 'TechCorp Support', contact_person: 'Frank Miller', email: 'f.miller@techcorp.com', phone: '800-555-5678', category: 'maintenance', contract_start: '2024-03-01', contract_end: '2025-03-01', rating: 3 }
  ];

  const insertVendor = db.prepare(`
    INSERT INTO vendors (name, contact_person, email, phone, category, contract_start, contract_end, rating, notes, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  for (const v of vendors) {
    insertVendor.run(v.name, v.contact_person, v.email, v.phone, v.category,
      v.contract_start, v.contract_end, v.rating, '');
  }
  console.log(`✅ Created ${vendors.length} vendors`);

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
  console.log(`✅ Created ${articles.length} knowledge articles`);

  // ========================
  // CHANGE LOG
  // ========================
  const changes = [
    { title: 'Firewall Rule Update - Block New Threat IPs', description: 'Update firewall rules to block newly identified threat actor IP ranges.', change_type: 'security', status: 'completed', priority: 'critical', scheduled_start: '2026-05-20 02:00:00', scheduled_end: '2026-05-20 03:00:00', actual_start: '2026-05-20 02:00:00', actual_end: '2026-05-20 02:35:00', impact: 'No user impact expected', assigned_to: 6 },
    { title: 'Exchange Server Patching', description: 'Install latest security patches for on-prem Exchange servers.', change_type: 'maintenance', status: 'scheduled', priority: 'high', scheduled_start: '2026-05-25 22:00:00', scheduled_end: '2026-05-26 02:00:00', impact: 'Email may be unavailable for up to 30 minutes during failover', assigned_to: 6 },
    { title: 'Network Switch Firmware Upgrade', description: 'Upgrade firmware on core switches to fix VLAN routing issues.', change_type: 'upgrade', status: 'scheduled', priority: 'high', scheduled_start: '2026-06-01 06:00:00', scheduled_end: '2026-06-01 08:00:00', impact: 'Brief network interruptions possible during failover', assigned_to: 3 },
    { title: 'Active Directory Schema Update', description: 'Apply schema extension for new MFA attributes.', change_type: 'configuration', status: 'scheduled', priority: 'medium', scheduled_start: '2026-06-05 21:00:00', scheduled_end: '2026-06-05 22:00:00', impact: 'AD replication delay possible', assigned_to: 2 },
    { title: 'Storage Array Maintenance', description: 'Replace failed drive in SAN array Bay 7.', change_type: 'maintenance', status: 'completed', priority: 'medium', scheduled_start: '2026-05-18 23:00:00', scheduled_end: '2026-05-19 01:00:00', actual_start: '2026-05-18 23:00:00', actual_end: '2026-05-18 23:45:00', impact: 'No impact - hot spare active', assigned_to: 6 }
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
  console.log(`✅ Created ${changes.length} change records`);

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
  console.log(`✅ Created ${comments.length} ticket comments`);
});

// Execute the transaction — ensure db.close() runs even if seed fails
try {
  seed();
  console.log('\n🎉 Seeding complete!\n');
  console.log('Default login credentials:');
  console.log('  Admin:    admin / ' + SEED_ADMIN_PW);
  console.log('  Manager:  jwilliams / ' + SEED_STAFF_PW);
  console.log('  Staff:    mpatel / ' + SEED_STAFF_PW + '\n');
} catch (err) {
  console.error('Seeding failed:', err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
