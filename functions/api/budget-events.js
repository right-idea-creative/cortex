// functions/api/budget-events.js
// Escribe eventos de presupuesto en BigQuery (rightidea-cortex.budget.budget_events)
// vía streaming insertAll, con auth OAuth2 firmada a mano con Web Crypto.
//
// POST /api/budget-events
//   Body: { client, channel, year, month, amount, event_type, changed_by, alloc_type?, note? }
//   -> 201 { event_id }
//
// Requiere Secret en Cloudflare Pages: GCP_SA_KEY (JSON completo de la service account
// cortex-pages-writer@rightidea-cortex.iam.gserviceaccount.com)

const PROJECT = 'rightidea-cortex';
const DATASET = 'budget';
const TABLE = 'budget_events';

// TODO: confirmar vocabularios con las decisiones de la otra instancia
const EVENT_TYPES = ['create', 'update', 'delete'];
const ALLOC_TYPES = null; // null = sin restricción; poner array para validar

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// ---------- Auth: JWT RS256 con Web Crypto -> access token ----------

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
  // reuso el token cacheado si le queda más de 60s de vida
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;

  const sa = JSON.parse(env.GCP_SA_KEY);

  const header = b64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlFromString(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/bigquery.insertdata',
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

// ---------- Validación ----------

function validateEvent(b) {
  if (!b || typeof b !== 'object') return 'Body must be an object';
  for (const f of ['client', 'channel', 'event_type', 'changed_by']) {
    if (!b[f] || !String(b[f]).trim()) return `${f} is required`;
  }
  const year = Number(b.year);
  const month = Number(b.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return 'year must be a valid integer';
  if (!Number.isInteger(month) || month < 1 || month > 12) return 'month must be 1-12';
  const amount = Number(b.amount);
  if (b.amount == null || Number.isNaN(amount)) return 'amount must be a number';
  if (!EVENT_TYPES.includes(b.event_type))
    return `event_type must be one of ${EVENT_TYPES.join(', ')}`;
  if (ALLOC_TYPES && b.alloc_type != null && !ALLOC_TYPES.includes(b.alloc_type))
    return `alloc_type must be one of ${ALLOC_TYPES.join(', ')}`;
  return null;
}

// ---------- Handler ----------

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.GCP_SA_KEY) {
    return json({ error: 'GCP_SA_KEY is not bound to this Pages project.' }, 500);
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const b = await request.json();
    const err = validateEvent(b);
    if (err) return json({ error: err }, 400);

    const eventId = crypto.randomUUID();
    const row = {
      event_id: eventId,
      client: String(b.client).trim(),
      channel: String(b.channel).trim(),
      year: Number(b.year),
      month: Number(b.month),
      // NUMERIC viaja como string en insertAll para no perder precisión
      amount: String(b.amount),
      alloc_type: b.alloc_type ?? null,
      event_type: b.event_type,
      changed_by: String(b.changed_by).trim(),
      changed_at: new Date().toISOString(),
      note: b.note ?? null,
    };

    const token = await getAccessToken(env);
    const res = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}/insertAll`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          // insertId da deduplicación best-effort si el cliente reintenta
          rows: [{ insertId: eventId, json: row }],
        }),
      }
    );
    const data = await res.json();

    if (!res.ok) {
      return json({ error: 'BigQuery request failed', detail: data }, 502);
    }
    if (data.insertErrors && data.insertErrors.length) {
      return json({ error: 'BigQuery rejected the row', detail: data.insertErrors }, 502);
    }

    return json({ event_id: eventId }, 201);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
