import { transit_realtime as GtfsRt } from "gtfs-realtime-bindings"
import { DeepReadonly } from "ts-essentials"
import type { IListVehicleStopTimesResult } from "./queries/list-vehicle-stop-times.queries"

type ITripUpdate = GtfsRt.ITripUpdate
type IVehiclePosition = GtfsRt.IVehiclePosition

const VehicleStopStatus = GtfsRt.VehiclePosition.VehicleStopStatus

export type VehicleStopTime = DeepReadonly<IListVehicleStopTimesResult>

/**
 * Synthesizes a TripUpdate from a VehiclePosition for agencies that only
 * publish vehicle positions (e.g. IDS JMK in Brno). The delay is estimated by
 * comparing when the vehicle was observed against the static schedule:
 *
 * - `STOPPED_AT` a stop: late by however long it has stayed past the
 *   scheduled departure (never early, since it will hold until then).
 * - `IN_TRANSIT_TO`/`INCOMING_AT` a stop: compare the observation time with
 *   when the schedule expects the vehicle to be at its position, interpolated
 *   by distance between the previous stop and the next one.
 *
 * `stopTimes` are the scheduled times at `stopId` for the vehicle's trip on
 * each candidate service day; the instance closest to the observation wins.
 */
export function tripUpdateFromVehiclePosition(
  vehicle: DeepReadonly<IVehiclePosition>,
  stopId: string,
  stopTimes: ReadonlyArray<VehicleStopTime>,
  observedAt: number,
): ITripUpdate | null {
  const tripId = vehicle.trip?.tripId
  if (!tripId) {
    return null
  }

  const candidates = stopTimes.filter(
    (stopTime) =>
      stopTime.trip_id === tripId &&
      stopTime.stop_id === stopId &&
      (!vehicle.trip?.startDate ||
        stopTime.start_date === vehicle.trip.startDate),
  )

  if (candidates.length === 0) {
    return null
  }

  const stopTime = candidates.reduce((best, candidate) =>
    Math.abs(observedAt - toUnix(candidate.arrival_time)) <
    Math.abs(observedAt - toUnix(best.arrival_time))
      ? candidate
      : best,
  )

  const delay = Math.round(estimateDelay(vehicle, stopTime, observedAt))

  return {
    trip: {
      ...vehicle.trip,
      tripId,
      startDate: stopTime.start_date,
    },
    vehicle: vehicle.vehicle,
    timestamp: observedAt,
    stopTimeUpdate: [
      {
        stopSequence: stopTime.stop_sequence,
        stopId: stopTime.stop_id,
        arrival: { delay },
        departure: { delay },
      },
    ],
  } as ITripUpdate
}

function estimateDelay(
  vehicle: DeepReadonly<IVehiclePosition>,
  stopTime: VehicleStopTime,
  observedAt: number,
): number {
  const status = vehicle.currentStatus ?? VehicleStopStatus.IN_TRANSIT_TO
  const scheduledDeparture = toUnix(stopTime.departure_time)

  if (
    status === VehicleStopStatus.STOPPED_AT ||
    stopTime.prev_departure_time === null
  ) {
    return Math.max(0, observedAt - scheduledDeparture)
  }

  const previousDeparture = toUnix(stopTime.prev_departure_time)
  if (observedAt < previousDeparture) {
    // It can't have left the previous stop yet (e.g. it's laying over at the
    // terminus but already reports the next stop), so it'll leave on time
    return 0
  }

  const progress = progressBetweenStops(vehicle, stopTime) ?? 1
  const expectedAt =
    previousDeparture +
    progress * (toUnix(stopTime.arrival_time) - previousDeparture)

  return observedAt - expectedAt
}

/**
 * Fraction (0-1) of the way from the previous stop to the next stop, based on
 * straight-line distance, or null if it can't be determined.
 */
function progressBetweenStops(
  vehicle: DeepReadonly<IVehiclePosition>,
  stopTime: VehicleStopTime,
): number | null {
  const position = vehicle.position
  if (
    !position ||
    stopTime.stop_lat === null ||
    stopTime.stop_lon === null ||
    stopTime.prev_stop_lat === null ||
    stopTime.prev_stop_lon === null
  ) {
    return null
  }

  const fromPrevious = distance(
    stopTime.prev_stop_lat,
    stopTime.prev_stop_lon,
    position.latitude,
    position.longitude,
  )

  const toNext = distance(
    position.latitude,
    position.longitude,
    stopTime.stop_lat,
    stopTime.stop_lon,
  )

  if (fromPrevious + toNext === 0) {
    return null
  }

  return fromPrevious / (fromPrevious + toNext)
}

// Equirectangular approximation; plenty accurate between adjacent stops
function distance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRadians = Math.PI / 180
  const x =
    (lon2 - lon1) * toRadians * Math.cos(((lat1 + lat2) / 2) * toRadians)
  const y = (lat2 - lat1) * toRadians
  return Math.hypot(x, y)
}

function toUnix(date: Date | DeepReadonly<Date>): number {
  return new Date(date as Date).getTime() / 1000
}
