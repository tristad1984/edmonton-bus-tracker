const EDMONTON_CENTER = [53.5461, -113.4938];
const POLL_MS = 5000;

const map = L.map('map', { zoomControl: true }).setView(EDMONTON_CENTER, 12);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  subdomains: 'abcd',
  maxZoom: 20,
}).addTo(map);

const statusEl = document.getElementById('status');
const markers = new Map(); // vehicle id -> L.marker

const STALE_AFTER_SECONDS = 90;

function isStale(vehicle) {
  if (!vehicle.timestamp) return false;
  return Date.now() / 1000 - vehicle.timestamp > STALE_AFTER_SECONDS;
}

function makeIcon(vehicle) {
  const color = vehicle.routeColor || '#0066cc';
  const hasBearing = typeof vehicle.bearing === 'number' && !Number.isNaN(vehicle.bearing);
  const arrowHtml = hasBearing
    ? `<div class="bus-arrow" style="--arrow-color:${color}; transform: rotate(${vehicle.bearing}deg);"></div>`
    : '';
  const staleClass = isStale(vehicle) ? ' stale' : '';
  const html = `
    <div class="bus-marker${staleClass}">
      ${arrowHtml}
      <div class="bus-dot" style="background:${color};">${escapeHtml(vehicle.routeShortName || '')}</div>
    </div>`;
  return L.divIcon({
    html,
    className: '',
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    popupAnchor: [0, -19],
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function popupHtml(vehicle) {
  const speedKmh = typeof vehicle.speedMps === 'number' ? Math.round(vehicle.speedMps * 3.6) : null;
  let ageLabel = 'unknown';
  if (vehicle.timestamp) {
    const ageSec = Math.round(Date.now() / 1000 - vehicle.timestamp);
    ageLabel = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
    if (isStale(vehicle)) ageLabel += ' — not reporting recently';
  }
  return `
    <div class="bus-popup">
      <b>Route ${escapeHtml(vehicle.routeShortName || '?')}</b>
      <div>Vehicle: ${escapeHtml(vehicle.label || vehicle.id)}</div>
      ${speedKmh !== null ? `<div>Speed: ${speedKmh} km/h</div>` : ''}
      <div class="muted">Last GPS update: ${ageLabel}</div>
    </div>`;
}

let focusedTripId = null; // when set, only this trip's bus is shown

async function refresh() {
  try {
    const res = await fetch('/api/vehicles');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const allVehicles = data.vehicles || [];
    const vehicles = focusedTripId ? allVehicles.filter((v) => v.tripId === focusedTripId) : allVehicles;
    const seen = new Set();

    for (const v of vehicles) {
      if (typeof v.lat !== 'number' || typeof v.lon !== 'number') continue;
      seen.add(v.id);
      const existing = markers.get(v.id);
      if (existing) {
        existing.setLatLng([v.lat, v.lon]);
        existing.setIcon(makeIcon(v));
        existing.getPopup()?.setContent(popupHtml(v));
      } else {
        const marker = L.marker([v.lat, v.lon], { icon: makeIcon(v) }).addTo(map);
        marker.bindPopup(popupHtml(v));
        markers.set(v.id, marker);
        if (focusedTripId) marker.openPopup();
      }
    }

    for (const [id, marker] of markers) {
      if (!seen.has(id)) {
        map.removeLayer(marker);
        markers.delete(id);
      }
    }

    const time = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : '—';
    if (data.error) {
      statusEl.textContent = `${allVehicles.length} buses · feed error: ${data.error}`;
    } else if (focusedTripId) {
      statusEl.textContent = vehicles.length
        ? `Tracking your bus · updated ${time}`
        : `Waiting for this bus's GPS… · updated ${time}`;
    } else {
      statusEl.textContent = `${allVehicles.length} buses · updated ${time}`;
    }
  } catch (err) {
    statusEl.textContent = `connection error: ${err.message}`;
  }
}

refresh();
setInterval(refresh, POLL_MS);

let stopMarker = null;
let userLocationMarker = null;
let geoWatchId = null;

function startWatchingUserLocation() {
  if (!navigator.geolocation || geoWatchId != null) return;
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      const icon = L.divIcon({
        html: '<div class="my-location-dot"></div>',
        className: '',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      if (userLocationMarker) {
        userLocationMarker.setLatLng([latitude, longitude]);
      } else {
        userLocationMarker = L.marker([latitude, longitude], { icon, zIndexOffset: 3000 }).addTo(map);
      }
    },
    (err) => console.warn('geolocation watch failed:', err.message),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function stopWatchingUserLocation() {
  if (geoWatchId != null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  if (userLocationMarker) {
    map.removeLayer(userLocationMarker);
    userLocationMarker = null;
  }
}

function focusOnTrip(tripId, stop, label) {
  focusedTripId = tripId;
  showStopOnMap(stop);
  startWatchingUserLocation();
  document.getElementById('focus-label').textContent = `🎯 Tracking ${label || 'your bus'}`;
  document.getElementById('focus-banner').classList.remove('hidden');
  refresh();
}

function clearFocus() {
  focusedTripId = null;
  stopWatchingUserLocation();
  document.getElementById('focus-banner').classList.add('hidden');
  refresh();
}

document.getElementById('clear-focus-btn').addEventListener('click', clearFocus);

function showStopOnMap(stop) {
  if (stopMarker) map.removeLayer(stopMarker);
  const icon = L.divIcon({
    html: '<div class="stop-pin"></div>',
    className: '',
    iconSize: [22, 30],
    iconAnchor: [11, 30],
  });
  stopMarker = L.marker([stop.lat, stop.lon], { icon, zIndexOffset: 2000 }).addTo(map);
  stopMarker.bindPopup(`<b>${escapeHtml(stop.name)}</b>`).openPopup();
  map.setView([stop.lat, stop.lon], 16);
}
