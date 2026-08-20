# Edmonton Transit Live

A live "Uber-style" map of Edmonton Transit (ETS) buses, plus installable
phone alerts that notify you before your bus arrives at a stop you choose —
so you don't have to stand outside in the cold waiting.

## How it works

- `server.js` polls Edmonton's public GTFS-realtime feeds:
  - **Vehicle positions** every 15s → `/api/vehicles` (live map)
  - **Trip updates** (predicted arrival times) every 20s → stop/route
    prediction endpoints and the alert engine
  - Route names/colors refresh daily from Edmonton's open data portal, and
    the static GTFS bundle (stop names/locations) refreshes daily too.
- `public/` is an installable PWA: a live Leaflet map (Map tab) and a
  stop/route search with push-notification alerts (Alerts tab).
- **Alert engine** (`watches.js`): when you set an alert, the server checks
  every trip-updates refresh for a match, and fires a push notification when
  *either* the predicted arrival time crosses your threshold *or* the bus's
  live GPS position comes within ~600m of your stop — whichever happens
  first. This dual-trigger design means one stale signal (predictions and
  raw GPS pings don't always update at the same rate) doesn't cost you the
  whole warning. Alerts have a 4-minute minimum lead time by design, to
  leave margin for feed latency plus your own walk to the stop.

A backend is required because the city's feeds are plain HTTP with no CORS
headers, so a browser can't fetch them directly.

## Run locally

```bash
npm install
node scripts/generate-vapid-keys.js   # first time only — prints keys to put in .env
npm start
```

Then open http://localhost:3000. A `.env` file with `VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` is required for push alerts to work
(the live map works without it).

## ⚠️ Important: free-tier hosting and background alerts

Render's **free web service tier spins the server down after ~15 minutes
with no incoming HTTP traffic**, and only wakes up again on the next
request. The alert engine only runs while the server is awake — so if the
app has been idle, a bus could arrive without you being notified.

Render's free tier grants **750 instance-hours/month** — just barely enough
to keep one service awake 24/7 (~720–744 hrs), but that's both wasteful and
cutting it close to the cap, and pointless given you only need this app
during actual commute windows, not around the clock.

**Recommended: a scheduled keep-alive ping, not a 24/7 one.** Use a free
cron pinger (e.g. [cron-job.org](https://cron-job.org)) to hit
`https://<your-app>.onrender.com/api/health` every ~10 minutes, but only
during the hours you'd realistically be checking on a bus — e.g. weekday
mornings and evenings. The incoming request resets Render's idle timer, so
the alert engine stays live through your actual commute windows, while
using a small fraction of the free-hours budget the rest of the time.

If you want it available at unpredictable times too, the alternative is
upgrading to a paid "Starter" instance (~$7/month) so it never sleeps —
but for a personal commute app, a scheduled pinger matching your actual
routine is the better fit.

Also note: the free tier's filesystem is ephemeral, so `data/store.json`
(saved alerts + push subscriptions) is wiped on every redeploy or restart.
That's fine for personal use but means you'll need to re-create alerts after
a redeploy.

## Deploying to Render

1. Push this project to a GitHub repo (Render deploys from a repo).
2. In Render, create a new Blueprint from the repo — it will pick up
   `render.yaml` automatically.
3. Render will prompt for `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (marked
   `sync: false` in the blueprint) — paste in the values from
   `scripts/generate-vapid-keys.js` (generate fresh ones for production
   rather than reusing your local dev keys).
4. Once deployed, open the Render URL on your phone and use
   "Add to Home Screen" (iOS Safari) or the install prompt (Android Chrome)
   to install it as an app.

### Environment variables

- `PORT` — port to listen on (default `3000`, Render sets this automatically)
- `VEHICLE_POLL_MS` — how often to poll live vehicle positions (default `15000`)
- `TRIP_UPDATES_POLL_MS` — how often to poll arrival predictions (default `20000`)
- `ROUTES_REFRESH_MS` — how often to refresh route names/colors (default 24h)
- `GTFS_STATIC_REFRESH_MS` — how often to re-download the static GTFS bundle (default 24h)
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — required for push alerts
