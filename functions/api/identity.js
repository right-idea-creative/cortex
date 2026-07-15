// functions/api/identity.js
// Cortex Identity Admin API — manage users, roles and capabilities from the UI.
// Backed by BigQuery (rightidea-cortex.identity.*) with full audit trail
// in identity.identity_events (who changed whose access, and when).
//
// GET  /api/identity                 -> { users, roles, events } (admin.users only)
// POST /api/identity                 -> apply one change (admin.users only)
//      body: { action: 'set_role',   email, role }
//            { action: 'set_active', email, active }
//            { action: 'grant',      email, capability }
//            { action: 'revoke',     email, capability }
//            { action: 'add_user',   email, display_name, role }
//
// Requires Cloudflare Pages Secret: GCP_SA_KEY. The service account needs
// dataViewer on dataset identity (already granted) plus dataEditor on
// identity.users and identity.identity_events (table-level).

const PROJECT = 'rightidea-cortex';
const IDENTITY = 'identity';
const USERS = 'users';
const ROLES = 'roles';
const EVENTS = 'identity_events';
const ACCESS_VIEW = 'identity.user_access';

// Lockout guard: these emails can never be deactivated or demoted via the API.
const PROTECTED_ADMINS = ['sebas.guzman@rightideacreative.net'];

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const CAP_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;   // modulo.accion (no permite '*')
const ROLE_RE = /^[a-z][a-z0-9_]*$/;

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
    r.f.forEach((cell, i) => {
      o[fields[i]] = Array.isArray(cell.v) ? cell.v.map(x => x.v) : cell.v;
    });
    return o;
  });
}

// DML statements (DELETE/UPDATE): returns number of affected rows.
async function bqDml(env, query) {
  const token = await getAccessToken(env);
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, useLegacySql: false }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    const msg = JSON.stringify(data);
    const err = new Error(`BigQuery DML failed: ${msg}`);
    err.streamingBuffer = /streaming buffer/i.test(msg);
    throw err;
  }
  if (!data.jobComplete) throw new Error('DML did not complete in time');
  return Number(data.numDmlAffectedRows || 0);
}


// ---------- Caller permissions (from identity.user_access) ----------

let permsCache = { map: null, exp: 0 };

async function callerCanAdmin(env, email) {
  const now = Math.floor(Date.now() / 1000);
  if (!permsCache.map || permsCache.exp <= now) {
    const rows = await bqQuery(env, `
      SELECT LOWER(TRIM(email)) AS email, capabilities
      FROM \`${PROJECT}.${ACCESS_VIEW}\`
    `, 500);
    const map = {};
    for (const r of rows) map[r.email] = r.capabilities || [];
    permsCache = { map, exp: now + 60 }; // caché corto: es el panel de admin
  }
  const caps = permsCache.map[email] || [];
  return caps.includes('*') || caps.includes('admin.users');
}

// ---------- Audit trail ----------

async function logEvent(env, action, targetEmail, detail, changedBy) {
  const eventId = crypto.randomUUID();
  const token = await getAccessToken(env);
  await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets/${IDENTITY}/tables/${EVENTS}/insertAll`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        rows: [{
          insertId: eventId,
          json: {
            event_id: eventId,
            action,
            target_email: targetEmail,
            detail: JSON.stringify(detail || {}),
            changed_by: changedBy,
            changed_at: new Date().toISOString(),
          },
        }],
      }),
    }
  );
}

// ---------- Handlers ----------

async function handleList(env) {
  const [users, roles, events] = await Promise.all([
    bqQuery(env, `
      SELECT email, display_name, job_title, agency, role, active,
             extra_capabilities, revoked_capabilities, updated_at
      FROM \`${PROJECT}.${IDENTITY}.${USERS}\`
      QUALIFY ROW_NUMBER() OVER (PARTITION BY LOWER(email) ORDER BY updated_at DESC) = 1
      ORDER BY email
    `, 300),
    bqQuery(env, `
      SELECT role, description, capabilities
      FROM \`${PROJECT}.${IDENTITY}.${ROLES}\`
      ORDER BY role
    `, 50),
    bqQuery(env, `
      SELECT event_id, action, target_email, detail, changed_by, changed_at
      FROM \`${PROJECT}.${IDENTITY}.${EVENTS}\`
      ORDER BY changed_at DESC
      LIMIT 100
    `, 100).catch(() => []),
  ]);
  return json({ users, roles, events });
}

