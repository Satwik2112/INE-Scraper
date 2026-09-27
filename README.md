# INE Price Tracker

## Stack
- Frontend: React + Vite (deploy: Vercel)
- Backend: Node/Express (deploy: Render)
- DB: Supabase Postgres
- Scraper: Playwright (playwright-extra + stealth plugin)
- Scheduling: external cron (cron-job.org) hitting `POST /api/scrape/run`

## Setup

### Supabase
1. Create project, open SQL editor, run `supabase/schema.sql`.
2. Copy project URL + service role key.

### Backend
```
cd backend
cp .env.example .env   # fill in Supabase + cron secret
npm install             # also runs `playwright install --with-deps chromium`
npm start
```
Local headed run (for the required demo recording):
```
npm run scrape:headed
```

## Diagnosing scraper failures
Logs every /api/* request/status and every offer-panel state across many
attempts, headed, so failure patterns are visible instead of guessed:
```
cd backend
npm run diagnose -- https://demo.inelabteamdev.com/item/2713 "Standard" 30
```
(url, optionName, attempt-count — all optional). Writes full detail to
`backend/diagnostics/run-<timestamp>.json` and prints a per-endpoint status
summary. Send me that JSON if failures are still unexplained.

### Frontend
```
cd frontend
echo "VITE_API_BASE_URL=http://localhost:4000" > .env
npm install
npm run dev
```

## Scraping schedule
Every 2 hours via cron-job.org, POST to:
```
https://<your-render-app>.onrender.com/api/scrape/run
Header: x-cron-secret: <CRON_SECRET>
```
Render free tier sleeps — the external cron's request itself wakes it; no
always-on process is used.

## Environment variables
| Var | Where | Purpose |
|---|---|---|
| SUPABASE_URL | backend | Supabase project URL |
| SUPABASE_SERVICE_ROLE_KEY | backend | server-side DB access |
| STORE_BASE_URL | backend | mock store base URL |
| CRON_SECRET | backend | auth for the cron trigger endpoint |
| HEADLESS | backend | `false` for the demo recording |
| SCRAPE_MAX_RETRIES | backend | retry attempts per scrape (default 3) |
| SCRAPE_NAV_TIMEOUT_MS | backend | per-navigation timeout |
| VITE_API_BASE_URL | frontend | backend API origin |

## Known gap to close before submission
`SELECTORS` in `backend/src/scraper/scraper.js` and the `/search` page path
in `searchStore()` are placeholders — set them from the real mock-store DOM
(devtools inspect) before relying on this against `demo.inelabteamdev.com`.
