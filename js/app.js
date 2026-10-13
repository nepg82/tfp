/* ==========================================================================
   TFP Ledger
   --------------------------------------------------------------------------
   A local-first ledger for a small practice. Data lives in IndexedDB and can
   optionally be backed up to a private GitHub repo as an AES-GCM encrypted file.

   Record types stored in IndexedDB (all have id, createdAt, updatedAt):
     income     { date, amount, category, payer, reference, description }
     expense    { date, amount, category, payer, reference, description }
     billing    { serviceDate, billedAmount, status: 'pending' | 'paid',
                  paymentDate, receivedAmount,        <- only when paid
                  payer, reference, description }
     category   { name, kind: 'expense' | 'income' }  (synced like any record)
     tombstone  { id, deletedAt }   <- marks a deleted record so deletes sync

   Accounting basis: CASH. A billing claim counts in the register and on
   statements on its payment date. Pending (unpaid) claims appear only on the
   Billing tab and as a memo line on statements.

   Sections in this file:
     1. Constants & state
     2. Small helpers
     3. IndexedDB
     4. Settings (localStorage)
     5. Categories (synced records)
     6. Date periods (presets)
     7. Register / billing / summary rendering
     8. Add / edit / delete entries
     9. Register filter controls
    10. Statements (preview, shared calculations, CSV)
    11. Encryption
    12. GitHub sync (push / pull / merge)
    13. Import / export / clear + button wiring
    14. PDF statement generator
    15. Startup
   ========================================================================== */


/* ==========================================================================
   1. Constants & state
   ========================================================================== */

const DB_NAME = 'tfp-ledger';
const DB_VERSION = 1;
const STORE = 'records';

const SETTINGS_KEY = 'tfp-ledger-settings';
const LAST_SYNC_KEY = 'tfp-last-sync';
const REMOTE_SHA_KEY = 'tfp-remote-sha';   // version of the GitHub file this device last synced with

// Categories used to live in localStorage. They are now ordinary records so they sync.
// These keys are only used for one-time migrations (see migrateCategories).
const LEGACY_CATEGORIES_KEY = 'tfp-ledger-expense-categories';
const CATEGORIES_MIGRATED_KEY = 'tfp-ledger-categories-migrated';
const INCOME_CATEGORIES_SEEDED_KEY = 'tfp-ledger-income-categories-seeded';

const DEFAULT_CATEGORIES = [
  'Fees', 'Advertising', 'Office Supplies', 'Software', 'Professional Services',
  'Rent', 'Utilities', 'Insurance', 'Travel', 'Other'
];
const DEFAULT_INCOME_CATEGORIES = ['Insurance Payments', 'Self-Pay', 'Other Income'];

// Insurance claims always report under this income category
const BILLING_CATEGORY = 'Insurance Payments';
// Income entered before income categories existed is reported under this one
const FALLBACK_INCOME_CATEGORY = 'Other Income';

// Record types that show up in the register, billing list, and statements
const LEDGER_TYPES = ['income', 'expense', 'billing'];

let db;                          // the open IndexedDB connection
let records = [];                // in-memory copy of every record (including categories and tombstones)
let editingId = null;            // id of the record being edited, or null for a new one
let registerAscending = false;   // register sort direction (false = newest/highest first)


/* ==========================================================================
   2. Small helpers
   ========================================================================== */

// Shortcut for document.getElementById
const $ = id => document.getElementById(id);

// 1234.5 -> "$1,234.50"
const money = n =>
  Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Accounting style: negatives in parentheses, -50 -> "($50.00)"
const moneyAcct = n => (n < 0 ? `(${money(-n)})` : money(n));

// CSS class to add to a cell showing a possibly-negative amount
const negClass = n => (n < 0 ? ' negative' : '');

// "2026-03-05" -> "Mar 5, 2026" (noon avoids timezone date-shifting)
const dateFmt = s =>
  s
    ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

const uid = () => crypto.randomUUID();

// A Date as "YYYY-MM-DD" in the user's own time zone
const localISO = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const today = () => localISO(new Date());

// Whole days from a "YYYY-MM-DD" date until today
function daysSince(dateStr) {
  const ms = new Date(today() + 'T12:00:00') - new Date(dateStr + 'T12:00:00');
  return Math.max(0, Math.round(ms / 86400000));
}

// Escape text before inserting it into HTML
function esc(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, c => map[c]);
}

// Brief pop-up message at the bottom of the screen
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(window._toast);
  window._toast = setTimeout(() => (t.style.display = 'none'), 2500);
}

// Every real ledger entry (not deletion markers, not categories)
function activeRecords() {
  return records.filter(r => LEDGER_TYPES.includes(r.type));
}

// A claim that has been billed but not yet paid
const isPending = r => r.type === 'billing' && r.status === 'pending';

// The date a record "counts" on: payment date for billing, otherwise its date.
// (Pending claims have no payment date, so they have no counting date yet.)
function recordDate(r) {
  return r.type === 'billing' ? r.paymentDate : r.date;
}

// Amount billed minus amount received (never negative)
function adjustmentOf(r) {
  return Math.max(0, Number(r.billedAmount) - Number(r.receivedAmount));
}

function incomeCategoryOf(r) {
  return r.category || FALLBACK_INCOME_CATEGORY;
}

// True if a "YYYY-MM-DD" date is within [from, to]; either bound may be empty
const inRange = (d, from, to) => !!d && (!from || d >= from) && (!to || d <= to);


/* ==========================================================================
   3. IndexedDB
   ========================================================================== */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function getAll() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// Insert or update several records in one transaction
function putMany(items) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    items.forEach(item => store.put(item));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function clearDB() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
}


/* ==========================================================================
   4. Settings (stored in localStorage)
   The token and password are only saved if the matching "remember" box is on.
   ========================================================================== */

function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch { /* ignore corrupt settings */ }

  $('ghOwner').value = s.owner || '';
  $('ghRepo').value = s.repo || '';
  $('ghPath').value = s.path || 'ledger.enc';
  $('rememberToken').checked = !!s.rememberToken;
  $('rememberPassword').checked = !!s.rememberPassword;

  if (s.rememberToken) $('ghToken').value = s.token || '';
  if (s.rememberPassword) $('encPassword').value = s.password || '';
}

function saveSettings() {
  const s = {
    owner: $('ghOwner').value.trim(),
    repo: $('ghRepo').value.trim(),
    path: $('ghPath').value.trim() || 'ledger.enc',
    rememberToken: $('rememberToken').checked,
    rememberPassword: $('rememberPassword').checked
  };

  if (s.rememberToken) s.token = $('ghToken').value;
  if (s.rememberPassword) s.password = $('encPassword').value;

  // Only what's ticked "remember" is stored. The boxes on screen keep their values
  // for this session either way, so Push and Pull can still use them.
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}


/* ==========================================================================
   5. Categories (synced records)
   Each category is its own record,
     { id: 'category:<lowercase name>' (expense) or 'category:income:<lowercase name>',
       type: 'category', kind: 'expense' | 'income', name }
   so categories sync through GitHub like everything else. Deleting one writes a
   tombstone with the same id. Records saved before income categories existed have
   no `kind` and are expense categories.
   `categories` and `incomeCategories` are sorted lists of names, rebuilt from
   `records` every time the screen refreshes.
   ========================================================================== */

let categories = [];          // expense category names
let incomeCategories = [];    // income category names

const categoryId = (name, kind = 'expense') =>
  (kind === 'income' ? 'category:income:' : 'category:') + name.trim().toLowerCase();

function rebuildCategories() {
  const names = kind => records
    .filter(r => r.type === 'category' && (r.kind || 'expense') === kind)
    .map(r => r.name)
    .sort((a, b) => a.localeCompare(b));

  categories = names('expense');
  incomeCategories = names('income');
}

async function addCategory(name, kind) {
  const now = Date.now();
  await putMany([{ id: categoryId(name, kind), type: 'category', kind, name, createdAt: now, updatedAt: now }]);
  records = await getAll();
  refresh();
  setSyncDirty();
}

async function deleteCategory(name, kind) {
  const now = Date.now();
  await putMany([{ id: categoryId(name, kind), type: 'tombstone', deletedAt: now, updatedAt: now }]);
  records = await getAll();
  refresh();
  setSyncDirty();
}

// Create records for the given names, skipping any that already exist (or were deleted).
// Timestamps are 0, so any real add or delete, here or on another device, always wins.
async function seedCategories(names, kind = 'expense') {
  const existingIds = new Set(records.map(r => r.id));
  const items = [...new Set(names.map(n => String(n).trim()).filter(Boolean))]
    .filter(n => !existingIds.has(categoryId(n, kind)))
    .map(n => ({ id: categoryId(n, kind), type: 'category', kind, name: n, createdAt: 0, updatedAt: 0 }));

  if (items.length) {
    await putMany(items);
    records = await getAll();
  }
}

