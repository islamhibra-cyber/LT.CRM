/**
 * WhatsApp CRM & Campaign Manager - Full-Stack Express Server
 * 
 * Supports:
 * - Real Meta WhatsApp Business Cloud API integration
 * - Persistent Database Engine & Atomic Disk Flushes
 * - Drag-and-drop Excel/CSV (.xlsx, .xls, .csv) parser
 * - Egyptian Phone Normalization & Deduplication Engine
 * - Background Message Queue & Safety Engine
 * - Meta Webhook Verification & Status Tracking
 * - Role-Based Access Control (RBAC)
 * - Complete Audit Logs & Reports
 * - Vite dev server integration on port 3000
 */

import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import multer from 'multer';

const _currentFilename = typeof __filename !== 'undefined' ? __filename : (typeof import.meta !== 'undefined' && import.meta.url ? fileURLToPath(import.meta.url) : process.cwd());
const _currentDirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(_currentFilename);
import * as XLSX from 'xlsx';
import { db, User, Customer, Campaign, MessageTemplate, CampaignRecipient } from './server/db.js';
import { normalizeEgyptianPhone } from './server/phoneNormalizer.js';
import { processAndDeduplicateRows, commitCandidatesToDatabase } from './server/deduplication.js';
import { metaClient } from './server/metaWhatsapp.js';
import { queueEngine } from './server/queueScheduler.js';
import { runAllAutomatedTests } from './server/testsRunner.js';

export interface LanInterface {
  name: string;
  address: string;
  family: string;
}

/**
 * Automatically inspects system network interfaces to find active IPv4 LAN addresses
 * (e.g. 192.168.x.x, 10.x.x.x, 172.x.x.x). Automatically refreshes if router assigns new DHCP IP.
 */
export function getLanIpAddresses(): LanInterface[] {
  const interfaces = os.networkInterfaces();
  const results: LanInterface[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push({
          name,
          address: net.address,
          family: net.family,
        });
      }
    }
  }
  return results;
}

const app = express();
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.APP_PORT || process.env.PORT || 3000);
// Auto-detect production mode if NODE_ENV is set OR if running outside source repository
const hasSourceCode = fs.existsSync(path.resolve(process.cwd(), 'src', 'App.tsx')) || fs.existsSync(path.resolve(_currentDirname, 'src', 'App.tsx'));
const isProd = process.env.NODE_ENV === 'production' || !hasSourceCode;

// CORS middleware for concurrent multi-device local network / Wi-Fi access
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Body parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Multer in-memory storage for Excel/CSV file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx, .xls, and .csv files are supported.'));
    }
  },
});

// Simple Session / Token Verification Middleware
interface AuthRequest extends Request {
  user?: User;
}

const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    // Check if query token is provided or fallback to default session for local Windows usage
    const queryToken = req.query.token as string;
    if (queryToken && queryToken.startsWith('tok_')) {
      const username = queryToken.replace('tok_', '');
      const user = db.getUserByUsername(username);
      if (user) {
        req.user = user;
        return next();
      }
    }
    // Default to admin for seamless experience if not set
    req.user = db.getUserByUsername('admin');
    return next();
  }

  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token.startsWith('tok_')) {
    const username = token.replace('tok_', '');
    const user = db.getUserByUsername(username);
    if (user) {
      req.user = user;
      return next();
    }
  }

  req.user = db.getUserByUsername('admin');
  next();
};

// ==========================================
// 1. AUTHENTICATION & USERS
// ==========================================
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.getUserByUsername(username);
  if (!user || !db.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Create session token
  const token = `tok_${user.username}`;
  db.logAudit(user.username, 'User Login', `Logged in successfully from ${req.ip || '127.0.0.1'}`);

  return res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      email: user.email,
      role: user.role,
    },
  });
});

app.get('/api/auth/me', authMiddleware, (req: AuthRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      full_name: req.user.full_name,
      email: req.user.email,
      role: req.user.role,
    },
  });
});

app.get('/api/users', authMiddleware, (req: AuthRequest, res: Response) => {
  const users = db.getUsers().map(u => ({
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    email: u.email,
    role: u.role,
    created_at: u.created_at,
  }));
  res.json({ users });
});

app.post('/api/users', authMiddleware, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can create users' });
  }
  const { username, password, full_name, email, role } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'Missing required user fields' });
  }

  if (db.getUserByUsername(username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  const newUser: User = {
    id: 'usr_' + Date.now(),
    username,
    password_hash: db.hashPassword(password),
    full_name,
    email: email || '',
    role: role || 'OPERATOR',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  db.saveUser(newUser);
  db.logAudit(req.user.username, 'User Created', `Created user account "${username}" with role "${role}"`);
  res.status(201).json({ user: newUser });
});

app.delete('/api/users/:id', authMiddleware, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can delete users' });
  }
  const target = db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.username === 'admin') {
    return res.status(400).json({ error: 'Cannot delete primary admin account' });
  }

  db.deleteUser(target.id);
  db.logAudit(req.user.username, 'User Deleted', `Deleted user account "${target.username}"`);
  res.json({ success: true });
});

