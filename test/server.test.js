// Runs without network: a fake Gemini endpoint stands in for Google AI Studio.
'use strict';
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const http = require('http');

let lastBody = null, calls = 0, rejectStrict = false;
const fake = http.createServer(async (req, res) => {
  let d = ''; for await (const c of req) d += c;
  lastBody = JSON.parse(d); calls++;
  if (rejectStrict && lastBody.systemInstruction) { res.writeHead(400); return res.end(JSON.stringify({ error: { message: 'systemInstruction not supported' } })); }
  const reply = { answer: 'Lo Student Office apre alle **9:00**.', sources: ['S1', 'LIVE', 'S999'], actions: [{ label: 'Portami lì', do: 'route:so' }, { label: 'hack', do: 'javascript:alert(1)' }], handoff: false };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '```json\n' + JSON.stringify(reply) + '\n```' }] } }] }));
});

let base, app;
before(async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.GEMINI_BASE_URL = 'http://127.0.0.1:' + fake.address().port;
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.LLM_PROVIDER = 'google';
  process.env.RATE_LIMIT_PER_MIN = '4';
  app = require('../server.js').server;
  await new Promise((r) => app.listen(0, r));
  base = 'http://127.0.0.1:' + app.address().port;
});
after(() => { app.close(); fake.close(); });

const chat = (text) => fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', text }], live: { colonnine_libere: ['EV-2'] } }) }).then(async (r) => ({ status: r.status, j: await r.json() }));

test('health reports model and knowledge', async () => {
  const j = await (await fetch(base + '/api/health')).json();
  assert.equal(j.ready, true);
  assert.equal(j.model, 'gemma-4-26b-a4b-it');
  assert.ok(j.docs >= 10, 'knowledge sections loaded');
});

test('chat cites real sources only and filters unsafe actions', async () => {
  const { status, j } = await chat('A che ora apre lo Student Office?');
  assert.equal(status, 200);
  assert.match(j.answer, /9:00/);
  assert.deepEqual(j.sources, ['Guida per le matricole · Student Office · Orari dello Student Office', "Dati live dell'app"]);
  assert.deepEqual(j.actions, [{ label: 'Portami lì', do: 'route:so' }]);
  const sys = lastBody.systemInstruction.parts[0].text;
  assert.match(sys, /\[S1\] Guida per le matricole/);
  assert.match(sys, /EV-2/, 'live context is in the prompt');
});

test('falls back to compatibility mode when systemInstruction is rejected', async () => {
  rejectStrict = true; calls = 0;
  const { status, j } = await chat('Ciao');
  rejectStrict = false;
  assert.equal(status, 200);
  assert.equal(calls, 2);
  assert.ok(j.answer.length > 0);
});

test('serves the app', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /GEMMA 4/);
  assert.equal((await fetch(base + '/../server.js')).status, 404);
});

test('rate limit protects the free quota', async () => {
  let last;
  for (let i = 0; i < 3; i++) last = await chat('ancora una domanda');
  assert.equal(last.status, 429);
  assert.match(last.j.error, /minuto/);
});

test('PWA files are served', async () => {
  const m = await fetch(base + '/manifest.webmanifest');
  assert.equal(m.headers.get('content-type'), 'application/manifest+json');
  assert.equal((await m.json()).display, 'standalone');
  assert.equal((await fetch(base + '/sw.js')).status, 200);
  assert.equal((await fetch(base + '/icons/apple-touch-icon.png')).status, 200);
});