// One-time upgrades, tracked by flags in localStorage:
//  1. Older versions kept expense categories in localStorage. Convert that list
//     (or the starter list on a brand-new device) into records.
//  2. Add the starter income categories.
async function migrateCategories() {
  if (!localStorage.getItem(CATEGORIES_MIGRATED_KEY)) {
    let names = DEFAULT_CATEGORIES;
    try {
      const saved = JSON.parse(localStorage.getItem(LEGACY_CATEGORIES_KEY) || 'null');
      if (Array.isArray(saved) && saved.length) names = saved;
    } catch { /* use the starter list */ }

    await seedCategories(names, 'expense');
    localStorage.setItem(CATEGORIES_MIGRATED_KEY, '1');
  }

  if (!localStorage.getItem(INCOME_CATEGORIES_SEEDED_KEY)) {
    await seedCategories(DEFAULT_INCOME_CATEGORIES, 'income');
    localStorage.setItem(INCOME_CATEGORIES_SEEDED_KEY, '1');
  }
}

// The two lists with Delete buttons in Settings
function renderCategories() {
  const draw = (elId, names, kind) => {
    const el = $(elId);
    if (!el) return;

    el.innerHTML = names.length
      ? names.map(c => `
          <div class="category-item">
            <span>${esc(c)}</span>
            <button type="button" class="delete-link" data-category-delete="${esc(c)}" data-category-kind="${kind}">Delete</button>
          </div>`).join('')
      : '<div class="hint">No categories defined.</div>';
  };

  draw('categoryList', categories, 'expense');
  draw('incomeCategoryList', incomeCategories, 'income');
}

// Every category name worth offering as a filter: the current list, plus any name
// still used by an existing entry (so old entries stay filterable after a delete).
function categoryChoices(kind) {
  const used = records
    .filter(r => r.type === kind && r.category)
    .map(r => r.category);
  const base = kind === 'income'
    ? [...incomeCategories, BILLING_CATEGORY, FALLBACK_INCOME_CATEGORY, ...used]
    : [...categories, ...used];
  return [...new Set(base)].sort((a, b) => a.localeCompare(b));
}

// The Register's category dropdown. Values look like "income:Self-Pay" or "expense:Rent",
// so an income category and an expense category can never be confused.
function populateRegisterCategory() {
  const el = $('registerCategory');
  if (!el) return;

  const previous = el.value;
  const options = kind => categoryChoices(kind)
    .map(c => `<option value="${esc(kind + ':' + c)}">${esc(c)}</option>`)
    .join('');

  el.innerHTML =
    '<option value="all">All Categories</option>' +
    `<optgroup label="Income">${options('income')}</optgroup>` +
    `<optgroup label="Expenses">${options('expense')}</optgroup>`;

  el.value = [...el.options].some(o => o.value === previous) ? previous : 'all';
}


/* ==========================================================================
   6. Date periods (presets used by the Register and Statements)
   ========================================================================== */

const PERIOD_OPTIONS = [
  ['thisMonth', 'This Month'],
  ['lastMonth', 'Last Month'],
  ['thisQuarter', 'This Quarter'],
  ['lastQuarter', 'Last Quarter'],
  ['ytd', 'Year to Date'],
  ['lastYear', 'Last Year']
];

// { from, to } for a preset name, or null for "custom"
function periodRange(key) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const range = (a, b) => ({ from: localISO(a), to: localISO(b) });

  switch (key) {
    case 'thisMonth':   return range(new Date(y, m, 1), new Date(y, m + 1, 0));
    case 'lastMonth':   return range(new Date(y, m - 1, 1), new Date(y, m, 0));
    case 'thisQuarter': { const q = Math.floor(m / 3) * 3;     return range(new Date(y, q, 1), new Date(y, q + 3, 0)); }
    case 'lastQuarter': { const q = Math.floor(m / 3) * 3 - 3; return range(new Date(y, q, 1), new Date(y, q + 3, 0)); }
    case 'ytd':         return range(new Date(y, 0, 1), now);
    case 'lastYear':    return range(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31));
    default:            return null;
  }
}

function populatePeriodSelects() {
  const options = PERIOD_OPTIONS.map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
  $('registerPeriod').innerHTML = '<option value="all">All Time</option>' + options + '<option value="custom">Custom</option>';
  $('statementPeriod').innerHTML = options + '<option value="custom">Custom</option>';
}

// Wire a period dropdown to its two date inputs.
// Picking a preset fills the dates; editing a date switches the dropdown to "Custom".
function linkPeriodControls(selectId, fromId, toId, onChange) {
  const select = $(selectId);

  select.onchange = () => {
    const range = select.value === 'all' ? { from: '', to: '' } : periodRange(select.value);
    if (range) {
      $(fromId).value = range.from;
      $(toId).value = range.to;
    }
    onChange();
  };

  const custom = () => {
    select.value = 'custom';
    onChange();
  };
  $(fromId).addEventListener('change', custom);
  $(toId).addEventListener('change', custom);
}

function setPeriod(selectId, key) {
  $(selectId).value = key;
  $(selectId).onchange();
}


/* ==========================================================================
   7. Register / billing / summary rendering
   ========================================================================== */

// Turn each PAID record into a uniform "row" for the register table.
//   gross     = amount charged (billed), or income received
//   expense   = money spent
//   reduction = billed minus received (the adjustment)
//   cash      = actual money movement (used for the running balance)
// Pending claims are not in the register: no money has moved yet.
function registerRows() {
  return activeRecords().filter(r => !isPending(r)).map(r => {
    const isBilling = r.type === 'billing';
    const isExpense = r.type === 'expense';
    const category = isExpense
      ? (r.category || 'Uncategorized')
      : isBilling ? BILLING_CATEGORY : incomeCategoryOf(r);

    return {
      id: r.id,
      raw: r,
      date: recordDate(r),
      type: isBilling ? 'Billing' : isExpense ? 'Expense' : 'Income',
      desc: r.description || (isBilling ? 'Insurance payment' : isExpense ? 'Expense' : 'Income'),
      category,
      catKey: (isExpense ? 'expense:' : 'income:') + category,
      payer: r.payer || '',
      ref: r.reference || '',
      gross: isExpense ? 0 : isBilling ? Number(r.billedAmount) : Number(r.amount),
      expense: isExpense ? Number(r.amount) : 0,
      reduction: isBilling ? adjustmentOf(r) : 0,
      cash: isExpense ? -Number(r.amount) : isBilling ? Number(r.receivedAmount) : Number(r.amount)
    };
  });
}

function sumRows(rows) {
  return rows.reduce(
    (t, r) => ({
      gross: t.gross + r.gross,
      expense: t.expense + r.expense,
      reduction: t.reduction + r.reduction,
      cash: t.cash + r.cash
    }),
    { gross: 0, expense: 0, reduction: 0, cash: 0 }
  );
}

// Rows within the Register's selected period (before type/category/search filters)
function periodRegisterRows() {
  const from = $('registerFrom').value;
  const to = $('registerThrough').value;
  return registerRows().filter(r => inRange(r.date, from, to));
}

// Apply the Register's type / category / search / sort controls
function filteredRegisterRows() {
  let rows = periodRegisterRows();

  const type = $('registerFilter').value;
  const category = $('registerCategory').value;
  const search = $('registerSearch').value.trim().toLowerCase();
  const sortKey = $('registerSort').value;

  if (type !== 'all') rows = rows.filter(r => r.raw.type === type);
  if (category !== 'all') rows = rows.filter(r => r.catKey === category);
  if (search) {
    rows = rows.filter(r =>
      `${r.desc} ${r.category} ${r.payer} ${r.ref}`.toLowerCase().includes(search));
  }

  // The value each row is sorted by
  const sortValue = r => {
    switch (sortKey) {
      case 'date':        return r.date || '';
      case 'type':        return r.type;
      case 'description': return r.desc.toLowerCase();
      case 'category':    return r.category.toLowerCase();
      default:            return r.gross + r.expense;   // 'amount'
    }
  };

  rows.sort((a, b) => {
    const av = sortValue(a);
    const bv = sortValue(b);
    if (av < bv) return -1;
    if (av > bv) return 1;
    return a.id.localeCompare(b.id);   // stable tie-breaker
  });

  if (!registerAscending) rows.reverse();
  return rows;
}

