import { Inject, Injectable, Scope } from "@nestjs/common"
import { Counter } from "@opentelemetry/api"
import { parse as parseCacheControl } from "cache-control-parser"
import { transit_realtime as GtfsRt } from "gtfs-realtime-bindings"
import ms from "ms"
import { MetricService } from "nestjs-otel"
import { PinoLogger } from "nestjs-pino"
import { env } from "src/env"
import { DateTimeService } from "src/modules/datetime/datetime.service"
import { DeepReadonly } from "ts-essentials"
import { FEED_CONTEXT } from "../../feed-context"
import type { FeedContext } from "../../interfaces/feed-provider.interface"
import { FeedCacheService } from "../feed-cache/feed-cache.service"
import type { FetchConfig, GtfsConfig } from "./config"
import {
  decodeTripUpdatesOnly,
  decodeVehiclePositionsOnly,
} from "./decode-trip-updates"
import { GtfsDbService } from "./gtfs-db.service"
import { UpstreamHttpError } from "./gtfs.errors"
import { IGetScheduleForRouteAtStopResult } from "./queries/list-schedule-for-route.queries"
import { listVehicleStopTimes } from "./queries/list-vehicle-stop-times.queries"
import { tripUpdateFromVehiclePosition } from "./vehicle-position-delay"

type ITripUpdate = GtfsRt.ITripUpdate
type IStopTimeUpdate = GtfsRt.TripUpdate.IStopTimeUpdate

// Vehicles that haven't reported in this long are probably out of service
const MAX_VEHICLE_POSITION_AGE_MS = ms("5m")

export type TripUpdateIndex = Map<
  string,
  ReadonlyArray<DeepReadonly<ITripUpdate>>
>

@Injectable({ scope: Scope.REQUEST })
export class GtfsRealtimeService {
  private readonly feedCode: string
  private readonly config: GtfsConfig
  private readonly requestsCounter: Counter
  private readonly failuresCounter: Counter
  private readonly partialDecodesCounter: Counter
  private readonly stopIdRewrite: {
    pattern: RegExp
    replacement: string
  } | null

  constructor(
    @Inject(FEED_CONTEXT) { feedCode, config }: FeedContext<GtfsConfig>,
    private readonly cache: FeedCacheService,
    private readonly db: GtfsDbService,
    private readonly dateTime: DateTimeService,
    metricService: MetricService,
    private readonly logger: PinoLogger,
  ) {
    this.feedCode = feedCode
    this.config = config
    this.stopIdRewrite = config.quirks?.realtimeStopIdRewrite
      ? {
          pattern: new RegExp(config.quirks.realtimeStopIdRewrite.pattern),
          replacement: config.quirks.realtimeStopIdRewrite.replacement,
        }
      : null
    this.logger.setContext(`${GtfsRealtimeService.name}[${feedCode}]`)

    this.requestsCounter = metricService.getCounter("gtfs_realtime_requests", {
      description: "Number of GTFS-RT fetch requests",
      unit: "requests",
    })

    this.failuresCounter = metricService.getCounter("gtfs_realtime_failures", {
      description: "Number of GTFS-RT fetch failures",
      unit: "failures",
    })

    this.partialDecodesCounter = metricService.getCounter(
      "gtfs_realtime_partial_decodes",
      {
        description:
          "Number of GTFS-RT responses that were truncated and only partially decoded",
        unit: "decodes",
      },
    )
  }

  async getTripUpdates(
    routeIds?: string[],
  ): Promise<ReadonlyArray<DeepReadonly<ITripUpdate>>> {
    const [tripUpdates, vehicleTripUpdates] = await Promise.all([
      this.fetchRealtimeFeeds(
        this.config.rtTripUpdates,
        routeIds,
        "tripUpdates",
        async (data, url) => this.decodeTripUpdates(data, url),
      ),
      this.fetchRealtimeFeeds(
        this.config.rtVehiclePositions,
        routeIds,
        "vehiclePositions",
        (data, url) => this.tripUpdatesFromVehiclePositions(data, url),
      ),
    ])

    if (vehicleTripUpdates.length === 0) {
      return tripUpdates
    }

    // Trip updates published by the agency take precedence over our estimates
    const tripIdsWithUpdates = new Set(tripUpdates.map((u) => u.trip?.tripId))
    return [
      ...tripUpdates,
      ...vehicleTripUpdates.filter(
        (u) => !tripIdsWithUpdates.has(u.trip?.tripId),
      ),
    ]
  }

