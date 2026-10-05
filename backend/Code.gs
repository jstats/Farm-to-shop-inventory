/**
 * Beelove farm-to-shop inventory backend (Google Apps Script, bound to the inventory Google Sheet).
 *
 * The sheet is the record. Workers' phones send stock movements here; the app's dashboard reads them back.
 *   items      – what we sell. Edit names, prices and reorder levels here; set active = no to hide an item.
 *   locations  – the farm and the shops (Kiunduani, Nairobi). Add a row with role = shop for a new branch.
 *                lat/lon = the place's GPS point (a manager sets it from the app); radiusM = how close a phone
 *                must be (default 200). A place with no lat/lon accepts entries from anywhere.
 *   workers    – who may sign in: name + PIN. Set active = no when someone leaves. role = manager may set
 *                places' GPS points from the app and gets the reminder summary. email + place (the shop or farm
 *                they work at) decide who gets which reminder.
 *   movements  – one row per captured movement. Never edit "movementId"; fix mistakes with a new count.
 *                lat/lon/accuracyM/distanceM = where the phone was when the entry was saved.
 *
 * Every request carries the worker's name and PIN. The worker recorded on a movement is the signed-in
 * worker, never a name the phone sends. After MAX_FAILS wrong PINs a name is locked for LOCK_MINUTES.
 *
 * Location check: an entry for a place with a GPS point is refused unless the phone was within radiusM of it
 * (plus up to MAX_SLACK_M of the phone's reported accuracy). Same rule as placeCheck in docs/stock.js.
 *
 * Reminders: run setupReminders() once. Every day at 18:00 each shop with no sales recorded that day emails its
 * workers; on the last day of the month (09:00 and 18:00) each place not yet counted that month emails its workers.
 * Managers get one summary of who was reminded. Nothing is sent before the first movement is recorded.
 *
 * First time: run setup() once from the Apps Script editor, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). Put the web app URL in docs/config.js.
 */
var MAX_FAILS = 5;
var LOCK_MINUTES = 15;
var DEFAULT_RADIUS_M = 200;
var MAX_SLACK_M = 100;
var MAX_ACCURACY_M = 500;
var SET_POINT_MAX_ACCURACY_M = 100;  // a manager's fix must be at least this good to become a place's point
var APP_URL = 'https://jstats.github.io/Farm-to-shop-inventory/';
var TZ = 'Africa/Nairobi';
var EVENING_HOUR = 18;  // daily sales reminder (and a second count reminder on the last day)
var MORNING_HOUR = 9;   // first count reminder on the last day of the month

