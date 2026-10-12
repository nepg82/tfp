/* ==========================================================================
   TFP Ledger
   --------------------------------------------------------------------------
   A local-first ledger for a small practice. Data lives in IndexedDB and can
   optionally be backed up to a private GitHub repo as an AES-GCM encrypted file.

   Record types stored in IndexedDB (all have id, createdAt, updatedAt):
     income     { date, amount, description }
     expense    { date, amount, category, description }
     billing    { serviceDate, paymentDate, billedAmount, receivedAmount, description }
     tombstone  { id, deletedAt }   <- marks a deleted record so deletes sync

   Sections in this file:
     1. Constants & state
     2. Small helpers
     3. IndexedDB
     4. Settings (localStorage)
     5. Expense categories
     6. Register / billing / summary rendering
     7. Add / edit / delete entries
     8. Register filter controls
     9. Statements (preview + shared calculations)
    10. Encryption
    11. GitHub sync (push / pull / merge)
    12. Import / export / clear + button wiring
    13. PDF statement generator
    14. Startup
   ========================================================================== */


/* ==========================================================================
   1. Constants & state
   ========================================================================== */

const DB_NAME = 'tfp-ledger';
const DB_VERSION = 1;
const STORE = 'records';

const SETTINGS_KEY = 'tfp-ledger-settings';
const CATEGORIES_KEY = 'tfp-ledger-expense-categories';

const DEFAULT_CATEGORIES = [
  'Fees', 'Advertising', 'Office Supplies', 'Software', 'Professional Services',
  'Rent', 'Utilities', 'Insurance', 'Travel', 'Other'
];

let db;                          // the open IndexedDB connection
let records = [];                // in-memory copy of every record (including tombstones)
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

// "2026-03-05" -> "Mar 5, 2026" (noon avoids timezone date-shifting)
const dateFmt = s =>
  s
    ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

const uid = () => crypto.randomUUID();

// Today as "YYYY-MM-DD" (note: based on UTC, as in the original)
const today = () => new Date().toISOString().slice(0, 10);

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

// Every record except deletion markers
function activeRecords() {
  return records.filter(r => r.type !== 'tombstone');
}

// The date a record "counts" on: payment date for billing, otherwise its date
function recordDate(r) {
  return r.type === 'billing' ? r.paymentDate : r.date;
}

// How much insurance paid less than was billed (never negative)
function revenueReduction(r) {
  return Math.max(0, Number(r.billedAmount) - Number(r.receivedAmount));
}


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

  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

  // If "remember" is off, clear the sensitive field after saving
  if (!s.rememberToken) $('ghToken').value = '';
  if (!s.rememberPassword) $('encPassword').value = '';
}


/* ==========================================================================
   5. Expense categories (stored in localStorage)
   ========================================================================== */

function loadCategories() {
  try {
    const saved = JSON.parse(localStorage.getItem(CATEGORIES_KEY) || 'null');
    if (Array.isArray(saved) && saved.length) {
      return [...new Set(saved.filter(Boolean))];
    }
  } catch { /* fall through to defaults */ }

  localStorage.setItem(CATEGORIES_KEY, JSON.stringify(DEFAULT_CATEGORIES));
  return [...DEFAULT_CATEGORIES];
}

let categories = loadCategories();