function renderRegister() {
  const rows = filteredRegisterRows();

  // The running balance is always calculated over ALL records in date order,
  // so it stays correct no matter how the table is filtered or sorted.
  const chronological = registerRows().sort(
    (a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id)
  );
  const balanceById = new Map();
  let balance = 0;
  for (const r of chronological) {
    balance += r.cash;
    balanceById.set(r.id, balance);
  }

  $('registerBody').innerHTML = rows.length
    ? rows.map(r => {
        const bal = balanceById.get(r.id) || 0;
        return `
        <tr>
          <td>${dateFmt(r.date)}</td>
          <td>${r.type}</td>
          <td>${esc(r.desc)}${r.payer ? `<div class="sub">${esc(r.payer)}</div>` : ''}</td>
          <td class="category">${esc(r.category)}</td>
          <td>${esc(r.ref)}</td>
          <td class="num">${r.gross ? money(r.gross) : ''}</td>
          <td class="num">${r.expense ? money(r.expense) : ''}</td>
          <td class="num">${r.reduction ? money(r.reduction) : ''}</td>
          <td class="num${negClass(bal)}">${moneyAcct(bal)}</td>
          <td>
            <button class="edit-link" data-edit="${r.id}">Edit</button>
            <button class="delete-link" data-delete="${r.id}">Delete</button>
          </td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="10">No transactions match the current filters.</td></tr>';

  // Totals for the rows currently shown
  const t = sumRows(rows);
  $('registerFoot').innerHTML = rows.length
    ? `<tr>
         <td colspan="5">Totals for ${rows.length} transaction${rows.length === 1 ? '' : 's'} shown</td>
         <td class="num">${money(t.gross)}</td>
         <td class="num">${money(t.expense)}</td>
         <td class="num">${money(t.reduction)}</td>
         <td></td><td></td>
       </tr>`
    : '';
}

function renderBilling() {
  const filter = $('billingFilter').value;   // all | pending | paid
  const claims = activeRecords().filter(r => r.type === 'billing');

  // Summary cards: what is still owed to us, as of today
  const pending = claims.filter(isPending);
  const outstanding = pending.reduce((sum, r) => sum + Number(r.billedAmount), 0);
  const oldest = pending.reduce((max, r) => Math.max(max, daysSince(r.serviceDate)), 0);

  $('billingSummary').innerHTML = [
    ['Outstanding claims', money(outstanding)],
    ['Pending claims', String(pending.length)],
    ['Oldest unpaid', pending.length ? `${oldest} day${oldest === 1 ? '' : 's'}` : '—']
  ].map(([label, value]) => `
    <div class="summary">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>`).join('');

  const shown = claims
    .filter(r => filter === 'all' || (filter === 'pending') === isPending(r))
    .sort((a, b) => (a.serviceDate || '').localeCompare(b.serviceDate || ''));

  $('billingBody').innerHTML = shown.length
    ? shown.map(r => {
        const pend = isPending(r);
        const days = pend ? daysSince(r.serviceDate) : 0;
        return `
        <tr>
          <td>${dateFmt(r.serviceDate)}</td>
          <td>${esc(r.payer || '')}</td>
          <td class="${pend ? 'status-pending' : ''}">${pend ? `Pending · ${days} day${days === 1 ? '' : 's'}` : 'Paid'}</td>
          <td>${pend ? '' : dateFmt(r.paymentDate)}</td>
          <td class="num">${money(r.billedAmount)}</td>
          <td class="num">${pend ? '' : money(r.receivedAmount)}</td>
          <td class="num">${pend ? '' : money(adjustmentOf(r))}</td>
          <td>
            ${pend ? `<button class="edit-link" data-markpaid="${r.id}">Record Payment</button>` : ''}
            <button class="edit-link" data-edit="${r.id}">Edit</button>
            <button class="delete-link" data-delete="${r.id}">Delete</button>
          </td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="8">No claims to show.</td></tr>';
}

// The four totals across the top of the Register, for the selected period
function renderSummary() {
  const from = $('registerFrom').value;
  const to = $('registerThrough').value;
  const rows = periodRegisterRows();
  const t = sumRows(rows);

  const cards = [
    ['Charges', t.gross],
    ['Expenses', t.expense],
    ['Adjustments', t.reduction],
    ['Net Cash Movement', t.cash]
  ];

  $('registerSummary').innerHTML = cards.map(([label, value]) => `
    <div class="summary">
      <div class="label">${label}</div>
      <div class="value${negClass(value)}">${moneyAcct(value)}</div>
    </div>`).join('');

  const span = from || to
    ? `${from ? dateFmt(from) : 'the beginning'} – ${to ? dateFmt(to) : 'today'}`
    : 'All dates';
  $('registerPeriodLabel').textContent =
    `Totals for ${span} · ${rows.length} transaction${rows.length === 1 ? '' : 's'}`;
}

// Redraw the whole UI from the current in-memory data
function refresh() {
  rebuildCategories();
  renderRegister();
  renderBilling();
  renderSummary();
  populateRegisterCategory();
  renderCategories();

  const count = activeRecords().length;
  $('recordCount').textContent = `${count} record${count === 1 ? '' : 's'}`;

  renderStatementPreview();
}


/* ==========================================================================
   8. Add / edit / delete entries
   ========================================================================== */

// Describes the form fields for each kind of entry.
// Each field: { id, label, type, value, step, options (for selects) }
function fieldsFor(kind, r = {}) {
  // <option> list for a category dropdown. The entry's own category is always
  // included, even if it has since been deleted, so editing never silently changes it.
  const categoryOptions = (names, selected) => {
    const all = selected && !names.includes(selected) ? [...names, selected] : names;
    const placeholder = selected ? '' : '<option value="" disabled selected>Choose…</option>';
    return placeholder + all
      .map(c => `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c)}</option>`)
      .join('');
  };

  if (kind === 'income') {
    // Old income entries have no category; show them under the fallback one
    const selected = r.category || (r.id ? FALLBACK_INCOME_CATEGORY : '');
    return [
      { id: 'date', label: 'Date', type: 'date', value: r.date || today() },
      { id: 'amount', label: 'Amount received', type: 'number', value: r.amount ?? '', step: '0.01' },
      { id: 'category', label: 'Category', type: 'select', options: categoryOptions(incomeCategories, selected) },
      { id: 'payer', label: 'Payer (optional)', type: 'text', value: r.payer || '' },
      { id: 'reference', label: 'Reference # (optional)', type: 'text', value: r.reference || '' },
      { id: 'description', label: 'Description', type: 'text', value: r.description || '' }
    ];
  }

  if (kind === 'expense') {
    return [
      { id: 'date', label: 'Date', type: 'date', value: r.date || today() },
      { id: 'amount', label: 'Amount', type: 'number', value: r.amount ?? '', step: '0.01' },
      { id: 'category', label: 'Category', type: 'select', options: categoryOptions(categories, r.category || '') },
      { id: 'payer', label: 'Payee (optional)', type: 'text', value: r.payer || '' },
      { id: 'reference', label: 'Reference # (optional)', type: 'text', value: r.reference || '' },
      { id: 'description', label: 'Description (optional)', type: 'text', value: r.description || '' }
    ];
  }

  // billing (an insurance claim, pending or paid)
  const status = r.status === 'pending' ? 'pending' : 'paid';
  const statusOptions =
    `<option value="pending" ${status === 'pending' ? 'selected' : ''}>Pending (billed, not yet paid)</option>` +
    `<option value="paid" ${status === 'paid' ? 'selected' : ''}>Paid</option>`;

  return [
    { id: 'serviceDate', label: 'Service date', type: 'date', value: r.serviceDate || today() },
    { id: 'billedAmount', label: 'Amount billed (charges)', type: 'number', value: r.billedAmount ?? '', step: '0.01' },
    { id: 'payer', label: 'Insurance payer (optional)', type: 'text', value: r.payer || '' },
    { id: 'status', label: 'Status', type: 'select', options: statusOptions },
    { id: 'paymentDate', label: 'Payment received', type: 'date', value: r.paymentDate || today() },
    { id: 'receivedAmount', label: 'Amount actually received', type: 'number', value: r.receivedAmount ?? '', step: '0.01' },
    { id: 'reference', label: 'Check / EFT # (optional)', type: 'text', value: r.reference || '' },
    { id: 'description', label: 'Description (optional)', type: 'text', value: r.description || '' }
  ];
}

function entryTitle(kind, id, overrides) {
  if (kind === 'income') return id ? 'Edit Income' : 'New Income';
  if (kind === 'expense') return id ? 'Edit Expense' : 'New Expense';
  if (id) return overrides.status === 'paid' ? 'Record Payment' : 'Edit Claim';
  return overrides.status === 'pending' ? 'New Claim' : 'New Insurance Payment';
}

// Paid-only fields are hidden while a claim is pending
function syncBillingFields() {
  const status = $('f_status');
  if (!status) return;
  const pending = status.value === 'pending';
  $('row_paymentDate').hidden = pending;
  $('row_receivedAmount').hidden = pending;
}

// Fill the dialog's form for a new entry (id = null) or an existing one.
// `overrides` are values to pre-set on top of the stored record.
function renderEntryForm(kind, id = null, overrides = {}) {
  editingId = id;
  const stored = id ? records.find(x => x.id === id) : null;
  if (id && !stored) return false;

  const record = { ...(stored || {}), ...overrides };

  $('dialogTitle').textContent = entryTitle(kind, id, overrides);
  $('entryFields').innerHTML = fieldsFor(kind, record).map(f => {
    const control = f.type === 'select'
      ? `<select id="f_${f.id}">${f.options}</select>`
      : `<input id="f_${f.id}" type="${f.type}" value="${esc(f.value)}" ${f.step ? `step="${f.step}"` : ''}>`;
    return `<div class="field" id="row_${f.id}"><label>${f.label}${control}</label></div>`;
  }).join('');

  $('entryForm').dataset.kind = kind;
  $('saveAddBtn').hidden = !!id;     // "Save & Add Another" only makes sense for new entries

  if (kind === 'billing') {
    $('f_status').onchange = syncBillingFields;
    syncBillingFields();
  }
  return true;
}

function openEntry(kind, id = null, overrides = {}) {
  if (!renderEntryForm(kind, id, overrides)) return;
  $('entryDialog').showModal();
}

function closeEntryDialog() {
  $('entryDialog').close('cancel');
  editingId = null;
}

$('cancelEntryBtn').onclick = closeEntryDialog;
$('closeEntryBtn').onclick = closeEntryDialog;
$('entryDialog').addEventListener('close', () => { editingId = null; });

// Save button: read the form, validate, store, refresh
$('entryForm').addEventListener('submit', async e => {
  e.preventDefault();
  const again = !!e.submitter && e.submitter.value === 'again';
  const kind = e.currentTarget.dataset.kind;

  // Work on a copy so a failed validation can't leave a half-edited record in memory
  const existing = editingId ? records.find(x => x.id === editingId) : null;
  if (editingId && !existing) return;
  const r = existing ? { ...existing } : { id: uid(), createdAt: Date.now(), type: kind };

  // Amount boxes can't be left blank (a blank would silently become $0.00)
  const amountIds = kind === 'billing' ? ['billedAmount'] : ['amount'];
  if (kind === 'billing' && $('f_status').value === 'paid') amountIds.push('receivedAmount');
  if (amountIds.some(id => $('f_' + id).value.trim() === '')) {
    alert('Enter the amount.');
    return;
  }

  if (kind === 'income') {
    r.date = $('f_date').value;
    r.amount = Number($('f_amount').value);
    r.category = $('f_category').value;
    r.description = $('f_description').value.trim() || r.category || 'Income';
  }

  if (kind === 'expense') {
    r.date = $('f_date').value;
    r.amount = Number($('f_amount').value);
    r.category = $('f_category').value;
    r.description = $('f_description').value.trim() || r.category || 'Expense';
  }

  if (kind === 'billing') {
    r.serviceDate = $('f_serviceDate').value;
    r.billedAmount = Number($('f_billedAmount').value);
    r.status = $('f_status').value;
    if (r.status === 'paid') {
      r.paymentDate = $('f_paymentDate').value;
      r.receivedAmount = Number($('f_receivedAmount').value);
    } else {
      delete r.paymentDate;
      delete r.receivedAmount;
    }
    r.description = $('f_description').value.trim();
  }

  r.payer = $('f_payer').value.trim();
  r.reference = $('f_reference').value.trim();
  r.updatedAt = Date.now();
  if (!validate(r)) return;

  await putMany([r]);
  records = await getAll();

  if (again) {
    // Keep the dialog open with a fresh form, carrying over the date for convenience
    renderEntryForm(kind, null, kind === 'billing' ? { status: r.status } : { date: r.date });
    const first = $('entryFields').querySelector('input,select');
    if (first) first.focus();
  } else {
    $('entryDialog').close('saved');
    editingId = null;
  }

  refresh();
  setSyncDirty();

  // Let the user know when a saved entry won't be visible in the current Register view
  if (isPending(r)) {
    toast('Claim saved. Pending claims are listed on the Billing tab.');
  } else if (!inRange(recordDate(r), $('registerFrom').value, $('registerThrough').value)) {
    toast('Saved. It falls outside the Register’s current period.');
  } else if (again) {
    toast('Saved.');
  }
});

// Returns true if the record is OK to save; otherwise alerts and returns false
function validate(r) {
  if ((r.type === 'income' || r.type === 'expense') && !r.date) {
    alert('Choose a date.');
    return false;
  }
  if ((r.type === 'income' || r.type === 'expense') && !r.category) {
    alert(`Choose ${r.type === 'income' ? 'an income' : 'an expense'} category.`);
    return false;
  }
  if (r.type === 'billing') {
    if (!r.serviceDate) {
      alert('Choose the service date.');
      return false;
    }
    if (r.billedAmount < 0) {
      alert('Amounts cannot be negative.');
      return false;
    }
    if (r.status === 'paid') {
      if (!r.paymentDate) {
        alert('Choose the payment date.');
        return false;
      }
      if (r.receivedAmount < 0 || r.receivedAmount > r.billedAmount) {
        alert('Received amount must be between $0 and the amount billed.');
        return false;
      }
    }
  }
  if ((r.amount ?? 0) < 0) {
    alert('Amounts cannot be negative.');
    return false;
  }
  return true;
}

// One click handler for all the dynamic Edit / Delete buttons (event delegation)
document.addEventListener('click', async e => {
  // Edit a record
  const editBtn = e.target.closest('[data-edit]');
  if (editBtn) {
    const r = records.find(x => x.id === editBtn.dataset.edit);
    if (r) openEntry(r.type, r.id);
    return;
  }

  // Record the payment for a pending claim
  const payBtn = e.target.closest('[data-markpaid]');
  if (payBtn) {
    const r = records.find(x => x.id === payBtn.dataset.markpaid);
    if (r) openEntry('billing', r.id, { status: 'paid', paymentDate: today() });
    return;
  }

  // Delete a record (replaced by a "tombstone" so the delete syncs to other devices)
  const deleteBtn = e.target.closest('[data-delete]');
  if (deleteBtn) {
    if (confirm('Delete this record?')) {
      const old = records.find(x => x.id === deleteBtn.dataset.delete);
      if (old) {
        await putMany([{ id: old.id, type: 'tombstone', deletedAt: Date.now(), updatedAt: Date.now() }]);
        records = await getAll();
        refresh();
        setSyncDirty();
      }
    }
    return;
  }

  // Delete a category (existing entries keep their category text)
  const categoryBtn = e.target.closest('[data-category-delete]');
  if (categoryBtn) {
    const name = categoryBtn.dataset.categoryDelete;
    const kind = categoryBtn.dataset.categoryKind;
    if (confirm(`Delete the category “${name}”? Existing entries will keep their category.`)) {
      await deleteCategory(name, kind);
    }
  }
});

// The "Add" box under a category list in Settings
function wireCategoryAdd(inputId, buttonId, kind) {
  const names = () => (kind === 'income' ? incomeCategories : categories);

  $(buttonId).onclick = async () => {
    const input = $(inputId);
    const name = input.value.trim();
    if (!name) return;

    if (names().some(c => c.toLowerCase() === name.toLowerCase())) {
      toast('That category already exists.');
      return;
    }

    await addCategory(name, kind);
    input.value = '';
    input.focus();
  };

  $(inputId).addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $(buttonId).click();
    }
  });
}

