#!/usr/bin/env node
// FARMi · H-OS demo server
// Serves the app (public/), reads the knowledge base (knowledge/*.md) on every request
// and forwards chat messages to Gemma 4 (Google AI Studio API or a local Ollama).
// Zero dependencies: Node 18+ only.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const os = require('os');

// Public demo server of the team. Anyone who clones the repo without an API key
// chats through it, so the team's key never leaves the hosting provider.
// Fill this in after the first deploy (see README → "Mettere la demo online").
const DEFAULT_DEMO_SERVER = '';

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));

const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const REMOTE = (process.env.REMOTE_URL || DEFAULT_DEMO_SERVER).replace(/\/$/, '');
const CFG = {
  port: Number(process.env.PORT) || 3000,
  // explicit LLM_PROVIDER wins; otherwise: own key → google, no key → team demo server
  provider: (process.env.LLM_PROVIDER || (KEY ? 'google' : REMOTE ? 'remote' : 'google')).toLowerCase(),
  googleKey: KEY,
  remoteUrl: REMOTE,
  // protects the free quota when the server is public
  ratePerMin: Number(process.env.RATE_LIMIT_PER_MIN) || 8,
  ratePerDay: Number(process.env.RATE_LIMIT_PER_DAY) || 150,
  dailyCap: Number(process.env.DAILY_CAP) || 1200,
  googleModel: process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it',
  googleBase: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
  ollamaUrl: (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'gemma4',
  knowledgeDir: path.join(ROOT, process.env.KNOWLEDGE_DIR || 'knowledge'),
  publicDir: path.join(ROOT, 'public'),
};

/* ------------------------------------------------------------------ env */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

/* ------------------------------------------------------------ knowledge */
// Each .md file is split by "## " headings. Every section gets an id (S1, S2, …)
// that the model must cite; the server turns ids back into readable labels,
// so a citation can never point to a document that does not exist.
function loadKnowledge() {
  if (!fs.existsSync(CFG.knowledgeDir)) return [];
  const files = fs.readdirSync(CFG.knowledgeDir).filter((f) => f.endsWith('.md')).sort();
  const sections = [];
  for (const f of files) {
    let raw = fs.readFileSync(path.join(CFG.knowledgeDir, f), 'utf8').replace(/\r\n/g, '\n');
    let title = f.replace(/\.md$/, ''), type = 'info';
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fm) {
      const t = fm[1].match(/^title:\s*(.+)$/m);
      if (t) title = t[1].trim();
      const ty = fm[1].match(/^type:\s*(.+)$/m);
      if (ty) type = ty[1].trim().toLowerCase();
      raw = raw.slice(fm[0].length);
    }
    const parts = raw.split(/^## /m);
    const intro = parts.shift().trim();
    if (!parts.length && intro) parts.push('Generale\n' + intro);
    for (const p of parts) {
      const nl = p.indexOf('\n');
      const heading = (nl < 0 ? p : p.slice(0, nl)).trim();
      const body = (nl < 0 ? '' : p.slice(nl + 1)).trim();
      if (!body) continue;
      sections.push({ id: 'S' + (sections.length + 1), file: f, title, type, heading, label: title + ' · ' + heading, body });
    }
  }
  return sections;
}

/* --------------------------------------------------------------- prompt */
const ACTIONS_HELP = [
  'go:first → apre la sezione Prima matricola',
  'open:parking → apre il Parcheggio con la posizione dell\'auto',
  'park:<CODICE> → guida a piedi verso un posto auto o una colonnina (es. park:EV-3, park:C-2)',
  'route:<luogo> → mappa del campus; luoghi: so (Student Office), gym, am (Aula Magna), a3 (Aula 3), lib (biblioteca), serra, basta, lounge, park, gate',
  'say:<testo> → risposta rapida che l\'utente può toccare (es. say:Sì, prenota)',
].join('\n');
const ACTION_RE = /^(go:first|open:parking|park:(EV-\d{1,2}|[A-J]-\d{1,2})|route:(so|gym|am|a3|lib|serra|basta|lounge|park|gate)|say:.{1,80})$/;

function systemPrompt(sections, live) {
  const kb = sections.map((s) => `[${s.id}]${s.type === 'regolamento' ? ' (REGOLAMENTO)' : ''} ${s.label}\n${s.body}`).join('\n\n');
  return `Sei FARMi, l'assistente del campus H-FARM (Ca' Tron, Roncade) dentro l'app H-FARM Campus. Parli con uno studente.

REGOLE
- Rispondi nella lingua dell'utente (di default italiano), in modo caldo e breve: massimo 3-4 frasi.
- Usa SOLO le FONTI e il CONTESTO LIVE qui sotto. Non inventare orari, prezzi, persone o regole.
- Cita sempre gli id delle fonti che hai usato (es. ["S3"]). Se usi il contesto live, aggiungi "LIVE".
- Se la risposta non è nelle fonti, oppure riguarda soldi, eccezioni, salute o dati personali: non improvvisare, metti "handoff": true e spiega che passi la domanda allo Student Office con un riepilogo della chat.
- REGOLAMENTO: le fonti marcate (REGOLAMENTO) sono regole vincolanti, divise in articoli e commi numerati.
  · Se l'utente chiede di fare qualcosa che un articolo vieta o limita, dillo chiaramente e con gentilezza: "Non è consentito dal regolamento", cita articolo e comma (es. "Art. 2, comma 1"), riassumi la regola in una frase e, se esiste, proponi l'alternativa consentita. Compila "violation".
  · Se la richiesta è consentita solo a certe condizioni (es. un'eccezione), spiega le condizioni citando il comma.
  · Non inventare mai articoli o commi: se nessuna regola ne parla, dillo e metti "handoff": true.
- Non dire mai di aver già prenotato, pagato o inviato qualcosa: puoi solo proporre azioni come pulsanti; l'app le esegue quando l'utente le tocca.
- Prenotazione dei corsi in palestra e ordini ai ristoranti si fanno nelle sezioni Palestra e Ristoranti dell'app H-FARM Campus: puoi dare orari, menu e regole, ma non prenotare né ordinare.
- Puoi usare **grassetto** per orari e luoghi. Niente elenchi lunghi.

AZIONI DISPONIBILI (massimo 3 per risposta, solo se utili)
${ACTIONS_HELP}

FORMATO: rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo:
{"answer":"...","sources":["S1"],"actions":[{"label":"Testo del pulsante","do":"open:parking"}],"handoff":false,"violation":null}
Quando una richiesta viola il regolamento: "violation":{"source":"S30","ref":"Art. 2, comma 1","quote":"la regola in breve"}

FONTI (knowledge base)
${kb || '(nessun documento caricato)'}

CONTESTO LIVE DELL'APP (fonte "LIVE", dati in tempo reale)
${live ? JSON.stringify(live, null, 1) : '(non disponibile)'}`;
}

/* ------------------------------------------------------------ providers */
async function callGoogle(system, history) {
  if (!CFG.googleKey) throw httpErr(503, 'Manca GEMINI_API_KEY nel file .env. Esegui "npm run setup".');
  const url = `${CFG.googleBase}/v1beta/models/${encodeURIComponent(CFG.googleModel)}:generateContent`;
  const contents = history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
  const attempt = async (strict) => {
    const body = strict
      ? { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } }
      : { contents: [{ role: 'user', parts: [{ text: system + '\n\n---\nInizio conversazione.' }] }, { role: 'model', parts: [{ text: '{"answer":"Ok","sources":[],"actions":[],"handoff":false}' }] }, ...contents], generationConfig: { temperature: 0.3 } };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': CFG.googleKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  };
  let { status, j } = await attempt(true);
  // Some models/versions reject systemInstruction or JSON mode: retry in compatibility mode.
  if (status === 400) ({ status, j } = await attempt(false));
  if (status === 429) throw httpErr(429, 'Limite gratuito di Google AI Studio raggiunto. Riprova tra un minuto.');
  if (status >= 400) throw httpErr(502, 'Google AI Studio: ' + ((j.error && j.error.message) || 'errore ' + status));
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  return parts.filter((p) => !p.thought && p.text).map((p) => p.text).join('');
}

async function callOllama(system, history) {
  const r = await fetch(CFG.ollamaUrl + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CFG.ollamaModel, stream: false, format: 'json', options: { temperature: 0.3 }, messages: [{ role: 'system', content: system }, ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }))] }),
    signal: AbortSignal.timeout(180000),
  }).catch(() => { throw httpErr(503, `Ollama non risponde su ${CFG.ollamaUrl}. Hai avviato Ollama e scaricato il modello (ollama pull ${CFG.ollamaModel})?`); });
  const j = await r.json().catch(() => ({}));
  if (r.status >= 400) throw httpErr(502, 'Ollama: ' + (j.error || 'errore ' + r.status));
  return (j.message && j.message.content) || '';
}

