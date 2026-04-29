import express from 'express';
import 'dotenv/config';
import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';

const {
  TTN_API_KEY,
  TTN_REGION = 'au1',
  GATEWAY_IDS = '',
  PORT = 3030,
  POLL_INTERVAL_MS = 15000,
  // Re-fetch name + location every N polls. Default ~10 min at 15s polling.
  METADATA_REFRESH_MS = 10 * 60 * 1000,
  // Heartbeat write so the UI's "last checked" stays fresh even when nothing changed.
  HEARTBEAT_WRITE_MS = 10 * 60 * 1000,
  GOOGLE_APPLICATION_CREDENTIALS,
  FIREBASE_PROJECT_ID = 'eloc-b1e63',
} = process.env;

if (!TTN_API_KEY || TTN_API_KEY.includes('replace-me')) {
  console.error('Set TTN_API_KEY in .env first. See README.md for how to create one.');
  process.exit(1);
}

const gatewayIds = GATEWAY_IDS.split(',').map(s => s.trim()).filter(Boolean);
if (gatewayIds.length === 0) {
  console.error('No gateways listed in GATEWAY_IDS.');
  process.exit(1);
}

// Firebase Admin credentials — three sources, tried in this order:
//   1. FIREBASE_SERVICE_ACCOUNT_JSON  — full JSON pasted as an env var.
//      Easiest for Portainer / Cloud Run / any platform with a secrets UI.
//   2. GOOGLE_APPLICATION_CREDENTIALS — path to a JSON file (Google convention).
//   3. ./service-account.json         — file next to server.js (bind-mount).
//
// Returns null if no credentials are configured. We DO NOT exit on missing
// or malformed credentials — the local SSE dashboard at PORT must keep
// serving so its URL stays alive while the operator fixes the secret.
function loadCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
    } catch (err) {
      console.warn('Firebase: FIREBASE_SERVICE_ACCOUNT_JSON is set but does not parse as JSON:', err.message);
      return null;
    }
  }
  if (GOOGLE_APPLICATION_CREDENTIALS) {
    try { return admin.credential.applicationDefault(); }
    catch (err) { console.warn('Firebase: GOOGLE_APPLICATION_CREDENTIALS load failed:', err.message); return null; }
  }
  try {
    const json = JSON.parse(readFileSync('./service-account.json', 'utf8'));
    return admin.credential.cert(json);
  } catch {
    console.warn('Firebase: no credentials configured (FIREBASE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS / ./service-account.json). Local dashboard will work; Firestore publishing disabled.');
    return null;
  }
}

let db = null;
try {
  const credential = loadCredential();
  if (credential) {
    admin.initializeApp({ credential, projectId: FIREBASE_PROJECT_ID });
    db = admin.firestore();
    console.log(`Firebase: publishing to project ${FIREBASE_PROJECT_ID}, collection gateway_status_cache`);
  } else {
    console.warn('Firebase: disabled — running in local-dashboard-only mode');
  }
} catch (err) {
  console.warn('Firebase: initializeApp failed, continuing without Firestore:', err.message);
  db = null;
}

const baseUrl = `https://${TTN_REGION}.cloud.thethings.network/api/v3`;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

const status = new Map();
const history = new Map();
const meta = new Map();           // gatewayId -> { name, location, fetchedAt }
const lastWrittenAt = new Map();  // gatewayId -> ms timestamp of last Firestore write

for (const id of gatewayIds) {
  status.set(id, {
    id,
    state: 'unknown',
    lastChecked: null,
    connectedAt: null,
    disconnectedAt: null,
    lastStatusAt: null,
    lastUplinkAt: null,
    lastDownlinkAt: null,
    uplinkCount: 0,
    downlinkCount: 0,
    error: null,
  });
  history.set(id, []);
}

function recordTransition(id, newState, atIso) {
  const arr = history.get(id);
  const last = arr[arr.length - 1];
  if (!last || last.state !== newState) arr.push({ state: newState, since: atIso });
  // Keep the most recent transition whose `since` is before the 24h cutoff
  // so we still know the state at the window start; drop everything older.
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  let firstKeep = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (new Date(arr[i].since).getTime() <= cutoff) { firstKeep = i; break; }
  }
  if (firstKeep > 0) arr.splice(0, firstKeep);
}

const sseClients = new Set();

