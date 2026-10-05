/**
 * Beelove Stock: the phone app workers use to record stock movements, plus the dashboard.
 *
 * Works offline: every entry is saved on the phone first (the queue), then sent to the Google Sheet
 * when there is signal. The dashboard is worked out on the phone from the sheet's movements plus
 * anything still waiting in the queue, so a worker always sees their own entries.
 */
(function () {
  var APP_VERSION = 11; // keep equal to VERSION in sw.js (a test checks)
  var CFG = window.BEELOVE_CONFIG || {};
  var DEMO = !CFG.apiUrl;
  var KEY = DEMO ? 'beelove-stock-demo:' : 'beelove-stock:';

  var TYPES = {
    restock: { title: 'Restock / harvest', ico: '📦', hint: 'Harvested, made, born or bought', verb: 'Restocked' },
    transfer: { title: 'Send stock', ico: '🚚', hint: 'Move stock from the farm to a shop', verb: 'Sent' },
    sale: { title: 'Record sales', ico: '🧾', hint: 'What a shop or the market sold', verb: 'Sold' },
    loss: { title: 'Record loss', ico: '⚠️', hint: 'Spoilt, died, broken or stolen', verb: 'Lost' },
    pack: { title: 'Pack honey', ico: '🍯', hint: 'Fill jars and bottles from bulk honey', verb: 'Packed' },
    receive: { title: 'Delivery arrived', ico: '📥', hint: 'Check what arrived', verb: 'Received', hidden: true },
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
      if (state.profile.role !== res.role || JSON.stringify(state.profile.places) !== JSON.stringify(res.places || [])) {
        state.profile.role = res.role;
        state.profile.places = res.places || [];
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
    if (state.updateReady) {
      html += '<div class="banner info">A new version of the app is ready. Finish what you are doing, then <button data-act="reload">update now</button>.</div>';
    }
    var todo = state.profile && state.tab !== 'home' && !state.view ? reminders() : [];
    if (todo.length) {
      html += '<div class="banner remind-strip" role="alert">🔔 ' + esc(todo[0].title) +
        (todo.length > 1 ? ' (+' + (todo.length - 1) + ' more)' : '') + ' · <button data-act="home">Do it now</button></div>';
    }
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
    if (state.view === 'pack') return renderPack(v);
    if (state.view === 'receive') return renderReceive(v);
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
        state.profile.places = res.places || [];
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
  /**
   * What this worker still has to do. Workers with places in the sheet see those places only;
   * everyone else (managers) sees every place.
   *  - sales: from 4pm, a shop with nothing recorded today
   *  - count: last 3 days of the month, and (marked late) the first 3 days of the next, until a count is made
   */
  function reminders() {
    if (!state.profile || !state.data) return [];
    var mvts = movements();
    var mine = myPlaces();
    var places = locations().filter(function (l) { return !mine.length || mine.indexOf(l.id) >= 0; });
    var out = [];
    Stock.pendingDeliveries(mvts, mine, today()).forEach(function (d) {
      var n = d.lines.reduce(function (t, x) { return t + x.qty; }, 0);
      out.push({ form: 'receive', place: d.to, batch: d.batch, ico: '📥', title: 'Delivery from ' + locName(d.from),
        text: d.worker + ' sent ' + qty(n) + ' item' + (n === 1 ? '' : 's') + ' to ' + locName(d.to) + ' on ' + niceDate(d.date) +
          '. Check what arrived and confirm.', button: 'Check delivery' });
    });
    var win = Stock.countWindow(today());
    if (win) {
      places.forEach(function (l) {
        if (Stock.countedSince(mvts, l.id, win.start)) return;
        var m = monthName(win.month, true).split(' ')[0];
        out.push({ form: 'count', place: l.id, ico: '📋',
          title: win.late ? m + ' count was missed' : 'Count the stock today',
          text: win.late ? 'Count everything at ' + l.name + ' now and enter it.'
            : 'It is the end of ' + m + '. Count everything at ' + l.name + ' and enter it.',
          button: 'Start count' });
      });
    }
    if (new Date().getHours() >= 16) {
      places.filter(function (l) { return l.role === 'shop'; }).forEach(function (l) {
        if (Stock.soldOn(mvts, l.id, today())) return;
        out.push({ form: 'sale', place: l.id, ico: '🧾', title: 'Record today\'s sales',
          text: 'No sales entered for ' + l.name + ' today. Enter what you sold before you close.', button: 'Record sales now' });
      });
    }
    return out;
  }

  function myPlaces() {
    return (state.profile && state.profile.places) || [];
  }

  function reminderCards(list) {
    return list.map(function (r) {
      return '<div class="remind" role="alert"><div class="remind-head"><span class="remind-ico" aria-hidden="true">' + r.ico + '</span>' +
        '<b>' + esc(r.title) + '</b></div><p>' + esc(r.text) + '</p>' +
        '<button class="btn" data-form="' + r.form + '" data-place="' + esc(r.place) + '"' + (r.batch ? ' data-batch="' + esc(r.batch) + '"' : '') + '>' +
        esc(r.button) + ' →</button></div>';
    }).join('');
  }

  function renderHome(v) {
    var todo = reminders();
    var firstName = esc(state.profile.name.split(' ')[0]);
    v.innerHTML =
      '<h1>Hello, ' + firstName + '</h1>' +
      reminderCards(todo) +
      '<p class="muted">' + (todo.length ? 'Or record something else:' : 'What are you recording?') + '</p>' +
      '<div class="actions">' +
      Object.keys(TYPES).filter(function (t) { return !TYPES[t].hidden && (t !== 'pack' || packPlaces().length); }).map(function (t) {
        var T = TYPES[t];
        var due = todo.some(function (r) { return r.form === t; });
        return '<button class="action' + (due ? ' due' : '') + '" data-form="' + t + '">' +
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
      : m.type === 'sale' || m.type === 'loss' ? locName(m.from) : locName(m.to);
    var pending = state.queue.some(function (q) { return q.id === m.id; });
    var extra = m.type === 'sale' ? ' · ' + ksh(m.qty * m.price)
      : m.type === 'restock' && m.source === 'bought' ? ' · bought from ' + m.supplier + (m.cost ? ' · ' + ksh(m.qty * m.cost) : '')
      : m.type === 'loss' ? ' · ' + reasonName(m.reason)
      : m.type === 'receive' ? (m.qty < m.sent ? ' · ' + qty(m.sent - m.qty) + ' short of ' + qty(m.sent) : ' · all ' + qty(m.sent) + ' arrived')
      : m.type === 'pack' ? (m.from ? ' · taken for packing' : ' · filled') : '';
    if (m.type === 'pack') where = m.from ? locName(m.from) : locName(m.to);
    if (m.type === 'receive') where = locName(m.from) + ' → ' + locName(m.to);
    return '<li><span class="muted small" style="width:48px">' + esc(niceDate(m.date)) + '</span>' +
      '<span class="grow"><b>' + esc(TYPES[m.type] ? TYPES[m.type].verb : m.type) + ' ' + qty(m.qty) + ' ' + esc(unit) + '</b> ' + esc(name) +
      '<br><span class="muted small">' + esc(where) + extra + ' · ' + esc(m.worker) + (m.note ? ' · “' + esc(m.note) + '”' : '') + '</span></span>' +
      (pending ? '<span class="pill wait">waiting</span>' : '') + '</li>';
  }

  function reasonName(r) {
    var x = LOSS_REASONS.filter(function (l) { return l[0] === r; })[0];
    return x ? x[1].toLowerCase() : 'other';
  }

  function placeLabel(id) {
    var l = locations().filter(function (x) { return x.id === id; })[0];
    return l && l.role === 'farm' ? l.name + ' (market)' : locName(id);
  }

  // ---------- forms ----------
  function locOptions(list, selected) {
    return list.map(function (l) {
      return '<option value="' + esc(l.id) + '"' + (l.id === selected ? ' selected' : '') + '>' + esc(l.name) + '</option>';
    }).join('');
  }

  var LOSS_REASONS = [['spoilt', 'Spoilt / rotten'], ['died', 'Died'], ['broken', 'Broken / damaged'], ['stolen', 'Stolen / missing'], ['other', 'Other']];

  function renderForm(v, type) {
    var T = TYPES[type];
    var f = farm() || {};
    var shopList = shops();
    // Places that sell: the shops, and the farm (its produce goes straight to the market).
    var sellers = locations().filter(function (l) { return l.role === 'shop' || l.role === 'farm'; });
    var isShop = function (id) { return id && shopList.some(function (s) { return s.id === id; }); };
    var isPlace = function (id) { return id && locations().some(function (l) { return l.id === id; }); };
    var myShop = myPlaces().filter(isShop)[0];
    var lastShop = isShop(state.prefs.shop) ? state.prefs.shop : myShop || (shopList[0] || {}).id;
    var lastPlace = isPlace(state.prefs.shop) ? state.prefs.shop : (myPlaces()[0] || lastShop);
    var where = '';
    if (type === 'restock') {
      where = '<label class="field"><span>Where did the stock arrive?</span><select name="to">' + locOptions(locations(), lastPlace) + '</select></label>' +
        '<div class="field"><span>Where did it come from?</span><div class="seg">' +
        '<label><input type="radio" name="source" value="own" checked> 🏡 Our own<small>harvest, workshop, born</small></label>' +
        '<label><input type="radio" name="source" value="bought"> 🛒 Bought<small>from a farmer or supplier</small></label></div></div>' +
        '<label class="field" id="supplier-field" hidden><span>Bought from (name)</span><input type="text" name="supplier" maxlength="100" placeholder="e.g. Mutua, Kibwezi"></label>';
    } else if (type === 'transfer') {
      where = '<div class="row2"><label class="field"><span>From</span><select name="from">' + locOptions(locations(), f.id) + '</select></label>' +
        '<label class="field"><span>To</span><select name="to">' + locOptions(locations(), lastShop) + '</select></label></div>';
    } else if (type === 'sale') {
      var sellAt = sellers.some(function (l) { return l.id === state.prefs.shop; }) ? state.prefs.shop : lastShop;
      where = '<label class="field"><span>Where was it sold?</span><select name="from">' + sellers.map(function (l) {
        return '<option value="' + esc(l.id) + '"' + (l.id === sellAt ? ' selected' : '') + '>' + esc(l.role === 'farm' ? l.name + ' (market)' : l.name) + '</option>';
      }).join('') + '</select></label>';
    } else if (type === 'loss') {
      where = '<label class="field"><span>Where?</span><select name="from">' + locOptions(locations(), lastPlace) + '</select></label>' +
        '<label class="field"><span>What happened?</span><select name="reason"><option value="">Choose…</option>' +
        LOSS_REASONS.map(function (r) { return '<option value="' + r[0] + '">' + r[1] + '</option>'; }).join('') + '</select></label>';
    } else {
      where = '<label class="field"><span>Where are you counting?</span><select name="to">' + locOptions(locations(), lastPlace) + '</select></label>';
    }
    var help = {
      restock: 'Enter how many arrived. Leave the rest empty.',
      transfer: 'Enter how many you are sending. Leave the rest empty.',
      sale: 'Enter how many were sold and the price for one.',
      loss: 'Enter how many were lost. Write what happened in the note.',
      count: 'Count what is physically there and type it in. Type 0 if there are none. Leave empty only items you did not count.',
    }[type];

    var cats = [];
    items().forEach(function (it) { if (cats.indexOf(it.category) < 0) cats.push(it.category); });
    var list = cats.map(function (c) {
      return '<div class="cat" data-cat="' + esc(c) + '">' + esc(c) + '</div>' + items().filter(function (it) { return it.category === c; }).map(function (it) {
        return '<div class="item sale-able" data-item="' + esc(it.id) + '" data-cat="' + esc(c) + '">' +
          '<div><div class="name">' + esc(it.name) + '</div><div class="meta">' + esc(it.unit) + (it.price ? ' · ' + ksh(it.price) : '') +
          '<span class="onhand"></span></div></div>' +
          '<div class="price-box" hidden><label for="p-' + esc(it.id) + '"></label><input id="p-' + esc(it.id) + '" inputmode="decimal" name="price" value="' +
          (it.price ? esc(it.price) : '') + '" placeholder="KSh" data-default="' + (it.price ? esc(it.price) : '') + '"></div>' +
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
      '</div>' +
      '<input type="search" id="filter" placeholder="Find an item…" aria-label="Find an item">' +
      list +
      '<p class="muted" id="none-here" hidden>No items are kept at this place. Ask the manager to add it under "places" in the items tab.</p>' +
      '<label class="field" style="margin-top:16px"><span>Note' + (type === 'loss' ? '' : ' (optional)') + '</span><textarea name="note" maxlength="500" placeholder="' +
      ({ count: 'e.g. 2 jars broken', restock: 'e.g. harvest from apiary 3', loss: 'e.g. rats got into the store' }[type] || '') + '"></textarea></label>' +
      '<div class="err" id="form-err"></div>' +
      '<div class="form-pad"></div>' +
      '<div class="savebar"><button class="btn" type="submit" id="save-btn">Save</button></div>' +
      '</form>';

    var form = $('#mv');
    function bought() { return type === 'restock' && form.source && form.source.value === 'bought'; }
    function sourceLoc() {
      return type === 'sale' || type === 'transfer' || type === 'loss' ? form.from.value : null;
    }
    /** Is the item listed here? It must be kept at the chosen place (for a transfer: at both ends). */
    function allowed(it) {
      if (type === 'transfer') return Stock.kept(it, form.from.value) && Stock.kept(it, form.to.value);
      return Stock.kept(it, type === 'sale' || type === 'loss' ? form.from.value : form.to.value);
    }
    function refresh() {
      var src = sourceLoc();
      var mvts = movements();
      var n = 0;
      var shown = 0;
      var term = ($('#filter').value || '').trim().toLowerCase();
      var priced = type === 'sale' || bought();
      if (type === 'restock') $('#supplier-field').hidden = !bought();
      Array.prototype.forEach.call(form.querySelectorAll('.item'), function (row) {
        var id = row.getAttribute('data-item');
        var it = itemById(id);
        var here = allowed(it);
        row.setAttribute('data-here', here ? '1' : '0');
        row.hidden = !here || (term && row.querySelector('.name').textContent.toLowerCase().indexOf(term) < 0);
        if (!row.hidden) shown++;
        var pb = row.querySelector('.price-box');
        pb.hidden = !priced;
        row.classList.toggle('sale', priced);
        pb.querySelector('label').textContent = type === 'sale' ? 'Price each' : 'Paid each';
        var pIn = pb.querySelector('input');
        if (bought() && pIn.getAttribute('data-mode') !== 'cost') { pIn.value = ''; pIn.setAttribute('data-mode', 'cost'); }
        if (type === 'restock' && !bought() && pIn.getAttribute('data-mode') === 'cost') pIn.setAttribute('data-mode', '');
        var q = row.querySelector('input[name=qty]').value.trim();
        var has = here && q !== '' && (type === 'count' || Number(q) > 0);
        row.classList.toggle('filled', has);
        if (has) n++;
        var oh = row.querySelector('.onhand');
        var warn = row.querySelector('.warn');
        if (src && here) {
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
      Array.prototype.forEach.call(form.querySelectorAll('.cat'), function (h) {
        var c = h.getAttribute('data-cat');
        h.hidden = !Array.prototype.some.call(form.querySelectorAll('.item'), function (r) { return r.getAttribute('data-cat') === c && !r.hidden; });
      });
      $('#none-here').hidden = shown > 0 || !!term;
      $('#save-btn').textContent = n ? 'Save ' + n + ' item' + (n === 1 ? '' : 's') : 'Save';
    }
    form.addEventListener('input', refresh);
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
      var reason = form.reason ? form.reason.value : '';
      if (type === 'loss' && !reason) { err.textContent = 'Choose what happened (spoilt, died, broken…).'; form.reason.focus(); return; }
      var isBought = bought();
      var supplier = isBought ? form.supplier.value.trim() : '';
      if (isBought && !supplier) { err.textContent = 'Type who it was bought from.'; form.supplier.focus(); return; }
      var note = form.note.value.trim();
      var at = new Date().toISOString();
      var batch = uid(); // every line saved together: one delivery, one restock, …
      var out = [];
      var bad = null, noPrice = null;
      Array.prototype.forEach.call(form.querySelectorAll('.item'), function (row) {
        if (row.getAttribute('data-here') !== '1') return; // typed in before the place was changed: not for this place
        var raw = row.querySelector('input[name=qty]').value.trim().replace(',', '.');
        if (raw === '') return;
        var q = Number(raw);
        if (!isFinite(q) || q < 0) { bad = bad || row; return; }
        if (q === 0 && type !== 'count') return;
        var id = row.getAttribute('data-item');
        var price = 0, cost = 0;
        if (type === 'sale' || isBought) {
          var pr = row.querySelector('input[name=price]').value.trim().replace(/,/g, '');
          var pv = Number(pr);
          if (pr === '' || pv === 0) { noPrice = noPrice || row; return; }
          if (!isFinite(pv) || pv < 0) { bad = bad || row; return; }
          if (type === 'sale') price = pv; else cost = pv;
        }
        var m = { id: uid(), date: date, type: type, itemId: id, qty: q,
                  from: type === 'sale' || type === 'transfer' || type === 'loss' ? from : '',
                  to: type === 'sale' || type === 'loss' ? '' : to, price: price, worker: state.profile.name, note: note, at: at, batch: batch };
        if (type === 'restock') {
          m.source = isBought ? 'bought' : 'own';
          if (isBought) { m.supplier = supplier; m.cost = cost; }
        }
        if (type === 'loss') m.reason = reason;
        out.push(m);
      });
      if (bad) {
        err.textContent = 'One of the numbers is not right. Use digits only.';
        bad.scrollIntoView({ block: 'center' });
        return;
      }
      if (noPrice) {
        err.textContent = type === 'sale' ? 'Type the price you sold at, for one.' : 'Type the price you paid, for one.';
        noPrice.scrollIntoView({ block: 'center' });
        noPrice.querySelector('input[name=price]').focus();
        return;
      }
      if (!out.length) { err.textContent = 'Type a number next to at least one item.'; return; }
      var overs = form.querySelectorAll('.item[data-here="1"] .warn:not([hidden])').length;
      if (overs && !window.confirm(overs + ' item' + (overs === 1 ? ' is' : 's are') + ' more than the stock recorded. Save anyway?')) return;

      commit(out);
    });

    function commit(out) {
      var from = form.from ? form.from.value : '';
      var to = form.to ? form.to.value : '';
      state.prefs.shop = type === 'sale' || type === 'loss' ? from : to;
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

  // ---------- packing ----------
  function bulkHoney() {
    return items().filter(function (it) { return it.category === 'Honey' && it.unit === 'kg'; })[0];
  }
  function packPlaces() {
    var bulk = bulkHoney();
    if (!bulk) return [];
    var mine = myPlaces();
    return locations().filter(function (l) { return Stock.kept(bulk, l.id) && (!mine.length || mine.indexOf(l.id) >= 0); });
  }

  function renderPack(v) {
    var bulk = bulkHoney();
    var places = packPlaces();
    if (!bulk || !places.length) { state.view = null; return render(); }
    v.innerHTML =
      '<button class="back" data-act="cancel">‹ Back</button>' +
      '<h1>🍯 Pack honey</h1>' +
      '<form id="mv" novalidate><div class="card">' +
      '<label class="field"><span>Date</span><input type="date" name="date" value="' + today() + '" max="' + today() + '" required></label>' +
      (places.length > 1 ? '<label class="field"><span>Where?</span><select name="place">' + locOptions(places, places[0].id) + '</select></label>'
        : '<input type="hidden" name="place" value="' + esc(places[0].id) + '">') +
      '<label class="field"><span>Bulk honey taken (kg)</span><input inputmode="decimal" name="kg" placeholder="e.g. 20" autocomplete="off"></label>' +
      '<p class="muted small" style="margin:0" id="bulk-left"></p></div>' +
      '<h2>How many did you fill?</h2><div id="pack-list"></div>' +
      '<div class="card" id="pack-sum"></div>' +
      '<label class="field" style="margin-top:16px"><span>Note (optional)</span><textarea name="note" maxlength="500"></textarea></label>' +
      '<div class="err" id="form-err"></div><div class="form-pad"></div>' +
      '<div class="savebar"><button class="btn" type="submit" id="save-btn">Save packing</button></div></form>';
    var form = $('#mv');
    function containers() {
      return items().filter(function (it) { return it.category === 'Honey' && it.kgEach > 0 && it.id !== bulk.id && Stock.kept(it, form.place.value); });
    }
    function drawList() {
      $('#pack-list').innerHTML = containers().map(function (it) {
        return '<div class="item" data-item="' + esc(it.id) + '"><div><div class="name">' + esc(it.name) + '</div><div class="meta">' +
          esc(it.unit) + ' · ' + it.kgEach + ' kg each</div></div><div><label for="q-' + esc(it.id) + '">How many</label>' +
          '<input id="q-' + esc(it.id) + '" inputmode="decimal" name="qty" placeholder="–" autocomplete="off"></div></div>';
      }).join('');
    }
    function numbers() {
      var kg = Number(String(form.kg.value).trim().replace(',', '.'));
      var packed = 0, lines = [], bad = false;
      Array.prototype.forEach.call(form.querySelectorAll('#pack-list .item'), function (row) {
        var raw = row.querySelector('input').value.trim();
        var q = Number(raw);
        row.classList.toggle('filled', raw !== '' && q > 0);
        if (raw === '') return;
        if (!isFinite(q) || q < 0 || Math.floor(q) !== q) { bad = true; return; }
        if (!q) return;
        var it = itemById(row.getAttribute('data-item'));
        packed += q * it.kgEach;
        lines.push({ itemId: it.id, qty: q });
      });
      return { kg: kg, packed: Math.round(packed * 100) / 100, lines: lines, bad: bad };
    }
    function refresh() {
      var n = numbers();
      var onHand = Stock.onHand(movements(), bulk.id, form.place.value);
      $('#bulk-left').textContent = qty(onHand) + ' kg of bulk honey recorded at ' + locName(form.place.value) + '.';
      var left = n.kg - n.packed;
      $('#pack-sum').innerHTML = '<p><b>In jars and bottles:</b> ' + qty(n.packed) + ' kg</p>' +
        (n.kg > 0 ? '<p style="margin:0" class="' + (left < -0.05 * n.kg ? 'err' : '') + '"><b>' + (left >= 0 ? 'Left on equipment / wasted:' : 'More in jars than taken:') +
          '</b> ' + qty(Math.abs(left)) + ' kg' + (n.kg ? ' (' + Math.round(Math.abs(left) / n.kg * 100) + '%)' : '') + '</p>' : '');
    }
    form.addEventListener('change', function (e) { if (e.target.name === 'place') { drawList(); } refresh(); });
    form.addEventListener('input', refresh);
    drawList();
    refresh();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('#form-err');
      var date = form.date.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) { err.textContent = 'Pick a date that is today or earlier.'; return; }
      var n = numbers();
      if (!(n.kg > 0)) { err.textContent = 'Type how many kg of bulk honey you took.'; form.kg.focus(); return; }
      if (n.bad) { err.textContent = 'Type whole numbers of jars and bottles.'; return; }
      if (!n.lines.length) { err.textContent = 'Type how many jars or bottles you filled.'; return; }
      // Small differences happen (honey stays on the equipment); more honey in the jars than was taken is a mistake.
      if (n.packed > n.kg * 1.05) { err.textContent = 'The jars hold ' + qty(n.packed) + ' kg but you took only ' + qty(n.kg) + ' kg. Check the numbers.'; return; }
      if (n.kg - n.packed > n.kg * 0.1 && !window.confirm(qty(n.kg - n.packed) + ' kg is not in jars. Is that right?')) return;
      var place = form.place.value;
      var onHand = Stock.onHand(movements(), bulk.id, place);
      if (n.kg > onHand && !window.confirm('Only ' + qty(onHand) + ' kg of bulk honey is recorded at ' + locName(place) + '. Save anyway?')) return;
      var batch = uid(), at = new Date().toISOString(), note = form.note.value.trim();
      var base = { date: date, type: 'pack', price: 0, worker: state.profile.name, note: note, at: at, batch: batch };
      var out = [Object.assign({ id: uid(), itemId: bulk.id, qty: n.kg, from: place, to: '' }, base)].concat(n.lines.map(function (l) {
        return Object.assign({ id: uid(), itemId: l.itemId, qty: l.qty, from: '', to: place }, base);
      }));
      saveLines('pack', out, place);
    });
  }

  // ---------- confirming a delivery ----------
  function renderReceive(v) {
    var key = state.receiving || {};
    var d = Stock.pendingDeliveries(movements(), [], today(), 30).filter(function (x) { return x.batch === key.batch && x.to === key.to; })[0];
    if (!d) { state.view = null; return render(); }
    v.innerHTML =
      '<button class="back" data-act="cancel">‹ Back</button>' +
      '<h1>📥 Delivery from ' + esc(locName(d.from)) + '</h1>' +
      '<p class="muted">Sent to ' + esc(locName(d.to)) + ' by ' + esc(d.worker) + ' on ' + esc(niceDate(d.date)) + '. Count what arrived. ' +
      'If something is missing or broken, change the number.</p>' +
      '<form id="mv" novalidate>' +
      d.lines.map(function (l, i) {
        var it = itemById(l.itemId) || { name: l.itemId, unit: '' };
        return '<div class="item sale" data-i="' + i + '"><div><div class="name">' + esc(it.name) + '</div><div class="meta">' + esc(it.unit) + '</div></div>' +
          '<div><label>Sent</label><div class="num" style="padding:12px 8px;font-weight:700">' + qty(l.qty) + '</div></div>' +
          '<div><label for="r-' + i + '">Arrived</label><input id="r-' + i + '" inputmode="decimal" name="qty" value="' + l.qty + '" autocomplete="off"></div>' +
          '<div class="warn" hidden></div></div>';
      }).join('') +
      '<label class="field" style="margin-top:16px"><span>Note (optional)</span><textarea name="note" maxlength="500" placeholder="e.g. 2 jars broken in the box"></textarea></label>' +
      '<div class="err" id="form-err"></div><div class="form-pad"></div>' +
      '<div class="savebar"><button class="btn" type="submit" id="save-btn">Confirm delivery</button></div></form>';
    var form = $('#mv');
    function check() {
      Array.prototype.forEach.call(form.querySelectorAll('.item'), function (row) {
        var l = d.lines[Number(row.getAttribute('data-i'))];
        var got = Number(row.querySelector('input').value);
        var w = row.querySelector('.warn');
        w.hidden = !(isFinite(got) && got !== l.qty);
        w.textContent = got < l.qty ? qty(l.qty - got) + ' missing' : got > l.qty ? qty(got - l.qty) + ' more than sent' : '';
        row.classList.toggle('filled', !w.hidden);
      });
    }
    form.addEventListener('input', check);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('#form-err'), out = [], bad = false, short = 0;
      var at = new Date().toISOString(), note = form.note.value.trim();
      Array.prototype.forEach.call(form.querySelectorAll('.item'), function (row) {
        var l = d.lines[Number(row.getAttribute('data-i'))];
        var raw = row.querySelector('input').value.trim().replace(',', '.');
        var got = Number(raw);
        if (raw === '' || !isFinite(got) || got < 0) { bad = true; return; }
        if (got < l.qty) short += l.qty - got;
        out.push({ id: uid(), date: today(), type: 'receive', itemId: l.itemId, qty: got, sent: l.qty, from: d.from, to: d.to, price: 0,
                   worker: state.profile.name, note: note, at: at, batch: d.batch });
      });
      if (bad) { err.textContent = 'Type how many arrived for every item (0 if none).'; return; }
      if (short && !window.confirm(qty(short) + ' fewer than were sent. ' + d.worker + ' and the manager will see this. Confirm?')) return;
      saveLines('receive', out, d.to);
    });
  }

  /** Queue the lines, show the Saved screen and send. */
  function saveLines(type, out, place) {
    state.prefs.shop = place;
    save('prefs', state.prefs);
    state.queue = state.queue.concat(out);
    save('queue', state.queue);
    state.lastSaved = { type: type, count: out.length, amount: 0 };
    state.view = 'done';
    render();
    window.scrollTo(0, 0);
    sync();
  }

  function renderDone(v) {
    var s = state.lastSaved || { count: 0 };
    var T = TYPES[s.type] || TYPES.restock;
    var waiting = !DEMO && state.queue.length;
    v.innerHTML = '<div class="done"><div class="big">✅</div><h1>Saved</h1>' +
      '<p>' + T.verb + ': ' + s.count + ' item' + (s.count === 1 ? '' : 's') + (s.type === 'sale' ? ' · ' + ksh(s.amount) : '') + '</p>' +
      '<p class="muted">' + (DEMO ? 'Saved on this phone (demo).' : waiting ? 'Saved on this phone. It will be sent to the sheet when there is signal.' : 'Sent to the stock sheet.') + '</p>' +
      '<div class="btn-row">' + (s.type === 'receive' ? '' : '<button class="btn" data-form="' + esc(s.type) + '">Record more ' + esc(T.title.toLowerCase()) + '</button>') +
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

    var byShop = s.salesByShop.length ? '<h2>This month by place</h2><div class="table-wrap"><table><thead><tr><th>Where</th><th class="num">Units</th><th class="num">Sales</th></tr></thead><tbody>' +
      s.salesByShop.map(function (b) {
        return '<tr><td>' + esc(placeLabel(b.location)) + '</td><td class="num">' + qty(b.units) + '</td><td class="num">' + ksh(b.amount) + '</td></tr>';
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

    // The latest month-end window that has started: this month's from the 3rd-last day, otherwise last month's.
    var win = Stock.countWindow(today());
    if (!win) {
      var d = new Date(today() + 'T00:00:00');
      d.setDate(0); // last day of the previous month
      win = Stock.countWindow(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
      win.late = true;
      win.closed = true;
    }
    var winMonth = monthName(win.month, true).split(' ')[0];
    var counts = '<h2>Month-end count (' + esc(winMonth) + ')</h2><ul class="list">' + locs.map(function (l) {
      var last = s.lastCount[l.id];
      var done = Stock.countedSince(movements(), l.id, win.start);
      var pill = done ? '<span class="pill ok">✓ Done</span>'
        : win.closed ? '<span class="pill bad">✗ Missed</span>' : '<span class="pill warn">⚠ ' + (win.late ? 'Late' : 'Due') + '</span>';
      return '<li><span class="grow"><b>' + esc(l.name) + '</b><br><span class="muted small">' +
        (last ? 'Last counted ' + esc(niceDate(last)) : 'Never counted') + '</span></span>' + pill + '</li>';
    }).join('') + '</ul>';

    var adj = s.adjustments.filter(function (a) { return a.movement.date.slice(0, 7) === ym && a.delta !== 0; });
    var adjHtml = adj.length ? '<h2>Count differences this month</h2><p class="muted small">Shelf count minus what the records said. Minus means stock went missing.</p>' +
      '<div class="table-wrap"><table><thead><tr><th>Item</th><th>Where</th><th class="num">Records</th><th class="num">Counted</th><th class="num">Diff</th></tr></thead><tbody>' +
      adj.map(function (a) {
        var it = itemById(a.movement.itemId);
        return '<tr><td>' + esc(it ? it.name : a.movement.itemId) + '</td><td>' + esc(locName(a.movement.to)) + '</td><td class="num">' + qty(a.before) +
          '</td><td class="num">' + qty(a.after) + '</td><td class="num' + (a.delta < 0 ? ' neg' : '') + '">' + (a.delta > 0 ? '+' : '') + qty(a.delta) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '';

    var inHtml = s.month.own || s.month.bought ? '<h2>New stock in ' + esc(monthName(ym)) + '</h2><div class="tiles">' +
      tile('Our own', qty(s.month.own) + ' units', 'Harvested, made or born') +
      tile('Bought', qty(s.month.bought) + ' units', 'Paid ' + ksh(s.month.spent)) + '</div>' : '';
    var lossHtml = s.losses.length ? '<h2>Losses in ' + esc(monthName(ym)) + '</h2><ul class="list">' + s.losses.map(function (l) {
      var it = itemById(l.itemId);
      return '<li><span class="grow">' + esc(it ? it.name : l.itemId) + '<br><span class="muted small">' + esc(reasonName(l.reason)) + '</span></span>' +
        '<span class="num">' + qty(l.qty) + ' ' + esc(it ? it.unit : '') + '</span>' + (l.value ? '<span class="num muted small" style="min-width:84px">' + ksh(l.value) + '</span>' : '') + '</li>';
    }).join('') + '</ul>' : '';
    // Honey flow this month: where every jar went, per place, and the totals in kg.
    var honeyIds = allItems().filter(function (it) { return it.category === 'Honey'; }).map(function (it) { return it.id; });
    var flowRows = Stock.flow(movements(), honeyIds, locs.map(function (l) { return l.id; }), ym + '-01', today())
      .filter(function (r) { return r.start || r.in || r.out || r.sold || r.lost || r.countDiff || r.end; });
    var signed = function (n) { return (n > 0 ? '+' : '') + qty(n); };
    var flowHtml = flowRows.length ? '<h2>Honey flow in ' + esc(monthName(ym)) + '</h2>' +
      '<p class="muted small">Start + In − Out − Sold − Lost ± Count (±) = Now. In: harvested, bought, packed or delivered. ' +
      'Out: sent away or used for packing. Lost: losses and deliveries that arrived short. ' +
      'In the kg totals packing only changes the container, so honey left on the equipment shows as Lost.</p>' +
      locs.filter(function (l) { return flowRows.some(function (r) { return r.place === l.id; }); }).map(function (l) {
        var rs = flowRows.filter(function (r) { return r.place === l.id; });
        var tk = Stock.flowKg(rs, function (id) { return (itemById(id) || {}).kgEach; });
        var kg = function (f) { return qty(Math.round(tk[f] * 10) / 10); };
        return '<div class="table-wrap" style="margin-bottom:10px"><table class="flow"><thead><tr><th>' + esc(l.name) + '</th><th class="num">Start</th><th class="num">In</th>' +
          '<th class="num">Out</th><th class="num">Sold</th><th class="num">Lost</th><th class="num">±</th><th class="num">Now</th></tr></thead><tbody>' +
          rs.map(function (r) {
            var it = itemById(r.itemId) || { name: r.itemId };
            var short = it.name.replace(/^Raw (Organic )?[Hh]oney — /, '').replace(/^bulk \(per kg\)$/, 'Bulk kg').replace(/ Squeeze Bottle$/, ' bottle');
            return '<tr><td>' + esc(short) + '</td><td class="num">' + qty(r.start) + '</td><td class="num">' + qty(r.in) +
              '</td><td class="num">' + qty(r.out) + '</td><td class="num">' + qty(r.sold) + '</td><td class="num' + (r.lost > 0 ? ' low' : '') + '">' + qty(r.lost) +
              '</td><td class="num' + (r.countDiff < 0 ? ' neg' : '') + '">' + signed(r.countDiff) + '</td><td class="num"><b>' + qty(r.end) + '</b></td></tr>';
          }).join('') +
          '<tr><td><b>Total kg</b></td><td class="num">' + kg('start') + '</td><td class="num">' + kg('in') + '</td><td class="num">' + kg('out') +
          '</td><td class="num">' + kg('sold') + '</td><td class="num">' + kg('lost') + '</td><td class="num">' + kg('countDiff') + '</td><td class="num"><b>' + kg('end') + '</b></td></tr>' +
          '</tbody></table></div>';
      }).join('') : '';
    var waiting = Stock.pendingDeliveries(movements(), [], today());
    var waitHtml = waiting.length ? '<h2>Deliveries not confirmed yet</h2><ul class="list">' + waiting.map(function (d) {
      var n = d.lines.reduce(function (t, x) { return t + x.qty; }, 0);
      return '<li><span class="grow"><b>' + esc(locName(d.from)) + ' → ' + esc(locName(d.to)) + '</b><br><span class="muted small">' +
        esc(niceDate(d.date)) + ' · ' + qty(n) + ' items · sent by ' + esc(d.worker) + '</span></span><span class="pill warn">⏳ Waiting</span></li>';
    }).join('') + '</ul>' : '';
    var table = '<h2>Stock now</h2><div class="table-wrap"><table><thead><tr><th>Item</th>' +
      locs.map(function (l) { return '<th class="num">' + esc(l.name.replace(/ Shop$/, '')) + '</th>'; }).join('') +
      '<th class="num">Total</th></tr></thead><tbody>' +
      s.stock.filter(function (x) { return x.item.active !== false || x.total !== 0; }).map(function (x) {
        return '<tr><td>' + esc(x.item.name) + '<br><span class="muted small">' + esc(x.item.unit) + '</span></td>' +
          locs.map(function (l) {
            var q = x.per[l.id];
            if (!Stock.kept(x.item, l.id) && !q) return '<td class="num muted">–</td>';
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
      tiles + low + chart + byShop + inHtml + flowHtml + waitHtml + lossHtml + counts + adjHtml + table + top + recent;
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
          var why = m.reason === 'invalid' ? 'item or place no longer exists' : 'refused';
          return movementLi(m).replace('</span></span>', ' · <b>' + esc(why) + '</b></span></span>');
        }).join('') + '</ul>' +
        '<div class="btn-row"><button class="btn secondary" data-act="clear-rejected">Clear this list</button></div>' : '') +
      '<div class="btn-row">' +
      (DEMO ? '<button class="btn secondary" data-act="reset-demo">Reset demo data</button>' : '') +
      '<button class="btn secondary" data-act="signout">Sign out</button></div>' +
      '<p class="muted small" style="margin-top:16px">App version ' + APP_VERSION + '.</p>' +
      '<p class="muted small">Tip: add this app to your home screen. On Android open the browser menu (⋮) and tap “Add to Home screen”. It works with no signal; entries are sent when signal comes back.</p>';
  }

  // ---------- events ----------
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-form],[data-act],[data-tab]');
    if (!t) return;
    var form = t.getAttribute('data-form');
    var act = t.getAttribute('data-act');
    var tab = t.getAttribute('data-tab');
    if (form) {
      var place = t.getAttribute('data-place');
      if (place) {
        state.prefs.shop = place;
        save('prefs', state.prefs);
      }
      state.receiving = form === 'receive' ? { batch: t.getAttribute('data-batch'), to: place } : null;
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
    } else if (act === 'reload') {
      location.reload();
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
    // When a new version has been downloaded, switch to it: straight away, or after the form being filled is saved.
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || state.updateReady) return;
      state.updateReady = true;
      if (!state.view || state.view === 'done') location.reload();
      else paintBanner();
    });
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      document.addEventListener('visibilitychange', function () { if (!document.hidden) reg.update().catch(function () {}); });
    }).catch(function () {});
  }

  render();
  sync();
})();
