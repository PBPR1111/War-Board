// Leap / JobProgress API client.
// Docs: https://docs.api.jobprogress.com  (base URL + Bearer auth)
//
// We don't yet know the exact field names JobProgress returns for stage /
// customer / address, so this client normalizes defensively and the server
// exposes a /api/debug/leap route that returns the RAW response for mapping.

const BASE_URL = process.env.LEAP_BASE_URL || "https://api.jobprogress.com/api/v3";
const TOKEN = process.env.LEAP_API_KEY;

// The three board columns, as seen at the top of the JobProgress home page.
const STAGES = ["Lead", "Estimate", "Work"];

async function leapGet(path, params = {}) {
  if (!TOKEN) throw new Error("LEAP_API_KEY is missing from .env");
  const url = new URL(BASE_URL.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Leap API ${res.status} ${res.statusText} for ${url.pathname} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

// JobProgress paginates; pull every page (cap at 20 for safety).
async function leapGetAll(path, params = {}) {
  let page = 1;
  const all = [];
  while (page <= 20) {
    const json = await leapGet(path, { ...params, page });
    const rows = json.data || json.results || json.items || (Array.isArray(json) ? json : []);
    all.push(...rows);
    const meta = json.meta || json.pagination || {};
    const lastPage = meta.last_page || meta.total_pages || meta.pages;
    if (!rows.length || (lastPage && page >= lastPage)) break;
    page += 1;
  }
  return all;
}

// Best-effort read of a nested value from a list of candidate paths.
function pick(obj, paths, fallback = "") {
  for (const p of paths) {
    const val = p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return fallback;
}

function normalizeStage(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.includes("lead")) return "Lead";
  if (s.includes("estimat") || s.includes("proposal") || s.includes("quote")) return "Estimate";
  if (s.includes("work") || s.includes("job") || s.includes("production") || s.includes("install")) return "Work";
  return ""; // unknown — will be reported, not silently bucketed
}

function customerName(c) {
  return (
    pick(c, ["name", "display_name", "full_name"]) ||
    [pick(c, ["first_name"]), pick(c, ["last_name"])].filter(Boolean).join(" ")
  );
}

function customerAddress(c) {
  return (
    pick(c, ["address.full_address", "full_address", "address.address"]) ||
    [
      pick(c, ["address.address", "address_line1", "street", "address1"]),
      pick(c, ["address.city", "city"]),
      pick(c, ["address.state", "state"]),
    ]
      .filter(Boolean)
      .join(", ")
  );
}

// Build a map of customer_id -> { name, address } so jobs can be enriched.
async function fetchCustomersMap() {
  const path = process.env.LEAP_CUSTOMERS_PATH || "/customers";
  const rows = await leapGetAll(path);
  const map = new Map();
  for (const c of rows) {
    map.set(String(c.id), { name: customerName(c), address: customerAddress(c) });
  }
  return map;
}

function normalizeJob(j, customersById) {
  const cust = customersById.get(String(j.customer_id)) || {};
  const rawStage = pick(j, ["current_stage.name", "stage.name", "stage", "status.name", "status"]);
  return {
    id: String(pick(j, ["id", "job_id", "uuid", "number"], "")),
    number: pick(j, ["number"], ""),
    name: pick(j, ["name", "description", "title"], "Untitled job"),
    customer: cust.name || "—",
    address: cust.address || "",
    stage: normalizeStage(rawStage),
    rawStage: String(rawStage || ""),
  };
}

async function fetchJobs() {
  const path = process.env.LEAP_JOBS_PATH || "/jobs";
  // Customers are needed for client name + address; tolerate failure gracefully.
  const [rows, customers] = await Promise.all([
    leapGetAll(path),
    fetchCustomersMap().catch(() => new Map()),
  ]);
  return rows.map((j) => normalizeJob(j, customers));
}

// Raw passthrough for one page — used to inspect real schema during setup.
async function fetchJobsRaw() {
  const path = process.env.LEAP_JOBS_PATH || "/jobs";
  return leapGet(path, { page: 1 });
}

async function fetchCustomersRaw() {
  const path = process.env.LEAP_CUSTOMERS_PATH || "/customers";
  return leapGet(path, { page: 1 });
}

module.exports = { fetchJobs, fetchJobsRaw, fetchCustomersRaw, STAGES };
