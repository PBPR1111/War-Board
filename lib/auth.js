// Login gate: Google sign-in restricted to the company Workspace.
// Enforced only when REQUIRE_LOGIN=true (so local dev stays frictionless).
const { google } = require("googleapis");

function baseUrl() {
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

function requireLogin() {
  return String(process.env.REQUIRE_LOGIN || "").toLowerCase() === "true";
}

function loginClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${baseUrl()}/auth/login/callback`
  );
}

// Who's allowed in. The OAuth app is "Internal", so Google already restricts
// sign-in to your Workspace org. ALLOWED_EMAILS / ALLOWED_EMAIL_DOMAIN can
// tighten it further (optional).
function allowedEmail(email) {
  const e = String(email || "").toLowerCase();
  const domain = String(process.env.ALLOWED_EMAIL_DOMAIN || "").toLowerCase().trim();
  const list = String(process.env.ALLOWED_EMAILS || "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length && list.includes(e)) return true;
  if (domain && e.endsWith("@" + domain)) return true;
  if (!domain && !list.length) return true; // rely on Internal-app restriction
  return false;
}

function requireAuth(req, res, next) {
  if (!requireLogin()) return next();
  if (req.session && req.session.email) return next();
  if (req.session) req.session.returnTo = req.originalUrl;
  return res.redirect("/login");
}

function getLoginUrl() {
  return loginClient().generateAuthUrl({
    scope: ["openid", "email", "profile"],
    prompt: "select_account",
  });
}

async function handleLoginCallback(code) {
  const { tokens } = await loginClient().getToken(code);
  const idToken = tokens.id_token || "";
  const payload = JSON.parse(Buffer.from(idToken.split(".")[1] || "", "base64").toString() || "{}");
  return { email: payload.email, verified: payload.email_verified };
}

module.exports = { requireAuth, requireLogin, getLoginUrl, handleLoginCallback, allowedEmail };
