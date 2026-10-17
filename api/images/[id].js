const {
  ensureSchema,
  getSql,
  requireMethod,
  requireSameOrigin,
  requireSession,
  sendJson,
  setNoStoreHeaders,
} = require("../../lib/server");

const MAX_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function readImageBody(req) {
  if (req.body != null) {
    const value = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    if (value.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("Image is larger than 8 MB."), { statusCode: 413 });
    return value;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_IMAGE_BYTES) throw Object.assign(new Error("Image is larger than 8 MB."), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  if (!["GET", "PUT", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, PUT, DELETE");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  if (req.method !== "GET" && !requireSameOrigin(req, res)) return;
  if (!requireSession(req, res)) return;
  const imageId = String(req.query?.id || "");
  if (!/^[\w-]{1,80}$/.test(imageId)) return sendJson(res, 400, { error: "Image ID is invalid." });

  try {
    await ensureSchema();
    const sql = getSql();
    if (req.method === "GET") {
      const rows = await sql`SELECT content_type, chunk_count FROM kho_moc_images WHERE id = ${imageId}`;
      if (!rows.length) return sendJson(res, 404, { error: "Image not found." });
      if (req.query?.part === undefined) {
        return sendJson(res, 200, { contentType: rows[0].content_type, parts: Number(rows[0].chunk_count) });
      }
      const part = Number(req.query.part);
      if (!Number.isInteger(part) || part < 0 || part >= Number(rows[0].chunk_count)) {
        return sendJson(res, 400, { error: "Image download part is invalid." });
      }
      const chunks = await sql`
        SELECT ENCODE(content, 'base64') AS content_base64
        FROM kho_moc_image_chunks WHERE image_id = ${imageId} AND chunk_index = ${part}
      `;
      if (!chunks.length) return sendJson(res, 409, { error: "Image upload is incomplete." });
      const image = Buffer.from(chunks[0].content_base64, "base64");
      setNoStoreHeaders(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", image.length);
      return res.end(image);
    }
    if (req.method === "DELETE") {
      await sql`DELETE FROM kho_moc_images WHERE id = ${imageId}`;
      return sendJson(res, 200, { deleted: true });
    }

    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) return sendJson(res, 415, { error: "Only JPG, PNG and WEBP images are supported." });
    const part = Number(req.query?.part);
    const parts = Number(req.query?.parts);
    if (!Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > 3 || part < 0 || part >= parts) {
      return sendJson(res, 400, { error: "Image upload part is invalid." });
    }
    const image = await readImageBody(req);
    if (!image.length || image.length > MAX_CHUNK_BYTES ||
        (part < parts - 1 && image.length !== MAX_CHUNK_BYTES) ||
        (parts === 3 && part === 2 && image.length > 2 * 1024 * 1024)) {
      return sendJson(res, 400, { error: "Image upload chunk has an invalid size." });
    }
    if (part === 0) {
      await sql`
        INSERT INTO kho_moc_images (id, content_type, chunk_count)
        VALUES (${imageId}, ${contentType}, ${parts})
        ON CONFLICT (id) DO UPDATE
        SET content_type = EXCLUDED.content_type, chunk_count = EXCLUDED.chunk_count, updated_at = NOW()
      `;
      await sql`DELETE FROM kho_moc_image_chunks WHERE image_id = ${imageId}`;
    } else {
      const existing = await sql`SELECT 1 FROM kho_moc_images WHERE id = ${imageId} AND content_type = ${contentType} AND chunk_count = ${parts}`;
      if (!existing.length) return sendJson(res, 409, { error: "Image upload session expired. Retry the upload." });
    }
    const base64 = image.toString("base64");
    await sql`
      INSERT INTO kho_moc_image_chunks (image_id, chunk_index, content)
      VALUES (${imageId}, ${part}, DECODE(${base64}, 'base64'))
      ON CONFLICT (image_id, chunk_index) DO UPDATE SET content = EXCLUDED.content
    `;
    return sendJson(res, 200, { id: imageId });
  } catch (error) {
    console.error("Cloud image request failed.", error);
    return sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Unable to process product image." });
  }
};

module.exports.config = { api: { bodyParser: false } };