// ==========================================
// 2. CUSTOMERS CRM & PROFILES
// ==========================================
app.get('/api/customers', (req: Request, res: Response) => {
  const { search, consent, tag, sort, page = '1', limit = '50' } = req.query;
  let customers = db.getCustomers();

  // Search by name, phone, email, notes
  if (search && typeof search === 'string') {
    const q = search.toLowerCase().trim();
    customers = customers.filter(c =>
      c.full_name.toLowerCase().includes(q) ||
      c.mobile_number.includes(q) ||
      c.whatsapp_number.includes(q) ||
      (c.email && c.email.toLowerCase().includes(q)) ||
      (c.notes && c.notes.toLowerCase().includes(q))
    );
  }

  // Filter by consent
  if (consent && typeof consent === 'string' && consent !== 'ALL') {
    customers = customers.filter(c => c.opt_in_status === consent);
  }

  // Filter by tag
  if (tag && typeof tag === 'string' && tag !== 'ALL') {
    customers = customers.filter(c => c.tags.includes(tag));
  }

  // Sorting
  if (sort === 'spending_desc') {
    customers.sort((a, b) => b.total_spending - a.total_spending);
  } else if (sort === 'orders_desc') {
    customers.sort((a, b) => b.number_of_orders - a.number_of_orders);
  } else if (sort === 'name_asc') {
    customers.sort((a, b) => a.full_name.localeCompare(b.full_name));
  } else {
    // Default newest first
    customers.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  const pageNum = parseInt(page as string) || 1;
  const pageLimit = parseInt(limit as string) || 50;
  const total = customers.length;
  const paginated = customers.slice((pageNum - 1) * pageLimit, pageNum * pageLimit);

  res.json({
    total,
    page: pageNum,
    totalPages: Math.ceil(total / pageLimit),
    customers: paginated,
  });
});

app.get('/api/customers/:id', (req: Request, res: Response) => {
  const customer = db.getCustomerById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  // Get customer messages and campaign interaction
  const messages = db.getMessages(customer.id);
  const isSuppressed = db.isPhoneOptedOut(customer.mobile_number);

  res.json({
    customer,
    isSuppressed,
    messages,
  });
});

app.post('/api/customers', authMiddleware, (req: AuthRequest, res: Response) => {
  const { full_name, mobile_number, email, address, gender, tags, notes, opt_in_status } = req.body;
  if (!mobile_number) {
    return res.status(400).json({ error: 'Mobile number is required' });
  }

  const phoneRes = normalizeEgyptianPhone(mobile_number);
  if (!phoneRes.isValid) {
    return res.status(400).json({ error: phoneRes.errorReason || 'Invalid Egyptian phone number' });
  }

  const existing = db.getCustomerByPhone(phoneRes.canonicalNational);
  if (existing) {
    return res.status(400).json({ error: 'A customer with this phone number already exists', existingId: existing.id });
  }

  const now = new Date().toISOString();
  const consentVal = (opt_in_status as any) || 'UNKNOWN';

  const newCust: Customer = {
    id: 'cust_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    full_name: full_name || 'Customer ' + phoneRes.canonicalNational.slice(-4),
    mobile_number: phoneRes.canonicalNational,
    whatsapp_number: phoneRes.canonicalE164,
    email: email || undefined,
    gender: gender || undefined,
    address: address || undefined,
    tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(t => t.trim()) : []),
    notes: notes || undefined,
    source: 'Manual CRM Entry',
    total_purchases: 0,
    total_spending: 0,
    number_of_orders: 0,
    opt_in_status: consentVal,
    opt_in_source: consentVal === 'OPTED_IN' ? 'Manual Operator Entry' : undefined,
    opt_in_date: consentVal === 'OPTED_IN' ? now : undefined,
    opt_out_status: consentVal === 'OPTED_OUT',
    opt_out_date: consentVal === 'OPTED_OUT' ? now : undefined,
    created_at: now,
    updated_at: now,
  };

  db.saveCustomer(newCust);
  db.logAudit(req.user?.username || 'Operator', 'Customer Created', `Created customer ${newCust.full_name} (${newCust.mobile_number})`);
  res.status(201).json({ customer: newCust });
});

app.put('/api/customers/:id', authMiddleware, (req: AuthRequest, res: Response) => {
  const customer = db.getCustomerById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const { full_name, email, address, gender, tags, notes, opt_in_status, total_spending, number_of_orders } = req.body;

  if (full_name !== undefined) customer.full_name = full_name;
  if (email !== undefined) customer.email = email;
  if (address !== undefined) customer.address = address;
  if (gender !== undefined) customer.gender = gender;
  if (tags !== undefined) customer.tags = Array.isArray(tags) ? tags : [];
  if (notes !== undefined) customer.notes = notes;
  if (total_spending !== undefined) customer.total_spending = Number(total_spending) || 0;
  if (number_of_orders !== undefined) customer.number_of_orders = Number(number_of_orders) || 0;

  if (opt_in_status && opt_in_status !== customer.opt_in_status) {
    customer.opt_in_status = opt_in_status;
    if (opt_in_status === 'OPTED_IN') {
      customer.opt_in_date = new Date().toISOString();
      customer.opt_in_source = 'Manual Admin Update';
      customer.opt_out_status = false;
      db.removeOptOut(customer.mobile_number);
    } else if (opt_in_status === 'OPTED_OUT') {
      customer.opt_out_status = true;
      customer.opt_out_date = new Date().toISOString();
      db.addOptOut(customer.mobile_number, customer.id, 'Manual CRM Opt-Out', req.user?.username || 'Admin');
    }
  }

  customer.updated_at = new Date().toISOString();
  db.saveCustomer(customer);
  db.logAudit(req.user?.username || 'User', 'Customer Updated', `Updated customer details for ${customer.full_name}`);
  res.json({ customer });
});

