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
function jobKeywords(job) {
  const customerTokens = distinctTokens(job.customer);
  const nameTokens = distinctTokens(job.name);
  const lastName = customerTokens[customerTokens.length - 1] || ""; // surname / business word
  return { customerTokens: new Set(customerTokens), nameTokens: new Set(nameTokens), lastName };
}

function classifyEvent(title, description) {
  const t = norm(title + " " + description);
  if (/\b(deliver|delivery|drop\s?off|arriv)/.test(t)) return "delivery";
  if (/\b(install|installation|fit|set|mount)/.test(t)) return "install";
  return "install"; // default bucket for a dated job event
}

function textMatchesJob(text, kw) {
  const t = " " + norm(text) + " ";
  const has = (tok) => tok && t.includes(" " + tok + " ");
  const custPresent = [...kw.customerTokens].filter(has);
  if (custPresent.length === 0) return false;            // a match MUST mention the client
  if (kw.lastName && has(kw.lastName)) return true;       // surname / business word
  if (custPresent.length >= 2) return true;              // two distinct client words
  if (custPresent.some((tok) => tok.length >= 5)) return true; // one distinctive client word
  return [...kw.nameTokens].some(has);                   // one short client word + a project word
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
