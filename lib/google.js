// Google Calendar + Tasks (read-only).
// Two modes:
//   1. Single account  — uses an OAuth refresh token (GOOGLE_REFRESH_TOKEN).
//   2. Domain-wide      — uses a service account (GOOGLE_SA_JSON) to read EVERY
//                         @pbprinc.com user's calendar + tasks. Preferred when set.
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const TOKENS_FILE = path.join(__dirname, "..", "tokens.json");

const SCOPES = (process.env.GOOGLE_SCOPES ||
  "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks.readonly")
  .split(/\s+/)
  .filter(Boolean);

const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks.readonly";
const DIR_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";

// ---------- shared shapers ----------
function mapEvent(ev) {
  return {
    id: ev.id,
    title: ev.summary || "(no title)",
    description: ev.description || "",
    location: ev.location || "",
    date: ev.start?.date || ev.start?.dateTime?.slice(0, 10) || "",
    startDateTime: ev.start?.dateTime || null,
    htmlLink: ev.htmlLink || "",
  };
}
function mapTask(t, listTitle) {
  return {
    id: t.id,
    parent: t.parent || null,
    text: t.title || "",
    notes: t.notes || "",
    done: t.status === "completed",
    list: listTitle || "",
  };
}

// ==================================================================
// MODE 1 — single account (OAuth refresh token)
// ==================================================================
function makeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}
function loadRefreshToken() {
  if (process.env.GOOGLE_REFRESH_TOKEN) return process.env.GOOGLE_REFRESH_TOKEN;
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")).refresh_token || null; }
  catch { return null; }
}
function saveRefreshToken(token) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({ refresh_token: token }, null, 2));
}
function getAuthUrl() {
  return makeClient().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
}
async function handleCallback(code) {
  const { tokens } = await makeClient().getToken(code);
  if (tokens.refresh_token) saveRefreshToken(tokens.refresh_token);
  return tokens.refresh_token;
}
function authedClient() {
  const refresh_token = loadRefreshToken();
  if (!refresh_token) throw new Error("Not connected to Google yet — visit /auth/google");
  const client = makeClient();
  client.setCredentials({ refresh_token });
  return client;
}
async function oneCalendarEvents({ days = 60 } = {}) {
  const cal = google.calendar({ version: "v3", auth: authedClient() });
  const now = new Date();
  const future = new Date(now.getTime() + days * 864e5);
  const res = await cal.events.list({
    calendarId: "primary", timeMin: now.toISOString(), timeMax: future.toISOString(),
    singleEvents: true, orderBy: "startTime", maxResults: 250,
  });
  return (res.data.items || []).map(mapEvent);
}
async function oneTasks() {
  const tasksApi = google.tasks({ version: "v1", auth: authedClient() });
  const lists = (await tasksApi.tasklists.list({ maxResults: 100 })).data.items || [];
  const out = [];
  for (const list of lists) {
    const items = (await tasksApi.tasks.list({ tasklist: list.id, showCompleted: true, maxResults: 100 })).data.items || [];
    for (const t of items) out.push(mapTask(t, list.title));
  }
  return out;
}

// ==================================================================
// MODE 2 — domain-wide delegation (service account, all users)
// ==================================================================
function getServiceAccount() {
  const b64 = process.env.GOOGLE_SA_JSON;
  if (!b64) return null;
  try { return JSON.parse(Buffer.from(b64, "base64").toString("utf8")); }
  catch { return null; }
}
function saConfigured() { return Boolean(getServiceAccount() && process.env.GOOGLE_ADMIN_EMAIL); }

function jwtFor(subject, scopes) {
  const sa = getServiceAccount();
  return new google.auth.JWT({ email: sa.client_email, key: sa.private_key, scopes, subject });
}

// Discover the users to read. Explicit TEAM_EMAILS wins; else list the domain.
async function listDomainUsers() {
  const explicit = (process.env.TEAM_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return explicit;
  const domain = process.env.GOOGLE_DOMAIN || "pbprinc.com";
  const dir = google.admin({ version: "directory_v1", auth: jwtFor(process.env.GOOGLE_ADMIN_EMAIL, [DIR_SCOPE]) });
  const users = [];
  let pageToken;
  do {
    const res = await dir.users.list({ domain, maxResults: 200, pageToken, orderBy: "email", query: "isSuspended=false" });
    for (const u of res.data.users || []) if (u.primaryEmail) users.push(u.primaryEmail);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return users;
}

async function allCalendarEvents({ days = 60 } = {}) {
  const users = await listDomainUsers();
  const now = new Date();
  const future = new Date(now.getTime() + days * 864e5);
  const out = [];
  for (const email of users) {
    try {
      const cal = google.calendar({ version: "v3", auth: jwtFor(email, [CAL_SCOPE]) });
      const res = await cal.events.list({
        calendarId: "primary", timeMin: now.toISOString(), timeMax: future.toISOString(),
        singleEvents: true, orderBy: "startTime", maxResults: 250,
      });
      for (const ev of res.data.items || []) out.push(mapEvent(ev));
    } catch (e) { /* skip a user we can't read */ }
  }
  // Collapse the same event appearing on multiple attendees' calendars.
  const seen = new Set();
  return out.filter((e) => {
    const k = (e.title || "") + "|" + (e.date || "") + "|" + (e.startDateTime || "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function allTasks() {
  const users = await listDomainUsers();
  const out = [];
  for (const email of users) {
    try {
      const tasksApi = google.tasks({ version: "v1", auth: jwtFor(email, [TASKS_SCOPE]) });
      const lists = (await tasksApi.tasklists.list({ maxResults: 100 })).data.items || [];
      for (const list of lists) {
        const items = (await tasksApi.tasks.list({ tasklist: list.id, showCompleted: true, maxResults: 100 })).data.items || [];
        for (const t of items) out.push(mapTask(t, list.title));
      }
    } catch (e) { /* skip a user we can't read */ }
  }
  return out;
}

// ==================================================================
// Public API — prefers domain-wide when configured.
// ==================================================================
function isConnected() {
  return saConfigured() || Boolean(loadRefreshToken());
}
async function fetchCalendarEvents(opts) {
  return saConfigured() ? allCalendarEvents(opts) : oneCalendarEvents(opts);
}
async function fetchTasks() {
  return saConfigured() ? allTasks() : oneTasks();
}

module.exports = {
  getAuthUrl,
  handleCallback,
  isConnected,
  saConfigured,
  listDomainUsers,
  fetchCalendarEvents,
  fetchTasks,
};