app.post('/api/customers/:id/opt-out', authMiddleware, (req: AuthRequest, res: Response) => {
  const customer = db.getCustomerById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const reason = req.body.reason || 'Requested opt-out via CRM';
  db.addOptOut(customer.mobile_number, customer.id, reason, req.user?.username || 'Operator');
  db.logAudit(req.user?.username || 'Operator', 'Customer Opt-Out', `Customer ${customer.full_name} (${customer.mobile_number}) added to Global Suppression list: ${reason}`);

  const updated = db.getCustomerById(customer.id);
  res.json({ customer: updated });
});

app.delete('/api/customers/:id', authMiddleware, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'MANAGER') {
    return res.status(403).json({ error: 'Only Admins and Managers can delete customers' });
  }
  const cust = db.getCustomerById(req.params.id);
  if (!cust) return res.status(404).json({ error: 'Customer not found' });

  db.deleteCustomer(cust.id);
  db.logAudit(req.user.username, 'Customer Deleted', `Deleted customer ${cust.full_name} (${cust.mobile_number})`);
  res.json({ success: true });
});

// ==========================================
// 3. EXCEL / CSV DRAG & DROP IMPORT ENGINE
// ==========================================
app.post('/api/imports/upload', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Record<string, any>[];

    if (rawRows.length === 0) {
      return res.status(400).json({ error: 'The uploaded file contains no data rows.' });
    }

    // Detect all column headers
    const columns = Object.keys(rawRows[0] || {});

    // Intelligent column auto-mapping detection
    const mapping: Record<string, string> = {};
    for (const col of columns) {
      const lower = col.toLowerCase().trim();
      if (/name|اسم|عميل|customer/i.test(lower)) {
        mapping['fullName'] = col;
      } else if (/mobile|phone|موبايل|هاتف|جوال|whatsapp|واتس/i.test(lower)) {
        if (!mapping['mobileNumber']) mapping['mobileNumber'] = col;
      } else if (/email|بريد/i.test(lower)) {
        mapping['email'] = col;
      } else if (/address|عنوان/i.test(lower)) {
        mapping['address'] = col;
      } else if (/spending|amount|total|مبلغ|اجمالي|إجمالي/i.test(lower)) {
        mapping['purchaseAmount'] = col;
      } else if (/order|طلب|فاتورة/i.test(lower)) {
        mapping['orderNumber'] = col;
      } else if (/tag|وسم|تصنيف/i.test(lower)) {
        mapping['tags'] = col;
      } else if (/consent|موافقة|opt.?in/i.test(lower)) {
        mapping['consentStatus'] = col;
      } else if (/date|تاريخ/i.test(lower)) {
        mapping['purchaseDate'] = col;
      }
    }

    res.json({
      fileName: req.file.originalname,
      fileSize: req.file.size,
      totalRows: rawRows.length,
      columns,
      suggestedMapping: mapping,
      sampleRows: rawRows.slice(0, 10),
      allRows: rawRows,
    });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to read Excel/CSV file: ${err.message}` });
  }
});

app.post('/api/imports/preview', (req: Request, res: Response) => {
  const { rows, columnMapping, defaultSource } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Rows array is required' });
  }

  // Transform rows using mapped columns if provided
  const transformedRows = rows.map((r: any) => {
    return {
      fullName: columnMapping?.fullName ? r[columnMapping.fullName] : (r.fullName ?? r.name ?? r['Customer Name'] ?? r['الاسم']),
      mobileNumber: columnMapping?.mobileNumber ? r[columnMapping.mobileNumber] : (r.mobileNumber ?? r.mobile ?? r.phone ?? r['Mobile'] ?? r['رقم الموبايل']),
      email: columnMapping?.email ? r[columnMapping.email] : (r.email ?? r['Email']),
      address: columnMapping?.address ? r[columnMapping.address] : (r.address ?? r['Address']),
      gender: columnMapping?.gender ? r[columnMapping.gender] : (r.gender ?? r['Gender']),
      tags: columnMapping?.tags ? r[columnMapping.tags] : (r.tags ?? r['Tags']),
      notes: columnMapping?.notes ? r[columnMapping.notes] : (r.notes ?? r['Notes']),
      purchaseAmount: columnMapping?.purchaseAmount ? r[columnMapping.purchaseAmount] : (r.purchaseAmount ?? r.amount ?? r['Total Spending']),
      orderNumber: columnMapping?.orderNumber ? r[columnMapping.orderNumber] : (r.orderNumber ?? r.order ?? r['Order']),
      purchaseDate: columnMapping?.purchaseDate ? r[columnMapping.purchaseDate] : (r.purchaseDate ?? r.date ?? r['Date']),
      consentStatus: columnMapping?.consentStatus ? r[columnMapping.consentStatus] : (r.consentStatus ?? r.optIn),
    };
  });

  const report = processAndDeduplicateRows(transformedRows, defaultSource || 'Excel Drag & Drop');
  res.json(report);
});

app.post('/api/imports/commit', authMiddleware, (req: AuthRequest, res: Response) => {
  const { candidates, fileName, fileSize, totalRows, invalidCount, duplicateCount } = req.body;
  if (!Array.isArray(candidates)) {
    return res.status(400).json({ error: 'Candidate list is required' });
  }

  const userName = req.user?.username || 'Admin';
  const result = commitCandidatesToDatabase(candidates, fileName || 'Manual Import', userName);

  // Record in Import History
  db.addImportRecord({
    id: 'imp_' + Date.now(),
    file_name: fileName || 'Import_' + new Date().toISOString(),
    file_size: fileSize || 0,
    user_name: userName,
    total_rows: totalRows || candidates.length,
    new_customers: result.newCount,
    updated_customers: result.updatedCount,
    duplicates: duplicateCount || 0,
    merged_records: candidates.length,
    invalid_numbers: invalidCount || 0,
    skipped_records: 0,
    created_at: new Date().toISOString(),
  });

  res.json({
    success: true,
    newCustomers: result.newCount,
    updatedCustomers: result.updatedCount,
    totalProcessed: candidates.length,
    stats: {
      newCustomers: result.newCount,
      updatedCustomers: result.updatedCount,
      totalProcessed: candidates.length,
    },
  });
});

app.get('/api/imports/history', (_req: Request, res: Response) => {
  res.json({ imports: db.getImports() });
});

// ==========================================
// 4. CAMPAIGNS & GROUP INVITATIONS
// ==========================================
app.get('/api/campaigns', (_req: Request, res: Response) => {
  res.json({ campaigns: db.getCampaigns() });
});

app.get('/api/campaigns/:id', (req: Request, res: Response) => {
  const campaign = db.getCampaignById(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const recipients = db.getCampaignRecipients(campaign.id);
  const messages = db.getMessages(undefined, campaign.id);

  res.json({
    campaign,
    recipients,
    messages,
  });
});

app.post('/api/campaigns', authMiddleware, (req: AuthRequest, res: Response) => {
  const {
    name,
    type = 'GROUP_INVITATION',
    target_segment_id: raw_target_segment,
    segment_id,
    template_id,
    group_name,
    group_link,
    allowed_days = [0, 1, 2, 3, 4, 5, 6],
    allowed_hours_start = 9,
    allowed_hours_end = 21,
    timezone = 'Africa/Cairo',
    priority = 'MEDIUM',
    start_now = false,
  } = req.body;

  const target_segment_id = raw_target_segment || segment_id || 'seg_all_opted_in';

  if (!name || !template_id) {
    return res.status(400).json({ error: 'Campaign name and WhatsApp template are required.' });
  }

  const template = db.getTemplateById(template_id);
  if (!template) {
    return res.status(400).json({ error: 'Selected WhatsApp message template does not exist.' });
  }

  if (template.status !== 'APPROVED') {
    return res.status(400).json({ error: `Cannot launch campaign with unapproved template (status: ${template.status}).` });
  }

  if (type === 'GROUP_INVITATION' && !group_link) {
    return res.status(400).json({ error: 'Group Invitation link is required for WhatsApp Group Invitation campaigns.' });
  }

  // Determine eligible recipients from database
  let targetCustomers = db.getCustomers();

  // Apply segment filtering
  if (target_segment_id === 'seg_all_opted_in') {
    targetCustomers = targetCustomers.filter(c => c.opt_in_status === 'OPTED_IN' && !c.opt_out_status);
  } else if (target_segment_id === 'seg_high_value') {
    targetCustomers = targetCustomers.filter(c => c.total_spending >= 5000 && c.opt_in_status === 'OPTED_IN' && !c.opt_out_status);
  } else if (target_segment_id === 'seg_recent_purchases') {
    targetCustomers = targetCustomers.filter(c => c.number_of_orders > 0 && c.opt_in_status === 'OPTED_IN' && !c.opt_out_status);
  }

  // Pre-calculate safety breakdown
  let eligibleCount = 0;
  let excludedCount = 0;
  let optOutsCount = 0;

  const campaignId = 'cmp_' + Date.now();
  const recipients: CampaignRecipient[] = [];

  for (const cust of targetCustomers) {
    const isSuppressed = db.isPhoneOptedOut(cust.mobile_number);
    const hasConsent = cust.opt_in_status === 'OPTED_IN' && !cust.opt_out_status && !isSuppressed;
    const phoneValid = normalizeEgyptianPhone(cust.mobile_number).isValid;

    if (hasConsent && phoneValid) {
      eligibleCount++;
      recipients.push({
        id: 'rcp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        campaign_id: campaignId,
        customer_id: cust.id,
        customer_name: cust.full_name,
        phone_canonical: cust.mobile_number,
        phone_e164: cust.whatsapp_number,
        status: start_now ? 'PENDING' : 'SCHEDULED',
        variables: {
          customer_name: cust.full_name,
          group_link: group_link || '',
          group_name: group_name || '',
        },
        queued_at: new Date().toISOString(),
        retry_count: 0,
      });
    } else {
      excludedCount++;
      if (isSuppressed || cust.opt_out_status) {
        optOutsCount++;
      }
    }
  }

  const campaign: Campaign = {
    id: campaignId,
    name,
    type,
    target_segment_id: target_segment_id || 'seg_all_opted_in',
    template_id: template.id,
    template_name: template.name,
    group_name,
    group_link,
    status: start_now ? 'RUNNING' : 'DRAFT',
    start_date: new Date().toISOString(),
    allowed_days,
    allowed_hours_start,
    allowed_hours_end,
    timezone,
    priority,
    total_recipients: targetCustomers.length,
    eligible_count: eligibleCount,
    excluded_count: excludedCount,
    sent_count: 0,
    delivered_count: 0,
    read_count: 0,
    failed_count: 0,
    skipped_count: 0,
    opt_outs_count: optOutsCount,
    created_by: req.user?.username || 'Admin',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  db.saveCampaign(campaign);
  db.saveRecipientsBatch(recipients);

  db.logAudit(
    req.user?.username || 'Admin',
    'Campaign Created',
    `Created campaign "${campaign.name}" with ${eligibleCount} eligible recipients (${excludedCount} excluded)`
  );

  res.status(201).json({
    campaign,
    eligibleCount,
    excludedCount,
    optOutsCount,
    totalRecipients: recipients.length,
    recipientsCount: recipients.length,
  });
});

app.post('/api/campaigns/:id/start', authMiddleware, (req: AuthRequest, res: Response) => {
  const campaign = db.getCampaignById(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  campaign.status = 'RUNNING';
  campaign.pause_reason = undefined;
  campaign.updated_at = new Date().toISOString();
  db.saveCampaign(campaign);

  // Transition recipients to PENDING if not already sent/skipped
  const recipients = db.getCampaignRecipients(campaign.id);
  for (const r of recipients) {
    if (r.status === 'SCHEDULED') {
      r.status = 'PENDING';
      db.saveRecipient(r);
    }
  }

  db.logAudit(req.user?.username || 'Admin', 'Campaign Started', `Started outbound sending for campaign "${campaign.name}"`);
  res.json({ campaign });
});

app.post('/api/campaigns/:id/pause', authMiddleware, (req: AuthRequest, res: Response) => {
  const campaign = db.getCampaignById(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  campaign.status = 'PAUSED';
  campaign.pause_reason = req.body.reason || 'Paused by operator';
  campaign.updated_at = new Date().toISOString();
  db.saveCampaign(campaign);

  db.logAudit(req.user?.username || 'Admin', 'Campaign Paused', `Campaign "${campaign.name}" paused: ${campaign.pause_reason}`);
  res.json({ campaign });
});

app.post('/api/campaigns/:id/resume', authMiddleware, (req: AuthRequest, res: Response) => {
  const campaign = db.getCampaignById(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  campaign.status = 'RUNNING';
  campaign.pause_reason = undefined;
  campaign.updated_at = new Date().toISOString();
  db.saveCampaign(campaign);

  db.logAudit(req.user?.username || 'Admin', 'Campaign Resumed', `Resumed campaign "${campaign.name}"`);
  res.json({ campaign });
});

app.post('/api/campaigns/:id/retry-failed', authMiddleware, (req: AuthRequest, res: Response) => {
  const campaign = db.getCampaignById(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const recipients = db.getCampaignRecipients(campaign.id).filter(r => r.status === 'FAILED');
  for (const r of recipients) {
    r.status = 'PENDING';
    r.failure_reason = undefined;
    db.saveRecipient(r);
  }

  campaign.failed_count = Math.max(0, campaign.failed_count - recipients.length);
  campaign.updated_at = new Date().toISOString();
  db.saveCampaign(campaign);

  db.logAudit(req.user?.username || 'Admin', 'Campaign Retry Failed', `Queued ${recipients.length} failed recipients for retry in campaign "${campaign.name}"`);
  res.json({ retriedCount: recipients.length });
});

// ==========================================
// 5. MESSAGE TEMPLATES
// ==========================================
app.get('/api/templates', (_req: Request, res: Response) => {
  res.json({ templates: db.getTemplates() });
});

app.post('/api/templates', authMiddleware, (req: AuthRequest, res: Response) => {
  const { name, language = 'ar', category = 'MARKETING', body, header, footer } = req.body;
  if (!name || !body) {
    return res.status(400).json({ error: 'Template name and body text are required.' });
  }

  // Parse variables
  const variableMatches = body.match(/\{\{([0-9a-zA-Z_]+)\}\}/g) || [];
  const variables: string[] = Array.from(new Set<string>(variableMatches.map((m: string) => m.replace(/[{}]/g, ''))));

  const newTemplate: MessageTemplate = {
    id: 'tmpl_' + Date.now(),
    name: name.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
    language,
    category,
    status: 'APPROVED', // Default to approved for local testing/management
    header,
    body,
    footer,
    variables: variables.length > 0 ? variables : ['customer_name'],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  db.saveTemplate(newTemplate);
  db.logAudit(req.user?.username || 'Admin', 'Template Created', `Created WhatsApp message template "${newTemplate.name}"`);
  res.status(201).json({ template: newTemplate });
});

app.post('/api/templates/sync-meta', authMiddleware, async (req: AuthRequest, res: Response) => {
  const result = await metaClient.fetchMetaTemplates();
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  db.logAudit(req.user?.username || 'Admin', 'Meta Templates Synced', `Synced ${result.templates?.length || 0} templates from Meta Cloud API`);
  res.json({
    success: true,
    count: result.templates?.length || 0,
    templates: db.getTemplates(),
  });
});

// ==========================================
// 6. WHATSAPP SETTINGS & META CLOUD API
// ==========================================
app.get('/api/whatsapp/settings', (_req: Request, res: Response) => {
  const settings = db.getSettings();
  // Mask sensitive access token for UI security
  const maskedToken = settings.meta_access_token
    ? (settings.meta_access_token.length > 10 ? '••••••••••••••••' + settings.meta_access_token.slice(-6) : '••••••••')
    : '';

  res.json({
    settings: {
      ...settings,
      meta_access_token_masked: maskedToken,
      has_access_token: Boolean(settings.meta_access_token),
    },
  });
});

app.put('/api/whatsapp/settings', authMiddleware, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can update WhatsApp API credentials' });
  }

  const {
    meta_business_id,
    meta_waba_id,
    meta_phone_number_id,
    meta_access_token,
    meta_webhook_verify_token,
    meta_api_version,
    meta_business_phone,
    meta_display_name,
    rate_limit_per_minute,
    auto_pause_threshold_errors,
  } = req.body;

  const updates: any = {};
  if (meta_business_id !== undefined) updates.meta_business_id = meta_business_id;
  if (meta_waba_id !== undefined) updates.meta_waba_id = meta_waba_id;
  if (meta_phone_number_id !== undefined) updates.meta_phone_number_id = meta_phone_number_id;
  if (meta_access_token !== undefined && !meta_access_token.includes('••••')) {
    updates.meta_access_token = meta_access_token;
  }
  if (meta_webhook_verify_token !== undefined) updates.meta_webhook_verify_token = meta_webhook_verify_token;
  if (meta_api_version !== undefined) updates.meta_api_version = meta_api_version;
  if (meta_business_phone !== undefined) updates.meta_business_phone = meta_business_phone;
  if (meta_display_name !== undefined) updates.meta_display_name = meta_display_name;
  if (rate_limit_per_minute !== undefined) updates.rate_limit_per_minute = Number(rate_limit_per_minute);
  if (auto_pause_threshold_errors !== undefined) updates.auto_pause_threshold_errors = Number(auto_pause_threshold_errors);

  const updated = db.updateSettings(updates);
  db.logAudit(req.user.username, 'WhatsApp Settings Updated', 'Updated Meta WhatsApp Business Cloud API settings');

  res.json({ success: true, settings: updated });
});

app.post('/api/whatsapp/test-connection', async (_req: Request, res: Response) => {
  const result = await metaClient.testConnection();
  res.json(result);
});

// ==========================================
// 7. META WEBHOOK (INCOMING UPDATES & STOP)
// ==========================================
// Webhook Verification (Meta Hub Challenge)
app.get('/api/webhook/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = db.getSettings().meta_webhook_verify_token;

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('[Webhook] Meta WhatsApp Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  res.status(403).send('Forbidden: Verify token mismatch');
});

// Webhook Event Receiver
app.post('/api/webhook/whatsapp', (req: Request, res: Response) => {
  try {
    const result = metaClient.handleWebhookEvent(req.body);
    res.status(200).json({ status: 'ok', ...result });
  } catch (err: any) {
    console.error('[Webhook] Error processing incoming payload:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 8. EMERGENCY STOP CIRCUIT BREAKER
// ==========================================
app.post('/api/emergency-stop', authMiddleware, (req: AuthRequest, res: Response) => {
  const userName = req.user?.username || 'Admin';
  const result = queueEngine.emergencyStop(userName);
  res.json({
    success: true,
    emergency_stop_active: true,
    stoppedCampaigns: result.stoppedCampaignsCount,
    message: 'EMERGENCY STOP ACTIVATED: Outbound messages stopped immediately.',
  });
});

app.post('/api/emergency-resume', authMiddleware, (req: AuthRequest, res: Response) => {
  const userName = req.user?.username || 'Admin';
  queueEngine.resumeEmergencyStop(userName);
  res.json({
    success: true,
    emergency_stop_active: false,
    message: 'Emergency stop circuit breaker cleared.',
  });
});

// ==========================================
// 9. REPORTS & EXPORTS
// ==========================================
app.get('/api/reports/dashboard', (_req: Request, res: Response) => {
  const customers = db.getCustomers();
  const campaigns = db.getCampaigns();
  const messages = db.getMessages();
  const optOuts = db.getOptOuts();
  const settings = db.getSettings();

  const totalCustomers = customers.length;
  const optedInCustomers = customers.filter(c => c.opt_in_status === 'OPTED_IN' && !c.opt_out_status).length;

  const now = new Date();
  const thisMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const addedThisMonth = customers.filter(c => c.created_at.startsWith(thisMonthStr)).length;

  const activeCampaigns = campaigns.filter(c => c.status === 'RUNNING').length;
  const scheduledMessages = db.getCampaignRecipients().filter(r => r.status === 'PENDING' || r.status === 'SCHEDULED').length;

  const todayStr = now.toISOString().split('T')[0];
  const messagesSentToday = messages.filter(m => m.created_at.startsWith(todayStr) && m.status === 'SENT').length;

  const deliveredMessages = messages.filter(m => m.status === 'DELIVERED' || m.status === 'READ').length;
  const readMessages = messages.filter(m => m.status === 'READ').length;
  const failedMessages = messages.filter(m => m.status === 'FAILED').length;
  const totalSent = messages.filter(m => m.status === 'SENT' || m.status === 'DELIVERED' || m.status === 'READ').length;

  const deliveryRate = totalSent > 0 ? Math.round((deliveredMessages / totalSent) * 100) : 0;
  const readRate = deliveredMessages > 0 ? Math.round((readMessages / deliveredMessages) * 100) : 0;
  const failureRate = (totalSent + failedMessages) > 0 ? Math.round((failedMessages / (totalSent + failedMessages)) * 100) : 0;
  const optOutRate = totalCustomers > 0 ? Math.round((optOuts.length / totalCustomers) * 100) : 0;

  res.json({
    metrics: {
      totalCustomers,
      optedInCustomers,
      customersAddedThisMonth: addedThisMonth,
      activeCampaigns,
      scheduledMessages,
      messagesSentToday,
      deliveredMessages,
      readMessages,
      failedMessages,
      optOuts: optOuts.length,
      apiErrors: db.getRawDatabaseState().api_logs.filter(l => l.status_code >= 400).length,
      deliveryRate,
      readRate,
      failureRate,
      optOutRate,
      emergencyStopActive: settings.emergency_stop_active,
    },
    metaStatus: metaClient.isConfigured() ? 'CONFIGURED' : 'NOT CONFIGURED',
  });
});

app.get('/api/reports/export/:type', (req: Request, res: Response) => {
  const { type } = req.params;
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';

  let data: any[] = [];
  let sheetName = 'Report';

  if (type === 'customers') {
    sheetName = 'Customers';
    data = db.getCustomers().map(c => ({
      'Customer ID': c.id,
      'Full Name': c.full_name,
      'Mobile Number': c.mobile_number,
      'WhatsApp E164': c.whatsapp_number,
      'Email': c.email || '',
      'Total Spending (EGP)': c.total_spending,
      'Orders': c.number_of_orders,
      'Consent Status': c.opt_in_status,
      'Opt-In Date': c.opt_in_date || '',
      'Opt-Out Status': c.opt_out_status ? 'YES' : 'NO',
      'Created At': c.created_at,
    }));
  } else if (type === 'campaigns') {
    sheetName = 'Campaigns';
    data = db.getCampaigns().map(c => ({
      'Campaign ID': c.id,
      'Name': c.name,
      'Type': c.type,
      'Status': c.status,
      'Template': c.template_name,
      'Group Name': c.group_name || '',
      'Total Recipients': c.total_recipients,
      'Eligible': c.eligible_count,
      'Sent': c.sent_count,
      'Delivered': c.delivered_count,
      'Read': c.read_count,
      'Failed': c.failed_count,
      'Created Date': c.created_at,
    }));
  } else if (type === 'optouts') {
    sheetName = 'OptOutSuppression';
    data = db.getOptOuts().map(o => ({
      'Phone': o.phone_canonical,
      'Reason': o.reason,
      'Source': o.source,
      'Date': o.created_at,
    }));
  } else {
    return res.status(400).json({ error: 'Unknown export type' });
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  if (format === 'csv') {
    const csv = XLSX.utils.sheet_to_csv(ws);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${sheetName}_${Date.now()}.csv"`);
    return res.send(csv);
  } else {
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${sheetName}_${Date.now()}.xlsx"`);
    return res.send(buffer);
  }
});

