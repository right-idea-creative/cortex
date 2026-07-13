// functions/api/budget-events.js
// Budget change events for Cortex OS.
// Writes to and reads from BigQuery (rightidea-cortex.budget.budget_events)
// with OAuth2 signed via Web Crypto. Authorization is enforced server-side
// using the Cloudflare Access identity header (cannot be spoofed by the client).
//
// ROLES are read dynamically from `budget.am_directory` (cached ~5 min):
//   role = 'admin'  -> can write + view history
//   role = 'editor' -> can write
//   role = 'viewer' -> read-only UI (no write, no history)
// Manage access by editing that table — no redeploy needed.
//
// POST /api/budget-events              -> insert event   (editors + admins)
// GET  /api/budget-events              -> event history  (admins only)
// GET  /api/budget-events?mode=perms   -> caller's own permissions
//
// Requires Cloudflare Pages Secret: GCP_SA_KEY (service account JSON for
// cortex-pages-writer@rightidea-cortex.iam.gserviceaccount.com)

const PROJECT = 'rightidea-cortex';
const DATASET = 'budget';
const TABLE = 'budget_events';
const DIRECTORY_TABLE = 'am_directory';
const ROLES_TTL_SECONDS = 300; // re-read am_directory every 5 minutes

// Safety net: if the roles query ever fails, these emails keep working
// so the system can never lock out its own admin.
const FALLBACK_ADMINS = ['sebas.guzman@rightideacreative.net'];

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
      // Full BigQuery scope: inserts + queries. What the SA can actually touch
      // is still limited by IAM (table-level bindings + project jobUser).
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

// ---------- BigQuery query helper (jobs.query) ----------

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
    r.f.forEach((cell, i) => { o[fields[i]] = cell.v; });
    return o;
  });
}

// ---------- Roles from am_directory (cached) ----------

let rolesCache = { map: null, exp: 0 };

async function getRoles(env) {
  const now = Math.floor(Date.now() / 1000);
  if (rolesCache.map && rolesCache.exp > now) return rolesCache.map;

  const rows = await bqQuery(env, `
    SELECT LOWER(TRIM(email)) AS email, LOWER(TRIM(role)) AS role
    FROM \`${PROJECT}.${DATASET}.${DIRECTORY_TABLE}\`
    WHERE active = TRUE
    QUALIFY ROW_NUMBER() OVER (PARTITION BY email ORDER BY updated_at DESC) = 1
  `, 200);

  const map = {};
  for (const r of rows) map[r.email] = r.role;
  rolesCache = { map, exp: now + ROLES_TTL_SECONDS };
  return map;
}

async function getPerms(env, email) {
  try {
    const roles = await getRoles(env);
    const role = roles[email] || null;
    return {
      email: email || null,
      role,
      can_write: role === 'editor' || role === 'admin',
      is_admin: role === 'admin',
    };
  } catch (e) {
    // Directory unreachable: fall back so admins are never locked out.
    const isFallbackAdmin = FALLBACK_ADMINS.includes(email);
    return {
      email: email || null,
      role: isFallbackAdmin ? 'admin' : null,
      can_write: isFallbackAdmin,
      is_admin: isFallbackAdmin,
      degraded: true,
    };
  }
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

// ---------- Budget planning data (replaces the n8n read webhook) ----------
// GET ?mode=data -> { summary:{year,clients,lines,total_committed}, items:[...] }
// Served from budget_base_current (sheet base + latest events overlay), so
// AM edits are reflected on the next page load.

// Flip together with the shell flag when leadership confirms viewers
// must not see budget data. true = only editors/admins can read.
const HIDE_BUDGETS_FROM_VIEWERS = false;

async function handleData(env) {
  const year = new Date().getUTCFullYear();
  const rows = await bqQuery(env, `
    SELECT
      client, channel,
      SUM(IF(month=1,  base_amount, 0)) AS m1,
      SUM(IF(month=2,  base_amount, 0)) AS m2,
      SUM(IF(month=3,  base_amount, 0)) AS m3,
      SUM(IF(month=4,  base_amount, 0)) AS m4,
      SUM(IF(month=5,  base_amount, 0)) AS m5,
      SUM(IF(month=6,  base_amount, 0)) AS m6,
      SUM(IF(month=7,  base_amount, 0)) AS m7,
      SUM(IF(month=8,  base_amount, 0)) AS m8,
      SUM(IF(month=9,  base_amount, 0)) AS m9,
      SUM(IF(month=10, base_amount, 0)) AS m10,
      SUM(IF(month=11, base_amount, 0)) AS m11,
      SUM(IF(month=12, base_amount, 0)) AS m12,
      SUM(base_amount) AS row_total
    FROM \`${PROJECT}.${DATASET}.budget_base_current\`
    WHERE year = ${year} AND month BETWEEN 1 AND 12
    GROUP BY client, channel
    ORDER BY client, channel
  `, 1000);

  const items = rows.map(r => ({
    client: r.client,
    channel: r.channel,
    m1: Number(r.m1), m2: Number(r.m2), m3: Number(r.m3), m4: Number(r.m4),
    m5: Number(r.m5), m6: Number(r.m6), m7: Number(r.m7), m8: Number(r.m8),
    m9: Number(r.m9), m10: Number(r.m10), m11: Number(r.m11), m12: Number(r.m12),
    row_total: Number(r.row_total),
  }));

  const summary = {
    year,
    clients: new Set(items.map(i => i.client)).size,
    lines: items.length,
    total_committed: Math.round(items.reduce((a, i) => a + i.row_total, 0) * 100) / 100,
  };

  return json({ summary, items });
}

async function handleHistory(env, url) {
  let limit = parseInt(url.searchParams.get('limit') || '200', 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  if (limit > 1000) limit = 1000;

  const events = await bqQuery(env, `
    SELECT event_id, client, channel, year, month, amount, alloc_type,
           event_type, changed_by, changed_at, note
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`
    ORDER BY changed_at DESC
    LIMIT ${limit}
  `, limit);
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
    const perms = await getPerms(env, email);

    // Any authenticated user can ask about their own permissions (UI gating).
    if (request.method === 'GET' && url.searchParams.get('mode') === 'perms') {
      return json(perms);
    }

    // Budget planning table data (replaces the public n8n webhook).
    if (request.method === 'GET' && url.searchParams.get('mode') === 'data') {
      if (HIDE_BUDGETS_FROM_VIEWERS && !perms.can_write) {
        return json({ error: 'Not authorized to view budget data.' }, 403);
      }
      return await handleData(env);
    }

    if (request.method === 'POST') {
      if (!perms.can_write) {
        return json({ error: 'Not authorized to edit budgets.' }, 403);
      }
      return await handleInsert(request, env, email);
    }

    if (request.method === 'GET') {
      if (!perms.is_admin) {
        return json({ error: 'Not authorized to view change history.' }, 403);
      }
      return await handleHistory(env, url);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
