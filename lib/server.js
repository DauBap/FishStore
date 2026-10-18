const { createHmac, timingSafeEqual } = require("node:crypto");
const { neon } = require("@neondatabase/serverless");

const COOKIE_NAME = "fish_store_session";
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
        DO $$
        BEGIN
          IF (to_regclass('fish_store_data') IS NOT NULL AND to_regclass('kho_moc_store') IS NOT NULL)
            OR (to_regclass('fish_store_images') IS NOT NULL AND to_regclass('kho_moc_images') IS NOT NULL)
            OR (to_regclass('fish_store_image_chunks') IS NOT NULL AND to_regclass('kho_moc_image_chunks') IS NOT NULL)
            OR (to_regclass('fish_store_login_attempts') IS NOT NULL AND to_regclass('kho_moc_login_attempts') IS NOT NULL)
          THEN
            RAISE EXCEPTION 'Both old and new Fish Store tables exist; refusing to risk data loss.';
          END IF;

          IF to_regclass('fish_store_data') IS NULL AND to_regclass('kho_moc_store') IS NOT NULL THEN
            ALTER TABLE kho_moc_store RENAME TO fish_store_data;
          END IF;
          IF to_regclass('fish_store_images') IS NULL AND to_regclass('kho_moc_images') IS NOT NULL THEN
            ALTER TABLE kho_moc_images RENAME TO fish_store_images;
          END IF;
          IF to_regclass('fish_store_image_chunks') IS NULL AND to_regclass('kho_moc_image_chunks') IS NOT NULL THEN
            ALTER TABLE kho_moc_image_chunks RENAME TO fish_store_image_chunks;
          END IF;
          IF to_regclass('fish_store_login_attempts') IS NULL AND to_regclass('kho_moc_login_attempts') IS NOT NULL THEN
            ALTER TABLE kho_moc_login_attempts RENAME TO fish_store_login_attempts;
          END IF;

          IF to_regclass('fish_store_login_attempts_time_idx') IS NULL AND to_regclass('kho_moc_login_attempts_time_idx') IS NOT NULL THEN
            ALTER INDEX kho_moc_login_attempts_time_idx RENAME TO fish_store_login_attempts_time_idx;
          END IF;
        END;
        $$
      `;
      await Promise.all([
        sql`
          CREATE TABLE IF NOT EXISTS fish_store_data (
            id TEXT PRIMARY KEY CHECK (id = 'owner'),
            payload JSONB NOT NULL,
            revision BIGINT NOT NULL DEFAULT 1,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `,
        sql`
          CREATE TABLE IF NOT EXISTS fish_store_store_state (
            id TEXT PRIMARY KEY CHECK (id = 'owner'),
            revision BIGINT NOT NULL DEFAULT 0,
            has_data BOOLEAN NOT NULL DEFAULT FALSE,
            legacy_migrated BOOLEAN NOT NULL DEFAULT FALSE
          )
        `,
        sql`CREATE TABLE IF NOT EXISTS fish_store_products (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload JSONB NOT NULL)`,
        sql`CREATE TABLE IF NOT EXISTS fish_store_customers (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload JSONB NOT NULL)`,
        sql`CREATE TABLE IF NOT EXISTS fish_store_orders (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload JSONB NOT NULL)`,
        sql`CREATE TABLE IF NOT EXISTS fish_store_receipts (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload JSONB NOT NULL)`,
        sql`CREATE TABLE IF NOT EXISTS fish_store_fish_intakes (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload JSONB NOT NULL)`,
        sql`CREATE TABLE IF NOT EXISTS fish_store_expenses (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload JSONB NOT NULL)`,
        sql`CREATE TABLE IF NOT EXISTS fish_store_fish_rewards (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload JSONB NOT NULL)`,
        sql`CREATE TABLE IF NOT EXISTS fish_store_units (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload JSONB NOT NULL)`,
        sql`
          CREATE TABLE IF NOT EXISTS fish_store_images (
            id TEXT PRIMARY KEY,
            content_type TEXT NOT NULL,
            chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 3),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `,
        sql`
          CREATE TABLE IF NOT EXISTS fish_store_login_attempts (
            ip_hash TEXT NOT NULL,
            attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `,
        sql`
          CREATE TABLE IF NOT EXISTS fish_store_owner (
            id TEXT PRIMARY KEY CHECK (id = 'owner'),
            account TEXT NOT NULL UNIQUE,
            password_salt TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `,
      ]);
      await sql`
        DO $$
        BEGIN
          ALTER TABLE fish_store_store_state ADD COLUMN IF NOT EXISTS has_data BOOLEAN NOT NULL DEFAULT FALSE;
          INSERT INTO fish_store_store_state (id) VALUES ('owner') ON CONFLICT (id) DO NOTHING;
        END;
        $$
      `;
      await Promise.all([
        sql`
          CREATE TABLE IF NOT EXISTS fish_store_image_chunks (
            image_id TEXT NOT NULL REFERENCES fish_store_images (id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 2),
            content BYTEA NOT NULL,
            PRIMARY KEY (image_id, chunk_index)
          )
        `,
        sql`CREATE INDEX IF NOT EXISTS fish_store_login_attempts_time_idx ON fish_store_login_attempts (ip_hash, attempted_at)`,
      ]);
      await Promise.all([
        sql`
        CREATE OR REPLACE FUNCTION fish_store_write_payload(store_payload JSONB)
        RETURNS VOID
        LANGUAGE plpgsql
        AS $$
        DECLARE
          collection RECORD;
          item JSONB;
          item_position INTEGER;
          item_id TEXT;
        BEGIN
          FOR collection IN
            SELECT * FROM (VALUES
              ('products', 'fish_store_products'),
              ('customers', 'fish_store_customers'),
              ('orders', 'fish_store_orders'),
              ('receipts', 'fish_store_receipts'),
              ('fishIntakes', 'fish_store_fish_intakes'),
              ('expenses', 'fish_store_expenses'),
              ('fishRewards', 'fish_store_fish_rewards'),
              ('units', 'fish_store_units')
            ) AS collections(payload_key, table_name)
          LOOP
            EXECUTE format('DELETE FROM %I', collection.table_name);
            FOR item, item_position IN
              SELECT value, ordinal::INTEGER
              FROM jsonb_array_elements(COALESCE(store_payload->collection.payload_key, '[]'::JSONB))
                WITH ORDINALITY AS entries(value, ordinal)
            LOOP
              IF collection.payload_key = 'units' THEN
                IF jsonb_typeof(item) <> 'string' THEN
                  RAISE EXCEPTION 'Invalid unit in store payload at position %.', item_position;
                END IF;
                item_id := 'unit-' || item_position;
                item := jsonb_build_object('value', item);
              ELSE
                IF jsonb_typeof(item) <> 'object' THEN
                  RAISE EXCEPTION 'Invalid record in store collection % at position %.', collection.payload_key, item_position;
                END IF;
                item_id := COALESCE(NULLIF(item->>'id', ''), 'legacy-' || collection.payload_key || '-' || item_position);
                item := item || jsonb_build_object('id', item_id);
              END IF;
              EXECUTE format(
                'INSERT INTO %I (id, position, payload) VALUES ($1, $2, $3)',
                collection.table_name
              ) USING item_id, item_position, item;
            END LOOP;
          END LOOP;
        END;
        $$
        `,
        sql`
        CREATE OR REPLACE FUNCTION fish_store_replace_payload(store_payload JSONB, expected_revision BIGINT)
        RETURNS BIGINT
        LANGUAGE plpgsql
        AS $$
        DECLARE
          next_revision BIGINT;
        BEGIN
          UPDATE fish_store_store_state
          SET revision = revision + 1, has_data = TRUE
          WHERE id = 'owner' AND revision = expected_revision
          RETURNING revision INTO next_revision;
          IF NOT FOUND THEN
            RETURN NULL;
          END IF;
          PERFORM fish_store_write_payload(store_payload);
          RETURN next_revision;
        END;
        $$
        `,
        sql`
        CREATE OR REPLACE FUNCTION fish_store_migrate_legacy_payload()
        RETURNS VOID
        LANGUAGE plpgsql
        AS $$
        DECLARE
          legacy_payload JSONB;
          legacy_revision BIGINT;
          migration_complete BOOLEAN;
        BEGIN
          SELECT legacy_migrated INTO migration_complete
          FROM fish_store_store_state
          WHERE id = 'owner'
          FOR UPDATE;
          IF migration_complete THEN
            RETURN;
          END IF;
          SELECT payload, revision INTO legacy_payload, legacy_revision
          FROM fish_store_data
          WHERE id = 'owner';
          IF FOUND THEN
            PERFORM fish_store_write_payload(legacy_payload);
            UPDATE fish_store_store_state
            SET revision = legacy_revision, has_data = TRUE, legacy_migrated = TRUE
            WHERE id = 'owner';
          ELSE
            UPDATE fish_store_store_state
            SET legacy_migrated = TRUE
            WHERE id = 'owner';
          END IF;
        END;
        $$
        `,
      ]);
      await sql`SELECT fish_store_migrate_legacy_payload()`;
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

function createSession(account) {
  const payload = Buffer.from(JSON.stringify({ account, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function sessionFromRequest(req) {
  const cookie = req.headers.cookie || "";
  const sessionCookie = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!sessionCookie) return null;
  let token;
  try {
    token = decodeURIComponent(sessionCookie.slice(COOKIE_NAME.length + 1));
  } catch {
    return null;
  }
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof session.account !== "string" || !Number.isInteger(session.exp) || session.exp <= Date.now() / 1000) return null;
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
  if (!host) return false;
  if (!origin) return true;
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

function ipHash(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  return createHmac("sha256", getSessionSecret()).update(ip).digest("hex");
}

module.exports = {
  clearSessionCookie,
  createSession,
  ensureSchema,
  getSql,
  hasSameOrigin,
  ipHash,
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  requireSession,
  safeEqual,
  sessionFromRequest,
  sendJson,
  setNoStoreHeaders,
  setSessionCookie,
};
