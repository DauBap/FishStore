const {
  configuredOwner,
  createSession,
  ensureSchema,
  getSql,
  ipHash,
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  safeEqual,
  sendJson,
  setSessionCookie,
} = require("../../lib/server");

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, "POST") || !requireSameOrigin(req, res)) return;
  const owner = configuredOwner(res);
  if (!owner) return;
  try {
    const body = await readJsonBody(req, 4096);
    if (typeof body.email !== "string" || typeof body.password !== "string" || body.password.length > 1024) {
      return sendJson(res, 400, { error: "Enter a valid email and password." });
    }
    await ensureSchema();
    const sql = getSql();
    const address = ipHash(req);
    const rows = await sql`
      SELECT COUNT(*)::int AS attempts
      FROM kho_moc_login_attempts
      WHERE ip_hash = ${address} AND attempted_at > NOW() - INTERVAL '15 minutes'
    `;
    if (rows[0].attempts >= 10) return sendJson(res, 429, { error: "Too many attempts. Try again in 15 minutes." });

    const matches = safeEqual(body.email.trim().toLowerCase(), owner.email) && safeEqual(body.password, owner.password);
    if (!matches) {
      await sql`INSERT INTO kho_moc_login_attempts (ip_hash) VALUES (${address})`;
      await sql`DELETE FROM kho_moc_login_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'`;
      return sendJson(res, 401, { error: "Email or password is incorrect." });
    }
    await sql`DELETE FROM kho_moc_login_attempts WHERE ip_hash = ${address}`;
    setSessionCookie(res, createSession(owner.email), req);
    return sendJson(res, 200, { authenticated: true, email: owner.email });
  } catch (error) {
    console.error("Owner login failed.", error);
    return sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Unable to sign in right now." });
  }
};
