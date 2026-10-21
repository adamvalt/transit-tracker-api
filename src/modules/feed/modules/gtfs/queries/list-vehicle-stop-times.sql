/* @name ListVehicleStopTimes */
WITH vehicles AS (
    SELECT DISTINCT v.trip_id, v.stop_id
    FROM unnest(:tripIds!::text[], :stopIds!::text[]) AS v(trip_id, stop_id)
)
-- For each (trip, stop) a vehicle reported, fetch that stop's scheduled times
-- (and the previous stop's) for both yesterday's and today's service day
SELECT
    st.trip_id,
    st.stop_id,
    st.stop_sequence,
    s.stop_lat,
    s.stop_lon,
    to_char(sd.day, 'YYYYMMDD') AS "start_date!",
    TIMEZONE(a.agency_timezone, sd.day + st.arrival_time) AS "arrival_time!",
    TIMEZONE(a.agency_timezone, sd.day + st.departure_time) AS "departure_time!",
    prev.stop_lat AS prev_stop_lat,
    prev.stop_lon AS prev_stop_lon,
    TIMEZONE(a.agency_timezone, sd.day + prev.departure_time) AS prev_departure_time
FROM vehicles v
JOIN "trips" t ON t.trip_id = v.trip_id
-- Joining on feed_code lets these lookups use the stop_times primary key
JOIN "stop_times" st ON st.feed_code = t.feed_code AND st.trip_id = t.trip_id AND st.stop_id = v.stop_id
JOIN "stops" s ON st.stop_id = s.stop_id
JOIN "routes" r ON t.route_id = r.route_id
JOIN "agency" a ON r.agency_id = a.agency_id
CROSS JOIN LATERAL (
    SELECT DATE(TIMEZONE(a.agency_timezone, to_timestamp(:nowUnixTime!))) + d AS day
    FROM generate_series(-1, 0) AS d
) sd
LEFT JOIN LATERAL (
    SELECT st2.departure_time, s2.stop_lat, s2.stop_lon
    FROM "stop_times" st2
    JOIN "stops" s2 ON st2.stop_id = s2.stop_id
    WHERE st2.feed_code = st.feed_code
      AND st2.trip_id = st.trip_id
      AND st2.stop_sequence < st.stop_sequence
      AND st2.departure_time IS NOT NULL
    ORDER BY st2.stop_sequence DESC
    LIMIT 1
) prev ON true
WHERE st.arrival_time IS NOT NULL
AND st.departure_time IS NOT NULL;
