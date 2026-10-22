/** The product photos the app shows are the ones the offline cache stores, and every file is there. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Seed = require('../docs/seed.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '../docs', f), 'utf8');
const list = (src, re) => JSON.parse('[' + src.match(re)[1].replace(/'/g, '"') + ']').sort();

test('product photos: app list = offline cache list = files, all real items', () => {
  const app = list(read('app.js'), /var PHOTOS = \[([^\]]+)\]/);
  const sw = list(read('sw.js'), /\.concat\(\s*\/\/[^\n]*\n\s*\[([^\]]+)\]/);
  const files = fs.readdirSync(path.join(__dirname, '../docs/img/items')).map((f) => f.replace(/\.webp$/, '')).sort();
  assert.deepEqual(app, sw);
  assert.deepEqual(app, files);
  const ids = Seed.ITEMS.map((r) => r[0]);
  app.forEach((id) => assert.ok(ids.includes(id), id + ' is not an item'));
});
