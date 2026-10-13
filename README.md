# True Faith Psychiatry Ledger

**Short name:** TFP Ledger

A small, installable Progressive Web App for tracking True Faith Psychiatry business income, insurance claims, expenses, and cash-basis Profit & Loss statements.

The app is designed for GitHub Pages. The application can live in a **public repository**, while the ledger itself is stored as an **encrypted file in a separate private GitHub repository**.

## Contents

1. [What it stores](#what-it-stores)
2. [How the numbers work](#how-the-numbers-work)
3. [Setup](#setup)
4. [Daily use](#daily-use)
5. [Using multiple devices](#using-multiple-devices)
6. [Statements](#statements)
7. [Backups, import, and export](#backups-import-and-export)
8. [Security notes](#security-notes)
9. [Troubleshooting](#troubleshooting)
10. [For developers](#for-developers)
11. [Changelog](#changelog)

---

## What it stores

- **Income** received directly, such as cash deposits, each assigned to an income category
- **Expenses**, each assigned to an expense category
- **Insurance claims:**
  - service date
  - amount billed (charges)
  - status: **Pending** (billed, not yet paid) or **Paid**
  - once paid: payment date, amount actually received, and the automatically calculated adjustment
- **Optional detail on every entry:** a payer or payee name and a reference number (for example a check or EFT number)
- **Expense categories** and **income categories** (your own lists, see [Categories](#categories))
- Local working data in the browser (IndexedDB)
- Encrypted GitHub backups and synchronization

No patient names, account numbers, or other patient identifiers are required by the data model. The Payer/Payee field is meant for an insurance company, vendor, or business name, **not a patient**.

## How the numbers work

The same terms are used in the Register, the Billing tab, statements, and the CSV export.

| Term | Meaning |
| --- | --- |
| **Charges** | For insurance claims, the amount billed. For other income, the amount received. |
| **Expenses** | Money spent. |
| **Adjustment** | For insurance claims, amount billed minus amount received (never below zero). This is the contractual write-down or shortfall. |
| **Net Revenue** | Charges minus Adjustments. |
| **Net Income** | Net Revenue minus Expenses. |
| **Cash Balance** (Register only) | Running cash total: money received, minus expenses. |
| **Outstanding claims** | Claims that have been billed but not yet paid. |

Things worth knowing:

- **The ledger is on a cash basis.** A claim counts in the Register and on statements on its **payment date**, not its service date. A pending claim isn't counted anywhere until you record its payment. (It's listed on the Billing tab and noted as a memo at the bottom of statements.)
- Amount received can't be more than the amount billed, and amounts can't be negative or left blank.
- The Register's running Cash Balance is always calculated over *all* records in date order, so it stays correct when you filter, re-sort, or change the period.
- Negative amounts are shown in parentheses, for example ($1,250.00).

---

## Setup

### 1. Create the public application repository

Create a new **public** GitHub repository for the application. A suggested name is:

`truefaith-ledger`

Upload the contents of this package to that repository. Keep the directory structure intact.

The repository should contain:

```text
index.html
manifest.webmanifest
sw.js
README.md
css/style.css
js/app.js
app-icons/app-icon-192.png
app-icons/app-icon-512.png
```

Replace the two icon files with your own icons. The app is already configured for those exact paths.

#### Enable GitHub Pages

In the public repository:

1. Open **Settings**.
2. Open **Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the `main` branch and `/ (root)`.
5. Save.

GitHub will provide the Pages URL for the app.

### 2. Create the private data repository

Create a second repository. Suggested name:

`truefaith-ledger-data`

Set this repository to **Private**.

Tips:

- The app creates `ledger.enc` the first time you push, so the repository doesn't need to contain anything.
- Its default branch must be named **`main`**. The app always writes to `main`. Initializing the repository with a README when you create it is an easy way to make sure the branch exists.
- Do not put application source code in this repository. It is intended to contain the encrypted ledger data only.

### 3. Create a GitHub fine-grained token

The app talks directly to GitHub's REST API from the browser.

Create a **fine-grained personal access token** and restrict it as tightly as possible:

- Resource owner: the GitHub account that owns the private data repository
- Repository access: **Only select repositories**
- Select: `truefaith-ledger-data`
- Repository permissions:
  - **Contents: Read and write**

No access to the public application repository is needed.

GitHub documents fine-grained token permissions here:

https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens

The repository Contents API used by this app supports fine-grained tokens with Contents permission:

https://docs.github.com/en/rest/repos/contents

Fine-grained tokens expire. When yours does, Push and Pull will start failing with a 401 error and you'll need to create a new token and paste it into Settings.

### 4. Configure TFP Ledger

Open the deployed PWA and go to **Settings**.

Enter:

- **GitHub owner:** your GitHub username
- **Private data repository:** `truefaith-ledger-data`
- **Data file:** `ledger.enc`
- **Fine-grained token:** the token created above
- **Encryption password:** a password used to encrypt the ledger before it leaves the browser

Settings are saved automatically when you change a field.

#### Encryption password

The ledger is encrypted in the browser with AES-256-GCM. A key is derived from the encryption password using PBKDF2-SHA256 (210,000 iterations).

**The encryption password is never sent to GitHub.**

The same encryption password must be entered on every device that needs to read the ledger.

If the encryption password is lost, the encrypted GitHub backup cannot be decrypted. There is no recovery option.

The app offers optional "Remember" checkboxes for the GitHub token and encryption password. Leaving them unchecked is more secure, but means they must be entered again each time on that device. See [Security notes](#security-notes) for how remembered values are stored.

### 5. Install the app (optional)

TFP Ledger is a PWA. In most browsers you can install it from the address bar (desktop) or the share/menu button ("Add to Home Screen" on phones). After the first load it also works offline.

---

## Daily use

The app has four tabs:

- **Register:** every transaction that has actually been paid or received, in one table, with summary totals across the top.
- **Billing:** insurance claims, both pending and paid.
- **Statements:** pick a period, preview a Profit & Loss statement, and download it as a PDF or CSV.
- **Settings:** GitHub sync, encryption, categories, and local data tools.

### Adding and editing entries

On the Register, use **+ Income**, **+ Expense**, and **+ Insurance Payment** (a claim that has already been paid). Each entry has optional **Payer/Payee** and **Reference #** boxes. Each row has **Edit** and **Delete** buttons.

In the entry window, **Save & Add Another** saves the entry and gives you a fresh form, which is handy when entering a batch (the date carries over).

Deleting asks for confirmation. A deleted record is replaced internally by a "tombstone" so the deletion can synchronize to other devices.

### Insurance claims

Use the **Billing** tab for the life of a claim:

1. Click **+ New Claim** when you bill. Enter the service date and amount billed; leave the status as **Pending**.
2. The claim appears on the Billing tab with how many days it has been waiting. The cards at the top show your total outstanding amount, the number of pending claims, and the oldest unpaid claim.
3. When the payment arrives, click **Record Payment** on that claim and enter the payment date and the amount actually received. The adjustment is calculated for you.

Only at step 3 does the claim appear in the Register and on statements. If the insurer pays nothing, record a payment of $0.00 to write the claim off fully. The **Show** filter on the Billing tab lets you look at pending claims only.

Claims made before this feature existed are treated as paid.

### Register period, filters, and totals

The Register opens on **This Month**. Use the **Period** menu (This Month, Last Month, This Quarter, Last Quarter, Year to Date, Last Year, All Time) or pick **From** and **Through** dates yourself. The summary cards at the top (Charges, Expenses, Adjustments, Net Cash Movement) cover the selected period, and the row at the bottom of the table totals whatever rows are currently shown.

You can also filter by type, filter by category (income and expense categories are listed separately), search by description, payer, reference, or category, and sort by date, type, description, category, or amount. The sort-direction button reverses the order, and **Clear** resets everything (including the period, back to This Month).

If you save an entry that falls outside the current period, the app tells you so, so you're not left wondering where it went.

### Categories

Manage categories in **Settings**. There are two lists:

- **Expense Categories:** shown in the Expense form.
- **Income Categories:** shown in the Income form. A starter list is provided (Insurance Payments, Self-Pay, Other Income).

Notes:

- Insurance claims always report under **Insurance Payments**. Use the Income form and a different category for money that doesn't come through claims.
- Income entered before income categories existed is reported under **Other Income**.
- A starter list of expense categories is also provided (Fees, Advertising, Office Supplies, Software, Professional Services, Rent, Utilities, Insurance, Travel, Other). Rename or remove them to suit. "Fees" and "Insurance" are broad, so you may want more specific names.
- Deleting a category does not change existing entries; they keep their category text and still appear on statements and in the Register filter.
- Categories can't be renamed. To rename one, add the new name and delete the old one (existing entries keep the old name).
- **Categories sync with the rest of the ledger.** Adding or deleting one marks the ledger as having unsynced changes, and Push and Pull carry categories between devices. If two devices add different categories, you end up with both. A category deleted on one device is deleted everywhere after the next sync, unless someone adds it back later.

### The sync status bar

The bar under the tabs shows the current state: *Local only*, *Unsynced local changes*, *Synced*, *Pulled + merged*, or *Sync error*, along with when this device last synced. Along with the title bar and tabs, it stays visible while you scroll.

---

## Using multiple devices

Each device has its own local copy of the ledger (in the browser's IndexedDB).

- **Pull** downloads the encrypted GitHub ledger and merges it with the local copy.
- **Push** first checks the GitHub copy, merges records, saves the merged result locally, and then uploads the merged encrypted ledger.
- New records have unique IDs, so additions made on different devices can be merged.
- If the same record was edited on two devices, the **most recently edited version wins**. If the timestamps are identical, the GitHub version wins.
- Deleted records are represented as tombstones so a deletion can synchronize to another device.
- Categories are stored as records too, so they sync the same way.

For normal use, a good habit is:

1. **Pull** when starting work on a second device.
2. Enter transactions.
3. **Push** when finished.

Avoid pushing from two devices at the same moment. If GitHub rejects a push because the file changed in the meantime, simply try again.

The app keeps working from the local copy when GitHub is unavailable.

**Upgrading to v1.0.5:** the ledger file now contains pending claims and income categories, which older versions don't understand. Update the app on *every* device (reload it so the new service worker takes over) before you push from the new version or add any pending claims. An older copy that pulls this data will show income categories in its expense list and will mishandle pending claims. The first time each device starts the new version, the starter income categories are added; existing entries and expense categories are untouched.

---

## Statements

Go to **Statements**, choose a **Period** (or set **From** and **Through** dates yourself; both are inclusive), and review the live preview. From there:

- **Create PDF Statement** downloads the statement as a PDF.
- **Export CSV** downloads every transaction in the period as a spreadsheet file, for your accountant.

The statement is a cash-basis **Profit & Loss** and is laid out in the order accountants expect:

1. **Profit & Loss:** Income by category, Total Charges, Less: Adjustments, Net Revenue, then Expenses by category, Total Expenses, and **Net Income**. A memo line notes any claims that were billed but unpaid as of the end of the period (they are not part of cash-basis income).
2. **Expense Detail:** every expense, grouped by category, with a total for each. Categories with no expenses in the period are omitted.
3. **Transaction Listing:** every transaction in date order, with Charges, Expenses, and Adjustment columns.

The PDF is generated locally in the browser and uses the same layout as the preview. It spans multiple pages if needed, repeats column titles at the top of each page, and has the preparation date and "Page X of Y" at the bottom.

In the tables, column titles are centered over their columns, amounts are right-aligned, thin vertical lines separate the columns, and every second row is shaded to make long lists easier to follow. (The Profit & Loss summary itself is not striped.)

### CSV columns

`Date, Type, Category, Description, Payer/Payee, Reference, Service Date, Charges, Adjustment, Expense, Net Cash`

Amounts are plain numbers with two decimals (no currency symbol). Net Cash is money in (positive) or out (negative). Only paid and received items are included. Text cells that start with `=`, `+`, `-`, or `@` get a leading apostrophe so a spreadsheet never mistakes them for a formula.

### PDF limitations

- The PDF uses a basic built-in font, so characters outside plain English letters, numbers, and punctuation (accented letters, curly quotes, emoji) print as `?`. The CSV and the on-screen preview handle them fine.
- A description too long for its column is cut off with "...". The on-screen preview and the CSV show the full text.

---

## Backups, import, and export

There are intentionally two layers of backup:

**Local:**

```text
Browser IndexedDB
```

**Remote:**

```text
Private GitHub repository
    └── ledger.enc
```

The GitHub repository's normal Git history also provides historical versions of the encrypted ledger file. Because the file is encrypted, those historical versions do not contain readable ledger information.

In **Settings → Local Data** you can also:

- **Export encrypted backup:** downloads a standalone `.enc` file, encrypted with your current encryption password.
- **Import encrypted backup:** reads a `.enc` file (using your current encryption password) and **merges** it into the local ledger. It doesn't replace existing data.
- **Clear local data:** erases this device's local ledger. It does not delete the GitHub copy. Pull will bring it back. Categories reset to the starter lists until you Pull.

The **CSV export** on the Statements tab is for sharing readable data with your accountant. It is *not* encrypted, so treat the file accordingly.

---

## Security notes

This application is intended to avoid storing patient identifiers, but it still contains sensitive business financial information.

The important protections are:

- Keep the data repository **private**.
- Use a fine-grained token restricted to that one repository.
- Do not commit a GitHub token to the public application repository.
- Do not put plaintext ledger files into the data repository.
- Use a strong encryption password.
- Do not use patient names or other unnecessary identifying information in descriptions, payer, or reference boxes.

How secrets are handled:

- The encryption password is used locally to encrypt and decrypt the ledger, and is never sent anywhere.
- The GitHub token is sent only to GitHub's API.
- If you tick "Remember" for the token or password, it is saved **unencrypted** in the browser's local storage on that device. Anyone with access to the browser profile could read it. Only use "Remember" on devices you control and trust.
- The local working copy in IndexedDB is **not** encrypted. Encryption applies to the GitHub file and to exported backups.
- CSV and PDF statements are plain files. Share them only through channels you trust.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Complete the GitHub owner, repository, and token fields" | A required Settings field is empty. Remember that the token isn't kept unless "Remember token" is ticked. |
| "Enter the encryption password in Settings" | Same, for the password. |
| `GitHub 401` | The token is wrong, expired, or revoked. |
| `GitHub 403` | The token lacks **Contents: Read and write** on the data repository, or the repository isn't in its selected list. |
| `GitHub 404` on **Pull** | The file doesn't exist yet (push first), or the owner, repository, or file name is misspelled. A 404 on **Push** is treated as "first upload." |
| `GitHub 409` or `422` | The file changed on GitHub during your push, or the repository has no `main` branch. Try again; check the branch name. |
| Pull or import says it can't decrypt | The encryption password is different from the one used to create the file. |
| Browser keeps showing an old version of the app | The service worker is serving cached files. See [Updating a deployed app](#updating-a-deployed-app). |
| An entry I just saved isn't in the Register | It's outside the selected period (the Register opens on This Month), or it's a pending claim (those are on the Billing tab). |
| Income categories show up in the expense list, or odd blank lines appear after a pull | Another device is still running a version older than v1.0.5. Update it (see [Using multiple devices](#using-multiple-devices)). |

---

## For developers

### Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure: four tab views, entry dialog, toast |
| `css/style.css` | Classic Mac OS styling. Rule order matters (later rules override earlier ones). |
| `js/app.js` | All application logic, in numbered sections |
| `sw.js` | Service worker: caches the app shell for offline use |
| `manifest.webmanifest` | PWA manifest (name, icons, display mode) |

There are no dependencies, no build step, and no frameworks.

### Data model

All records live in one IndexedDB store (`records`, keyed by `id`) and share `id`, `type`, `createdAt`, and `updatedAt`.

```text
income     { date, amount, category, payer, reference, description }
expense    { date, amount, category, payer, reference, description }
billing    { serviceDate, billedAmount, status, payer, reference, description,
             paymentDate, receivedAmount }     // last two only when status = 'paid'
category   { name, kind }                      // kind = 'expense' | 'income'
tombstone  { id, deletedAt }                   // marks a deleted record
```

Notes:

- A billing record with no `status` (from older versions) is treated as `paid`.
- Income records with no `category` are reported under "Other Income".
- Category record ids are `category:<lowercase name>` for expense categories (no `kind` also means expense) and `category:income:<lowercase name>` for income categories.
- Only `income`, `expense`, and `billing` records are "ledger" records (they appear in the Register, Billing tab, record count, and statements). Pending claims have no `paymentDate`, so they have no counting date and are excluded from everything cash-based.

Other browser storage (localStorage):

- `tfp-ledger-settings`: GitHub owner, repository, path, and optionally the token and password
- `tfp-last-sync`: timestamp of the last successful push or pull
- `tfp-ledger-categories-migrated`, `tfp-ledger-income-categories-seeded`: flags marking one-time migrations (the old `tfp-ledger-expense-categories` key is read only once, for the first of them)

### Encrypted file format

`ledger.enc` is JSON:

```json
{
  "format": "TFP-LEDGER-ENC",
  "version": 1,
  "kdf": "PBKDF2-SHA256",
  "iterations": 210000,
  "cipher": "AES-256-GCM",
  "salt": "<base64>",
  "iv": "<base64>",
  "data": "<base64 ciphertext>"
}
```

The decrypted payload is `{ "version": 1, "updatedAt": "<ISO date>", "records": [ ... ] }`.

### Merge rule

Records from both sides are combined by `id`. For each `id`, the record with the larger `updatedAt` (or `createdAt` if absent) is kept; ties go to the later-listed record, which is the remote one.

Categories are one record each, so they merge per category. Deleting a category writes a tombstone with the same id, and adding it again later replaces the tombstone. Starter and migrated categories are created with a timestamp of 0, so any real add or delete on any device overrides them.

### Statement calculations

`statementData(from, to)` is shared by the preview, the PDF, and the totals. It selects paid records whose counting date (payment date for claims, otherwise the entry date) falls in the range, totals charges by income category (claims under "Insurance Payments"), and computes adjustments, expenses, and net income. The "outstanding claims" memo counts claims billed on or before the end date that were still unpaid on that date (pending now, or paid after the end date).

### Known limitations

- Pushes always target the `main` branch.
- Tombstones are never purged, so they accumulate slowly.
- Each claim has a single payment. Partial payments or re-billing a denied claim aren't modeled; edit the claim or add a new one.
- There's no void/audit trail (deletes are final, apart from the GitHub file's Git history) and no bank-reconciliation ("cleared") marker.
- Category names are matched case-insensitively, and there's no rename (delete and re-add).
- The local IndexedDB copy is stored unencrypted.

### Updating a deployed app

The service worker serves files from its cache first. If you deploy a change and browsers keep running the old version, increment the version at the top of `sw.js`:

```js
const CACHE_NAME = 'tfp-ledger-v1.0.6';
```

Also bump it whenever you add or rename a file listed in the service worker's `APP_SHELL` list. (In older copies of the file the constant is simply named `CACHE`.)

---

## Changelog

### v1.0.5

- **Terminology:** "Gross Charges" is now **Charges**, "Revenue Reduction" is now **Adjustment**, "Balance" is now **Cash Balance**, and the statement is now a **Profit & Loss Statement** (cash basis).
- **Pending claims:** claims can be saved as Pending (billed, not yet paid) and paid later with **Record Payment**. The Billing tab shows outstanding totals and how long each claim has been waiting. Statements include an outstanding-claims memo.
- **Income categories:** income entries now have categories (synced like expense categories). Insurance claims report under "Insurance Payments", which fixes the old overlap with the "Insurance" expense category in the Register filter.
- **Statement layout:** Profit & Loss summary first, then Expense Detail, then the Transaction Listing. PDFs have page numbers and a preparation date.
- **Periods:** date presets (This Month, Last Month, This Quarter, Last Quarter, Year to Date, Last Year) on the Register and Statements. The Register's summary cards are now scoped to the selected period, and a totals row shows the rows currently displayed. The Register opens on This Month.
- **CSV export** of a statement period for your accountant.
- **Optional Payer/Payee and Reference #** fields on every entry; searchable, and shown in the Register.
- **Entry window:** "Save & Add Another"; the × button and the Enter key now work; blank amounts are rejected instead of becoming $0.00; a category must be chosen deliberately; editing an entry whose category was later deleted keeps that category.
- Negative amounts display in parentheses (and red) in the Register and Profit & Loss.
- The sync bar shows when the device last synced.
- Dates now use your local time zone (previously "today" switched to tomorrow in the evening).

### v1.0.4

- Expense categories sync between devices through the encrypted ledger. Existing category lists are converted automatically on first launch.
- Numeric column titles are centered over their columns, and thin vertical lines separate columns in the app's tables, the statement preview, and the PDF.
- Statement rows are shaded alternately in the preview and the PDF.
- PDF amounts are now truly right-aligned, overlong text is trimmed to fit its column, and column titles repeat on each page.
- Push now refreshes the screen after merging in records from GitHub.

### v1.0.3

- Title bar, tabs, and sync bar stay pinned while scrolling.

### v1.0.2

- Register now displays Gross Charges, Expenses, and Revenue Reduction.
- Expense category is visible in the Register.
- Register supports filtering by type and category, text search, and sorting by date, type, description, category, or amount.
- Statement preview uses a bank-statement-style transaction table with Gross Charges, Expenses, and Revenue Reduction columns.
- Statement expense detail is grouped by category; categories with no expenses are omitted.
- PDF statements use the same layout and can span multiple pages.

### v1.0.0

- Initial release.