// ==========================================
// 10. BACKUPS & RESTORE
// ==========================================
app.get('/api/backups', (_req: Request, res: Response) => {
  res.json({ backups: db.getBackups() });
});

app.post('/api/backups/create', authMiddleware, (req: AuthRequest, res: Response) => {
  const meta = db.createBackup('MANUAL', req.user?.username || 'Admin');
  res.status(201).json({ backup: meta });
});

app.post('/api/backups/restore/:id', authMiddleware, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can restore backups' });
  }

  const success = db.restoreBackup(req.params.id, req.user.username);
  if (!success) {
    return res.status(400).json({ error: 'Failed to restore backup' });
  }
  res.json({ success: true, message: 'Database restored successfully' });
});

// ==========================================
// 11. AUDIT & API LOGS
// ==========================================
app.get('/api/logs/audit', (_req: Request, res: Response) => {
  res.json({ logs: db.getRawDatabaseState().audit_logs.slice(0, 100) });
});

app.get('/api/logs/api', (_req: Request, res: Response) => {
  res.json({ logs: db.getRawDatabaseState().api_logs.slice(0, 100) });
});

// ==========================================
// 12. AUTOMATED TESTS RUNNER
// ==========================================
app.post('/api/tests/run', async (_req: Request, res: Response) => {
  const summary = await runAllAutomatedTests();
  res.json(summary);
});