  private async fetchRealtimeFeeds<T>(
    feedConfig: GtfsConfig["rtTripUpdates"],
    routeIds: string[] | undefined,
    cacheKeyPrefix: string,
    decode: (data: Uint8Array, url: string) => Promise<T[]>,
  ): Promise<ReadonlyArray<DeepReadonly<T>>> {
    if (!feedConfig) {
      return []
    }

    let fetchConfigs: FetchConfig[] = []
    if (Array.isArray(feedConfig)) {
      fetchConfigs = feedConfig.filter((config) => {
        if (!config.routeIds || config.routeIds.length === 0) {
          return true
        }

        if (!routeIds || routeIds.length === 0) {
          return true
        }

        return config.routeIds.some((routeId) => routeIds.includes(routeId))
      })
    } else if (typeof feedConfig === "object") {
      fetchConfigs = [feedConfig]
    }

    if (fetchConfigs.length === 0) {
      return []
    }

    const minCacheAgeMs = env.duration("GTFS_RT_MIN_CACHE_AGE", -1)

    const responses = await Promise.allSettled(
      fetchConfigs.map((config) =>
        this.cache.cached(`${cacheKeyPrefix}-${config.url}`, async () => {
          this.requestsCounter.add(1, {
            feed_code: this.feedCode,
          })

          let maxAgeMs = isNaN(minCacheAgeMs) ? -1 : minCacheAgeMs

          const controller = new AbortController()
          const timeoutId = setTimeout(
            () => controller.abort("request timed out"),
            5000,
          )

          try {
            const resp = await fetch(config.url, {
              signal: controller.signal,
              headers: {
                "User-Agent":
                  "Transit Tracker API (https://transit-tracker.eastsideurbanism.org/)",
                ...(config.headers ?? {}),
              },
            })

            clearTimeout(timeoutId)

            if (!resp.ok) {
              throw new UpstreamHttpError(
                "GET",
                resp.url,
                resp.status,
                resp.statusText,
              )
            }

            const cacheControl = resp.headers.get("cache-control")
            if (cacheControl) {
              const directives = parseCacheControl(cacheControl)
              if (typeof directives["max-age"] === "number") {
                maxAgeMs = Math.max(maxAgeMs, directives["max-age"] * 1000)
              } else if (directives["no-cache"]) {
                maxAgeMs = Math.max(maxAgeMs, 0)
              }
            }

            const arrayBuffer = await resp.arrayBuffer()
            const value = await decode(new Uint8Array(arrayBuffer), config.url)

            return {
              value,
              ttl: maxAgeMs >= 0 ? maxAgeMs : ms("15s"),
            }
          } finally {
            clearTimeout(timeoutId)
          }
        }),
      ),
    )

    responses.forEach((response, index) => {
      if (response.status === "rejected") {
        this.logger.warn(
          { err: response.reason, url: fetchConfigs[index].url },
          `Failed to fetch ${cacheKeyPrefix}`,
        )

        this.failuresCounter.add(1, {
          feed_code: this.feedCode,
        })
      }
    })

    const successfulResponses = responses.filter(
      (r) => r.status === "fulfilled",
    )
    if (successfulResponses.length === 0) {
      return []
    }

    return successfulResponses.flatMap((r) => r.value)
  }