wireCategoryAdd('newCategory', 'addCategoryBtn', 'expense');
wireCategoryAdd('newIncomeCategory', 'addIncomeCategoryBtn', 'income');


/* ==========================================================================
   9. Register filter controls
   ========================================================================== */

$('registerFilter').onchange = renderRegister;
$('registerCategory').onchange = renderRegister;
$('registerSort').onchange = renderRegister;
$('registerSearch').oninput = renderRegister;

// Changing the period affects both the table and the summary cards
linkPeriodControls('registerPeriod', 'registerFrom', 'registerThrough', () => {
  renderRegister();
  renderSummary();
});

$('registerDirection').onclick = () => {
  registerAscending = !registerAscending;
  $('registerDirection').textContent = registerAscending ? 'Descending ▼' : 'Ascending ▲';
  renderRegister();
};

$('clearRegisterFilters').onclick = () => {
  $('registerFilter').value = 'all';
  $('registerCategory').value = 'all';
  $('registerSearch').value = '';
  $('registerSort').value = 'date';
  registerAscending = false;
  $('registerDirection').textContent = 'Ascending ▲';
  setPeriod('registerPeriod', 'thisMonth');
};

$('billingFilter').onchange = renderBilling;


/* ==========================================================================
   10. Statements (shared by the on-screen preview, the PDF, and the CSV)
   ========================================================================== */

