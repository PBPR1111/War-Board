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

const STOP = new Set(["the", "and", "rd", "st", "ave", "dr", "ln", "ct", "hwy", "fl", "job", "remodel", "install", "delivery"]);

// Distinctive tokens from a job we can look for in event/task text.
function jobKeywords(job) {
  const tokens = new Set();
  for (const field of [job.customer, job.name, job.address]) {
    for (const tok of norm(field).split(" ")) {
      if (tok.length >= 3 && !STOP.has(tok)) tokens.add(tok);
    }
  }
  // Last name of the customer is the strongest single signal.
  const lastName = norm(job.customer).split(" ").filter((t) => t.length >= 3 && !STOP.has(t)).pop();
  return { tokens, lastName };
}

function classifyEvent(title, description) {
  const t = norm(title + " " + description);
  if (/\b(deliver|delivery|drop\s?off|arriv)/.test(t)) return "delivery";
  if (/\b(install|installation|fit|set|mount)/.test(t)) return "install";
  return "install"; // default bucket for a dated job event
}

function textMatchesJob(text, kw) {
  const t = " " + norm(text) + " ";
  if (kw.lastName && t.includes(" " + kw.lastName + " ")) return true; // strong: client surname
  let hits = 0;
  for (const tok of kw.tokens) {
    if (t.includes(" " + tok + " ")) hits += 1;
    if (hits >= 2) return true; // two distinctive tokens = confident match
  }
  return false;
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
      .filter((t) => textMatchesJob(t.text + " " + t.notes, kw))
      .map((t) => ({
        text: t.text,
        done: t.done,
        subtasks: (childrenByParent[t.id] || []).map((s) => ({ text: s.text, done: s.done })),
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
