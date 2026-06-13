// Google OAuth + Calendar + Tasks (read-only).
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const TOKENS_FILE = path.join(__dirname, "..", "tokens.json");

const SCOPES = (process.env.GOOGLE_SCOPES ||
  "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks.readonly")
  .split(/\s+/)
  .filter(Boolean);

function makeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function loadRefreshToken() {
  if (process.env.GOOGLE_REFRESH_TOKEN) return process.env.GOOGLE_REFRESH_TOKEN;
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")).refresh_token || null;
  } catch {
    return null;
  }
}

function saveRefreshToken(token) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({ refresh_token: token }, null, 2));
}

function isConnected() {
  return Boolean(loadRefreshToken());
}

// Step 1: URL the user visits to grant access.
function getAuthUrl() {
  return makeClient().generateAuthUrl({
    access_type: "offline", // required to receive a refresh token
    prompt: "consent", // force refresh_token on every grant
    scope: SCOPES,
  });
}

// Step 2: exchange the ?code from the callback for tokens, persist refresh token.
async function handleCallback(code) {
  const client = makeClient();
  const { tokens } = await client.getToken(code);
  if (tokens.refresh_token) saveRefreshToken(tokens.refresh_token);
  return tokens.refresh_token;
}

// Authenticated client for API calls (uses stored refresh token).
function authedClient() {
  const refresh_token = loadRefreshToken();
  if (!refresh_token) throw new Error("Not connected to Google yet — visit /auth/google");
  const client = makeClient();
  client.setCredentials({ refresh_token });
  return client;
}

async function fetchCalendarEvents({ days = 60 } = {}) {
  const auth = authedClient();
  const cal = google.calendar({ version: "v3", auth });
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });
  return (res.data.items || []).map((ev) => ({
    id: ev.id,
    title: ev.summary || "(no title)",
    description: ev.description || "",
    location: ev.location || "",
    date: ev.start?.date || ev.start?.dateTime?.slice(0, 10) || "",
  }));
}

async function fetchTasks() {
  const auth = authedClient();
  const tasksApi = google.tasks({ version: "v1", auth });
  const lists = (await tasksApi.tasklists.list({ maxResults: 100 })).data.items || [];
  const out = [];
  for (const list of lists) {
    const items = (await tasksApi.tasks.list({ tasklist: list.id, showCompleted: true, maxResults: 100 })).data.items || [];
    for (const t of items) {
      out.push({
        id: t.id,
        text: t.title || "",
        notes: t.notes || "",
        done: t.status === "completed",
        list: list.title || "",
      });
    }
  }
  return out;
}

module.exports = {
  getAuthUrl,
  handleCallback,
  isConnected,
  fetchCalendarEvents,
  fetchTasks,
};