  private decodeTripUpdates(data: Uint8Array, url: string): ITripUpdate[] {
    const { tripUpdates, truncated } = decodeTripUpdatesOnly(data)

    if (truncated) {
      this.logger.warn(
        { url, entitiesRecovered: tripUpdates.length },
        "GTFS-RT response was truncated; using partially decoded trip updates",
      )
      this.partialDecodesCounter.add(1, {
        feed_code: this.feedCode,
      })
    }

    if (!this.stopIdRewrite) {
      return tripUpdates
    }

    for (const tripUpdate of tripUpdates) {
      for (const stopTimeUpdate of tripUpdate.stopTimeUpdate ?? []) {
        if (stopTimeUpdate.stopId) {
          stopTimeUpdate.stopId = this.rewriteStopId(stopTimeUpdate.stopId)
        }
      }
    }

    return tripUpdates
  }

  private async tripUpdatesFromVehiclePositions(
    data: Uint8Array,
    url: string,
  ): Promise<ITripUpdate[]> {
    const { vehiclePositions, feedTimestamp, truncated } =
      decodeVehiclePositionsOnly(data)

    if (truncated) {
      this.logger.warn(
        { url, entitiesRecovered: vehiclePositions.length },
        "GTFS-RT response was truncated; using partially decoded vehicle positions",
      )
      this.partialDecodesCounter.add(1, {
        feed_code: this.feedCode,
      })
    }

    const now = this.dateTime.now().getTime() / 1000

    const vehicles = vehiclePositions.flatMap((vehicle) => {
      const tripId = vehicle.trip?.tripId
      if (!tripId || !vehicle.stopId) {
        return []
      }

      const observedAt = Number(vehicle.timestamp || feedTimestamp || now)
      if (now - observedAt > MAX_VEHICLE_POSITION_AGE_MS / 1000) {
        return []
      }

      return [
        {
          vehicle,
          tripId,
          stopId: this.rewriteStopId(vehicle.stopId),
          observedAt,
        },
      ]
    })

    if (vehicles.length === 0) {
      return []
    }

    const stopTimes = await listVehicleStopTimes.run(
      {
        tripIds: vehicles.map((v) => v.tripId),
        stopIds: vehicles.map((v) => v.stopId),
        nowUnixTime: now,
      },
      this.db,
    )

    const stopTimesByTrip = Map.groupBy(stopTimes, (st) => st.trip_id)

    return vehicles.flatMap(({ vehicle, tripId, stopId, observedAt }) => {
      const tripUpdate = tripUpdateFromVehiclePosition(
        vehicle,
        stopId,
        stopTimesByTrip.get(tripId) ?? [],
        observedAt,
      )

      return tripUpdate ? [tripUpdate] : []
    })
  }

  private rewriteStopId(stopId: string): string {
    if (!this.stopIdRewrite) {
      return stopId
    }

    return stopId.replace(
      this.stopIdRewrite.pattern,
      this.stopIdRewrite.replacement,
    )
  }

  resolveTripTimes(
    trip: DeepReadonly<IGetScheduleForRouteAtStopResult>,
    stopTimeUpdate?: DeepReadonly<IStopTimeUpdate>,
  ) {
    const scheduledArrivalTime = new Date(trip.arrival_time)
    const scheduledDepartureTime = new Date(trip.departure_time)

    let inferredDelay = 0
    if (stopTimeUpdate) {
      const definedDelay =
        stopTimeUpdate.arrival?.delay ?? stopTimeUpdate.departure?.delay

      if (typeof definedDelay === "number") {
        inferredDelay = definedDelay
      } else {
        const hasAnyUpdate = stopTimeUpdate.arrival || stopTimeUpdate.departure
        const hasOnlyOneUpdate =
          !stopTimeUpdate.arrival || !stopTimeUpdate.departure

        if (hasAnyUpdate && hasOnlyOneUpdate) {
          // Infer delay from difference between schedule and update
          for (const key of ["arrival", "departure"] as const) {
            const time = stopTimeUpdate[key]?.time
            if (typeof time !== "number") {
              continue
            }

            inferredDelay =
              time - new Date(trip[`${key}_time`]).getTime() / 1000
          }
        }
      }
    }

    const departureTime = stopTimeUpdate?.departure?.time
      ? new Date((stopTimeUpdate.departure?.time as number) * 1000)
      : new Date(
          scheduledDepartureTime.getTime() +
            (stopTimeUpdate?.departure?.delay ?? inferredDelay) * 1000,
        )

    const arrivalTime = stopTimeUpdate?.arrival?.time
      ? new Date((stopTimeUpdate.arrival?.time as number) * 1000)
      : new Date(
          scheduledArrivalTime.getTime() +
            (stopTimeUpdate?.arrival?.delay ?? inferredDelay) * 1000,
        )

    if (arrivalTime > departureTime) {
      departureTime.setTime(arrivalTime.getTime())
    }

    const maximumDeviationFromSchedule = Math.max(
      Math.abs(departureTime.getTime() - scheduledDepartureTime.getTime()),
      Math.abs(arrivalTime.getTime() - scheduledArrivalTime.getTime()),
    )

    if (maximumDeviationFromSchedule > ms("90m")) {
      // Low confidence prediction, following Transit's guidelines:
      // https://resources.transitapp.com/article/462-trip-updates#rbest
      return {
        departureTime: scheduledDepartureTime,
        arrivalTime: scheduledArrivalTime,
        isRealtime: false,
      }
    }

    return {
      departureTime,
      arrivalTime,
      isRealtime: !!stopTimeUpdate,
    }
  }

