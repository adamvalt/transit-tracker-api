# GTFS Configuration

The Transit Tracker API supports [static GTFS feeds](https://gtfs.org/documentation/schedule/reference/) with one or more optional [GTFS-realtime Trip Updates](https://gtfs.org/documentation/realtime/feed-entities/trip-updates/) feeds to supplement the static schedule with real-time updates. For agencies that only publish [Vehicle Positions](https://gtfs.org/documentation/realtime/feed-entities/vehicle-positions/), delays can be [estimated from those instead](#gtfs-realtime-vehicle-positions).

To add a GTFS feed, add a feed to your `feeds.yaml` with a `gtfs:` section. Here is a basic example:

```yaml
feeds:
  nctd:
    name: North County Transit District
    description: San Diego, California
    gtfs:
      static: https://lfportal.nctd.org/staticGTFS/google_transit.zip
      # If your transit agency doesn't support GTFS-rt, you can omit this section
      rtTripUpdates:
        url: https://api.goswift.ly/real-time/nctd/gtfs-rt-trip-updates
        headers:
          Authorization: your_swiftly_api_key
```

You can find a full reference in the [YAML schema](../../schemas/feeds.schema.json).

## Static GTFS

### Feed Sync

It's important to keep GTFS data up-to-date as agencies make service changes. You can set up automatic synchronization of feeds by defining a `FEED_SYNC_SCHEDULE` environment variable using a [cron expression](https://en.wikipedia.org/wiki/Cron). For example, to sync all feeds once every day, set the following environment variable:

```shell
FEED_SYNC_SCHEDULE="0 0 * * *"
```

You can also manually sync feeds at any time using the CLI. If you are using the [Docker Compose deployment](../deployment/deploy-docker.md), you can run the following command:

```shell
docker compose run --rm api "node ./dist/cli sync"
```

Static feeds will not be imported unless they have changed since last import. This is determined using the `Last-Modified` or `ETag` HTTP headers, or if neither are provided by the server, a hash of the ZIP file. You can force a re-import of all feeds by adding the `--force`/`-f` flag.

```shell
docker compose run --rm api "node ./dist/cli sync -f"
```

You can also sync a specific feed by providing its feed code using the `--feed` flag. Provide multiple times to sync multiple feeds.

```shell
docker compose run --rm api "node ./dist/cli sync --feed nctd --feed septabus"
```

### ZIP-in-ZIP Feeds

Some agencies will publish their GTFS feeds as a ZIP file that contains another ZIP file inside of it. In this case, you can specify the path of the inner ZIP file in the URL hash. During import, the API will first extract the outer ZIP file, then extract the inner ZIP file for processing.

For example, SEPTA publishes both of their GTFS feeds as a single ZIP file which contains two ZIP files inside of it: one for bus (`google_bus.zip`) and one for rail (`google_rail.zip`). You can configure both feeds like this:

```yaml
feeds:
  septarail:
    name: SEPTA Rail
    description: Philadelphia, Pennsylvania, USA
    gtfs:
      static:
        url: https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip#google_rail.zip
  septabus:
    name: SEPTA Bus
    description: Philadelphia, Pennsylvania, USA
    gtfs:
      static:
        url: https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip#google_bus.zip
```

## GTFS-Realtime Trip Updates

### GTFS-RT Caching

The API will respect the [`Cache-Control` header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control) when determining how long to cache a GTFS-RT feed before fetching it again.

You can control the minimum cache duration for GTFS-RT feeds by specifying a `GTFS_RT_MIN_CACHE_AGE` environment variable. For example, to set the minimum cache duration to 30 seconds, set the following environment variable:

```shell
GTFS_RT_MIN_CACHE_AGE=30s
```

If there is no `Cache-Control` header or `GTFS_RT_MIN_CACHE_AGE` is not set, the API will default to caching GTFS-RT feeds for 15 seconds.

### Multiple GTFS-RT Feeds

Some agencies will publish updates through multiple GTFS-RT feeds, e.g. one for bus routes and another for rail routes. You can configure multiple GTFS-RT feeds by providing a list instead of a single object. The API will fetch all feeds and merge the trip updates together.

For example, Pittsburgh Regional Transit provides separate feeds for bus and rail updates:

```yaml
feeds:
  prt:
    name: Pittsburgh Regional Transit
    description: Pittsburgh, Pennsylvania, USA
    gtfs:
      static:
        url: https://www.rideprt.org/developerresources/GTFS.zip
      rtTripUpdates:
        - url: https://truetime.rideprt.org/gtfsrt-bus/trips
        - url: https://truetime.rideprt.org/gtfsrt-train/trips
```

#### Filtering by Route

Some agencies will split their GTFS-RT feeds by route ID. If you know the route IDs for each feed ahead of time, you can configure the API to only request updates for those routes by specifying a `routeIds` array for each feed. This will improve performance by only requesting the necessary GTFS-RT feeds for a given request.

For example, the NYC subway's GTFS-RT Trip Updates are split across multiple feeds by route ID:

```yaml
feeds:
  nycsubway:
    name: NYC Subway
    description: New York City, New York, USA
    gtfs:
      quirks:
        fuzzyMatchTripUpdates: true
      static:
        url: https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
      rtTripUpdates:
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace
          routeIds: ["A","C","E","H"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm
          routeIds: ["B","D","F","FX","M","FS"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g
          routeIds: ["G"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz
          routeIds: ["J","Z"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw
          routeIds: ["N","Q","R","W"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l
          routeIds: ["L"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs
          routeIds: ["1","2","3","4","5","6","6X","7","7X","GS"]
        - url: https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si
          routeIds: ["SI"]
```

## GTFS-Realtime Vehicle Positions

Some agencies don't publish Trip Updates at all, only Vehicle Positions. For example, IDS JMK (Brno, Czech Republic) publishes the position of every vehicle along with its trip and the stop it's at or heading to, but no delays. You can configure an `rtVehiclePositions` feed (in the same formats as `rtTripUpdates`) and the API will estimate each trip's delay by comparing where the vehicle is with where the schedule says it should be:

- A vehicle `STOPPED_AT` a stop is late by however long it has stayed past the scheduled departure.
- A vehicle `IN_TRANSIT_TO` a stop is compared against the scheduled time at its position, interpolated by distance between the previous stop and the next one. A vehicle that reports the next stop before the previous stop's scheduled departure (e.g. laying over at the terminus) is assumed to be on time.

The estimated delay applies to the vehicle's next stop and every stop after it. Vehicles that haven't reported for more than 5 minutes are ignored, and if a trip also has a Trip Update, the Trip Update takes precedence.

```yaml
feeds:
  idsjmk:
    name: IDS JMK
    description: Brno, Czech Republic
    gtfs:
      quirks:
        realtimeStopIdRewrite:
          pattern: "^U0*(\\d+)Z0*(\\d+)$"
          replacement: "U$1Z$2"
      static:
        url: https://kordis-jmk.cz/gtfs/gtfs.zip
      rtVehiclePositions:
        url: https://kordis-jmk.cz/gtfs/gtfsReal.dat
```

## Quirks

Even though GTFS is a standard, some agencies will have slight variations in their data that require special handling. You can enable certain "quirks" to account for these variations. Quirks are configured in the `gtfs.quirks` section of your feed configuration.

### `fuzzyMatchTripUpdates`

By default, the API will only apply GTFS-RT Trip Updates to trips that exactly match a trip ID in the static GTFS feed. However, some agencies (like NYC MTA) will use different trip IDs in their GTFS-RT feeds that don't exactly match the static feed. This is usually due to operational reasons.

If `fuzzyMatchTripUpdates` is enabled, the API will instead match Trip Updates based on a partial match of the trip ID. For example, if a Trip Update has a trip ID of `12345`, it will match a static GTFS trip with an ID of `12345-ABCD`.

### `realtimeStopIdRewrite`

Some agencies use a different format for stop IDs in their GTFS-RT feeds than in their static feed. For example, IDS JMK's realtime feed zero-pads stop IDs (`U01266Z02`) while its static feed doesn't (`U1266Z2`).

If `realtimeStopIdRewrite` is set, the API will rewrite every stop ID in Trip Updates and Vehicle Positions using a [regular expression](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/replace#specifying_a_string_as_the_replacement) before matching it against the static feed:

```yaml
quirks:
  realtimeStopIdRewrite:
    pattern: "^U0*(\\d+)Z0*(\\d+)$"
    replacement: "U$1Z$2"
```