// Paid records whose counting date falls within [from, to] (inclusive)
function recordsInRange(from, to) {
  return activeRecords().filter(r => !isPending(r) && inRange(recordDate(r), from, to));
}

// Claims billed on or before `to` that had not yet been paid by `to`
function outstandingAsOf(to) {
  const open = activeRecords().filter(r =>
    r.type === 'billing' &&
    r.serviceDate && (!to || r.serviceDate <= to) &&
    (isPending(r) || (to && r.paymentDate > to)));

  return {
    count: open.length,
    amount: open.reduce((sum, r) => sum + Number(r.billedAmount), 0)
  };
}

// Totals and groupings for a statement period
function statementData(from, to) {
  const rs = recordsInRange(from, to);
  const billing = rs.filter(r => r.type === 'billing');
  const income = rs.filter(r => r.type === 'income');
  const expenses = rs.filter(r => r.type === 'expense');

  // Charges by income category: claims under "Insurance Payments", the rest by their own category
  const byCategory = new Map();
  const addIncome = (name, amount) => byCategory.set(name, (byCategory.get(name) || 0) + amount);
  billing.forEach(r => addIncome(BILLING_CATEGORY, Number(r.billedAmount)));
  income.forEach(r => addIncome(incomeCategoryOf(r), Number(r.amount)));
  const incomeLines = [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const gross = incomeLines.reduce((sum, [, amount]) => sum + amount, 0);
  const reduction = billing.reduce((sum, r) => sum + adjustmentOf(r), 0);
  const exp = expenses.reduce((sum, r) => sum + Number(r.amount), 0);

  return {
    rs, billing, income, expenses,
    incomeLines, gross, reduction,
    netRevenue: gross - reduction,
    exp,
    net: gross - reduction - exp,
    outstanding: outstandingAsOf(to)
  };
}

// Group expenses by category, categories sorted A-Z: [[category, [records]], ...]
function expenseGroups(expenses) {
  const groups = new Map();
  expenses.forEach(r => {
    const category = r.category || 'Uncategorized';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(r);
  });
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const sumAmounts = items => items.reduce((sum, r) => sum + Number(r.amount), 0);

// One statement transaction line: its date, description, and the three amounts
function statementRow(r) {
  const isBilling = r.type === 'billing';
  const isExpense = r.type === 'expense';
  const isIncome = r.type === 'income';

  return {
    date: recordDate(r),
    desc: r.description || (isBilling ? 'Insurance payment' : isExpense ? 'Expense' : 'Income'),
    gross: isBilling ? Number(r.billedAmount) : isIncome ? Number(r.amount) : 0,
    exp: isExpense ? Number(r.amount) : 0,
    red: isBilling ? adjustmentOf(r) : 0
  };
}

// Statement records sorted by date
function statementRecordsSorted(data) {
  return [...data.rs].sort((a, b) => recordDate(a).localeCompare(recordDate(b)));
}

function renderStatementPreview() {
  const from = $('statementFrom').value;
  const to = $('statementThrough').value;

  if (!from || !to) {
    $('statementPreview').innerHTML = '<div class="hint">Choose a date range to preview the statement.</div>';
    return;
  }

  const d = statementData(from, to);
  const expenseSets = expenseGroups(d.expenses);

  // --- Profit & Loss ---
  const incomeRows = d.incomeLines.length
    ? d.incomeLines.map(([name, amount]) =>
        `<tr><td class="pl-item">${esc(name)}</td><td class="num">${money(amount)}</td></tr>`).join('')
    : '<tr><td class="pl-item empty">No income in this period.</td><td></td></tr>';

  const expenseRows = expenseSets.length
    ? expenseSets.map(([name, items]) =>
        `<tr><td class="pl-item">${esc(name)}</td><td class="num">${money(sumAmounts(items))}</td></tr>`).join('')
    : '<tr><td class="pl-item empty">No expenses in this period.</td><td></td></tr>';

  const memo = d.outstanding.count
    ? `Memo: ${d.outstanding.count} insurance claim${d.outstanding.count === 1 ? '' : 's'} billed but unpaid as of ${dateFmt(to)}, totaling ${money(d.outstanding.amount)}. Not included above (cash basis).`
    : `Memo: no insurance claims were outstanding as of ${dateFmt(to)}.`;

  const profitAndLoss = `
    <div class="statement-section pl">
      <h3>Profit &amp; Loss</h3>
      <table>
        <tbody>
          <tr class="pl-sub"><td colspan="2">Income</td></tr>
          ${incomeRows}
          <tr class="pl-total"><td>Total Charges</td><td class="num">${money(d.gross)}</td></tr>
          <tr><td class="pl-item">Less: Adjustments</td><td class="num">${moneyAcct(-d.reduction)}</td></tr>
          <tr class="pl-total"><td>Net Revenue</td><td class="num${negClass(d.netRevenue)}">${moneyAcct(d.netRevenue)}</td></tr>
          <tr class="pl-sub"><td colspan="2">Expenses</td></tr>
          ${expenseRows}
          <tr class="pl-total"><td>Total Expenses</td><td class="num">${money(d.exp)}</td></tr>
          <tr class="pl-grand"><td>Net Income</td><td class="num${negClass(d.net)}">${moneyAcct(d.net)}</td></tr>
        </tbody>
      </table>
      <div class="hint">${memo}</div>
    </div>`;

  // --- Expense detail: one small table per category ---
  const expenseSections = expenseSets.map(([category, items]) => {
    const lines = items
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(r => `
        <tr>
          <td>${dateFmt(r.date)}</td>
          <td>${esc(r.description || category)}</td>
          <td class="num">${money(r.amount)}</td>
        </tr>`).join('');

    return `
      <div class="statement-section">
        <h3>${esc(category)}</h3>
        <table>
          <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead>
          <tbody>
            ${lines}
            <tr class="statement-total"><td></td><td>Category Total</td><td class="num">${money(sumAmounts(items))}</td></tr>
          </tbody>
        </table>
      </div>`;
  }).join('');

  // --- Transaction listing (everything, in date order) ---
  const transactionRows = statementRecordsSorted(d).map(r => {
    const row = statementRow(r);
    return `
      <tr>
        <td>${dateFmt(row.date)}</td>
        <td>${esc(row.desc)}</td>
        <td class="num">${row.gross ? money(row.gross) : ''}</td>
        <td class="num">${row.exp ? money(row.exp) : ''}</td>
        <td class="num">${row.red ? money(row.red) : ''}</td>
      </tr>`;
  }).join('');

  $('statementPreview').innerHTML = `
    <div class="statement-head">
      <div>
        <h2>True Faith Psychiatry</h2>
        <div>Profit &amp; Loss Statement</div>
        <div class="muted">Cash basis</div>
      </div>
      <div class="nowrap statement-period">
        <div>${dateFmt(from)} – ${dateFmt(to)}</div>
        <div class="muted">Prepared ${dateFmt(today())}</div>
      </div>
    </div>

    ${profitAndLoss}

    <div class="statement-section-title">Expense Detail</div>
    ${expenseSections || '<div class="empty">No expenses in this period.</div>'}

    <div class="statement-section">
      <h3>Transaction Listing</h3>
      <table>
        <thead>
          <tr>
            <th>Date</th><th>Description</th>
            <th class="num">Charges</th><th class="num">Expenses</th><th class="num">Adjustment</th>
          </tr>
        </thead>
        <tbody>
          ${transactionRows || '<tr><td colspan="5" class="empty">No transactions in this period.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

linkPeriodControls('statementPeriod', 'statementFrom', 'statementThrough', renderStatementPreview);

// --- CSV export (for the accountant) ---

// Quote a text cell. Cells that start with = + - @ get a leading apostrophe so that
// spreadsheet programs never treat typed text as a formula.
function csvText(value) {
  let s = String(value ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

const csvNum = n => Number(n || 0).toFixed(2);

function buildCSV(from, to) {
  const header = [
    'Date', 'Type', 'Category', 'Description', 'Payer/Payee', 'Reference',
    'Service Date', 'Charges', 'Adjustment', 'Expense', 'Net Cash'
  ];

  const rows = registerRows()
    .filter(r => inRange(r.date, from, to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .map(r => [
      r.date, csvText(r.type), csvText(r.category), csvText(r.desc), csvText(r.payer), csvText(r.ref),
      r.raw.type === 'billing' ? r.raw.serviceDate : '',
      csvNum(r.gross), csvNum(r.reduction), csvNum(r.expense), csvNum(r.cash)
    ]);

  // Leading BOM so Excel reads the file as UTF-8
  return '\ufeff' + [header.map(csvText), ...rows].map(row => row.join(',')).join('\r\n') + '\r\n';
}


/* ==========================================================================
   11. Encryption
   Password -> PBKDF2 (SHA-256, 210,000 iterations) -> AES-256-GCM key.
   The encrypted file is JSON containing the salt, IV, and ciphertext (base64).
   ========================================================================== */

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// bytes -> base64 (in chunks so large files don't overflow the call stack)
function b64(bytes) {
  let s = '';
  bytes = new Uint8Array(bytes);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// base64 -> bytes
function unb64(s) {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// records -> encrypted JSON string
async function encryptData(items, password) {
  if (!password) throw Error('Enter an encryption password in Settings.');

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);

  const plain = enc.encode(JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    records: items
  }));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);

  return JSON.stringify({
    format: 'TFP-LEDGER-ENC',
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: 210000,
    cipher: 'AES-256-GCM',
    salt: b64(salt),
    iv: b64(iv),
    data: b64(cipher)
  });
}

// encrypted JSON string -> records (throws if the password is wrong)
async function decryptData(text, password) {
  const o = JSON.parse(text);
  if (o.format !== 'TFP-LEDGER-ENC') throw Error('Not a TFP Ledger encrypted file.');

  const key = await deriveKey(password, unb64(o.salt));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, key, unb64(o.data));
  return JSON.parse(dec.decode(plain)).records;
}


/* ==========================================================================
   12. GitHub sync
   The encrypted ledger is stored as a single file in a private repo, using
   the GitHub "contents" API. Records are merged by id; newest edit wins.
   ========================================================================== */

// Read and validate the GitHub fields from Settings
function githubSettings() {
  const owner = $('ghOwner').value.trim();
  const repo = $('ghRepo').value.trim();
  const path = $('ghPath').value.trim() || 'ledger.enc';
  const token = $('ghToken').value.trim();

  if (!owner || !repo || !token) {
    throw Error('Complete the GitHub owner, repository, and token fields in Settings.');
  }
  return { owner, repo, path, token };
}

// Small wrapper around fetch for the GitHub API
async function gh(method, url, body) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${githubSettings().token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (body) headers['Content-Type'] = 'application/json';

  // cache: 'no-store' matters. GitHub lets browsers cache file lookups for about a
  // minute, and a stale copy has an out-of-date "sha", which makes the upload fail with a 409.
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });

  if (!res.ok) throw Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// The API URL of the data file
function githubFileUrl(s) {
  return `https://api.github.com/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/contents/${s.path}`;
}

// GitHub returns file contents as base64 UTF-8; convert to a normal string
function decodeGithubContent(base64) {
  return decodeURIComponent(escape(atob(base64.replace(/\n/g, ''))));
}

// Combine two record lists by id. For the same id, the most recently updated wins.
// Returns a Map of id -> record.
function mergeRecords(local, remote) {
  const map = new Map();
  [...local, ...remote].forEach(x => {
    const old = map.get(x.id);
    const xTime = Number(x.updatedAt || x.createdAt || 0);
    const oldTime = old ? Number(old.updatedAt || old.createdAt || 0) : 0;
    if (!old || xTime >= oldTime) map.set(x.id, x);
  });
  return map;
}

// Store the given records as the new local copy (in memory + IndexedDB)
async function replaceLocalRecords(newRecords) {
  records = newRecords;
  await clearDB();
  await putMany(records);
}

// Show when this device last synced successfully
function showLastSync() {
  const stamp = localStorage.getItem(LAST_SYNC_KEY);
  $('lastSync').textContent = stamp ? `Last synced ${new Date(stamp).toLocaleString()}` : '';
}

// Record a successful sync. `remoteSha` identifies the version of the GitHub file we
// are now in step with, so the update check can tell when someone else changes it.
function markSynced(remoteSha) {
  localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
  if (remoteSha) localStorage.setItem(REMOTE_SHA_KEY, remoteSha);
  showLastSync();
  hideUpdateBanner();
  setUpdateNote('');
}

// Upload: fetch the remote copy, merge it with local, save locally, then encrypt and upload
async function push(retry = true) {
  saveSettings();
  const s = githubSettings();
  const password = $('encPassword').value;
  if (!password) throw Error('Enter the encryption password in Settings.');

  $('syncStatus').textContent = 'Checking GitHub…';
  const url = githubFileUrl(s);

  let existing = null;   // remote file info (we need its sha to overwrite it)
  let remote = [];
  try {
    existing = await gh('GET', url);
    remote = await decryptData(decodeGithubContent(existing.content), password);
  } catch (e) {
    // A 404 just means the file doesn't exist yet; anything else is a real error
    if (!String(e.message).includes('GitHub 404')) throw e;
  }

  const merged = [...mergeRecords(records, remote).values()];
  await replaceLocalRecords(merged);
  refresh();

  $('syncStatus').textContent = 'Encrypting…';
  const content = await encryptData(merged, password);

  const body = {
    message: `Update TFP Ledger ${new Date().toISOString()}`,
    content: btoa(unescape(encodeURIComponent(content))),
    branch: 'main'
  };
  if (existing?.sha) body.sha = existing.sha;

  let saved;
  try {
    saved = await gh('PUT', url, body);
  } catch (e) {
    // 409 = the file changed on GitHub after we read it. Start over once (fresh read and merge).
    if (retry && String(e.message).includes('GitHub 409')) return push(false);
    throw e;
  }

  $('syncStatus').textContent = 'Synced';
  markSynced(saved?.content?.sha);
  toast('Ledger pushed to GitHub.');
}

// Download: fetch the remote copy and merge it into local
async function pull() {
  saveSettings();
  const s = githubSettings();
  const password = $('encPassword').value;
  if (!password) throw Error('Enter the encryption password in Settings.');

  $('syncStatus').textContent = 'Pulling…';

  const file = await gh('GET', githubFileUrl(s));
  const remote = await decryptData(decodeGithubContent(file.content), password);

  await replaceLocalRecords([...mergeRecords(records, remote).values()]);
  refresh();

  $('syncStatus').textContent = 'Pulled + merged';
  markSynced(file.sha);
  toast(`Pulled ${remote.length} records and merged locally.`);
}

function setSyncDirty() {
  $('syncStatus').textContent = 'Unsynced local changes';
}

/* --- Update notice: tell the user when GitHub has newer data than this device ---
   The app never syncs by itself. It only LOOKS at GitHub (read-only) and, if the file
   there is not the version this device last synced with, shows a banner that can't be
   missed. Looking needs the GitHub token but not the encryption password. */

let latestRemoteSha = null;   // version of the GitHub file at the last check
let dismissedSha = null;      // version the user chose "Later" for (this session only)
let lastCheck = 0;
let checking = false;

function setUpdateNote(text) {
  $('updateNote').textContent = text;
}

function showUpdateBanner() {
  $('updateBanner').hidden = false;
  document.body.classList.add('has-banner');
  $('pullBtn').classList.add('attn');
}

function hideUpdateBanner() {
  $('updateBanner').hidden = true;
  document.body.classList.remove('has-banner');
  $('pullBtn').classList.remove('attn');
}

// Compare the GitHub file's version with the one this device last synced with.
// Quiet when sync isn't set up; `force` skips the 30-second throttle.
async function checkForUpdates(force = false) {
  if (checking || (!force && Date.now() - lastCheck < 30000)) return;

  const owner = $('ghOwner').value.trim();
  const repo = $('ghRepo').value.trim();
  if (!owner || !repo) return;                         // GitHub sync isn't set up

  if (!$('ghToken').value.trim()) {
    setUpdateNote('Enter your GitHub token in Settings to check for updates.');
    return;
  }

  checking = true;
  lastCheck = Date.now();
  try {
    const file = await gh('GET', githubFileUrl(githubSettings()));
    setUpdateNote('');
    latestRemoteSha = file.sha;

    if (file.sha === localStorage.getItem(REMOTE_SHA_KEY)) hideUpdateBanner();
    else if (file.sha !== dismissedSha) showUpdateBanner();
  } catch (e) {
    const msg = String(e.message);
    if (msg.includes('GitHub 404')) {
      hideUpdateBanner();                              // nothing has been pushed yet
      setUpdateNote('');
    } else if (msg.includes('GitHub 401') || msg.includes('GitHub 403')) {
      setUpdateNote('Update check failed: GitHub rejected the token.');
    }
    // Other errors (usually being offline) are ignored; we'll look again later
  } finally {
    checking = false;
  }
}

// Look when the app opens, when you come back to it, when the connection returns,
// and every 5 minutes while it's open.
function startUpdateChecks() {
  checkForUpdates(true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdates();
  });
  window.addEventListener('online', () => checkForUpdates(true));
  setInterval(() => {
    if (document.visibilityState === 'visible') checkForUpdates(true);
  }, 5 * 60 * 1000);
}

$('updateLaterBtn').onclick = () => {
  dismissedSha = latestRemoteSha;
  hideUpdateBanner();
};


/* ==========================================================================
   13. Import / export / clear + button wiring
   ========================================================================== */

// Trigger a browser download of some text
async function downloadText(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('exportBtn').onclick = async () => {
  try {
    saveSettings();
    const password = $('encPassword').value;
    if (!password) throw Error('Enter an encryption password in Settings.');

    await downloadText(`tfp-ledger-${today()}.enc`, await encryptData(records, password), 'application/json');
    toast('Encrypted backup exported.');
  } catch (e) {
    alert(e.message);
  }
};

$('importBtn').onclick = () => $('importFile').click();

$('importFile').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const password = $('encPassword').value;
    if (!password) throw Error('Enter an encryption password in Settings.');

    const imported = await decryptData(await file.text(), password);
    await replaceLocalRecords([...mergeRecords(records, imported).values()]);
    refresh();
    setSyncDirty();
    toast('Backup imported and merged.');
  } catch (err) {
    alert('Could not import backup: ' + err.message);
  }

  e.target.value = '';   // allow re-selecting the same file
};

