# True Faith Psychiatry Ledger

**Short name:** TFP Ledger

A small, installable Progressive Web App for tracking True Faith Psychiatry business income, insurance billing, expenses, and date-range financial statements.

The app is designed for GitHub Pages. The application can live in a **public repository**, while the ledger itself is stored as an **encrypted file in a separate private GitHub repository**.

## What it stores

- Income received directly, such as cash deposits
- Expenses, with an optional category
- Insurance billing records:
  - service date
  - payment date
  - amount billed
  - amount actually received
  - automatically calculated insurance shortfall
- Date-range statements
- Local IndexedDB working data
- Encrypted GitHub backups/synchronization

No patient names, account numbers, or other patient identifiers are required by the data model.

## 1. Create the public application repository

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

### Enable GitHub Pages

In the public repository:

1. Open **Settings**.
2. Open **Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the `main` branch and `/ (root)`.
5. Save.

GitHub will provide the Pages URL for the app.

## 2. Create the private data repository

Create a second repository. Suggested name:

`truefaith-ledger-data`

Set this repository to **Private**.

It can start completely empty. The app will create `ledger.enc` the first time you push the ledger.

Do not put application source code in this repository. It is intended to contain the encrypted ledger data only.

## 3. Create a GitHub fine-grained token

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

The repository Contents API used by this app supports fine-grained tokens with Contents permission.

https://docs.github.com/en/rest/repos/contents

## 4. Configure TFP Ledger

Open the deployed PWA and go to **Settings**.

Enter:

- **GitHub owner:** your GitHub username
- **Private data repository:** `truefaith-ledger-data`
- **Data file:** `ledger.enc`
- **Fine-grained token:** the token created above
- **Encryption password:** a password used to encrypt the ledger before it leaves the browser

### Encryption password

The ledger is encrypted in the browser with AES-256-GCM. A key is derived from the encryption password using PBKDF2-SHA256.

**The encryption password is never sent to GitHub.**

The same encryption password must be entered on every device that needs to read the ledger.

If the encryption password is lost, the encrypted GitHub backup cannot be decrypted.

The app offers optional "Remember" checkboxes for the GitHub token and encryption password. Leaving them unchecked is more secure, but means they must be entered again on that device.

## 5. Using multiple devices

Each device has its own local IndexedDB copy.

- **Pull** downloads the encrypted GitHub ledger and merges it with the local copy.
- **Push** first checks the GitHub copy, merges records, and then uploads the merged encrypted ledger.
- New records have unique IDs, so additions made on different devices can be merged.
- Deleted records are represented internally as tombstones so a deletion can synchronize to another device.

For normal use, a good habit is:

1. Pull when starting work on a second device.
2. Enter transactions.
3. Push when finished.

The app also keeps the local copy so it can be used when GitHub is temporarily unavailable.

## 6. Statements

Go to **Statements**, select the beginning and ending dates, and choose **Create PDF Statement**.

The statement includes:

- Insurance payments received
- Other income received
- Actual income received
- Insurance amount billed
- Insurance shortfall
- Expenses
- Net cash movement
- A transaction listing

The PDF is generated locally in the browser.

## 7. Important security notes

This application is intended to avoid storing patient identifiers, but it still contains sensitive business financial information.

The important protections are:

- Keep the data repository **private**.
- Use a fine-grained token restricted to that one repository.
- Do not commit a GitHub token to the public application repository.
- Do not put plaintext ledger files into the data repository.
- Use a strong encryption password.
- Do not use patient names or other unnecessary identifying information in transaction descriptions.

The GitHub token is stored only in the browser when the user chooses to remember it. The encryption password is used locally to decrypt/encrypt the ledger.

## 8. Service-worker cache version

If you make a deployed application change and the browser appears to keep running an older version, increment the cache name at the top of `sw.js`:

```js
const CACHE = 'tfp-ledger-v1.0.1';
```

The current package starts at `v1.0.0`.

## 9. Backup philosophy

There are intentionally two layers:

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

The app's **Export encrypted backup** function provides an additional standalone backup file.
