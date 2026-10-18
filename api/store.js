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
  const collections = ["products", "customers", "orders", "receipts", "fishRewards", "fishIntakes", "expenses", "units"];
  return payload && typeof payload === "object" && !Array.isArray(payload) &&
    ["products", "customers", "orders", "receipts", "fishRewards"].every((key) => Array.isArray(payload[key])) &&
    collections.every((key) => payload[key] === undefined || (
      Array.isArray(payload[key]) && payload[key].every((item) =>
        key === "units" ? typeof item === "string" : item !== null && typeof item === "object" && !Array.isArray(item)
      )
    ));
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
      const rows = await sql`
        SELECT
          jsonb_build_object(
            'products', COALESCE((SELECT jsonb_agg(payload ORDER BY position) FROM fish_store_products), '[]'::JSONB),
            'customers', COALESCE((SELECT jsonb_agg(payload ORDER BY position) FROM fish_store_customers), '[]'::JSONB),
            'orders', COALESCE((SELECT jsonb_agg(payload ORDER BY position) FROM fish_store_orders), '[]'::JSONB),
            'receipts', COALESCE((SELECT jsonb_agg(payload ORDER BY position) FROM fish_store_receipts), '[]'::JSONB),
            'fishIntakes', COALESCE((SELECT jsonb_agg(payload ORDER BY position) FROM fish_store_fish_intakes), '[]'::JSONB),
            'expenses', COALESCE((SELECT jsonb_agg(payload ORDER BY position) FROM fish_store_expenses), '[]'::JSONB),
            'fishRewards', COALESCE((SELECT jsonb_agg(payload ORDER BY position) FROM fish_store_fish_rewards), '[]'::JSONB),
            'units', COALESCE((SELECT jsonb_agg(payload->'value' ORDER BY position) FROM fish_store_units), '[]'::JSONB)
          ) AS payload,
          revision,
          has_data
        FROM fish_store_store_state
        WHERE id = 'owner'
      `;
      return sendJson(res, 200, rows.length
        ? { data: rows[0].has_data ? rows[0].payload : null, revision: Number(rows[0].revision) }
        : { data: null, revision: 0 });
    }

    const body = await readJsonBody(req);
    if (!validPayload(body.data) || !Number.isSafeInteger(body.revision) || body.revision < 0) {
      return sendJson(res, 400, { error: "Store data or revision is invalid." });
    }
    const payload = JSON.stringify(body.data);
    const rows = await sql`
      SELECT fish_store_replace_payload(${payload}::jsonb, ${body.revision}::bigint) AS revision
    `;
    if (rows[0].revision === null) return sendJson(res, 409, { error: "Data changed on another device. Reload the app to get the latest copy before saving again." });
    return sendJson(res, 200, { revision: Number(rows[0].revision) });
  } catch (error) {
    console.error("Cloud store request failed.", error);
    return sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Unable to access cloud data right now." });
  }
};
