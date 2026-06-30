// functions/api/account-standard.js
// Cloudflare Pages Function — Account Standard API (Neon / Postgres)
//
// Append-only: every save INSERTs a new row. Nothing is updated or deleted.
// "Current" = latest created_at per item_id, filtered to active = true.
//
// Routes (same file handles all methods):
//   GET  /api/account-standard             -> current standards (active, latest each)
//   GET  /api/account-standard?item_id=X   -> full version history for one item
//   POST /api/account-standard             -> save a new version of an item (JSON body)
//
// Env: set DATABASE_URL in Cloudflare Pages -> Settings -> Environment variables
//      (the Neon connection string for the NEW account-standard project).
//      Same pattern as strategy / project-hq.

import { neon } from '@neondatabase/serverless';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function onRequestGet(context) {
  try {
    const sql = neon(context.env.DATABASE_URL);
    const url = new URL(context.request.url);
    const itemId = url.searchParams.get('item_id');

    if (itemId) {
      const rows = await sql`
        select * from account_standard
        where item_id = ${itemId}
        order by created_at desc
      `;
      return json({ history: rows });
    }

    // Current standard: latest version per item, only active rows.
    const rows = await sql`
      select * from current_account_standard
      where active = true
      order by category, sort_order, item
    `;
    return json({ rows });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const sql = neon(context.env.DATABASE_URL);
    const b = await context.request.json();

    // Required
    if (!b.item_id || !b.category || !b.level || !b.item) {
      return json({ error: 'item_id, category, level, and item are required.' }, 400);
    }
    if (!['confirmed', 'pending'].includes(b.status)) {
      return json({ error: 'status must be confirmed or pending.' }, 400);
    }
    if (!['Account', 'Campaign', 'Ad Group', 'Ad'].includes(b.level)) {
      return json({ error: 'invalid level.' }, 400);
    }

    const row = await sql`
      insert into account_standard
        (item_id, category, level, item, position, exception, status, sort_order, active, edited_by)
      values
        (${b.item_id}, ${b.category}, ${b.level}, ${b.item},
         ${b.position ?? null}, ${b.exception ?? null}, ${b.status},
         ${Number.isInteger(b.sort_order) ? b.sort_order : 0},
         ${b.active === false ? false : true},
         ${b.edited_by ?? null})
      returning *
    `;
    return json({ row: row[0] });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