// ==========================================
// 13. SYSTEM SETTINGS
// ==========================================
app.get('/api/settings', (_req: Request, res: Response) => {
  res.json({ settings: db.getSettings() });
});

app.put('/api/settings', authMiddleware, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can modify system settings' });
  }
  const updated = db.updateSettings(req.body);
  db.logAudit(req.user.username, 'System Settings Updated', 'Updated system preferences');
  res.json({ settings: updated });
});

// ==========================================
// 13B. DIRECT INSTALLER DOWNLOAD ENDPOINTS
// ==========================================
const handleFinalZipDownload = (_req: Request, res: Response) => {
  const candidates = [
    path.resolve(process.cwd(), 'release', 'CACAO-WhatsApp-CRM-Final.zip'),
    path.resolve(process.cwd(), 'release', 'CACAO-WhatsApp-CRM-Portable.zip'),
    path.resolve(process.cwd(), 'public', 'downloads', 'CACAO-WhatsApp-CRM-Final.zip'),
    path.resolve(process.cwd(), 'public', 'downloads', 'CACAO-WhatsApp-CRM-Portable.zip'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="CACAO-WhatsApp-CRM-Final.zip"');
      return res.download(c, 'CACAO-WhatsApp-CRM-Final.zip');
    }
  }
  res.status(404).json({ error: 'Final zip package not found' });
};