function snapshot() {
  return {
    gateways: Array.from(status.values()),
    history: Object.fromEntries(history),
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

async function fetchGatewayMetadata(id) {
  const cached = meta.get(id);
  if (cached && Date.now() - cached.fetchedAt < Number(METADATA_REFRESH_MS)) return cached;
  const url = `${baseUrl}/gateways/${encodeURIComponent(id)}?field_mask=name,antennas`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${TTN_API_KEY}` } });
    if (!resp.ok) {
      // Keep the previous metadata (if any) on transient failure.
      console.warn(`metadata fetch ${id}: HTTP ${resp.status}`);
      return cached ?? { name: id, location: null, fetchedAt: 0 };
    }
    const data = await resp.json();
    const antennaLoc = data?.antennas?.[0]?.location;
    const location = antennaLoc && typeof antennaLoc.latitude === 'number' && typeof antennaLoc.longitude === 'number'
      ? { lat: antennaLoc.latitude, lng: antennaLoc.longitude, ...(typeof antennaLoc.altitude === 'number' ? { altitude: antennaLoc.altitude } : {}) }
      : null;
    const next = { name: data?.name || id, location, fetchedAt: Date.now() };
    meta.set(id, next);
    return next;
  } catch (err) {
    console.warn(`metadata fetch ${id} failed:`, err.message);
    return cached ?? { name: id, location: null, fetchedAt: 0 };
  }
}

function toFirestoreTimestamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(d);
}

async function writeGatewayStatus(gateway, gatewayMeta) {
  if (!db) return; // Firestore disabled — local dashboard still serves.
  const doc = {
    gatewayId: gateway.id,
    name: gatewayMeta.name,
    state: gateway.state,
    location: gatewayMeta.location,
    lastChecked: admin.firestore.FieldValue.serverTimestamp(),
    connectedAt: toFirestoreTimestamp(gateway.connectedAt),
    disconnectedAt: toFirestoreTimestamp(gateway.disconnectedAt),
    lastStatusAt: toFirestoreTimestamp(gateway.lastStatusAt),
    lastUplinkAt: toFirestoreTimestamp(gateway.lastUplinkAt),
    lastDownlinkAt: toFirestoreTimestamp(gateway.lastDownlinkAt),
    uplinkCount: gateway.uplinkCount,
    downlinkCount: gateway.downlinkCount,
    error: gateway.error,
  };
  await db.collection('gateway_status_cache').doc(gateway.id).set(doc, { merge: true });
  lastWrittenAt.set(gateway.id, Date.now());
}

async function pollGateway(id) {
  const url = `${baseUrl}/gs/gateways/${encodeURIComponent(id)}/connection/stats`;
  const prev = status.get(id);
  const now = new Date().toISOString();
  let next;

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${TTN_API_KEY}` },
    });

    if (resp.status === 404) {
      next = { ...prev, state: 'offline', lastChecked: now, error: null };
    } else if (resp.status === 401 || resp.status === 403) {
      next = {
        ...prev,
        state: 'error',
        lastChecked: now,
        error: `Auth failed (${resp.status}) — check API key rights`,
      };
    } else if (!resp.ok) {
      next = { ...prev, state: 'error', lastChecked: now, error: `HTTP ${resp.status}` };
    } else {
      const data = await resp.json();
      // Match TTN console: connection record present and not closed = online.
      // Basic Station (SEMTECHWS) gateways don't send periodic status messages,
      // so we can't rely on last_status_received_at for liveness.
      const state = data.disconnected_at ? 'offline' : 'online';
      next = {
        id,
        state,
        lastChecked: now,
        connectedAt: data.connected_at || null,
        disconnectedAt: data.disconnected_at || null,
        lastStatusAt: data.last_status_received_at || null,
        lastUplinkAt: data.last_uplink_received_at || null,
        lastDownlinkAt: data.last_downlink_received_at || null,
        uplinkCount: Number(data.uplink_count || 0),
        downlinkCount: Number(data.downlink_count || 0),
        error: null,
      };
    }
  } catch (err) {
    next = { ...prev, state: 'error', lastChecked: now, error: err.message };
  }

  status.set(id, next);
  recordTransition(id, next.state, now);

  // Decide whether to write to Firestore. Always on state change; otherwise
  // only on the heartbeat interval to keep write volume low.
  const stateChanged = prev.state !== next.state;
  const lastWrite = lastWrittenAt.get(id) ?? 0;
  const heartbeatDue = Date.now() - lastWrite >= Number(HEARTBEAT_WRITE_MS);

  if (stateChanged || heartbeatDue) {
    try {
      const gatewayMeta = await fetchGatewayMetadata(id);
      await writeGatewayStatus(next, gatewayMeta);
    } catch (err) {
      console.error(`Firestore write ${id} failed:`, err.message);
    }
  }
}

async function pollAll() {
  await Promise.all(gatewayIds.map(pollGateway));
  broadcast();
}

const app = express();
app.use(express.static('public'));

app.get('/api/status', (_req, res) => {
  res.json(snapshot());
});

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.listen(PORT, () => {
  console.log(`Gateway monitor: http://localhost:${PORT}`);
  console.log(`Region: ${TTN_REGION}`);
  console.log(`Tracking: ${gatewayIds.join(', ')}`);
  console.log(`Firestore project: ${FIREBASE_PROJECT_ID} (collection: gateway_status_cache)`);
  console.log(`Polling: ${POLL_INTERVAL_MS}ms · heartbeat write: ${HEARTBEAT_WRITE_MS}ms`);
  pollAll();
  setInterval(pollAll, Number(POLL_INTERVAL_MS));
});
