// functions/api/alerts.js
// Cortex Alerts API — serves active campaign-health alerts to the UI.
// Backed by BigQuery (rightidea-cortex.transformed.alerts_active), a UNION
// of the per-type alert views (campaign_suspended, ads_disapproved,
// overspend, no_spend).
//
// GET /api/alerts  -> { rows: [...], as_of }  (performance.view gated by shell)
//
// Auth to BigQuery: JWT RS256 -> access token, same pattern as identity.js /
// budget-events.js. Requires Cloudflare Pages secret GCP_SA_KEY. The SA reads
// dataset `transformed` via projectReaders (no extra grant needed) plus
// project-level jobUser to run the query.

const PROJECT = 'rightidea-cortex';
const ALERTS_VIEW = 'transformed.alerts_active';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// ---------- Auth: JWT RS256 con Web Crypto -> access token ----------
// (clonado de identity.js — mismo patron probado en produccion)

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
// (clonado de identity.js)
async function bqQuery(env, query, maxResults = 1000) {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, useLegacySql: false, maxResults }),
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

// ---------- Route ----------
export async function onRequestGet(context) {
  try {
    const rows = await bqQuery(
      context.env,
      `SELECT alert_type, severity, source, customer_id, client_name,
              account_manager, tier, sub_mcc, av_status, entity_id,
              entity_name, detail, detected_at
       FROM \`${PROJECT}.${ALERTS_VIEW}\`
       ORDER BY severity, alert_type, client_name`
    );
    const asOf = rows.length && rows[0].detected_at ? rows[0].detected_at : new Date().toISOString();
    return json({ rows, as_of: asOf });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