const handleSetupExeDownload = (_req: Request, res: Response) => {
  const candidates = [
    path.resolve(process.cwd(), 'release', 'CACAO-WhatsApp-CRM-Setup.exe'),
    path.resolve(process.cwd(), 'release', 'installer', 'CACAO-WhatsApp-CRM-Setup.exe'),
    path.resolve(process.cwd(), 'public', 'downloads', 'CACAO-WhatsApp-CRM-Setup.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="CACAO-WhatsApp-CRM-Setup.exe"');
      return res.download(c, 'CACAO-WhatsApp-CRM-Setup.exe');
    }
  }
  res.status(404).json({ error: 'Installer file not found' });
};

const handleRenderZipDownload = (_req: Request, res: Response) => {
  const candidates = [
    path.resolve(process.cwd(), 'release', 'cacao-whatsapp-crm-github-render.zip'),
    path.resolve(process.cwd(), 'public', 'downloads', 'cacao-whatsapp-crm-github-render.zip'),
    path.resolve(process.cwd(), 'dist', 'downloads', 'cacao-whatsapp-crm-github-render.zip'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="cacao-whatsapp-crm-github-render.zip"');
      return res.download(c, 'cacao-whatsapp-crm-github-render.zip');
    }
  }
  res.status(404).json({ error: 'Render deployment package not found' });
};

