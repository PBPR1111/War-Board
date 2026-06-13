require("dotenv").config();
const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");
const leap = require("./lib/leap");
const googleSvc = require("./lib/google");
const auth = require("./lib/auth");
const { buildBoard } = require("./lib/match");

const app = express();
const PORT =
  Number(process.env.PORT) ||
  Number((process.env.GOOGLE_REDIRECT_URI || "").match(/:(\d+)/)?.[1]) ||
  3000;

// Behind Render's proxy; needed for secure cookies.
app.set("trust proxy", 1);
app.use(
  cookieSession({
    name: "wb_sess",
    keys: [process.env.SESSION_SECRET || "dev-insecure-change-me"],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  })
);

// ---- Health check (ungated, for Render) ----
app.get("/healthz", (req, res) => res.send("ok"));

// ---- Login (Google sign-in, company-only) ----
app.get("/login", (req, res) => {
  if (!auth.requireLogin()) return res.redirect("/");
  res.send(`<!doctype html><meta charset="utf-8"><title>War Board — Sign in</title>
    <div style="font-family:system-ui;max-width:380px;margin:18vh auto;text-align:center">
      <h1 style="font-size:20px">War Board</h1>
      <p style="color:#64748b;font-size:14px">Sign in with your company Google account to view the board.</p>
      <a href="/auth/login" style="display:inline-block;margin-top:12px;background:#0f172a;color:#fff;
         text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">Sign in with Google</a>
    </div>`);
});

app.get("/auth/login", (req, res) => res.redirect(auth.getLoginUrl()));

app.get("/auth/login/callback", async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    const { email } = await auth.handleLoginCallback(String(req.query.code || ""));
    if (!auth.allowedEmail(email)) {
      return res
        .status(403)
        .send(`<h2>Access denied</h2><p>${email || "This account"} isn't authorized for this board.</p>`);
    }
    req.session.email = email;
    const dest = req.session.returnTo || "/";
    req.session.returnTo = null;
    res.redirect(dest);
  } catch (e) {
    res.status(500).send(`<h2>Login error</h2><pre>${e.message}</pre>`);
  }
});

app.get("/logout", (req, res) => {
  req.session = null;
  res.redirect("/login");
});

// ---- Everything below requires login (when REQUIRE_LOGIN=true) ----
app.use(auth.requireAuth);

app.use(express.static(path.join(__dirname, "public")));

// ---- Google OAuth (one-time consent to mint the refresh token) ----
app.get("/auth/google", (req, res) => {
  res.redirect(googleSvc.getAuthUrl());
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    const token = await googleSvc.handleCallback(String(req.query.code || ""));
    res.send(
      `<h2>✅ Google connected${token ? "" : " (no new refresh token — already connected)"}.</h2>` +
        `<p>You can close this tab and return to the board. <a href="/">Open board →</a></p>`
    );
  } catch (e) {
    res.status(500).send(`<h2>OAuth error</h2><pre>${e.message}</pre>`);
  }
});

// ---- Status: what's connected ----
app.get("/api/status", (req, res) => {
  res.json({
    leapKey: Boolean(process.env.LEAP_API_KEY),
    googleConnected: googleSvc.isConnected(),
  });
});

