# Split Ledger (shared version)

A Splitwise-style app for splitting costs with friends. Everyone in a group sees the same ledger, and changes show up on other phones within a second or two.

- Groups with invite links. People can be added by name first and claim that name when they join.
- Four ways to split: equal, exact amounts, percentages, shares. Every split adds up to the exact amount.
- Balances, the fewest payments to settle up, and "Record" to log a payment in one tap.
- Excel export (expenses with each person's share, balances, settle-up, payments).
- Plain static files plus Supabase. No build step.

This app has its own Supabase project. Do not connect it to the DSR project.

## Files

| Path | What it is |
|---|---|
| `index.html`, `css/style.css` | The page and its look |
| `js/app.js` | Screens and actions |
| `js/math.js` | Splitting, balances and settle-up maths |
| `js/xlsx.js` | Builds the Excel file in the browser |
| `js/client.js`, `js/config.js` | Supabase connection. **You edit `config.js`.** |
| `supabase/schema.sql` | Tables, security rules and functions. Run once. |
| `supabase/tests/` | Database tests (optional, see the end) |
| `tests/math.test.mjs` | Maths tests. Run with `npm test`. |

## Set it up

1. **Create a Supabase project.** At supabase.com, make a new project (a new one, separate from the DSR). Pick the region closest to your users, for example Mumbai.

2. **Create the tables.** In the project, open **SQL Editor > New query**, paste all of `supabase/schema.sql`, and press **Run**. It should finish with "Success". Run it only once on a fresh project.

3. **Turn off email confirmation.** Open **Authentication > Sign In / Providers > Email** and switch **Confirm email** off. Reason: Supabase's built-in email service only sends to people on your own Supabase team, so friends would never get the confirmation email and could not sign up. (If you later set up your own email sending under **Authentication > SMTP Settings**, you can switch confirmation back on.)

4. **Set the site address.** Open **Authentication > URL Configuration**. Set **Site URL** to where the app will live (your Vercel address once deployed, or `http://localhost:3000` while testing) and add the same address under **Redirect URLs**.

5. **Copy your keys into the app.** Open **Project Settings > API**. Copy the **Project URL** and the **anon / publishable** key into `js/config.js`.
   - The anon key is meant to be public. The security rules in `schema.sql` protect the data.
   - Never paste the `service_role` or secret key anywhere in this app.

6. **Try it on your computer.** In this folder run:

   ```
   npx serve . -l 3000
   ```

   Then open http://localhost:3000. Double-clicking `index.html` will not work, because browsers block the app's scripts when a page is opened as a plain file.

7. **Put it online (Vercel).** Run `npx vercel` in this folder. When asked, choose no framework and keep the output folder as `.`. Or push the folder to GitHub and import it in Vercel. Then put the Vercel address into Supabase as the **Site URL** (step 4).

## Using it

1. Open the app, create an account, and tap **New group**. Add the other people by name.
2. In the group, open the **Group** tab and tap **Share invite link**. Send it on WhatsApp.
3. When a friend opens the link, they sign in and pick the name you gave them (or join as someone new).
4. Anyone can add expenses. **Balances** shows who owes whom, and **Record** logs a payment.

## Who can do what

- Anyone in a group can add, edit and delete expenses and payments, and add or rename people. This matches how Splitwise groups work.
- Only the person who created the group can delete it.
- Anyone with the invite link can join and then sees every expense. Use **Make a new link** if a link was shared with the wrong person. People already in the group stay.
- People who have joined can't be removed from the app. Only names that haven't joined yet, and aren't in any expense or payment, can be removed.

## Things to know

- **Forgot password** sends an email, so it only works once you have set up your own email sending (step 3). Until then, reset a password from the Supabase dashboard under **Authentication > Users**.
- **Free Supabase projects pause** after a period of no use. Open the dashboard and press **Restore** if the app stops responding after a quiet spell.
- **Back up your data.** Use **Download Excel** on the Group tab every so often, and check which backup options your Supabase plan includes.
- A group can hold thousands of expenses. Everything loads when a group is opened, so very large groups will open more slowly.

## Tests

- `npm test` runs the maths tests (splits, balances, settle-up). It needs Node 20 or newer.
- `supabase/tests/` has database tests that try to break the security rules (outsiders, cheating the split, claiming names, deleting groups). To run them you need a scratch PostgreSQL 15 or newer: create an empty database, run `pg_setup.sql` (a small stand-in for Supabase's login tables), then `schema.sql`, then `rls_test.sql`. Every line should say PASS.
