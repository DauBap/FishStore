const { clearSessionCookie, requireMethod, requireSameOrigin, sendJson } = require("../../lib/server");

module.exports = function handler(req, res) {
  if (!requireMethod(req, res, "POST") || !requireSameOrigin(req, res)) return;
  clearSessionCookie(res, req);
  return sendJson(res, 200, { authenticated: false });
};