function sqlStr(v) { return "'" + String(v).replace(/'/g, "\\'") + "'"; }

async function handleChange(request, env, caller) {
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== 'object') return json({ error: 'Body must be an object' }, 400);
  const action = b.action;
  const email = String(b.email || '').toLowerCase().trim();
  if (!EMAIL_RE.test(email)) return json({ error: 'A valid email is required' }, 400);

  const isProtected = PROTECTED_ADMINS.includes(email);

  if (action === 'set_role') {
    const role = String(b.role || '').toLowerCase().trim();
    if (!ROLE_RE.test(role)) return json({ error: 'Invalid role' }, 400);
    const known = await bqQuery(env, `
      SELECT role FROM \`${PROJECT}.${IDENTITY}.${ROLES}\` WHERE role = ${sqlStr(role)}
    `, 1);
    if (!known.length) return json({ error: `Unknown role: ${role}` }, 400);
    if (isProtected && role !== 'admin') {
      return json({ error: 'This account is lockout-protected and must remain admin.' }, 400);
    }
    const n = await bqDml(env, `
      UPDATE \`${PROJECT}.${IDENTITY}.${USERS}\`
      SET role = ${sqlStr(role)}, updated_at = CURRENT_TIMESTAMP()
      WHERE LOWER(email) = ${sqlStr(email)}
    `);
    if (!n) return json({ error: 'No user found with that email' }, 404);
    await logEvent(env, 'set_role', email, { role }, caller);
    return json({ ok: true, affected: n });
  }

  if (action === 'set_active') {
    const active = b.active === true;
    if (isProtected && !active) {
      return json({ error: 'This account is lockout-protected and cannot be deactivated.' }, 400);
    }
    const n = await bqDml(env, `
      UPDATE \`${PROJECT}.${IDENTITY}.${USERS}\`
      SET active = ${active ? 'TRUE' : 'FALSE'}, updated_at = CURRENT_TIMESTAMP()
      WHERE LOWER(email) = ${sqlStr(email)}
    `);
    if (!n) return json({ error: 'No user found with that email' }, 404);
    await logEvent(env, 'set_active', email, { active }, caller);
    return json({ ok: true, affected: n });
  }

  if (action === 'grant' || action === 'revoke') {
    const cap = String(b.capability || '').toLowerCase().trim();
    if (!CAP_RE.test(cap)) return json({ error: 'Invalid capability (expected modulo.accion)' }, 400);
    if (isProtected && action === 'revoke') {
      return json({ error: 'This account is lockout-protected; nothing to revoke on admin.' }, 400);
    }
    const capSql = sqlStr(cap);
    let setSql;
    if (action === 'grant') {
      setSql = `
        extra_capabilities = ARRAY(
          SELECT DISTINCT c FROM UNNEST(ARRAY_CONCAT(IFNULL(extra_capabilities, []), [${capSql}])) c
        ),
        revoked_capabilities = ARRAY(
          SELECT c FROM UNNEST(IFNULL(revoked_capabilities, [])) c WHERE c != ${capSql}
        )`;
    } else {
      setSql = `
        revoked_capabilities = ARRAY(
          SELECT DISTINCT c FROM UNNEST(ARRAY_CONCAT(IFNULL(revoked_capabilities, []), [${capSql}])) c
        ),
        extra_capabilities = ARRAY(
          SELECT c FROM UNNEST(IFNULL(extra_capabilities, [])) c WHERE c != ${capSql}
        )`;
    }
    const n = await bqDml(env, `
      UPDATE \`${PROJECT}.${IDENTITY}.${USERS}\`
      SET ${setSql}, updated_at = CURRENT_TIMESTAMP()
      WHERE LOWER(email) = ${sqlStr(email)}
    `);
    if (!n) return json({ error: 'No user found with that email' }, 404);
    await logEvent(env, action, email, { capability: cap }, caller);
    return json({ ok: true, affected: n });
  }

  if (action === 'add_user') {
    const role = String(b.role || 'analyst').toLowerCase().trim();
    if (!ROLE_RE.test(role)) return json({ error: 'Invalid role' }, 400);
    const known = await bqQuery(env, `
      SELECT role FROM \`${PROJECT}.${IDENTITY}.${ROLES}\` WHERE role = ${sqlStr(role)}
    `, 1);
    if (!known.length) return json({ error: `Unknown role: ${role}` }, 400);
    const displayName = String(b.display_name || '').trim().slice(0, 80) || null;
    const exists = await bqQuery(env, `
      SELECT email FROM \`${PROJECT}.${IDENTITY}.${USERS}\` WHERE LOWER(email) = ${sqlStr(email)} LIMIT 1
    `, 1);
    if (exists.length) return json({ error: 'User already exists' }, 409);
    await bqDml(env, `
      INSERT INTO \`${PROJECT}.${IDENTITY}.${USERS}\`
        (email, display_name, agency, role, active, updated_at)
      VALUES (${sqlStr(email)}, ${displayName ? sqlStr(displayName) : 'NULL'},
              'Right Idea', ${sqlStr(role)}, TRUE, CURRENT_TIMESTAMP())
    `);
    await logEvent(env, 'add_user', email, { role, display_name: displayName }, caller);
    return json({ ok: true }, 201);
  }

  return json({ error: `Unknown action: ${String(action)}` }, 400);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.GCP_SA_KEY) {
    return json({ error: 'GCP_SA_KEY is not bound to this Pages project.' }, 500);
  }
  const email = accessEmail(request);
  try {
    const allowed = await callerCanAdmin(env, email);
    if (!allowed) return json({ error: 'Not authorized for user management.' }, 403);

    if (request.method === 'GET') return await handleList(env);
    if (request.method === 'POST') {
      const res = await handleChange(request, env, email);
      permsCache = { map: null, exp: 0 }; // ver cambios propios al instante
      return res;
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