var TABS = {
  items:     ['itemId', 'name', 'category', 'unit', 'price', 'reorderLevel', 'active'],
  locations: ['locationId', 'name', 'role', 'lat', 'lon', 'radiusM'],
  workers:   ['name', 'pin', 'active', 'role', 'email', 'place'],
  movements: ['movementId', 'date', 'type', 'itemId', 'itemName', 'qty', 'unit', 'from', 'to', 'price', 'amount',
              'worker', 'note', 'at', 'receivedAt', 'lat', 'lon', 'accuracyM', 'distanceM'],
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

/** Run once from the editor. Safe to run again: it only adds missing tabs and columns, never overwrites rows. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    headers_(sh, TABS[name]);
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
    workers.appendRow(['Manager', String(1000 + Math.floor(Math.random() * 9000)), 'yes', 'manager']);
  }
  // Keep PINs as text so a leading zero survives.
  workers.getRange('B:B').setNumberFormat('@');
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
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

function num_(v) {
  return v === '' || v == null || !isFinite(Number(v)) ? null : Number(v);
}

function distanceM_(lat1, lon1, lat2, lon2) {
  var R = 6371000, rad = Math.PI / 180;
  var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Same rule as placeCheck in docs/stock.js. Returns { ok, distance, reason }. */
function placeCheck_(loc, m) {
  var plat = num_(loc && loc.lat), plon = num_(loc && loc.lon);
  var lat = num_(m.lat), lon = num_(m.lon), acc = num_(m.acc) || 0;
  var d = lat != null && lon != null && plat != null && plon != null ? distanceM_(plat, plon, lat, lon) : null;
  if (plat == null || plon == null) return { ok: true, distance: d };
  if (lat == null || lon == null) return { ok: false, distance: null, reason: 'no_gps' };
  if (acc > MAX_ACCURACY_M) return { ok: false, distance: d, reason: 'weak_gps' };
  var radius = num_(loc.radiusM) > 0 ? num_(loc.radiusM) : DEFAULT_RADIUS_M;
  return d <= radius + Math.min(acc, MAX_SLACK_M) ? { ok: true, distance: d } : { ok: false, distance: d, reason: 'too_far' };
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

/** Returns the worker's name (as written in the sheet) and role, or { error }. */
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
  return { name: String(w.name).trim(), role: String(w.role || '').trim().toLowerCase(), place: placeId_(w.place) };
}

function data_() {
  return {
    items: rows_('items').filter(function (r) { return r.itemId; }).map(function (r) {
      return { id: String(r.itemId), name: String(r.name), category: String(r.category), unit: String(r.unit),
               price: Number(r.price) || 0, reorderLevel: Number(r.reorderLevel) || 0, active: yes_(r.active) };
    }),
    locations: rows_('locations').filter(function (r) { return r.locationId; }).map(function (r) {
      return { id: String(r.locationId), name: String(r.name), role: String(r.role),
               lat: num_(r.lat), lon: num_(r.lon), radiusM: num_(r.radiusM) };
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
 *   {action: 'setPoint', name, pin, locationId, lat, lon, acc} → managers only: sets a place's GPS point
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
    out.role = who.role;
    out.place = who.place;
    return json_(out);
  }
  if (body.action === 'setPoint') return json_(setPoint_(who, body));

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
      if (!ok) { rejected.push(id); reasons[id] = 'invalid'; return; }
      var check = placeCheck_(locs[m.type === 'sale' || m.type === 'transfer' ? m.from : m.to], m);
      if (!check.ok) { rejected.push(id); reasons[id] = check.reason; return; }
      var price = m.type === 'sale' ? Number(m.price) || 0 : '';
      var v = {
        movementId: id, date: m.date, type: m.type, itemId: m.itemId, itemName: it.name, qty: qty, unit: it.unit,
        from: m.from || '', to: m.to || '', price: price, amount: m.type === 'sale' ? qty * price : '', worker: who.name,
        note: String(m.note || '').slice(0, 500), at: m.at || '', receivedAt: now,
        lat: num_(m.lat) == null ? '' : num_(m.lat), lon: num_(m.lon) == null ? '' : num_(m.lon),
        accuracyM: num_(m.acc) == null ? '' : Math.round(num_(m.acc)),
        distanceM: check.distance == null ? '' : Math.round(check.distance),
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

/** A manager standing at a place saves the phone's position as that place's GPS point. */
function setPoint_(who, body) {
  if (who.role !== 'manager') return { ok: false, error: 'not_manager' };
  var lat = num_(body.lat), lon = num_(body.lon), acc = num_(body.acc);
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, error: 'no_gps' };
  if (acc == null || acc > SET_POINT_MAX_ACCURACY_M) return { ok: false, error: 'weak_gps' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('locations');
  var head = headers_(sh, TABS.locations);
  var ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues() : [];
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(body.locationId)) {
      sh.getRange(i + 2, head.indexOf('lat') + 1).setValue(Math.round(lat * 1e6) / 1e6);
      sh.getRange(i + 2, head.indexOf('lon') + 1).setValue(Math.round(lon * 1e6) / 1e6);
      return { ok: true };
    }
  }
  return { ok: false, error: 'unknown_place' };
}

// ---------- reminders ----------

/** Run once from the editor: (re)creates the two daily reminder triggers. */
function setupReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'reminders') ScriptApp.deleteTrigger(t);
  });
  [MORNING_HOUR, EVENING_HOUR].forEach(function (h) {
    ScriptApp.newTrigger('reminders').timeBased().everyDays(1).atHour(h).nearMinute(0).inTimezone(TZ).create();
  });
}

/** Trigger handler. */
function reminders() {
  return reminders_(new Date());
}

/** A worker's place as a locationId: accepts the id or the place's name, any case. '' if none/unknown. */
function placeId_(v) {
  var want = String(v || '').trim().toLowerCase();
  if (!want) return '';
  var hit = rows_('locations').filter(function (r) {
    return String(r.locationId).toLowerCase() === want || String(r.name).trim().toLowerCase() === want;
  })[0];
  return hit ? String(hit.locationId) : '';
}

function isLastDayOfMonth_(ymd) {
  var p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1)).getUTCDate() === 1;
}

/** Works out what is outstanding at `now` and emails the people concerned. Returns what it sent (for tests/logs). */
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
    return { name: String(w.name).trim(), email: String(w.email || '').trim(), role: String(w.role || '').trim().toLowerCase(),
             place: placeId_(w.place) };
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
  var summary = [];
  issues.forEach(function (x) {
    var people = workers.filter(function (w) { return w.place === String(x.place.locationId) && w.email; });
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
    summary.push('• ' + x.place.name + ': ' + (x.kind === 'sales' ? 'no sales recorded today' : monthName + ' count not done') +
      (people.length ? ' (reminded ' + people.map(function (w) { return w.name; }).join(', ') + ')'
        : ' (nobody reminded: no worker with an email has this place)'));
  });

  workers.filter(function (w) { return w.role === 'manager' && w.email; }).forEach(function (m) {
    MailApp.sendEmail(m.email, 'Beelove Stock: ' + issues.length + ' thing' + (issues.length === 1 ? '' : 's') + ' outstanding (' + dayName + ')',
      'Hello ' + m.name.split(' ')[0] + ',\n\n' + summary.join('\n') + '\n\nDashboard: ' + APP_URL + '\n\nBeelove Stock');
    sent.push({ to: m.email, kind: 'summary' });
  });
  return sent;
}
