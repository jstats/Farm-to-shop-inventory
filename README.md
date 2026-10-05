# Beelove Stock: farm-to-shop inventory

A phone app for Beelove Farm workers to record stock as it moves from the **farm** to the
**Kiunduani** and **Nairobi** shops and is sold, with a dashboard that updates as they record.

Workers open a link on their phone and add it to the home screen. Nothing is installed from the Play Store.
It works with no signal: entries are saved on the phone and sent when signal comes back.
Everything goes into a Google Sheet that you own.

## What workers record

| Button | When | What it does |
|---|---|---|
| 📦 Restock / harvest | New stock arrives (harvest, workshop, supplier) | Adds to the farm, or to a shop |
| 🚚 Send stock | Stock leaves the farm for a shop (or between shops) | Takes from one place, adds to the other |
| 🧾 Record sales | End of the day, or after each sale | Takes from the shop; records the price charged |
| 📋 Monthly count | Once a month at each place | Sets stock to what is really on the shelf; the difference is shown as missing or extra |

**No signal?** Workers record as normal. Entries wait on the phone ("3 waiting for signal" at the top) and
are sent automatically when signal returns. Only the very first sign-in on a phone needs signal.

**Only from the right place.** Once a manager has set a place's GPS point, entries for that place can only
be saved within 200 m of it: sales and counts at that shop, transfers where the stock leaves, restocks where it
arrives. GPS works without data, so this works offline too. Every entry stores where the phone was and how far
it was from the place (`lat`, `lon`, `accuracyM`, `distanceM` in `movements`).

**Reminders.** Every day at 6pm, each shop with no sales recorded that day emails its workers. On the last day
of the month (9am and 6pm), each place not yet counted emails its workers. Managers get one email listing who was
reminded. With Gmail on their phone, workers get a notification even if they never open the app. Inside the app,
the same reminders show as yellow banners (sales from 4pm; the count in the last 3 days of the month).

Each worker signs in with **their name and a PIN**. The sheet records the signed-in name on every
entry, so you can tell who did what. The worker's name comes from the sheet, never from the phone.

## The dashboard

- Sales this month (KSh and units), split by shop, and a 12-month sales chart
- Stock at the farm and each shop, plus the stock value at selling price
- Low stock: any shop at or below an item's reorder level, and how many the farm has to send
- Monthly count status for each place, and the count differences (stock that went missing)
- Best sellers this month and the latest activity, with who recorded it

## Items

The 16 items come from the website's beekeeping shop page, with the same names and prices.
The **reorder levels are my first guess**. Change them in the sheet.
To add fish products or anything else, add a row to the `items` tab.
Workers see the change the next time their app refreshes.

## Setting it up (about 15 minutes, one time)

### 1. The Google Sheet and backend
1. Create a new Google Sheet, for example **"Beelove Stock"**, in the beelovefarm25 Google account.
2. In the sheet, go to **Extensions → Apps Script**. Delete what is there and paste in `backend/Code.gs`.
   Under Project Settings, tick "Show appsscript.json", then paste in `backend/appsscript.json`.
3. Choose the `setup` function and press **Run**, then approve the permissions.
   This creates the `items`, `locations`, `workers` and `movements` tabs and fills in the items and the three places.
4. Open the `workers` tab. Add each worker with a PIN (4 or more digits), for example `Kalondu | 4821 | yes`.
   Put `manager` in the `role` column for anyone allowed to set place locations.
   For reminders, fill in `email` and `place` (the shop or farm they work at, e.g. `Kiunduani Shop`).
5. Go to **Deploy → New deployment → Web app**. Set Execute as: **Me** and Who has access: **Anyone**. Then press Deploy.
   Copy the web app URL, which ends in `/exec`.

### 2. The app
1. Paste that URL into `docs/config.js` as `apiUrl` and commit.
2. On GitHub, go to **Settings → Pages**. Set Source: *Deploy from a branch*, Branch: `main`, Folder: `/docs`, then save.
   The app will be at `https://jstats.github.io/Farm-to-shop-inventory/`.
3. Send workers the link. On their phone they open it in Chrome, then tap ⋮ → **Add to Home screen**.

### 3. Turn on reminders
In Apps Script, pick `setupReminders` and press **Run** once (approve the email permission).
To stop them: the ⏰ **Triggers** page in the left menu, delete the two `reminders` triggers.

### 4. Set each place's location
A manager signs in on their phone, goes to the farm, then each shop. At each place they open **Me → Place
locations** and tap **I am here** while standing inside. Places that are not set accept entries from anywhere.
To allow a bigger area (e.g. a large farm), type a distance in metres in `radiusM` in the `locations` tab.

### 5. Day one: the opening count
Before anything else, do a **Monthly count** at the farm, Kiunduani and Nairobi, with every item counted.
That sets the starting stock. Until then the dashboard shows everything as "Out".

## Good to know

- **Mistakes:** don't edit or delete rows in `movements`. If a number was wrong, the next count corrects the stock.
  If a whole entry was wrong, a manager can delete that row in the sheet; the change shows on the next refresh.
- **New branch:** add a row to `locations` with role `shop`. It appears in every form and on the dashboard.
- **Someone leaves:** set `active` to `no` in `workers`. Their old entries keep their name.
- **Forgotten PIN:** change it in `workers`. After 5 wrong PINs, that name is locked for 15 minutes.
- **Privacy:** the app's code is public on GitHub. The data is not: the sheet only answers to a valid name and PIN.
- **Updating the app:** after changing any file in `docs/`, bump `VERSION` in `docs/sw.js`, so phones pick up the new version.
  After changing `Code.gs`, paste the new code, run `setup` again (it adds any new columns and keeps your data), then
  **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**, so the URL stays the same.
- **Location refused?** The app says why: location turned off, GPS too weak (step outside for a moment), or too far.
  A manager can see each entry's distance in `movements`.

## Try it without the sheet

With `apiUrl` empty, the app runs in **demo mode** with made-up sales, and any name and PIN work:

```
npm start            # http://localhost:8080
npm test             # stock maths + backend tests
```

## Files

- `docs/`: the app (plain HTML/JS, no build step), served by GitHub Pages
  - `app.js`: screens, offline queue, sync
  - `stock.js`: stock maths (replays movements; counts reset balances)
  - `seed.js`: starting items/places, and demo data
  - `sw.js`: offline support
- `backend/Code.gs`: the Google Apps Script backend
- `tests/`: `npm test`
