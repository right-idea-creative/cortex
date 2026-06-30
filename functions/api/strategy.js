// functions/api/strategy.js
// Cloudflare Pages Function — Current Strategy API (Neon / Postgres)
//
// Append-only: every save INSERTs a new row. Nothing is updated or deleted.
// "Current" = latest created_at per card_id, filtered to active = true.
//
// Routes (same file handles all methods):
//   GET  /api/strategy            -> current strategy (active cards, latest version each)
//   GET  /api/strategy?card_id=X  -> full version history for one card (newest first)
//   POST /api/strategy            -> save a new version of a card (body = JSON, see below)
//
// Env: set DATABASE_URL in Cloudflare Pages -> Settings -> Environment variables
//      (your Neon connection string). Same pattern as project-hq.
//
// Uses Neon's serverless driver over HTTP (works in the Pages edge runtime).

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
    const cardId = url.searchParams.get('card_id');

    if (cardId) {
      // Full history for one card, newest first.
      const rows = await sql`
        select * from strategy_entries
        where card_id = ${cardId}
        order by created_at desc
      `;
      return json({ history: rows });
    }

    // Current strategy: latest version per card, only active cards.
    const rows = await sql`
      select * from current_strategy
      where active = true
      order by pillar, topic nulls first, title
    `;
    return json({ cards: rows });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const sql = neon(context.env.DATABASE_URL);
    const b = await context.request.json();

    // Required: card_id, pillar, title, status.
    if (!b.card_id || !b.pillar || !b.title || !b.status) {
      return json({ error: 'card_id, pillar, title, and status are required' }, 400);
    }

    const [row] = await sql`
      insert into strategy_entries
        (card_id, pillar, topic, title, body, status, applies_to,
         change_kind, note, active, edited_by)
      values
        (${b.card_id}, ${b.pillar}, ${b.topic ?? null}, ${b.title}, ${b.body ?? null},
         ${b.status}, ${b.applies_to ?? 'general'},
         ${b.change_kind ?? 'edit'}, ${b.note ?? null},
         ${b.active ?? true}, ${b.edited_by ?? null})
      returning *
    `;
    return json({ saved: row }, 201);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
