// A seeded history at the size of M3-T10, as an EVENT STREAM (creates, edits,
// deletes, consent flips) and as the table items it leaves behind. The stream
// is grouped in lanes (one per brew, one per user's consent) so that it can be
// replayed in another interleaving that keeps each lane's own order: the final
// table must not depend on which lane runs first.
//
// The person-level shapes come from the generators of the rebuild property
// tests (test/aggregation/support/histories.ts): parameters, ratings, beans.
// This file adds the scale, the stored-item shapes with valid ids, and the
// event stream. Test code only.
import type { RebuildBrew, RebuildInput, RebuildShelfEntry } from '../../src/aggregation/rebuild/types.ts';
import { PriceBandSchema } from '../../src/generated/contract.ts';
import type { Bean, Brew, ShelfEntry } from '../../src/generated/contract.ts';
import { genBeans, parametersOf, ratingOf, score } from '../aggregation/support/histories.ts';
import { Rng } from '../aggregation/support/rng.ts';
import { verifiedUserId } from '../events.ts';
import { RUN_MS, beanItem, profileItem, sub, ulid } from '../repository/aggregate-fixtures.ts';
import type { FakeTable, Item } from '../repository/fake-table.ts';
import { beanMetaKey, brewKey, shelfEntryKey } from '../../src/repository/index.ts';

export { RUN_MS };

/** The size of M3-T10. */
export const USERS = 200;
export const BEANS = 300;
export const BREWS_CREATED = 20_000;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const HISTORY_DAYS = 40;

export type BrewValues = Brew['values'];

export type HistoryEvent =
  | { readonly kind: 'create'; readonly lane: string; readonly user: string; readonly brewId: string; readonly values: BrewValues }
  | { readonly kind: 'edit'; readonly lane: string; readonly brewId: string; readonly values: BrewValues }
  | { readonly kind: 'delete'; readonly lane: string; readonly brewId: string }
  | { readonly kind: 'consent'; readonly lane: string; readonly user: string; readonly value: boolean };

