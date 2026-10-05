# Beelove Stock: farm-to-shop inventory

A phone app for Beelove Farm workers to record stock as it moves from the **farm** to the
**Kiunduani** and **Nairobi** shops and is sold, with a dashboard that updates as they record.

Workers open a link on their phone and add it to the home screen. Nothing is installed from the Play Store.
It works with no signal: entries are saved on the phone and sent when signal comes back.
Everything goes into a Google Sheet that you own.

## What workers record

| Button | When | What it does |
|---|---|---|
| 📦 Restock / harvest | New stock arrives | Adds to a place. Asks **Our own** (harvested, made in the workshop, born) or **Bought** (from whom, and the price paid for one) |
| 🚚 Send stock | Stock leaves the farm for a shop (or between shops) | Takes from one place, adds to the other |
| 🧾 Record sales | End of the day, or after each sale | Takes from a shop, or from the **Farm (market)** for produce, animals and fish sold at the market |
| ⚠️ Record loss | Something spoilt, died, broke or was stolen | Takes from a place, with the reason |
| 🍯 Pack honey | Bulk honey is put into jars and bottles (shown to people who work where bulk honey is kept) | Takes the kg used from bulk honey, adds the jars/bottles filled, and shows what was left on the equipment |
| 📥 Delivery arrived | A card appears at the shop when stock is sent to it | The shop types what actually arrived; anything short is recorded as lost on the way, with who sent and who received |
| 📋 Monthly count | End of every month, at each place | Sets stock to what is really there; the difference shows as missing or extra |

**Where things are kept.** Each item has `places` in the items tab: honey `Farm, Kiunduani Shop, Nairobi Shop`,
hives and equipment `Kiunduani Shop, Nairobi Shop`, bananas, rabbits, sheep and fish `Farm`. Forms only list the
items kept at the chosen place, so the shop never sees sheep and the farm never sees bee suits.

**Typical flows**
- Honey we harvest: Restock *Raw honey — bulk (kg)* at Farm → *Our own*. Honey bought from farmers: the same → *Bought*,
  with the farmer's name and price per kg. Then *Pack honey* into jars and bottles, *Send stock* to the shops,
  and the shop confirms the delivery.
- Hives from the workshop: Restock at Kiunduani Shop → *Our own*. Equipment from a supplier: Restock at the shop → *Bought*.
- Matoke / ripe bananas: Restock at Farm when harvested → *Record sales* at *Farm (market)*. Rotten bunches → *Record loss*.
- Rabbits, Dorper sheep, fish: Restock at Farm when born / stocked → *Record sales* at *Farm (market)*;
  deaths → *Record loss*; the monthly count is the headcount.

**No signal?** Workers record as normal. Entries wait on the phone ("3 waiting for signal" at the top) and
are sent automatically when signal returns. Only the very first sign-in on a phone needs signal.

**Following the honey.** The dashboard's *Honey flow* table (and the monthly report) shows, per place and honey product,
Start + In − Out − Sold − Lost ± Count = Now, with totals in kg. Every kilo is followed from the hive or the farmer,
through packing (`kgEach` in the items tab says how much honey each jar or bottle holds), delivery and the shelf, to the
sale. Unexplained gaps show up as delivery shortfalls (who sent, who received) or as count differences (which shop).

**Reminders.** The app is the main reminder. When a worker opens it, a big card at the top says what is due,
with one button straight to the right form, and a strip shows on every other screen until it is done:
- **Record today's sales:** from 4pm, when their shop has nothing recorded that day.
- **Count the stock today:** in the last 3 days of the month. If missed, "October count was missed" stays for the
  first 3 days of the next month. Only a count in that window counts as the month-end count.

Workers see reminders for their own places (`place` in the workers tab, several allowed); anyone with no place sees every place.
Email is a backup: at 6pm (sales) and on the last day of the month (count), the sheet emails the workers concerned.

**Reports, to the owner only.** Every Monday morning a weekly report, and on the 4th of each month a monthly report
(it waits for counts done on the 1st–3rd), are emailed to the Google account that owns the sheet, and nobody else:
sales by shop and at the market, best sellers, new stock split into our own and bought (who from, and what was
paid), stock sent to shops, losses with reasons, month-end counts and missing stock, low stock, and who recorded what.
To see one now, run `sendTestReport` in Apps Script.

**The dashboard is for managers only.** Put `manager` in the `role` column of the workers tab for yourself. Everyone
else sees only *Record* and *Me*, and their phone only receives the entries of their own places (and their own
entries), so business totals never reach it.

