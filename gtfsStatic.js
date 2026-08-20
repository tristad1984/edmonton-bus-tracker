import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';

const GTFS_ZIP_URL = 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/gtfs.zip';

// Edmonton's LRT lines have no real-time GPS feed (only buses do), so their
// predictions come from the static published schedule instead. These are
// ETS's stable, well-known LRT route_ids.
export const LRT_ROUTE_IDS = new Set(['021R', '022R', '023R']);

const WEEKDAY_FIELDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function readCsv(zip, filename) {
  const entry = zip.getEntry(filename);
  if (!entry) throw new Error(`${filename} not found in GTFS zip`);
  const text = entry.getData().toString('utf8').replace(/^﻿/, '');
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
}

function parseTimeToSeconds(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  if ([h, m, s].some(Number.isNaN)) return null;
  return h * 3600 + m * 60 + s;
}

// Downloads and parses the static GTFS bundle. stops.txt and trips.txt cover
// the whole network (used for stop lookup / trip->route mapping). calendar,
// calendar_dates, and stop_times are only parsed for LRT trips specifically
// — buses get their schedule info from the realtime feeds, so pulling the
// full stop_times.txt (huge) for every bus trip too isn't needed.
export async function loadGtfsStatic() {
  const res = await fetch(GTFS_ZIP_URL);
  if (!res.ok) throw new Error(`GTFS zip fetch failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buffer);

  const stopRows = readCsv(zip, 'stops.txt');
  const stops = new Map();
  for (const row of stopRows) {
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!row.stop_id || Number.isNaN(lat) || Number.isNaN(lon)) continue;
    // location_type 1 = a parent "station" grouping entry (e.g. an LRT
    // station name shared by several platform-level stops) — it's never a
    // real boarding point itself and never appears in stop_times.txt, so
    // including it just produces identically-named dead-end search results.
    if (row.location_type === '1') continue;
    stops.set(row.stop_id, {
      stopId: row.stop_id,
      code: row.stop_code || row.stop_id,
      name: row.stop_name || row.stop_id,
      lat,
      lon,
    });
  }

  const tripRows = readCsv(zip, 'trips.txt');
  const trips = new Map();
  const lrtTripIds = new Set();
  for (const row of tripRows) {
    if (!row.trip_id) continue;
    trips.set(row.trip_id, {
      routeId: row.route_id || null,
      serviceId: row.service_id || null,
      directionId: row.direction_id !== '' ? Number(row.direction_id) : null,
      headsign: row.trip_headsign || '',
    });
    if (LRT_ROUTE_IDS.has(row.route_id)) lrtTripIds.add(row.trip_id);
  }

  const calendar = new Map(); // service_id -> { weekdays: bool[7], startDate, endDate }
  try {
    for (const row of readCsv(zip, 'calendar.txt')) {
      calendar.set(row.service_id, {
        weekdays: WEEKDAY_FIELDS.map((f) => row[f] === '1'),
        startDate: row.start_date,
        endDate: row.end_date,
      });
    }
  } catch (err) {
    console.warn('[static] calendar.txt unavailable:', err.message);
  }

  const calendarExceptions = new Map(); // `${service_id}_${YYYYMMDD}` -> 1 (added) | 2 (removed)
  try {
    for (const row of readCsv(zip, 'calendar_dates.txt')) {
      calendarExceptions.set(`${row.service_id}_${row.date}`, Number(row.exception_type));
    }
  } catch (err) {
    console.warn('[static] calendar_dates.txt unavailable:', err.message);
  }

  const lrtStopTimesByStop = new Map(); // stopId -> [{ tripId, arrivalSec, departureSec }]
  try {
    for (const row of readCsv(zip, 'stop_times.txt')) {
      if (!lrtTripIds.has(row.trip_id)) continue;
      const arrivalSec = parseTimeToSeconds(row.arrival_time);
      const departureSec = parseTimeToSeconds(row.departure_time || row.arrival_time);
      if (arrivalSec == null || !row.stop_id) continue;
      if (!lrtStopTimesByStop.has(row.stop_id)) lrtStopTimesByStop.set(row.stop_id, []);
      lrtStopTimesByStop.get(row.stop_id).push({ tripId: row.trip_id, arrivalSec, departureSec });
    }
  } catch (err) {
    console.warn('[static] stop_times.txt unavailable — LRT schedules disabled:', err.message);
  }

  return { stops, trips, calendar, calendarExceptions, lrtStopTimesByStop };
}
