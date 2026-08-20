import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { haversineMeters } from './utils.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

const MIN_THRESHOLD_MINUTES = 4;
const MAX_THRESHOLD_MINUTES = 30;
const GPS_BACKUP_METERS = 600; // fire regardless of predicted ETA once the bus is this close
const FIRED_TTL_MS = 2 * 60 * 60 * 1000; // stop remembering a fired trip after 2h

let subscriptions = new Map(); // endpoint -> PushSubscription
let watches = new Map(); // id -> watch

export const vapidEnabled = Boolean(
  process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
);

if (vapidEnabled) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('[push] VAPID keys not set — push notifications are disabled. Run scripts/generate-vapid-keys.js');
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    subscriptions = new Map(parsed.subscriptions || []);
    watches = new Map(
      (parsed.watches || []).map(([id, w]) => [id, { ...w, firedTrips: new Map(w.firedTrips || []) }])
    );
    console.log(`[watches] loaded ${watches.size} watch(es), ${subscriptions.size} subscription(s)`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[watches] failed to load store:', err.message);
  }
}

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const serializable = {
    subscriptions: Array.from(subscriptions.entries()),
    watches: Array.from(watches.entries()).map(([id, w]) => [
      id,
      { ...w, firedTrips: Array.from(w.firedTrips.entries()) },
    ]),
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(serializable, null, 2));
}

export function addSubscription(subscription) {
  subscriptions.set(subscription.endpoint, subscription);
  saveStore();
}

export function addWatch({ endpoint, stopId, routeId, thresholdMinutes }) {
  if (!subscriptions.has(endpoint)) throw new Error('Unknown push subscription — subscribe first');
  if (!stopId) throw new Error('stopId is required');
  const clampedThreshold = Math.min(
    MAX_THRESHOLD_MINUTES,
    Math.max(MIN_THRESHOLD_MINUTES, Number(thresholdMinutes) || MIN_THRESHOLD_MINUTES)
  );
  const watch = {
    id: crypto.randomUUID(),
    endpoint,
    stopId,
    routeId: routeId || null,
    thresholdMinutes: clampedThreshold,
    createdAt: new Date().toISOString(),
    firedTrips: new Map(), // tripId -> firedAtMs
  };
  watches.set(watch.id, watch);
  saveStore();
  return watch;
}

export function removeWatch(id) {
  const existed = watches.delete(id);
  if (existed) saveStore();
  return existed;
}

export function listWatchesByEndpoint(endpoint) {
  return Array.from(watches.values()).filter((w) => w.endpoint === endpoint);
}

async function sendPush(endpoint, payload) {
  const subscription = subscriptions.get(endpoint);
  if (!subscription) return;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      subscriptions.delete(endpoint);
      for (const [id, w] of watches) if (w.endpoint === endpoint) watches.delete(id);
      saveStore();
      console.log('[push] subscription expired, removed:', endpoint.slice(-20));
    } else {
      console.error('[push] send failed:', err.message);
    }
  }
}

// Called after every trip-updates refresh. Checks each watch against the
// latest predictions (primary trigger) and live vehicle positions (backup
// trigger for when a specific trip's prediction is stale), and fires a push
// notification the first time either condition is met for a given trip.
export async function checkWatches({ tripUpdatesByStop, vehiclesByTrip, stops, routes }) {
  if (!vapidEnabled || watches.size === 0) return;
  const nowMs = Date.now();
  const nowSec = nowMs / 1000;

  for (const watch of watches.values()) {
    // prune old fired-trip entries so the set doesn't grow forever
    for (const [tripId, firedAtMs] of watch.firedTrips) {
      if (nowMs - firedAtMs > FIRED_TTL_MS) watch.firedTrips.delete(tripId);
    }

    const stop = stops.get(watch.stopId);
    if (!stop) continue;
    const candidates = tripUpdatesByStop.get(watch.stopId) || [];

    for (const candidate of candidates) {
      if (watch.routeId && candidate.routeId !== watch.routeId) continue;
      if (watch.firedTrips.has(candidate.tripId)) continue;

      const etaMinutes = (candidate.arrivalTime - nowSec) / 60;
      if (etaMinutes < -1) continue; // already gone

      const scheduledTrigger = etaMinutes <= watch.thresholdMinutes;

      let gpsTrigger = false;
      const vehicle = vehiclesByTrip.get(candidate.tripId);
      if (vehicle) {
        const distanceM = haversineMeters(vehicle.lat, vehicle.lon, stop.lat, stop.lon);
        if (distanceM <= GPS_BACKUP_METERS) gpsTrigger = true;
      }

      if (!scheduledTrigger && !gpsTrigger) continue;

      const route = candidate.routeId ? routes[candidate.routeId] : null;
      const routeLabel = route?.shortName || candidate.routeId || 'Bus';
      const minutesLabel = Math.max(0, Math.round(etaMinutes));

      watch.firedTrips.set(candidate.tripId, nowMs);
      saveStore();

      await sendPush(watch.endpoint, {
        title: `Route ${routeLabel} is ${minutesLabel <= 1 ? 'almost here' : `${minutesLabel} min away`}`,
        body: `Approaching ${stop.name}${gpsTrigger ? ' (live GPS)' : ''}`,
        tag: `watch-${watch.id}`,
        data: { watchId: watch.id, stopId: watch.stopId, routeId: candidate.routeId },
      });
    }
  }
}

loadStore();
