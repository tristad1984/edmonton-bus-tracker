import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { toNumber } from './utils.js';

const TRIP_UPDATES_URL = 'http://gtfs.edmonton.ca/TMGTFSRealTimeWebService/TripUpdate/TripUpdates.pb';

// Fetches and decodes the live trip-updates feed, then builds a
// stopId -> [{ tripId, routeId, directionId, arrivalTime, departureTime }]
// index (only future stop-time predictions) so lookups by stop are O(1).
export async function fetchTripUpdates(tripsLookup) {
  const res = await fetch(TRIP_UPDATES_URL);
  if (!res.ok) throw new Error(`trip updates fetch failed: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

  const nowSec = Date.now() / 1000;
  const byStop = new Map();
  const byTrip = new Map();

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu || !tu.trip || !tu.trip.tripId) continue;

    const tripId = tu.trip.tripId;
    const staticInfo = tripsLookup?.get(tripId);
    const routeId = tu.trip.routeId || staticInfo?.routeId || null;
    const directionId = tu.trip.directionId ?? staticInfo?.directionId ?? null;
    const headsign = staticInfo?.headsign || '';

    const stops = [];
    for (const stu of tu.stopTimeUpdate || []) {
      const arrivalTime = toNumber(stu.arrival?.time);
      const departureTime = toNumber(stu.departure?.time);
      const bestTime = arrivalTime ?? departureTime;
      if (bestTime == null || bestTime < nowSec - 60) continue; // skip past/unknown stops

      const record = {
        tripId,
        routeId,
        directionId,
        headsign,
        stopId: stu.stopId,
        arrivalTime: arrivalTime ?? bestTime,
        departureTime: departureTime ?? bestTime,
      };
      stops.push(record);

      if (!byStop.has(stu.stopId)) byStop.set(stu.stopId, []);
      byStop.get(stu.stopId).push(record);
    }

    if (stops.length) byTrip.set(tripId, { tripId, routeId, directionId, headsign, stops });
  }

  for (const list of byStop.values()) list.sort((a, b) => a.arrivalTime - b.arrivalTime);

  return { byStop, byTrip, updatedAt: new Date().toISOString() };
}