$('clearBtn').onclick = async () => {
  if (confirm('Clear all local ledger data? This does not delete the GitHub copy.')) {
    await clearDB();
    records = [];
    // So the entry forms still have categories to choose from
    await seedCategories(DEFAULT_CATEGORIES, 'expense');
    await seedCategories(DEFAULT_INCOME_CATEGORIES, 'income');
    refresh();
    setSyncDirty();
    toast('Local ledger cleared.');
  }
};

$('pushBtn').onclick = async () => {
  try {
    await push();
  } catch (e) {
    $('syncStatus').textContent = 'Sync error';
    alert(e.message);
  }
};

async function runPull() {
  try {
    await pull();
  } catch (e) {
    $('syncStatus').textContent = 'Sync error';
    alert(e.message);
  }
}

$('pullBtn').onclick = runPull;
$('updatePullBtn').onclick = runPull;

// Save settings whenever any settings field changes
['ghOwner', 'ghRepo', 'ghPath', 'ghToken', 'encPassword', 'rememberToken', 'rememberPassword']
  .forEach(id => $(id).addEventListener('change', saveSettings));

// Check for updates as soon as the GitHub details are filled in
['ghOwner', 'ghRepo', 'ghToken']
  .forEach(id => $(id).addEventListener('change', () => checkForUpdates(true)));

