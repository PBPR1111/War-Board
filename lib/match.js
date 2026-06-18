// Matching logic: attach Google Calendar events + Tasks to Leap jobs.
//
// Rule (per project spec): a calendar event / task belongs to a job if its
// text mentions the job's CLIENT NAME, ADDRESS, or JOB NAME. We match on
// normalized tokens and require a meaningful overlap to avoid false hits.

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set([
  // generic
  "the", "and", "job", "remodel", "remodeling", "install", "installation", "delivery",
  "kitchen", "bath", "bathroom", "cabinet", "cabinets", "design", "project", "showroom",
  "consultation", "renovation", "refresh", "premier", "llc", "inc",
  // street types
  "rd", "st", "ave", "dr", "ln", "ct", "hwy", "blvd", "road", "street", "drive", "lane",
  "court", "way", "terrace", "place", "circle", "trail",
  // Palm Beach County locations (too common to be distinctive)
  "fl", "florida", "palm", "beach", "gardens", "island", "west", "north", "south", "east",
  "jupiter", "boca", "raton", "stuart", "lake", "worth", "wellington", "jensen", "hobe",
  "sound", "port", "lucie", "royal", "delray", "boynton", "tequesta", "lighthouse", "point",
]);

// Distinctive tokens, kept separate by source. We do NOT use the job's street
// address (city/street words repeat and cause false matches).
function distinctTokens(s) {
  const out = [];
  for (const tok of norm(s).split(" ")) {
    if (tok.length >= 3 && !STOP.has(tok)) out.push(tok);
  }
  return out;
}
// Generic company suffixes — never the distinctive part of a name.
const GENERIC = new Set([
  "enterprises", "enterprise", "company", "group", "holdings", "partners",
  "services", "service", "corp", "corporation", "construction", "contracting",
  "builders", "homes", "properties", "realty", "co",
]);

function jobKeywords(job) {
  const customerTokens = distinctTokens(job.customer);
  // The "key" is the strongest single signal: the last NON-generic word
  // (a person's surname, or a business's distinctive word like "Kahel").
  // First names alone are too common to match on (two different Christinas).
  let key = "";
  for (let i = customerTokens.length - 1; i >= 0; i--) {
    if (!GENERIC.has(customerTokens[i])) { key = customerTokens[i]; break; }
  }
  if (!key) key = customerTokens[customerTokens.length - 1] || "";
  return { customerTokens: new Set(customerTokens), key };
}

function classifyEvent(title, description) {
  const t = norm(title + " " + description);
  if (/\b(deliver|delivery|drop\s?off|arriv)/.test(t)) return "delivery";
  if (/\b(install|installation|fit|set|mount)/.test(t)) return "install";
  return "install"; // default bucket for a dated job event
}

// Levenshtein edit distance (small strings only).
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// How many typos we tolerate, scaled by token length. Short tokens (common
// first names like "ken") must match exactly to avoid false hits; longer,
// distinctive words (surnames, business names) allow a 1-letter variation,
// so "Kassal" matches "Kassel".
function fuzzyTolerance(len) {
  return len >= 5 ? 1 : 0;
}

// True if `tok` appears among `words`, allowing a small spelling variation.
function tokenInWords(tok, words) {
  if (!tok) return false;
  const tol = fuzzyTolerance(tok.length);
  for (const w of words) {
    if (w === tok) return true;
    if (tol > 0 && Math.abs(w.length - tok.length) <= tol && editDistance(w, tok) <= tol) return true;
  }
  return false;
}

function textMatchesJob(text, kw) {
  const words = norm(text).split(" ").filter(Boolean);
  if (tokenInWords(kw.key, words)) return true;          // distinctive surname / business word (fuzzy)
  // Otherwise require the FULL client name (e.g. both "Christina" AND "Canavan").
  let hits = 0;
  for (const tok of kw.customerTokens) if (tokenInWords(tok, words)) hits++;
  return hits >= 2;
}

function buildBoard(jobs, events, tasks) {
  // Group subtasks under their parent task id.
  const childrenByParent = {};
  for (const t of tasks) {
    if (t.parent) (childrenByParent[t.parent] = childrenByParent[t.parent] || []).push(t);
  }
  const topTasks = tasks.filter((t) => !t.parent);

  const enriched = jobs.map((job) => {
    const kw = jobKeywords(job);
    const calendarEvents = events
      // Scan the event's title, location (address) AND description for a job match.
      .filter((ev) => textMatchesJob(ev.title + " " + ev.location + " " + ev.description, kw))
      .map((ev) => ({
        type: classifyEvent(ev.title, ev.description),
        title: ev.title,
        date: ev.date,
        startDateTime: ev.startDateTime || null,
        htmlLink: ev.htmlLink || "",
      }))
      .filter((ev) => ev.date);
    const jobTasks = topTasks
      .filter((t) => !t.done) // only live (incomplete) tasks
      .filter((t) => textMatchesJob(t.text + " " + t.notes, kw))
      .map((t) => ({
        text: t.text,
        done: t.done,
        subtasks: (childrenByParent[t.id] || []).filter((s) => !s.done).map((s) => ({ text: s.text, done: s.done })),
      }));
    return { ...job, calendarEvents, tasks: jobTasks };
  });

  // Events/tasks that didn't match any job — surfaced so nothing is silently dropped.
  const matchedEventIds = new Set();
  const matchedTaskIds = new Set();
  enriched.forEach((j) => {
    j.calendarEvents.forEach((e) => matchedEventIds.add(e.title + e.date));
    j.tasks.forEach((t) => matchedTaskIds.add(t.text));
  });
  const unmatched = {
    events: events.filter((e) => !matchedEventIds.has(e.title + e.date)).length,
    tasks: tasks.filter((t) => !matchedTaskIds.has(t.text)).length,
  };

  return { jobs: enriched, unmatched };
}

module.exports = { buildBoard };