// Clean up (trim, dedupe, sort), persist, and re-render everything that shows categories
function saveCategories() {
  categories = [...new Set(categories.map(x => x.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  localStorage.setItem(CATEGORIES_KEY, JSON.stringify(categories));
  renderCategories();
  populateRegisterCategory();
}

// The list with Delete buttons in Settings
function renderCategories() {
  const el = $('categoryList');
  if (!el) return;

  el.innerHTML = categories.length
    ? categories.map(c => `
        <div class="category-item">
          <span>${esc(c)}</span>
          <button type="button" class="delete-link" data-category-delete="${esc(c)}">Delete</button>
        </div>`).join('')
    : '<div class="hint">No categories defined.</div>';
}

// The category dropdown in the Register filters (keeps the current choice if still valid)
function populateRegisterCategory() {
  const el = $('registerCategory');
  if (!el) return;

  const previous = el.value;
  el.innerHTML =
    '<option value="all">All Categories</option>' +
    categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  el.value = categories.includes(previous) ? previous : 'all';
}


/* ==========================================================================
   6. Register / billing / summary rendering
   ========================================================================== */

// Turn each record into a uniform "row" for the register table.
//   gross     = what was charged / received before insurance shortfalls
//   expense   = money spent
//   reduction = billed minus received
//   cash      = actual money movement (used for the running balance)
function registerRows() {
  return activeRecords().map(r => {
    const isBilling = r.type === 'billing';
    const isExpense = r.type === 'expense';

    return {
      id: r.id,
      raw: r,
      date: recordDate(r),
      type: isBilling ? 'Billing' : isExpense ? 'Expense' : 'Income',
      desc: r.description || (isBilling ? 'Insurance payment' : isExpense ? 'Expense' : 'Income'),
      category: isExpense ? r.category : (isBilling ? 'Insurance' : 'Income'),
      gross: isExpense ? 0 : isBilling ? Number(r.billedAmount) : Number(r.amount),
      expense: isExpense ? Number(r.amount) : 0,
      reduction: isBilling ? revenueReduction(r) : 0,
      cash: isExpense ? -Number(r.amount) : isBilling ? Number(r.receivedAmount) : Number(r.amount)
    };
  });
}

// Apply the Register's type / category / search / sort controls
function filteredRegisterRows() {
  let rows = registerRows();

  const type = $('registerFilter').value;
  const category = $('registerCategory').value;
  const search = $('registerSearch').value.trim().toLowerCase();
  const sortKey = $('registerSort').value;

  if (type !== 'all') rows = rows.filter(r => r.raw.type === type);
  if (category !== 'all') rows = rows.filter(r => r.category === category);
  if (search) rows = rows.filter(r => `${r.desc} ${r.category}`.toLowerCase().includes(search));

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
    ? rows.map(r => `
        <tr>
          <td>${dateFmt(r.date)}</td>
          <td>${r.type}</td>
          <td>${esc(r.desc)}</td>
          <td class="category">${esc(r.category)}</td>
          <td class="num">${r.gross ? money(r.gross) : ''}</td>
          <td class="num">${r.expense ? money(r.expense) : ''}</td>
          <td class="num">${r.reduction ? money(r.reduction) : ''}</td>
          <td class="num">${money(balanceById.get(r.id) || 0)}</td>
          <td>
            <button class="edit-link" data-edit="${r.id}">Edit</button>
            <button class="delete-link" data-delete="${r.id}">Delete</button>
          </td>
        </tr>`).join('')
    : '<tr><td colspan="9">No transactions match the current filters.</td></tr>';
}

function renderBilling() {
  const billing = activeRecords()
    .filter(r => r.type === 'billing')
    .sort((a, b) => (a.serviceDate || '').localeCompare(b.serviceDate || ''));

  $('billingBody').innerHTML = billing.length
    ? billing.map(r => `
        <tr>
          <td>${dateFmt(r.serviceDate)}</td>
          <td>${dateFmt(r.paymentDate)}</td>
          <td class="num">${money(r.billedAmount)}</td>
          <td class="num">${money(r.receivedAmount)}</td>
          <td class="num">${money(revenueReduction(r))}</td>
          <td>
            <button class="edit-link" data-edit="${r.id}">Edit</button>
            <button class="delete-link" data-delete="${r.id}">Delete</button>
          </td>
        </tr>`).join('')
    : '<tr><td colspan="6">No billing records yet.</td></tr>';
}

// The four totals across the top of the Register
function renderSummary() {
  const rows = registerRows();
  const total = key => rows.reduce((sum, r) => sum + r[key], 0);

  const cards = [
    ['Gross charges', total('gross')],
    ['Expenses', total('expense')],
    ['Revenue reduction', total('reduction')],
    ['Net cash movement', total('cash')]
  ];

  $('registerSummary').innerHTML = cards.map(([label, value]) => `
    <div class="summary">
      <div class="label">${label}</div>
      <div class="value">${money(value)}</div>
    </div>`).join('');
}

// Redraw the whole UI from the current in-memory data
function refresh() {
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
   7. Add / edit / delete entries
   ========================================================================== */

// Describes the form fields for each kind of entry.
// Each field: [id, label, input type, value, step (optional)]
function fieldsFor(kind, r = {}) {
  const selectedCategory = categories.includes(r.category) ? r.category : '';
  const categoryOptions = categories
    .map(c => `<option value="${esc(c)}" ${c === selectedCategory ? 'selected' : ''}>${esc(c)}</option>`)
    .join('');

  if (kind === 'income') {
    return [
      ['date', 'Date', 'date', r.date || today()],
      ['amount', 'Amount received', 'number', r.amount ?? '', '0.01'],
      ['description', 'Description', 'text', r.description || '']
    ];
  }

  if (kind === 'expense') {
    return [
      ['date', 'Date', 'date', r.date || today()],
      ['amount', 'Amount', 'number', r.amount ?? '', '0.01'],
      ['category', 'Category', 'select', categoryOptions],
      ['description', 'Description (optional)', 'text', r.description || '']
    ];
  }

  // billing
  return [
    ['serviceDate', 'Service date', 'date', r.serviceDate || today()],
    ['paymentDate', 'Payment received', 'date', r.paymentDate || today()],
    ['billedAmount', 'Gross charges', 'number', r.billedAmount ?? '', '0.01'],
    ['receivedAmount', 'Amount actually received', 'number', r.receivedAmount ?? '', '0.01'],
    ['description', 'Description (optional)', 'text', r.description || '']
  ];
}

// Open the dialog to create (id = null) or edit (id = record id) an entry
function openEntry(kind, id = null) {
  editingId = id;
  const record = id ? records.find(x => x.id === id) : {};
  if (id && !record) return;

  const titles = {
    income: id ? 'Edit Income' : 'New Income',
    expense: id ? 'Edit Expense' : 'New Expense',
    billing: id ? 'Edit Billing Payment' : 'New Billing Payment'
  };
  $('dialogTitle').textContent = titles[kind];

  $('entryFields').innerHTML = fieldsFor(kind, record).map(([fieldId, label, type, value, step]) => {
    if (type === 'select') {
      return `<div class="field"><label>${label}<select id="f_${fieldId}">${value}</select></label></div>`;
    }
    const stepAttr = step ? `step="${step}"` : '';
    return `<div class="field"><label>${label}<input id="f_${fieldId}" type="${type}" value="${esc(value)}" ${stepAttr}></label></div>`;
  }).join('');

  $('entryForm').dataset.kind = kind;
  $('entryDialog').showModal();
}

$('cancelEntryBtn').onclick = () => {
  $('entryDialog').close('cancel');
  editingId = null;
};

// Save button: read the form, validate, store, refresh
$('entryForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (e.submitter && e.submitter.value === 'cancel') return;

  const kind = e.currentTarget.dataset.kind;
  const r = editingId
    ? records.find(x => x.id === editingId)
    : { id: uid(), createdAt: Date.now(), type: kind };
  if (!r) return;

  if (kind === 'income') {
    r.date = $('f_date').value;
    r.amount = Number($('f_amount').value);
    r.description = $('f_description').value.trim() || 'Income';
  }

  if (kind === 'expense') {
    r.date = $('f_date').value;
    r.amount = Number($('f_amount').value);
    r.category = $('f_category').value;
    r.description = $('f_description').value.trim() || r.category || 'Expense';
  }

  if (kind === 'billing') {
    r.serviceDate = $('f_serviceDate').value;
    r.paymentDate = $('f_paymentDate').value;
    r.billedAmount = Number($('f_billedAmount').value);
    r.receivedAmount = Number($('f_receivedAmount').value);
    r.description = $('f_description').value.trim() || 'Insurance payment';
  }

  r.updatedAt = Date.now();
  if (!validate(r)) return;

  await putMany([r]);
  records = await getAll();
  $('entryDialog').close('saved');
  editingId = null;
  refresh();
  setSyncDirty();
});

// Returns true if the record is OK to save; otherwise alerts and returns false
function validate(r) {
  if ((r.type === 'income' || r.type === 'expense') && !r.date) {
    alert('Choose a date.');
    return false;
  }
  if (r.type === 'expense' && !r.category) {
    alert('Choose an expense category.');
    return false;
  }
  if (r.type === 'billing' && (!r.serviceDate || !r.paymentDate)) {
    alert('Choose both service and payment dates.');
    return false;
  }
  if (r.type === 'billing' && (r.billedAmount < 0 || r.receivedAmount < 0 || r.receivedAmount > r.billedAmount)) {
    alert('Received amount must be between $0 and the gross charges.');
    return false;
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

  // Delete an expense category (existing expenses keep their category text)
  const categoryBtn = e.target.closest('[data-category-delete]');
  if (categoryBtn) {
    const name = categoryBtn.dataset.categoryDelete;
    if (confirm(`Delete the category “${name}”? Existing expenses will keep their category.`)) {
      categories = categories.filter(x => x !== name);
      saveCategories();
    }
  }
});

// Add-category box
$('addCategoryBtn').onclick = () => {
  const input = $('newCategory');
  const name = input.value.trim();
  if (!name) return;

  if (categories.some(c => c.toLowerCase() === name.toLowerCase())) {
    toast('That category already exists.');
    return;
  }

  categories.push(name);
  saveCategories();
  input.value = '';
  input.focus();
};

$('newCategory').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('addCategoryBtn').click();
  }
});


