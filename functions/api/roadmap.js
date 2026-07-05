import { neon } from '@neondatabase/serverless';

// Read-only. Serves the roadmap plan from Neon for radar-roadmap.html.
// Route: /api/roadmap   (place this file at functions/api/roadmap.js)
// Never writes. Status changes happen through the CLI, not this page.
export async function onRequest(context) {
  const { env } = context;

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

  if (!env.CORTEX_STRATEGY_NEON) {
    return json({ error: 'CORTEX_STRATEGY_NEON is not bound to this Pages project.' }, 500);
  }

  try {
    const sql = neon(env.CORTEX_STRATEGY_NEON);

    const startRow = await sql`SELECT value FROM roadmap.settings WHERE key = 'project_start'`;

    const tasks = await sql`
      SELECT task_id, stage, stage_order, work_type, title, owner, status,
             planned_start, planned_end, duration_days, depends_on, late,
             (title ILIKE '%acceptance%') AS is_gate, detail
      FROM roadmap.schedule
      ORDER BY stage_order, planned_start, task_id`;

    const stages = await sql`
      SELECT stage, stage_order, tasks, done, in_progress, late, starts, ends
      FROM roadmap.stage_progress
      ORDER BY stage_order`;

    const counts = tasks.reduce(
      (a, t) => {
        a.total++;
        if (t.status === 'done') a.done++;
        if (t.status === 'in_progress') a.in_progress++;
        if (t.status === 'blocked') a.blocked++;
        if (t.late) a.late++;
        return a;
      },
      { total: 0, done: 0, in_progress: 0, blocked: 0, late: 0 }
    );

    return json({
      project_start: startRow[0] ? startRow[0].value : null,
      tasks,
      stages,
      counts,
    });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}
