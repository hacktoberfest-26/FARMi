// FARMi cites real articles of the regulation and drops invented ones.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadKnowledge, parseModel, systemPrompt } = require('../server.js');

const secs = loadKnowledge();
const art2 = secs.find((s) => s.type === 'regolamento' && /Art\. 2/.test(s.heading));
const info = secs.find((s) => s.type !== 'regolamento');

test('regulation articles are loaded and flagged in the prompt', () => {
  assert.ok(art2, 'Art. 2 loaded');
  assert.match(systemPrompt(secs, null), /\(REGOLAMENTO\) Regolamento di campus \(esempio\) · Art\. 2 – Animali/);
});

test('a violation is reported with article and comma', () => {
  const raw = JSON.stringify({ answer: 'Il cane non può entrare in aula.', sources: [], actions: [], handoff: false, violation: { source: art2.id, ref: 'Art. 2, comma 1', quote: 'Gli animali non possono entrare in aule.' } });
  const out = parseModel(raw, secs);
  assert.deepEqual(out.violation, { doc: 'Regolamento di campus (esempio)', ref: 'Art. 2, comma 1', quote: 'Gli animali non possono entrare in aule.' });
  assert.equal(out.sources[0], art2.label);
});

test('invented articles or non-regulation sources are dropped', () => {
  assert.equal(parseModel(JSON.stringify({ answer: 'x', violation: { source: 'S999', ref: 'Art. 99' } }), secs).violation, null);
  assert.equal(parseModel(JSON.stringify({ answer: 'x', violation: { source: info.id, ref: 'Art. 1' } }), secs).violation, null);
});