/* ==========================================================================
   8. Register filter controls
   ========================================================================== */

$('registerFilter').onchange = renderRegister;
$('registerCategory').onchange = renderRegister;
$('registerSort').onchange = renderRegister;
$('registerSearch').oninput = renderRegister;

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
  renderRegister();
};


/* ==========================================================================
   9. Statements (shared by the on-screen preview and the PDF)
   ========================================================================== */

// Records whose date falls within [from, to] (inclusive, either bound optional)
function recordsInRange(from, to) {
  return activeRecords().filter(r => {
    const d = recordDate(r);
    return d && (!from || d >= from) && (!to || d <= to);
  });
}

// Totals and groupings for a statement period
function statementData(from, to) {
  const rs = recordsInRange(from, to);
  const billing = rs.filter(r => r.type === 'billing');
  const income = rs.filter(r => r.type === 'income');
  const expenses = rs.filter(r => r.type === 'expense');

  const gross =
    billing.reduce((sum, r) => sum + Number(r.billedAmount), 0) +
    income.reduce((sum, r) => sum + Number(r.amount), 0);
  const reduction = billing.reduce((sum, r) => sum + revenueReduction(r), 0);
  const exp = expenses.reduce((sum, r) => sum + Number(r.amount), 0);
  const net = gross - reduction - exp;

  return { rs, billing, income, expenses, gross, reduction, exp, net, received: gross - reduction };
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
    red: isBilling ? revenueReduction(r) : 0
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

  // Transactions table body
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

  // One small table per expense category
  const expenseSections = expenseGroups(d.expenses).map(([category, items]) => {
    const lines = items
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(r => `
        <tr>
          <td>${dateFmt(r.date)}</td>
          <td>${esc(r.description || category)}</td>
          <td class="num">${money(r.amount)}</td>
        </tr>`).join('');
    const categoryTotal = items.reduce((sum, r) => sum + Number(r.amount), 0);

    return `
      <div class="statement-section">
        <h3>${esc(category)}</h3>
        <table>
          <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead>
          <tbody>
            ${lines}
            <tr class="statement-total"><td></td><td>Category Total</td><td class="num">${money(categoryTotal)}</td></tr>
          </tbody>
        </table>
      </div>`;
  }).join('');

  $('statementPreview').innerHTML = `
    <div class="statement-head">
      <div>
        <h2>True Faith Psychiatry</h2>
        <div>Account Statement</div>
      </div>
      <div class="nowrap">${dateFmt(from)} – ${dateFmt(to)}</div>
    </div>

    <div class="statement-section">
      <h3>Transactions</h3>
      <table>
        <thead>
          <tr>
            <th>Date</th><th>Description</th>
            <th class="num">Gross Charges</th><th class="num">Expenses</th><th class="num">Revenue Reduction</th>
          </tr>
        </thead>
        <tbody>
          ${transactionRows || '<tr><td colspan="5" class="empty">No transactions in this period.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="statement-section">
      <h3>Expense Detail</h3>
      ${expenseSections || '<div class="empty">No expenses in this period.</div>'}
    </div>

    <div class="summary-box">
      <table>
        <tbody>
          <tr><td>Gross Charges</td><td class="num">${money(d.gross)}</td></tr>
          <tr><td>Revenue Reduction</td><td class="num">${money(d.reduction)}</td></tr>
          <tr><td>Net Revenue</td><td class="num">${money(d.gross - d.reduction)}</td></tr>
          <tr><td>Total Expenses</td><td class="num">${money(d.exp)}</td></tr>
          <tr class="grand"><td>Net Income</td><td class="num">${money(d.net)}</td></tr>
        </tbody>
      </table>
    </div>`;
}

