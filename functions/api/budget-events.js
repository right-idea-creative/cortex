// functions/api/budget-events.js
// Budget change events for Cortex OS.
// Writes to and reads from BigQuery (rightidea-cortex.budget.budget_events)
// with OAuth2 signed via Web Crypto. Authorization is enforced server-side
// using the Cloudflare Access identity header (cannot be spoofed by the client).
//
// POST /api/budget-events              -> insert event   (WRITERS only)
//   Body: { client, channel, year, month, amount, event_type, alloc_type?, note? }
//   changed_by is taken from the Access header, NOT from the body.
//   -> 201 { event_id }
//
// GET  /api/budget-events              -> event history  (ADMINS only)
//   Optional query params: ?limit=200
//   -> 200 { events: [...] }
//
// GET  /api/budget-events?mode=perms   -> caller's own permissions (any authenticated user)
//   -> 200 { email, can_write, is_admin }
//
// Requires Cloudflare Pages Secret: GCP_SA_KEY (service account JSON for
// cortex-pages-writer@rightidea-cortex.iam.gserviceaccount.com)

const PROJECT = 'rightidea-cortex';
const DATASET = 'budget';
const TABLE = 'budget_events';

// ---- Authorization (emails as authenticated by Cloudflare Access) ----
// Add AM emails here as they're approved to edit budgets.
const WRITERS = [
  'sebas.guzman@rightideacreative.net',
];
// Admins can view the full change history.
const ADMINS = [
  'sebas.guzman@rightideacreative.net',
];

// TODO: confirmar vocabularios definitivos
const EVENT_TYPES = ['create', 'update', 'delete'];
const ALLOC_TYPES = null; // null = sin restricción; poner array para validar

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// Email injected by Cloudflare Access after login. Header can't be set by
// external clients because Access sits in front of every request.
const accessEmail = (request) =>
  (request.headers.get('cf-access-authenticated-user-email') || '').toLowerCase().trim();

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
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;

  const sa = JSON.parse(env.GCP_SA_KEY);

  const header = b64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlFromString(
    JSON.stringify({
      iss: sa.client_email,
      // Full BigQuery scope: needed for both streaming inserts and queries.
      // What the SA can actually touch is still limited by IAM (table-level
      // dataEditor + project jobUser).
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

// ---------- Validación ----------

function validateEvent(b) {
  if (!b || typeof b !== 'object') return 'Body must be an object';
  for (const f of ['client', 'channel', 'event_type']) {
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

// ---------- Handlers ----------

async function handleInsert(request, env, email) {
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
    amount: String(b.amount), // NUMERIC as string to keep precision
    alloc_type: b.alloc_type ?? null,
    event_type: b.event_type,
    changed_by: email, // server-side identity from Access — body is ignored
    changed_at: new Date().toISOString(),
    note: b.note ?? null,
  };

  const token = await getAccessToken(env);
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}/insertAll`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [{ insertId: eventId, json: row }] }),
    }
  );
  const data = await res.json();

  if (!res.ok) return json({ error: 'BigQuery request failed', detail: data }, 502);
  if (data.insertErrors && data.insertErrors.length)
    return json({ error: 'BigQuery rejected the row', detail: data.insertErrors }, 502);

  return json({ event_id: eventId }, 201);
}

async function handleHistory(env, url) {
  let limit = parseInt(url.searchParams.get('limit') || '200', 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  if (limit > 1000) limit = 1000;

  const token = await getAccessToken(env);
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `SELECT event_id, client, channel, year, month, amount, alloc_type,
                       event_type, changed_by, changed_at, note
                FROM \`${PROJECT}.${DATASET}.${TABLE}\`
                ORDER BY changed_at DESC
                LIMIT ${limit}`,
        useLegacySql: false,
        maxResults: limit,
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) return json({ error: 'BigQuery query failed', detail: data }, 502);
  if (!data.jobComplete) return json({ error: 'Query did not complete in time' }, 504);

  const fields = (data.schema && data.schema.fields || []).map(f => f.name);
  const events = (data.rows || []).map(r => {
    const o = {};
    r.f.forEach((cell, i) => { o[fields[i]] = cell.v; });
    return o;
  });
  return json({ events });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.GCP_SA_KEY) {
    return json({ error: 'GCP_SA_KEY is not bound to this Pages project.' }, 500);
  }

  const email = accessEmail(request);
  const url = new URL(request.url);

  try {
    // Any authenticated user can ask about their own permissions (UI gating).
    if (request.method === 'GET' && url.searchParams.get('mode') === 'perms') {
      return json({
        email: email || null,
        can_write: WRITERS.includes(email),
        is_admin: ADMINS.includes(email),
      });
    }

    if (request.method === 'POST') {
      if (!WRITERS.includes(email)) {
        return json({ error: 'Not authorized to edit budgets.' }, 403);
      }
      return await handleInsert(request, env, email);
    }

    if (request.method === 'GET') {
      if (!ADMINS.includes(email)) {
        return json({ error: 'Not authorized to view change history.' }, 403);
      }
      return await handleHistory(env, url);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
