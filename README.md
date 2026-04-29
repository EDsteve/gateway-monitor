# Gateway Monitor

Polls TTN's Gateway Server `connection/stats` REST endpoint for the configured
gateways and publishes their state to Firestore (`gateway_status_cache/{gatewayId}`)
so the main ELOC web app can show them on the LoRa map and dashboard.

Also exposes a small local dashboard at `/` (Server-Sent Events) as a backup
view in case the main app or Firestore is unreachable.

Default polling interval is 15 s; Firestore writes happen on every state
change plus a heartbeat write every 10 minutes (so the UI's "last checked"
stays fresh without burning the daily write quota).

## 1. Get a TTN API key

1. Open https://au1.cloud.thethings.network/console/
2. Sign in with the account that owns (or is a collaborator on) the gateways.
3. Top-right user menu → **Personal API keys** → **+ Add API key**.
   - Name: `gateway-monitor`
   - Expires: pick something short (this is throwaway)
   - Rights — tick at minimum:
     - `View gateway information`
     - `View gateway status`
     - `View gateway location` *(required so markers can be placed on the map)*
4. Click **Create API key**. Copy the `NNSXS....` value — it is only shown once.

> If the gateways belong to an **organization** rather than your user, create
> the key under **Organizations → {org} → API keys** instead, with the same
> rights. A user-level key only sees gateways the user has rights on.

## 2. Get a Firebase service account

1. Open [Firebase Console](https://console.firebase.google.com/) → project `eloc-b1e63`
2. ⚙ → **Project settings** → **Service accounts** tab
3. Click **Generate new private key** → downloads a JSON file

How you give that JSON to the running service depends on how you deploy:

### Option A — Portainer / Docker with env vars (easiest)

1. Open the downloaded JSON file in any text editor and copy the **entire contents**.
2. In Portainer → **Stacks → gateway-monitor → Environment variables → + Add**:
   - **Name:** `FIREBASE_SERVICE_ACCOUNT_JSON`
   - **Value:** paste the JSON
3. **Save settings**, then **Pull and redeploy**.

No file lives on the host filesystem — Portainer stores the value and
injects it at container start. To rotate: generate a new key, replace
the env-var value, redeploy.

### Option B — Local development / bare metal

Save the file as `gateway-monitor/service-account.json` next to `server.js`
(already gitignored). The server reads it automatically. To rotate: replace
the file and restart.

### Option C — Bind-mount the JSON (Docker without Portainer env vars)

Place the file at any path on the host and bind-mount it into the
container. Example `docker-compose.yml`:
```yaml
volumes:
  - /opt/eloc-secrets/firebase-admin.json:/app/service-account.json:ro
```

### Revoking old keys

Old keys can be revoked anytime from Firebase Console → Project settings
→ Service accounts → Manage all service accounts.

## 3. Configure

```bash
cd gateway-monitor
cp .env.example .env
# edit .env and paste the NNSXS... key into TTN_API_KEY
```

Defaults already match your setup (`au1`, both gateway IDs, port 3030,
project `eloc-b1e63`).

## 4. Run

```bash
npm install
npm start
```

Open http://localhost:3030 for the local backup dashboard. Firestore writes
to `gateway_status_cache/{gatewayId}` start immediately — verify in the
Firebase Console.

`npm run dev` restarts on file changes.

## Firestore security rules (one-off)

Add this rule via Firebase Console → Firestore → Rules so authenticated web
users can read gateway state, but client SDKs can't write to it (the producer
uses an admin service account, which bypasses rules):

```
match /gateway_status_cache/{gatewayId} {
  allow read: if request.auth != null;
  allow write: if false;
}
```

## Adding a new gateway

1. Register the gateway in TTN Console. Confirm the existing API key has
   `View gateway information`, `View gateway status`, `View gateway location`
   rights for it (organisation-level keys cover all org gateways automatically;
   user-level keys need to be re-issued or have collaborator rights granted).
2. Append the new gateway ID to `GATEWAY_IDS` in `.env`.
3. Restart the service (`systemctl restart gateway-monitor` or just rerun
   `npm start`). Within ~15 s a `gateway_status_cache/{newId}` doc appears
   and the main app picks it up via its `onSnapshot` subscription.

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

- The TTN region `au1` is set only in `.env`; change it there to test
  another cluster.
- For real push (no poll lag) the next step would be the TTN Events API
  (`/api/v3/events`, server-sent events) or the Gateway Server MQTT —
  both need the same API key.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `TTN_API_KEY` | — (required) | TTN personal/org API key with gateway rights |
| `TTN_REGION` | `au1` | TTN cluster (`eu1`, `nam1`, `au1`, …) |
| `GATEWAY_IDS` | — (required) | Comma-separated TTN gateway IDs |
| `POLL_INTERVAL_MS` | `15000` | TTN poll cadence |
| `HEARTBEAT_WRITE_MS` | `600000` | Force a Firestore write at least every N ms |
| `METADATA_REFRESH_MS` | `600000` | Re-fetch gateway name + location every N ms |
| `FIREBASE_PROJECT_ID` | `eloc-b1e63` | Firestore project to write to |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | unset | Full service-account JSON pasted as one env var. Recommended for Portainer/Docker. |
| `GOOGLE_APPLICATION_CREDENTIALS` | unset | Path to service-account JSON file (Google convention). Used if `FIREBASE_SERVICE_ACCOUNT_JSON` is unset. |
| `PORT` | `3030` | Local backup-dashboard HTTP port |

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
