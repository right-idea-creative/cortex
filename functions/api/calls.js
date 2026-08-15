// functions/api/calls.js
// Cortex Call-Tracking API — serves the CTM dashboard payload to the UI.
// Replaces the n8n webhook (naterimc.app.n8n.cloud/webhook/8772e93a-...) so the
// dashboard no longer depends on Nate's personal n8n account. Same cut we made
// for alerts.
//
// Backed by BigQuery views in dataset `ctm_data` (all derived from
// ctm_calls_enriched) plus budget.spend_daily_unified for Google Ads spend.
//
// GET /api/calls -> { generated_at, clients, calls_daily, calls_heatmap, ads_daily }
// The shape mirrors exactly what call-tracking.html's normalize() expects:
//   calls_daily:   {date, client_name, channel, total_calls, missed_calls, answered_calls}
//   calls_heatmap: {client_name, day_of_week_sun1, hour_of_day, total_calls, missed_calls}
//   ads_daily:     {date, client_name, channel, spend_usd}
//
// Auth to BigQuery: JWT RS256 -> access token, same pattern as identity.js /
// alerts.js. Requires Cloudflare Pages secret GCP_SA_KEY. cortex-pages-writer@
// already has READER on dataset ctm_data + budget (granted for the alerts work).

const PROJECT = 'rightidea-cortex';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// ---------- Auth: JWT RS256 con Web Crypto -> access token ----------
// (clonado de alerts.js — mismo patron probado en produccion)

let tokenCache = { token: null, exp: 0 };

function b64urlFromString(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlFromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;

  const sa = JSON.parse(env.GCP_SA_KEY);

  const header = b64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlFromString(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/bigquery https://www.googleapis.com/auth/drive.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${b64urlFromBuffer(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`OAuth token exchange failed: ${JSON.stringify(data)}`);
  }
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.token;
}

// ---------- BigQuery query helper (jobs.query) ----------
// (clonado de alerts.js)
async function bqQuery(env, query, maxResults = 100000) {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, useLegacySql: false, maxResults, timeoutMs: 60000 }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`BigQuery query failed: ${JSON.stringify(data)}`);
  if (!data.jobComplete) throw new Error('Query did not complete in time');
  const fields = (data.schema && data.schema.fields || []).map(f => f.name);
  return (data.rows || []).map(r => {
    const o = {};
    r.f.forEach((cell, i) => {
      o[fields[i]] = Array.isArray(cell.v) ? cell.v.map(x => x.v) : cell.v;
    });
    return o;
  });
}

// BQ devuelve TODOS los valores como STRING en la REST API. Los charts hacen
// aritmetica (reduce/+), asi que numeros vienen casteados aca, no en el cliente.
const n = v => (v == null ? 0 : Number(v));

// ---------- Route ----------
export async function onRequestGet(context) {
  try {
    const env = context.env;

    // Ventana: el dashboard filtra hasta 90 dias en el cliente. Traigo 100 para
    // cubrir el boton "90 days" con margen. ponytail: ventana fija 100d; si algun
    // dia se pide >90d, subir este literal (o parametrizar por querystring).
    const WINDOW_DAYS = 100;

    const [callsDaily, heatmap, adsDaily] = await Promise.all([
      // calls_daily: campo se llama `date` en el frontend, la vista da `call_date`
      bqQuery(env,
        `SELECT CAST(call_date AS STRING) AS date, client_name, channel,
                total_calls, missed_calls, answered_calls
         FROM \`${PROJECT}.ctm_data.ctm_calls_daily\`
         WHERE call_date >= DATE_SUB(CURRENT_DATE(), INTERVAL ${WINDOW_DAYS} DAY)`),

      // heatmap: sin filtro de fecha — es agregado hora x dia sobre toda la historia
      bqQuery(env,
        `SELECT client_name, day_of_week_sun1, hour_of_day, total_calls, missed_calls
         FROM \`${PROJECT}.ctm_data.ctm_calls_heatmap\``),

      // ads_daily: spend Google Ads grano dia+cliente.
      // spend_daily_unified usa channel='google_ads' (lowercase); el frontend
      // lee r.channel==='Google Ads', asi que se traduce el literal aca.
      // ponytail: MISMATCH DE NOMBRES DE CLIENTE — spend_daily_unified.client
      // ('RJ Nelson Co.', "DJ's Dugout") NO calza con ctm_calls_enriched.client_name
      // ('RJ Nelson') en ~31 de 79 clientes. En vista "All Clients" suma bien;
      // filtrando por un cliente afectado, su spend/CPC sale en 0. Preexistente
      // (el webhook de n8n tenia el mismo problema). Upgrade: normalizar ambos
      // vocabularios contra reference.client_mapping antes de servir. Ticket aparte.
      bqQuery(env,
        `SELECT CAST(date AS STRING) AS date, client AS client_name,
                'Google Ads' AS channel, actual AS spend_usd
         FROM \`${PROJECT}.budget.spend_daily_unified\`
         WHERE channel = 'google_ads'
           AND date >= DATE_SUB(CURRENT_DATE(), INTERVAL ${WINDOW_DAYS} DAY)`),
    ]);

    // Cast numerico (REST API entrega strings)
    const calls_daily = callsDaily.map(r => ({
      date: r.date, client_name: r.client_name, channel: r.channel,
      total_calls: n(r.total_calls), missed_calls: n(r.missed_calls),
      answered_calls: n(r.answered_calls),
    }));
    const calls_heatmap = heatmap.map(r => ({
      client_name: r.client_name,
      day_of_week_sun1: n(r.day_of_week_sun1), hour_of_day: n(r.hour_of_day),
      total_calls: n(r.total_calls), missed_calls: n(r.missed_calls),
    }));
    const ads_daily = adsDaily.map(r => ({
      date: r.date, client_name: r.client_name, channel: r.channel,
      spend_usd: n(r.spend_usd),
    }));

    // clients: union de nombres de calls + ads, ordenado (igual que el webhook)
    const clients = [...new Set([
      ...calls_daily.map(r => r.client_name),
      ...ads_daily.map(r => r.client_name),
    ])].filter(Boolean).sort();

    return json({
      generated_at: new Date().toISOString().slice(0, 10),
      clients,
      calls_daily,
      calls_heatmap,
      ads_daily,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
