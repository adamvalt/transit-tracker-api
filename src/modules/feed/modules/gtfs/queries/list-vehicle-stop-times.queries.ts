/** Types generated for queries found in "src/modules/feed/modules/gtfs/queries/list-vehicle-stop-times.sql" */
import { PreparedQuery } from "@pgtyped/runtime"

export type stringArray = string[]

/** 'ListVehicleStopTimes' parameters type */
export interface IListVehicleStopTimesParams {
  nowUnixTime: number
  stopIds: stringArray
  tripIds: stringArray
}

/** 'ListVehicleStopTimes' return type */
export interface IListVehicleStopTimesResult {
  arrival_time: Date
  departure_time: Date
  prev_departure_time: Date | null
  prev_stop_lat: number | null
  prev_stop_lon: number | null
  start_date: string
  stop_id: string
  stop_lat: number | null
  stop_lon: number | null
  stop_sequence: number
  trip_id: string
}

/** 'ListVehicleStopTimes' query type */
export interface IListVehicleStopTimesQuery {
  params: IListVehicleStopTimesParams
  result: IListVehicleStopTimesResult
}

const listVehicleStopTimesIR: any = {
  usedParamSet: { tripIds: true, stopIds: true, nowUnixTime: true },
  params: [
    {
      name: "tripIds",
      required: true,
      transform: { type: "scalar" },
      locs: [{ a: 76, b: 84 }],
    },
    {
      name: "stopIds",
      required: true,
      transform: { type: "scalar" },
      locs: [{ a: 95, b: 103 }],
    },
    {
      name: "nowUnixTime",
      required: true,
      transform: { type: "scalar" },
      locs: [{ a: 1194, b: 1206 }],
    },
  ],
  statement:
    'WITH vehicles AS (\n    SELECT DISTINCT v.trip_id, v.stop_id\n    FROM unnest(:tripIds!::text[], :stopIds!::text[]) AS v(trip_id, stop_id)\n)\n-- For each (trip, stop) a vehicle reported, fetch that stop\'s scheduled times\n-- (and the previous stop\'s) for both yesterday\'s and today\'s service day\nSELECT\n    st.trip_id,\n    st.stop_id,\n    st.stop_sequence,\n    s.stop_lat,\n    s.stop_lon,\n    to_char(sd.day, \'YYYYMMDD\') AS "start_date!",\n    TIMEZONE(a.agency_timezone, sd.day + st.arrival_time) AS "arrival_time!",\n    TIMEZONE(a.agency_timezone, sd.day + st.departure_time) AS "departure_time!",\n    prev.stop_lat AS prev_stop_lat,\n    prev.stop_lon AS prev_stop_lon,\n    TIMEZONE(a.agency_timezone, sd.day + prev.departure_time) AS prev_departure_time\nFROM vehicles v\nJOIN "trips" t ON t.trip_id = v.trip_id\n-- Joining on feed_code lets these lookups use the stop_times primary key\nJOIN "stop_times" st ON st.feed_code = t.feed_code AND st.trip_id = t.trip_id AND st.stop_id = v.stop_id\nJOIN "stops" s ON st.stop_id = s.stop_id\nJOIN "routes" r ON t.route_id = r.route_id\nJOIN "agency" a ON r.agency_id = a.agency_id\nCROSS JOIN LATERAL (\n    SELECT DATE(TIMEZONE(a.agency_timezone, to_timestamp(:nowUnixTime!))) + d AS day\n    FROM generate_series(-1, 0) AS d\n) sd\nLEFT JOIN LATERAL (\n    SELECT st2.departure_time, s2.stop_lat, s2.stop_lon\n    FROM "stop_times" st2\n    JOIN "stops" s2 ON st2.stop_id = s2.stop_id\n    WHERE st2.feed_code = st.feed_code\n      AND st2.trip_id = st.trip_id\n      AND st2.stop_sequence < st.stop_sequence\n      AND st2.departure_time IS NOT NULL\n    ORDER BY st2.stop_sequence DESC\n    LIMIT 1\n) prev ON true\nWHERE st.arrival_time IS NOT NULL\nAND st.departure_time IS NOT NULL',
}

/**
 * Query generated from SQL:
 * ```
 * WITH vehicles AS (
 *     SELECT DISTINCT v.trip_id, v.stop_id
 *     FROM unnest(:tripIds!::text[], :stopIds!::text[]) AS v(trip_id, stop_id)
 * )
 * -- For each (trip, stop) a vehicle reported, fetch that stop's scheduled times
 * -- (and the previous stop's) for both yesterday's and today's service day
 * SELECT
 *     st.trip_id,
 *     st.stop_id,
 *     st.stop_sequence,
 *     s.stop_lat,
 *     s.stop_lon,
 *     to_char(sd.day, 'YYYYMMDD') AS "start_date!",
 *     TIMEZONE(a.agency_timezone, sd.day + st.arrival_time) AS "arrival_time!",
 *     TIMEZONE(a.agency_timezone, sd.day + st.departure_time) AS "departure_time!",
 *     prev.stop_lat AS prev_stop_lat,
 *     prev.stop_lon AS prev_stop_lon,
 *     TIMEZONE(a.agency_timezone, sd.day + prev.departure_time) AS prev_departure_time
 * FROM vehicles v
 * JOIN "trips" t ON t.trip_id = v.trip_id
 * -- Joining on feed_code lets these lookups use the stop_times primary key
 * JOIN "stop_times" st ON st.feed_code = t.feed_code AND st.trip_id = t.trip_id AND st.stop_id = v.stop_id
 * JOIN "stops" s ON st.stop_id = s.stop_id
 * JOIN "routes" r ON t.route_id = r.route_id
 * JOIN "agency" a ON r.agency_id = a.agency_id
 * CROSS JOIN LATERAL (
 *     SELECT DATE(TIMEZONE(a.agency_timezone, to_timestamp(:nowUnixTime!))) + d AS day
 *     FROM generate_series(-1, 0) AS d
 * ) sd
 * LEFT JOIN LATERAL (
 *     SELECT st2.departure_time, s2.stop_lat, s2.stop_lon
 *     FROM "stop_times" st2
 *     JOIN "stops" s2 ON st2.stop_id = s2.stop_id
 *     WHERE st2.feed_code = st.feed_code
 *       AND st2.trip_id = st.trip_id
 *       AND st2.stop_sequence < st.stop_sequence
 *       AND st2.departure_time IS NOT NULL
 *     ORDER BY st2.stop_sequence DESC
 *     LIMIT 1
 * ) prev ON true
 * WHERE st.arrival_time IS NOT NULL
 * AND st.departure_time IS NOT NULL
 * ```
 */
export const listVehicleStopTimes = new PreparedQuery<
  IListVehicleStopTimesParams,
  IListVehicleStopTimesResult
>(listVehicleStopTimesIR)
