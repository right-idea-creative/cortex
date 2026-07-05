export async function onRequestPost({ request, env }) {
  try {
    const body = await request.text();
    const r = await fetch(env.ROADMAP_AGENT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502, headers: { "Content-Type": "application/json" },
    });
  }
}