async function callRemote(body) {
  if (!CFG.remoteUrl) throw httpErr(503, 'Nessuna chiave API e nessun server demo configurato. Esegui "npm run setup".');
  const r = await fetch(CFG.remoteUrl + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) })
    .catch(() => { throw httpErr(503, 'Il server demo non risponde (' + CFG.remoteUrl + '). Se è appena stato svegliato riprova tra 30 secondi.'); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(r.status, j.error || 'Server demo: errore ' + r.status);
  return j;
}

/* ----------------------------------------------------------- rate limit */
const hits = new Map(); let day = '', dayCount = 0;
function rateLimit(ip) {
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; hits.clear(); }
  const h = hits.get(ip) || { min: [], day: 0 };
  h.min = h.min.filter((t) => now - t < 60000);
  if (dayCount >= CFG.dailyCap) throw httpErr(429, 'FARMi ha finito le risposte AI di oggi per la demo. Torna domani!');
  if (h.day >= CFG.ratePerDay) throw httpErr(429, 'Hai raggiunto il limite di domande di oggi per la demo.');
  if (h.min.length >= CFG.ratePerMin) throw httpErr(429, 'Troppe domande in un minuto: aspetta qualche secondo.');
  h.min.push(now); h.day++; dayCount++; hits.set(ip, h);
}
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '').trim();
}

