// Leap / JobProgress API client.
// Docs: https://docs.api.jobprogress.com  (base URL + Bearer auth)
//
// We don't yet know the exact field names JobProgress returns for stage /
// customer / address, so this client normalizes defensively and the server
// exposes a /api/debug/leap route that returns the RAW response for mapping.

const BASE_URL = process.env.LEAP_BASE_URL || "https://api.jobprogress.com/api/v3";
const TOKEN = process.env.LEAP_API_KEY;

// Board columns (left → right), matching the JobProgress workflow stages.
const STAGES = ["Estimate", "Proposal", "Pre Production", "Work"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function leapGet(path, params = {}, attempt = 0) {
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
  // Respect rate limiting (429) and transient server errors (5xx): bounded
  // backoff with several attempts, since a full board build makes many calls.
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const retryAfter = Number(res.headers.get("retry-after")) || (2 * (attempt + 1));
    await sleep(Math.min(retryAfter, 15) * 1000);
    return leapGet(path, params, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Leap API ${res.status} ${res.statusText} for ${url.pathname} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

// JobProgress paginates; pull EVERY page. We request a large page size so the
// whole list comes back in a few calls, and we stop at the real last page.
// (Previously this capped at 20 pages of 10 = 200 rows, which silently dropped
// jobs/customers on accounts larger than that.)
async function leapGetAll(path, params = {}) {
  let page = 1;
  const all = [];
  const MAX_PAGES = 100; // safety ceiling; the real stop is the API's last page
  let perPage = 100;     // big pages = fewer calls, but some endpoints reject it
  while (page <= MAX_PAGES) {
    let json;
    try {
      json = await leapGet(path, { per_page: perPage, ...params, page });
    } catch (e) {
      // Some endpoints (e.g. /customers) reject a large per_page. Drop it and
      // retry this page at the API's default size.
      if (perPage !== undefined) {
        perPage = undefined;
        try {
          json = await leapGet(path, { ...params, page });
        } catch (e2) {
          break; // still failing (e.g. rate limit) — keep what we have so far
        }
      } else {
        break; // a page failed (e.g. rate limit) — return partial, never empty-out
      }
    }
    const rows = json.data || json.results || json.items || (Array.isArray(json) ? json : []);
    all.push(...rows);
    // JobProgress nests pagination under meta.pagination; support flat shapes too.
    const meta = json.meta || json.pagination || {};
    const pag = meta.pagination || meta;
    const lastPage = pag.total_pages || pag.last_page || pag.pages;
    if (!rows.length || (lastPage && page >= lastPage)) break;
    page += 1;
    if (page <= MAX_PAGES) await sleep(120); // gentle pacing to avoid 429s
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

// Intentional mapping of THIS account's JobProgress stages to the board columns.
// The board shows ONLY: Estimate, Proposal, Pre Production, Work.
//   Estimate       <- "Estimate" + "On-Site Consultation"
//   Proposal       <- "Proposal"
//   Pre Production <- "Pre Production"
//   Work           <- "Work"
// A stage mapped to null is deliberately kept OFF the board: everything before
// Estimate (Lead, Showroom Appointment, Appointment Set, Bad Lead) plus
// Contract Signed and Paid.
const STAGE_TO_COLUMN = {
  "estimate": "Estimate",
  "on-site consultation": "Estimate",
  "proposal": "Proposal",
  "pre production": "Pre Production",
  "pre-production": "Pre Production",
  "work": "Work",
  // Deliberately hidden from the board:
  "lead": null,
  "showroom appointment": null,
  "appointment set": null,
  "bad lead -did not move forward": null,
  "contract signed": null,
  "paid": null,
};

function normalizeStage(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (/pre[\s-]?production/.test(s)) return "Pre Production";
  if (Object.prototype.hasOwnProperty.call(STAGE_TO_COLUMN, s)) return STAGE_TO_COLUMN[s];
  // Tolerant matching for the four visible columns only (handles minor renames).
  // Note: hidden stages are caught by the explicit map above, so they never
  // reach this fallback. Anything still unmatched stays OFF the board (null).
  if (/proposal/.test(s)) return "Proposal";
  if (/\bwork\b/.test(s)) return "Work";
  if (/(estimat|on[\s-]?site|consult)/.test(s)) return "Estimate";
  return null;
}

// A job in a finished or dead CRM stage (Completed, Cancelled, Lost, …) should
// drop off the active board entirely rather than linger under Work.
function isTerminalStage(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return /(complet|finished|\bdone\b|cancel|\blost\b|\bdead\b|abandon)/.test(s);
}

function customerName(c) {
  // Prefer the BUSINESS/company name (e.g. "Group 9") over the contact person.
  return (
    pick(c, ["company_name", "company", "business_name", "organization", "business"]) ||
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
// Cached longer than jobs since customer details change rarely.
const CUSTOMERS_CACHE_MS = Number(process.env.CUSTOMERS_CACHE_MS) || 30 * 60 * 1000;
let customersCache = null; // { map, ts }

async function fetchCustomersMap() {
  if (customersCache && Date.now() - customersCache.ts < CUSTOMERS_CACHE_MS) {
    return customersCache.map;
  }
  const path = process.env.LEAP_CUSTOMERS_PATH || "/customers";
  const rows = await leapGetAll(path);
  const map = new Map();
  for (const c of rows) {
    map.set(String(c.id), { name: customerName(c), address: customerAddress(c) });
  }
  customersCache = { map, ts: Date.now() };
  return map;
}

function cityFromAddress(addr) {
  const parts = String(addr || "").split(",").map((s) => s.trim()).filter(Boolean);
  // Address is built as "street, city, state" — city is the second-to-last part.
  if (parts.length >= 2) return parts[parts.length - 2];
  return "";
}

function normalizeJob(j, customersById) {
  const cust = customersById.get(String(j.customer_id)) || {};
  const rawStage = pick(j, ["current_stage.name", "stage.name", "stage", "status.name", "status"]);
  const customerId = pick(j, ["customer_id"], "");
  const jobId = pick(j, ["id", "job_id"], "");
  const crmUrl =
    customerId && jobId
      ? `https://jobprogress.com/app/#/customer-jobs/${customerId}/job/${jobId}/proposals`
      : "";
  const address = cust.address || "";
  return {
    id: String(pick(j, ["id", "job_id", "uuid", "number"], "")),
    customerId: String(customerId || ""),
    number: pick(j, ["number"], ""),
    name: pick(j, ["name", "description", "title"], "Untitled job"),
    customer: cust.name || "—",
    address,
    city: cityFromAddress(address),
    stage: normalizeStage(rawStage),
    rawStage: String(rawStage || ""),
    // When the job last changed stage — used to sort each column (newest on top).
    stageChangedAt: pick(j, ["stage_last_modified", "updated_at", "awarded_date"], ""),
    // QuickBooks financials (synced into JobProgress from QB Desktop).
    financial: {
      total: Number(pick(j, ["financial_details.total_job_price", "financial_details.final_job_total"], 0)) || 0,
      paid: Number(pick(j, ["financial_details.total_payment_received"], 0)) || 0,
      owed: Number(pick(j, ["financial_details.total_amount_owed"], 0)) || 0,
    },
    crmUrl,
  };
}

// --- JobProgress appointments + schedules (v3, accessible with our token) ---
function leapDateOnly(s) {
  return String(s || "").slice(0, 10);
}
function leapISO(s) {
  const t = String(s || "").trim().replace(" ", "T");
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t) ? t : null;
}
function cleanTitle(s) {
  return String(s || "").split("\n")[0].replace(/\s*-{2,}\s*$/, "").trim() || "(no title)";
}

async function fetchAppointments() {
  const rows = await leapGetAll(process.env.LEAP_APPTS_PATH || "/appointments").catch(() => []);
  return rows.map((a) => ({
    source: "appointment",
    title: cleanTitle(a.title),
    customerId: String(a.customer_id || ""),
    jobId: "",
    date: leapDateOnly(a.start_date_time),
    startDateTime: a.full_day ? null : leapISO(a.start_date_time),
    completed: Boolean(a.is_completed),
  }));
}

async function fetchSchedules() {
  const rows = await leapGetAll(process.env.LEAP_SCHED_PATH || "/schedules").catch(() => []);
  return rows.map((s) => ({
    source: "schedule",
    title: cleanTitle(s.title),
    customerId: String(s.customer_id || ""),
    jobId: String(s.job_id || ""),
    date: leapDateOnly(s.start_date_time),
    startDateTime: s.full_day ? null : leapISO(s.start_date_time),
    completed: Boolean(s.is_completed),
  }));
}

async function fetchJobs() {
  const path = process.env.LEAP_JOBS_PATH || "/jobs";
  // Customers are needed for client name + address; tolerate failure gracefully.
  // includes financial_details so each job carries QB totals (price/paid/owed).
  const [rows, customers] = await Promise.all([
    leapGetAll(path, { "includes[]": "financial_details" }),
    fetchCustomersMap().catch(() => new Map()),
  ]);
  return rows
    // Drop jobs that are archived or deleted in the CRM (they shouldn't show on the board).
    .filter((j) => !j.archived && !j.deleted_at && !j.is_deleted)
    .map((j) => normalizeJob(j, customers))
    // Drop jobs in a finished/dead CRM stage (e.g. Completed) — moving a job to
    // Completed in the CRM should remove it from the board, not file it under Work.
    .filter((j) => !isTerminalStage(j.rawStage))
    // Drop jobs whose stage is intentionally hidden from the board (stage === null):
    // Paid, Showroom Appointment, Appointment Set, On-Site Consultation,
    // Contract Signed, Bad Lead. Keeps each column matched 1:1 to the CRM.
    .filter((j) => j.stage !== null);
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

// Generic raw GET for probing endpoints during setup.
async function rawGet(path) {
  return leapGet(path);
}

// --- JobProgress "v1 public" API (used for documents/proposals) ---
const V1_BASE = process.env.LEAP_V1_BASE || "https://jobprogress.com/api/public/api/v1";

async function v1Get(path, params = {}) {
  if (!TOKEN) throw new Error("LEAP_API_KEY is missing");
  const url = new URL(V1_BASE.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`Leap v1 ${res.status} for ${url.pathname} — ${b.slice(0, 300)}`);
  }
  return res.json();
}

// List a job's documents (proposals), each with its worksheet (the PDF).
async function fetchProposalsRaw(jobId) {
  return v1Get("/proposals", { job_id: jobId, "includes[]": "worksheet", limit: 0, multi_page: 1 });
}

module.exports = { fetchJobs, fetchJobsRaw, fetchCustomersRaw, rawGet, fetchProposalsRaw, fetchAppointments, fetchSchedules, STAGES };
