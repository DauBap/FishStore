const { createHmac, timingSafeEqual } = require("node:crypto");
const { neon } = require("@neondatabase/serverless");

const COOKIE_NAME = "kho_moc_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
let schemaReady;
let sqlClient;

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS kho_moc_store (
          id TEXT PRIMARY KEY CHECK (id = 'owner'),
          payload JSONB NOT NULL,
          revision BIGINT NOT NULL DEFAULT 1,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS kho_moc_images (
          id TEXT PRIMARY KEY,
          content_type TEXT NOT NULL,
          chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 3),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS kho_moc_image_chunks (
          image_id TEXT NOT NULL REFERENCES kho_moc_images (id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 2),
          content BYTEA NOT NULL,
          PRIMARY KEY (image_id, chunk_index)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS kho_moc_login_attempts (
          ip_hash TEXT NOT NULL,
          attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS kho_moc_login_attempts_time_idx ON kho_moc_login_attempts (ip_hash, attempted_at)`;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters.");
  return secret;
}

function sign(value) {
  return createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createSession(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function sessionFromRequest(req) {
  const cookie = req.headers.cookie || "";
  const sessionCookie = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!sessionCookie) return null;
  const token = decodeURIComponent(sessionCookie.slice(COOKIE_NAME.length + 1));
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof session.email !== "string" || !Number.isInteger(session.exp) || session.exp <= Date.now() / 1000) return null;
    return session;
  } catch {
    return null;
  }
}

function setSessionCookie(res, token, req) {
  const secure = req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`);
}

function clearSessionCookie(res, req) {
  const secure = req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
}

function setNoStoreHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
}

function sendJson(res, status, body) {
  setNoStoreHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function requireMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader("Allow", method);
  sendJson(res, 405, { error: "Method not allowed." });
  return false;
}

function hasSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const secureRequest = req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production";
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    return parsed.host === host && (parsed.protocol === "https:" || (!secureRequest && localHost));
  } catch {
    return false;
  }
}

function requireSameOrigin(req, res) {
  if (hasSameOrigin(req)) return true;
  sendJson(res, 403, { error: "Request origin is not allowed." });
  return false;
}

function requireSession(req, res) {
  const session = sessionFromRequest(req);
  if (session) return session;
  sendJson(res, 401, { error: "Please sign in again." });
  return null;
}

function readJsonBody(req, maximumBytes = 5 * 1024 * 1024) {
  if (req.body && typeof req.body === "object") {
    const body = JSON.stringify(req.body);
    if (Buffer.byteLength(body) > maximumBytes) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maximumBytes) {
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function configuredOwner(res) {
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD;
  if (email && password && password.length >= 12) return { email, password };
  sendJson(res, 500, { error: "Owner login is not configured. Check OWNER_EMAIL and OWNER_PASSWORD." });
  return null;
}

function ipHash(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  return createHmac("sha256", getSessionSecret()).update(ip).digest("hex");
}

module.exports = {
  clearSessionCookie,
  configuredOwner,
  createSession,
  ensureSchema,
  getSql,
  ipHash,
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  requireSession,
  safeEqual,
  sendJson,
  setNoStoreHeaders,
  setSessionCookie,
  sessionFromRequest,
};
