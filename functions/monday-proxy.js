/**
 * Córtex OS — Monday.com Ticket Proxy
 * Cloudflare Pages Function: functions/monday-proxy.js
 *
 * GET /monday-proxy?clientId=ITEM_ID
 *   → Fetches all items from each of the four ticket boards, filters
 *     client-side by linked_items matching the given clientId, excludes
 *     done tickets, and returns a clean JSON array.
 *
 * NOTE: monday.com does not support server-side filtering on board_relation
 * columns via query_params rules. Client-side filtering on linked_items is
 * the correct approach.
 *
 * Env secret required:
 *   MONDAY_API_TOKEN — Cloudflare Pages → Settings → Environment variables
 */

const MONDAY_API = "https://api.monday.com/v2";

const BOARDS = [
  {
    id: "8682614199",
    name: "Digital Tickets (AMs)",
    clientCol: "board_relation_mm3w1n38",
    statusCol: "color_mknzm7z9",
    doneIds: new Set(["14"]),
  },
  {
    id: "18409255608",
    name: "Digital Operations",
    clientCol: "board_relation_mm3wmamw",
    statusCol: "color_mknzm7z9",
    doneIds: new Set(["14"]),
  },
  {
    id: "18410164402",
    name: "SEO Operations",
    clientCol: "board_relation_mm3wj3nw",
    statusCol: "color_mknzm7z9",
    doneIds: new Set(["14"]),
  },
  {
    id: "18409258149",
    name: "Creative Work Order",
    clientCol: "board_relation_mm3w67jk",
    statusCol: "color_mky9rvz3",
    doneIds: new Set(["106", "1"]),
  },
];

// ─── CORS headers ─────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ─── GraphQL helper ───────────────────────────────────────────────────────────
async function gql(token, query) {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`monday API HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

// ─── Fetch client name from master list ──────────────────────────────────────
async function fetchClientName(token, clientId) {
  try {
    const data = await gql(token, `{ items(ids: [${clientId}]) { id name } }`);
    return data?.items?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

// ─── Fetch all items from a board (paginated) ─────────────────────────────────
async function fetchAllItems(token, board) {
  let allItems = [];
  let cursor = null;

  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : "";
    const query = `{
      boards(ids: [${board.id}]) {
        items_page(limit: 100${cursorArg}) {
          cursor
          items {
            id
            name
            column_values(ids: ["${board.clientCol}", "${board.statusCol}", "date4"]) {
              id
              text
              ... on BoardRelationValue {
                linked_items { id name }
              }
              ... on StatusValue {
                label
                index
                is_done
                label_style { color }
              }
              ... on DateValue {
                date
              }
            }
          }
        }
      }
    }`;

    const data = await gql(token, query);
    const page = data?.boards?.[0]?.items_page;
    allItems = allItems.concat(page?.items ?? []);
    cursor = page?.cursor ?? null;
  } while (cursor);

  return allItems;
}

// ─── Filter and shape tickets for a given client ──────────────────────────────
async function fetchBoardTickets(token, board, clientId) {
  const allItems = await fetchAllItems(token, board);
  const tickets = [];

  for (const item of allItems) {
    let isLinkedToClient = false;
    let statusLabel = "";
    let statusColor = "#c4c4c4";
    let statusIndex = null;
    let isDone = false;
    let dueDate = null;

    for (const col of item.column_values) {
      if (col.id === board.clientCol) {
        isLinkedToClient = (col.linked_items ?? []).some(
          (li) => String(li.id) === String(clientId)
        );
      }
      if (col.id === board.statusCol) {
        statusLabel = col.label ?? col.text ?? "";
        statusColor = col.label_style?.color ?? "#c4c4c4";
        statusIndex = col.index != null ? String(col.index) : null;
        isDone = col.is_done === true;
      }
      if (col.id === "date4") {
        dueDate = col.date ?? null;
      }
    }

    if (!isLinkedToClient) continue;
    if (isDone || (statusIndex !== null && board.doneIds.has(statusIndex))) continue;

    tickets.push({
      id: String(item.id),
      name: item.name,
      status: statusLabel,
      statusColor,
      board: board.name,
      boardId: board.id,
      url: `https://rightideacreative-team.monday.com/boards/${board.id}/pulses/${item.id}`,
      dueDate: dueDate ?? null,
    });
  }

  return tickets;
}

// ─── Main GET handler ─────────────────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  const origin = request.headers.get("origin");
  const headers = { "Content-Type": "application/json", ...corsHeaders(origin) };

  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");

  if (!clientId) {
    return new Response(JSON.stringify({ error: "Missing clientId parameter" }), {
      status: 400, headers,
    });
  }

  const token = env.MONDAY_API_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: "Server misconfiguration: missing API token" }), {
      status: 500, headers,
    });
  }

  const [clientNameResult, ...boardResults] = await Promise.allSettled([
    fetchClientName(token, clientId),
    ...BOARDS.map((board) => fetchBoardTickets(token, board, clientId)),
  ]);

  const clientName = clientNameResult.status === "fulfilled" ? clientNameResult.value : null;
  const tickets = [];
  const boardErrors = [];

  for (let i = 0; i < BOARDS.length; i++) {
    const result = boardResults[i];
    if (result.status === "fulfilled") {
      tickets.push(...result.value);
    } else {
      boardErrors.push({
        boardId: BOARDS[i].id,
        boardName: BOARDS[i].name,
        error: result.reason?.message ?? "Unknown error",
      });
    }
  }

  const response = { clientName, tickets };
  if (boardErrors.length > 0) response.boardErrors = boardErrors;

  return new Response(JSON.stringify(response), { status: 200, headers });
}

// ─── OPTIONS preflight ────────────────────────────────────────────────────────
export async function onRequestOptions({ request }) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

// ─── Catch-all for other methods ──────────────────────────────────────────────
export async function onRequest({ request, env }) {
  const method = request.method.toUpperCase();
  if (method === "GET") return onRequestGet({ request, env });
  if (method === "OPTIONS") return onRequestOptions({ request });
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", ...corsHeaders(request.headers.get("origin")) },
  });
}
