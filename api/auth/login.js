const { promisify } = require("node:util");
const { scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const {
  createSession,
  ensureSchema,
  getSql,
  ipHash,
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  sendJson,
  setSessionCookie,
} = require("../../lib/server");

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 64;

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, "POST") || !requireSameOrigin(req, res)) return;
  try {
    const body = await readJsonBody(req, 4096);
    if (typeof body.account !== "string" || typeof body.password !== "string" ||
        body.account.length > 64 || body.password.length > 1024) {
      return sendJson(res, 400, { error: "Enter a valid account and password." });
    }
    const account = body.account.trim().toLowerCase();
    await ensureSchema();
    const sql = getSql();
    const address = ipHash(req);
    const attempts = await sql`
      SELECT COUNT(*)::int AS attempts
      FROM fish_store_login_attempts
      WHERE ip_hash = ${address} AND attempted_at > NOW() - INTERVAL '15 minutes'
    `;
    if (attempts[0].attempts >= 10) return sendJson(res, 429, { error: "Too many attempts. Try again in 15 minutes." });

    const owners = await sql`
      SELECT account, password_salt, password_hash
      FROM fish_store_owner
      WHERE id = 'owner'
    `;
    if (!owners.length) return sendJson(res, 409, { error: "Tạo tài khoản chủ trước khi đăng nhập." });
    const owner = owners[0];
    const derived = await scrypt(body.password, Buffer.from(owner.password_salt, "base64url"), PASSWORD_BYTES);
    const expected = Buffer.from(owner.password_hash, "base64url");
    const matches = account === owner.account &&
      expected.length === PASSWORD_BYTES &&
      timingSafeEqual(derived, expected);
    if (!matches) {
      await sql`INSERT INTO fish_store_login_attempts (ip_hash) VALUES (${address})`;
      await sql`DELETE FROM fish_store_login_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'`;
      return sendJson(res, 401, { error: "Tài khoản hoặc mật khẩu không đúng." });
    }
    await sql`DELETE FROM fish_store_login_attempts WHERE ip_hash = ${address}`;
    setSessionCookie(res, createSession(owner.account), req);
    return sendJson(res, 200, { authenticated: true });
  } catch (error) {
    console.error("Owner login failed.", error);
    return sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Unable to sign in right now." });
  }
};
