// The paged Scan of the nightly rebuild (ADR 0035 points 6 and 7, M3-T7).
//
// Pages with `ExclusiveStartKey` and a fixed `Limit`, eventually consistent
// (the SDK's default, no `ConsistentRead`). Keeps profiles, shelf entries,
// brews and bean `META` items, decoded through the same schemas the rest of
// the repository uses, and the existing aggregate and ranking items for the
// writer to compare. Every other item is skipped by its key prefix.
//
// A Scan is not a snapshot: a brew edited or moved during it (a `brewed_at` edit changes
// its sort key) can be seen twice (the rebuild then fails the night, closed) or missed
// for a night. Both are rare and repaired the next night, with the 3-day age limit as
// backstop.
//
// Fail closed: a page error, a throttle that exhausted the SDK's retries, or an
// item of a kept type that does not decode throws, and the caller gets nothing:
// the result is built only after the last page. The one tolerance is an old
// aggregate or ranking item that does not decode: it is kept as a key only (the
// rebuild overwrites or deletes it), because failing on it would stop the very
// run that repairs it.
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import type { AggregateItem, RebuildBrew, RebuildShelfEntry } from '../aggregation/rebuild/types.ts';
import { isCognitoSub } from '../auth/user-id.ts';
import type { Bean } from '../generated/contract.ts';
import { decodeStoredAggregate, decodeStoredRanking } from './aggregate-schemas.ts';
import type { RankingBodyValue } from './aggregate-schemas.ts';
import { CorruptItemError } from './errors.ts';
import { ExistingAggregates, keyText } from './existing-aggregates.ts';
import { PREFIX, SORT_KEY, parseAggregateSortKey, parseBeanPk, parseBrewSortKey, parseRankingPk, parseShelfSortKey } from './keys.ts';
import type { Key } from './keys.ts';
import { BeanItem, BrewItem, ProfileItem, ShelfItem, beanOf } from './repository.ts';

/** Items per Scan request (`Limit`). A page is at most 1 MB whatever this is. */
export const SCAN_PAGE_SIZE = 500;

export interface RebuildScan {
  readonly brews: readonly RebuildBrew[];
  readonly shelfEntries: readonly RebuildShelfEntry[];
  readonly beans: readonly Bean[];
  /** `consent.contribute_to_aggregates` per user that has a profile item. */
  readonly consentByUser: ReadonlyMap<string, boolean>;
  /** The aggregate and ranking items found, for `replaceAggregates`. Opaque: it answers counts and a write plan only. */
  readonly existing: ExistingAggregates;
  /** Every item the Scan returned, skipped ones included. */
  readonly itemsScanned: number;
}

/** The user id of a `USER#<sub>` partition key. Anything that is not a Cognito sub is a corrupt item (the run fails). */
function userOf(pk: string): string {
  const sub = pk.slice(PREFIX.user.length);
  if (!isCognitoSub(sub)) throw new CorruptItemError('a user partition key does not hold a user id');
  return sub;
}

function stringAttribute(item: Record<string, unknown>, name: 'pk' | 'sk'): string {
  const value = item[name];
  if (typeof value !== 'string') throw new CorruptItemError('a scanned item has no key');
  return value;
}

function decode<T extends { pk: string }>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, item: unknown, pk: string, what: string): T {
  const parsed = schema.safeParse(item);
  if (!parsed.success) throw new CorruptItemError(`a scanned ${what} does not match its schema`);
  if (parsed.data.pk !== pk) throw new CorruptItemError(`a scanned ${what} is outside its partition`);
  return parsed.data;
}

/**
 * Reads the whole table and returns what the rebuild needs. Throws on the first
 * failure; nothing is returned then.
 */
export async function scanForRebuild(client: DynamoDBDocumentClient, tableName: string, pageSize = SCAN_PAGE_SIZE): Promise<RebuildScan> {
  const brews: RebuildBrew[] = [];
  const shelfEntries: RebuildShelfEntry[] = [];
  const beans: Bean[] = [];
  const consentByUser = new Map<string, boolean>();
  const aggregates = new Map<string, { key: Key; body: AggregateItem | undefined }>();
  const rankings = new Map<string, { key: Key; body: RankingBodyValue | undefined }>();
  let itemsScanned = 0;

  let start: Record<string, unknown> | undefined;
  do {
    const input: ScanCommandInput = { TableName: tableName, Limit: pageSize, ...(start === undefined ? {} : { ExclusiveStartKey: start }) };
    const page = await client.send(new ScanCommand(input));
    for (const raw of page.Items ?? []) {
      itemsScanned += 1;
      const item: Record<string, unknown> = raw;
      const pk = stringAttribute(item, 'pk');
      const sk = stringAttribute(item, 'sk');
      if (pk.startsWith(PREFIX.user)) {
        if (sk === SORT_KEY.profile) {
          const profile = decode(ProfileItem, item, pk, 'profile');
          consentByUser.set(userOf(pk), profile.values.consent.contribute_to_aggregates);
        } else if (sk.startsWith(PREFIX.shelf)) {
          const stored = decode(ShelfItem, item, pk, 'shelf entry');
          if (parseShelfSortKey(sk) !== stored.shelfEntryId) throw new CorruptItemError('a scanned shelf entry does not match its key');
          shelfEntries.push({ userId: userOf(pk), entry: { shelf_entry_id: stored.shelfEntryId, values: stored.values } });
        } else if (sk.startsWith(PREFIX.brew)) {
          const stored = decode(BrewItem, item, pk, 'brew');
          if (parseBrewSortKey(sk)?.brewId !== stored.brewId) throw new CorruptItemError('a scanned brew does not match its key');
          brews.push({ userId: userOf(pk), brew: { brew_id: stored.brewId, values: stored.values } });
        }
        // BREWID#, RECIPE#, LOOKUPS#, PHOTO#, PHOTO_PENDING#, BEANPHOTOS#, PHOTO_UPLOADS#: skipped.
      } else if (pk.startsWith(PREFIX.bean)) {
        if (sk === SORT_KEY.beanMeta) {
          const stored = decode(BeanItem, item, pk, 'bean');
          if (parseBeanPk(pk) !== stored.beanId) throw new CorruptItemError('a scanned bean does not match its key');
          beans.push(beanOf(stored).bean);
        } else if (sk.startsWith(PREFIX.aggregate)) {
          const key = { pk, sk };
          const decoded = decodeStoredAggregate(item);
          const kind = parseAggregateSortKey(sk);
          const matches =
            decoded !== undefined &&
            kind !== undefined &&
            decoded.pk === pk &&
            decoded.sk === sk &&
            parseBeanPk(pk) === decoded.body.bean_id &&
            decoded.body.kind === kind.kind &&
            decoded.body.method === (kind.kind === 'method' ? kind.method : undefined);
          aggregates.set(keyText(key), { key, body: matches ? decoded.body : undefined });
        }
        // PHOTO#, and anything else in a bean partition: skipped.
      } else if (pk.startsWith(PREFIX.ranking)) {
        const key = { pk, sk };
        const decoded = decodeStoredRanking(item);
        const facet = parseRankingPk(pk);
        rankings.set(keyText(key), { key, body: decoded !== undefined && facet !== undefined && decoded.body.run_day === sk ? decoded.body : undefined });
      }
      // BARCODE#, DELETED# (account tombstones), counters and every other partition: skipped.
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);

  return { brews, shelfEntries, beans, consentByUser, existing: new ExistingAggregates(aggregates, rankings), itemsScanned };
}
