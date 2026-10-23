/**
 * Languages: every text the app shows through t(), tn() or N() has a translation in docs/i18n.js,
 * with the same {placeholders} and the same HTML tags, and every item, group, unit and place in the
 * starting list has a translated name. Add a language by adding its dictionaries to docs/i18n.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I18N = require('../docs/i18n.js');
const Seed = require('../docs/seed.js');

const app = fs.readFileSync(path.join(__dirname, '../docs/app.js'), 'utf8');
const LIT = "'((?:[^'\\\\]|\\\\.)*)'";
// eslint-disable-next-line no-new-func
const unquote = (raw) => new Function("return '" + raw + "'")();

/** Every English text in app.js that is translated, from t('…'), N('…') and tn(n, '…', '…'). */
function appTexts() {
  const out = new Set();
  for (const m of app.matchAll(new RegExp('\\b(?:t|N)\\(\\s*' + LIT, 'g'))) out.add(unquote(m[1]));
  for (const m of app.matchAll(new RegExp('\\btn\\([^,()]+(?:\\(\\))?[^,()]*,\\s*' + LIT + '\\s*,\\s*' + LIT, 'g'))) {
    out.add(unquote(m[1]));
    out.add(unquote(m[2]));
  }
  return out;
}
const holes = (s) => (s.match(/\{\w+\}/g) || []).sort();
const tags = (s) => (s.match(/<\/?[a-z]+/g) || []);
const others = I18N.langs.map((l) => l[0]).filter((c) => c !== 'en');

test('i18n: a translated text is one quoted string (no + inside t(), so the test can find it)', () => {
  const joined = app.match(new RegExp('\\b(?:t|N)\\(\\s*' + LIT + '\\s*\\+', 'g')) || [];
  assert.deepEqual(joined, []);
  const tnCalls = (app.match(/\btn\((?!\))/g) || []).length - 1; // minus the definition (and "tn()" in comments)
  const tnFound = [...app.matchAll(new RegExp('\\btn\\([^,()]+(?:\\(\\))?[^,()]*,\\s*' + LIT + '\\s*,\\s*' + LIT, 'g'))].length;
  assert.equal(tnFound, tnCalls, 'every tn() call has a simple first argument and two quoted texts');
});

for (const lang of others) {
  test('i18n (' + lang + '): every text has a translation with the same placeholders and tags', () => {
    const dict = I18N[lang];
    const texts = appTexts();
    assert.ok(texts.size > 200, 'found ' + texts.size + ' texts');
    const missing = [...texts].filter((s) => !(s in dict));
    assert.deepEqual(missing, [], 'no translation for these texts');
    for (const s of texts) {
      assert.deepEqual(holes(dict[s]), holes(s), 'placeholders differ: ' + s);
      assert.deepEqual(tags(dict[s]), tags(s), 'HTML tags differ: ' + s);
      assert.ok(dict[s].trim(), 'empty translation: ' + s);
    }
  });

  test('i18n (' + lang + '): no leftover translations for texts the app no longer shows', () => {
    const texts = appTexts();
    assert.deepEqual(Object.keys(I18N[lang]).filter((s) => !texts.has(s)), []);
  });

  test('i18n (' + lang + '): items, groups, units and places have names', () => {
    const items = Seed.items();
    const need = (group, ids) => {
      const g = I18N[lang + '_' + group] || {};
      assert.deepEqual(ids.filter((id) => !g[id]), [], lang + '_' + group + ' is missing these');
    };
    need('items', items.map((i) => i.id));
    need('items_short', items.filter((i) => i.category === 'Honey' || i.category === 'Packaging').map((i) => i.id));
    need('cats', [...new Set(items.map((i) => i.category))]);
    const units = [...new Set(items.map((i) => i.unit))];
    need('units', units);
    need('units_many', units);
    need('places', Seed.locations().map((l) => l.id));
    need('places_short', Seed.locations().map((l) => l.id));
  });
}

test('i18n: the language file is cached for offline use and loaded before the app', () => {
  const sw = fs.readFileSync(path.join(__dirname, '../docs/sw.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
  assert.match(sw, /'i18n\.js'/);
  assert.ok(html.indexOf('i18n.js') > 0 && html.indexOf('i18n.js') < html.indexOf('app.js'));
});
