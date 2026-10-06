/**
 * Beelove farm-to-shop inventory backend (Google Apps Script, bound to the inventory Google Sheet).
 *
 * The sheet is the record. Workers' phones send stock movements here; the app's dashboard reads them back.
 *   items      – what we sell. Edit names, prices and reorder levels here; set active = no to hide an item.
 *                places = where the item is kept (e.g. "Farm" or "Kiunduani Shop, Nairobi Shop"); empty = everywhere.
 *                Forms only list the items kept at the chosen place. kgEach = kg of honey in one unit (honey only).
 *                container = the empty jar/bottle a filled unit uses up (itemIds, comma-separated: add lids or labels
 *                later); packing takes them off the Packaging stock automatically.
 *   locations  – the farm and the shops (Kiunduani, Nairobi). Add a row with role = shop for a new branch.
 *   workers    – who may sign in: name + PIN. Set active = no when someone leaves. email + place decide who gets
 *                which reminder; place is where they work, several separated by commas (e.g. "Farm, Kiunduani Shop").
 *                role = manager sees the dashboard and everything; anyone else only receives the entries of their
 *                own places (and their own entries), so business totals never reach their phone.
 *   movements  – one row per captured movement. Never edit "movementId"; fix mistakes with a new count.
 *                Restocks say source = own (harvest, workshop, born) or bought (supplier + cost per unit);
 *                losses say reason = spoilt / died / broken / stolen / other. Lines saved together share a batch:
 *                a delivery (transfer) is confirmed by receive lines with the same batch (qty arrived of sent);
 *                a packing (pack) takes kg from bulk honey (from) and adds jars/bottles (to).
 *
 * Every request carries the worker's name and PIN. The worker recorded on a movement is the signed-in
 * worker, never a name the phone sends. After MAX_FAILS wrong PINs a name is locked for LOCK_MINUTES.
 *
 * Reminders and reports: run setupReminders() once. Every day at 18:00 each shop with no sales recorded that day
 * emails its workers; on the last day of the month (09:00 and 18:00) each place not yet counted emails its workers.
 * Every Monday 07:00 a weekly report, and on the 4th at 07:00 a monthly report (after late counts are in), go ONLY
 * to the Google account that owns this script. Nothing is sent before the first movement is recorded.
 *
 * First time: run setup() once from the Apps Script editor, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). Put the web app URL in docs/config.js.
 */
var MAX_FAILS = 5;
var LOCK_MINUTES = 15;
var APP_URL = 'https://jstats.github.io/Farm-to-shop-inventory/';
var TZ = 'Africa/Nairobi';
var EVENING_HOUR = 18;  // daily sales reminder (and a second count reminder on the last day)
var MORNING_HOUR = 9;   // first count reminder on the last day of the month
var REPORT_HOUR = 7;    // weekly report on Mondays, monthly report on the REPORT_MONTH_DAY
var REPORT_MONTH_DAY = 4;  // the month-end count may be done up to the 3rd, so the monthly report waits for it

var TABS = {
  items:     ['itemId', 'name', 'category', 'unit', 'price', 'reorderLevel', 'active', 'places', 'kgEach', 'container'],
  locations: ['locationId', 'name', 'role'],
  workers:   ['name', 'pin', 'active', 'email', 'place', 'role'],
  movements: ['movementId', 'date', 'type', 'itemId', 'itemName', 'qty', 'unit', 'from', 'to', 'price', 'amount',
              'worker', 'note', 'at', 'receivedAt', 'source', 'supplier', 'cost', 'reason', 'batch', 'sent'],
};

// From beelovefarm.org/shop/beekeeping (October 2026), plus farm produce, livestock and fish (prices to be set in the sheet).
// reorderLevel = warn when a shop (or, for Packaging, the farm) has this many or fewer. Then places (where it is kept)
// and, for honey, kgEach and container (the empty jar/bottle it is filled into).
// Same rows as docs/seed.js (a test keeps them equal).
var SHOPS = 'Kiunduani Shop, Nairobi Shop';
var ALL = 'Farm, Kiunduani Shop, Nairobi Shop';
var SEED_ITEMS = [
  ['ktbh-hive', 'Kenya Top Bar Hive (KTBH)', 'Hives', 'hive', 4000, 2, SHOPS],
  ['langstroth-hive', 'Langstroth Hive (10-frame)', 'Hives', 'hive', 5000, 2, SHOPS],
  ['modern-log-hive', 'Modern Log Hive', 'Hives', 'hive', 3000, 2, SHOPS],
  ['log-hive', 'Traditional Log Hive', 'Hives', 'hive', 2500, 2, SHOPS],
  ['swarm-catcher', 'Swarm Catcher Box', 'Hives', 'box', 2200, 2, SHOPS],
  ['bee-suit', 'Full Bee Suit', 'Protection', 'suit', 4000, 3, SHOPS],
  ['bee-gloves', 'Beekeeping Gloves (Long Cuff)', 'Protection', 'pair', 950, 3, SHOPS],
  ['bee-smoker', 'Bee Smoker', 'Tools', 'piece', 3500, 2, SHOPS],
  ['hive-tool', 'Hive Tool (J-Type)', 'Tools', 'piece', 700, 3, SHOPS],
  ['frame-grip', 'Frame Grip / Lifter', 'Tools', 'piece', 700, 2, SHOPS],
  ['bee-brush', 'Bee Brush', 'Tools', 'piece', 700, 3, SHOPS],
  ['bee-attractant', 'Bee Attractant (10ml)', 'Tools', 'bottle', 500, 5, SHOPS],
  ['queen-excluder', 'Queen Excluder', 'Tools', 'piece', 800, 2, SHOPS],
  ['propolis-mat', 'Propolis Collector Mat', 'Tools', 'piece', 800, 2, SHOPS],
  ['foundation-sheet', 'Foundation Sheets', 'Tools', 'sheet', 180, 20, SHOPS],
  ['frame-feeder', 'Bee Feeder', 'Tools', 'piece', 800, 3, SHOPS],
  ['honey-extractor', 'Manual Honey Extractor (3/6 frame)', 'Processing', 'piece', 45000, 1, SHOPS],
  ['refractometer', 'Honey Refractometer (ATC)', 'Processing', 'piece', 10000, 1, SHOPS],
  ['honey-strainer', 'Double Stainless Sieve', 'Processing', 'set', 4000, 1, SHOPS],
  ['cone-strainer', 'Cone Honey Strainer', 'Processing', 'piece', 900, 2, SHOPS],
  ['uncapping-fork', 'Uncapping Fork', 'Processing', 'piece', 700, 2, SHOPS],
  ['honey-bucket', 'Food-Grade Honey Bucket (20L)', 'Processing', 'bucket', 1200, 2, SHOPS],
  ['honey-150g', 'Raw Organic Honey — 150g Jar', 'Honey', 'jar', 150, 20, ALL, 0.15, 'empty-jar-150g'],
  ['honey-300g', 'Raw Organic Honey — 300g Squeeze Bottle', 'Honey', 'bottle', 300, 10, ALL, 0.3, 'empty-bottle-300g'],
  ['honey-500g', 'Raw Organic Honey — 500g Squeeze Bottle', 'Honey', 'bottle', 500, 10, ALL, 0.5, 'empty-bottle-500g'],
  ['honey-1kg', 'Raw Organic Honey — 1kg Jar', 'Honey', 'jar', 1000, 10, ALL, 1, 'empty-jar-1kg'],
  ['honey-bulk', 'Raw honey — bulk (per kg)', 'Honey', 'kg', 0, 0, 'Farm', 1],
  ['empty-jar-150g', 'Empty 150g jar', 'Packaging', 'jar', 0, 50, 'Farm'],
  ['empty-bottle-300g', 'Empty 300g squeeze bottle', 'Packaging', 'bottle', 0, 30, 'Farm'],
  ['empty-bottle-500g', 'Empty 500g squeeze bottle', 'Packaging', 'bottle', 0, 30, 'Farm'],
  ['empty-jar-1kg', 'Empty 1kg jar', 'Packaging', 'jar', 0, 30, 'Farm'],
  ['matoke', 'Matoke', 'Farm produce', 'bunch', 0, 0, 'Farm'],
  ['ripe-bananas', 'Ripe bananas', 'Farm produce', 'bunch', 0, 0, 'Farm'],
  ['rabbit', 'Rabbit', 'Livestock', 'head', 0, 0, 'Farm'],
  ['dorper-sheep', 'Dorper sheep', 'Livestock', 'head', 0, 0, 'Farm'],
  ['tilapia-fingerling', 'Tilapia fingerlings', 'Fish', 'piece', 0, 0, 'Farm'],
  ['catfish-fingerling', 'Catfish fingerlings', 'Fish', 'piece', 0, 0, 'Farm'],
  ['tilapia', 'Tilapia (table size)', 'Fish', 'kg', 0, 0, 'Farm'],
  ['catfish', 'Catfish (table size)', 'Fish', 'kg', 0, 0, 'Farm'],
];
// No longer sold (not on the website): kept in old sheets for history, switched off.
var RETIRED = ['bee-veil'];
var SEED_LOCATIONS = [
  ['farm', 'Farm', 'farm'],
  ['kiunduani', 'Kiunduani Shop', 'shop'],
  ['nairobi', 'Nairobi Shop', 'shop'],
];
var TYPES = ['restock', 'transfer', 'receive', 'sale', 'loss', 'pack', 'count'];
var LOSS_REASONS = ['spoilt', 'died', 'broken', 'stolen', 'other'];

