# ShareSquare

A Splitwise-style app for splitting costs with friends. Everyone in a group sees the same ledger, and changes show up on other phones within a second or two.

- No accounts, no email. Each person signs in with a 4-digit PIN they pick, from any device.
- Groups with invite links or a short PIN. People can be added by name first and claim that name when they join.
- Four ways to split: equal, exact amounts, percentages, shares. Every split adds up to the exact amount.
- **Scan a bill:** photograph a restaurant bill, check the items it finds, tick who shared each one, and the tax, tip and discount are shared in proportion to what each person ordered.
- Balances, the fewest payments to settle up, and "Record" to log a payment in one tap.
- Excel export (expenses with each person's share, balances, settle-up, payments).
- Plain static files plus Supabase. No build step.

This app needs its own, dedicated Supabase project — don't point it at a Supabase project used by another app.

## Files

| Path | What it is |
|---|---|
| `index.html`, `css/style.css` | The page and its look |
| `js/app.js` | Screens and actions |
| `js/math.js` | Splitting, balances and settle-up maths |
| `js/bill.js` | Reads the text of a scanned bill into items, and splits a bill item by item |
| `js/scan.js` | Reads a bill photo into text on the phone (loads only when someone taps **Scan bill**) |
| `js/xlsx.js` | Builds the Excel file in the browser |
| `js/client.js`, `js/config.js` | Supabase connection. **You edit `config.js`.** |
| `supabase/schema.sql` | Tables, security rules and functions. Run once. |
| `supabase/migrations/` | Small SQL updates for projects that already ran `schema.sql`. Run each file once, in order. |
| `supabase/tests/` | Database tests (optional, see the end) |
| `tests/math.test.mjs`, `tests/bill.test.mjs` | Maths and bill-reading tests. Run with `npm test`. |

## Set it up

1. **Create a Supabase project.** At supabase.com, make a new project, dedicated to this app. Pick the region closest to your users, for example Mumbai.

2. **Create the tables.** In the project, open **SQL Editor > New query**, paste all of `supabase/schema.sql`, and press **Run**. It should finish with "Success". Run it only once on a fresh project.

3. **Turn on anonymous sign-ins.** Open **Authentication > Sign In / Providers > Anonymous** and switch **Enable anonymous sign-ins** on. There's no email anywhere in this app — every device gets a silent, email-less session, and a 4-digit PIN (handled entirely in `schema.sql`) is what actually identifies a person. You do not need the Email provider enabled at all.

4. **Set the site address.** Open **Authentication > URL Configuration**. Set **Site URL** to where the app will live (your Vercel address once deployed, or `http://localhost:3000` while testing) and add the same address under **Redirect URLs**.

5. **Copy your keys into the app.** Open **Project Settings > API**. Copy the **Project URL** and the **anon / publishable** key into `js/config.js`.
   - The anon key is meant to be public. The security rules in `schema.sql` protect the data.
   - Never paste the `service_role` or secret key anywhere in this app.

6. **Try it on your computer.** In this folder run:

   ```
   npx serve . -l 3000
   ```

   Then open http://localhost:3000. Double-clicking `index.html` will not work, because browsers block the app's scripts when a page is opened as a plain file.

7. **Put it online (Vercel).** Push this repo to GitHub and import it in Vercel (choose no framework, output folder `.`), or run `npx vercel` in this folder. Once the Vercel project is connected to the GitHub repo (**Project Settings > Git**), every push to `main` deploys automatically. Put the Vercel address into Supabase as the **Site URL** (step 4).

## Using it

1. Open the app, choose a 4-digit PIN, and tap **New group**. Add the other people by name.
2. In the group, open the **Group** tab and tap **Share invite link**. Send it on WhatsApp.
3. When a friend opens the link, they sign in and pick the name you gave them (or join as someone new).
4. Anyone can add expenses. **Balances** shows who owes whom, and **Record** logs a payment.

## Scan a bill

On the **Expenses** or **Balances** tab, tap **Scan bill**, then take a photo or pick one from the gallery. The items, tax, service charge and discount are read off the photo and shown for checking. Tap the names of the people who shared each item (everyone is ticked to start with). The expense is saved with each person's exact share, so it shows up like any other expense and can be edited later.

- The photo is read on the phone and is never uploaded. The first scan downloads the Tesseract text reader (a few MB, from the jsDelivr CDN); after that the browser keeps it.
- Reading is not perfect, especially on crumpled, dim or handwritten bills. That's why every item can be edited, and the app warns when the items don't add up to the total printed on the bill.
- **Enter items by hand** skips the photo and gives the same item-by-item split.
- An item shared by several people is split equally between them. Tax, tip and round-off are spread in proportion to each person's items; a discount is taken off the same way.

## Who can do what

- Anyone in a group can add, edit and delete expenses and payments, and add or rename people. This matches how Splitwise groups work.
- Only the person who created the group can delete it.
- Anyone with the invite link can join and then sees every expense. Use **Make a new link** if a link was shared with the wrong person. People already in the group stay.
- People who have joined can't be removed from the app. Only names that haven't joined yet, and aren't in any expense or payment, can be removed.

## Things to know

- **There's no password reset.** A PIN is the whole credential — if someone loses theirs, there's no recovery. They'd need a new PIN and to re-join their groups via invite link/PIN.
- **Free Supabase projects pause** after a period of no use. Open the dashboard and press **Restore** if the app stops responding after a quiet spell.
- **Back up your data.** Use **Download Excel** on the Group tab every so often, and check which backup options your Supabase plan includes.
- A group can hold thousands of expenses. Everything loads when a group is opened, so very large groups will open more slowly.

## Tests

- `npm test` runs the maths tests (splits, balances, settle-up) and the bill-reading tests. It needs Node 20 or newer.
- `supabase/tests/` has database tests that try to break the security rules (outsiders, cheating the split, claiming names, deleting groups). To run them you need a scratch PostgreSQL 15 or newer: create an empty database, run `pg_setup.sql` (a small stand-in for Supabase's login tables), then `schema.sql`, then `rls_test.sql`. Every line should say PASS. **Note:** `rls_test.sql` predates the PIN sign-in system (it simulates signed-in users directly, not through `person_devices`) and needs updating to match — it will fail as-is until that's done.