/* --------------------------------------------------------------- answer */
function parseModel(text, sections) {
  let o = null;
  const clean = String(text).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { o = JSON.parse(clean); } catch {
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) { try { o = JSON.parse(clean.slice(a, b + 1)); } catch {} }
  }
  if (!o || typeof o !== 'object') o = { answer: clean, sources: [], actions: [], handoff: false };
  const byId = Object.fromEntries(sections.map((s) => [s.id, s]));
  const src = [];
  for (const id of [].concat(o.sources || [])) {
    const k = String(id).trim().replace(/^\[|\]$/g, '').toUpperCase();
    const label = k === 'LIVE' ? 'Dati live dell\'app' : byId[k] && byId[k].label;
    if (label && !src.includes(label)) src.push(label);
  }
  const actions = [].concat(o.actions || [])
    .filter((a) => a && typeof a.label === 'string' && typeof a.do === 'string' && ACTION_RE.test(a.do.trim()))
    .slice(0, 3).map((a) => ({ label: a.label.slice(0, 40), do: a.do.trim() }));
  let violation = null;
  const v = o.violation;
  if (v && typeof v === 'object') {
    const sec = byId[String(v.source || '').trim().replace(/^\[|\]$/g, '').toUpperCase()];
    const ref = String(v.ref || '').trim().slice(0, 60);
    // only real articles of a real regulation, never invented ones
    if (sec && sec.type === 'regolamento' && /art/i.test(ref)) {
      violation = { doc: sec.title, ref, quote: String(v.quote || '').trim().slice(0, 220) };
      if (!src.includes(sec.label)) src.unshift(sec.label);
    }
  }
  return { answer: String(o.answer || '').trim() || 'Non ho trovato una risposta.', sources: src, actions, handoff: !!o.handoff, violation };
}

async function chat(body) {
  const sections = loadKnowledge();
  const history = [].concat(body.messages || [])
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text.slice(0, 2000) }));
  if (!history.length || history[history.length - 1].role !== 'user') throw httpErr(400, 'Serve almeno un messaggio utente.');
  if (CFG.provider === 'remote') return callRemote({ messages: history, live: body.live });
  const system = systemPrompt(sections, body.live);
  const t0 = Date.now();
  const raw = CFG.provider === 'ollama' ? await callOllama(system, history) : await callGoogle(system, history);
  const out = parseModel(raw, sections);
  out.model = activeModel();
  out.ms = Date.now() - t0;
  return out;
}

/* ----------------------------------------------------------------- http */
function activeModel() { return CFG.provider === 'ollama' ? 'ollama/' + CFG.ollamaModel : CFG.provider === 'remote' ? 'Gemma 4 · server demo' : CFG.googleModel; }
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function send(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
const MIME = { '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/health') {
      const ready = CFG.provider === 'ollama' || (CFG.provider === 'remote' ? !!CFG.remoteUrl : !!CFG.googleKey);
      return send(res, 200, { ok: true, ready, provider: CFG.provider, model: activeModel(), docs: loadKnowledge().length });
    }
    if (url.pathname === '/api/knowledge') {
      return send(res, 200, loadKnowledge().map(({ id, file, label, body }) => ({ id, file, label, chars: body.length })));
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      let data = '';
      for await (const c of req) { data += c; if (data.length > 200000) throw httpErr(413, 'Richiesta troppo grande'); }
      if (CFG.provider !== 'remote') rateLimit(clientIp(req));
      return send(res, 200, await chat(JSON.parse(data || '{}')));
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Metodo non consentito' });
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(CFG.publicDir, rel));
    if (!file.startsWith(CFG.publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'Non trovato' });
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || ext === '.js' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=86400' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.message || 'Errore interno' });
  }
});

if (require.main === module) {
  server.listen(CFG.port, () => {
    const n = loadKnowledge().length;
    const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`\n  FARMi è pronto su  http://localhost:${CFG.port}`);
    if (lan.length) console.log(`  Dal telefono (stessa Wi-Fi):  http://${lan[0]}:${CFG.port}`);
    console.log('');
    console.log(`  Modello:    ${activeModel()} (${{ ollama: 'Ollama locale', remote: CFG.remoteUrl, google: 'Google AI Studio' }[CFG.provider] || CFG.provider})`);
    console.log(`  Knowledge:  ${n} sezioni da ${path.relative(ROOT, CFG.knowledgeDir)}/ (modifica i .md: vale dalla domanda successiva)`);
    if (CFG.provider === 'google' && !CFG.googleKey) console.log('\n  ⚠  Manca GEMINI_API_KEY: esegui "npm run setup". Intanto la chat usa le risposte demo offline.');
    console.log('');
  });
}

module.exports = { server, loadKnowledge, parseModel, systemPrompt, CFG };
