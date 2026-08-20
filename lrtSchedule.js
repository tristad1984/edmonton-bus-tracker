// Edmonton's LRT has no real-time GPS feed, so its "predictions" come from
// the static published schedule (calendar + calendar_dates + stop_times)
// instead of live trip updates. Output records match the same shape as live
// bus trip-update records so they can be merged straight into the same
// stopId -> [records] structure everything else already reads from.

function ymd(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function isServiceActiveOnDate(serviceId, date, calendar, calendarExceptions) {
  const dateStr = ymd(date);
  const exception = calendarExceptions.get(`${serviceId}_${dateStr}`);
  if (exception === 1) return true;
  if (exception === 2) return false;
  const cal = calendar.get(serviceId);
  if (!cal) return false;
  if (dateStr < cal.startDate || dateStr > cal.endDate) return false;
  return cal.weekdays[date.getDay()];
}

export function lrtPredictionsForStop(stopId, ctx, windowMinutes = 60) {
  const { trips, calendar, calendarExceptions, lrtStopTimesByStop } = ctx;
  const entries = lrtStopTimesByStop.get(stopId);
  if (!entries || !entries.length) return [];

  const now = new Date();
  const nowSec = now.getTime() / 1000;
  const results = [];

  // Check both today's service day and yesterday's, since a trip starting
  // before midnight can have GTFS times like "25:10:00" (1:10am next day).
  for (const dayOffset of [0, -1]) {
    const serviceDate = new Date(now);
    serviceDate.setDate(serviceDate.getDate() + dayOffset);
    serviceDate.setHours(0, 0, 0, 0);
    const serviceDayStartSec = serviceDate.getTime() / 1000;

    for (const entry of entries) {
      const trip = trips.get(entry.tripId);
      if (!trip || !trip.serviceId) continue;
      if (!isServiceActiveOnDate(trip.serviceId, serviceDate, calendar, calendarExceptions)) continue;

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