// "Add" buttons. Claims added from the Billing tab start as pending;
// the Register's button records a payment that has already arrived.
$('addIncomeBtn').onclick = () => openEntry('income');
$('addExpenseBtn').onclick = () => openEntry('expense');
$('addBillingBtn').onclick = () => openEntry('billing', null, { status: 'paid' });
$('newBillingBtn').onclick = () => openEntry('billing', null, { status: 'pending' });

// A valid {from, to} from the Statements tab, or null (after alerting) if not
function statementRangeOrAlert() {
  const from = $('statementFrom').value;
  const to = $('statementThrough').value;
  if (!from || !to || from > to) {
    alert('Choose a valid date range first.');
    return null;
  }
  return { from, to };
}

$('statementBtn').onclick = () => {
  const range = statementRangeOrAlert();
  if (range) generatePDF(range.from, range.to);
};

$('csvBtn').onclick = () => {
  const range = statementRangeOrAlert();
  if (range) {
    downloadText(`tfp-ledger-${range.from}-to-${range.to}.csv`, buildCSV(range.from, range.to), 'text/csv');
  }
};

// Tab navigation
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.view + 'View').classList.add('active');
  };
});


/* ==========================================================================
   14. PDF statement generator
   Builds a PDF by hand (no library): US Letter pages, Helvetica text only.
   Coordinates are in points; (0,0) is the bottom-left corner of the page.

   Each page is built from two buffers: shapes (shading, lines) and text.
   Shapes are written first and text last, so text always sits on top of the
   shading, and shapes never appear inside the PDF's text block.
   ========================================================================== */

// Helvetica character widths (1/1000 of the font size) for ASCII 32-126.
// PDF has no built-in right-align or center, so we measure text ourselves.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,    // space ! " # $ % & ' ( ) * + , - . /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,    // 0-9 : ; < = > ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,   // @ A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,    // P-Z [ \ ] ^ _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,    // ` a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584          // p-z { | } ~
];

// Width of text in points. Non-ASCII characters print as "?", so they're measured as "?".
function pdfTextWidth(text, size) {
  const s = String(text);
  let units = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    units += (code >= 32 && code <= 126) ? HELVETICA_WIDTHS[code - 32] : HELVETICA_WIDTHS['?'.charCodeAt(0) - 32];
  }
  return units * size / 1000;
}

// Shorten text with "..." if it is wider than maxWidth
function pdfFit(text, size, maxWidth) {
  let s = String(text);
  if (pdfTextWidth(s, size) <= maxWidth) return s;
  while (s.length && pdfTextWidth(s + '...', size) > maxWidth) s = s.slice(0, -1);
  return s + '...';
}

// Escape text for a PDF string; non-ASCII characters become "?"
function pdfEsc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E]/g, '?');
}

const pdfRound = n => Math.round(n * 100) / 100;

// Draw text with its left edge at x
function pdfText(x, y, text, size = 9, font = 'F1') {
  return `/${font} ${size} Tf\n1 0 0 1 ${pdfRound(x)} ${pdfRound(y)} Tm\n(${pdfEsc(text)}) Tj\n`;
}

// Draw text with its right edge at rightX
function pdfTextRight(rightX, y, text, size = 9) {
  return pdfText(rightX - pdfTextWidth(text, size), y, text, size);
}

// Draw text centered on centerX
function pdfTextCenter(centerX, y, text, size = 9) {
  return pdfText(centerX - pdfTextWidth(text, size) / 2, y, text, size);
}

// Draw a line (width in points; gray 0 = black, 1 = white)
function pdfLine(x1, y1, x2, y2, width = 0.6, gray = 0) {
  return `${gray} G\n${width} w\n${pdfRound(x1)} ${pdfRound(y1)} m\n${pdfRound(x2)} ${pdfRound(y2)} l\nS\n0 G\n`;
}

// Draw a filled gray rectangle (used for header bands and row shading)
function pdfRect(x, y, w, h, gray = 0.9) {
  return `${gray} g\n${pdfRound(x)} ${pdfRound(y)} ${pdfRound(w)} ${pdfRound(h)} re\nf\n0 g\n`;
}

