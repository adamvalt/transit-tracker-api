import { transit_realtime as GtfsRt } from "gtfs-realtime-bindings"
import protobuf from "protobufjs/minimal"

type ITripUpdate = GtfsRt.ITripUpdate
type IVehiclePosition = GtfsRt.IVehiclePosition

// Field numbers from gtfs-realtime.proto
// https://github.com/google/transit/blob/master/gtfs-realtime/proto/gtfs-realtime.proto
const FEED_MESSAGE_HEADER = 1 // FeedMessage.header
const FEED_MESSAGE_ENTITY = 2 // FeedMessage.entity
const FEED_ENTITY_TRIP_UPDATE = 3 // FeedEntity.trip_update
const FEED_ENTITY_VEHICLE = 4 // FeedEntity.vehicle

export interface DecodeTripUpdatesResult {
  tripUpdates: ITripUpdate[]
  truncated: boolean
}

export interface DecodeVehiclePositionsResult {
  vehiclePositions: IVehiclePosition[]
  /** FeedHeader.timestamp, if present */
  feedTimestamp: number | null
  truncated: boolean
}

interface DecodeEntitiesResult<T> {
  entities: T[]
  feedTimestamp: number | null
  truncated: boolean
}

/**
 * Selectively decodes only TripUpdate entities from a GTFS-RT FeedMessage,
 * skipping VehiclePosition and Alert entities at the wire format level to
 * avoid unnecessary deserialization.
 */
export function decodeTripUpdatesOnly(
  data: Uint8Array,
): DecodeTripUpdatesResult {
  const { entities, truncated } = decodeEntitiesOnly(
    data,
    FEED_ENTITY_TRIP_UPDATE,
    (reader, length) =>
      GtfsRt.TripUpdate.toObject(GtfsRt.TripUpdate.decode(reader, length), {
        longs: Number,
      }) as ITripUpdate,
  )

  return { tripUpdates: entities, truncated }
}

/**
 * Selectively decodes only VehiclePosition entities from a GTFS-RT
 * FeedMessage, skipping TripUpdate and Alert entities at the wire format level.
 */
export function decodeVehiclePositionsOnly(
  data: Uint8Array,
): DecodeVehiclePositionsResult {
  const { entities, feedTimestamp, truncated } = decodeEntitiesOnly(
    data,
    FEED_ENTITY_VEHICLE,
    (reader, length) =>
      GtfsRt.VehiclePosition.toObject(
        GtfsRt.VehiclePosition.decode(reader, length),
        { longs: Number },
      ) as IVehiclePosition,
  )

  return { vehiclePositions: entities, feedTimestamp, truncated }
}

function decodeEntitiesOnly<T>(
  data: Uint8Array,
  entityFieldNumber: number,
  decode: (reader: protobuf.Reader, length: number) => T,
): DecodeEntitiesResult<T> {
  const reader = protobuf.Reader.create(data)
  const end = reader.len
  const entities: T[] = []
  let feedTimestamp: number | null = null
  let truncated = false

  while (reader.pos < end) {
    const fieldStart = reader.pos

    try {
      const tag = reader.uint32()
      const fieldNumber = tag >>> 3
      const wireType = tag & 7

      switch (fieldNumber) {
        case FEED_MESSAGE_HEADER: {
          const header = GtfsRt.FeedHeader.decode(reader, reader.uint32())
          if (header.timestamp) {
            feedTimestamp = Number(header.timestamp)
          }
          break
        }
        case FEED_MESSAGE_ENTITY: {
          const entityLength = reader.uint32()
          const entityEnd = reader.pos + entityLength
          if (entityEnd > end) {
            throw new RangeError("entity length runs past end of buffer")
          }
          const entity = decodeEntityField(
            reader,
            entityEnd,
            entityFieldNumber,
            decode,
          )
          if (entity) {
            entities.push(entity)
          }
          // Ensure we're at the end of this entity even if decoding stopped early
          reader.pos = entityEnd
          break
        }
        default:
          // Skip unknown fields
          reader.skipType(wireType)
          break
      }
    } catch (err) {
      if (!(err instanceof RangeError)) {
        throw err
      }
      // The buffer ended mid-field. Everything decoded before fieldStart
      // is still complete, valid data, so stop here and use that.
      reader.pos = fieldStart
      truncated = true
      break
    }
  }

  return { entities, feedTimestamp, truncated }
}

function decodeEntityField<T>(
  reader: protobuf.Reader,
  end: number,
  entityFieldNumber: number,
  decode: (reader: protobuf.Reader, length: number) => T,
): T | null {
  let entity: T | null = null

  while (reader.pos < end) {
    const tag = reader.uint32()
    const fieldNumber = tag >>> 3
    const wireType = tag & 7

    if (fieldNumber === entityFieldNumber) {
      entity = decode(reader, reader.uint32())
    } else {
      // Skip id (1), is_deleted (2), the other entity types, and unknowns
      reader.skipType(wireType)
    }
  }

  return entity
}
