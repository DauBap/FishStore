const { requireMethod, sendJson, sessionFromRequest } = require("../../lib/server");

module.exports = function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;
  const session = sessionFromRequest(req);
  if (!session) return sendJson(res, 401, { authenticated: false });
  return sendJson(res, 200, { authenticated: true, email: session.email });
};
