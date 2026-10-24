// A clone without API key forwards the chat to the team's demo server.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

let demo, child, base, seen = null;
test.before(async () => {
  demo = http.createServer(async (req, res) => {
    let d = ''; for await (const c of req) d += c; seen = JSON.parse(d);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answer: 'Ciao dal server demo', sources: ['Guida · Test'], actions: [], handoff: false, model: 'gemma-4-26b-a4b-it' }));
  });
  await new Promise((r) => demo.listen(0, r));
  const port = 3900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, PORT: String(port), REMOTE_URL: 'http://127.0.0.1:' + demo.address().port };
  delete env.GEMINI_API_KEY; delete env.LLM_PROVIDER;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, cwd: '/' , stdio: 'ignore' });
  base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
test.after(() => { child.kill(); demo.close(); });

test('without a key the chat goes through the demo server', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.provider, 'remote');
  assert.equal(h.ready, true);
  const r = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', text: 'ciao' }], live: { x: 1 } }) });
  const j = await r.json();
  assert.equal(j.answer, 'Ciao dal server demo');
  assert.deepEqual(seen.live, { x: 1 });
});
