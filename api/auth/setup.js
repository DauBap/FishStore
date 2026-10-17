const { randomBytes, scrypt: scryptCallback } = require("node:crypto");
const { promisify } = require("node:util");
const {
  createSession,
  ensureSchema,
  getSql,
  requireMethod,
  requireSameOrigin,
  readJsonBody,
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
        body.account.length > 64 || body.password.length < 12 || body.password.length > 1024) {
      return sendJson(res, 400, { error: "Use an account up to 64 characters and a password of at least 12 characters." });
    }
    const account = body.account.trim().toLowerCase();
    if (account.length < 3 || /\s/.test(account)) {
      return sendJson(res, 400, { error: "Account must be at least 3 characters and contain no spaces." });
    }
    await ensureSchema();
    const salt = randomBytes(16);
    const passwordHash = await scrypt(body.password, salt, PASSWORD_BYTES);
    const sessionToken = createSession(account);
    const sql = getSql();
    const owners = await sql`
      INSERT INTO fish_store_owner (id, account, password_salt, password_hash)
      VALUES ('owner', ${account}, ${salt.toString("base64url")}, ${passwordHash.toString("base64url")})
      ON CONFLICT (id) DO NOTHING
      RETURNING account
    `;
    if (!owners.length) return sendJson(res, 409, { error: "The owner account has already been created." });
    setSessionCookie(res, sessionToken, req);
    return sendJson(res, 201, { authenticated: true });
  } catch (error) {
    console.error("Owner account setup failed.", error);
    return sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Unable to create the owner account." });
  }
};
