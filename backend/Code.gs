/**
 * Beelove farm-to-shop inventory backend (Google Apps Script, bound to the inventory Google Sheet).
 *
 * The sheet is the record. Workers' phones send stock movements here; the app's dashboard reads them back.
 *   items      – what we sell. Edit names, prices and reorder levels here; set active = no to hide an item.
 *   locations  – the farm and the shops (Kiunduani, Nairobi). Add a row with role = shop for a new branch.
 *   workers    – who may sign in: name + PIN. Set active = no when someone leaves.
 *   movements  – one row per captured movement. Never edit "movementId"; fix mistakes with a new count.
 *
 * Every request carries the worker's name and PIN. The worker recorded on a movement is the signed-in
 * worker, never a name the phone sends. After MAX_FAILS wrong PINs a name is locked for LOCK_MINUTES.
 *
 * First time: run setup() once from the Apps Script editor, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). Put the web app URL in docs/config.js.
 */
var MAX_FAILS = 5;
var LOCK_MINUTES = 15;

var TABS = {
  items:     ['itemId', 'name', 'category', 'unit', 'price', 'reorderLevel', 'active'],
  locations: ['locationId', 'name', 'role'],
  workers:   ['name', 'pin', 'active'],
  movements: ['movementId', 'date', 'type', 'itemId', 'itemName', 'qty', 'unit', 'from', 'to', 'price', 'amount',
              'worker', 'note', 'at', 'receivedAt'],
};

// From the Beelove website shop page. reorderLevel = warn when a shop has this many or fewer.
var SEED_ITEMS = [
  ['ktbh-hive', 'KTBH — Kenya Top Bar Hive', 'Hives', 'hive', 4500, 2],
  ['langstroth-hive', 'Langstroth Hive (10-frame)', 'Hives', 'hive', 7500, 2],
  ['log-hive', 'Traditional Log Hive', 'Hives', 'hive', 1800, 2],
  ['bee-suit', 'Full Bee Suit', 'Protection', 'suit', 3500, 3],
  ['bee-veil', 'Bee Veil (Round)', 'Protection', 'veil', 800, 5],
  ['bee-smoker', 'Bee Smoker', 'Tools', 'piece', 1200, 3],
  ['hive-tool', 'Hive Tool (J-Type)', 'Tools', 'piece', 350, 5],
  ['bee-brush', 'Bee Brush', 'Tools', 'piece', 300, 5],
  ['bee-attractant', 'Bee Attractant', 'Tools', 'bottle', 500, 5],
  ['foundation-sheet', 'Foundation Sheets', 'Tools', 'sheet', 150, 20],
  ['frame-feeder', 'Frame Feeder', 'Tools', 'piece', 400, 5],
  ['honey-extractor', 'Manual Honey Extractor', 'Processing', 'piece', 12000, 1],
  ['honey-strainer', 'Honey Strainer (Double)', 'Processing', 'piece', 900, 2],
  ['honey-150g', 'Raw Honey — 150g Jar', 'Honey', 'jar', 350, 20],
  ['honey-1kg', 'Raw Honey — 1kg Jar', 'Honey', 'jar', 1800, 10],
  ['honey-bulk', 'Bulk Honey (per kg)', 'Honey', 'kg', 1400, 20],
];
var SEED_LOCATIONS = [
  ['farm', 'Farm', 'farm'],
  ['kiunduani', 'Kiunduani Shop', 'shop'],
  ['nairobi', 'Nairobi Shop', 'shop'],
];
var TYPES = ['restock', 'transfer', 'sale', 'count'];

/** Run once from the editor. Safe to run again: it only adds missing tabs and never overwrites rows. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(TABS[name]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, TABS[name].length).setFontWeight('bold');
    }
  });
  var items = ss.getSheetByName('items');
  if (items.getLastRow() === 1) {
    var rows = SEED_ITEMS.map(function (r) { return r.concat(['yes']); });
    items.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
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

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
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

/** Returns the worker's name as written in the sheet, or an error string. */
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
  return { name: String(w.name).trim() };
}

function data_() {
  return {
    items: rows_('items').filter(function (r) { return r.itemId; }).map(function (r) {
      return { id: String(r.itemId), name: String(r.name), category: String(r.category), unit: String(r.unit),
               price: Number(r.price) || 0, reorderLevel: Number(r.reorderLevel) || 0, active: yes_(r.active) };
    }),
    locations: rows_('locations').filter(function (r) { return r.locationId; }).map(function (r) {
      return { id: String(r.locationId), name: String(r.name), role: String(r.role) };
    }),
    movements: rows_('movements').filter(function (r) { return r.movementId; }).map(function (r) {
      return { id: String(r.movementId), date: date_(r.date), type: String(r.type), itemId: String(r.itemId),
               qty: Number(r.qty) || 0, from: String(r.from || ''), to: String(r.to || ''), price: Number(r.price) || 0,
               worker: String(r.worker), note: String(r.note || ''),
               at: r.at instanceof Date ? r.at.toISOString() : String(r.at) };
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
    out.ok = true;
    out.worker = who.name;
    return json_(out);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('movements');
    var seen = {};
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { seen[String(r[0])] = true; });
    }
    var items = {};
    rows_('items').forEach(function (r) { items[String(r.itemId)] = r; });
    var locs = {};
    rows_('locations').forEach(function (r) { locs[String(r.locationId)] = true; });

    var now = new Date();
    var saved = [], rejected = [], rows = [];
    (body.movements || []).forEach(function (m) {
      var id = String(m.id || '');
      if (!id) return;
      if (seen[id]) { saved.push(id); return; }
      var it = items[String(m.itemId)];
      var qty = Number(m.qty);
      var ok = it && TYPES.indexOf(m.type) >= 0 && isFinite(qty) && qty >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(m.date) &&
        (!m.from || locs[m.from]) && (!m.to || locs[m.to]);
      if (!ok) { rejected.push(id); return; }
      var price = m.type === 'sale' ? Number(m.price) || 0 : '';
      rows.push([id, m.date, m.type, m.itemId, it.name, qty, it.unit, m.from || '', m.to || '', price,
                 m.type === 'sale' ? qty * price : '', who.name, String(m.note || '').slice(0, 500), m.at || '', now]);
      seen[id] = true;
      saved.push(id);
    });
    if (rows.length) {
      var start = sh.getLastRow() + 1;
      sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
      sh.getRange(start, 2, rows.length, 1).setNumberFormat('yyyy-mm-dd');
    }
    return json_({ ok: true, saved: saved, rejected: rejected, worker: who.name });
  } finally {
    lock.releaseLock();
  }
}