  buildTripUpdateIndex(
    tripUpdates: ReadonlyArray<DeepReadonly<ITripUpdate>>,
  ): TripUpdateIndex {
    return Map.groupBy(
      tripUpdates.filter((u) => u.trip?.tripId),
      (u) => u.trip!.tripId!,
    )
  }

  matchTripToTripUpdate(
    trip: DeepReadonly<IGetScheduleForRouteAtStopResult>,
    tripUpdateIndex: TripUpdateIndex,
  ): {
    tripUpdate: DeepReadonly<ITripUpdate> | undefined
    stopTimeUpdate: DeepReadonly<IStopTimeUpdate> | undefined
    vehicle: string | null
  } {
    // Look up candidates from the index by exact trip ID
    let tripUpdate: DeepReadonly<ITripUpdate> | undefined
    const exactCandidates = tripUpdateIndex.get(trip.trip_id)
    if (exactCandidates) {
      tripUpdate = exactCandidates.find(
        (update) =>
          update.trip.startDate === trip.start_date || !update.trip.startDate,
      )
    }

    // Fall back to fuzzy match if enabled and no exact match found
    if (!tripUpdate && this.config.quirks?.fuzzyMatchTripUpdates) {
      for (const [tripId, candidates] of tripUpdateIndex) {
        if (trip.trip_id.includes(tripId)) {
          tripUpdate = candidates.find(
            (update) =>
              update.trip.startDate === trip.start_date ||
              !update.trip.startDate,
          )
          if (tripUpdate) break
        }
      }
    }

    let stopTimeUpdate = tripUpdate?.stopTimeUpdate?.find(
      (update) =>
        update.scheduleRelationship !==
          GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA &&
        (update.stopSequence === trip.stop_sequence ||
          update.stopId === trip.stop_id),
    )

    // If no exact match, find the latest stop update before our stop as fallback
    if (!stopTimeUpdate && tripUpdate?.stopTimeUpdate) {
      const previousStopUpdates = tripUpdate.stopTimeUpdate
        .filter(
          (update) =>
            update.scheduleRelationship !==
              GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA &&
            typeof update.stopSequence === "number" &&
            update.stopSequence < trip.stop_sequence,
        )
        .sort((a, b) => b.stopSequence! - a.stopSequence!)

      if (previousStopUpdates.length > 0) {
        const latestUpdate = previousStopUpdates[0]

        // Synthesize stop time update with only delay
        stopTimeUpdate = {
          departure: {
            delay: latestUpdate.departure?.delay,
          },
          arrival: {
            delay: latestUpdate.arrival?.delay,
          },
        }
      }
    }

    const vehicle = tripUpdate?.vehicle?.label ?? null

    return { tripUpdate, stopTimeUpdate, vehicle }
  }
}