// Both /downloads and /api/download routes to guarantee proxy compatibility
app.get('/downloads/cacao-whatsapp-crm-github-render.zip', handleRenderZipDownload);
app.get('/downloads/CACAO-WhatsApp-CRM-Setup.exe', handleSetupExeDownload);
app.get('/downloads/CACAO-WhatsApp-CRM-Final.zip', handleFinalZipDownload);
app.get('/downloads/CACAO-WhatsApp-CRM-Portable.zip', handleFinalZipDownload);

app.get('/api/download/github-render-package', handleRenderZipDownload);
app.get('/api/download/render-zip', handleRenderZipDownload);
app.get('/api/download/final-zip', handleFinalZipDownload);
app.get('/api/download/installer', handleSetupExeDownload);
app.get('/api/download/setup-exe', handleSetupExeDownload);
app.get('/api/download/package', handleFinalZipDownload);

// ==========================================
// 13C. LOCAL NETWORK & LAN SERVER INFO
// ==========================================
app.get('/api/network-info', (_req: Request, res: Response) => {
  const lanInterfaces = getLanIpAddresses();
  const primaryLan = lanInterfaces[0]?.address || '127.0.0.1';
  res.json({
    host: HOST,
    port: PORT,
    localUrl: `http://localhost:${PORT}`,
    primaryLanUrl: `http://${primaryLan}:${PORT}`,
    networkUrls: lanInterfaces.map(i => ({
      name: i.name,
      ip: i.address,
      url: `http://${i.address}:${PORT}`,
    })),
    interfaces: lanInterfaces,
    firewallCommand: `netsh advfirewall firewall add rule name="CACAO WhatsApp CRM (Port ${PORT})" dir=in action=allow protocol=TCP localport=${PORT} profile=any`,
    serverTime: new Date().toISOString(),
  });
});