/**
 * Run once from the editor. Safe to run again: it adds missing tabs, columns and starting items (by itemId),
 * fills an empty "places" for the starting items, and never changes anything else.
 * (To stop selling an item, set active = no rather than deleting the row, or setup will add it back.)
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    headers_(sh, TABS[name]);
  });
  var items = ss.getSheetByName('items');
  var ihead = headers_(items, TABS.items);
  var have = {};
  if (items.getLastRow() > 1) {
    var col = function (h) { return ihead.indexOf(h) + 1; };
    var vals = items.getRange(2, 1, items.getLastRow() - 1, ihead.length).getValues();
    vals.forEach(function (r, i) {
      var id = String(r[col('itemId') - 1]);
      have[id] = true;
      var seed = SEED_ITEMS.filter(function (x) { return x[0] === id; })[0];
      if (seed && String(r[col('places') - 1]).trim() === '') items.getRange(i + 2, col('places')).setValue(seed[6]);
      if (seed && seed[7] && String(r[col('kgEach') - 1]).trim() === '') items.getRange(i + 2, col('kgEach')).setValue(seed[7]);
      if (seed && seed[8] && String(r[col('container') - 1]).trim() === '') items.getRange(i + 2, col('container')).setValue(seed[8]);
    });
  }
  var add = SEED_ITEMS.filter(function (x) { return !have[x[0]]; }).map(function (x) {
    var v = { itemId: x[0], name: x[1], category: x[2], unit: x[3], price: x[4], reorderLevel: x[5], active: 'yes', places: x[6], kgEach: x[7] || '', container: x[8] || '' };
    return ihead.map(function (h) { return v.hasOwnProperty(h) ? v[h] : ''; });
  });
  if (add.length) items.getRange(items.getLastRow() + 1, 1, add.length, ihead.length).setValues(add);
  var locs = ss.getSheetByName('locations');
  if (locs.getLastRow() === 1) locs.getRange(2, 1, SEED_LOCATIONS.length, 3).setValues(SEED_LOCATIONS);
  var workers = ss.getSheetByName('workers');
  if (workers.getLastRow() === 1) {
    workers.appendRow(['Manager', String(1000 + Math.floor(Math.random() * 9000)), 'yes']);
  }
  // Keep PINs as text so a leading zero survives.
  workers.getRange('B:B').setNumberFormat('@');
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
}

/**
 * Run from the editor to make the items tab match the price list above (the website's current items).
 * For each listed item: updates name, category, unit, price and places; adds it if missing. A reorderLevel you
 * already set is kept. Retired items (no longer sold) are set to active = no; their rows stay for history.
 * Items you added yourself are not touched. Returns what changed.
 */
