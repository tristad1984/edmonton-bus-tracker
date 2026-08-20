(() => {
  const stopResultsEl = document.getElementById('stop-results');
  const stopSearchEl = document.getElementById('stop-search');
  const routeSearchEl = document.getElementById('route-search');
  const locateBtn = document.getElementById('locate-btn');
  const predictionsCard = document.getElementById('predictions-card');
  const predictionsStopName = document.getElementById('predictions-stop-name');
  const predictionsList = document.getElementById('predictions-list');
  const watchForm = document.getElementById('watch-form');
  const thresholdSelect = document.getElementById('threshold-select');
  const subscribeBtn = document.getElementById('subscribe-btn');
  const subscribeStatus = document.getElementById('subscribe-status');
  const watchListEl = document.getElementById('watch-list');
  const viewOnMapBtn = document.getElementById('view-on-map-btn');
  const destinationSearchEl = document.getElementById('destination-search');
  const findRouteBtn = document.getElementById('find-route-btn');
  const tripSuggestionsEl = document.getElementById('trip-suggestions');

  let selectedStop = null; // { stopId, name, lat, lon }
  let selectedRouteId = null; // null = any route at this stop

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function formatDistance(m) {
    return m < 1000 ? `${m} m away` : `${(m / 1000).toFixed(1)} km away`;
  }

  function formatEta(min) {
    if (min <= 0) return 'due now';
    return `${min} min`;
  }

  async function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  function renderStopResults(stops, { showDistance = false } = {}) {
    stopResultsEl.innerHTML = '';
    if (!stops.length) {
      stopResultsEl.innerHTML = '<div class="muted">No stops found.</div>';
      return;
    }
    for (const stop of stops) {
      const row = document.createElement('div');
      row.className = 'result-item';
      row.innerHTML = `
        <div class="item-main">
          ${escapeHtml(stop.name)}
          <div class="item-sub">Stop ${escapeHtml(stop.code)}${showDistance ? ' · ' + formatDistance(stop.distanceM) : ''}${stop.headsign ? ' · towards ' + escapeHtml(stop.headsign) : ''}</div>
        </div>
        ${typeof stop.nextEtaMinutes === 'number' ? `<div class="eta">${formatEta(stop.nextEtaMinutes)}</div>` : ''}
      `;
      row.addEventListener('click', () => selectStop(stop.stopId, stop.name, stop.routeIdHint || null));
      stopResultsEl.appendChild(row);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      stopResultsEl.innerHTML = '<div class="muted">Geolocation isn\'t available in this browser.</div>';
      return;
    }
    locateBtn.disabled = true;
    locateBtn.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        locateBtn.disabled = false;
        locateBtn.textContent = '📍 Use my location';
        const { latitude, longitude } = pos.coords;
        const res = await fetch(`/api/stops/nearby?lat=${latitude}&lon=${longitude}&limit=8`);
        const data = await res.json();
        renderStopResults(data.stops, { showDistance: true });
      },
      (err) => {
        locateBtn.disabled = false;
        locateBtn.textContent = '📍 Use my location';
        const msg = err.code === err.PERMISSION_DENIED
          ? 'Location permission denied. Try searching by name instead.'
          : 'Could not get an accurate location (this is common over plain HTTP — it will be more accurate once deployed to HTTPS). Try searching by name instead.';
        stopResultsEl.innerHTML = `<div class="muted">${msg}</div>`;
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });

  function getCurrentPositionAsync() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation isn\'t available in this browser.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
    });
  }

  findRouteBtn.addEventListener('click', async () => {
    const destText = destinationSearchEl.value.trim();
    if (!destText) return;
    findRouteBtn.disabled = true;
    findRouteBtn.textContent = 'Finding your route…';
    tripSuggestionsEl.innerHTML = '';
    try {
      const pos = await getCurrentPositionAsync().catch((err) => {
        throw new Error(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied — turn it on to use "Where to?".'
            : 'Could not get your location.'
        );
      });
      const { latitude, longitude } = pos.coords;

      const geoRes = await fetch(`/api/geocode?q=${encodeURIComponent(destText)}`);
      const geoData = await geoRes.json();
      if (!geoData.results || !geoData.results.length) {
        tripSuggestionsEl.innerHTML = '<div class="muted">Couldn\'t find that place. Try a more specific address.</div>';
        return;
      }
      const dest = geoData.results[0];

      const tripRes = await fetch(
        `/api/trip-suggestions?fromLat=${latitude}&fromLon=${longitude}&toLat=${dest.lat}&toLon=${dest.lon}`
      );
      const tripData = await tripRes.json();

      if (!tripData.suggestions || !tripData.suggestions.length) {
        const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lon}&travelmode=transit`;
        tripSuggestionsEl.innerHTML = `
          <div class="muted">
            No direct (no-transfer) route found to "${escapeHtml(dest.label)}" from your location.
            You may need a transfer — try <a href="${gmapsUrl}" target="_blank" rel="noopener">Google Maps transit directions</a>.
          </div>`;
        return;
      }

      tripSuggestionsEl.innerHTML = `<div class="muted">Routes to "${escapeHtml(dest.label)}":</div>`;
      for (const s of tripData.suggestions) {
        const row = document.createElement('div');
        row.className = 'result-item';
        row.innerHTML = `
          <div class="route-chip" style="background:${s.routeColor}">${escapeHtml(s.routeShortName)}</div>
          <div class="item-main">
            ${escapeHtml(s.headsign)}
            <div class="item-sub">Board at ${escapeHtml(s.boardStop.name)} (${formatDistance(s.boardStop.distanceM)}) · get off near ${escapeHtml(s.alightStop.name)} (${formatDistance(s.alightStop.distanceM)} from destination)</div>
          </div>
          <div class="eta">${formatEta(s.etaMinutes)}</div>
        `;
        row.addEventListener('click', () => selectStop(s.boardStop.stopId, s.boardStop.name, s.routeId));
        tripSuggestionsEl.appendChild(row);
      }
    } catch (err) {
      tripSuggestionsEl.innerHTML = `<div class="muted">⚠️ ${escapeHtml(err.message)}</div>`;
    } finally {
      findRouteBtn.disabled = false;
      findRouteBtn.textContent = '🧭 Find my route';
    }
  });

  stopSearchEl.addEventListener(
    'input',
    debounce(async () => {
      const q = stopSearchEl.value.trim();
      if (!q) { stopResultsEl.innerHTML = ''; return; }
      const res = await fetch(`/api/stops/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      renderStopResults(data.stops);
    }, 300)
  );

  routeSearchEl.addEventListener(
    'input',
    debounce(async () => {
      const q = routeSearchEl.value.trim();
      if (!q) { stopResultsEl.innerHTML = ''; return; }
      const res = await fetch(`/api/routes/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data.routes.length) {
        stopResultsEl.innerHTML = '<div class="muted">No matching route.</div>';
        return;
      }
      stopResultsEl.innerHTML = '';
      for (const route of data.routes) {
        const row = document.createElement('div');
        row.className = 'result-item';
        row.innerHTML = `
          <div class="route-chip" style="background:${route.color}">${escapeHtml(route.shortName)}</div>
          <div class="item-main">${escapeHtml(route.longName || route.shortName)}</div>
        `;
        row.addEventListener('click', async () => {
          const stopsRes = await fetch(`/api/routes/${encodeURIComponent(route.routeId)}/stops`);
          const stopsData = await stopsRes.json();
          const stops = stopsData.stops.map((s) => ({ ...s, routeIdHint: route.routeId }));
          renderStopResults(stops);
        });
        stopResultsEl.appendChild(row);
      }
    }, 300)
  );

  async function selectStop(stopId, name, routeIdHint) {
    selectedStop = { stopId, name };
    selectedRouteId = routeIdHint || null;
    predictionsStopName.textContent = name;
    predictionsCard.classList.remove('hidden');
    predictionsList.innerHTML = '<div class="muted">Loading…</div>';
    watchForm.classList.add('hidden');
    subscribeStatus.textContent = '';

    const res = await fetch(`/api/stops/${encodeURIComponent(stopId)}/predictions`);
    const data = await res.json();
    selectedStop.lat = data.stop.lat;
    selectedStop.lon = data.stop.lon;
    const predictions = routeIdHint ? data.predictions.filter((p) => p.routeId === routeIdHint) : data.predictions;

    if (!predictions.length) {
      predictionsList.innerHTML = '<div class="muted">No buses currently predicted at this stop.</div>';
    } else {
      predictionsList.innerHTML = '';
      for (const p of predictions) {
        const row = document.createElement('div');
        row.className = 'result-item';
        row.innerHTML = `
          <div class="route-chip" style="background:${p.routeColor}">${escapeHtml(p.routeShortName)}</div>
          <div class="item-main">
            ${escapeHtml(p.headsign || '')}
            <div class="item-sub">Tap to track this bus on the map</div>
          </div>
          <div class="eta">${formatEta(p.etaMinutes)}</div>
        `;
        row.addEventListener('click', () => {
          document.querySelector('.tab-btn[data-view="map-view"]').click();
          const label = `Route ${p.routeShortName}`;
          setTimeout(() => focusOnTrip(p.tripId, selectedStop, label), 100);
        });
        predictionsList.appendChild(row);
      }
    }
    watchForm.classList.remove('hidden');
    predictionsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  viewOnMapBtn.addEventListener('click', () => {
    if (!selectedStop || typeof selectedStop.lat !== 'number') return;
    // switch tabs first so the map container is visible/sized before we set its view
    document.querySelector('.tab-btn[data-view="map-view"]').click();
    setTimeout(() => {
      clearFocus(); // in case a previous single-bus focus was active
      showStopOnMap(selectedStop);
    }, 100);
  });

  subscribeBtn.addEventListener('click', async () => {
    if (!selectedStop) return;
    subscribeBtn.disabled = true;
    subscribeStatus.textContent = 'Setting up notifications…';
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('Push notifications are not supported in this browser.');
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notification permission was not granted.');

      const keyRes = await fetch('/api/push/vapid-public-key');
      const keyData = await keyRes.json();
      if (!keyData.enabled) throw new Error('Push isn\'t configured on the server yet.');

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: await urlBase64ToUint8Array(keyData.publicKey),
        });
      }

      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });

      const watchRes = await fetch('/api/watches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          stopId: selectedStop.stopId,
          routeId: selectedRouteId,
          thresholdMinutes: Number(thresholdSelect.value),
        }),
      });
      const watchData = await watchRes.json();
      if (!watchRes.ok) throw new Error(watchData.error || 'Failed to create alert');

      subscribeStatus.textContent = `✅ Alert set for ${selectedStop.name}`;
      loadWatches();
    } catch (err) {
      subscribeStatus.textContent = `⚠️ ${err.message}`;
    } finally {
      subscribeBtn.disabled = false;
    }
  });

  async function loadWatches() {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      watchListEl.innerHTML = '<div class="muted">No active alerts yet.</div>';
      return;
    }
    const res = await fetch(`/api/watches?endpoint=${encodeURIComponent(subscription.endpoint)}`);
    const data = await res.json();
    if (!data.watches.length) {
      watchListEl.innerHTML = '<div class="muted">No active alerts yet.</div>';
      return;
    }
    watchListEl.innerHTML = '';
    for (const w of data.watches) {
      const row = document.createElement('div');
      row.className = 'result-item watch-row';
      row.innerHTML = `
        <div class="item-main">
          ${escapeHtml(w.stopName)}
          <div class="item-sub">${escapeHtml(w.routeShortName)} · alert at ${w.thresholdMinutes} min</div>
        </div>
        <button class="delete-btn" title="Remove alert">✕</button>
      `;
      row.querySelector('.delete-btn').addEventListener('click', async () => {
        await fetch(`/api/watches/${w.id}`, { method: 'DELETE' });
        loadWatches();
      });
      watchListEl.appendChild(row);
    }
  }

  loadWatches();
})();
