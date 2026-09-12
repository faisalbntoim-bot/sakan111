/**
 * Internal Event Tracking v1 — event name whitelist.
 *
 * Snake-cased, product-oriented names. All UserEvent rows written by
 * `event-tracking-service.ts` and `POST /v1/events` MUST use one of
 * these strings — arbitrary event strings are rejected at the route
 * boundary.
 *
 * The legacy recommendation module continues to use SCREAMING_SNAKE
 * names (see `recommendation/events.ts`) — both live in the same
 * `UserEvent.eventType` column and each consumer filters by its own
 * known set, so the two vocabularies coexist without collision.
 */

export const TRACKABLE_EVENTS = [
  'property_view',
  'property_save',
  'property_unsave',
  'property_share',
  'property_contact',
  'property_call',
  'property_whatsapp',
  'property_open_gallery',
  'property_open_map',
  'property_open_tour',
  'property_hide',
  'property_report',
  'search',
  'filter_change',
  'feed_impression',
  'feed_click',
] as const;

export type TrackableEvent = typeof TRACKABLE_EVENTS[number];

export function isTrackableEvent(v: unknown): v is TrackableEvent {
  return typeof v === 'string' && (TRACKABLE_EVENTS as readonly string[]).includes(v);
}

/** Hard limits enforced at ingestion. */
export const EVENT_LIMITS = {
  metadataBytesMax: 4 * 1024,   // 4 KB serialized
  searchQueryMax: 200,          // chars
  sessionIdMax: 128,            // chars
  cityMax: 80,
  districtMax: 120,
  propertyTypeMax: 40,
  listingTypeMax: 40,
  propertyIdMax: 40,
} as const;

/**
 * Whitelist of scalar/array-of-scalar metadata keys we accept from
 * clients. Anything else is dropped at the sanitizer boundary before
 * the row reaches the database.
 */
export const METADATA_ALLOWED_KEYS = [
  'source',        // 'feed' | 'search' | 'saved' | 'market' | 'admin' …
  'position',      // impression slot / feed index (int)
  'query',         // <= 200 chars — echoed search phrase for filter_change
  'filters',       // shallow object of scalars only
  'listingType',   // sale | rent | daily …
  'from',          // route or screen the event fired from
  'referrer',      // opaque referrer id
  'durationMs',    // number
] as const;

export type MetadataKey = typeof METADATA_ALLOWED_KEYS[number];
