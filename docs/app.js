/**
 * Beelove Stock: the phone app workers use to record stock movements, plus the dashboard.
 *
 * Works offline: every entry is saved on the phone first (the queue), then sent to the Google Sheet
 * when there is signal. The dashboard is worked out on the phone from the sheet's movements plus
 * anything still waiting in the queue, so a worker always sees their own entries.
 */
(function () {
  var CFG = window.BEELOVE_CONFIG || {};
  var DEMO = !CFG.apiUrl;
  var KEY = DEMO ? 'beelove-stock-demo:' : 'beelove-stock:';

  var TYPES = {
    restock: { title: 'Restock / harvest', ico: '📦', hint: 'New stock arriving at the farm or a shop', verb: 'Restocked' },
    transfer: { title: 'Send stock', ico: '🚚', hint: 'Move stock from the farm to a shop', verb: 'Sent' },
    sale: { title: 'Record sales', ico: '🧾', hint: 'What a shop sold', verb: 'Sold' },
    count: { title: 'Monthly count', ico: '📋', hint: 'Count what is on the shelf', verb: 'Counted' },
  };

  // ---------- storage (wrapped: private mode or full storage must not break the app) ----------
  function load(k, fallback) {
    try {
      var v = localStorage.getItem(KEY + k);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(k, v) {
    try {
      localStorage.setItem(KEY + k, JSON.stringify(v));
    } catch (e) { /* keep going in memory */ }
  }

  var state = {
    profile: load('profile', null), // { name, pin }
    data: load('data', null), // { items, locations, movements, fetchedAt }
    queue: load('queue', []), // movements not yet in the sheet
    rejected: load('rejected', []), // movements the sheet refused (unknown item etc.)
    prefs: load('prefs', {}), // last shop used, etc.
    tab: 'home',
    view: null, // form type when filling a form, 'done' after saving
    syncing: false,
    online: navigator.onLine !== false,
    authError: false,
    lastError: '',
  };

  // ---------- helpers ----------
  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ksh(n) { return 'KSh ' + Math.round(n).toLocaleString('en-KE'); }
  function qty(n) { return (Math.round(n * 100) / 100).toLocaleString('en-KE'); }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function monthName(ym, long) {
    var d = new Date(ym + '-01T00:00:00');
    return d.toLocaleDateString('en-KE', long ? { month: 'long', year: 'numeric' } : { month: 'short' });
  }
  function niceDate(d) {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
  }

  // ---------- GPS (works without mobile data) ----------
  /** Best fix within `ms`: resolves early once accuracy is good. Rejects with 'denied' or 'no_gps'. */
  // Always a fresh reading: an earlier fix would let someone save after walking away.
  function locate(ms) {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject('no_gps');
      var best = null;
      var id = navigator.geolocation.watchPosition(function (p) {
        var f = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, time: Date.now() };
        if (!best || f.acc < best.acc) best = f;
        if (best.acc <= 30) finish();
      }, function (err) {
        if (err.code === 1) { done = true; navigator.geolocation.clearWatch(id); clearTimeout(timer); reject('denied'); }
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: ms });
      var done = false;
      var timer = setTimeout(finish, ms);
      function finish() {
        if (done) return;
        done = true;
        navigator.geolocation.clearWatch(id);
        clearTimeout(timer);
        if (best) resolve(best); else reject('no_gps');
      }
    });
  }

  function distText(m) {
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
  }

  function placeError(reason, loc, check) {
    if (reason === 'denied') return 'This app needs your location to save entries for ' + loc.name + '. Allow location for this site in your browser settings, then try again.';
    if (reason === 'no_gps') return 'Could not find your location. Turn on Location (GPS) on your phone and try again.';
    if (reason === 'weak_gps') return 'Your GPS signal is too weak. Step outside or near a window for a moment, then try again.';
    if (reason === 'too_far') return 'You are ' + distText(check.distance) + ' from ' + loc.name + '. Entries for ' + loc.name + ' can only be saved there.';
    return 'Location check failed.';
  }

  function items() { return ((state.data && state.data.items) || []).filter(function (i) { return i.active !== false; }); }
  function allItems() { return (state.data && state.data.items) || []; }
  function locations() { return (state.data && state.data.locations) || []; }
  function shops() { return locations().filter(function (l) { return l.role === 'shop'; }); }
  function farm() { return locations().filter(function (l) { return l.role === 'farm'; })[0] || locations()[0]; }
  function locName(id) {
    var l = locations().filter(function (x) { return x.id === id; })[0];
    return l ? l.name : id;
  }
  function itemById(id) { return allItems().filter(function (i) { return i.id === id; })[0]; }

  /** Sheet movements plus the queue (the queue wins on the same id). */
  function movements() {
    var byId = {};
    var out = [];
    state.queue.forEach(function (m) { byId[m.id] = true; out.push(m); });
    ((state.data && state.data.movements) || []).forEach(function (m) { if (!byId[m.id]) out.push(m); });
    return out;
  }

  // ---------- backend ----------
  function api(body) {
    body.name = state.profile && state.profile.name;
    body.pin = state.profile && state.profile.pin;
    return fetch(CFG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // plain text: no CORS preflight for Apps Script
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  function errorText(code) {
    if (code === 'wrong_pin') return 'Name or PIN is not right.';
    if (code === 'locked') return 'Too many wrong PINs. Wait 15 minutes and try again.';
    return 'Something went wrong (' + code + ').';
  }

  function demoData() {
    return { items: Seed.items(), locations: Seed.locations(), movements: Seed.demoMovements(today()), fetchedAt: new Date().toISOString() };
  }

  /** Sends the queue, then pulls the latest from the sheet. Quiet on failure: entries stay queued. */
  function sync() {
    if (!state.profile) return Promise.resolve();
    if (DEMO) {
      state.data.movements = movements();
      state.queue = [];
      save('data', state.data);
      save('queue', state.queue);
      render();
      return Promise.resolve();
    }
    if (state.syncing) return Promise.resolve();
    state.syncing = true;
    paintSync();
    var sending = state.queue.slice();
    var step = sending.length ? api({ action: 'save', movements: sending }) : Promise.resolve({ ok: true, saved: [], rejected: [] });
    return step.then(function (res) {
      if (!res.ok) throw res;
      var done = {};
      res.saved.concat(res.rejected || []).forEach(function (id) { done[id] = true; });
      var reasons = res.reasons || {};
      var rej = sending.filter(function (m) { return (res.rejected || []).indexOf(m.id) >= 0; })
        .map(function (m) { return Object.assign({}, m, { reason: reasons[m.id] || 'invalid' }); });
      if (rej.length) {
        state.rejected = state.rejected.concat(rej);
        save('rejected', state.rejected);
      }
      // Keep entries made while this request was in flight.
      state.queue = state.queue.filter(function (m) { return !done[m.id]; });
      save('queue', state.queue);
      return api({ action: 'data' });
    }).then(function (res) {
      if (!res.ok) throw res;
      state.data = { items: res.items, locations: res.locations, movements: res.movements, fetchedAt: new Date().toISOString() };
      save('data', state.data);
      if (state.profile.role !== res.role) {
        state.profile.role = res.role;
        save('profile', state.profile);
      }
      state.authError = false;
      state.lastError = '';
    }).catch(function (err) {
      if (err && (err.error === 'wrong_pin' || err.error === 'locked')) state.authError = true;
      state.lastError = err && err.error ? errorText(err.error) : 'No connection. Entries are safe on this phone.';
    }).then(function () {
      state.syncing = false;
      render();
    });
  }

  // ---------- chrome: sync status, banners, tabs ----------
  function paintSync() {
    var el = $('#sync');
    if (!state.profile) { el.textContent = ''; return; }
    if (DEMO) { el.textContent = 'Demo'; return; }
    if (state.syncing) el.textContent = 'Sending…';
    else if (state.queue.length) el.textContent = state.queue.length + ' waiting for signal';
    else el.textContent = 'All sent ✓';
  }

  function paintBanner() {
    var html = '';
    if (DEMO && state.profile) {
      html += '<div class="banner info">Demo mode: sample data, saved only on this phone. Connect the Google Sheet in config.js to go live.</div>';
    }
    if (state.authError) {
      html += '<div class="banner bad">Your name or PIN no longer works, so entries are not being sent. ' +
        '<button data-act="resign">Sign in again</button></div>';
    }
    if (state.rejected.length) {
      html += '<div class="banner bad">' + state.rejected.length + ' entr' + (state.rejected.length === 1 ? 'y was' : 'ies were') +
        ' refused by the sheet. See Me.</div>';
    }
    $('#banner').innerHTML = html;
  }

  function paintTabs() {
    var nav = $('#tabs');
    nav.hidden = !state.profile;
    Array.prototype.forEach.call(nav.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === state.tab);
    });
  }

  function render() {
    paintSync();
    paintBanner();
    paintTabs();
    var v = $('#view');
    if (!state.profile || !state.data) return renderSignIn(v);
    if (state.view === 'done') return renderDone(v);
    if (state.view) return renderForm(v, state.view);
    if (state.tab === 'dashboard') return renderDashboard(v);
    if (state.tab === 'me') return renderMe(v);
    return renderHome(v);
  }

  // ---------- sign in ----------
  function renderSignIn(v) {
    v.innerHTML =
      '<h1>Sign in</h1>' +
      '<p class="muted">Your name goes on every entry you make, so we can tell who did what.</p>' +
      (DEMO ? '<p class="banner info" style="margin:12px 0;width:100%">Demo mode: any name and PIN work.</p>' : '') +
      '<form id="signin" class="card" autocomplete="on">' +
      '<label class="field"><span>Your name</span><input type="text" name="name" autocomplete="username" required value="' +
      esc((state.profile && state.profile.name) || load('lastName', '')) + '"></label>' +
      '<label class="field"><span>PIN</span><input type="password" name="pin" inputmode="numeric" autocomplete="current-password" required></label>' +
      '<div class="err" id="signin-err"></div>' +
      '<button class="btn" type="submit">Sign in</button>' +
      '</form>' +
      '<p class="muted small">No PIN yet? Ask the manager to add you in the "workers" tab of the stock sheet.</p>';
    $('#signin').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var name = f.name.value.trim();
      var pin = f.pin.value.trim();
      var btn = f.querySelector('button');
      var err = $('#signin-err');
      if (!name || !pin) return;
      if (DEMO) {
        state.profile = { name: name, pin: pin, role: 'manager' };
        state.data = state.data || demoData();
        afterSignIn();
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Checking…';
      state.profile = { name: name, pin: pin };
      api({ action: 'data' }).then(function (res) {
        if (!res.ok) throw res;
        state.profile.name = res.worker; // as spelled in the sheet
        state.profile.role = res.role;
        state.data = { items: res.items, locations: res.locations, movements: res.movements, fetchedAt: new Date().toISOString() };
        save('data', state.data);
        afterSignIn();
      }).catch(function (x) {
        state.profile = null;
        err.textContent = x && x.error ? errorText(x.error) : 'No connection. You need signal the first time you sign in.';
        btn.disabled = false;
        btn.textContent = 'Sign in';
      });
    });
  }

  function afterSignIn() {
    save('profile', state.profile);
    save('lastName', state.profile.name);
    save('data', state.data);
    state.authError = false;
    state.tab = 'home';
    state.view = null;
    render();
    sync();
  }

  // ---------- home ----------
  function renderHome(v) {
    var s = Stock.summarise({ items: allItems(), locations: locations(), movements: movements() }, today());
    var due = s.countDue.map(locName);
    var firstName = esc(state.profile.name.split(' ')[0]);
    v.innerHTML =
      '<h1>Hello, ' + firstName + '</h1>' +
      '<p class="muted">What are you recording?</p>' +
      (due.length ? '<div class="banner warn" style="width:100%;margin:12px 0 0">📋 ' + esc(monthName(today().slice(0, 7), true)) +
        ' count not done yet: ' + esc(due.join(', ')) + '.</div>' : '') +
      '<div class="actions">' +
      Object.keys(TYPES).map(function (t) {
        var T = TYPES[t];
        return '<button class="action' + (t === 'count' && due.length ? ' due' : '') + '" data-form="' + t + '">' +
          '<span class="ico" aria-hidden="true">' + T.ico + '</span><b>' + T.title + '</b><span>' + T.hint + '</span></button>';
      }).join('') +
      '</div>' +
      recentMine();
  }

  function recentMine() {
    var mine = Stock.sortMovements(movements().filter(function (m) { return m.worker === state.profile.name; })).reverse().slice(0, 6);
    if (!mine.length) return '';
    return '<h2>Your latest entries</h2><ul class="list">' + mine.map(movementLi).join('') + '</ul>';
  }

  function movementLi(m) {
    var it = itemById(m.itemId);
    var name = it ? it.name : m.itemId;
    var unit = it ? it.unit : '';
    var where = m.type === 'transfer' ? locName(m.from) + ' → ' + locName(m.to)
      : m.type === 'sale' ? locName(m.from) : locName(m.to);
    var pending = state.queue.some(function (q) { return q.id === m.id; });
    var extra = m.type === 'sale' ? ' · ' + ksh(m.qty * m.price) : '';
    return '<li><span class="muted small" style="width:48px">' + esc(niceDate(m.date)) + '</span>' +
      '<span class="grow"><b>' + esc(TYPES[m.type] ? TYPES[m.type].verb : m.type) + ' ' + qty(m.qty) + ' ' + esc(unit) + '</b> ' + esc(name) +
      '<br><span class="muted small">' + esc(where) + extra + ' · ' + esc(m.worker) + (m.note ? ' · “' + esc(m.note) + '”' : '') + '</span></span>' +
      (pending ? '<span class="pill wait">waiting</span>' : '') + '</li>';
  }

  // ---------- forms ----------
  function locOptions(list, selected) {
    return list.map(function (l) {
      return '<option value="' + esc(l.id) + '"' + (l.id === selected ? ' selected' : '') + '>' + esc(l.name) + '</option>';
    }).join('');
  }

  function renderForm(v, type) {
    var T = TYPES[type];
    var f = farm() || {};
    var shopList = shops();
    var lastShop = state.prefs.shop && shopList.some(function (s) { return s.id === state.prefs.shop; }) ? state.prefs.shop : (shopList[0] || {}).id;
    var where = '';
    if (type === 'restock') {
      where = '<label class="field"><span>Where did the stock arrive?</span><select name="to">' + locOptions(locations(), f.id) + '</select></label>';
    } else if (type === 'transfer') {
      where = '<div class="row2"><label class="field"><span>From</span><select name="from">' + locOptions(locations(), f.id) + '</select></label>' +
        '<label class="field"><span>To</span><select name="to">' + locOptions(locations(), lastShop) + '</select></label></div>';
    } else if (type === 'sale') {
      where = '<label class="field"><span>Which shop?</span><select name="from">' + locOptions(shopList, lastShop) + '</select></label>';
    } else {
      where = '<label class="field"><span>Where are you counting?</span><select name="to">' + locOptions(locations(), lastShop) + '</select></label>';
    }
    var help = {
      restock: 'Enter how many arrived. Leave the rest empty.',
      transfer: 'Enter how many you are sending. Leave the rest empty.',
      sale: 'Enter how many were sold. Change the price if you sold at a different price.',
      count: 'Count what is physically there and type it in. Type 0 if there are none. Leave empty only items you did not count.',
    }[type];

    var cats = [];
    items().forEach(function (it) { if (cats.indexOf(it.category) < 0) cats.push(it.category); });
    var list = cats.map(function (c) {
      return '<div class="cat">' + esc(c) + '</div>' + items().filter(function (it) { return it.category === c; }).map(function (it) {
        return '<div class="item' + (type === 'sale' ? ' sale' : '') + '" data-item="' + esc(it.id) + '">' +
          '<div><div class="name">' + esc(it.name) + '</div><div class="meta">' + esc(it.unit) + ' · ' + ksh(it.price) +
          '<span class="onhand"></span></div></div>' +
          (type === 'sale' ? '<div><label for="p-' + esc(it.id) + '">Price</label><input id="p-' + esc(it.id) + '" inputmode="decimal" name="price" value="' + esc(it.price) + '"></div>' : '') +
          '<div><label for="q-' + esc(it.id) + '">' + (type === 'count' ? 'On shelf' : 'How many') + '</label>' +
          '<input id="q-' + esc(it.id) + '" inputmode="decimal" name="qty" placeholder="–" autocomplete="off"></div>' +
          '<div class="warn" hidden></div></div>';
      }).join('');
    }).join('');

    v.innerHTML =
      '<button class="back" data-act="cancel">‹ Back</button>' +
      '<h1>' + T.ico + ' ' + T.title + '</h1>' +
      '<form id="mv" novalidate>' +
      '<div class="card">' +
      '<label class="field"><span>Date</span><input type="date" name="date" value="' + today() + '" max="' + today() + '" required></label>' +
      where +
      '<p class="muted small" style="margin:0">' + help + '</p>' +
      '<p class="muted small" id="gps-note" style="margin:8px 0 0"></p>' +
      '</div>' +
      '<input type="search" id="filter" placeholder="Find an item…" aria-label="Find an item">' +
      list +
      '<label class="field" style="margin-top:16px"><span>Note (optional)</span><textarea name="note" maxlength="500" placeholder="' +
      (type === 'count' ? 'e.g. 2 jars broken' : type === 'restock' ? 'e.g. harvest from apiary 3' : '') + '"></textarea></label>' +
      '<div class="err" id="form-err"></div>' +
      '<div class="form-pad"></div>' +
      '<div class="savebar"><button class="btn" type="submit" id="save-btn">Save</button></div>' +
      '</form>';

    var form = $('#mv');
    function sourceLoc() {
      if (type === 'sale' || type === 'transfer') return form.from.value;
      return null;
    }
    function refresh() {
      var src = sourceLoc();
      var mvts = movements();
      var n = 0;
      Array.prototype.forEach.call(form.querySelectorAll('.item'), function (row) {
        var id = row.getAttribute('data-item');
        var q = row.querySelector('input[name=qty]').value.trim();
        var has = q !== '' && (type === 'count' || Number(q) > 0);
        row.classList.toggle('filled', has);
        if (has) n++;
        var oh = row.querySelector('.onhand');
        var warn = row.querySelector('.warn');
        if (src) {
          var on = Stock.onHand(mvts, id, src);
          oh.textContent = ' · ' + qty(on) + ' at ' + locName(src);
          var over = has && Number(q) > on;
          warn.hidden = !over;
          warn.textContent = over ? 'Only ' + qty(on) + ' recorded at ' + locName(src) + '. Check the number, or do a count.' : '';
        } else {
          oh.textContent = '';
          warn.hidden = true;
        }
      });
      $('#save-btn').textContent = n ? 'Save ' + n + ' item' + (n === 1 ? '' : 's') : 'Save';
      var place = locations().filter(function (l) {
        return l.id === Stock.checkPlace({ type: type, from: form.from ? form.from.value : '', to: form.to ? form.to.value : '' });
      })[0];
      $('#gps-note').textContent = place && Stock.hasPoint(place) ? '📍 You need to be at ' + place.name + ' to save this.' : '';
    }
    form.addEventListener('input', function (e) {
      if (e.target.id === 'filter') {
        var term = e.target.value.trim().toLowerCase();
        Array.prototype.forEach.call(form.querySelectorAll('.item'), function (row) {
          row.hidden = term && row.querySelector('.name').textContent.toLowerCase().indexOf(term) < 0;
        });
        return;
      }
      refresh();
    });
    form.addEventListener('change', refresh);
    refresh();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('#form-err');
      var date = form.date.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) { err.textContent = 'Pick a date that is today or earlier.'; return; }
      var from = form.from ? form.from.value : '';
      var to = form.to ? form.to.value : '';
      if (type === 'transfer' && from === to) { err.textContent = '“From” and “To” must be different places.'; return; }
      var note = form.note.value.trim();
      var at = new Date().toISOString();
      var out = [];
      var bad = null;
      Array.prototype.forEach.call(form.querySelectorAll('.item'), function (row) {
        var raw = row.querySelector('input[name=qty]').value.trim().replace(',', '.');
        if (raw === '') return;
        var q = Number(raw);
        if (!isFinite(q) || q < 0) { bad = bad || row; return; }
        if (q === 0 && type !== 'count') return;
        var id = row.getAttribute('data-item');
        var price = 0;
        if (type === 'sale') {
          price = Number(row.querySelector('input[name=price]').value.trim().replace(/,/g, ''));
          if (!isFinite(price) || price < 0) { bad = bad || row; return; }
        }
        out.push({ id: uid(), date: date, type: type, itemId: id, qty: q, from: type === 'sale' || type === 'transfer' ? from : '',
                   to: type === 'sale' ? '' : to, price: price, worker: state.profile.name, note: note, at: at });
      });
      if (bad) {
        err.textContent = 'One of the numbers is not right. Use digits only.';
        bad.scrollIntoView({ block: 'center' });
        return;
      }
      if (!out.length) { err.textContent = 'Type a number next to at least one item.'; return; }
      var overs = form.querySelectorAll('.warn:not([hidden])').length;
      if (overs && !window.confirm(overs + ' item' + (overs === 1 ? ' is' : 's are') + ' more than the stock recorded. Save anyway?')) return;

      var place = locations().filter(function (l) { return l.id === Stock.checkPlace({ type: type, from: from, to: to }); })[0];
      if (!place || !Stock.hasPoint(place)) return commit(out);
      var btn = $('#save-btn');
      btn.disabled = true;
      btn.textContent = 'Checking your location…';
      err.textContent = '';
      locate(15000).then(function (fix) {
        var check = Stock.placeCheck(place, fix);
        if (!check.ok) throw { reason: check.reason, check: check };
        out.forEach(function (m) { m.lat = fix.lat; m.lon = fix.lon; m.acc = Math.round(fix.acc); });
        commit(out);
      }).catch(function (x) {
        btn.disabled = false;
        refresh();
        err.textContent = placeError(x && x.reason ? x.reason : x, place, x && x.check);
        err.scrollIntoView({ block: 'center' });
      });
    });

    function commit(out) {
      var from = form.from ? form.from.value : '';
      var to = form.to ? form.to.value : '';
      if (type === 'sale' || type === 'count') state.prefs.shop = type === 'sale' ? from : to;
      if (type === 'transfer') state.prefs.shop = to;
      save('prefs', state.prefs);
      state.queue = state.queue.concat(out);
      save('queue', state.queue);
      state.lastSaved = { type: type, count: out.length, amount: out.reduce(function (s, m) { return s + m.qty * m.price; }, 0) };
      state.view = 'done';
      render();
      window.scrollTo(0, 0);
      sync();
    }
  }

  function renderDone(v) {
    var s = state.lastSaved || { count: 0 };
    var T = TYPES[s.type] || TYPES.restock;
    var waiting = !DEMO && state.queue.length;
    v.innerHTML = '<div class="done"><div class="big">✅</div><h1>Saved</h1>' +
      '<p>' + T.verb + ': ' + s.count + ' item' + (s.count === 1 ? '' : 's') + (s.type === 'sale' ? ' · ' + ksh(s.amount) : '') + '</p>' +
      '<p class="muted">' + (DEMO ? 'Saved on this phone (demo).' : waiting ? 'Saved on this phone. It will be sent to the sheet when there is signal.' : 'Sent to the stock sheet.') + '</p>' +
      '<div class="btn-row"><button class="btn" data-form="' + esc(s.type) + '">Record more ' + esc(T.title.toLowerCase()) + '</button>' +
      '<button class="btn secondary" data-act="home">Done</button>' +
      '<button class="btn secondary" data-tab="dashboard">See dashboard</button></div></div>';
  }

  // ---------- dashboard ----------
  function renderDashboard(v) {
    var s = Stock.summarise({ items: allItems(), locations: locations(), movements: movements() }, today());
    var ym = today().slice(0, 7);
    var locs = locations();
    var maxSale = Math.max.apply(null, s.salesByMonth.map(function (m) { return m.amount; }).concat([1]));
    var curMonth = s.salesByMonth[s.salesByMonth.length - 1];
    var prevMonth = s.salesByMonth[s.salesByMonth.length - 2];

    var tiles =
      '<div class="tiles">' +
      tile('Sales in ' + monthName(ym), ksh(s.month.sales), prevMonth ? 'Last month ' + ksh(prevMonth.amount) : '') +
      tile('Units sold', qty(s.month.units), s.month.entries + ' entries this month') +
      tile('Stock value', ksh(s.stockValue), 'At selling price, all places') +
      tile('Low in a shop', String(s.low.length), s.low.length ? 'Needs restocking' : 'Nothing low') +
      '</div>';

    var chart = '<h2>Sales by month</h2><div class="card"><div class="chart-max">' + ksh(maxSale) + '</div><div class="chart" id="chart">' +
      s.salesByMonth.map(function (m) {
        var h = Math.max(0, (m.amount / maxSale) * 100);
        return '<div class="col' + (m === curMonth ? ' cur' : '') + '" tabindex="0" data-tip="' + esc(monthName(m.month, true) + ': ' + ksh(m.amount) + ' · ' + qty(m.units) + ' units') + '">' +
          '<div class="bar" style="height:' + h.toFixed(1) + '%"></div><span class="lbl">' + esc(monthName(m.month).slice(0, 3)) + '</span></div>';
      }).join('') + '</div><p class="muted small" style="margin-top:10px">Tap a bar for the amount. This month is darker.</p></div>';

    var byShop = s.salesByShop.length ? '<h2>This month by shop</h2><div class="table-wrap"><table><thead><tr><th>Shop</th><th class="num">Units</th><th class="num">Sales</th></tr></thead><tbody>' +
      s.salesByShop.map(function (b) {
        return '<tr><td>' + esc(locName(b.location)) + '</td><td class="num">' + qty(b.units) + '</td><td class="num">' + ksh(b.amount) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '';

    var lowLi = function (l) {
      return '<li><span class="grow"><b>' + esc(l.item.name) + '</b><br><span class="muted small">' + esc(locName(l.location)) +
        ' · reorder at ' + qty(l.item.reorderLevel) + ' · farm has ' + qty(stockAt(s, l.item.id, (farm() || {}).id)) + '</span></span>' +
        '<span class="pill ' + (l.qty <= 0 ? 'bad' : 'warn') + '">' + (l.qty <= 0 ? '⛔ Out' : '⚠ ' + qty(l.qty) + ' left') + '</span></li>';
    };
    var lowSorted = s.low.slice().sort(function (a, b) { return a.qty - b.qty; });
    var low = '<h2>Low stock in shops</h2>' + (lowSorted.length
      ? '<ul class="list">' + lowSorted.slice(0, 5).map(lowLi).join('') + '</ul>' +
        (lowSorted.length > 5 ? '<details class="more"><summary>Show ' + (lowSorted.length - 5) + ' more</summary><ul class="list">' +
          lowSorted.slice(5).map(lowLi).join('') + '</ul></details>' : '')
      : '<p class="muted">✓ Every shop is above its reorder level.</p>');

    var counts = '<h2>Monthly count</h2><ul class="list">' + locs.map(function (l) {
      var last = s.lastCount[l.id];
      var done = last && last.slice(0, 7) === ym;
      return '<li><span class="grow"><b>' + esc(l.name) + '</b><br><span class="muted small">' +
        (last ? 'Last counted ' + esc(niceDate(last)) : 'Never counted') + '</span></span>' +
        '<span class="pill ' + (done ? 'ok' : 'warn') + '">' + (done ? '✓ Done' : '⚠ Due') + '</span></li>';
    }).join('') + '</ul>';

    var adj = s.adjustments.filter(function (a) { return a.movement.date.slice(0, 7) === ym && a.delta !== 0; });
    var adjHtml = adj.length ? '<h2>Count differences this month</h2><p class="muted small">Shelf count minus what the records said. Minus means stock went missing.</p>' +
      '<div class="table-wrap"><table><thead><tr><th>Item</th><th>Where</th><th class="num">Records</th><th class="num">Counted</th><th class="num">Diff</th></tr></thead><tbody>' +
      adj.map(function (a) {
        var it = itemById(a.movement.itemId);
        return '<tr><td>' + esc(it ? it.name : a.movement.itemId) + '</td><td>' + esc(locName(a.movement.to)) + '</td><td class="num">' + qty(a.before) +
          '</td><td class="num">' + qty(a.after) + '</td><td class="num' + (a.delta < 0 ? ' neg' : '') + '">' + (a.delta > 0 ? '+' : '') + qty(a.delta) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '';

    var table = '<h2>Stock now</h2><div class="table-wrap"><table><thead><tr><th>Item</th>' +
      locs.map(function (l) { return '<th class="num">' + esc(l.name.replace(/ Shop$/, '')) + '</th>'; }).join('') +
      '<th class="num">Total</th></tr></thead><tbody>' +
      s.stock.filter(function (x) { return x.item.active !== false || x.total !== 0; }).map(function (x) {
        return '<tr><td>' + esc(x.item.name) + '<br><span class="muted small">' + esc(x.item.unit) + '</span></td>' +
          locs.map(function (l) {
            var q = x.per[l.id];
            var cls = q < 0 ? ' neg' : x.lowAt.indexOf(l.id) >= 0 ? ' low' : '';
            return '<td class="num' + cls + '">' + qty(q) + (q < 0 ? ' ⛔' : x.lowAt.indexOf(l.id) >= 0 ? ' ⚠' : '') + '</td>';
          }).join('') + '<td class="num">' + qty(x.total) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="muted small" style="margin-top:6px">⚠ at or below reorder level · ⛔ below zero: an entry is missing or wrong; the next count will correct it.</p>';

    var top = s.top.length ? '<h2>Best sellers in ' + esc(monthName(ym)) + '</h2><ul class="list">' + s.top.slice(0, 5).map(function (t) {
      var it = itemById(t.itemId);
      return '<li><span class="grow">' + esc(it ? it.name : t.itemId) + '</span><span class="num small muted">' + qty(t.units) + ' ' + esc(it ? it.unit : '') +
        '</span><span class="num" style="min-width:96px">' + ksh(t.amount) + '</span></li>';
    }).join('') + '</ul>' : '';

    var recent = '<h2>Latest activity</h2>' + (s.recent.length ? '<ul class="list">' + s.recent.slice(0, 12).map(movementLi).join('') + '</ul>' : '<p class="muted">Nothing recorded yet.</p>');

    var fresh = state.data && state.data.fetchedAt ? new Date(state.data.fetchedAt).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    v.innerHTML = '<h1>Dashboard</h1><p class="muted small">' + (DEMO ? 'Demo data' : 'Updated ' + esc(fresh)) +
      ' · <button class="btn link" data-act="sync">Refresh</button></p>' +
      tiles + low + chart + byShop + counts + adjHtml + table + top + recent;
    wireChart();
  }

  function stockAt(s, itemId, loc) {
    var x = s.stock.filter(function (r) { return r.item.id === itemId; })[0];
    return x ? x.per[loc] || 0 : 0;
  }

  function tile(label, value, sub) {
    return '<div class="tile"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div>' +
      (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function wireChart() {
    var chart = $('#chart');
    var tip = $('#tip');
    if (!chart) return;
    function show(col) {
      Array.prototype.forEach.call(chart.children, function (c) { c.classList.toggle('hover', c === col); });
      if (!col) { tip.hidden = true; return; }
      tip.textContent = col.getAttribute('data-tip');
      tip.hidden = false;
      var r = col.getBoundingClientRect();
      var w = tip.offsetWidth;
      var x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
      tip.style.left = x + 'px';
      var bar = col.querySelector('.bar').getBoundingClientRect();
      tip.style.top = Math.max(8, bar.top - tip.offsetHeight - 8) + 'px';
    }
    function hit(e) {
      var col = e.target.closest && e.target.closest('.col');
      show(col);
    }
    chart.addEventListener('pointermove', hit);
    chart.addEventListener('pointerdown', hit);
    chart.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') show(null); });
    chart.addEventListener('focusin', hit);
    chart.addEventListener('focusout', function () { show(null); });
    window.addEventListener('scroll', function () { show(null); }, { passive: true, once: true });
  }

  // ---------- me ----------
  function renderMe(v) {
    var fresh = state.data && state.data.fetchedAt ? new Date(state.data.fetchedAt).toLocaleString('en-KE') : 'never';
    v.innerHTML = '<h1>' + esc(state.profile.name) + '</h1>' +
      '<div class="card">' +
      '<p><b>Waiting to send:</b> ' + state.queue.length + ' entr' + (state.queue.length === 1 ? 'y' : 'ies') + '</p>' +
      '<p><b>Last update from the sheet:</b> ' + esc(DEMO ? 'demo' : fresh) + '</p>' +
      (state.lastError ? '<p class="err">' + esc(state.lastError) + '</p>' : '') +
      '<div class="btn-row"><button class="btn secondary" data-act="sync">Send and refresh now</button></div>' +
      '</div>' +
      (state.rejected.length ? '<h2>Refused by the sheet</h2><p class="muted small">These were not saved in the sheet. Tell the manager, then clear them.</p>' +
        '<ul class="list">' + state.rejected.map(function (m) {
          var why = { too_far: 'saved away from the place', no_gps: 'no location', weak_gps: 'weak GPS', invalid: 'item or place no longer exists' }[m.reason] || 'refused';
          return movementLi(m).replace('</span></span>', ' · <b>' + esc(why) + '</b></span></span>');
        }).join('') + '</ul>' +
        '<div class="btn-row"><button class="btn secondary" data-act="clear-rejected">Clear this list</button></div>' : '') +
      (state.profile.role === 'manager' ? placePoints() : '') +
      '<div class="btn-row">' +
      (DEMO ? '<button class="btn secondary" data-act="reset-demo">Reset demo data</button>' : '') +
      '<button class="btn secondary" data-act="signout">Sign out</button></div>' +
      '<p class="muted small" style="margin-top:16px">Tip: add this app to your home screen. On Android open the browser menu (⋮) and tap “Add to Home screen”. It works with no signal; entries are sent when signal comes back.</p>';
  }

  function placePoints() {
    return '<h2>Place locations (managers)</h2>' +
      '<p class="muted small">Stand inside a place and tap its button. After that, entries for that place can only be saved within ' +
      Stock.DEFAULT_RADIUS_M + ' m of it. To change the distance, edit radiusM in the locations tab.</p>' +
      '<ul class="list">' + locations().map(function (l) {
        return '<li><span class="grow"><b>' + esc(l.name) + '</b><br><span class="muted small">' +
          (Stock.hasPoint(l) ? '📍 Set · within ' + (l.radiusM || Stock.DEFAULT_RADIUS_M) + ' m' : 'Not set: entries allowed from anywhere') +
          '</span></span><button class="btn secondary" style="width:auto;min-height:40px;padding:8px 12px" data-act="set-point" data-loc="' + esc(l.id) + '">I am here</button></li>';
      }).join('') + '</ul><div class="err" id="point-err"></div>';
  }

  function setPoint(locId, btn) {
    var loc = locations().filter(function (l) { return l.id === locId; })[0];
    if (!loc || !window.confirm('Save your current position as the location of ' + loc.name + '? Only do this while you are inside ' + loc.name + '.')) return;
    var err = $('#point-err');
    btn.disabled = true;
    btn.textContent = 'Finding you…';
    locate(20000).then(function (fix) {
      if (fix.acc > 100) throw 'weak_gps';
      if (DEMO) return { ok: true, fix: fix };
      if (!navigator.onLine) throw 'offline';
      return api({ action: 'setPoint', locationId: locId, lat: fix.lat, lon: fix.lon, acc: fix.acc }).then(function (res) {
        if (!res.ok) throw res.error;
        return { ok: true, fix: fix };
      });
    }).then(function (r) {
      loc.lat = Math.round(r.fix.lat * 1e6) / 1e6;
      loc.lon = Math.round(r.fix.lon * 1e6) / 1e6;
      save('data', state.data);
      render();
      sync();
    }).catch(function (x) {
      btn.disabled = false;
      btn.textContent = 'I am here';
      err.textContent = x === 'offline' ? 'You need signal to save a place location.'
        : x === 'not_manager' ? 'Only managers can set place locations.'
        : x === 'weak_gps' ? 'GPS is not accurate enough yet (needs 100 m or better). Wait a moment near a window and try again.'
        : placeError(x, loc, null);
    });
  }

  // ---------- events ----------
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-form],[data-act],[data-tab]');
    if (!t) return;
    var form = t.getAttribute('data-form');
    var act = t.getAttribute('data-act');
    var tab = t.getAttribute('data-tab');
    if (form) {
      state.view = form;
      render();
      window.scrollTo(0, 0);
    } else if (tab) {
      if (state.view && state.view !== 'done' && !confirmLeave()) return;
      state.tab = tab;
      state.view = null;
      render();
      window.scrollTo(0, 0);
      if (tab === 'dashboard') sync();
    } else if (act === 'cancel') {
      if (!confirmLeave()) return;
      state.view = null;
      render();
    } else if (act === 'home') {
      state.view = null;
      state.tab = 'home';
      render();
    } else if (act === 'set-point') {
      setPoint(t.getAttribute('data-loc'), t);
    } else if (act === 'sync') {
      sync();
    } else if (act === 'signout' || act === 'resign') {
      if (state.queue.length && !DEMO && act === 'signout' &&
          !window.confirm(state.queue.length + ' entries are not sent yet. They stay on this phone and go when you sign in again. Sign out?')) return;
      state.profile = null;
      save('profile', null);
      render();
    } else if (act === 'clear-rejected') {
      state.rejected = [];
      save('rejected', []);
      render();
    } else if (act === 'reset-demo') {
      if (!window.confirm('Put the sample data back and delete your demo entries?')) return;
      state.data = demoData();
      state.queue = [];
      save('data', state.data);
      save('queue', []);
      render();
    }
  });

  function confirmLeave() {
    var filled = document.querySelectorAll('#mv .item.filled').length;
    return !filled || window.confirm('Leave without saving? The numbers you typed will be lost.');
  }

  window.addEventListener('online', function () { state.online = true; sync(); });
  window.addEventListener('offline', function () { state.online = false; paintSync(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(); });
  setInterval(function () { if (!document.hidden && state.queue.length) sync(); }, 60000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  render();
  sync();
})();