function applyWebsitePrices() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('items');
  var head = headers_(sh, TABS.items);
  var col = function (h) { return head.indexOf(h); };
  var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues() : [];
  var changed = [];
  var have = {};
  rows.forEach(function (r, i) {
    var id = String(r[col('itemId')]);
    have[id] = true;
    var seed = SEED_ITEMS.filter(function (x) { return x[0] === id; })[0];
    var before = r.join('|');
    if (seed) {
      r[col('name')] = seed[1];
      r[col('category')] = seed[2];
      r[col('unit')] = seed[3];
      r[col('price')] = seed[4];
      r[col('places')] = seed[6];
      r[col('kgEach')] = seed[7] || '';
      r[col('container')] = seed[8] || '';
      if (String(r[col('reorderLevel')]).trim() === '') r[col('reorderLevel')] = seed[5];
    } else if (RETIRED.indexOf(id) >= 0) {
      r[col('active')] = 'no';
    } else return;
    if (r.join('|') !== before) {
      sh.getRange(i + 2, 1, 1, head.length).setValues([r]);
      changed.push(id);
    }
  });
  var add = SEED_ITEMS.filter(function (x) { return !have[x[0]]; }).map(function (x) {
    var v = { itemId: x[0], name: x[1], category: x[2], unit: x[3], price: x[4], reorderLevel: x[5], active: 'yes', places: x[6], kgEach: x[7] || '', container: x[8] || '' };
    changed.push(x[0] + ' (new)');
    return head.map(function (h) { return v.hasOwnProperty(h) ? v[h] : ''; });
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, head.length).setValues(add);
  Logger.log('Updated: ' + (changed.join(', ') || 'nothing, already up to date'));
  return changed;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** Makes sure row 1 holds every column in `cols` (adding missing ones at the end). Returns the header row. */
function headers_(sh, cols) {
  if (sh.getLastRow() === 0) {
    sh.appendRow(cols);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, cols.length).setFontWeight('bold');
    return cols.slice();
  }
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var missing = cols.filter(function (c) { return head.indexOf(c) < 0; });
  if (missing.length) {
    sh.getRange(1, head.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    head = head.concat(missing);
  }
  return head;
}

function rows_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var head = values.shift();
  return values.map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

function yes_(v) {
  return v === true || /^(yes|y|true|1)$/i.test(String(v).trim());
}

function date_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Africa/Nairobi', 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

/** Returns the worker's name (as written in the sheet) and places, or { error }. */
function signIn_(name, pin) {
  var key = 'fails:' + String(name || '').trim().toLowerCase();
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get(key) || 0);
  if (fails >= MAX_FAILS) return { error: 'locked' };
  var w = rows_('workers').filter(function (r) {
    return yes_(r.active) && String(r.name).trim().toLowerCase() === String(name || '').trim().toLowerCase();
  })[0];
  if (!w || String(w.pin).trim() !== String(pin || '').trim()) {
    cache.put(key, String(fails + 1), LOCK_MINUTES * 60);
    return { error: 'wrong_pin' };
  }
  cache.remove(key);
  return { name: String(w.name).trim(), places: placeIds_(w.place), manager: /^manager$/i.test(String(w.role || '').trim()) };
}

function data_() {
  return {
    items: rows_('items').filter(function (r) { return r.itemId; }).map(function (r) {
      return { id: String(r.itemId), name: String(r.name), category: String(r.category), unit: String(r.unit),
               price: Number(r.price) || 0, reorderLevel: Number(r.reorderLevel) || 0, active: yes_(r.active),
               places: placeIds_(r.places), kgEach: Number(r.kgEach) || 0,
               container: String(r.container || '').split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean) };
    }),
    locations: rows_('locations').filter(function (r) { return r.locationId; }).map(function (r) {
      return { id: String(r.locationId), name: String(r.name), role: String(r.role) };
    }),
    movements: rows_('movements').filter(function (r) { return r.movementId; }).map(function (r) {
      return { id: String(r.movementId), date: date_(r.date), type: String(r.type), itemId: String(r.itemId),
               qty: Number(r.qty) || 0, from: String(r.from || ''), to: String(r.to || ''), price: Number(r.price) || 0,
               worker: String(r.worker), note: String(r.note || ''),
               at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
               source: String(r.source || ''), supplier: String(r.supplier || ''), cost: Number(r.cost) || 0, reason: String(r.reason || ''),
               batch: String(r.batch || ''), sent: Number(r.sent) || 0 };
    }),
  };
}

function doGet() {
  return json_({ ok: true, service: 'beelove-inventory' });
}

/**
 * Everything is a POST so the PIN never sits in a URL.
 *   {action: 'data', name, pin}                → items, locations and all movements
 *   {action: 'save', name, pin, movements: []} → appends new movements; safe to repeat (known movementIds are skipped)
 */
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  var who = signIn_(body.name, body.pin);
  if (who.error) return json_({ ok: false, error: who.error });
  if (body.action === 'data') {
    var out = data_();
    if (!who.manager) {
      // Workers get what their screens need: their places' entries (stock on hand, deliveries, reminders) and their own.
      out.movements = out.movements.filter(function (m) {
        return m.worker === who.name || who.places.indexOf(m.from) >= 0 || who.places.indexOf(m.to) >= 0;
      });
    }
    out.ok = true;
    out.worker = who.name;
    out.places = who.places;
    out.role = who.manager ? 'manager' : '';
    return json_(out);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('movements');
    var head = headers_(sh, TABS.movements);
    var seen = {};
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { seen[String(r[0])] = true; });
    }
    var items = {};
    rows_('items').forEach(function (r) { items[String(r.itemId)] = r; });
    var locs = {};
    rows_('locations').forEach(function (r) { locs[String(r.locationId)] = r; });

    var now = new Date();
    var saved = [], rejected = [], reasons = {}, rows = [];
    (body.movements || []).forEach(function (m) {
      var id = String(m.id || '');
      if (!id) return;
      if (seen[id]) { saved.push(id); return; }
      var it = items[String(m.itemId)];
      var qty = Number(m.qty);
      var ok = it && TYPES.indexOf(m.type) >= 0 && isFinite(qty) && qty >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(m.date) &&
        (!m.from || locs[m.from]) && (!m.to || locs[m.to]);
      // Packing lines take from one place or add to it, never both; a confirmation says what was sent and which delivery.
      if (ok && m.type === 'pack') ok = !!m.from !== !!m.to && !!m.batch;
      if (ok && m.type === 'receive') ok = !!m.from && !!m.to && !!m.batch && isFinite(Number(m.sent)) && Number(m.sent) >= 0;
      if (!ok) { rejected.push(id); reasons[id] = 'invalid'; return; }
      var price = m.type === 'sale' ? Number(m.price) || 0 : '';
      var bought = m.type === 'restock' && m.source === 'bought';
      var v = {
        movementId: id, date: m.date, type: m.type, itemId: m.itemId, itemName: it.name, qty: qty, unit: it.unit,
        from: m.from || '', to: m.to || '', price: price, amount: m.type === 'sale' ? qty * price : '', worker: who.name,
        note: String(m.note || '').slice(0, 500), at: m.at || '', receivedAt: now,
        source: m.type === 'restock' ? (bought ? 'bought' : 'own') : '',
        supplier: bought ? String(m.supplier || '').slice(0, 100) : '',
        cost: bought ? Math.max(0, Number(m.cost) || 0) : '',
        reason: m.type === 'loss' ? (LOSS_REASONS.indexOf(m.reason) >= 0 ? m.reason : 'other') : '',
        batch: String(m.batch || '').slice(0, 80),
        sent: m.type === 'receive' ? Number(m.sent) : '',
      };
      rows.push(head.map(function (h) { return v.hasOwnProperty(h) ? v[h] : ''; }));
      seen[id] = true;
      saved.push(id);
    });
    if (rows.length) {
      var start = sh.getLastRow() + 1;
      sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
      sh.getRange(start, head.indexOf('date') + 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');
    }
    return json_({ ok: true, saved: saved, rejected: rejected, reasons: reasons, worker: who.name });
  } finally {
    lock.releaseLock();
  }
}