function generatePDF(from, to) {
  const d = statementData(from, to);

  // Page geometry (points)
  const W = 612, H = 792;            // US Letter
  const margin = 42;
  const right = W - margin;          // right edge of the content area
  const usable = right - margin;     // width of the content area
  const cellPad = 5;                 // space between a column line and its text
  const amountRight = right - cellPad;

  const HEADER_GRAY = .88;           // table header bands
  const STRIPE_GRAY = .93;           // alternating row shading

  const pages = [];                  // finished pages: { gfx, txt }
  let gfx = '';                      // shapes for the current page
  let txt = '';                      // text for the current page
  let y = H - 42;                    // current vertical position (moves down the page)

  // --- Page management ---

  const header = () => {
    txt += pdfText(margin, y, 'TRUE FAITH PSYCHIATRY', 17);
    txt += pdfTextRight(right, y, 'PROFIT & LOSS STATEMENT', 9);
    y -= 23;
    txt += pdfText(margin, y, `${dateFmt(from)} - ${dateFmt(to)}`, 10);
    txt += pdfTextRight(right, y, 'Cash basis', 9);
    gfx += pdfLine(margin, y - 8, W - margin, y - 8);
    y -= 25;
  };

  const beginPage = () => {
    gfx = '';
    txt = '';
    y = H - 42;
    header();
  };

  const finishPage = () => {
    pages.push({ gfx, txt });
  };

  // Start a new page if fewer than `need` points remain
  const ensure = (need = 18) => {
    if (y - need < 42) {
      finishPage();
      beginPage();
    }
  };

  // Horizontal divider between sections (skipped at the very top of a page,
  // where it would just double up with the page header's line)
  const separator = () => {
    if (y < H - 42 - 48) gfx += pdfLine(margin, y, W - margin, y);
  };

  // --- Table helpers ---
  // A table is described by `edges`: the x position of each column boundary,
  // including the left and right sides. Columns are separated by thin vertical lines.

  // Thin vertical lines between columns, for one band of the table
  const columnRules = (edges, bottom, height) => {
    for (let i = 1; i < edges.length - 1; i++) {
      gfx += pdfLine(edges[i], bottom, edges[i], bottom + height, .5, .55);
    }
  };

  // Put text in column `col`, aligned 'left', 'center', or 'right', trimmed to fit
  const cell = (edges, col, text, align, size, baseline) => {
    if (text === '') return;
    const left = edges[col];
    const rightEdge = edges[col + 1];
    const fitted = pdfFit(text, size, rightEdge - left - cellPad * 2);

    if (align === 'right') txt += pdfTextRight(rightEdge - cellPad, baseline, fitted, size);
    else if (align === 'center') txt += pdfTextCenter((left + rightEdge) / 2, baseline, fitted, size);
    else txt += pdfText(left + cellPad, baseline, fitted, size);
  };

  // Gray header band (18pt tall) with titles: labels = [[text, align], ...]
  const tableHeader = (edges, labels) => {
    gfx += pdfRect(margin, y - 18, usable, 18, HEADER_GRAY);
    columnRules(edges, y - 18, 18);
    labels.forEach(([label, align], i) => cell(edges, i, label, align, 8, y - 13));
    y -= 29;   // first row's band starts exactly at the bottom of the header
  };

  // One data row (15pt tall). Every second row is shaded.
  // cells = [[text, align], ...]
  const tableRow = (edges, index, cells) => {
    if (index % 2 === 1) gfx += pdfRect(margin, y - 4, usable, 15, STRIPE_GRAY);
    columnRules(edges, y - 4, 15);
    cells.forEach(([text, align], i) => cell(edges, i, text, align, 7, y));
    y -= 15;
  };

  // --- Profit & Loss summary ---
  // A simple two-column statement: account name on the left, amount on the right.

  // Gray band naming a section (INCOME / EXPENSES)
  const plBand = label => {
    ensure(34);
    gfx += pdfRect(margin, y - 4, usable, 14, HEADER_GRAY);
    txt += pdfText(margin + cellPad, y, label.toUpperCase(), 8);
    y -= 15;
  };

  // One line. `indent` for line items; `rule` draws a line above (totals);
  // `heavy` makes it a thicker rule and a bigger font (the bottom line).
  const plLine = (label, value, { indent = false, rule = false, heavy = false } = {}) => {
    ensure(20);
    const size = heavy ? 11 : 9;
    if (rule) gfx += pdfLine(margin, y + 10, right, y + 10, heavy ? .9 : .5);
    txt += pdfText(margin + cellPad + (indent ? 12 : 0), y, label, size);
    if (value !== null) txt += pdfTextRight(amountRight, y, moneyAcct(value), size);
    y -= heavy ? 17 : 14;
  };

  beginPage();
  txt += pdfText(margin, y, 'PROFIT & LOSS', 11);
  y -= 16;

  plBand('Income');
  if (d.incomeLines.length) {
    d.incomeLines.forEach(([name, amount]) => plLine(name, amount, { indent: true }));
  } else {
    plLine('No income in this period.', null, { indent: true });
  }
  plLine('Total Charges', d.gross, { rule: true });
  plLine('Less: Adjustments', -d.reduction, { indent: true });
  plLine('Net Revenue', d.netRevenue, { rule: true });
  y -= 6;

  const expenseSets = expenseGroups(d.expenses);
  plBand('Expenses');
  if (expenseSets.length) {
    expenseSets.forEach(([name, items]) => plLine(name, sumAmounts(items), { indent: true }));
  } else {
    plLine('No expenses in this period.', null, { indent: true });
  }
  plLine('Total Expenses', d.exp, { rule: true });
  y -= 6;
  plLine('Net Income', d.net, { rule: true, heavy: true });

  // Claims billed but not yet paid are not part of cash-basis income; mention them as a memo
  ensure(30);
  txt += pdfText(margin + cellPad, y,
    d.outstanding.count
      ? `Memo: ${d.outstanding.count} claim${d.outstanding.count === 1 ? '' : 's'} billed but unpaid as of ${dateFmt(to)}: ${money(d.outstanding.amount)} (not included above)`
      : `Memo: no insurance claims were outstanding as of ${dateFmt(to)}`,
    7.5);
  y -= 26;

  // --- Expense detail, one table per category ---

  const eEdges = [margin, 112, 470, right];
  const eLabels = [
    ['Date', 'left'],
    ['Description', 'left'],
    ['Amount', 'center']
  ];

  // Category name band, then the column titles
  const categoryHeader = category => {
    gfx += pdfRect(margin, y - 14, usable, 14, HEADER_GRAY);
    txt += pdfText(margin + 4, y - 10, category.toUpperCase(), 8);
    y -= 14;
    tableHeader(eEdges, eLabels);
  };

  // Start a new page (repeating the category header) if fewer than `need` points remain
  const ensureInCategory = (category, need) => {
    if (y - need < 42) {
      finishPage();
      beginPage();
      categoryHeader(category);
    }
  };

  if (expenseSets.length) {
    ensure(100);
    separator();
    y -= 18;
    txt += pdfText(margin, y, 'EXPENSE DETAIL', 11);
    y -= 17;

    for (const [category, items] of expenseSets) {
      ensure(70);
      categoryHeader(category);

      items
        .sort((a, b) => a.date.localeCompare(b.date))
        .forEach((r, i) => {
          ensureInCategory(category, 18);
          tableRow(eEdges, i, [
            [dateFmt(r.date), 'left'],
            [r.description || category, 'left'],
            [money(r.amount), 'right']
          ]);
        });

      // Category total row (not shaded), with a heavier line above it
      ensureInCategory(category, 18);
      gfx += pdfLine(margin, y + 11, right, y + 11, .8);
      columnRules(eEdges, y - 4, 15);
      cell(eEdges, 1, 'Category Total', 'left', 8, y);
      cell(eEdges, 2, money(sumAmounts(items)), 'right', 8, y);
      y -= 29;
    }
  }

  // --- Transaction listing (last, as supporting detail) ---

  const tEdges = [margin, 112, 298, 384, 470, right];
  const tLabels = [
    ['Date', 'left'],
    ['Description', 'left'],
    ['Charges', 'center'],
    ['Expenses', 'center'],
    ['Adjustment', 'center']
  ];

  ensure(100);
  separator();
  y -= 18;
  txt += pdfText(margin, y, 'TRANSACTION LISTING', 11);
  y -= 10;
  tableHeader(tEdges, tLabels);

  const listing = statementRecordsSorted(d);
  if (!listing.length) {
    txt += pdfText(margin + cellPad, y, 'No transactions in this period.', 8);
    y -= 15;
  }

  listing.forEach((r, i) => {
    // On a new page, repeat the column titles
    if (y - 20 < 42) {
      finishPage();
      beginPage();
      tableHeader(tEdges, tLabels);
    }

    const row = statementRow(r);
    tableRow(tEdges, i, [
      [dateFmt(row.date), 'left'],
      [row.desc, 'left'],
      [row.gross ? money(row.gross) : '', 'right'],
      [row.exp ? money(row.exp) : '', 'right'],
      [row.red ? money(row.red) : '', 'right']
    ]);
  });

  finishPage();

  // --- Page footers (added last, when the page count is known) ---

  const streams = pages.map((p, i) => {
    const footerText =
      pdfText(margin, 24, `Prepared ${dateFmt(today())}`, 8) +
      pdfTextRight(right, 24, `Page ${i + 1} of ${pages.length}`, 8);
    const footerLine = pdfLine(margin, 36, right, 36, .4, .6);
    return `${p.gfx}${footerLine}BT\n${p.txt}${footerText}ET`;
  });

  // --- Assemble the PDF file structure ---
  // Object layout: 1 = catalog, 2 = page list, then (page, content) pairs, last = font.

  const objects = [];
  const pageRefs = [];
  const fontObjNumber = 3 + streams.length * 2;

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');   // object 1
  objects.push('');                                    // object 2 (filled in below)

  streams.forEach((stream, i) => {
    const pageObj = 3 + i * 2;
    const contentObj = 4 + i * 2;
    pageRefs.push(`${pageObj} 0 R`);

    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${fontObjNumber} 0 R >> >> /Contents ${contentObj} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${streams.length} >>`;
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  // Write each object and remember its byte offset for the cross-reference table
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets[i + 1] = pdf.length;
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  downloadText(`tfp-statement-${from}-to-${to}.pdf`, pdf, 'application/pdf');
}


/* ==========================================================================
   15. Startup
   ========================================================================== */

(async () => {
  await openDB();
  loadSettings();
  records = await getAll();
  await migrateCategories();

  // Both the Register and Statements start on the current month
  populatePeriodSelects();
  setPeriod('registerPeriod', 'thisMonth');
  setPeriod('statementPeriod', 'thisMonth');

  showLastSync();
  refresh();
  startUpdateChecks();

  // Register the service worker for offline use
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
