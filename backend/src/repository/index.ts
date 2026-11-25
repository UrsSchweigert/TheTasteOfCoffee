// The repository module: the one place that knows the table's key formats
// (docs/05-system-design.md, Data model; ADR 0010) and talks to DynamoDB.
export * from './errors.ts';
export * from './keys.ts';
export { decodeCursor, encodeCursor } from './cursor.ts';
export { ITEM_TYPE, LOOKUP_COUNTER_TTL_SECONDS, OPEN_FOOD_FACTS_MISS_TTL_SECONDS, Repository } from './repository.ts';
export type { BeanRecord, BeanStatus, ListOptions, NewBean, OpenFoodFactsCacheEntry, Page, RepositoryOptions } from './repository.ts';
export { REVIEW_QUEUE_INDEX, STREAM_VIEW_TYPE, TABLE_ATTRIBUTES, tableKeySchema } from './table.ts';
export type { TableKeySchema } from './table.ts';
