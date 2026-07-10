// Reef Tank sync Worker.
// Serves the built app from ./dist and provides a tiny sync API backed by D1.
// Auth: a single shared token, set with `npx wrangler secret put SYNC_TOKEN`.

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB — far beyond any realistic dataset

let tableReady = false;

async function ensureTable(db) {
  if (tableReady) return;
  await db.exec(
    "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL)"
  );
  tableReady = true;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const auth = request.headers.get("Authorization") || "";
      if (!env.SYNC_TOKEN || auth !== `Bearer ${env.SYNC_TOKEN}`) {
        return json({ error: "unauthorised" }, 401);
      }

      if (url.pathname === "/api/state") {
        await ensureTable(env.DB);

        if (request.method === "GET") {
          const row = await env.DB
            .prepare("SELECT body FROM state WHERE id = 1")
            .first();
          return new Response(row ? row.body : "null", {
            headers: { "content-type": "application/json" },
          });
        }

        if (request.method === "PUT") {
          const body = await request.text();
          if (body.length > MAX_BODY_BYTES) return json({ error: "too large" }, 413);
          try { JSON.parse(body); } catch { return json({ error: "invalid JSON" }, 400); }
          await env.DB
            .prepare(
              "INSERT INTO state (id, body, updated_at) VALUES (1, ?1, ?2) " +
              "ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at"
            )
            .bind(body, new Date().toISOString())
            .run();
          return json({ ok: true });
        }

        return json({ error: "method not allowed" }, 405);
      }

      return json({ error: "not found" }, 404);
    }

    // Everything else: the built app
    return env.ASSETS.fetch(request);
  },
};
