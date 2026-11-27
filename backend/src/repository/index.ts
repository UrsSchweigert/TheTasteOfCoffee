// The repository module: the one place that knows the table's key formats
// (docs/05-system-design.md, Data model; ADR 0010) and talks to DynamoDB.
export * from './errors.ts';
export * from './keys.ts';
export { decodeCursor, encodeCursor } from './cursor.ts';
export {
  BATCH_WRITE_ATTEMPTS,
  BATCH_WRITE_CONCURRENCY,
  BATCH_WRITE_SIZE,
  ITEM_TYPE,
  LABEL_PHOTOS_PER_BEAN,
  LOOKUP_COUNTER_TTL_SECONDS,
  OPEN_FOOD_FACTS_MISS_TTL_SECONDS,
  PENDING_LABEL_PHOTO_TTL_SECONDS,
  Repository,
  TOMBSTONE_TTL_SECONDS,
} from './repository.ts';
export type { AccountPhotos, AccountTombstone, ExportItems, LabelPhoto } from './repository.ts';
export type { BeanRecord, BeanStatus, ListOptions, NewBean, OpenFoodFactsCacheEntry, Page, PendingLabelPhoto, RepositoryOptions } from './repository.ts';
export { REVIEW_QUEUE_INDEX, STREAM_VIEW_TYPE, TABLE_ATTRIBUTES, tableKeySchema } from './table.ts';
export type { TableKeySchema } from './table.ts';
export { AggregateRepository } from './aggregate-repository.ts';
export type { AggregateRepositoryOptions } from './aggregate-repository.ts';
export type { AggregateRead, CriterionFigures, ServedAggregate } from './aggregate-read.ts';
export { AGGREGATE_BATCH_ATTEMPTS, AGGREGATE_BATCH_CONCURRENCY, AGGREGATE_BATCH_SIZE } from './aggregate-write.ts';
export type { WriteReport } from './aggregate-write.ts';
export { SCAN_PAGE_SIZE } from './scan.ts';
export type { RebuildScan } from './scan.ts';
export type { ExistingAggregates } from './existing-aggregates.ts';