export interface History {
  readonly events: readonly HistoryEvent[];
  /** Shelf entries and beans: loaded before the stream, never changed by it. */
  readonly shelfEntries: readonly RebuildShelfEntry[];
  readonly beans: readonly Bean[];
  /** Counts of what the stream contains, for the report. */
  readonly counts: { readonly creates: number; readonly edits: number; readonly deletes: number; readonly consentEvents: number; readonly flippedUsers: number };
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

export function generateHistory(seed: number): History {
  const rng = new Rng(seed);
  const users = Array.from({ length: USERS }, (_, i) => sub(i + 1));
  const beanIds = Array.from({ length: BEANS }, (_, i) => ulid(i + 1));
  const beans = genBeans(rng, beanIds, 0.85);
  // Popular beans first, so that many beans reach 5 raters and many do not.
  const popularBean = (): string => beanIds[Math.floor(rng.next() ** 3 * BEANS)] ?? ulid(1);

  const events: HistoryEvent[] = [];
  const shelfEntries: RebuildShelfEntry[] = [];
  let entryNumber = 0;
  let brewNumber = 0;
  let edits = 0;
  let deletes = 0;
  let flippedUsers = 0;
  const bands = PriceBandSchema.options;
  const bags = ['g_250', 'g_250', 'g_500', 'g_1000'] as const;
  // Brews per user: random weights scaled so that the total is exactly BREWS_CREATED.
  const weights = users.map(() => 0.5 + rng.next());
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let cumulative = 0;
  const counts = weights.map((w) => {
    const before = Math.round((cumulative * BREWS_CREATED) / totalWeight);
    cumulative += w;
    return Math.round((cumulative * BREWS_CREATED) / totalWeight) - before;
  });

  users.forEach((user, userIndex) => {
    // Consent: most say yes, some no, some have no profile at all; some flip one or more times.
    const initial = rng.next();
    if (initial < 0.8) events.push({ kind: 'consent', lane: `consent:${user}`, user, value: true });
    else if (initial < 0.9) events.push({ kind: 'consent', lane: `consent:${user}`, user, value: false });
    if (initial < 0.9 && rng.chance(0.2)) {
      flippedUsers += 1;
      let value = initial < 0.8;
      for (let flips = rng.int(1, 3); flips > 0; flips -= 1) {
        value = !value;
        events.push({ kind: 'consent', lane: `consent:${user}`, user, value });
      }
    }

    // Shelf entries, each with a start day inside the history.
    const style = rng.pick(['normal', 'normal', 'normal', 'normal', 'heavy', 'burst', 'liner', 'dosing'] as const);
    const entries: { entry: ShelfEntry; startMs: number }[] = Array.from({ length: rng.int(2, 5) }, () => {
      entryNumber += 1;
      const startMs = RUN_MS - rng.int(2, HISTORY_DAYS) * DAY_MS;
      const roastMs = startMs + rng.int(-2, 2) * DAY_MS;
      const entry: ShelfEntry = {
        shelf_entry_id: ulid(1000 + entryNumber),
        values: {
          vocabulary_version: 3,
          bean_id: popularBean(),
          purchase_date: isoOf(startMs).slice(0, 10),
          ...(rng.chance(0.4) ? { roast_date: isoOf(roastMs).slice(0, 10) } : {}),
          ...(rng.chance(0.55) ? { bag_size: rng.pick(bags) } : {}),
          ...(rng.chance(0.55) ? { price_band: rng.chance(0.8) ? rng.pick(bands.slice(0, 2)) : rng.pick(bands) } : {}),
        },
      };
      shelfEntries.push({ userId: user, entry });
      return { entry, startMs };
    });

    const liner = style === 'liner' ? score(rng) : undefined;
    const mode = style === 'dosing' ? 'wild' : 'clean';
    const count = counts[userIndex] ?? 0;
    let heavyDay = 0;
    for (let made = 0; made < count; made += 1) {
      const picked = rng.pick(entries);
      const orphan = rng.chance(0.005);
      let at: number;
      if (style === 'heavy' && rng.chance(0.4)) {
        // Many cups of one bean on one day: past the daily cap.
        heavyDay = heavyDay === 0 ? Date.UTC(2026, 10, 27) - rng.int(1, 20) * DAY_MS : heavyDay;
        at = heavyDay + rng.int(8 * 60, 20 * 60) * MINUTE_MS + (made % 7) * MINUTE_MS;
      } else if (style === 'burst' && made % 25 < 7) {
        // Seven cups, four seconds apart: more than 5 within a minute.
        const first = entries[0] ?? picked;
        at = first.startMs + (Math.floor(made / 25) % 15) * DAY_MS + 9 * 60 * MINUTE_MS + (made % 25) * 4_000;
      } else if (rng.chance(0.01)) {
        // In the future: past the 5 minute skew.
        at = RUN_MS + rng.int(6, 600) * MINUTE_MS;
      } else if (rng.chance(0.04)) {
        at = picked.startMs - rng.int(1, 3) * DAY_MS + rng.int(0, DAY_MS - 1);
      } else {
        at = picked.startMs + rng.int(0, Math.max(1, RUN_MS - picked.startMs - 1));
      }
      brewNumber += 1;
      const brewId = ulid(3000 + brewNumber);
      const rated = !rng.chance(0.08);
      const shelfEntryId = orphan ? ulid(2000) : picked.entry.shelf_entry_id;
      const values: BrewValues = {
        vocabulary_version: 3,
        shelf_entry_id: shelfEntryId,
        brewed_at: isoOf(at),
        parameters: parametersOf(rng, mode),
        ...(rated ? { rating: ratingOf(rng, liner) } : {}),
      };
      const lane = `brew:${brewId}`;
      events.push({ kind: 'create', lane, user, brewId, values });
      if (rng.chance(0.08)) {
        for (let n = rng.int(1, 2); n > 0; n -= 1) {
          edits += 1;
          const moved = rng.chance(0.3);
          const rerated = rng.chance(0.6);
          const current = values;
          events.push({
            kind: 'edit',
            lane,
            brewId,
            values: {
              ...current,
              brewed_at: moved ? isoOf(Math.min(RUN_MS, at + rng.int(-3, 3) * DAY_MS + rng.int(0, 3600) * 1000)) : current.brewed_at,
              parameters: rerated ? current.parameters : parametersOf(rng, mode),
              ...(rerated && !rng.chance(0.1) ? { rating: ratingOf(rng, liner) } : {}),
            },
          });
        }
      }
      if (rng.chance(0.02)) {
        deletes += 1;
        events.push({ kind: 'delete', lane, brewId });
      }
    }
  });

  return { events, shelfEntries, beans, counts: { creates: brewNumber, edits, deletes, consentEvents: events.filter((e) => e.kind === 'consent').length, flippedUsers } };
}

// ---- the table side ----

function brewStored(user: string, brewId: string, beanId: string, values: BrewValues): Item {
  return { ...brewKey(verifiedUserId(user), values.brewed_at, brewId), type: 'BREW', brewId, shelfEntryId: values.shelf_entry_id, beanId, values };
}

/** The items the stream does not change: shelf entries and bean `META` items. */
export function baseItems(history: History): Item[] {
  const items: Item[] = history.shelfEntries.map(({ userId, entry }) => ({
    ...shelfEntryKey(verifiedUserId(userId), entry.shelf_entry_id),
    type: 'SHELF',
    shelfEntryId: entry.shelf_entry_id,
    beanId: entry.values.bean_id,
    values: entry.values,
  }));
  for (const bean of history.beans) {
    items.push({
      ...beanItem(bean.bean_id),
      ...beanMetaKey(bean.bean_id),
      status: bean.verified ? 'verified' : 'unverified',
      vocabularyVersion: bean.vocabulary_version,
      pickedAttributes: bean.picked_attributes,
      operatorAttributes: bean.operator_attributes,
    });
  }
  return items;
}

/** Applies the events in the given order to a table that already holds the base items. */
export function applyEvents(table: FakeTable, history: History, events: readonly HistoryEvent[]): void {
  const beanOfEntry = new Map(history.shelfEntries.map(({ entry }) => [entry.shelf_entry_id, entry.values.bean_id]));
  const current = new Map<string, { user: string; pk: string; sk: string }>();
  for (const event of events) {
    if (event.kind === 'consent') {
      table.put(profileItem(event.user, event.value));
      continue;
    }
    const old = current.get(event.brewId);
    if (old !== undefined) {
      table.remove(old.pk, old.sk);
      current.delete(event.brewId);
    }
    if (event.kind === 'delete') {
      if (old === undefined) throw new Error('delete before create in a replay');
      continue;
    }
    const user = event.kind === 'create' ? event.user : old?.user;
    if (user === undefined) throw new Error('edit before create in a replay');
    const stored = brewStored(user, event.brewId, beanOfEntry.get(event.values.shelf_entry_id) ?? ulid(1), event.values);
    table.put(stored);
    current.set(event.brewId, { user, pk: String(stored.pk), sk: String(stored.sk) });
  }
}

/** The history in a different order: lanes interleaved at random, each lane in its own order. */
export function interleaved(events: readonly HistoryEvent[], seed: number): HistoryEvent[] {
  const rng = new Rng(seed);
  const lanes = new Map<string, HistoryEvent[]>();
  for (const event of events) lanes.set(event.lane, [...(lanes.get(event.lane) ?? []), event]);
  const open = rng.shuffle([...lanes.values()]).map((list) => [...list].reverse());
  const out: HistoryEvent[] = [];
  while (open.length > 0) {
    const index = rng.int(0, open.length - 1);
    const lane = open[index];
    const event = lane?.pop();
    if (event !== undefined) out.push(event);
    if (lane?.length === 0) open.splice(index, 1);
  }
  return out;
}

/** The state the stream leaves, as the rebuild core's input (the oracle's input): folded without a table. */
export function finalInput(history: History): RebuildInput {
  const brews = new Map<string, RebuildBrew>();
  const consentByUser = new Map<string, boolean>();
  for (const event of history.events) {
    if (event.kind === 'consent') consentByUser.set(event.user, event.value);
    else if (event.kind === 'delete') brews.delete(event.brewId);
    else {
      const user = event.kind === 'create' ? event.user : brews.get(event.brewId)?.userId;
      if (user === undefined) throw new Error('edit before create');
      brews.set(event.brewId, { userId: user, brew: { brew_id: event.brewId, values: event.values } });
    }
  }
  return { brews: [...brews.values()], shelfEntries: history.shelfEntries, beans: history.beans, consentByUser, runTimeMs: RUN_MS };
}