// ---------- reminders ----------

/** Run once from the editor: (re)creates the reminder and report triggers. Safe to run again. */
function setupReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['reminders', 'weeklyReport', 'monthlyReport'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  [MORNING_HOUR, EVENING_HOUR].forEach(function (h) {
    ScriptApp.newTrigger('reminders').timeBased().everyDays(1).atHour(h).nearMinute(0).inTimezone(TZ).create();
  });
  ScriptApp.newTrigger('weeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(REPORT_HOUR).inTimezone(TZ).create();
  ScriptApp.newTrigger('monthlyReport').timeBased().onMonthDay(REPORT_MONTH_DAY).atHour(REPORT_HOUR).inTimezone(TZ).create();
}

/** Trigger handler. */
function reminders() {
  return reminders_(new Date());
}

/** A worker's places as locationIds. Accepts ids or names, any case, separated by commas or semicolons; unknown ones are skipped. */
function placeIds_(v) {
  var locs = rows_('locations');
  var out = [];
  String(v || '').split(/[,;]/).forEach(function (part) {
    var want = part.trim().toLowerCase();
    if (!want) return;
    var hit = locs.filter(function (r) {
      return String(r.locationId).toLowerCase() === want || String(r.name).trim().toLowerCase() === want;
    })[0];
    if (hit && out.indexOf(String(hit.locationId)) < 0) out.push(String(hit.locationId));
  });
  return out;
}

function isLastDayOfMonth_(ymd) {
  var p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1)).getUTCDate() === 1;
}

/** Works out what is outstanding at `now` and emails the workers concerned. Returns what it sent (for tests/logs). */
function reminders_(now) {
  var today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  var hour = Number(Utilities.formatDate(now, TZ, 'H'));
  var evening = hour >= EVENING_HOUR - 1;
  var lastDay = isLastDayOfMonth_(today);
  var month = today.slice(0, 7);
  var monthName = Utilities.formatDate(now, TZ, 'MMMM');
  var dayName = Utilities.formatDate(now, TZ, 'd MMM');

  var moves = rows_('movements').filter(function (r) { return r.movementId; });
  if (!moves.length) return [];  // not in use yet
  var locs = rows_('locations').filter(function (r) { return r.locationId; });
  var workers = rows_('workers').filter(function (w) { return yes_(w.active); }).map(function (w) {
    return { name: String(w.name).trim(), email: String(w.email || '').trim(), places: placeIds_(w.place) };
  });

  var issues = [];
  locs.forEach(function (l) {
    var id = String(l.locationId);
    if (evening && String(l.role) === 'shop') {
      var sold = moves.some(function (m) { return m.type === 'sale' && String(m.from) === id && date_(m.date) === today; });
      if (!sold) issues.push({ place: l, kind: 'sales' });
    }
    if (lastDay) {
      // Done if counted in the last 3 days of the month (same window as countWindow in docs/stock.js).
      var start = month + '-' + String(Number(today.slice(8, 10)) - 2).padStart(2, '0');
      var counted = moves.some(function (m) { return m.type === 'count' && String(m.to) === id && date_(m.date) >= start; });
      if (!counted) issues.push({ place: l, kind: 'count' });
    }
  });
  if (!issues.length) return [];

  var sent = [];
  issues.forEach(function (x) {
    var people = workers.filter(function (w) { return w.places.indexOf(String(x.place.locationId)) >= 0 && w.email; });
    var subject, body;
    people.forEach(function (w) {
      var first = w.name.split(' ')[0];
      if (x.kind === 'sales') {
        subject = 'Beelove: record today\'s sales at ' + x.place.name;
        body = 'Hello ' + first + ',\n\nNo sales have been recorded for ' + x.place.name + ' today (' + dayName + ').\n' +
          'If anything was sold, please record it in the app before you close:\n' + APP_URL + '\n\n' +
          'If the shop sold nothing today, you can ignore this message.\n\nBeelove Farm';
      } else {
        subject = 'Beelove: ' + monthName + ' stock count at ' + x.place.name;
        body = 'Hello ' + first + ',\n\nToday is the last day of ' + monthName + ' and the stock count for ' + x.place.name +
          ' has not been done yet.\nPlease count everything that is there and enter it in the app (Monthly count):\n' + APP_URL +
          '\n\nBeelove Farm';
      }
      MailApp.sendEmail(w.email, subject, body);
      sent.push({ to: w.email, kind: x.kind, place: String(x.place.locationId) });
    });
  });
  return sent;
}

// ---------- reports (owner only) ----------

/** Trigger handler: Monday morning, covers last Monday–Sunday. */
function weeklyReport() {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return sendReport_('week', weekBefore_(today), today);
}

/** Trigger handler: on REPORT_MONTH_DAY, covers the whole previous month. */
function monthlyReport() {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return sendReport_('month', monthBefore_(today), today);
}

function addDays_(ymd, n) {
  var p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}

/** The Monday–Sunday week that ended before `today`. */
function weekBefore_(today) {
  var dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;  // 0 = Monday
  var end = addDays_(today, -dow - 1);
  return { start: addDays_(end, -6), end: end };
}

/** The calendar month before `today`'s month. */
function monthBefore_(today) {
  var p = today.split('-').map(Number);
  var first = new Date(Date.UTC(p[0], p[1] - 2, 1)).toISOString().slice(0, 10);
  var last = new Date(Date.UTC(p[0], p[1] - 1, 0)).toISOString().slice(0, 10);
  return { start: first, end: last };
}

function movements_() {
  return rows_('movements').filter(function (r) { return r.movementId; }).map(function (r) {
    return { id: String(r.movementId), date: date_(r.date), type: String(r.type), itemId: String(r.itemId), qty: Number(r.qty) || 0,
             from: String(r.from || ''), to: String(r.to || ''), price: Number(r.price) || 0, worker: String(r.worker),
             at: r.at instanceof Date ? r.at.toISOString() : String(r.at || ''),
             source: String(r.source || ''), supplier: String(r.supplier || ''), cost: Number(r.cost) || 0, reason: String(r.reason || ''),
             batch: String(r.batch || ''), sent: Number(r.sent) || 0 };
  });
}

