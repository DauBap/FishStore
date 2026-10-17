const { ensureSchema, getSql, requireMethod, sendJson, sessionFromRequest } = require("../../lib/server");

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;
  try {
    const session = sessionFromRequest(req);
    if (session) return sendJson(res, 200, { authenticated: true, account: session.account });
    await ensureSchema();
    const sql = getSql();
    const owners = await sql`SELECT 1 FROM fish_store_owner WHERE id = 'owner'`;
    return sendJson(res, 200, { authenticated: false, setupRequired: !owners.length });
  } catch (error) {
    console.error("Could not check owner session.", error);
    return sendJson(res, 500, { error: "Unable to check sign-in status right now." });
  }
};