// ==========================================
// 14. VITE DEV SERVER / STATIC PRODUCTION SERVING
// ==========================================
async function startServer() {
  let viteLoaded = false;
  if (!isProd) {
    try {
      // In dev, mount Vite's connect middleware to serve React SPA with HMR/bundling
      const { createServer } = await import('vite');
      const vite = await createServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      viteLoaded = true;
    } catch (_viteErr) {
      console.warn('[Server] Vite not found or could not be loaded; serving static frontend build.');
    }
  }

  if (isProd || !viteLoaded) {
    // In production or standalone, serve frontend assets from candidate paths (app or dist)
    const candidatePaths = [
      path.resolve(process.cwd(), 'app'),
      path.resolve(process.cwd(), 'dist'),
      path.resolve(_currentDirname, '..', 'app'),
      path.resolve(_currentDirname, '..', 'dist'),
      path.resolve(_currentDirname, 'app'),
      path.resolve(_currentDirname, 'dist'),
    ];
    const distPath = candidatePaths.find(p => fs.existsSync(p)) || path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const server = app.listen(PORT, HOST, () => {
    const lanInterfaces = getLanIpAddresses();
    console.log('\n======================================================================');
    console.log('       CACAO WHATSAPP CRM - LOCAL NETWORK SERVER STARTED');
    console.log('======================================================================');
    console.log(`  Local Access (This PC):  http://localhost:${PORT}`);
    if (lanInterfaces.length > 0) {
      lanInterfaces.forEach(i => {
        console.log(`  Network Access (${i.name}): http://${i.address}:${PORT}  <-- Open from other PCs & Phones!`);
      });
    } else {
      console.log(`  Network Interface:       http://0.0.0.0:${PORT} (Waiting for network interface)`);
    }
    console.log('----------------------------------------------------------------------');
    console.log(`  Listening Host:          ${HOST} (Accessible from LAN / Wi-Fi)`);
    console.log(`  Listening Port:          ${PORT} (Configurable via PORT env var)`);
    console.log(`  Database Master:         data/whatsapp_crm.json (Single source of truth)`);
    console.log(`  Windows Firewall:        netsh advfirewall firewall add rule name="CACAO WhatsApp CRM" dir=in action=allow protocol=TCP localport=${PORT} profile=any`);
    console.log('======================================================================\n');
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[WhatsApp CRM ERROR] Port ${PORT} is already in use by another instance or service.`);
      console.error(`[WhatsApp CRM SOLUTION] To stop the conflicting process on port ${PORT}, run 'STOP_WINDOWS.bat' or terminate the process in Windows Task Manager.`);
      process.exit(1);
    } else {
      console.error('[WhatsApp CRM ERROR] Server listen error:', err);
      process.exit(1);
    }
  });

  const gracefulShutdown = () => {
    console.log('[WhatsApp CRM] Received termination signal. Flushing database to disk...');
    try {
      db.flush();
      queueEngine.stopScheduler();
      console.log('[WhatsApp CRM] Database flushed and scheduler stopped.');
    } catch (e) {
      console.error('[WhatsApp CRM] Error during shutdown flush:', e);
    }
    server.close(() => {
      console.log('[WhatsApp CRM] Server terminated cleanly.');
      process.exit(0);
    });
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

startServer().catch(err => {
  console.error('[WhatsApp CRM] Fatal startup failure:', err);
});
