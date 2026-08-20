import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';

const GTFS_ZIP_URL = 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/gtfs.zip';

function readCsv(zip, filename) {
  const entry = zip.getEntry(filename);
  if (!entry) throw new Error(`${filename} not found in GTFS zip`);
  const text = entry.getData().toString('utf8').replace(/^﻿/, '');
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
}

// Downloads and parses the static GTFS bundle, returning lookup maps.
// Only stops.txt and trips.txt are parsed — everything else the app needs
// (which routes/stops are currently active) comes from the realtime feeds.
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
  for (const row of tripRows) {
    if (!row.trip_id) continue;
    trips.set(row.trip_id, {
      routeId: row.route_id || null,
      directionId: row.direction_id !== '' ? Number(row.direction_id) : null,
      headsign: row.trip_headsign || '',
    });
  }

  return { stops, trips };
}