Each worker signs in with **their name and a PIN**. The sheet records the signed-in name on every
entry, so you can tell who did what. The worker's name comes from the sheet, never from the phone.

## The dashboard

- Sales this month (KSh and units), split by shop, and a 12-month sales chart
- Stock at the farm and each shop, plus the stock value at selling price
- Low stock: any shop at or below an item's reorder level, and how many the farm has to send
- Monthly count status for each place, and the count differences (stock that went missing)
- Best sellers this month and the latest activity, with who recorded it

## Items

The 26 beekeeping items come from beelovefarm.org/shop/beekeeping (October 2026), with the same names and prices;
the **reorder levels are a first guess**. When the website's prices change, edit them in the `items` tab
(or ask for the list in `backend/Code.gs` to be updated and run `applyWebsitePrices`, which updates names, prices
and places, adds new items and switches off retired ones without touching history or items you added).
"Raw honey — bulk (per kg)" is the honey harvested or bought in kg at the farm, before it is packed. Matoke, ripe bananas, rabbits, Dorper sheep, tilapia and catfish
(fingerlings per piece, table fish per kg) start at **price 0**: workers type the price at each sale until you
fill it in. Change anything in the `items` tab; add a row for a new item (give it a unique `itemId` and its `places`).
To stop selling something set `active` to `no` (don't delete the row). Workers see changes on their next refresh.

## Setting it up (about 15 minutes, one time)

### 1. The Google Sheet and backend
1. Create a new Google Sheet, for example **"Beelove Stock"**, in the beelovefarm25 Google account.
2. In the sheet, go to **Extensions → Apps Script**. Delete what is there and paste in `backend/Code.gs`.
   Under Project Settings, tick "Show appsscript.json", then paste in `backend/appsscript.json`.
3. Choose the `setup` function and press **Run**, then approve the permissions.
   This creates the `items`, `locations`, `workers` and `movements` tabs and fills in the items and the three places.
4. Open the `workers` tab. Add each worker with a PIN (4 or more digits), for example `Kalondu | 4821 | yes`.
   For reminders, fill in `email` and `place`: where they work, e.g. `Kiunduani Shop`. Someone who works in
   several places gets them all, separated by commas: `Farm, Kiunduani Shop`.
5. Go to **Deploy → New deployment → Web app**. Set Execute as: **Me** and Who has access: **Anyone**. Then press Deploy.
   Copy the web app URL, which ends in `/exec`.

### 2. The app
1. Paste that URL into `docs/config.js` as `apiUrl` and commit.
2. On GitHub, go to **Settings → Pages**. Set Source: *Deploy from a branch*, Branch: `main`, Folder: `/docs`, then save.
   The app will be at `https://jstats.github.io/Farm-to-shop-inventory/`.
3. Send workers the link. On their phone they open it in Chrome, then tap ⋮ → **Add to Home screen**.

### 3. Turn on reminders and reports
In Apps Script, pick `setupReminders` and press **Run** once (approve the email permission).
To stop them: the ⏰ **Triggers** page in the left menu, delete the `reminders`, `weeklyReport` and `monthlyReport` triggers.

### 4. Day one: the opening count
Before anything else, do a **Monthly count** at the farm, Kiunduani and Nairobi, with every item counted.
That sets the starting stock. Until then the dashboard shows everything as "Out".

## Good to know

- **Mistakes:** don't edit or delete rows in `movements`. If a number was wrong, the next count corrects the stock.
  If a whole entry was wrong, you can delete that row in the sheet; the change shows on the next refresh.
- **New branch:** add a row to `locations` with role `shop`. It appears in every form and on the dashboard.
- **Someone leaves:** set `active` to `no` in `workers`. Their old entries keep their name.
- **Forgotten PIN:** change it in `workers`. After 5 wrong PINs, that name is locked for 15 minutes.
- **Privacy:** the app's code is public on GitHub. The data is not: the sheet only answers to a valid name and PIN.
- **Updating the app:** after changing any file in `docs/`, raise `VERSION` in `docs/sw.js` and `APP_VERSION` in
  `docs/app.js` together (a test checks they match). Phones switch to the new version the next time the app is opened
  with signal (or after the form being filled is saved); **Me** shows the version number.
  After changing `Code.gs`, paste the new code, run `setup` again (it adds any new columns and keeps your data), then
  **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**, so the URL stays the same.

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
