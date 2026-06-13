# War Board

A read-only board that pulls your **Leap CRM (JobProgress)** jobs and enriches each one with matched **Google Calendar** dates (delivery/install) and **Google Tasks** to-dos. Jobs are grouped into the three columns from your CRM home page: **Lead, Estimate, Work**.

Nothing is written back to Leap or Google — this only *reads* and displays.

## Running it (on your Mac)

1. Open the **Terminal** app.
2. Go to this folder by pasting this and pressing Return:
   ```
   cd "/Users/sjr/Documents/Claude/Projects/War Board"
   ```
3. Make sure Node is installed (you need v18 or newer):
   ```
   node -v
   ```
   If that errors, install Node from https://nodejs.org (the "LTS" button), then try again.
4. Install dependencies (only needed the first time):
   ```
   npm install
   ```
5. Start it:
   ```
   npm start
   ```
6. Open **http://localhost:3000** in your browser. You'll see your jobs.
7. Click **"Connect Google →"** once. Sign in, click **Allow**. This grants read access to your Calendar and Tasks and saves a token so you never have to do it again.
8. The board now shows jobs + matched dates + to-dos, and auto-refreshes every 20 minutes.

To stop the server, click the Terminal window and press **Control + C**.

## If the jobs look wrong

The exact field names JobProgress returns can vary by account. To see the raw data:

- With the server running, open **http://localhost:3000/api/debug/leap** — that shows the unmodified Leap response.

Send me what you see there and I'll adjust the field mapping (job name, customer, address, stage) in `lib/leap.js`.

## Files

- `server.js` — the web server and API routes
- `lib/leap.js` — fetches jobs from Leap
- `lib/google.js` — Google OAuth + Calendar + Tasks
- `lib/match.js` — matches calendar events & tasks to jobs (by client name, address, job name)
- `public/index.html` — the board you see in the browser
- `.env` — your secret keys (never share this)
- `tokens.json` — created automatically after you connect Google (never share this)
