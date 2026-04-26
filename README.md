# Gateway Monitor

Throwaway dashboard that shows online status for two TTN gateways
(`eloc-id-gateway-002`, `eloc-id-gateway-003`) on the `au1` cluster.

It polls TTN's Gateway Server `connection/stats` REST endpoint every 30 s
and pushes results to the browser via Server-Sent Events. No database,
no build step.

## 1. Get a TTN API key

1. Open https://au1.cloud.thethings.network/console/
2. Sign in with the account that owns (or is a collaborator on) the gateways.
3. Top-right user menu → **Personal API keys** → **+ Add API key**.
   - Name: `gateway-monitor`
   - Expires: pick something short (this is throwaway)
   - Rights — tick at minimum:
     - `View gateway information`
     - `View gateway status`
     - `View gateway location` *(optional)*
4. Click **Create API key**. Copy the `NNSXS....` value — it is only shown once.

> If the gateways belong to an **organization** rather than your user, create
> the key under **Organizations → {org} → API keys** instead, with the same
> rights. A user-level key only sees gateways the user has rights on.

## 2. Configure

```bash
cd gateway-monitor
cp .env.example .env
# edit .env and paste the NNSXS... key into TTN_API_KEY
```

Defaults already match your setup (`au1`, both gateway IDs, port 3030).

## 3. Run

```bash
npm install
npm start
```

Open http://localhost:3030

`npm run dev` restarts on file changes.

## What the states mean

| State    | Meaning                                                                  |
|----------|--------------------------------------------------------------------------|
| online   | TTN has an open connection record (no `disconnected_at`)                 |
| offline  | TTN returned 404 (no current connection) or `disconnected_at` is set     |
| error    | API call failed — message shown on the card (often bad/expired key)      |
| unknown  | First poll hasn't returned yet                                           |

This matches what the TTN console shows. Note that Basic Station gateways
(`SEMTECHWS/LBSLNS`) don't send periodic status messages — liveness comes
from the WebSocket itself — so the "Last status" timestamp can be hours
old even on a healthy gateway.

## Notes

- This folder is self-contained and has its own `.gitignore`. Delete the
  whole `gateway-monitor/` folder when you're done.
- The TTN region `au1` is hardcoded only in `.env`; change it there to test
  another cluster.
- For real push (no 30 s lag) the next step would be the TTN Events API
  (`/api/v3/events`, server-sent events) or the Gateway Server MQTT —
  both need the same API key.

## Deploy to Cloud Run

This is a Node service, not a static site, so Firebase Hosting can't run it.
Cloud Run is a good fit — same Google project as Firebase, scales to zero
when nobody has the dashboard open, free tier covers throwaway use.

### One-time setup

```bash
gcloud auth login
gcloud config set project eloc-b1e63
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

### First deploy (with env vars)

The first deploy needs to set the env vars. `GATEWAY_IDS` contains a comma,
so we use gcloud's `^|^` custom-delimiter syntax (treats `|` as the separator
instead of `,`).

Replace `YOUR_KEY` with the real `NNSXS.…` key from `.env`:

```bash
cd gateway-monitor
gcloud run deploy gateway-monitor --source . --region us-central1 --allow-unauthenticated --timeout 3600 --set-env-vars "^|^TTN_API_KEY=YOUR_KEY|TTN_REGION=au1|GATEWAY_IDS=eloc-id-gateway-002,eloc-id-gateway-003|POLL_INTERVAL_MS=30000"
```

When it finishes it prints a URL like
`https://gateway-monitor-xxxxxxxxxx-uc.a.run.app`. Open it.

### Re-deploy after code changes

Env vars are kept across deploys, so:

```bash
npm run deploy
```

is enough. (It runs `gcloud run deploy gateway-monitor --source . …` without
the env-var flag.)

### Notes

- `--allow-unauthenticated` makes the dashboard public. Drop the flag for
  IAM-protected access.
- `--timeout 3600` keeps each SSE connection alive for up to 1 hour. After
  that the browser reconnects automatically (a brief "Disconnected — retrying…"
  flicker in the top bar).
- Default `--min-instances=0` means polling pauses when nobody has the page
  open — fine for a status board. Add `--min-instances=1` if you need 24/7
  polling regardless of viewers (small ongoing cost).
- The API key sits in plaintext on the Cloud Run revision. For real
  production move it to Secret Manager and use
  `--set-secrets TTN_API_KEY=ttn-api-key:latest` instead.
