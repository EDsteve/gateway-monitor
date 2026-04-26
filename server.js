import express from 'express';
import 'dotenv/config';

const {
  TTN_API_KEY,
  TTN_REGION = 'au1',
  GATEWAY_IDS = '',
  PORT = 3030,
  POLL_INTERVAL_MS = 30000,
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

const baseUrl = `https://${TTN_REGION}.cloud.thethings.network/api/v3`;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

const status = new Map();
const history = new Map();
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
  pollAll();
  setInterval(pollAll, Number(POLL_INTERVAL_MS));
});