$('statementFrom').addEventListener('change', renderStatementPreview);
$('statementThrough').addEventListener('change', renderStatementPreview);


/* ==========================================================================
   10. Encryption
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
   11. GitHub sync
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

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
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

// Upload: fetch the remote copy, merge it with local, save locally, then encrypt and upload
async function push() {
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

  $('syncStatus').textContent = 'Encrypting…';
  const content = await encryptData(merged, password);

  const body = {
    message: `Update TFP Ledger ${new Date().toISOString()}`,
    content: btoa(unescape(encodeURIComponent(content))),
    branch: 'main'
  };
  if (existing?.sha) body.sha = existing.sha;

  await gh('PUT', url, body);

  $('syncStatus').textContent = 'Synced';
  localStorage.setItem('tfp-last-sync', new Date().toISOString());
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
  toast(`Pulled ${remote.length} records and merged locally.`);
}

function setSyncDirty() {
  $('syncStatus').textContent = 'Unsynced local changes';
}


/* ==========================================================================
   12. Import / export / clear + button wiring
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

$('pullBtn').onclick = async () => {
  try {
    await pull();
  } catch (e) {
    $('syncStatus').textContent = 'Sync error';
    alert(e.message);
  }
};

// Save settings whenever any settings field changes
['ghOwner', 'ghRepo', 'ghPath', 'ghToken', 'encPassword', 'rememberToken', 'rememberPassword']
  .forEach(id => $(id).addEventListener('change', saveSettings));

// "Add" buttons
$('addIncomeBtn').onclick = () => openEntry('income');
$('addExpenseBtn').onclick = () => openEntry('expense');
$('addBillingBtn').onclick = () => openEntry('billing');
$('newBillingBtn').onclick = () => openEntry('billing');

// Create PDF button
$('statementBtn').onclick = () => {
  const from = $('statementFrom').value;
  const to = $('statementThrough').value;
  if (!from || !to || from > to) {
    alert('Choose a valid date range first.');
    return;
  }
  generatePDF(from, to);
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
   13. PDF statement generator
   Builds a PDF by hand (no library): US Letter pages, Helvetica text only.
   Coordinates are in points; (0,0) is the bottom-left corner of the page.
   ========================================================================== */

