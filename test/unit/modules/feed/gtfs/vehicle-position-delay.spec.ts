import { transit_realtime as GtfsRt } from "gtfs-realtime-bindings"
import {
  tripUpdateFromVehiclePosition,
  VehicleStopTime,
} from "src/modules/feed/modules/gtfs/vehicle-position-delay"
import { describe, expect, it } from "vitest"

const VehicleStopStatus = GtfsRt.VehiclePosition.VehicleStopStatus

const unix = (iso: string) => new Date(iso).getTime() / 1000

// Previous stop at (49.0, 16.0) departing 12:00, next stop 1 km north at
// (49.009, 16.0) arriving 12:02 and departing 12:03
function stopTime(overrides: Partial<VehicleStopTime> = {}): VehicleStopTime {
  return {
    trip_id: "trip-1",
    stop_id: "next-stop",
    stop_sequence: 5,
    stop_lat: 49.009,
    stop_lon: 16.0,
    start_date: "20261021",
    arrival_time: new Date("2026-10-21T12:02:00Z"),
    departure_time: new Date("2026-10-21T12:03:00Z"),
    prev_stop_lat: 49.0,
    prev_stop_lon: 16.0,
    prev_departure_time: new Date("2026-10-21T12:00:00Z"),
    ...overrides,
  }
}

function vehicle(
  overrides: GtfsRt.IVehiclePosition = {},
): GtfsRt.IVehiclePosition {
  return {
    trip: { tripId: "trip-1" },
    stopId: "next-stop",
    currentStatus: VehicleStopStatus.IN_TRANSIT_TO,
    position: { latitude: 49.0045, longitude: 16.0 },
    vehicle: { id: "1088", label: "1088" },
    ...overrides,
  }
}

function delayOf(update: GtfsRt.ITripUpdate | null) {
  return update?.stopTimeUpdate?.[0]?.departure?.delay
}

describe("tripUpdateFromVehiclePosition", () => {
  it("interpolates the expected time between stops", () => {
    // Halfway between stops at 12:03 is 2 minutes later than the schedule
    // expects (12:01)
    const update = tripUpdateFromVehiclePosition(
      vehicle(),
      "next-stop",
      [stopTime()],
      unix("2026-10-21T12:03:00Z"),
    )

    expect(delayOf(update)).toBe(120)
    expect(update?.stopTimeUpdate?.[0]?.arrival?.delay).toBe(120)
    expect(update?.stopTimeUpdate?.[0]?.stopSequence).toBe(5)
    expect(update?.stopTimeUpdate?.[0]?.stopId).toBe("next-stop")
  })

  it("reports early running", () => {
    const update = tripUpdateFromVehiclePosition(
      vehicle(),
      "next-stop",
      [stopTime()],
      unix("2026-10-21T12:00:30Z"),
    )

    expect(delayOf(update)).toBe(-30)
  })

  it("uses the next stop's arrival when the position is unknown", () => {
    const update = tripUpdateFromVehiclePosition(
      vehicle({ position: null }),
      "next-stop",
      [stopTime()],
      unix("2026-10-21T12:05:00Z"),
    )

    expect(delayOf(update)).toBe(180)
  })

  it("assumes an on-time departure if the vehicle can't have left yet", () => {
    // Laying over at the terminus while already reporting the next stop
    const update = tripUpdateFromVehiclePosition(
      vehicle({ position: { latitude: 49.0, longitude: 16.0 } }),
      "next-stop",
      [stopTime()],
      unix("2026-10-21T11:50:00Z"),
    )

    expect(delayOf(update)).toBe(0)
  })

  it("is late by the time spent past the departure when stopped", () => {
    const update = tripUpdateFromVehiclePosition(
      vehicle({ currentStatus: VehicleStopStatus.STOPPED_AT }),
      "next-stop",
      [stopTime()],
      unix("2026-10-21T12:04:30Z"),
    )

    expect(delayOf(update)).toBe(90)
  })

  it("is on time when stopped before the scheduled departure", () => {
    const update = tripUpdateFromVehiclePosition(
      vehicle({ currentStatus: VehicleStopStatus.STOPPED_AT }),
      "next-stop",
      [stopTime()],
      unix("2026-10-21T12:01:00Z"),
    )

    expect(delayOf(update)).toBe(0)
  })

  it("handles a vehicle heading to the first stop", () => {
    const first = stopTime({
      stop_sequence: 1,
      prev_stop_lat: null,
      prev_stop_lon: null,
      prev_departure_time: null,
    })

    expect(
      delayOf(
        tripUpdateFromVehiclePosition(
          vehicle(),
          "next-stop",
          [first],
          unix("2026-10-21T11:55:00Z"),
        ),
      ),
    ).toBe(0)

    expect(
      delayOf(
        tripUpdateFromVehiclePosition(
          vehicle(),
          "next-stop",
          [first],
          unix("2026-10-21T12:04:00Z"),
        ),
      ),
    ).toBe(60)
  })

  it("picks the service day closest to the observation", () => {
    const yesterday = stopTime({
      start_date: "20261020",
      arrival_time: new Date("2026-10-20T12:02:00Z"),
      departure_time: new Date("2026-10-20T12:03:00Z"),
      prev_departure_time: new Date("2026-10-20T12:00:00Z"),
    })

    const update = tripUpdateFromVehiclePosition(
      vehicle(),
      "next-stop",
      [yesterday, stopTime()],
      unix("2026-10-21T12:03:00Z"),
    )

    expect(update?.trip?.startDate).toBe("20261021")
    expect(delayOf(update)).toBe(120)
  })

  it("respects the vehicle's start date when it has one", () => {
    const update = tripUpdateFromVehiclePosition(
      vehicle({ trip: { tripId: "trip-1", startDate: "20261020" } }),
      "next-stop",
      [stopTime()],
      unix("2026-10-21T12:03:00Z"),
    )

    expect(update).toBeNull()
  })

  it("keeps the trip and vehicle descriptors", () => {
    const update = tripUpdateFromVehiclePosition(
      vehicle({ trip: { tripId: "trip-1", routeId: "L1" } }),
      "next-stop",
      [stopTime()],
      unix("2026-10-21T12:03:00Z"),
    )

    expect(update?.trip).toEqual({
      tripId: "trip-1",
      routeId: "L1",
      startDate: "20261021",
    })
    expect(update?.vehicle?.label).toBe("1088")
    expect(update?.timestamp).toBe(unix("2026-10-21T12:03:00Z"))
  })

  it("returns null without a trip or a matching scheduled stop", () => {
    const observedAt = unix("2026-10-21T12:03:00Z")

    expect(
      tripUpdateFromVehiclePosition(
        vehicle({ trip: null }),
        "next-stop",
        [stopTime()],
        observedAt,
      ),
    ).toBeNull()

    expect(
      tripUpdateFromVehiclePosition(
        vehicle(),
        "other-stop",
        [stopTime()],
        observedAt,
      ),
    ).toBeNull()

    expect(
      tripUpdateFromVehiclePosition(vehicle(), "next-stop", [], observedAt),
    ).toBeNull()
  })
})
