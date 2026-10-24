#!/usr/bin/env node
// Interactive setup: writes .env and tests the connection to Gemma 4.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines$ = rl[Symbol.asyncIterator]();
const ask = async (q, d) => {
  process.stdout.write(d ? `${q} [${d}]: ` : `${q}: `);
  const { value, done } = await lines$.next();
  if (!process.stdin.isTTY) process.stdout.write((done ? '' : value) + '\n');
  return ((done ? '' : value) || '').trim() || d || '';
};

(async () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) { console.error(`Serve Node.js 18 o più recente (hai ${process.version}). Scaricalo da https://nodejs.org`); process.exit(1); }

  console.log('\n  FARMi · configurazione di Gemma 4\n');
  console.log('  1) Google AI Studio  – gratis, nessuna GPU, serve solo una chiave API (consigliato)');
  console.log('  2) Ollama            – il modello gira sul tuo PC, nessuna chiave, serve RAM/GPU');
  const demo = (fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').match(/DEFAULT_DEMO_SERVER = '([^']*)'/) || [])[1] || '';
  console.log('  3) Server demo       – nessuna chiave: usa la demo online del team' + (demo ? ` (${demo})` : '') + '\n');
  const choice = await ask('  Scegli 1, 2 o 3', demo ? '3' : '1');
  const lines = ['# Generato da "npm run setup". Non committare questo file.', 'PORT=' + (await ask('  Porta del server', '3000'))];

  if (choice === '3') {
    const url = await ask('  Indirizzo del server demo', demo);
    if (!url) { console.error('\n  Serve l\'indirizzo del server demo (es. https://farmi.onrender.com).'); process.exit(1); }
    lines.push('LLM_PROVIDER=remote', 'REMOTE_URL=' + url.replace(/\/$/, ''));
  } else if (choice === '2') {
    lines.push('LLM_PROVIDER=ollama');
    lines.push('OLLAMA_URL=' + (await ask('  Indirizzo di Ollama', 'http://localhost:11434')));
    lines.push('OLLAMA_MODEL=' + (await ask('  Modello (gemma4 = E4B, gemma4:e2b per PC leggeri, gemma4:26b se hai 16 GB+ di VRAM)', 'gemma4')));
    console.log('\n  Ricorda: installa Ollama da https://ollama.com e poi lancia  ollama pull ' + lines[lines.length - 1].split('=')[1]);
  } else {
    console.log('\n  Crea una chiave gratuita qui: https://aistudio.google.com/apikey\n');
    const key = await ask('  Incolla la chiave GEMINI_API_KEY');
    if (!key) { console.error('\n  Nessuna chiave inserita. Riesegui "npm run setup" quando ce l\'hai.'); process.exit(1); }
    lines.push('LLM_PROVIDER=google', 'GEMINI_API_KEY=' + key);
    lines.push('GEMMA_MODEL=' + (await ask('  Modello (gemma-4-26b-a4b-it è più veloce, gemma-4-31b-it più accurato)', 'gemma-4-26b-a4b-it')));
  }
  rl.close();
  fs.writeFileSync(ENV, lines.join('\n') + '\n');
  console.log('\n  ✓ Salvato .env');

  // Quick live test with the same code the server uses.
  for (const l of lines) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2]; }
  delete require.cache[require.resolve('../server.js')];
  const { server } = require('../server.js');
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  process.stdout.write('  … provo a chiedere a Gemma 4 gli orari dello Student Office … ');
  try {
    const r = await fetch(`http://localhost:${port}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', text: 'A che ora apre lo Student Office?' }] }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    console.log('ok\n\n  FARMi: ' + j.answer + (j.sources.length ? '\n  Fonti: ' + j.sources.join(' · ') : '') + `\n  (${j.model}, ${j.ms} ms)`);
    console.log('\n  Tutto pronto. Avvia con:  npm start\n');
  } catch (e) {
    console.log('errore\n\n  ✗ ' + e.message + '\n  La configurazione è salvata: correggi e riprova, oppure avvia comunque con "npm start" (la chat userà le risposte demo).\n');
  } finally { server.close(); }
})();
