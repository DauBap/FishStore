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

function readImageBody(body) {
  const encoded = body && typeof body === "object" ? body.data : null;
  if (typeof encoded !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw Object.assign(new Error("Image upload body is invalid."), { statusCode: 400 });
  }
  const image = Buffer.from(encoded, "base64");
  if (image.toString("base64") !== encoded) {
    throw Object.assign(new Error("Image upload body is invalid."), { statusCode: 400 });
  }
  if (image.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("Image is larger than 8 MB."), { statusCode: 413 });
  return image;
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
      if (req.query?.download === "1") {
        const chunks = await sql`
          SELECT image.content_type, image.chunk_count, chunk.chunk_index,
            ENCODE(chunk.content, 'base64') AS content_base64
          FROM fish_store_images AS image
          LEFT JOIN fish_store_image_chunks AS chunk ON chunk.image_id = image.id
          WHERE image.id = ${imageId}
          ORDER BY chunk.chunk_index
        `;
        if (!chunks.length) return sendJson(res, 404, { error: "Image not found." });
        const partCount = Number(chunks[0].chunk_count);
        if (!Number.isInteger(partCount) || partCount < 1 || partCount > 3 ||
            chunks.length !== partCount || chunks.some((chunk, index) => Number(chunk.chunk_index) !== index)) {
          return sendJson(res, 409, { error: "Image upload is incomplete." });
        }
        const image = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.content_base64, "base64")));
        if (!ALLOWED_TYPES.has(chunks[0].content_type) || !image.length || image.length > MAX_IMAGE_BYTES) {
          return sendJson(res, 409, { error: "Image data is invalid." });
        }
        setNoStoreHeaders(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", chunks[0].content_type);
        res.setHeader("Content-Length", image.length);
        return res.end(image);
      }
      const rows = await sql`SELECT content_type, chunk_count FROM fish_store_images WHERE id = ${imageId}`;
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
        FROM fish_store_image_chunks WHERE image_id = ${imageId} AND chunk_index = ${part}
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
      await sql`DELETE FROM fish_store_images WHERE id = ${imageId}`;
      return sendJson(res, 200, { deleted: true });
    }

    const contentType = String(req.body?.contentType || "").trim().toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) return sendJson(res, 415, { error: "Only JPG, PNG and WEBP images are supported." });
    const part = Number(req.query?.part);
    const parts = Number(req.query?.parts);
    if (!Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > 3 || part < 0 || part >= parts) {
      return sendJson(res, 400, { error: "Image upload part is invalid." });
    }
    const image = readImageBody(req.body);
    if (!image.length || image.length > MAX_CHUNK_BYTES ||
        (part < parts - 1 && image.length !== MAX_CHUNK_BYTES) ||
        (parts === 3 && part === 2 && image.length > 2 * 1024 * 1024)) {
      return sendJson(res, 400, { error: "Image upload chunk has an invalid size." });
    }
    if (part === 0) {
      await sql`
        INSERT INTO fish_store_images (id, content_type, chunk_count)
        VALUES (${imageId}, ${contentType}, ${parts})
        ON CONFLICT (id) DO UPDATE
        SET content_type = EXCLUDED.content_type, chunk_count = EXCLUDED.chunk_count, updated_at = NOW()
      `;
      await sql`DELETE FROM fish_store_image_chunks WHERE image_id = ${imageId}`;
    } else {
      const existing = await sql`SELECT 1 FROM fish_store_images WHERE id = ${imageId} AND content_type = ${contentType} AND chunk_count = ${parts}`;
      if (!existing.length) return sendJson(res, 409, { error: "Image upload session expired. Retry the upload." });
    }
    const base64 = image.toString("base64");
    await sql`
      INSERT INTO fish_store_image_chunks (image_id, chunk_index, content)
      VALUES (${imageId}, ${part}, DECODE(${base64}, 'base64'))
      ON CONFLICT (image_id, chunk_index) DO UPDATE SET content = EXCLUDED.content
    `;
    return sendJson(res, 200, { id: imageId });
  } catch (error) {
    console.error("Cloud image request failed.", error);
    return sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Unable to process product image." });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: "4.5mb" } } };