// Escape text for a PDF string; non-ASCII characters become "?"
function pdfEsc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E]/g, '?');
}

// Draw text at (x, y)
function pdfText(x, y, text, size = 9, font = 'F1') {
  return `/${font} ${size} Tf\n1 0 0 1 ${x} ${y} Tm\n(${pdfEsc(text)}) Tj\n`;
}

// Draw a thin line
function pdfLine(x1, y1, x2, y2) {
  return `0.6 w\n${x1} ${y1} m\n${x2} ${y2} l\nS\n`;
}

// Draw a filled gray rectangle (used for table header bands)
function pdfRect(x, y, w, h, gray = 0.9) {
  return `${gray} g\n${x} ${y} ${w} ${h} re\nf\n0 g\n`;
}

function generatePDF(from, to) {
  const d = statementData(from, to);

  // Page geometry
  const W = 612, H = 792;          // US Letter
  const margin = 42;
  const usable = W - margin * 2;

  const pages = [];                // finished page content streams
  let content = '';                // content stream of the page being built
  let y = H - 42;                  // current vertical position (moves down the page)

  // --- Page management ---

  const header = () => {
    content += pdfText(margin, y, 'TRUE FAITH PSYCHIATRY', 17);
    content += pdfText(W - margin - 130, y, 'ACCOUNT STATEMENT', 9);
    y -= 23;
    content += pdfText(margin, y, `${dateFmt(from)} - ${dateFmt(to)}`, 10);
    content += pdfLine(margin, y - 8, W - margin, y - 8);
    y -= 25;
  };

  const beginPage = () => {
    content = 'BT\n';
    y = H - 42;
    header();
  };

  const finishPage = () => {
    content += 'ET';
    pages.push(content);
  };

  // Start a new page if fewer than `need` points remain
  const ensure = (need = 18) => {
    if (y - need < 42) {
      finishPage();
      beginPage();
    }
  };

  // --- Transactions table ---

  const col = [margin, 128, 330, 410, 500];   // x position of each column

  const transactionHeader = () => {
    ensure(38);
    content += pdfRect(margin, y - 18, usable, 18, .88);
    content += pdfText(col[0], y - 13, 'Date', 8);
    content += pdfText(col[1], y - 13, 'Description', 8);
    content += pdfText(col[2], y - 13, 'Gross Charges', 8);
    content += pdfText(col[3], y - 13, 'Expenses', 8);
    content += pdfText(col[4], y - 13, 'Revenue Reduction', 8);
    y -= 26;
  };

  beginPage();
  content += pdfText(margin, y, 'TRANSACTIONS', 11);
  y -= 10;
  transactionHeader();

  for (const r of statementRecordsSorted(d)) {
    ensure(20);
    const row = statementRow(r);

    content += pdfText(col[0], y, dateFmt(row.date), 7);
    content += pdfText(col[1], y, row.desc.slice(0, 31), 7);
    if (row.gross) content += pdfText(col[2] + 48, y, money(row.gross), 7);
    if (row.exp)   content += pdfText(col[3] + 55, y, money(row.exp), 7);
    if (row.red)   content += pdfText(col[4] + 65, y, money(row.red), 7);
    y -= 15;
  }

  // --- Revenue summary ---

  y -= 5;
  ensure(60);
  content += pdfLine(margin, y, W - margin, y);
  y -= 18;

  content += pdfText(margin, y, 'REVENUE SUMMARY', 11);
  y -= 17;
  content += pdfText(margin, y, 'Gross Charges', 9);
  content += pdfText(460, y, money(d.gross), 9);
  y -= 14;
  content += pdfText(margin, y, 'Revenue Reduction', 9);
  content += pdfText(460, y, money(d.reduction), 9);
  y -= 14;
  content += pdfText(margin, y, 'Net Revenue', 9);
  content += pdfText(460, y, money(d.gross - d.reduction), 9);
  y -= 23;

  // --- Expenses by category ---

  content += pdfText(margin, y, 'EXPENSES BY CATEGORY', 11);
  y -= 17;

  for (const [category, items] of expenseGroups(d.expenses)) {
    ensure(50);
    content += pdfRect(margin, y - 14, usable, 14, .88);
    content += pdfText(margin + 4, y - 10, category.toUpperCase(), 8);
    y -= 24;

    for (const r of items.sort((a, b) => a.date.localeCompare(b.date))) {
      ensure(18);
      content += pdfText(margin + 4, y, dateFmt(r.date), 7);
      content += pdfText(128, y, (r.description || category).slice(0, 42), 7);
      content += pdfText(500, y, money(r.amount), 7);
      y -= 13;
    }

    content += pdfLine(margin + 4, y + 4, W - margin, y + 4);
    content += pdfText(350, y - 8, 'Category Total', 8);
    content += pdfText(500, y - 8, money(items.reduce((sum, r) => sum + Number(r.amount), 0)), 8);
    y -= 24;
  }

  // --- Final statement summary ---

  ensure(105);
  content += pdfLine(margin, y, W - margin, y);
  y -= 20;
  content += pdfText(margin, y, 'STATEMENT SUMMARY', 11);
  y -= 18;

  const summary = [
    ['Gross Charges', d.gross],
    ['Revenue Reduction', d.reduction],
    ['Net Revenue', d.gross - d.reduction],
    ['Total Expenses', d.exp],
    ['NET INCOME', d.net]
  ];

  for (const [label, value] of summary) {
    if (label === 'NET INCOME') {
      content += pdfLine(margin, y + 5, W - margin, y + 5);
      y -= 8;
    }
    content += pdfText(margin, y, label, 9);
    content += pdfText(460, y, money(value), label === 'NET INCOME' ? 11 : 9);
    y -= 16;
  }

  finishPage();

  // --- Assemble the PDF file structure ---
  // Object layout: 1 = catalog, 2 = page list, then (page, content) pairs, last = font.

  const objects = [];
  const pageRefs = [];
  const fontObjNumber = 3 + pages.length * 2;

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');   // object 1
  objects.push('');                                    // object 2 (filled in below)

  pages.forEach((stream, i) => {
    const pageObj = 3 + i * 2;
    const contentObj = 4 + i * 2;
    pageRefs.push(`${pageObj} 0 R`);

    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${fontObjNumber} 0 R >> >> /Contents ${contentObj} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`;
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
   14. Startup
   ========================================================================== */

(async () => {
  await openDB();
  loadSettings();
  records = await getAll();

  renderCategories();
  populateRegisterCategory();

  // Default statement range: first of this month through today
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  $('statementFrom').value = firstOfMonth.toISOString().slice(0, 10);
  $('statementThrough').value = today();

  refresh();

  // Register the service worker for offline use
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();