/** Same maths as replay() in docs/stock.js (a test keeps them equal): balances, and the difference each count made. */
function replay_(moves) {
  var bal = {}, adjustments = [];
  function get(i, l) { return (bal[i] && bal[i][l]) || 0; }
  function add(i, l, q) { if (!l) return; if (!bal[i]) bal[i] = {}; bal[i][l] = get(i, l) + q; }
  moves.slice().sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
  }).forEach(function (m) {
    if (m.type === 'restock') add(m.itemId, m.to, m.qty);
    else if (m.type === 'transfer') { add(m.itemId, m.from, -m.qty); add(m.itemId, m.to, m.qty); }
    else if (m.type === 'sale' || m.type === 'loss') add(m.itemId, m.from, -m.qty);
    else if (m.type === 'pack') { if (m.from) add(m.itemId, m.from, -m.qty); else add(m.itemId, m.to, m.qty); }
    else if (m.type === 'receive') add(m.itemId, m.to, m.qty - m.sent);
    else if (m.type === 'count') {
      var before = get(m.itemId, m.to);
      add(m.itemId, m.to, m.qty - before);
      adjustments.push({ movement: m, before: before, after: m.qty, delta: m.qty - before });
    }
  });
  return { balance: bal, adjustments: adjustments };
}

/** Same as flow() in docs/stock.js (a test keeps them equal): start + in − out − sold − lost + countDiff = end. */
function flow_(moves, itemIds, placeIds, start, end) {
  var opening = replay_(moves.filter(function (m) { return m.date < start; })).balance;
  var upto = replay_(moves.filter(function (m) { return m.date <= end; }));
  var rows = {};
  function row(item, place) {
    var k = item + '|' + place;
    if (!rows[k]) rows[k] = { itemId: item, place: place, start: (opening[item] && opening[item][place]) || 0, in: 0, out: 0, sold: 0, lost: 0, countDiff: 0, end: 0, packIn: 0, packOut: 0 };
    return rows[k];
  }
  var want = function (item, place) { return place && itemIds.indexOf(item) >= 0 && placeIds.indexOf(place) >= 0; };
  moves.forEach(function (m) {
    if (m.date < start || m.date > end) return;
    var q = m.qty, i = m.itemId;
    if (m.type === 'restock' && want(i, m.to)) row(i, m.to).in += q;
    else if (m.type === 'transfer') { if (want(i, m.from)) row(i, m.from).out += q; if (want(i, m.to)) row(i, m.to).in += q; }
    else if (m.type === 'receive' && want(i, m.to)) row(i, m.to).lost += m.sent - q;
    else if (m.type === 'sale' && want(i, m.from)) row(i, m.from).sold += q;
    else if (m.type === 'loss' && want(i, m.from)) row(i, m.from).lost += q;
    else if (m.type === 'pack') {
      if (m.from && want(i, m.from)) { row(i, m.from).out += q; row(i, m.from).packOut += q; }
      if (!m.from && want(i, m.to)) { row(i, m.to).in += q; row(i, m.to).packIn += q; }
    }
  });
  upto.adjustments.forEach(function (a) {
    if (a.movement.date >= start && want(a.movement.itemId, a.movement.to)) row(a.movement.itemId, a.movement.to).countDiff += a.delta;
  });
  itemIds.forEach(function (i) {
    placeIds.forEach(function (p) { if ((opening[i] && opening[i][p]) || (upto.balance[i] && upto.balance[i][p])) row(i, p); });
  });
  return Object.keys(rows).map(function (k) {
    var r = rows[k];
    r.end = r.start + r.in - r.out - r.sold - r.lost + r.countDiff;
    return r;
  });
}

/** Same as flowKg() in docs/stock.js: kg totals with packing treated as a conversion (its leftover counts as lost). */
function flowKg_(rows, kgEach) {
  var t = { start: 0, in: 0, out: 0, sold: 0, lost: 0, countDiff: 0, end: 0 };
  rows.forEach(function (r) {
    var k = kgEach(r.itemId) || 0;
    t.start += r.start * k; t.in += (r.in - r.packIn) * k; t.out += (r.out - r.packOut) * k; t.sold += r.sold * k;
    t.lost += (r.lost + r.packOut) * k - r.packIn * k; t.countDiff += r.countDiff * k; t.end += r.end * k;
  });
  Object.keys(t).forEach(function (f) { t[f] = Math.round(t[f] * 100) / 100; });
  return t;
}

