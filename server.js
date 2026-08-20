import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { toNumber, haversineMeters } from './utils.js';
import { loadGtfsStatic } from './gtfsStatic.js';
import { fetchTripUpdates } from './tripUpdates.js';
import {
  vapidEnabled,
  getVapidPublicKey,
  addSubscription,
  addWatch,
  removeWatch,
  listWatchesByEndpoint,
  checkWatches,
} from './watches.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const VEHICLE_POSITIONS_URL = 'http://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb';
const ROUTES_URL = 'https://data.edmonton.ca/resource/d577-xky7.json?$limit=5000';
const VEHICLE_POLL_MS = Number(process.env.VEHICLE_POLL_MS) || 15_000;
const TRIP_UPDATES_POLL_MS = Number(process.env.TRIP_UPDATES_POLL_MS) || 20_000;
const ROUTES_REFRESH_MS = Number(process.env.ROUTES_REFRESH_MS) || 24 * 60 * 60 * 1000;
const GTFS_STATIC_REFRESH_MS = Number(process.env.GTFS_STATIC_REFRESH_MS) || 24 * 60 * 60 * 1000;

const state = {
  vehicles: [],
  vehiclesByTrip: new Map(),
  vehiclesUpdatedAt: null,
  routes: {},
  routesUpdatedAt: null,
  stops: new Map(),
  trips: new Map(),
  staticUpdatedAt: null,
  tripUpdatesByStop: new Map(),
  tripUpdatesByTrip: new Map(),
  tripUpdatesUpdatedAt: null,
  lastError: null,
};

function colorForRouteId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

async function refreshRoutes() {
  try {
    const res = await fetch(ROUTES_URL);
    if (!res.ok) throw new Error(`routes fetch failed: HTTP ${res.status}`);
    const rows = await res.json();
    const routes = {};
    for (const row of rows) {
      const id = row.route_id;
      if (!id) continue;
      routes[id] = {
        shortName: row.route_short_name || row.route_long_name || id,
        longName: row.route_long_name || '',
        color: row.route_color ? `#${row.route_color}` : colorForRouteId(id),
        textColor: row.route_text_color ? `#${row.route_text_color}` : '#ffffff',
      };
    }
    state.routes = routes;
    state.routesUpdatedAt = new Date().toISOString();
    console.log(`[routes] loaded ${Object.keys(routes).length} routes`);
  } catch (err) {
    console.error('[routes] refresh failed:', err.message);
  }
}

async function refreshGtfsStatic() {
  try {
    const { stops, trips } = await loadGtfsStatic();
    state.stops = stops;
    state.trips = trips;
    state.staticUpdatedAt = new Date().toISOString();
    console.log(`[static] loaded ${stops.size} stops, ${trips.size} trips`);
  } catch (err) {
    console.error('[static] refresh failed:', err.message);
  }
}