// ---- Individual sources (handy for debugging) ----
app.get("/api/jobs", async (req, res) => {
  try { res.json(await leap.fetchJobs()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/calendar-events", async (req, res) => {
  try { res.json(await googleSvc.fetchCalendarEvents()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/tasks", async (req, res) => {
  try { res.json(await googleSvc.fetchTasks()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- Compact Leap schema preview — use this once to confirm real field names ----
app.get("/api/debug/leap", async (req, res) => {
  try {
    const raw = await leap.fetchJobsRaw();
    const rows = raw.data || raw.results || raw.items || (Array.isArray(raw) ? raw : []);
    const first = rows[0] || {};
    res.json({
      envelopeKeys: Object.keys(raw),
      jobCountThisPage: rows.length,
      firstJobKeys: Object.keys(first),
      firstJob: first,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Full raw (in case we need it) ----
app.get("/api/debug/leap-full", async (req, res) => {
  try { res.json(await leap.fetchJobsRaw()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- Probe a job's documents/files endpoints (run once to discover the API) ----
app.get("/api/debug/documents", async (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ error: "Add ?jobId=NUMBER (e.g. 7889348)" });
  const candidates = [
    `/jobs/${jobId}/proposals`,
    `/jobs/${jobId}/documents`,
    `/jobs/${jobId}/files`,
    `/jobs/${jobId}/photos`,
    `/jobs/${jobId}`,
  ];
  const out = {};
  for (const p of candidates) {
    try {
      const json = await leap.rawGet(p);
      const rows = json.data || json.results || json.items || (Array.isArray(json) ? json : [json]);
      out[p] = { ok: true, count: Array.isArray(rows) ? rows.length : 0, sampleKeys: Object.keys(rows[0] || {}), sample: rows[0] || null };
    } catch (e) {
      out[p] = { ok: false, error: e.message };
    }
  }
  res.json(out);
});

// ---- Distinct stage names + counts (for building the column mapping) ----
app.get("/api/debug/stages", async (req, res) => {
  try {
    const jobs = await leap.fetchJobs();
    const counts = {};
    for (const j of jobs) {
      const key = j.rawStage || "(blank)";
      counts[key] = (counts[key] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    res.json({ totalJobs: jobs.length, stages: Object.fromEntries(sorted) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Compact customer schema preview ----
app.get("/api/debug/leap-customer", async (req, res) => {
  try {
    const raw = await leap.fetchCustomersRaw();
    const rows = raw.data || raw.results || raw.items || (Array.isArray(raw) ? raw : []);
    const first = rows[0] || {};
    res.json({ envelopeKeys: Object.keys(raw), firstCustomerKeys: Object.keys(first), firstCustomer: first });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Combined board payload (jobs + matched events + matched tasks) ----
// Cached in memory so all viewers + auto-refreshes share one upstream pull,
// which keeps us well under Leap's rate limit. Stale data is served if a
// refresh fails (e.g. a transient Leap 429), so the board never goes blank.
const BOARD_CACHE_MS = Number(process.env.BOARD_CACHE_MS) || 10 * 60 * 1000;
let boardCache = null; // { payload, ts }
let boardInFlight = null;

async function buildBoardPayload() {
  const jobs = await leap.fetchJobs();
  let events = [];
  let tasks = [];
  let googleError = null;
  if (googleSvc.isConnected()) {
    try {
      [events, tasks] = await Promise.all([
        googleSvc.fetchCalendarEvents(),
        googleSvc.fetchTasks(),
      ]);
    } catch (e) {
      googleError = e.message;
    }
  }
  const board = buildBoard(jobs, events, tasks);
  return {
    stages: leap.STAGES,
    googleConnected: googleSvc.isConnected(),
    googleError,
    generatedAt: new Date().toISOString(),
    ...board,
  };
}

app.get("/api/board-data", async (req, res) => {
  const fresh = boardCache && Date.now() - boardCache.ts < BOARD_CACHE_MS;
  const force = req.query.force === "1";
  if (fresh && !force) {
    return res.json({ ...boardCache.payload, cached: true });
  }
  try {
    // Coalesce concurrent rebuilds into a single upstream fetch.
    if (!boardInFlight) {
      boardInFlight = buildBoardPayload().finally(() => { boardInFlight = null; });
    }
    const payload = await boardInFlight;
    boardCache = { payload, ts: Date.now() };
    res.json(payload);
  } catch (e) {
    // On failure, fall back to stale cache rather than breaking the board.
    if (boardCache) {
      return res.json({
        ...boardCache.payload,
        cached: true,
        refreshError: e.message,
      });
    }
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  War Board running →  http://localhost:${PORT}\n`);
  if (!googleSvc.isConnected()) {
    console.log(`  Google not connected yet. Open http://localhost:${PORT}/auth/google once to grant access.\n`);
  }
});