/** Everything the report says about [period.start, period.end]. `asOf` = the day the report is made. */
function report_(kind, period, asOf) {
  var moves = movements_();
  var items = {};
  rows_('items').forEach(function (r) { items[String(r.itemId)] = r; });
  var locs = rows_('locations').filter(function (r) { return r.locationId; });
  var shops = locs.filter(function (l) { return String(l.role) === 'shop'; });
  var places = function (it) { return placeIds_(it.places); };
  var kept = function (it, id) { var p = places(it); return !p.length || p.indexOf(id) >= 0; };
  var days = Math.round((Date.parse(period.end) - Date.parse(period.start)) / 864e5) + 1;
  var prev = { start: addDays_(period.start, -days), end: addDays_(period.start, -1) };
  if (kind === 'month') prev = monthBefore_(period.start);
  var inP = function (m, p) { return m.date >= p.start && m.date <= p.end; };
  var amount = function (m) { return m.qty * m.price; };

  var sales = moves.filter(function (m) { return m.type === 'sale' && inP(m, period); });
  var prevSales = moves.filter(function (m) { return m.type === 'sale' && inP(m, prev); });
  var total = sales.reduce(function (t, m) { return t + amount(m); }, 0);

  // Sales points: every shop, plus the farm (market sales) when it sold something.
  var points = locs.filter(function (l) {
    return String(l.role) === 'shop' || sales.some(function (m) { return m.from === String(l.locationId); });
  });
  var byShop = points.map(function (l) {
    var ss = sales.filter(function (m) { return m.from === String(l.locationId); });
    var dayset = {};
    ss.forEach(function (m) { dayset[m.date] = true; });
    return { name: String(l.role) === 'shop' ? String(l.name) : String(l.name) + ' (market)', amount: ss.reduce(function (t, m) { return t + amount(m); }, 0),
             units: ss.reduce(function (t, m) { return t + m.qty; }, 0), daysWithSales: Object.keys(dayset).length };
  });

  var topMap = {};
  sales.forEach(function (m) {
    var t = topMap[m.itemId] || (topMap[m.itemId] = { itemId: m.itemId, units: 0, amount: 0 });
    t.units += m.qty;
    t.amount += amount(m);
  });
  var top = Object.keys(topMap).map(function (k) { return topMap[k]; }).sort(function (a, b) { return b.amount - a.amount; }).slice(0, 5)
    .map(function (t) { var it = items[t.itemId] || {}; return { name: String(it.name || t.itemId), unit: String(it.unit || ''), units: t.units, amount: t.amount }; });

  var inPeriod = moves.filter(function (m) { return inP(m, period); });
  var restocked = inPeriod.filter(function (m) { return m.type === 'restock'; }).reduce(function (t, m) { return t + m.qty; }, 0);
  // Per item: how much was our own (harvest, workshop, born) and how much was bought, and what buying cost.
  var inMap = {};
  inPeriod.filter(function (m) { return m.type === 'restock'; }).forEach(function (m) {
    var x = inMap[m.itemId] || (inMap[m.itemId] = { itemId: m.itemId, own: 0, bought: 0, spent: 0, suppliers: {} });
    if (m.source === 'bought') {
      x.bought += m.qty;
      x.spent += m.qty * m.cost;
      if (m.supplier) x.suppliers[m.supplier] = true;
    } else x.own += m.qty;
  });
  var incoming = Object.keys(inMap).map(function (k) {
    var x = inMap[k], it = items[k] || {};
    return { name: String(it.name || k), unit: String(it.unit || ''), category: String(it.category || ''), own: x.own, bought: x.bought,
             spent: x.spent, suppliers: Object.keys(x.suppliers).join(', ') };
  }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  var lossMap = {};
  inPeriod.filter(function (m) { return m.type === 'loss'; }).forEach(function (m) {
    var k = m.itemId + '|' + (m.reason || 'other');
    var x = lossMap[k] || (lossMap[k] = { itemId: m.itemId, reason: m.reason || 'other', qty: 0 });
    x.qty += m.qty;
  });
  var losses = Object.keys(lossMap).map(function (k) {
    var x = lossMap[k], it = items[x.itemId] || {};
    return { name: String(it.name || x.itemId), unit: String(it.unit || ''), reason: x.reason, qty: x.qty, value: x.qty * (Number(it.price) || 0) };
  });
  var sent = shops.map(function (l) {
    return { name: String(l.name), units: inPeriod.filter(function (m) { return m.type === 'transfer' && m.to === String(l.locationId); })
      .reduce(function (t, m) { return t + m.qty; }, 0) };
  });
  var byWorker = {};
  inPeriod.forEach(function (m) { byWorker[m.worker] = (byWorker[m.worker] || 0) + 1; });
  var workers = Object.keys(byWorker).sort().map(function (w) { return { name: w, entries: byWorker[w] }; });

  var r = replay_(moves.filter(function (m) { return m.date <= asOf; }));
  var low = [];
  Object.keys(items).forEach(function (id) {
    var it = items[id];
    var level = Number(it.reorderLevel) || 0;
    if (!level || !yes_(it.active)) return;
    var watch = String(it.category) === 'Packaging' ? locs : shops;  // empty jars run out at the farm, not in a shop
    watch.filter(function (l) { return kept(it, String(l.locationId)); }).forEach(function (l) {
      var q = (r.balance[id] && r.balance[id][String(l.locationId)]) || 0;
      if (q <= level) low.push({ name: String(it.name), place: String(l.name), qty: q });
    });
  });

  // Honey: flow per product and place (kg totals per place), packing, and deliveries.
  var honey = Object.keys(items).filter(function (id) { return String(items[id].category) === 'Honey'; });
  var kgOf = function (id) { return Number(items[id] && items[id].kgEach) || 0; };
  var placeName = function (id) { var l = locs.filter(function (x) { return String(x.locationId) === id; })[0]; return l ? String(l.name) : id; };
  var honeyFlow = flow_(moves, honey, locs.map(function (l) { return String(l.locationId); }), period.start, period.end)
    .filter(function (r) { return r.start || r.in || r.out || r.sold || r.lost || r.countDiff || r.end; })
    .map(function (r) { r.name = String(items[r.itemId].name); r.unit = String(items[r.itemId].unit); r.placeName = placeName(r.place); r.kg = kgOf(r.itemId); return r; })
    .sort(function (a, b) { return a.placeName === b.placeName ? (a.name < b.name ? -1 : 1) : (a.placeName < b.placeName ? -1 : 1); });
  var packaging = Object.keys(items).filter(function (id) { return String(items[id].category) === 'Packaging'; });
  var containerFlow = flow_(moves, packaging, locs.map(function (l) { return String(l.locationId); }), period.start, period.end)
    .filter(function (r) { return r.start || r.in || r.out || r.lost || r.countDiff || r.end; })
    .map(function (r) { r.name = String(items[r.itemId].name); r.unit = String(items[r.itemId].unit); r.placeName = placeName(r.place); return r; })
    .sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  var packs = inPeriod.filter(function (m) { return m.type === 'pack'; });
  var packing = {
    times: Object.keys(packs.reduce(function (o, m) { o[m.batch] = true; return o; }, {})).length,
    kgTaken: packs.filter(function (m) { return m.from; }).reduce(function (t, m) { return t + m.qty * (kgOf(m.itemId) || 1); }, 0),
    kgPacked: packs.filter(function (m) { return !m.from; }).reduce(function (t, m) { return t + m.qty * kgOf(m.itemId); }, 0),
  };
  var short = inPeriod.filter(function (m) { return m.type === 'receive' && m.qty !== m.sent; }).map(function (m) {
    var sentBy = moves.filter(function (t) { return t.type === 'transfer' && t.batch === m.batch && t.itemId === m.itemId; })[0];
    return { date: m.date, name: String((items[m.itemId] || {}).name || m.itemId), from: placeName(m.from), to: placeName(m.to),
             sent: m.sent, arrived: m.qty, sender: sentBy ? sentBy.worker : '', receiver: m.worker };
  });
  var confirmed = {};
  moves.forEach(function (m) { if (m.type === 'receive') confirmed[m.batch + '|' + m.to] = true; });
  var unconfirmed = {};
  moves.forEach(function (m) {
    if (m.type !== 'transfer' || !m.batch || m.date > addDays_(asOf, -2) || m.date < addDays_(asOf, -40) || confirmed[m.batch + '|' + m.to]) return;
    unconfirmed[m.batch + '|' + m.to] = { date: m.date, from: placeName(m.from), to: placeName(m.to), sender: m.worker };
  });

  var out = { kind: kind, period: period, total: total, units: sales.reduce(function (t, m) { return t + m.qty; }, 0),
              prevTotal: prevSales.reduce(function (t, m) { return t + amount(m); }, 0), byShop: byShop, days: days,
              top: top, restocked: restocked, incoming: incoming, losses: losses, sent: sent, workers: workers, low: low,
              honeyFlow: honeyFlow, containerFlow: containerFlow, packing: packing, short: short,
              unconfirmed: Object.keys(unconfirmed).map(function (k) { return unconfirmed[k]; }) };

  if (kind === 'month') {
    // The month-end count window: last 3 days of the month to the 3rd of the next (same as countWindow in docs/stock.js).
    var winStart = addDays_(period.end, -2), winEnd = addDays_(period.end, 3);
    out.counts = locs.map(function (l) {
      var c = moves.filter(function (m) { return m.type === 'count' && m.to === String(l.locationId) && m.date >= winStart && m.date <= winEnd; });
      return { name: String(l.name), done: c.length > 0, date: c.length ? c[c.length - 1].date : '' };
    });
    out.differences = r.adjustments.filter(function (a) {
      return a.movement.date >= winStart && a.movement.date <= winEnd && a.delta !== 0;
    }).map(function (a) {
      var it = items[a.movement.itemId] || {};
      var place = locs.filter(function (l) { return String(l.locationId) === a.movement.to; })[0];
      return { name: String(it.name || a.movement.itemId), place: place ? String(place.name) : a.movement.to, before: a.before,
               after: a.after, delta: a.delta, value: a.delta * (Number(it.price) || 0), worker: a.movement.worker };
    });
    out.missingValue = out.differences.reduce(function (t, d) { return t + Math.min(0, d.value); }, 0);
  }
  return out;
}

/** "Raw Organic Honey — 150g Jar" → "150g Jar", for narrow tables. */
function shortName_(name) {
  return String(name).replace(/^Raw (Organic )?[Hh]oney — /, '').replace(/^bulk \(per kg\)$/, 'Bulk honey (kg)').replace(/ Squeeze Bottle$/, ' bottle');
}

function ksh_(n) {
  return 'KSh ' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function nice_(ymd) {
  var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var p = ymd.split('-').map(Number);
  return p[2] + ' ' + m[p[1] - 1];
}

function esc_(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

/** The report as an email: { subject, html, text }. */
function reportEmail_(r) {
  var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var label = r.kind === 'week' ? nice_(r.period.start) + ' – ' + nice_(r.period.end)
    : months[Number(r.period.start.slice(5, 7)) - 1] + ' ' + r.period.start.slice(0, 4);
  var change = r.prevTotal ? Math.round((r.total - r.prevTotal) / r.prevTotal * 100) : null;
  var lines = [];
  var html = [];
  var td = 'style="padding:6px 6px;border-bottom:1px solid #e2e3da"';
  var tdr = 'style="padding:6px 6px;border-bottom:1px solid #e2e3da;text-align:right;white-space:nowrap"';
  var tdw = 'style="padding:6px 6px;border-bottom:1px solid #e2e3da;text-align:right"';
  function h(t) { html.push('<h3 style="margin:22px 0 6px;font-size:16px">' + esc_(t) + '</h3>'); lines.push('', t.toUpperCase()); }
  function table(head, rows) {
    html.push('<table style="border-collapse:collapse;width:100%;font-size:13px"><tr>' + head.map(function (x, i) {
      return '<th ' + (i ? tdr : td) + '>' + esc_(x) + '</th>'; }).join('') + '</tr>' +
      rows.map(function (row) {
        if (row.heading) return '<tr><td colspan="' + head.length + '" style="padding:10px 10px 4px;font-weight:bold;border-bottom:1px solid #cfd1c6">' + esc_(row.heading) + '</td></tr>';
        // Short values (amounts, counts) stay on one line; longer text (names, routes) may wrap.
        return '<tr>' + row.map(function (x, i) { return '<td ' + (i ? (String(x).length <= 14 ? tdr : tdw) : td) + '>' + esc_(x) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</table>');
    rows.forEach(function (row) { lines.push(row.heading ? row.heading + ':' : '- ' + row.join(' | ')); });
  }

  html.push('<div style="font-family:Arial,sans-serif;color:#1c1f1a;max-width:620px">');
  html.push('<h2 style="margin:0 0 4px">Beelove ' + (r.kind === 'week' ? 'weekly' : 'monthly') + ' report</h2><div style="color:#565d52">' + esc_(label) + '</div>');
  html.push('<p style="font-size:28px;font-weight:bold;margin:16px 0 0">' + ksh_(r.total) + '</p><div style="color:#565d52">sales · ' + r.units + ' units' +
    (change === null ? '' : ' · ' + (change >= 0 ? '+' : '') + change + '% vs previous ' + r.kind) + '</div>');
  lines.push('Beelove ' + (r.kind === 'week' ? 'weekly' : 'monthly') + ' report: ' + label, 'Sales: ' + ksh_(r.total) + ' (' + r.units + ' units)' +
    (change === null ? '' : ', ' + (change >= 0 ? '+' : '') + change + '% vs previous ' + r.kind));

  h('Sales by place');
  table(['Where', 'Sales', 'Units', 'Days with sales'], r.byShop.map(function (b) { return [b.name, ksh_(b.amount), b.units, b.daysWithSales + ' of ' + r.days]; }));
  if (r.top.length) {
    h('Best sellers');
    table(['Item', 'Sold', 'Sales'], r.top.map(function (t) { return [t.name, t.units + ' ' + t.unit, ksh_(t.amount)]; }));
  }
  if (r.incoming.length) {
    h('New stock: our own and bought');
    // Honey, farm produce, animals and fish, and anything bought, one row each; the workshop's own items in one line.
    var farmCats = ['Honey', 'Farm produce', 'Livestock', 'Fish'];
    var listed = r.incoming.filter(function (x) { return x.bought || farmCats.indexOf(x.category) >= 0; });
    var rest = r.incoming.filter(function (x) { return listed.indexOf(x) < 0; });
    var rowsIn = listed.map(function (x) { return [shortName_(x.name), x.own + ' ' + x.unit, x.bought ? x.bought + ' ' + x.unit : '–', x.spent ? ksh_(x.spent) : '–', x.suppliers || '–']; });
    if (rest.length) rowsIn.push(['Workshop / other own stock (' + rest.length + ' items)', rest.reduce(function (t, x) { return t + x.own; }, 0) + ' units', '–', '–', '–']);
    table(['Item', 'Our own', 'Bought', 'Paid', 'Bought from'], rowsIn);
    var paid = r.incoming.reduce(function (t, x) { return t + x.spent; }, 0);
    if (paid) { html.push('<p style="margin:6px 0 0"><b>Paid for bought stock: ' + ksh_(paid) + '</b></p>'); lines.push('Paid for bought stock: ' + ksh_(paid)); }
  }
  if (r.packing.times) {
    h('Packing');
    var waste = r.packing.kgTaken - r.packing.kgPacked;
    table(['', 'kg'], [['Bulk honey taken (' + r.packing.times + ' packing' + (r.packing.times === 1 ? '' : 's') + ')', r.packing.kgTaken.toFixed(1)],
      ['Filled into jars and bottles', r.packing.kgPacked.toFixed(1)], ['Left on equipment / wasted', waste.toFixed(1)]]);
  }
  if (r.honeyFlow.length) {
    h('Honey flow');
    html.push('<p style="margin:0 0 6px;color:#565d52;font-size:13px">Start + In − Out − Sold − Lost ± Count difference = End. ' +
      'In = harvested, bought, packed or delivered; Out = sent away or used for packing; Lost includes delivery shortfalls. ' +
      'In the kg totals packing is only a change of container, so honey left on the equipment shows as Lost.</p>');
    var flowRows = [];
    var places = [];
    r.honeyFlow.forEach(function (x) { if (places.indexOf(x.placeName) < 0) places.push(x.placeName); });
    places.forEach(function (p) {
      var rs = r.honeyFlow.filter(function (x) { return x.placeName === p; });
      flowRows.push({ heading: p });
      rs.forEach(function (x) {
        flowRows.push([shortName_(x.name), x.start, x.in, x.out, x.sold, x.lost, (x.countDiff > 0 ? '+' : '') + x.countDiff, x.end]);
      });
      var kgs = {};
      rs.forEach(function (x) { kgs[x.itemId] = x.kg; });
      var t = flowKg_(rs, function (id) { return kgs[id]; });
      var f1 = function (n) { return n.toFixed(1); };
      flowRows.push(['Total kg', f1(t.start), f1(t.in), f1(t.out), f1(t.sold), f1(t.lost), f1(t.countDiff), f1(t.end)]);
    });
    table(['Item', 'Start', 'In', 'Out', 'Sold', 'Lost', '±', 'End'], flowRows);
  }
  if (r.containerFlow.length) {
    h('Empty jars and bottles');
    html.push('<p style="margin:0 0 6px;color:#565d52;font-size:13px">Start + Bought − Used for packing − Broken ± Count = End. ' +
      'A minus count difference means more containers were used than packing records show: jars filled and not recorded.</p>');
    table(['Container', 'Start', 'Bought', 'Used', 'Broken', '±', 'End'], r.containerFlow.map(function (x) {
      return [x.name.replace(/^Empty /, '') + (r.containerFlow.some(function (y) { return y.place !== x.place; }) ? ' · ' + x.placeName : ''),
              x.start, x.in, x.packOut, x.lost, (x.countDiff > 0 ? '+' : '') + x.countDiff, x.end];
    }));
  }
  if (r.short.length) {
    h('Deliveries that arrived short');
    table(['Item', 'Sent', 'Arrived', 'When, route and people'], r.short.map(function (x) {
      return [shortName_(x.name), x.sent, x.arrived, nice_(x.date) + ': ' + x.from + ' → ' + x.to + ', sent by ' + x.sender + ', received by ' + x.receiver]; }));
  }
  if (r.unconfirmed.length) {
    h('Deliveries not confirmed yet');
    table(['Sent', 'Route', 'Sent by'], r.unconfirmed.map(function (x) { return [nice_(x.date), x.from + ' → ' + x.to, x.sender]; }));
  }
  h('Sent to shops');
  table(['Shop', 'Units'], r.sent.map(function (x) { return [x.name, x.units]; }));
  if (r.losses.length) {
    h('Losses recorded');
    table(['Item', 'Reason', 'Lost', 'Value'], r.losses.map(function (x) { return [x.name, x.reason, x.qty + ' ' + x.unit, ksh_(x.value)]; }));
  }
  if (r.counts) {
    h('Month-end count');
    table(['Place', 'Status'], r.counts.map(function (c) { return [c.name, c.done ? 'Done ' + nice_(c.date) : 'NOT DONE']; }));
    if (r.differences.length) {
      h('Count differences (shelf vs records)');
      table(['Item · place', 'Records', 'Counted', '±', 'Value'], r.differences.map(function (d) {
        return [shortName_(d.name) + ' · ' + d.place, d.before, d.after, (d.delta > 0 ? '+' : '') + d.delta, ksh_(d.value)]; }));
      html.push('<p style="margin:6px 0 0"><b>Missing stock value: ' + ksh_(-r.missingValue) + '</b></p>');
      lines.push('Missing stock value: ' + ksh_(-r.missingValue));
    } else {
      html.push('<p style="margin:6px 0 0">No differences: counted stock matched the records.</p>');
    }
  }
  h('Low stock now');
  if (r.low.length) table(['Item', 'Shop', 'Left'], r.low.map(function (l) { return [l.name, l.place, l.qty]; }));
  else { html.push('<p style="margin:0">Nothing is at or below its reorder level.</p>'); lines.push('Nothing low.'); }
  h('Who recorded');
  if (r.workers.length) table(['Worker', 'Entries'], r.workers.map(function (w) { return [w.name, w.entries]; }));
  else { html.push('<p style="margin:0">Nobody recorded anything.</p>'); lines.push('Nobody recorded anything.'); }
  html.push('<p style="margin-top:24px"><a href="' + APP_URL + '">Open the dashboard</a></p></div>');
  lines.push('', 'Dashboard: ' + APP_URL);

  return { subject: 'Beelove ' + (r.kind === 'week' ? 'weekly' : 'monthly') + ' report: ' + label + ' · ' + ksh_(r.total), html: html.join(''), text: lines.join('\n') };
}

/** Builds the report and emails it to the script owner only. Returns { to, subject } (or null if nothing to report). */
function sendReport_(kind, period, asOf) {
  if (!rows_('movements').some(function (r) { return r.movementId; })) return null;  // not in use yet
  var to = Session.getEffectiveUser().getEmail();
  if (!to) return null;
  var mail = reportEmail_(report_(kind, period, asOf));
  MailApp.sendEmail({ to: to, subject: mail.subject, body: mail.text, htmlBody: mail.html });
  return { to: to, subject: mail.subject };
}

/** Run from the editor to see last week's report in your inbox now. */
function sendTestReport() {
  return weeklyReport();
}