async function refreshVehicles() {
  try {
    const res = await fetch(VEHICLE_POSITIONS_URL);
    if (!res.ok) throw new Error(`vehicle feed fetch failed: HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const vehicles = [];
    const vehiclesByTrip = new Map();
    for (const entity of feed.entity) {
      const v = entity.vehicle;
      if (!v || !v.position) continue;
      const routeId = v.trip?.routeId || null;
      const route = routeId ? state.routes[routeId] : null;

      const record = {
        id: entity.id,
        vehicleId: v.vehicle?.id || null,
        label: v.vehicle?.label || route?.shortName || entity.id,
        routeId,
        routeShortName: route?.shortName || routeId || '?',
        routeColor: route?.color || '#0066cc',
        tripId: v.trip?.tripId || null,
        directionId: v.trip?.directionId ?? null,
        lat: v.position.latitude,
        lon: v.position.longitude,
        bearing: v.position.bearing ?? null,
        speedMps: v.position.speed ?? null,
        status: v.currentStatus ?? null,
        timestamp: toNumber(v.timestamp),
      };
      vehicles.push(record);
      if (record.tripId) vehiclesByTrip.set(record.tripId, record);
    }

    state.vehicles = vehicles;
    state.vehiclesByTrip = vehiclesByTrip;
    state.vehiclesUpdatedAt = new Date().toISOString();
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message;
    console.error('[vehicles] refresh failed:', err.message);
  }
}

async function refreshTripUpdates() {
  try {
    const { byStop, byTrip, updatedAt } = await fetchTripUpdates(state.trips);
    state.tripUpdatesByStop = byStop;
    state.tripUpdatesByTrip = byTrip;
    state.tripUpdatesUpdatedAt = updatedAt;

    await checkWatches({
      tripUpdatesByStop: byStop,
      vehiclesByTrip: state.vehiclesByTrip,
      stops: state.stops,
      routes: state.routes,
    });
  } catch (err) {
    console.error('[trip-updates] refresh failed:', err.message);
  }
}

function stopSummary(stop) {
  return { stopId: stop.stopId, code: stop.code, name: stop.name, lat: stop.lat, lon: stop.lon };
}

function predictionsForStop(stopId, limit = 8) {
  const records = state.tripUpdatesByStop.get(stopId) || [];
  const nowSec = Date.now() / 1000;
  return records.slice(0, limit).map((r) => {
    const route = r.routeId ? state.routes[r.routeId] : null;
    return {
      tripId: r.tripId,
      routeId: r.routeId,
      routeShortName: route?.shortName || r.routeId || '?',
      routeColor: route?.color || '#0066cc',
      headsign: r.headsign,
      arrivalTime: r.arrivalTime,
      etaMinutes: Math.round((r.arrivalTime - nowSec) / 60),
    };
  });
}

function nearestStops(lat, lon, limit = 6, maxDistanceM = 900) {
  const results = [];
  for (const stop of state.stops.values()) {
    const distanceM = haversineMeters(lat, lon, stop.lat, stop.lon);
    if (distanceM <= maxDistanceM) results.push({ stop, distanceM });
  }
  results.sort((a, b) => a.distanceM - b.distanceM);
  return results.slice(0, limit);
}

// routeId -> soonest upcoming trip-update record at this stop
function routesServingStop(stopId) {
  const records = state.tripUpdatesByStop.get(stopId) || [];
  const byRoute = new Map();
  for (const r of records) {
    if (!r.routeId) continue;
    const existing = byRoute.get(r.routeId);
    if (!existing || r.arrivalTime < existing.arrivalTime) byRoute.set(r.routeId, r);
  }
  return byRoute;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/vehicles', (req, res) => {
  res.json({ updatedAt: state.vehiclesUpdatedAt, error: state.lastError, vehicles: state.vehicles });
});

app.get('/api/routes', (req, res) => {
  res.json({ updatedAt: state.routesUpdatedAt, routes: state.routes });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    vehiclesUpdatedAt: state.vehiclesUpdatedAt,
    vehicleCount: state.vehicles.length,
    tripUpdatesUpdatedAt: state.tripUpdatesUpdatedAt,
    stopCount: state.stops.size,
    pushEnabled: vapidEnabled,
  });
});

app.get('/api/stops/nearby', (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const limit = Math.min(50, Number(req.query.limit) || 10);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ error: 'lat and lon query params are required' });
  }
  const results = [];
  for (const stop of state.stops.values()) {
    const distanceM = haversineMeters(lat, lon, stop.lat, stop.lon);
    results.push({ ...stopSummary(stop), distanceM: Math.round(distanceM) });
  }
  results.sort((a, b) => a.distanceM - b.distanceM);
  res.json({ stops: results.slice(0, limit) });
});

app.get('/api/stops/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ stops: [] });
  const results = [];
  for (const stop of state.stops.values()) {
    if (stop.name.toLowerCase().includes(q) || stop.code.toLowerCase().includes(q)) {
      results.push(stopSummary(stop));
      if (results.length >= 25) break;
    }
  }
  res.json({ stops: results });
});

const EDMONTON_VIEWBOX = '-113.80,53.70,-113.20,53.30'; // left,top,right,bottom

app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'json');
    url.searchParams.set('q', q);
    url.searchParams.set('viewbox', EDMONTON_VIEWBOX);
    url.searchParams.set('bounded', '1');
    url.searchParams.set('limit', '5');
    const geoRes = await fetch(url, {
      headers: { 'User-Agent': `edmonton-bus-tracker/1.0 (${process.env.VAPID_SUBJECT || 'contact via github'})` },
    });
    if (!geoRes.ok) throw new Error(`geocode HTTP ${geoRes.status}`);
    const rows = await geoRes.json();
    res.json({ results: rows.map((row) => ({ label: row.display_name, lat: Number(row.lat), lon: Number(row.lon) })) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/trip-suggestions', (req, res) => {
  const fromLat = Number(req.query.fromLat);
  const fromLon = Number(req.query.fromLon);
  const toLat = Number(req.query.toLat);
  const toLon = Number(req.query.toLon);
  if ([fromLat, fromLon, toLat, toLon].some(Number.isNaN)) {
    return res.status(400).json({ error: 'fromLat, fromLon, toLat, toLon are required' });
  }

  const originStops = nearestStops(fromLat, fromLon);
  const destStops = nearestStops(toLat, toLon);
  const nowSec = Date.now() / 1000;
  const bestByKey = new Map(); // `${routeId}|${headsign}` -> suggestion

  for (const { stop: originStop, distanceM: originDistanceM } of originStops) {
    const originRoutes = routesServingStop(originStop.stopId);
    for (const { stop: destStop, distanceM: destDistanceM } of destStops) {
      if (originStop.stopId === destStop.stopId) continue;
      const destRoutes = routesServingStop(destStop.stopId);
      for (const [routeId, originRecord] of originRoutes) {
        if (!destRoutes.has(routeId)) continue;
        const route = state.routes[routeId];
        const etaMinutes = Math.round((originRecord.arrivalTime - nowSec) / 60);
        const key = `${routeId}|${originRecord.headsign}`;
        const existing = bestByKey.get(key);
        if (existing && existing.etaMinutes <= etaMinutes) continue;
        bestByKey.set(key, {
          routeId,
          routeShortName: route?.shortName || routeId,
          routeColor: route?.color || '#0066cc',
          headsign: originRecord.headsign,
          boardStop: { stopId: originStop.stopId, name: originStop.name, distanceM: Math.round(originDistanceM) },
          alightStop: { stopId: destStop.stopId, name: destStop.name, distanceM: Math.round(destDistanceM) },
          etaMinutes,
        });
      }
    }
  }

  const suggestions = Array.from(bestByKey.values()).sort((a, b) => a.etaMinutes - b.etaMinutes).slice(0, 8);
  res.json({ suggestions });
});

app.get('/api/stops/:stopId/predictions', (req, res) => {
  const stop = state.stops.get(req.params.stopId);
  if (!stop) return res.status(404).json({ error: 'unknown stop' });
  res.json({ stop: stopSummary(stop), predictions: predictionsForStop(req.params.stopId) });
});

app.get('/api/routes/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ routes: [] });
  const results = [];
  for (const [routeId, route] of Object.entries(state.routes)) {
    if (
      route.shortName.toLowerCase().startsWith(q) ||
      routeId.toLowerCase().startsWith(q) ||
      route.longName.toLowerCase().includes(q)
    ) {
      results.push({ routeId, shortName: route.shortName, longName: route.longName, color: route.color });
      if (results.length >= 15) break;
    }
  }
  res.json({ routes: results });
});

app.get('/api/routes/:routeId/stops', (req, res) => {
  const routeId = req.params.routeId;
  const seen = new Map();
  for (const [stopId, records] of state.tripUpdatesByStop) {
    const match = records.find((r) => r.routeId === routeId);
    if (!match) continue;
    const stop = state.stops.get(stopId);
    if (!stop) continue;
    const nowSec = Date.now() / 1000;
    seen.set(stopId, {
      ...stopSummary(stop),
      headsign: match.headsign,
      nextEtaMinutes: Math.round((match.arrivalTime - nowSec) / 60),
    });
  }
  res.json({ routeId, stops: Array.from(seen.values()).sort((a, b) => a.nextEtaMinutes - b.nextEtaMinutes) });
});

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: getVapidPublicKey(), enabled: vapidEnabled });
});

app.post('/api/push/subscribe', (req, res) => {
  if (!vapidEnabled) return res.status(503).json({ error: 'push not configured on server' });
  const subscription = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  addSubscription(subscription);
  res.json({ ok: true });
});

app.get('/api/watches', (req, res) => {
  const endpoint = String(req.query.endpoint || '');
  if (!endpoint) return res.status(400).json({ error: 'endpoint query param required' });
  const list = listWatchesByEndpoint(endpoint).map((w) => {
    const stop = state.stops.get(w.stopId);
    const route = w.routeId ? state.routes[w.routeId] : null;
    return {
      id: w.id,
      stopId: w.stopId,
      stopName: stop?.name || w.stopId,
      routeId: w.routeId,
      routeShortName: route?.shortName || w.routeId || 'Any route',
      thresholdMinutes: w.thresholdMinutes,
      createdAt: w.createdAt,
    };
  });
  res.json({ watches: list });
});

app.post('/api/watches', (req, res) => {
  if (!vapidEnabled) return res.status(503).json({ error: 'push not configured on server' });
  try {
    const watch = addWatch(req.body || {});
    res.json({ ok: true, id: watch.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/watches/:id', (req, res) => {
  const removed = removeWatch(req.params.id);
  res.json({ ok: removed });
});

async function withStartupRetry(fn, label, retries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    await fn();
    if (attempt < retries && Object.keys(state.routes).length === 0 && label === 'routes') {
      console.warn(`[${label}] attempt ${attempt} left state empty, retrying in ${delayMs}ms…`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    return;
  }
}

async function start() {
  await withStartupRetry(refreshRoutes, 'routes');
  await refreshGtfsStatic();
  await refreshVehicles();
  await refreshTripUpdates();

  setInterval(refreshVehicles, VEHICLE_POLL_MS);
  setInterval(refreshTripUpdates, TRIP_UPDATES_POLL_MS);
  setInterval(refreshRoutes, ROUTES_REFRESH_MS);
  setInterval(refreshGtfsStatic, GTFS_STATIC_REFRESH_MS);

  app.listen(PORT, () => {
    console.log(`Edmonton bus tracker running at http://localhost:${PORT}`);
  });
}

start();
