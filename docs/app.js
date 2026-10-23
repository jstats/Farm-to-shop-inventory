/**
 * Beelove Stock: the phone app workers use to record stock movements, plus the dashboard.
 *
 * Works offline: every entry is saved on the phone first (the queue), then sent to the Google Sheet
 * when there is signal. The dashboard is worked out on the phone from the sheet's movements plus
 * anything still waiting in the queue, so a worker always sees their own entries.
 */
(function () {
  var APP_VERSION = 19; // keep equal to VERSION in sw.js (a test checks)
  var CFG = window.BEELOVE_CONFIG || {};
  var DEMO = !CFG.apiUrl;
  var KEY = DEMO ? 'beelove-stock-demo:' : 'beelove-stock:';

  // ---------- language ----------
  // The English text is the key; docs/i18n.js holds the other languages. Text with no translation shows in English.
  // A test checks that every t(), tn() and N() text has a translation with the same {placeholders}.
  var I18N = window.BEELOVE_I18N || { langs: [['en', 'English']] };
  var LANG = (function () {
    var ok = function (c) { return I18N.langs.some(function (l) { return l[0] === c; }); };
    try {
      var saved = JSON.parse(localStorage.getItem('beelove-stock-lang') || 'null');
      if (ok(saved)) return saved;
    } catch (e) { /* no storage: use the phone's language */ }
    var phone = String(navigator.language || 'en').slice(0, 2).toLowerCase();
    return ok(phone) ? phone : 'en';
  })();
  function setLang(c) {
    LANG = c;
    try { localStorage.setItem('beelove-stock-lang', JSON.stringify(c)); } catch (e) { /* kept for this visit only */ }
    document.documentElement.lang = c;
  }
  /** Marks English text for translation where it is written down (lists, tables); t() translates it where it is shown. */
  function N(s) { return s; }
  /** The text in the chosen language, with {name} placeholders filled in (values are not escaped). */
  function t(s, v) {
    var x = (LANG !== 'en' && I18N[LANG] && I18N[LANG][s]) || s;
    return v ? x.replace(/\{(\w+)\}/g, function (m, k) { return k in v ? v[k] : m; }) : x;
  }
  /** One or many: {n} is the number. French uses the singular for 0 and 1. */
  function tn(n, one, many, v) {
    return t((LANG === 'fr' ? Math.abs(n) < 2 : n === 1) ? one : many, Object.assign({ n: qty(n) }, v || {}));
  }
  /** Item, category, unit and place names: from the language file by id, or as written in the sheet. */
  function tr(group, id, fallback) {
    var g = LANG !== 'en' && I18N[LANG + '_' + group];
    return (g && g[id]) || fallback;
  }
  function locale() { return LANG === 'fr' ? 'fr-FR' : 'en-KE'; }
  document.documentElement.lang = LANG;

  var TYPES = {
    restock: { title: N('New stock in'), ico: '📦', hint: N('Only stock that just arrived: harvest, workshop, supplier, born'), verb: N('New stock') },
    transfer: { title: N('Send stock'), ico: '🚚', hint: N('Move stock from one place to another'), verb: N('Sent') },
    sale: { title: N('Record sales'), ico: '🧾', hint: N('What a shop or the market sold'), verb: N('Sold') },
    loss: { title: N('Record loss'), ico: '⚠️', hint: N('Spoilt, died, broken or stolen'), verb: N('Lost') },
    pack: { title: N('Pack honey'), ico: '🍯', hint: N('Fill jars and bottles from bulk honey'), verb: N('Packed') },
    receive: { title: N('Delivery arrived'), ico: '📥', hint: N('Check what arrived'), verb: N('Received'), hidden: true },
    count: { title: N('Stock count'), ico: '📋', hint: N('What is on the shelf now: the opening and month-end count'), verb: N('Counted') },
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
  /** Returns false if the phone would not store it (private mode, storage full): the app keeps going in memory. */
  function save(k, v) {
    try {
      localStorage.setItem(KEY + k, JSON.stringify(v));
      return true;
    } catch (e) {
      return false;
    }
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
    storageError: false, // the phone refused to store the queue: entries are only in memory until sent
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
    return d.toLocaleDateString(locale(), long ? { month: 'long', year: 'numeric' } : { month: 'short' });
  }
  /** Month for a chart bar: 3 letters (4 in French, so juin and juil. differ). */
  function monthShort(ym) {
    return monthName(ym).replace('.', '').slice(0, LANG === 'fr' ? 4 : 3);
  }
  function niceDate(d) {
    return new Date(d + 'T00:00:00').toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  }

  function items() { return ((state.data && state.data.items) || []).filter(function (i) { return i.active !== false; }); }
  function allItems() { return (state.data && state.data.items) || []; }
  function locations() { return (state.data && state.data.locations) || []; }
  function shops() { return locations().filter(function (l) { return l.role === 'shop'; }); }
  function farm() { return locations().filter(function (l) { return l.role === 'farm'; })[0] || locations()[0]; }
  function locName(id) {
    var l = locations().filter(function (x) { return x.id === id; })[0];
    return l ? tr('places', l.id, l.name) : id;
  }
  function itemById(id) { return allItems().filter(function (i) { return i.id === id; })[0]; }
  function itemName(it) { return it ? tr('items', it.id, it.name || it.id) : ''; }
  function unitName(u) { return tr('units', u, u || ''); }
  /** The unit after a number: "3 flacons" in French; English keeps the sheet's word as before. */
  function unitFor(n, u) { return LANG === 'fr' && Math.abs(n) >= 2 ? tr('units_many', u, unitName(u)) : unitName(u); }
  /** "jars", "bottles": the unit for more than one. */
  function unitsName(u) { return LANG === 'en' ? u + 's' : tr('units_many', u, unitName(u)); }
  function catName(c) { return tr('cats', c, c); }

  // ---------- product pictures ----------
  // Small photos of our own products (from beelovefarm.org), stored with the app so they work offline.
  // Items with no photo show a sign for their group instead.
  var PHOTOS = ['ktbh-hive', 'langstroth-hive', 'modern-log-hive', 'log-hive', 'swarm-catcher', 'bee-suit', 'bee-gloves', 'bee-smoker',
    'hive-tool', 'frame-grip', 'bee-brush', 'bee-attractant', 'queen-excluder', 'propolis-mat', 'honey-extractor', 'refractometer',
    'honey-strainer', 'cone-strainer', 'uncapping-fork', 'honey-bucket', 'honey-150g', 'honey-300g', 'honey-500g', 'honey-1kg',
    'honey-bulk', 'tilapia-fingerling', 'catfish-fingerling', 'tilapia', 'catfish'];
  var CAT_SIGN = { Hives: '🐝', Protection: '🧤', Tools: '🔧', Processing: '⚙️', Honey: '🍯', Packaging: '🫙',
    'Farm produce': '🍌', Livestock: '🐑', Fish: '🐟' };
  function thumb(it, small) {
    var cls = 'thumb' + (small ? ' sm' : '');
    if (it && PHOTOS.indexOf(it.id) >= 0) {
      return '<span class="' + cls + '"><img src="img/items/' + esc(it.id) + '.webp" alt="" loading="lazy" decoding="async" ' +
        'onerror="this.parentNode.textContent=\'' + (CAT_SIGN[it.category] || '📦') + '\'"></span>';
    }
    return '<span class="' + cls + ' sign" aria-hidden="true">' + ((it && CAT_SIGN[it.category]) || '📦') + '</span>';
  }

  /** Sheet movements plus the queue (the queue wins on the same id), rejected entries included. */
  function allMovements() {
    var byId = {};
    var out = [];
    state.queue.forEach(function (m) { byId[m.id] = true; out.push(m); });
    ((state.data && state.data.movements) || []).forEach(function (m) { if (!byId[m.id]) out.push(m); });
    return out;
  }
  /** The movements that count: rejected entries are left out of every figure. */
  function movements() {
    return Stock.withoutRejected(allMovements(), rejections());
  }
  function rejections() { return (state.data && state.data.rejections) || []; }

  // ---------- whose entries ----------
  function sameName(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
  /**
   * Entries go to the sheet under the name of the person who made them. After someone else signs in on the same phone,
   * the first person's waiting entries stay here until they (or a manager) sign in, so they are never sent as someone else's.
   */
  function mayGoNow(m) { return isManager() || !m.worker || sameName(m.worker, state.profile.name); }
  function othersWaiting() {
    return state.profile ? state.queue.filter(function (m) { return !mayGoNow(m); }) : [];
  }
  function myWaiting() {
    return state.profile ? state.queue.filter(mayGoNow) : [];
  }
  function saveQueue() {
    state.storageError = !save('queue', state.queue);
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
    if (code === 'wrong_pin') return t('Name or PIN is not right.');
    if (code === 'locked') return t('Too many wrong PINs. Wait 15 minutes and try again.');
    if (code === 'not_allowed') return t('Only a manager can do this.');
    if (code === 'reason_needed') return t('Write why, so others understand.');
    if (code === 'update_backend') return t('The stock sheet needs its script updated before entries can be rejected.');
    if (code === 'not_found') return t('That entry is not in the sheet yet. Try again when it has been sent.');
    return t('Something went wrong ({code}).', { code: code });
  }

  function demoData() {
    return { items: Seed.items(), locations: Seed.locations(), movements: Seed.demoMovements(today()), rejections: [], fetchedAt: new Date().toISOString() };
  }

  /** Sends the queue, then pulls the latest from the sheet. Quiet on failure: entries stay queued. */
  function sync() {
    if (!state.profile) return Promise.resolve();
    if (DEMO) {
      state.data.movements = allMovements();
      state.queue = [];
      save('data', state.data);
      save('queue', state.queue);
      render();
      return Promise.resolve();
    }
    if (state.syncing) return Promise.resolve();
    state.syncing = true;
    paintSync();
    var sending = state.queue.filter(mayGoNow);
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
      saveQueue();
      return api({ action: 'data' });
    }).then(function (res) {
      if (!res.ok) throw res;
      state.data = { items: res.items, locations: res.locations, movements: res.movements, rejections: res.rejections || [],
                     fetchedAt: new Date().toISOString() };
      save('data', state.data);
      if (state.profile.role !== (res.role || '') || JSON.stringify(state.profile.places) !== JSON.stringify(res.places || [])) {
        state.profile.role = res.role || '';
        state.profile.places = res.places || [];
        save('profile', state.profile);
      }
      state.authError = false;
      state.lastError = '';
    }).catch(function (err) {
      if (err && (err.error === 'wrong_pin' || err.error === 'locked')) state.authError = true;
      state.lastError = err && err.error ? errorText(err.error) : t('No connection. Entries are safe on this phone.');
    }).then(function () {
      state.syncing = false;
      render();
    });
  }

  // ---------- chrome: sync status, banners, tabs ----------
  function paintSync() {
    var el = $('#sync');
    if (!state.profile) { el.textContent = ''; return; }
    if (DEMO) { el.textContent = t('Demo'); return; }
    if (state.syncing) el.textContent = t('Sending…');
    else if (myWaiting().length) el.textContent = tn(myWaiting().length, '{n} waiting for signal', '{n} waiting for signal');
    else el.textContent = t('All sent ✓');
  }

  function paintBanner() {
    var html = '';
    if (state.updateReady) {
      html += '<div class="banner info">' + t('A new version of the app is ready. Finish what you are doing, then <button data-act="reload">update now</button>.') + '</div>';
    }
    var todo = state.profile && state.tab !== 'home' && !state.view ? reminders() : [];
    if (todo.length) {
      html += '<div class="banner remind-strip" role="alert">🔔 ' + esc(todo[0].title) +
        (todo.length > 1 ? ' ' + t('(+{n} more)', { n: todo.length - 1 }) : '') + ' · <button data-act="home">' + t('Do it now') + '</button></div>';
    }
    if (DEMO && state.profile) {
      html += '<div class="banner info">' + t('Demo mode: sample data, saved only on this phone. Connect the Google Sheet in config.js to go live.') + '</div>';
    }
    if (state.authError) {
      html += '<div class="banner bad">' + t('Your name or PIN no longer works, so entries are not being sent.') + ' ' +
        '<button data-act="resign">' + t('Sign in again') + '</button></div>';
    }
    if (state.storageError && state.queue.length) {
      html += '<div class="banner bad">⚠️ ' + t('This phone did not store your entries (storage full or private browsing). Keep the app open until they are sent, or free some space on the phone.') + '</div>';
    }
    var others = othersWaiting();
    if (others.length) {
      var names = others.map(function (m) { return m.worker; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
      html += '<div class="banner info">' + tn(others.length, '{n} entry by {names} waits on this phone.', '{n} entries by {names} wait on this phone.', { names: esc(names.join(', ')) }) + ' ' +
        (names.length === 1 ? t('They are sent when {name} or a manager signs in here.', { name: esc(names[0].split(' ')[0]) })
          : t('They are sent when they or a manager signs in here.')) + '</div>';
    }
    if (state.rejected.length) {
      html += '<div class="banner bad">' + tn(state.rejected.length, '{n} entry was refused by the sheet. See Me.', '{n} entries were refused by the sheet. See Me.') + '</div>';
    }
    $('#banner').innerHTML = html;
  }

  function isManager() {
    return DEMO || (state.profile && state.profile.role === 'manager');
  }

  function paintTabs() {
    var nav = $('#tabs');
    nav.hidden = !state.profile;
    // Only managers have a dashboard; everyone else sees Record and Me.
    var dash = nav.querySelector('[data-tab=dashboard]');
    dash.hidden = !isManager();
    nav.style.gridTemplateColumns = 'repeat(' + (isManager() ? 3 : 2) + ', 1fr)';
    var labels = { home: N('Record'), dashboard: N('Dashboard'), me: N('Me') };
    Array.prototype.forEach.call(nav.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === state.tab);
      b.textContent = t(labels[b.getAttribute('data-tab')]);
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
    if (state.tab === 'dashboard' && isManager()) return renderDashboard(v);
    if (state.tab === 'dashboard') state.tab = 'home';
    if (state.tab === 'me') return renderMe(v);
    return renderHome(v);
  }

  // ---------- sign in ----------
  /** English · Français: shown on Sign in and Me. Each language is written in its own words, so anyone can find theirs. */
  function langSwitch() {
    if (I18N.langs.length < 2) return '';
    return '<div class="lang" role="group" aria-label="Language · Langue"><span aria-hidden="true">🌐</span>' + I18N.langs.map(function (l) {
      return '<button type="button" class="lang-btn" data-act="lang" data-lang="' + l[0] + '" lang="' + l[0] + '" aria-pressed="' + (l[0] === LANG) + '">' +
        esc(l[1]) + '</button>';
    }).join('') + '</div>';
  }

  function renderSignIn(v) {
    v.innerHTML =
      langSwitch() +
      '<h1>' + t('Sign in') + '</h1>' +
      '<p class="muted">' + t('Your name goes on every entry you make, so we can tell who did what.') + '</p>' +
      (DEMO ? '<p class="banner info" style="margin:12px 0;width:100%">' + t('Demo mode: any name and PIN work.') + '</p>' : '') +
      '<form id="signin" class="card" autocomplete="on">' +
      '<label class="field"><span>' + t('Your name') + '</span><input type="text" name="name" autocomplete="username" required value="' +
      esc((state.profile && state.profile.name) || load('lastName', '')) + '"></label>' +
      '<label class="field"><span>' + t('PIN') + '</span><input type="password" name="pin" inputmode="numeric" autocomplete="current-password" required></label>' +
      '<div class="err" id="signin-err"></div>' +
      '<button class="btn" type="submit">' + t('Sign in') + '</button>' +
      '</form>' +
      '<p class="muted small">' + t('No PIN yet? Ask the manager to add you in the "workers" tab of the stock sheet.') + '</p>';
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
      btn.textContent = t('Checking…');
      state.profile = { name: name, pin: pin };
      api({ action: 'data' }).then(function (res) {
        if (!res.ok) throw res;
        state.profile.name = res.worker; // as spelled in the sheet
        state.profile.places = res.places || [];
        state.profile.role = res.role || '';
        state.data = { items: res.items, locations: res.locations, movements: res.movements, rejections: res.rejections || [],
                       fetchedAt: new Date().toISOString() };
        save('data', state.data);
        afterSignIn();
      }).catch(function (x) {
        state.profile = null;
        err.textContent = x && x.error ? errorText(x.error) : t('No connection. You need signal the first time you sign in.');
        btn.disabled = false;
        btn.textContent = t('Sign in');
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
      var n = d.lines.reduce(function (s, x) { return s + x.qty; }, 0);
      out.push({ form: 'receive', place: d.to, batch: d.batch, ico: '📥', title: t('Delivery from {place}', { place: locName(d.from) }),
        text: tn(n, '{who} sent {n} item to {place} on {date}.', '{who} sent {n} items to {place} on {date}.',
            { who: d.worker, place: locName(d.to), date: niceDate(d.date) }) +
          (d.age >= 2 ? ' ' + t('({days} days ago)', { days: d.age }) : '') + ' ' + t('Check what arrived and confirm.'), button: t('Check delivery') });
    });
    var win = Stock.countWindow(today());
    if (win) {
      places.forEach(function (l) {
        var missing = Stock.countMissing(mvts, items(), l.id, win.start);
        if (!missing.length) return;
        var started = Stock.countedSince(mvts, l.id, win.start);
        var m = monthName(win.month, true).split(' ')[0];
        var here = locName(l.id);
        out.push({ form: 'count', place: l.id, ico: '📋',
          title: win.late ? t('{month} count was missed', { month: m }) : t('Count the stock today'),
          text: started ? tn(missing.length, '{n} item has no number yet at {place} (for example {item}).', '{n} items have no number yet at {place} (for example {item}).',
                { place: here, item: itemName(missing[0]) }) + ' ' + t('Type 0 for items that are not there.')
            : win.late ? t('Count everything at {place} now and enter it.', { place: here })
            : t('It is the end of {month}. Count everything at {place} and enter it.', { month: m, place: here }),
          button: t('Start count') });
      });
    }
    if (new Date().getHours() >= 16) {
      places.filter(function (l) { return l.role === 'shop'; }).forEach(function (l) {
        if (Stock.soldOn(mvts, l.id, today())) return;
        out.push({ form: 'sale', place: l.id, ico: '🧾', title: t('Record today\'s sales'),
          text: t('No sales entered for {place} today. Enter what you sold before you close.', { place: locName(l.id) }), button: t('Record sales now') });
      });
    }
    return out;
  }

  function myPlaces() {
    return (state.profile && state.profile.places) || [];
  }
  /** A place that is not one of the worker's own (managers and workers with no place set: never). */
  function notMine(id) {
    var mine = myPlaces();
    return !!id && !isManager() && mine.length > 0 && mine.indexOf(id) < 0;
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
      '<h1>' + t('Hello, {name}', { name: firstName }) + '</h1>' +
      reminderCards(todo) +
      '<p class="muted">' + (todo.length ? t('Or record something else:') : t('What are you recording?')) + '</p>' +
      '<div class="actions">' +
      Object.keys(TYPES).filter(function (k) { return !TYPES[k].hidden && (k !== 'pack' || packPlaces().length); }).map(function (k) {
        var T = TYPES[k];
        var due = todo.some(function (r) { return r.form === k; });
        return '<button class="action' + (due ? ' due' : '') + '" data-form="' + k + '">' +
          '<span class="ico" aria-hidden="true">' + T.ico + '</span><b>' + t(T.title) + '</b><span>' + t(T.hint) + '</span></button>';
      }).join('') +
      '</div>' +
      recentMine();
  }

  function recentMine() {
    var mine = Stock.sortMovements(allMovements().filter(function (m) { return m.worker === state.profile.name; })).reverse().slice(0, 6);
    if (!mine.length) return '';
    var gone = Stock.rejectedKeys(rejections());
    return '<h2>' + t('Your latest entries') + '</h2><ul class="list">' + mine.map(function (m) { return movementLi(m, gone[Stock.entryKey(m)]); }).join('') + '</ul>';
  }

  function verb(type) { return TYPES[type] ? t(TYPES[type].verb) : type; }

  function movementLi(m, rejected) {
    var it = itemById(m.itemId);
    var name = it ? itemName(it) : m.itemId;
    var unit = it ? unitFor(m.qty, it.unit) : '';
    var where = m.type === 'transfer' ? locName(m.from) + ' → ' + locName(m.to)
      : m.type === 'sale' || m.type === 'loss' ? locName(m.from) : locName(m.to);
    var pending = state.queue.some(function (q) { return q.id === m.id; });
    var extra = m.type === 'sale' ? ' · ' + ksh(m.qty * m.price)
      : m.type === 'restock' && m.source === 'bought' ? ' · ' + esc(t('bought from {farmer}', { farmer: m.supplier })) + (m.cost ? ' · ' + ksh(m.qty * m.cost) : '')
      : m.type === 'loss' ? ' · ' + esc(reasonName(m.reason))
      : m.type === 'receive' ? ' · ' + esc(m.qty < m.sent ? t('{short} short of {sent}', { short: qty(m.sent - m.qty), sent: qty(m.sent) }) : t('all {sent} arrived', { sent: qty(m.sent) }))
      : m.type === 'pack' ? ' · ' + (m.from ? t('taken for packing') : t('filled')) : '';
    if (m.type === 'pack') where = m.from ? locName(m.from) : locName(m.to);
    if (m.type === 'receive') where = locName(m.from) + ' → ' + locName(m.to);
    return '<li' + (rejected ? ' class="rejected"' : '') + '><span class="muted small" style="width:48px">' + esc(niceDate(m.date)) + '</span>' +
      '<span class="grow"><b>' + esc(verb(m.type)) + ' ' + qty(m.qty) + ' ' + esc(unit) + '</b> ' + esc(name) +
      '<br><span class="muted small">' + esc(where) + extra + ' · ' + esc(m.worker) + (m.note ? ' · “' + esc(m.note) + '”' : '') + '</span></span>' +
      (pending ? '<span class="pill wait">' + t('waiting') + '</span>' : rejected ? '<span class="pill bad" title="' +
        esc(t('Rejected by {who}: {reason}', { who: rejected.by, reason: rejected.reason })) + '">' + t('Rejected') + '</span>' : '') + '</li>';
  }

  function reasonName(r) {
    var x = LOSS_REASONS.filter(function (l) { return l[0] === r; })[0];
    return x ? t(x[1]).toLowerCase() : t('other');
  }

  function placeLabel(id) {
    var l = locations().filter(function (x) { return x.id === id; })[0];
    return l && l.role === 'farm' ? t('{place} (market)', { place: locName(id) }) : locName(id);
  }

  // ---------- forms ----------
  function locOptions(list, selected) {
    return list.map(function (l) {
      return '<option value="' + esc(l.id) + '"' + (l.id === selected ? ' selected' : '') + '>' + esc(locName(l.id)) + '</option>';
    }).join('');
  }

  /** Bulk honey (kg): harvested or bought from farmers. Packed honey (jars, bottles) only comes from Pack honey. */
  function isBulkHoney(it) { return it.category === 'Honey' && it.unit === 'kg'; }
  function isPackedHoney(it) { return it.category === 'Honey' && it.unit !== 'kg'; }

  var LOSS_REASONS = [['spoilt', N('Spoilt / rotten')], ['died', N('Died')], ['broken', N('Broken / damaged')], ['stolen', N('Stolen / missing')], ['other', N('Other')]];

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
    // A box under the place that says what to check first (never counted, or a delivery not confirmed yet).
    var checkBox = '<div class="check-box" id="place-warn" hidden></div>';
    if (type === 'restock') {
      where = '<label class="field"><span>' + t('Where did the stock arrive?') + '</span><select name="to">' + locOptions(locations(), lastPlace) + '</select></label>' + checkBox;
    } else if (type === 'transfer') {
      // No silent defaults: start from the places used last time, or the worker's only place; otherwise they choose.
      var mine = myPlaces().filter(isPlace);
      var fromDef = isPlace(state.prefs.from) ? state.prefs.from : mine.length === 1 ? mine[0] : '';
      var toDef = isPlace(state.prefs.to) && state.prefs.to !== fromDef ? state.prefs.to : '';
      where = '<div class="row2"><label class="field"><span>' + t('From (leaving)') + '</span><select name="from"><option value="">' + t('Choose…') + '</option>' +
        locOptions(locations(), fromDef) + '</select></label>' +
        '<label class="field"><span>' + t('To (arriving)') + '</span><select name="to"><option value="">' + t('Choose…') + '</option>' +
        locOptions(locations(), toDef) + '</select></label></div>' +
        '<p class="route" id="route"></p>' + checkBox;
    } else if (type === 'sale') {
      var sellAt = sellers.some(function (l) { return l.id === state.prefs.shop; }) ? state.prefs.shop : lastShop;
      where = '<label class="field"><span>' + t('Where was it sold?') + '</span><select name="from">' + sellers.map(function (l) {
        return '<option value="' + esc(l.id) + '"' + (l.id === sellAt ? ' selected' : '') + '>' + esc(placeLabel(l.id)) + '</option>';
      }).join('') + '</select></label>' + checkBox;
    } else if (type === 'loss') {
      where = '<label class="field"><span>' + t('Where?') + '</span><select name="from">' + locOptions(locations(), lastPlace) + '</select></label>' + checkBox +
        '<label class="field"><span>' + t('What happened?') + '</span><select name="reason"><option value="">' + t('Choose…') + '</option>' +
        LOSS_REASONS.map(function (r) { return '<option value="' + r[0] + '">' + esc(t(r[1])) + '</option>'; }).join('') + '</select></label>';
    } else {
      where = '<label class="field"><span>' + t('Where are you counting?') + '</span><select name="to">' + locOptions(locations(), lastPlace) + '</select></label>' + checkBox;
    }
    var help = t({
      restock: N('Only stock that has <b>just arrived</b>: from the workshop, a supplier, a harvest, or born. Stock that was already here goes in <b>Stock count</b>, not here. Honey comes in as bulk kg; jars and bottles come from Pack honey.'),
      transfer: N('Check <b>From</b> and <b>To</b>, then enter how many you are sending. Leave the rest empty.'),
      sale: N('Enter how many were sold and the price for one.'),
      loss: N('Enter how many were lost. Write what happened in the note.'),
      count: N('Count what is <b>on the shelf now</b> and type it in. Type 0 if there are none. Leave empty only items you did not count. Use this for the first (opening) count too.'),
    }[type]);

    var cats = [];
    items().forEach(function (it) { if (cats.indexOf(it.category) < 0) cats.push(it.category); });
    var list = cats.map(function (c) {
      return '<div class="cat" data-cat="' + esc(c) + '">' + esc(catName(c)) + '</div>' + items().filter(function (it) { return it.category === c; }).map(function (it) {
        if (type === 'restock' && isBulkHoney(it)) {
          // Bulk honey has two sources: our harvest, and honey bought from farmers (who, and the price per kg).
          return '<div class="item bulk" data-item="' + esc(it.id) + '" data-cat="' + esc(c) + '">' +
            '<div class="bulk-head who">' + thumb(it) + '<div><div class="name">' + esc(itemName(it)) + '</div><div class="meta">kg<span class="onhand"></span></div></div></div>' +
            '<div class="row2"><div><label for="q-' + esc(it.id) + '">' + t('Our harvest (kg)') + '</label>' +
            '<input id="q-' + esc(it.id) + '" inputmode="decimal" name="qty" placeholder="–" autocomplete="off"></div>' +
            '<div><label for="qb-' + esc(it.id) + '">' + t('Bought from farmers (kg)') + '</label>' +
            '<input id="qb-' + esc(it.id) + '" inputmode="decimal" name="qtyBought" placeholder="–" autocomplete="off"></div></div>' +
            '<div class="row2 bought-box" hidden><div><label for="sup-' + esc(it.id) + '">' + t('Farmer’s name') + '</label>' +
            '<input id="sup-' + esc(it.id) + '" type="text" name="supplier" maxlength="100" placeholder="' + esc(t('e.g. Mutua, Kibwezi')) + '"></div>' +
            '<div><label for="cost-' + esc(it.id) + '">' + t('Price paid per kg') + '</label>' +
            '<input id="cost-' + esc(it.id) + '" inputmode="decimal" name="cost" placeholder="KSh" autocomplete="off"></div></div>' +
            '<div class="warn" hidden></div><div class="price-box" hidden><input name="price"></div></div>';
        }
        return '<div class="item sale-able" data-item="' + esc(it.id) + '" data-cat="' + esc(c) + '">' +
          '<div class="who">' + thumb(it) + '<div><div class="name">' + esc(itemName(it)) + '</div><div class="meta">' + esc(unitName(it.unit)) + (it.price ? ' · ' + ksh(it.price) : '') +
          '<span class="onhand"></span></div></div></div>' +
          '<div class="price-box" hidden><label for="p-' + esc(it.id) + '"></label><input id="p-' + esc(it.id) + '" inputmode="decimal" name="price" value="' +
          (it.price ? esc(it.price) : '') + '" placeholder="KSh" data-default="' + (it.price ? esc(it.price) : '') + '"></div>' +
          '<div><label for="q-' + esc(it.id) + '">' + (type === 'count' ? t('On shelf') : t('How many')) + '</label>' +
          '<input id="q-' + esc(it.id) + '" inputmode="decimal" name="qty" placeholder="–" autocomplete="off"></div>' +
          '<div class="warn" hidden></div></div>';
      }).join('');
    }).join('');

    v.innerHTML =
      '<button class="back" data-act="cancel">‹ ' + t('Back') + '</button>' +
      '<h1>' + T.ico + ' ' + t(T.title) + '</h1>' +
      '<form id="mv" novalidate>' +
      '<div class="card">' +
      '<label class="field"><span>' + t('Date') + '</span><input type="date" name="date" value="' + today() + '" max="' + today() + '" required></label>' +
      where +
      '<p class="muted small" style="margin:0">' + help + '</p>' +
      '</div>' +
      '<input type="search" id="filter" placeholder="' + esc(t('Find an item…')) + '" aria-label="' + esc(t('Find an item')) + '">' +
      list +
      '<p class="muted" id="none-here" hidden>' + t('No items are kept at this place. Ask the manager to add it under "places" in the items tab.') + '</p>' +
      '<label class="field" style="margin-top:16px"><span>' + (type === 'loss' ? t('Note') : t('Note (optional)')) + '</span><textarea name="note" maxlength="500" placeholder="' +
      esc(t({ count: N('e.g. 2 jars broken'), restock: N('e.g. harvest from apiary 3'), loss: N('e.g. rats got into the store') }[type] || '')) + '"></textarea></label>' +
      '<div class="err" id="form-err"></div>' +
      '<div class="form-pad"></div>' +
      '<div class="savebar"><button class="btn" type="submit" id="save-btn">' + t('Save') + '</button></div>' +
      '</form>';

    var form = $('#mv');
    function sourceLoc() {
      return type === 'sale' || type === 'transfer' || type === 'loss' ? form.from.value : null;
    }
    /** Is the item listed here? It must be kept at the chosen place (for a transfer: at both ends). */
    function allowed(it) {
      if (type === 'transfer') return !!form.from.value && !!form.to.value && Stock.kept(it, form.from.value) && Stock.kept(it, form.to.value);
      if (type === 'sale' && it.category === 'Packaging') return false; // empty jars are used, not sold
      if (type === 'restock' && isPackedHoney(it)) return false;         // jars and bottles come from Pack honey
      return Stock.kept(it, type === 'sale' || type === 'loss' ? form.from.value : form.to.value);
    }
    function refresh() {
      var src = sourceLoc();
      var mvts = movements();
      var n = 0;
      var shown = 0;
      var term = ($('#filter').value || '').trim().toLowerCase();
      var priced = type === 'sale';
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
        if (pb.querySelector('label')) pb.querySelector('label').textContent = t('Price each');
        var q = row.querySelector('input[name=qty]').value.trim();
        var qb = row.querySelector('input[name=qtyBought]');
        if (qb) row.querySelector('.bought-box').hidden = !(Number(qb.value) > 0);
        var has = here && ((q !== '' && (type === 'count' || Number(q) > 0)) || (qb && Number(qb.value) > 0));
        row.classList.toggle('filled', has);
        if (has) n++;
        var oh = row.querySelector('.onhand');
        var warn = row.querySelector('.warn');
        if (src && here) {
          var on = Stock.onHand(mvts, id, src);
          oh.textContent = ' · ' + t('{n} at {place}', { n: qty(on), place: locName(src) });
          var over = has && Number(q) > on;
          warn.hidden = !over;
          warn.textContent = !over ? ''
            : on <= 0 ? (type === 'transfer' ? t('None recorded at {place}. Is “From” right? If it is, count the stock there first.', { place: locName(src) })
              : t('None recorded at {place}. Is “Where” right? If it is, count the stock there first.', { place: locName(src) }))
            : t('Only {n} recorded at {place}. Check the number, or do a count.', { n: qty(on), place: locName(src) });
        } else {
          oh.textContent = '';
          warn.hidden = true;
        }
      });
      Array.prototype.forEach.call(form.querySelectorAll('.cat'), function (h) {
        var c = h.getAttribute('data-cat');
        h.hidden = !Array.prototype.some.call(form.querySelectorAll('.item'), function (r) { return r.getAttribute('data-cat') === c && !r.hidden; });
      });
      var choosing = type === 'transfer' && !(form.from.value && form.to.value);
      $('#none-here').textContent = choosing ? t('Choose From and To first.')
        : t('No items are kept at this place. Ask the manager to add it under "places" in the items tab.');
      $('#none-here').hidden = (shown > 0 || !!term) && !choosing;
      $('#save-btn').textContent = n ? tn(n, 'Save {n} item', 'Save {n} items') : t('Save');
      paintChecks(mvts);
    }
    /** The From → To line, and what to do first at this place (count it, or confirm a delivery). */
    function paintChecks(mvts) {
      var route = $('#route');
      if (route) {
        var fv = form.from.value, tv = form.to.value;
        route.innerHTML = fv && tv
          ? t('From <b>{from}</b> <span aria-hidden="true">→</span> to <b>{to}</b>', { from: esc(locName(fv)), to: esc(locName(tv)) })
          : t('Choose where the stock is leaving from and where it is going.');
        route.classList.toggle('same', !!fv && fv === tv);
      }
      var box = $('#place-warn');
      if (!box) return;
      var at = type === 'sale' || type === 'loss' ? form.from.value : form.to.value;
      var own = type === 'transfer' ? form.from.value : at;
      var html = notMine(own) ? '⚠️ ' + t('<b>{place} is not your place.</b> Only record here if you are really there.', { place: esc(locName(own)) }) + '<br>' : '';
      if (type === 'restock' && at && !Stock.everCounted(mvts, at)) {
        html += '⚠️ ' + t('<b>{place} has not been counted yet.</b> If this stock was already here before today, it goes in Stock count, not here.', { place: esc(locName(at)) }) +
          '<br><button type="button" class="btn secondary" data-form="count" data-place="' + esc(at) + '">' + t('Go to Stock count') + ' →</button>';
      } else if ((type === 'sale' || type === 'count') && at) {
        var d = Stock.pendingDeliveries(mvts, [at], today())[0];
        if (d) {
          var n = d.lines.reduce(function (s, x) { return s + x.qty; }, 0);
          html += '📥 ' + tn(n, '<b>A delivery to {place} is not confirmed yet:</b> {n} item from {from}, sent {date} by {who}. Confirm it first, so the stock is right.',
              '<b>A delivery to {place} is not confirmed yet:</b> {n} items from {from}, sent {date} by {who}. Confirm it first, so the stock is right.',
              { place: esc(locName(at)), from: esc(locName(d.from)), date: esc(niceDate(d.date)), who: esc(d.worker) }) +
            '<br><button type="button" class="btn" data-form="receive" data-place="' + esc(d.to) + '" data-batch="' + esc(d.batch) + '">' + t('Check delivery') + ' →</button>';
        }
      }
      box.innerHTML = html;
      box.hidden = !html;
    }
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    refresh();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('#form-err');
      var date = form.date.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) { err.textContent = t('Pick a date that is today or earlier.'); return; }
      var from = form.from ? form.from.value : '';
      var to = form.to ? form.to.value : '';
      if (type === 'transfer' && (!from || !to)) { err.textContent = t('Choose where the stock is leaving from (From) and where it is going (To).'); return; }
      if (type === 'transfer' && from === to) { err.textContent = t('“From” and “To” must be different places.'); return; }
      var reason = form.reason ? form.reason.value : '';
      if (type === 'loss' && !reason) { err.textContent = t('Choose what happened (spoilt, died, broken…).'); form.reason.focus(); return; }
      var note = form.note.value.trim();
      var at = new Date().toISOString();
      var batch = uid(); // every line saved together: one delivery, one restock, …
      var out = [];
      var bad = null, noPrice = null, noFarmer = null, part = null;
      var line = function (id, q, extra) {
        return Object.assign({ id: uid(), date: date, type: type, itemId: id, qty: q,
          from: type === 'sale' || type === 'transfer' || type === 'loss' ? from : '',
          to: type === 'sale' || type === 'loss' ? '' : to, price: 0, worker: state.profile.name, note: note, at: at, batch: batch }, extra || {});
      };
      Array.prototype.forEach.call(form.querySelectorAll('.item'), function (row) {
        if (row.getAttribute('data-here') !== '1') return; // typed in before the place was changed: not for this place
        var qbIn = row.querySelector('input[name=qtyBought]');
        if (qbIn) {
          // Bulk honey: a line for our harvest and a line for honey bought from a farmer.
          var hv = row.querySelector('input[name=qty]').value.trim().replace(',', '.');
          var bv = qbIn.value.trim().replace(',', '.');
          if ((hv !== '' && !(Number(hv) >= 0)) || (bv !== '' && !(Number(bv) >= 0))) { bad = bad || row; return; }
          if (Number(hv) > 0) out.push(line(row.getAttribute('data-item'), Number(hv), { source: 'own' }));
          if (Number(bv) > 0) {
            var farmer = row.querySelector('input[name=supplier]').value.trim();
            var cv = row.querySelector('input[name=cost]').value.trim().replace(/,/g, '');
            if (!farmer) { noFarmer = noFarmer || row; return; }
            if (!(Number(cv) > 0)) { noPrice = noPrice || row; return; }
            out.push(line(row.getAttribute('data-item'), Number(bv), { source: 'bought', supplier: farmer, cost: Number(cv) }));
          }
          return;
        }
        var raw = row.querySelector('input[name=qty]').value.trim().replace(',', '.');
        if (raw === '') return;
        var q = Number(raw);
        if (!isFinite(q) || q < 0) { bad = bad || row; return; }
        if (q === 0 && type !== 'count') return;
        var id = row.getAttribute('data-item');
        if (q % 1 && Stock.wholeUnits(itemById(id))) { part = part || row; return; }
        var price = 0;
        if (type === 'sale') {
          var pr = row.querySelector('input[name=price]').value.trim().replace(/,/g, '');
          var pv = Number(pr);
          if (pr === '' || pv === 0) { noPrice = noPrice || row; return; }
          if (!isFinite(pv) || pv < 0) { bad = bad || row; return; }
          price = pv;
        }
        out.push(line(id, q, type === 'loss' ? { price: price, reason: reason } : { price: price }));
      });
      if (bad) {
        err.textContent = t('One of the numbers is not right. Use digits only.');
        bad.scrollIntoView({ block: 'center' });
        return;
      }
      if (part) {
        err.textContent = t('Only kg can have a point. Count jars, pieces and animals in whole numbers (1, 2, 3…).');
        part.scrollIntoView({ block: 'center' });
        return;
      }
      if (noFarmer) {
        err.textContent = t('Type the name of the farmer the honey was bought from.');
        noFarmer.scrollIntoView({ block: 'center' });
        noFarmer.querySelector('input[name=supplier]').focus();
        return;
      }
      if (noPrice) {
        var bulkRow = !!noPrice.querySelector('input[name=cost]');
        err.textContent = bulkRow ? t('Type the price paid per kg.') : t('Type the price you sold at, for one.');
        noPrice.scrollIntoView({ block: 'center' });
        noPrice.querySelector(bulkRow ? 'input[name=cost]' : 'input[name=price]').focus();
        return;
      }
      if (!out.length) { err.textContent = t('Type a number next to at least one item.'); return; }
      var mvts = movements();
      var ago = Math.round((Date.parse(today() + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 864e5);
      if (ago > 31 && !window.confirm(t('The date is {days} days ago ({date}).\n\nIs the date right?', { days: ago, date: niceDate(date) }))) return;
      var ownPlace = type === 'sale' || type === 'loss' || type === 'transfer' ? from : to;
      if (notMine(ownPlace) && !window.confirm(t('{place} is not your place.\n\nSave this for {place} anyway?', { place: locName(ownPlace) }))) return;
      var lineText = function (m) {
        var it = itemById(m.itemId) || {};
        return '• ' + qty(m.qty) + (it.unit === 'kg' ? ' kg ' : ' × ') + (itemName(it) || m.itemId);
      };
      if (type === 'transfer' && !window.confirm(t('Please check before sending:\n\nFROM:  {from}\nTO:  {to}\n\n{lines}\n\nIs this right?',
          { from: locName(from).toUpperCase(), to: locName(to).toUpperCase(), lines: out.map(lineText).join('\n') }))) return;
      if (type === 'restock' && !Stock.everCounted(mvts, to) && !window.confirm(t('{place} has never been counted.\n\nWas ALL of this stock delivered, made or harvested just now?\n\nIf it was already on the shelf, press Cancel and use Stock count instead.', { place: locName(to) }))) return;
      var place = type === 'sale' ? from : to;
      var waiting = (type === 'sale' || type === 'count') && Stock.pendingDeliveries(mvts, [place], today())[0];
      if (waiting && !window.confirm(t('A delivery from {from} to {to} is not confirmed yet.\n\nPress Cancel and confirm the delivery first, or OK to save anyway.',
          { from: locName(waiting.from), to: locName(waiting.to) }))) return;
      var overs = form.querySelectorAll('.item[data-here="1"] .warn:not([hidden])').length;
      var src = sourceLoc();
      if (overs && !window.confirm(type === 'transfer'
          ? tn(overs, '{n} item is more than the stock recorded at {place}.\n\nIs “From” right? Save anyway?', '{n} items are more than the stock recorded at {place}.\n\nIs “From” right? Save anyway?', { place: locName(src) })
          : tn(overs, '{n} item is more than the stock recorded at {place}.\n\nIs “Where” right? Save anyway?', '{n} items are more than the stock recorded at {place}.\n\nIs “Where” right? Save anyway?', { place: locName(src) }))) return;
      var dup = Stock.recentDuplicate(mvts, out, state.profile.name, at, 10);
      if (dup) {
        var mins = Math.max(1, Math.round((Date.parse(at) - Date.parse(dup.at)) / 60000));
        if (!window.confirm(tn(mins, 'You saved exactly the same entry {n} minute ago.\n\nSave it AGAIN?', 'You saved exactly the same entry {n} minutes ago.\n\nSave it AGAIN?'))) return;
      }

      commit(out);
    });

    function commit(out) {
      var from = form.from ? form.from.value : '';
      var to = form.to ? form.to.value : '';
      state.prefs.shop = type === 'sale' || type === 'loss' ? from : to;
      if (type === 'transfer') { state.prefs.from = from; state.prefs.to = to; }
      save('prefs', state.prefs);
      state.queue = state.queue.concat(out);
      saveQueue();
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
    var mine = isManager() ? [] : myPlaces(); // managers can pack anywhere bulk honey is kept
    return locations().filter(function (l) { return Stock.kept(bulk, l.id) && (!mine.length || mine.indexOf(l.id) >= 0); });
  }

  function renderPack(v) {
    var bulk = bulkHoney();
    var places = packPlaces();
    if (!bulk || !places.length) { state.view = null; return render(); }
    v.innerHTML =
      '<button class="back" data-act="cancel">‹ ' + t('Back') + '</button>' +
      '<h1>🍯 ' + t('Pack honey') + '</h1>' +
      '<form id="mv" novalidate><div class="card">' +
      '<label class="field"><span>' + t('Date') + '</span><input type="date" name="date" value="' + today() + '" max="' + today() + '" required></label>' +
      (places.length > 1 ? '<label class="field"><span>' + t('Where?') + '</span><select name="place">' + locOptions(places, places[0].id) + '</select></label>'
        : '<input type="hidden" name="place" value="' + esc(places[0].id) + '">') +
      '<label class="field"><span>' + t('Bulk honey taken (kg)') + '</span><input inputmode="decimal" name="kg" placeholder="' + esc(t('e.g. 20')) + '" autocomplete="off"></label>' +
      '<p class="muted small" style="margin:0" id="bulk-left"></p></div>' +
      '<h2>' + t('How many did you fill?') + '</h2><div id="pack-list"></div>' +
      '<div class="card" id="pack-sum"></div>' +
      '<label class="field" style="margin-top:16px"><span>' + t('Note (optional)') + '</span><textarea name="note" maxlength="500"></textarea></label>' +
      '<div class="err" id="form-err"></div><div class="form-pad"></div>' +
      '<div class="savebar"><button class="btn" type="submit" id="save-btn">' + t('Save packing') + '</button></div></form>';
    var form = $('#mv');
    function containers() {
      return items().filter(function (it) { return it.category === 'Honey' && it.kgEach > 0 && it.id !== bulk.id && Stock.kept(it, form.place.value); });
    }
    /** The empty containers (jar, bottle; later lids, labels) one filled unit uses up, if they are items. */
    function empties(it) {
      return (it.container || []).map(itemById).filter(function (c) { return c && c.active !== false; });
    }
    function drawList() {
      $('#pack-list').innerHTML = containers().map(function (it) {
        return '<div class="item" data-item="' + esc(it.id) + '"><div class="who">' + thumb(it) + '<div><div class="name">' + esc(itemName(it)) + '</div><div class="meta">' +
          esc(unitName(it.unit)) + ' · ' + esc(t('{kg} kg each', { kg: qty(it.kgEach) })) + '<span class="empties"></span></div></div></div><div><label for="q-' + esc(it.id) + '">' + t('How many') + '</label>' +
          '<input id="q-' + esc(it.id) + '" inputmode="decimal" name="qty" placeholder="–" autocomplete="off"></div>' +
          '<div class="warn" hidden></div></div>';
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
      // Empty containers used: one of each linked container per filled unit.
      var used = {};
      lines.forEach(function (l) { empties(itemById(l.itemId)).forEach(function (c) { used[c.id] = (used[c.id] || 0) + l.qty; }); });
      return { kg: kg, packed: Math.round(packed * 100) / 100, lines: lines, bad: bad, used: used };
    }
    function refresh() {
      var n = numbers();
      var mv = movements();
      Array.prototype.forEach.call(form.querySelectorAll('#pack-list .item'), function (row) {
        var cs = empties(itemById(row.getAttribute('data-item')));
        var q = Number(row.querySelector('input').value) || 0;
        var short = cs.filter(function (c) { return (n.used[c.id] || 0) > Stock.onHand(mv, c.id, form.place.value); });
        row.querySelector('.empties').textContent = cs.length ? ' · ' + t('{list} in store', { list: cs.map(function (c) {
          return qty(Stock.onHand(mv, c.id, form.place.value)) + (LANG === 'en' ? ' ' + c.name.toLowerCase() + 's' : ' × ' + itemName(c).toLowerCase());
        }).join(', ') }) : '';
        var w = row.querySelector('.warn');
        w.hidden = !(q > 0 && short.length);
        w.textContent = w.hidden ? '' : t('More than the empty {what} recorded in store. Check the number, or record the empties you bought.',
          { what: short.map(function (c) { return unitsName(c.unit); }).join(' / ') });
      });
      var onHand = Stock.onHand(mv, bulk.id, form.place.value);
      $('#bulk-left').textContent = t('{kg} kg of bulk honey recorded at {place}.', { kg: qty(onHand), place: locName(form.place.value) });
      var left = n.kg - n.packed;
      $('#pack-sum').innerHTML = '<p><b>' + t('In jars and bottles:') + '</b> ' + qty(n.packed) + ' kg</p>' +
        (n.kg > 0 ? '<p style="margin:0" class="' + (left < -0.05 * n.kg ? 'err' : '') + '"><b>' + (left >= 0 ? t('Left on equipment / wasted:') : t('More in jars than taken:')) +
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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) { err.textContent = t('Pick a date that is today or earlier.'); return; }
      var n = numbers();
      if (!(n.kg > 0)) { err.textContent = t('Type how many kg of bulk honey you took.'); form.kg.focus(); return; }
      if (n.bad) { err.textContent = t('Type whole numbers of jars and bottles.'); return; }
      if (!n.lines.length) { err.textContent = t('Type how many jars or bottles you filled.'); return; }
      // Small differences happen (honey stays on the equipment); more honey in the jars than was taken is a mistake.
      if (n.packed > n.kg * 1.05) { err.textContent = t('The jars hold {packed} kg but you took only {kg} kg. Check the numbers.', { packed: qty(n.packed), kg: qty(n.kg) }); return; }
      if (n.kg - n.packed > n.kg * 0.1 && !window.confirm(t('{kg} kg is not in jars. Is that right?', { kg: qty(n.kg - n.packed) }))) return;
      var place = form.place.value;
      var onHand = Stock.onHand(movements(), bulk.id, place);
      if (n.kg > onHand && !window.confirm(t('Only {kg} kg of bulk honey is recorded at {place}. Save anyway?', { kg: qty(onHand), place: locName(place) }))) return;
      var shortEmpties = Object.keys(n.used).filter(function (id) { return n.used[id] > Stock.onHand(movements(), id, place); });
      if (shortEmpties.length && !window.confirm(t('More containers used than recorded in store:\n{lines}\n\nSave anyway? (Record the empties you bought with New stock in.)', { lines: shortEmpties.map(function (id) {
            return '• ' + t('{item}: {used} used, {left} in store', { item: itemName(itemById(id)), used: qty(n.used[id]), left: qty(Stock.onHand(movements(), id, place)) });
          }).join('\n') }))) return;
      var batch = uid(), at = new Date().toISOString(), note = form.note.value.trim();
      var base = { date: date, type: 'pack', price: 0, worker: state.profile.name, note: note, at: at, batch: batch };
      var out = [Object.assign({ id: uid(), itemId: bulk.id, qty: n.kg, from: place, to: '' }, base)].concat(n.lines.map(function (l) {
        return Object.assign({ id: uid(), itemId: l.itemId, qty: l.qty, from: '', to: place }, base);
      })).concat(Object.keys(n.used).map(function (id) {
        // The empty jars/bottles this packing used up.
        return Object.assign({ id: uid(), itemId: id, qty: n.used[id], from: place, to: '' }, base);
      }));
      saveLines('pack', out, place);
    });
  }

  // ---------- confirming a delivery ----------
  function renderReceive(v) {
    var key = state.receiving || {};
    var d = Stock.pendingDeliveries(movements(), [], today()).filter(function (x) { return x.batch === key.batch && x.to === key.to; })[0];
    if (!d) { state.view = null; return render(); }
    v.innerHTML =
      '<button class="back" data-act="cancel">‹ ' + t('Back') + '</button>' +
      '<h1>📥 ' + esc(t('Delivery from {place}', { place: locName(d.from) })) + '</h1>' +
      '<p class="muted">' + esc(t('Sent to {place} by {who} on {date}.', { place: locName(d.to), who: d.worker, date: niceDate(d.date) })) + ' ' +
      t('Count what arrived. If something is missing or broken, change the number.') + '</p>' +
      '<form id="mv" novalidate>' +
      d.lines.map(function (l, i) {
        var it = itemById(l.itemId) || { name: l.itemId, unit: '' };
        return '<div class="item sale" data-i="' + i + '"><div class="who">' + thumb(it) + '<div><div class="name">' + esc(itemName(it)) + '</div><div class="meta">' + esc(unitName(it.unit)) + '</div></div></div>' +
          '<div><label>' + t('Sent') + '</label><div class="num" style="padding:12px 8px;font-weight:700">' + qty(l.qty) + '</div></div>' +
          '<div><label for="r-' + i + '">' + t('Arrived') + '</label><input id="r-' + i + '" inputmode="decimal" name="qty" value="' + l.qty + '" autocomplete="off"></div>' +
          '<div class="warn" hidden></div></div>';
      }).join('') +
      '<label class="field" style="margin-top:16px"><span>' + t('Note (optional)') + '</span><textarea name="note" maxlength="500" placeholder="' + esc(t('e.g. 2 jars broken in the box')) + '"></textarea></label>' +
      '<div class="err" id="form-err"></div>' +
      '<div class="never-box"><p class="muted small">' + t('Nothing came, or it was saved by mistake (for example sent twice)?') + '</p>' +
      '<button type="button" class="btn secondary small" data-act="never-came" data-key="' + esc(d.batch) + '">' + t('This delivery never came') + '</button></div>' +
      '<div class="form-pad"></div>' +
      '<div class="savebar"><button class="btn" type="submit" id="save-btn">' + t('Confirm delivery') + '</button></div></form>';
    var form = $('#mv');
    function check() {
      Array.prototype.forEach.call(form.querySelectorAll('.item'), function (row) {
        var l = d.lines[Number(row.getAttribute('data-i'))];
        var got = Number(row.querySelector('input').value);
        var w = row.querySelector('.warn');
        w.hidden = !(isFinite(got) && got !== l.qty);
        w.textContent = got < l.qty ? t('{n} missing', { n: qty(l.qty - got) }) : got > l.qty ? t('{n} more than sent', { n: qty(got - l.qty) }) : '';
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
        if (raw === '' || !isFinite(got) || got < 0 || (got % 1 && Stock.wholeUnits(itemById(l.itemId)))) { bad = true; return; }
        if (got < l.qty) short += l.qty - got;
        out.push({ id: uid(), date: today(), type: 'receive', itemId: l.itemId, qty: got, sent: l.qty, from: d.from, to: d.to, price: 0,
                   worker: state.profile.name, note: note, at: at, batch: d.batch });
      });
      if (bad) { err.textContent = t('Type how many arrived for every item (0 if none), in whole numbers except kg.'); return; }
      if (short && !window.confirm(t('{n} fewer than were sent. {who} and the manager will see this. Confirm?', { n: qty(short), who: d.worker }))) return;
      saveLines('receive', out, d.to);
    });
  }

  /** Queue the lines, show the Saved screen and send. */
  function saveLines(type, out, place) {
    state.prefs.shop = place;
    save('prefs', state.prefs);
    state.queue = state.queue.concat(out);
    saveQueue();
    state.lastSaved = { type: type, count: out.length, amount: 0 };
    state.view = 'done';
    render();
    window.scrollTo(0, 0);
    sync();
  }

  function renderDone(v) {
    var s = state.lastSaved || { count: 0 };
    var T = TYPES[s.type] || TYPES.restock;
    var waiting = !DEMO && myWaiting().length;
    v.innerHTML = '<div class="done"><div class="big">✅</div><h1>' + t('Saved') + '</h1>' +
      '<p>' + esc(t(T.verb)) + ': ' + tn(s.count, '{n} item', '{n} items') + (s.type === 'sale' ? ' · ' + ksh(s.amount) : '') + '</p>' +
      '<p class="muted">' + (DEMO ? t('Saved on this phone (demo).') : state.storageError && waiting ? '⚠️ ' + t('The phone could not store it. Keep the app open until it is sent.')
        : waiting ? t('Saved on this phone. It will be sent to the sheet when there is signal.') : t('Sent to the stock sheet.')) + '</p>' +
      '<div class="btn-row">' + (s.type === 'receive' ? '' : '<button class="btn" data-form="' + esc(s.type) + '">' + t('Record more') + '</button>') +
      '<button class="btn secondary" data-act="home">' + t('Done') + '</button>' +
      (isManager() ? '<button class="btn secondary" data-tab="dashboard">' + t('See dashboard') + '</button>' : '') + '</div></div>';
  }

  // ---------- dashboard ----------
  function renderDashboard(v) {
    var s = Stock.summarise({ items: allItems(), locations: locations(), movements: movements() }, today());
    var ym = today().slice(0, 7);
    var locs = locations();
    var maxSale = Math.max.apply(null, s.salesByMonth.map(function (m) { return m.amount; }).concat([1]));
    var curMonth = s.salesByMonth[s.salesByMonth.length - 1];
    var prevMonth = s.salesByMonth[s.salesByMonth.length - 2];

    var onTheWay = Stock.pendingDeliveries(movements(), [], today());
    var oldest = onTheWay.reduce(function (a, d) { return !a || d.age > a.age ? d : a; }, null);
    // The latest month-end window that has started: this month's from the 3rd-last day, otherwise last month's.
    var countWin = Stock.countWindow(today());
    if (!countWin) {
      var cd = new Date(today() + 'T00:00:00');
      cd.setDate(0); // last day of the previous month
      countWin = Stock.countWindow(cd.getFullYear() + '-' + String(cd.getMonth() + 1).padStart(2, '0') + '-' + String(cd.getDate()).padStart(2, '0'));
      countWin.late = true;
      countWin.closed = true;
    }
    var winMonthShort = monthName(countWin.month, true).split(' ')[0];
    var countsDone = locs.filter(function (l) { return !Stock.countMissing(movements(), items(), l.id, countWin.start).length; }).length;
    var tiles =
      '<div class="tiles">' +
      tile(t('Sales in {month}', { month: monthName(ym) }), ksh(s.month.sales), prevMonth ? t('Last month {amount}', { amount: ksh(prevMonth.amount) }) : '') +
      tile(t('Units sold'), qty(s.month.units), tn(s.month.entries, '{n} entry this month', '{n} entries this month')) +
      tile(t('Stock value'), ksh(s.stockValue), t('At selling price, all places')) +
      tile(t('Low in a shop'), String(s.low.length), s.low.length ? t('Needs restocking') : t('Nothing low')) +
      tile(t('Deliveries on the way'), String(onTheWay.length), onTheWay.length
        ? (oldest.age === 0 ? t('Oldest sent today') : oldest.age === 1 ? t('Oldest sent yesterday') : t('Oldest sent {days} days ago', { days: oldest.age })) : t('All confirmed')) +
      tile(t('Places counted'), countsDone + ' / ' + locs.length, countWin.closed ? t('{month}: {result}', { month: winMonthShort, result: countsDone === locs.length ? t('all done') : t('missed') }) :
        countWin.late ? t('Late: due by the 3rd') : t('Due by the end of the month')) +
      '</div>';

    var chart = '<h2>' + t('Sales by month') + '</h2><div class="card"><div class="chart-max">' + ksh(maxSale) + '</div><div class="chart" id="chart">' +
      s.salesByMonth.map(function (m) {
        var h = Math.max(0, (m.amount / maxSale) * 100);
        return '<div class="col' + (m === curMonth ? ' cur' : '') + '" tabindex="0" data-tip="' + esc(monthName(m.month, true) + ': ' + ksh(m.amount) + ' · ' + t('{n} units', { n: qty(m.units) })) + '">' +
          '<div class="bar" style="height:' + h.toFixed(1) + '%"></div><span class="lbl">' + esc(monthShort(m.month)) + '</span></div>';
      }).join('') + '</div><p class="muted small" style="margin-top:10px">' + t('Tap a bar for the amount. This month is darker.') + '</p></div>';

    var byShop = s.salesByShop.length ? '<h2>' + t('This month by place') + '</h2><div class="table-wrap"><table><thead><tr><th>' + t('Where') + '</th><th class="num">' + t('Units') +
      '</th><th class="num">' + t('Sales') + '</th></tr></thead><tbody>' +
      s.salesByShop.map(function (b) {
        return '<tr><td>' + esc(placeLabel(b.location)) + '</td><td class="num">' + qty(b.units) + '</td><td class="num">' + ksh(b.amount) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '';

    var lowLi = function (l) {
      return '<li class="with-thumb">' + thumb(l.item, true) + '<span class="grow"><b>' + esc(itemName(l.item)) + '</b><br><span class="muted small">' + esc(locName(l.location)) +
        ' · ' + esc(t('reorder at {n}', { n: qty(l.item.reorderLevel) })) +
        (l.location === (farm() || {}).id ? '' : ' · ' + esc(t('farm has {n}', { n: qty(stockAt(s, l.item.id, (farm() || {}).id)) }))) + '</span></span>' +
        '<span class="pill ' + (l.qty <= 0 ? 'bad' : 'warn') + '">' + (l.qty <= 0 ? '⛔ ' + t('Out of stock') : '⚠ ' + t('{n} left', { n: qty(l.qty) })) + '</span></li>';
    };
    var lowSorted = s.low.slice().sort(function (a, b) { return a.qty - b.qty; });
    var low = '<h2>' + t('Low stock') + '</h2>' + (lowSorted.length
      ? '<ul class="list">' + lowSorted.slice(0, 5).map(lowLi).join('') + '</ul>' +
        (lowSorted.length > 5 ? '<details class="more"><summary>' + t('Show {n} more', { n: lowSorted.length - 5 }) + '</summary><ul class="list">' +
          lowSorted.slice(5).map(lowLi).join('') + '</ul></details>' : '')
      : '<p class="muted">✓ ' + t('Everything is above its reorder level.') + '</p>');

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
    var counts = '<h2>' + esc(t('Month-end count ({month})', { month: winMonth })) + '</h2><ul class="list">' + locs.map(function (l) {
      var last = s.lastCount[l.id];
      var keptHere = items().filter(function (it) { return Stock.kept(it, l.id); }).length;
      var missing = Stock.countMissing(movements(), items(), l.id, win.start).length;
      var done = !missing;
      var part = !done && missing < keptHere ? ' · ' + t('{done} of {all} items counted', { done: keptHere - missing, all: keptHere }) : '';
      var pill = done ? '<span class="pill ok">✓ ' + t('Done') + '</span>'
        : win.closed ? '<span class="pill bad">✗ ' + t('Missed') + '</span>' : '<span class="pill warn">⚠ ' + (win.late ? t('Late') : t('Due')) + '</span>';
      return '<li><span class="grow"><b>' + esc(locName(l.id)) + '</b><br><span class="muted small">' +
        (last ? esc(t('Last counted {date}', { date: niceDate(last) })) : t('Never counted')) + esc(part) + '</span></span>' + pill + '</li>';
    }).join('') + '</ul>';

    var adj = s.adjustments.filter(function (a) { return a.movement.date.slice(0, 7) === ym && a.delta !== 0; });
    var adjHtml = adj.length ? '<h2>' + t('Count differences this month') + '</h2><p class="muted small">' + t('Shelf count minus what the records said. Minus means stock went missing.') + '</p>' +
      '<div class="table-wrap"><table><thead><tr><th>' + t('Item') + '</th><th>' + t('Where') + '</th><th class="num">' + t('Records') + '</th><th class="num">' + t('Counted') +
      '</th><th class="num">' + t('Diff') + '</th></tr></thead><tbody>' +
      adj.map(function (a) {
        var it = itemById(a.movement.itemId);
        return '<tr><td>' + esc(it ? itemName(it) : a.movement.itemId) + '</td><td>' + esc(locName(a.movement.to)) + '</td><td class="num">' + qty(a.before) +
          '</td><td class="num">' + qty(a.after) + '</td><td class="num' + (a.delta < 0 ? ' neg' : '') + '">' + (a.delta > 0 ? '+' : '') + qty(a.delta) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '';

    var inHtml = s.month.own || s.month.bought ? '<h2>' + esc(t('Honey in, {month}', { month: monthName(ym) })) + '</h2><div class="tiles">' +
      tile(t('Our harvest'), qty(s.month.own) + ' kg', t('From our apiaries')) +
      tile(t('Bought from farmers'), qty(s.month.bought) + ' kg', t('Paid {amount}', { amount: ksh(s.month.spent) })) + '</div>' : '';
    var lossHtml = s.losses.length ? '<h2>' + esc(t('Losses in {month}', { month: monthName(ym) })) + '</h2><ul class="list">' + s.losses.map(function (l) {
      var it = itemById(l.itemId);
      return '<li><span class="grow">' + esc(it ? itemName(it) : l.itemId) + '<br><span class="muted small">' + esc(reasonName(l.reason)) + '</span></span>' +
        '<span class="num">' + qty(l.qty) + ' ' + esc(it ? unitFor(l.qty, it.unit) : '') + '</span>' + (l.value ? '<span class="num muted small" style="min-width:84px">' + ksh(l.value) + '</span>' : '') + '</li>';
    }).join('') + '</ul>' : '';
    // Honey flow this month: where every jar went, per place, and the totals in kg.
    var honeyIds = allItems().filter(function (it) { return it.category === 'Honey'; }).map(function (it) { return it.id; });
    var flowRows = Stock.flow(movements(), honeyIds, locs.map(function (l) { return l.id; }), ym + '-01', today())
      .filter(function (r) { return r.start || r.in || r.out || r.sold || r.lost || r.countDiff || r.end; });
    var signed = function (n) { return (n > 0 ? '+' : '') + qty(n); };
    // The honey journey this month in kg, at a glance: bulk at the farm → packed → sent to the shops → sold.
    var kgOf = function (id) { return (itemById(id) || {}).kgEach || 0; };
    var bulkIt = bulkHoney();
    var shopIds = shops().map(function (l) { return l.id; });
    var sumKg = function (f, pred) {
      return Math.round(flowRows.filter(pred).reduce(function (sum, r) { return sum + r[f] * (r.itemId === (bulkIt || {}).id ? 1 : kgOf(r.itemId)); }, 0) * 10) / 10;
    };
    var bulkNow = sumKg('end', function (r) { return bulkIt && r.itemId === bulkIt.id; });
    var packedKg = Math.round(movements().filter(function (m) { return m.type === 'pack' && m.to && m.date >= ym + '-01'; })
      .reduce(function (sum, m) { return sum + (Number(m.qty) || 0) * kgOf(m.itemId); }, 0) * 10) / 10;
    var shopsNow = sumKg('end', function (r) { return shopIds.indexOf(r.place) >= 0 && (!bulkIt || r.itemId !== bulkIt.id); });
    var soldKg = sumKg('sold', function (r) { return !bulkIt || r.itemId !== bulkIt.id; });
    var step = function (n, lbl, v, sub) {
      return '<div class="step"><span class="lbl"><span class="n">' + n + '</span>' + lbl + '</span><b>' + qty(v) + ' kg</b><span class="sub">' + sub + '</span></div>';
    };
    var journey = flowRows.length ? '<h2>' + esc(t('Honey journey, {month}', { month: monthName(ym) })) + '</h2><div class="journey">' +
      step(1, t('Bulk at the farm'), bulkNow, t('waiting to be packed')) +
      step(2, t('Packed'), packedKg, t('into jars and bottles this month')) +
      step(3, t('In the shops'), shopsNow, t('on the shelves now')) +
      step(4, t('Sold'), soldKg, t('this month, all places')) + '</div>' : '';
    /** Short names for the narrow flow tables. */
    var shortName = function (it) {
      if (LANG !== 'en') return tr('items_short', it.id, itemName(it));
      return it.category === 'Packaging' ? it.name.replace(/^Empty /, '').replace(/ squeeze bottle$/, ' bottle')
        : it.name.replace(/^Raw (Organic )?[Hh]oney — /, '').replace(/^bulk \(per kg\)$/, 'Bulk kg').replace(/ Squeeze Bottle$/, ' bottle');
    };
    var flowHtml = flowRows.length ? '<h2>' + esc(t('Honey flow in {month}', { month: monthName(ym) })) + '</h2>' +
      '<p class="muted small">' + t('Start + In − Out − Sold − Lost ± Count (±) = Now. In: harvested, bought, packed or delivered. Out: sent away or used for packing. Lost: losses and deliveries that arrived short. In the kg totals packing only changes the container, so honey left on the equipment shows as Lost.') + '</p>' +
      locs.filter(function (l) { return flowRows.some(function (r) { return r.place === l.id; }); }).map(function (l) {
        var rs = flowRows.filter(function (r) { return r.place === l.id; });
        var tk = Stock.flowKg(rs, function (id) { return (itemById(id) || {}).kgEach; });
        var kg = function (f) { return qty(Math.round(tk[f] * 10) / 10); };
        return '<div class="table-wrap" style="margin-bottom:10px"><table class="flow"><thead><tr><th>' + esc(LANG === 'en' ? l.name : tr('places_short', l.id, locName(l.id))) + '</th><th class="num">' + t('Start') + '</th><th class="num">' + t('In') + '</th>' +
          '<th class="num">' + t('Out') + '</th><th class="num">' + t('Sold') + '</th><th class="num">' + t('Lost') + '</th><th class="num">±</th><th class="num">' + t('Now') + '</th></tr></thead><tbody>' +
          rs.map(function (r) {
            var it = itemById(r.itemId) || { id: r.itemId, name: r.itemId };
            return '<tr><td>' + esc(shortName(it)) + '</td><td class="num">' + qty(r.start) + '</td><td class="num">' + qty(r.in) +
              '</td><td class="num">' + qty(r.out) + '</td><td class="num">' + qty(r.sold) + '</td><td class="num' + (r.lost > 0 ? ' low' : '') + '">' + qty(r.lost) +
              '</td><td class="num' + (r.countDiff < 0 ? ' neg' : '') + '">' + signed(r.countDiff) + '</td><td class="num"><b>' + qty(r.end) + '</b></td></tr>';
          }).join('') +
          '<tr><td><b>' + t('Total kg') + '</b></td><td class="num">' + kg('start') + '</td><td class="num">' + kg('in') + '</td><td class="num">' + kg('out') +
          '</td><td class="num">' + kg('sold') + '</td><td class="num">' + kg('lost') + '</td><td class="num">' + kg('countDiff') + '</td><td class="num"><b>' + kg('end') + '</b></td></tr>' +
          '</tbody></table></div>';
      }).join('') : '';
    // Empty jars and bottles: bought, used for packing, broken, and what the count found.
    var packIds = allItems().filter(function (it) { return it.category === 'Packaging'; }).map(function (it) { return it.id; });
    var contRows = Stock.flow(movements(), packIds, locs.map(function (l) { return l.id; }), ym + '-01', today())
      .filter(function (r) { return r.start || r.in || r.out || r.lost || r.countDiff || r.end; });
    var contHtml = contRows.length ? '<h2>' + esc(t('Empty jars and bottles in {month}', { month: monthName(ym) })) + '</h2>' +
      '<p class="muted small">' + t('Start + Bought − Used for packing − Broken ± Count = Now. A minus count means more containers were used than packing records show: jars filled and not recorded.') + '</p>' +
      '<div class="table-wrap"><table class="flow"><thead><tr><th>' + t('Container') + '</th><th class="num">' + t('Start') + '</th><th class="num">' + t('Bought') + '</th>' +
      '<th class="num">' + t('Used') + '</th><th class="num">' + t('Broken') + '</th><th class="num">±</th><th class="num">' + t('Now') + '</th></tr></thead><tbody>' +
      contRows.map(function (r) {
        var it = itemById(r.itemId) || { id: r.itemId, name: r.itemId, category: 'Packaging' };
        var where = locs.length > 1 && contRows.some(function (x) { return x.place !== r.place; }) ? ' · ' + locName(r.place) : '';
        return '<tr><td>' + esc(shortName(it)) + esc(where) + '</td><td class="num">' + qty(r.start) +
          '</td><td class="num">' + qty(r.in) + '</td><td class="num">' + qty(r.packOut) + '</td><td class="num' + (r.lost > 0 ? ' low' : '') + '">' + qty(r.lost) +
          '</td><td class="num' + (r.countDiff < 0 ? ' neg' : '') + '">' + signed(r.countDiff) + '</td><td class="num"><b>' + qty(r.end) + '</b></td></tr>';
      }).join('') + '</tbody></table></div>' : '';
    var waiting = Stock.pendingDeliveries(movements(), [], today());
    var waitHtml = waiting.length ? '<h2>' + t('Deliveries not confirmed yet') + '</h2><ul class="list">' + waiting.map(function (d) {
      var n = d.lines.reduce(function (s2, x) { return s2 + x.qty; }, 0);
      return '<li><span class="grow"><b>' + esc(locName(d.from)) + ' → ' + esc(locName(d.to)) + '</b><br><span class="muted small">' +
        esc(niceDate(d.date)) + ' · ' + esc(tn(n, '{n} item', '{n} items')) + ' · ' + esc(t('sent by {who}', { who: d.worker })) + '</span></span><span class="pill warn">⏳ ' + t('Waiting') + '</span></li>';
    }).join('') + '</ul>' : '';
    var table = '<h2>' + t('Stock now') + '</h2><div class="table-wrap"><table><thead><tr><th>' + t('Item') + '</th>' +
      locs.map(function (l) { return '<th class="num">' + esc(LANG === 'en' ? l.name.replace(/ Shop$/, '') : tr('places_short', l.id, locName(l.id))) + '</th>'; }).join('') +
      '<th class="num">' + t('Total') + '</th></tr></thead><tbody>' +
      s.stock.filter(function (x) { return x.item.active !== false || x.total !== 0; }).map(function (x) {
        return '<tr><td>' + esc(itemName(x.item)) + '<br><span class="muted small">' + esc(unitName(x.item.unit)) + '</span></td>' +
          locs.map(function (l) {
            var q = x.per[l.id];
            if (!Stock.kept(x.item, l.id) && !q) return '<td class="num muted">–</td>';
            var cls = q < 0 ? ' neg' : x.lowAt.indexOf(l.id) >= 0 ? ' low' : '';
            return '<td class="num' + cls + '">' + qty(q) + (q < 0 ? ' ⛔' : x.lowAt.indexOf(l.id) >= 0 ? ' ⚠' : '') + '</td>';
          }).join('') + '<td class="num">' + qty(x.total) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="muted small" style="margin-top:6px">' + t('⚠ at or below reorder level · ⛔ below zero: an entry is missing or wrong; the next count will correct it.') + '</p>';

    var topMax = s.top.length ? Math.max.apply(null, s.top.slice(0, 5).map(function (x) { return x.amount; }).concat([1])) : 1;
    var top = s.top.length ? '<h2>' + esc(t('Best sellers in {month}', { month: monthName(ym) })) + '</h2><ul class="list">' + s.top.slice(0, 5).map(function (x) {
      var it = itemById(x.itemId);
      return '<li class="with-thumb">' + thumb(it || { id: x.itemId }, true) + '<span class="grow">' + esc(it ? itemName(it) : x.itemId) +
        '<span class="hbar" aria-hidden="true"><span style="width:' + (x.amount / topMax * 100).toFixed(1) + '%"></span></span></span>' +
        '<span class="num small muted">' + qty(x.units) + ' ' + esc(it ? unitFor(x.units, it.unit) : '') +
        '</span><span class="num" style="min-width:96px">' + ksh(x.amount) + '</span></li>';
    }).join('') + '</ul>' : '';

    var gone = Stock.rejectedKeys(rejections());
    var allEntries = Stock.entries(allMovements());
    var recentEntries = allEntries.slice(0, 15);
    var recent = '<h2>' + t('Latest entries') + '</h2>' + (recentEntries.length
      ? '<p class="muted small">' + t('Reject an entry that is wrong: it stays in the sheet but is left out of stock and reports. You can restore it.') + '</p>' +
        '<ul class="list">' + recentEntries.map(function (e) { return entryLi(e, gone[e.key], true); }).join('') + '</ul>'
      : '<p class="muted">' + t('Nothing recorded yet.') + '</p>');
    var rejectedList = allEntries.filter(function (e) { return gone[e.key]; });
    var rejectedHtml = rejectedList.length ? '<details class="more"><summary>' + t('Rejected entries ({n})', { n: rejectedList.length }) + '</summary><ul class="list">' +
      rejectedList.map(function (e) { return entryLi(e, gone[e.key], true); }).join('') + '</ul></details>' : '';
    var checkList = Stock.checks(allMovements(), rejections(), today());
    var checkHtml = checkList.length ? checksHtml(checkList)
      : '<h2>' + t('Check these entries') + '</h2><p class="muted">✓ ' + t('Nothing looks wrong: no stock below zero, nothing saved twice, no delivery waiting too long.') + '</p>';

    var fresh = state.data && state.data.fetchedAt ? new Date(state.data.fetchedAt).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    // Five short tabs instead of one long page; the last one used is remembered.
    var tabs = [['overview', N('Overview')], ['sales', N('Sales')], ['stock', N('Stock')], ['honey', N('Honey')], ['entries', N('Entries')]];
    var tab = tabs.some(function (x) { return x[0] === state.prefs.dash; }) ? state.prefs.dash : 'overview';
    var nav = '<div class="dash-tabs" role="tablist" aria-label="' + esc(t('Dashboard sections')) + '">' + tabs.map(function (x) {
      return '<button type="button" role="tab" data-act="dash" data-dash="' + x[0] + '" aria-selected="' + (x[0] === tab) + '">' + t(x[1]) +
        (x[0] === 'entries' && checkList.length ? '<span class="badge" aria-label="' + esc(t('{n} to check', { n: checkList.length })) + '">' + checkList.length + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    var more = function (to, label) { return '<p class="see-more"><button type="button" class="btn link" data-act="dash" data-dash="' + to + '">' + label + ' →</button></p>'; };

    var body;
    if (tab === 'sales') {
      body = chart + byShop + top + lossHtml;
    } else if (tab === 'stock') {
      body = table + low + counts + adjHtml + waitHtml;
    } else if (tab === 'honey') {
      body = journey + inHtml + flowHtml + contHtml || '<p class="muted" style="margin-top:16px">' + t('No honey or jars moved this month yet.') + '</p>';
    } else if (tab === 'entries') {
      body = checkHtml + recent + rejectedHtml;
    } else {
      var attention = checkList.length
        ? '<button type="button" class="check-banner" data-act="dash" data-dash="entries"><span aria-hidden="true">⚠️</span><span class="grow"><b>' +
          tn(checkList.length, '{n} entry to check', '{n} entries to check') + '</b><br><span class="small">' + t('Stock below zero, saved twice or not confirmed') +
          '</span></span><span aria-hidden="true">›</span></button>'
        : '';
      var lowTop = '<h2>' + t('Low stock') + '</h2>' + (lowSorted.length ? '<ul class="list">' + lowSorted.slice(0, 3).map(lowLi).join('') + '</ul>' +
        (lowSorted.length > 3 ? more('stock', t('All {n} low items', { n: lowSorted.length })) : '') : '<p class="muted">✓ ' + t('Everything is above its reorder level.') + '</p>');
      var latest = recentEntries.length ? '<h2>' + t('Latest entries') + '</h2><ul class="list">' + recentEntries.slice(0, 5).map(function (e) { return entryLi(e, gone[e.key]); }).join('') + '</ul>' +
        more('entries', t('All entries')) : '';
      body = attention + tiles + lowTop + waitHtml + (win.closed ? '' : counts) + latest;
    }
    v.innerHTML = '<h1>' + t('Dashboard') + '</h1><p class="muted small">' + (DEMO ? t('Demo data') : esc(t('Updated {when}', { when: fresh }))) +
      ' · <button class="btn link" data-act="sync">' + t('Refresh') + '</button></p>' + nav + '<div class="dash-body">' + body + '</div>';
    if (tab === 'sales') wireChart();
  }

  // ---------- checking entries: reject, restore, keep ----------
  /** One entry (lines saved together) as a list row, with Reject or Restore for managers. */
  function entryLi(e, rejected, actions) {
    var line = function (m) {
      var it = itemById(m.itemId) || { name: m.itemId, unit: '' };
      return qty(m.qty) + ' ' + unitFor(m.qty, it.unit) + ' ' + itemName(it);
    };
    var shown = e.type === 'pack' ? e.lines.filter(function (m) { return m.to; }) : e.lines;
    if (!shown.length) shown = e.lines;
    var what = line(shown[0]) + (shown.length > 1 ? ' ' + t('+ {n} more', { n: shown.length - 1 }) : '');
    var where = e.type === 'transfer' ? locName(e.from) + ' → ' + locName(e.to)
      : e.type === 'sale' || e.type === 'loss' ? placeLabel(e.from) : locName(e.to || e.from);
    var extra = e.type === 'sale' ? ' · ' + ksh(e.lines.reduce(function (s, m) { return s + m.qty * m.price; }, 0))
      : e.type === 'transfer' ? ' · ' + (e.received ? t('confirmed by {who}', { who: e.received.by }) : t('not confirmed')) : '';
    var pending = e.lines.some(function (m) { return state.queue.some(function (q) { return q.id === m.id; }); });
    var right = pending ? '<span class="pill wait">' + t('waiting') + '</span>'
      : actions && isManager() ? '<button class="btn secondary small" data-act="' + (rejected ? 'restore' : 'reject') + '" data-key="' + esc(e.key) + '">' +
        (rejected ? t('Restore') : t('Reject')) + '</button>'
      : rejected ? '<span class="pill bad">' + t('Rejected') + '</span>' : '';
    return '<li' + (rejected ? ' class="rejected"' : '') + '><span class="muted small" style="width:48px">' + esc(niceDate(e.date)) + '</span>' +
      '<span class="grow"><b>' + esc(verb(e.type)) + '</b> ' + esc(what) +
      '<br><span class="muted small">' + esc(where) + esc(extra) + ' · ' + esc(e.worker) + '</span>' +
      (rejected ? '<br><span class="small reject-note">' + esc(t('Rejected by {who}: “{reason}”', { who: rejected.by, reason: rejected.reason })) + '</span>' : '') +
      '</span>' + right + '</li>';
  }

  /** The dashboard's "Check these entries": stock below zero, entries saved twice, deliveries never confirmed. */
  function checksHtml(list) {
    if (!list.length) return '';
    var cards = list.map(function (c) {
      var head;
      if (c.kind === 'negative') {
        var it = itemById(c.itemId) || { name: c.itemId, unit: '' };
        head = '⛔ ' + t('<b>{place}: {item} is at {n}.</b> Stock cannot be below zero: one of these entries is wrong, or the stock there was never counted.',
          { place: esc(locName(c.place)), item: esc(itemName(it)), n: qty(c.qty) });
      } else if (c.kind === 'twice') {
        head = '⧉ ' + t('<b>Saved twice?</b> These two entries are the same and were saved within a day of each other. Reject the extra one, or keep both if both really happened.');
      } else {
        head = '⏳ ' + t('<b>Delivery not confirmed after {days} days.</b> If it never came, reject it; if it came, the shop should confirm it.', { days: c.days });
      }
      var gone = {};
      return '<div class="check-card">' + '<p>' + head + '</p><ul class="list">' + c.entries.map(function (e) { return entryLi(e, gone[e.key], true); }).join('') + '</ul>' +
        (c.kind === 'twice' ? '<button class="btn secondary small" data-act="keep" data-key="' + esc(c.key) + '">' + t('Both are right') + '</button>' : '') + '</div>';
    }).join('');
    return '<h2>' + t('Check these entries ({n})', { n: list.length }) + '</h2>' + cards;
  }

  function entryText(key) {
    var e = Stock.entries(allMovements()).filter(function (x) { return x.key === key; })[0];
    if (!e) return '';
    var it = itemById(e.lines[0].itemId) || { name: e.lines[0].itemId, unit: '' };
    return verb(e.type) + ' ' + qty(e.lines[0].qty) + ' ' + unitFor(e.lines[0].qty, it.unit) + ' ' + itemName(it) +
      (e.lines.length > 1 ? ' ' + t('+ {n} more', { n: e.lines.length - 1 }) : '') + ', ' + niceDate(e.date) + ', ' + t('by {who}', { who: e.worker });
  }

  /** Records a reject / restore / keep in the sheet (needs signal), then refreshes. */
  function review(key, decision, reason) {
    var row = { key: key, action: decision, reason: reason || '', by: state.profile.name, at: new Date().toISOString() };
    if (DEMO) {
      state.data.rejections = rejections().concat([row]);
      save('data', state.data);
      render();
      return Promise.resolve(true);
    }
    if (state.reviewing) return Promise.resolve(false);
    state.reviewing = true;
    return api({ action: 'review', key: key, decision: decision, reason: reason || '' }).then(function (res) {
      if (!res.ok) throw res;
      if (!res.rejections) throw { error: 'update_backend' };  // the sheet still runs a script without 'review'
      state.data.rejections = res.rejections;
      save('data', state.data);
      return true;
    }).catch(function (err) {
      window.alert(err && err.error ? errorText(err.error) : t('No connection. This needs signal: try again when you have signal.'));
      return false;
    }).then(function (ok) {
      state.reviewing = false;
      render();
      if (ok) sync();
      return ok;
    });
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
    var fresh = state.data && state.data.fetchedAt ? new Date(state.data.fetchedAt).toLocaleString(locale()) : t('never');
    v.innerHTML = '<h1>' + esc(state.profile.name) + '</h1>' +
      '<div class="card">' +
      '<p><b>' + t('Waiting to send:') + '</b> ' + tn(myWaiting().length, '{n} entry', '{n} entries') + '</p>' +
      (othersWaiting().length ? '<p class="muted small">' + tn(othersWaiting().length, '{n} more by someone else waits for them to sign in here.', '{n} more by someone else wait for them to sign in here.') + '</p>' : '') +
      '<p><b>' + t('Last update from the sheet:') + '</b> ' + esc(DEMO ? t('demo') : fresh) + '</p>' +
      (state.lastError ? '<p class="err">' + esc(state.lastError) + '</p>' : '') +
      '<div class="btn-row"><button class="btn secondary" data-act="sync">' + t('Send and refresh now') + '</button></div>' +
      '</div>' +
      '<h2>' + t('Language') + '</h2>' + langSwitch() +
      (state.rejected.length ? '<h2>' + t('Refused by the sheet') + '</h2><p class="muted small">' + t('These were not saved in the sheet. Tell the manager, then clear them.') + '</p>' +
        '<ul class="list">' + state.rejected.map(function (m) {
          var why = {
            invalid: N('item or place no longer exists'), whole_number: N('only kg can have a point'), price: N('price below 0'),
            date: N('date is wrong'), no_delivery: N('that delivery is not in the sheet'), already_received: N('this delivery was already confirmed'),
          }[m.reason] || N('refused');
          return movementLi(m).replace('</span></span>', ' · <b>' + esc(t(why)) + '</b></span></span>');
        }).join('') + '</ul>' +
        '<div class="btn-row"><button class="btn secondary" data-act="clear-rejected">' + t('Clear this list') + '</button></div>' : '') +
      '<div class="btn-row">' +
      (DEMO ? '<button class="btn secondary" data-act="reset-demo">' + t('Reset demo data') + '</button>' : '') +
      '<button class="btn secondary" data-act="signout">' + t('Sign out') + '</button></div>' +
      '<p class="muted small" style="margin-top:16px">' + t('App version {v}.', { v: APP_VERSION }) + '</p>' +
      '<p class="muted small">' + t('Tip: add this app to your home screen. On Android open the browser menu (⋮) and tap “Add to Home screen”. It works with no signal; entries are sent when signal comes back.') + '</p>';
  }

  // ---------- events ----------
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-form],[data-act],[data-tab]');
    if (!el) return;
    var form = el.getAttribute('data-form');
    var act = el.getAttribute('data-act');
    var tab = el.getAttribute('data-tab');
    if (form) {
      if (el.closest('#mv') && !confirmLeave()) return; // a "go to count / check delivery" button inside a form
      var place = el.getAttribute('data-place');
      if (place) {
        state.prefs.shop = place;
        save('prefs', state.prefs);
      }
      state.receiving = form === 'receive' ? { batch: el.getAttribute('data-batch'), to: place } : null;
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
          !window.confirm(tn(state.queue.length, '{n} entry is not sent yet. It stays on this phone and is sent under the name of whoever made it, when that person (or a manager) signs in here again. Sign out?',
            '{n} entries are not sent yet. They stay on this phone and are sent under the name of whoever made them, when that person (or a manager) signs in here again. Sign out?'))) return;
      state.profile = null;
      save('profile', null);
      render();
    } else if (act === 'dash') {
      state.prefs.dash = el.getAttribute('data-dash');
      save('prefs', state.prefs);
      render();
      window.scrollTo(0, 0);
    } else if (act === 'reject') {
      var key = el.getAttribute('data-key');
      var why = window.prompt(t('Reject this entry?\n\n{entry}\n\nIt stays in the sheet but is left out of stock and reports. You can restore it later.\n\nWhy is it wrong?', { entry: entryText(key) }), '');
      if (why === null) return;
      if (!why.trim()) { window.alert(t('Write why it is wrong, so others understand.')); return; }
      review(key, 'reject', why.trim());
    } else if (act === 'restore') {
      if (!window.confirm(t('Put this entry back into the stock?\n\n{entry}', { entry: entryText(el.getAttribute('data-key')) }))) return;
      review(el.getAttribute('data-key'), 'restore', '');
    } else if (act === 'keep') {
      review(el.getAttribute('data-key'), 'keep', 'both are right');
    } else if (act === 'lang') {
      setLang(el.getAttribute('data-lang'));
      render();
    } else if (act === 'never-came') {
      var why2 = window.prompt(t('This delivery never came?\n\n{entry}\n\nIt will be taken off the record. The sender and the manager will see your reason.\n\nWhat happened?',
        { entry: entryText(el.getAttribute('data-key')) }), t('Never came'));
      if (why2 === null) return;
      if (!why2.trim()) { window.alert(t('Write what happened, so others understand.')); return; }
      review(el.getAttribute('data-key'), 'reject', why2.trim()).then(function (ok) {
        if (ok) { state.view = null; state.receiving = null; render(); }
      });
    } else if (act === 'clear-rejected') {
      state.rejected = [];
      save('rejected', []);
      render();
    } else if (act === 'reset-demo') {
      if (!window.confirm(t('Put the sample data back and delete your demo entries?'))) return;
      state.data = demoData();
      state.queue = [];
      save('data', state.data);
      save('queue', []);
      render();
    }
  });

  function confirmLeave() {
    var filled = document.querySelectorAll('#mv .item.filled').length;
    return !filled || window.confirm(t('Leave without saving? The numbers you typed will be lost.'));
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
