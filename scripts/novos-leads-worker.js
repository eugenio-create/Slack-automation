'use strict';

// Run on an always-on host, not inside a serverless function/GitHub Actions.
// Configuration comes from the process environment, never command arguments.
const url = process.env.NOVOS_LEADS_URL;
const secret = process.env.NOVOS_LEADS_SECRET;
if (!url || !secret || new URL(url).protocol !== 'https:') {
  console.error('Configure NOVOS_LEADS_URL (HTTPS) e NOVOS_LEADS_SECRET.');
  process.exit(1);
}
let stopping = false;
let timer;
const controller = new AbortController();
function stop() { stopping = true; clearTimeout(timer); controller.abort(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
async function tick() {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'x-notif-secret': secret }, redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(55000)])
    });
    const result = await response.json();
    console.log(JSON.stringify({ at: new Date().toISOString(), status: response.status,
      ok: result.ok === true, sent: result.sent || 0, code: result.code || null,
      errors: Array.isArray(result.errors) ? result.errors.length : 0 }));
  } catch {
    if (!stopping) console.error('Falha na chamada; próxima tentativa no próximo minuto.');
  }
  // One request at a time, on a 60-second cadence. No overlapping background work.
  if (!stopping) timer = setTimeout(tick, Math.max(0, 60000 - (Date.now() - start)));
}
tick();
