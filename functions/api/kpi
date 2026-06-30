// functions/api/kpi.js
// CRUD for KPI performance criteria, backed by Neon Postgres.
// Connection string from env var KPI_DATABASE_URL (point at the new Neon project).
//
// GET   /api/kpi            -> { rules:[...with nested conditions + status...], statuses:[...] }
// POST  /api/kpi            -> create rule (+ its conditions)
// PUT   /api/kpi            -> update rule (replaces its conditions wholesale)
// DELETE /api/kpi?id=123    -> delete rule (conditions cascade)
//
// Status vocabulary is managed separately:
// POST   /api/kpi?kind=status   -> create status
// PUT    /api/kpi?kind=status   -> update status
// DELETE /api/kpi?kind=status&id=123 -> delete status (blocked if rules reference it)

import { neon } from '@neondatabase/serverless';

const LEVELS = ['account', 'campaign', 'ad_group'];
const OPS    = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between'];
const MATCH  = ['all', 'any'];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function validateRule(b) {
  if (!b || typeof b !== 'object') return 'Body must be an object';
  if (!LEVELS.includes(b.level)) return `level must be one of ${LEVELS.join(', ')}`;
  if (!b.status_id) return 'status_id is required';
  if (!b.condition_text || !String(b.condition_text).trim()) return 'condition_text is required';
  if (b.match && !MATCH.includes(b.match)) return `match must be one of ${MATCH.join(', ')}`;
  if (Array.isArray(b.conditions)) {
    for (const c of b.conditions) {
      if (!c.metric || !String(c.metric).trim()) return 'each condition needs a metric';
      if (!OPS.includes(c.operator)) return `condition operator must be one of ${OPS.join(', ')}`;
      if (c.operator === 'between' && (c.threshold == null || c.threshold_high == null))
        return "'between' needs both threshold and threshold_high";
    }
  }
  return null;
}

async function fetchRules(sql) {
  const rules = await sql`
    SELECT r.*, s.label AS status_label, s.color AS status_color, s.rank AS status_rank
    FROM kpi_rules r
    JOIN kpi_statuses s ON s.id = r.status_id
    ORDER BY r.level, s.rank, r.condition_text`;
  const conds = await sql`SELECT * FROM kpi_conditions ORDER BY rule_id, position, id`;
  const byRule = {};
  for (const c of conds) (byRule[c.rule_id] ||= []).push(c);
  for (const r of rules) r.conditions = byRule[r.id] || [];
  return rules;
}

async function insertConditions(sql, ruleId, conditions) {
  if (!Array.isArray(conditions)) return;
  let pos = 0;
  for (const c of conditions) {
    await sql`
      INSERT INTO kpi_conditions
        (rule_id, metric, operator, threshold, threshold_high, unit, window_days, position)
      VALUES
        (${ruleId}, ${c.metric}, ${c.operator}, ${c.threshold ?? null},
         ${c.threshold_high ?? null}, ${c.unit ?? null}, ${c.window_days ?? null}, ${pos++})`;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const sql = neon(env.KPI_DATABASE_URL);
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind'); // 'status' or null (rule)
  const method = request.method;

  try {
    // ---- status vocabulary ----
    if (kind === 'status') {
      if (method === 'GET') return json(await sql`SELECT * FROM kpi_statuses ORDER BY rank`);
      if (method === 'POST') {
        const b = await request.json();
        if (!b.label || b.rank == null) return json({ error: 'label and rank are required' }, 400);
        const [row] = await sql`
          INSERT INTO kpi_statuses (label, rank, color, description)
          VALUES (${b.label}, ${b.rank}, ${b.color ?? null}, ${b.description ?? null})
          RETURNING *`;
        return json(row, 201);
      }
      if (method === 'PUT') {
        const b = await request.json();
        if (!b.id) return json({ error: 'id is required' }, 400);
        const [row] = await sql`
          UPDATE kpi_statuses SET
            label=${b.label}, rank=${b.rank}, color=${b.color ?? null}, description=${b.description ?? null}
          WHERE id=${b.id} RETURNING *`;
        if (!row) return json({ error: 'not found' }, 404);
        return json(row);
      }
      if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: 'id query param is required' }, 400);
        const [used] = await sql`SELECT 1 FROM kpi_rules WHERE status_id=${id} LIMIT 1`;
        if (used) return json({ error: 'Status is in use by one or more rules; reassign them first.' }, 409);
        const [row] = await sql`DELETE FROM kpi_statuses WHERE id=${id} RETURNING id`;
        if (!row) return json({ error: 'not found' }, 404);
        return json({ deleted: row.id });
      }
      return json({ error: 'Method not allowed' }, 405);
    }

    // ---- rules ----
    if (method === 'GET') {
      const [rules, statuses] = await Promise.all([
        fetchRules(sql),
        sql`SELECT * FROM kpi_statuses ORDER BY rank`,
      ]);
      return json({ rules, statuses });
    }

    if (method === 'POST') {
      const b = await request.json();
      const err = validateRule(b);
      if (err) return json({ error: err }, 400);
      const [rule] = await sql`
        INSERT INTO kpi_rules
          (level, status_id, condition_text, exception_text, match, campaign_type, notes, updated_by)
        VALUES
          (${b.level}, ${b.status_id}, ${b.condition_text}, ${b.exception_text ?? null},
           ${b.match ?? 'all'}, ${b.campaign_type ?? null}, ${b.notes ?? null}, ${b.updated_by ?? null})
        RETURNING id`;
      await insertConditions(sql, rule.id, b.conditions);
      return json({ id: rule.id }, 201);
    }

    if (method === 'PUT') {
      const b = await request.json();
      if (!b.id) return json({ error: 'id is required' }, 400);
      const err = validateRule(b);
      if (err) return json({ error: err }, 400);
      const [rule] = await sql`
        UPDATE kpi_rules SET
          level=${b.level}, status_id=${b.status_id}, condition_text=${b.condition_text},
          exception_text=${b.exception_text ?? null}, match=${b.match ?? 'all'},
          campaign_type=${b.campaign_type ?? null}, notes=${b.notes ?? null},
          updated_by=${b.updated_by ?? null}
        WHERE id=${b.id} RETURNING id`;
      if (!rule) return json({ error: 'not found' }, 404);
      // conditions are replaced wholesale — simplest correct approach
      await sql`DELETE FROM kpi_conditions WHERE rule_id=${b.id}`;
      await insertConditions(sql, b.id, b.conditions);
      return json({ id: b.id });
    }

    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id query param is required' }, 400);
      const [row] = await sql`DELETE FROM kpi_rules WHERE id=${id} RETURNING id`;
      if (!row) return json({ error: 'not found' }, 404);
      return json({ deleted: row.id });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
