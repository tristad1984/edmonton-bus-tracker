// Edmonton's LRT has no real-time GPS feed, so its "predictions" come from
// the static published schedule (calendar + calendar_dates + stop_times)
// instead of live trip updates. Output records match the same shape as live
// bus trip-update records so they can be merged straight into the same
// stopId -> [records] structure everything else already reads from.
//
// All date/time math below is done explicitly in Edmonton's timezone rather
// than the server process's local time. On most hosts (including Render,
// which runs UTC) "today" per the server clock can already be tomorrow's
// date relative to Edmonton in the evening, which silently broke every
// calendar_dates.txt lookup — the app worked locally only because that dev
// machine happened to be set to Mountain Time already.

const TIME_ZONE = 'America/Edmonton';

function edmontonDateParts(instant) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// The UTC epoch (ms) for 00:00:00 Edmonton time on the given calendar date.
// Standard "guess and correct" trick for zone-aware construction without a
// date library: treat the target Y/M/D as if it were UTC, see what Edmonton
// clock that instant actually shows, and correct by the difference — which
// is exactly the zone's real UTC offset at that moment (so this naturally
// accounts for DST, no hardcoded offset needed).
function edmontonMidnightUtcMs(year, month, day) {
  const guessUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  const shown = edmontonDateParts(new Date(guessUtcMs));
  const shownAsUtcMs = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
  const offsetMs = shownAsUtcMs - guessUtcMs;
  return guessUtcMs - offsetMs;
}

// Pure calendar-day arithmetic (no timezone/DST involved — Y/M/D are just
// numbers here, handled via UTC Date only to get correct month/year rollover).
function addDays(year, month, day, deltaDays) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function ymdString(year, month, day) {
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

function isServiceActiveOnDate(serviceId, dateStr, weekdayIndex, calendar, calendarExceptions) {
  const exception = calendarExceptions.get(`${serviceId}_${dateStr}`);
  if (exception === 1) return true;
  if (exception === 2) return false;
  const cal = calendar.get(serviceId);
  if (!cal) return false;
  if (dateStr < cal.startDate || dateStr > cal.endDate) return false;
  return cal.weekdays[weekdayIndex];
}

export function lrtPredictionsForStop(stopId, ctx, windowMinutes = 60) {
  const { trips, calendar, calendarExceptions, lrtStopTimesByStop } = ctx;
  const entries = lrtStopTimesByStop.get(stopId);
  if (!entries || !entries.length) return [];

  const now = new Date();
  const nowSec = now.getTime() / 1000;
  const todayYmd = edmontonDateParts(now);
  const results = [];

  // Check both today's service day and yesterday's, since a trip starting
  // before midnight can have GTFS times like "25:10:00" (1:10am next day).
  for (const dayOffset of [0, -1]) {
    const { year, month, day } = addDays(todayYmd.year, todayYmd.month, todayYmd.day, dayOffset);
    const dateStr = ymdString(year, month, day);
    const weekdayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const serviceDayStartSec = edmontonMidnightUtcMs(year, month, day) / 1000;

    for (const entry of entries) {
      const trip = trips.get(entry.tripId);
      if (!trip || !trip.serviceId) continue;
      if (!isServiceActiveOnDate(trip.serviceId, dateStr, weekdayIndex, calendar, calendarExceptions)) continue;

      const arrivalTime = serviceDayStartSec + entry.arrivalSec;
      const minutesOut = (arrivalTime - nowSec) / 60;
      if (minutesOut < -1 || minutesOut > windowMinutes) continue;

      results.push({
        tripId: entry.tripId,
        routeId: trip.routeId,
        directionId: trip.directionId,
        headsign: trip.headsign,
        stopId,
        arrivalTime,
        departureTime: serviceDayStartSec + entry.departureSec,
        scheduled: true, // no live GPS — this is a timetable prediction, not a tracked vehicle
      });
    }
  }

  results.sort((a, b) => a.arrivalTime - b.arrivalTime);
  return results;
}
