// functions/api/call-attribution.js
// Cortex Call-Attribution API — sirve el tablero de atribucion de llamadas + gap
// vs conversiones de Google Ads.
//
// Distinto de calls.js (el tablero operativo): este lee de la vista de atribucion
// fina ctm_data.calls_attribution (google_paid / gbp / google_organic separados)
// y la cruza con raw_google_ads para el "gap" Google-Ads-vs-CTM (Test B).
//
// Auth/bqQuery clonados de calls.js (patron probado, mismo secret GCP_SA_KEY,
// cortex-pages-writer@ ya tiene READER en ctm_data + raw_google_ads).
//
// GET /api/call-attribution?month=YYYY-MM
//   -> { generated_at, month, clients, by_channel, gads_conversions }
//   by_channel:       {month, client_name, channel, total, period_unique}
//   gads_conversions: {month, customer_id, conv_google}   (PHONE_CALL_LEAD)
// El frontend cruza gads_conversions con by_channel(google_paid) por customer_id.

const PROJECT = 'rightidea-cortex';

// MCC de Google Ads: el nombre de tabla lleva el id del MCC, pero customer_id
// (columna) es el cliente real, asi que cubre TODAS las cuentas.
const GADS_CONV_TABLE = 'raw_google_ads.ads_AccountConversionStats_6118198619';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// ---------- Auth: JWT RS256 -> access token (clonado de calls.js) ----------
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
      scope: 'https://www.googleapis.com/auth/bigquery',
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

const n = v => (v == null ? 0 : Number(v));

// month param -> primer y ultimo dia. Default: mes anterior completo (la
// comparacion con Google Ads es limpia solo a mes cerrado, ver nota del tablero).
function monthBounds(monthStr) {
  let y, m;
  if (/^\d{4}-\d{2}$/.test(monthStr || '')) {
    [y, m] = monthStr.split('-').map(Number);
  } else {
    const now = new Date();
    // mes anterior
    y = now.getUTCFullYear();
    m = now.getUTCMonth(); // 0-index -> este es el mes PASADO en 1-index
    if (m === 0) { y -= 1; m = 12; }
  }
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // dia 0 del sig mes = ultimo del actual
  const last = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { first, last, label: `${y}-${String(m).padStart(2, '0')}` };
}

export async function onRequestGet(context) {
  try {
    const env = context.env;
    const url = new URL(context.request.url);
    const { first, last, label } = monthBounds(url.searchParams.get('month'));

    const [byChannel, gadsConv] = await Promise.all([
      // Total + Period Unique por cliente y canal (grano mes)
      bqQuery(env,
        `SELECT '${label}' AS month, client_name, channel,
                COUNT(*) AS total,
                COUNT(DISTINCT caller_hash) AS period_unique,
                CAST(ANY_VALUE(google_ads_customer_id) AS STRING) AS customer_id
         FROM \`${PROJECT}.ctm_data.calls_attribution\`
         WHERE call_date_local BETWEEN '${first}' AND '${last}'
           AND client_name IS NOT NULL
         GROUP BY client_name, channel`),

      // Conversiones de llamada que reporta Google Ads (PHONE_CALL_LEAD), por cliente
      bqQuery(env,
        `SELECT '${label}' AS month,
                CAST(customer_id AS STRING) AS customer_id,
                ROUND(SUM(metrics_conversions), 0) AS conv_google
         FROM \`${PROJECT}.${GADS_CONV_TABLE}\`
         WHERE segments_conversion_action_category = 'PHONE_CALL_LEAD'
           AND segments_date BETWEEN '${first}' AND '${last}'
         GROUP BY customer_id`),
    ]);

    const by_channel = byChannel.map(r => ({
      month: r.month, client_name: r.client_name, channel: r.channel,
      total: n(r.total), period_unique: n(r.period_unique),
      customer_id: r.customer_id || null,
    }));
    const gads_conversions = gadsConv.map(r => ({
      month: r.month, customer_id: r.customer_id, conv_google: n(r.conv_google),
    }));

    const clients = [...new Set(by_channel.map(r => r.client_name))]
      .filter(Boolean).sort();

    return json({
      generated_at: new Date().toISOString().slice(0, 10),
      month: label,
      clients,
      by_channel,
      gads_conversions,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
