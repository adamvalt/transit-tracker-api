import { z } from "zod"

export const FetchConfigSchema = z.strictObject({
  url: z.string(),
  headers: z.record(z.string()).optional(),
})

export const FetchConfigOrUrlSchema = z.union([
  FetchConfigSchema,
  z.string().transform((url) => ({ url, headers: {} })),
])

export const RouteIdFilteredFetchConfigSchema = FetchConfigSchema.extend({
  routeIds: z.array(z.string()).optional(),
})

const RealtimeFeedConfigSchema = z
  .union([FetchConfigOrUrlSchema, z.array(RouteIdFilteredFetchConfigSchema)])
  .optional()

export const StopIdRewriteSchema = z.strictObject({
  pattern: z.string().refine(
    (pattern) => {
      try {
        new RegExp(pattern)
        return true
      } catch {
        return false
      }
    },
    { message: "Invalid regular expression" },
  ),
  replacement: z.string(),
})

export const GtfsConfigSchema = z.strictObject({
  quirks: z
    .object({
      fuzzyMatchTripUpdates: z.boolean().optional(),
      realtimeStopIdRewrite: StopIdRewriteSchema.optional(),
    })
    .optional(),
  static: FetchConfigOrUrlSchema,
  rtTripUpdates: RealtimeFeedConfigSchema,
  rtVehiclePositions: RealtimeFeedConfigSchema,
})

export type FetchConfig = z.infer<typeof FetchConfigSchema>
export type StopIdRewrite = z.infer<typeof StopIdRewriteSchema>
export type GtfsConfig = z.infer<typeof GtfsConfigSchema>
