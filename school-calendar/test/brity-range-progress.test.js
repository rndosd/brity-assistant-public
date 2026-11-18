'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the Electron import handler without opening the messenger in CI.
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = main.indexOf('async function importRange(');
const end = main.indexOf('\n}', start) + 2;

async function simulate(batches) {
  let calls = 0;
  const context = {
    rangeDays: (from, to) => ({ from, to }), rangeReady() {}, publish() {},
    collectorOptions: {}, lifetime: {}, closing: false, goeEdition: false,
    rangeImport: null, collectorRun: null, snapshot() {}, refresh: async () => {},
    store: { refresh: async () => {}, rangePending: () => [] },
    collectRange: async () => {
      calls++;
      assert.ok(calls <= batches.length, 'Repeated a batch that made no progress');
      return { status: 'ready', ...batches[calls - 1] };
    }
  };
  const result = await vm.runInNewContext(main.slice(start, end) +
    "\nimportRange('2026-11-01', '2026-11-18')", context);
  return { result, calls };
}

test('when nine Brity rows yield no confirmed notes, stop once and report all nine', async () => {
  const { result, calls } = await simulate([{ opened: 9, imported: 0, remaining: 9 }]);
  assert.equal(calls, 1);
  assert.equal(result.unreadableNotes, 9);
  assert.equal(result.imported, 0);
});

test('keep earlier imports when a later Brity batch cannot read details', async () => {
  const { result, calls } = await simulate([
    { opened: 20, imported: 20, remaining: 9 },
    { opened: 9, imported: 0, remaining: 9 }
  ]);
  assert.equal(calls, 2);
  assert.equal(result.imported, 20);
  assert.equal(result.unreadableNotes, 9);
});
