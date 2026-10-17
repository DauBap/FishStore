const {
  ensureSchema,
  getSql,
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  requireSession,
  sendJson,
} = require("../lib/server");

function validPayload(payload) {
  return payload && typeof payload === "object" &&
    ["products", "customers", "orders", "receipts", "fishRewards"].every((key) => Array.isArray(payload[key])) &&
    (payload.expenses === undefined || Array.isArray(payload.expenses)) &&
    (payload.units === undefined || Array.isArray(payload.units));
}

module.exports = async function handler(req, res) {
  if (!["GET", "PUT"].includes(req.method)) {
    res.setHeader("Allow", "GET, PUT");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  if (req.method === "PUT" && !requireSameOrigin(req, res)) return;
  if (!requireSession(req, res)) return;
  try {
    await ensureSchema();
    const sql = getSql();
    if (req.method === "GET") {
      const rows = await sql`SELECT payload, revision FROM fish_store_data WHERE id = 'owner'`;
      return sendJson(res, 200, rows.length
        ? { data: rows[0].payload, revision: Number(rows[0].revision) }
        : { data: null, revision: 0 });
    }

    const body = await readJsonBody(req);
    if (!validPayload(body.data) || !Number.isSafeInteger(body.revision) || body.revision < 0) {
      return sendJson(res, 400, { error: "Store data or revision is invalid." });
    }
    const payload = JSON.stringify(body.data);
    const rows = await sql`
      INSERT INTO fish_store_data (id, payload, revision)
      VALUES ('owner', ${payload}::jsonb, 1)
      ON CONFLICT (id) DO UPDATE
      SET payload = EXCLUDED.payload, revision = fish_store_data.revision + 1, updated_at = NOW()
      WHERE fish_store_data.revision = ${body.revision}
      RETURNING revision
    `;
    if (!rows.length) return sendJson(res, 409, { error: "Data changed on another device. Reload the app to get the latest copy before saving again." });
    return sendJson(res, 200, { revision: Number(rows[0].revision) });
  } catch (error) {
    console.error("Cloud store request failed.", error);
    return sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Unable to access cloud data right now." });
  }
};
