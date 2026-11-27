// Seeded random histories for the rebuild property tests (M3-T6): users, shelf
// entries, brews, beans and consent as the repository would hand them to the
// core. "wild" histories aim at every plausibility rule (bursts, future brews,
// before roast, big doses, straight-liners, heavy days over the cap, orphans);
// "clean" histories keep every cross-brew rule out of the way, so the daily cap
// and the weights can be compared with a simple history.
import type { Bean, Brew, BrewParameters, FlavourNote, IntensityLevel, Rating, Scores, ShelfEntry } from '../../../src/generated/contract.ts';
import { FlavourNoteSchema, IntensityLevelSchema, MethodSchema, OriginSchema, PriceBandSchema, ProcessSchema, RoastLevelSchema } from '../../../src/generated/contract.ts';
import type { RebuildBrew, RebuildInput, RebuildShelfEntry } from '../../../src/aggregation/rebuild/types.ts';
import type { Rng } from './rng.ts';

export const RUN_MS = Date.UTC(2026, 10, 27, 12, 0, 0);
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export type Mode = 'wild' | 'clean';

export function scoresOf(value: (criterion: keyof Scores) => number): Scores {
  return {
    aroma: value('aroma'),
    flavour: value('flavour'),
    aftertaste: value('aftertaste'),
    acidity: value('acidity'),
    body: value('body'),
    sweetness: value('sweetness'),
    balance: value('balance'),
    overall: value('overall'),
  };
}

/** A score in points, 1 to 10 in half steps. */
const score = (rng: Rng): number => rng.int(2, 20) / 2;

function parametersOf(rng: Rng, mode: Mode): BrewParameters {
  const method = rng.pick(MethodSchema.options);
  const parameters: { -readonly [K in keyof BrewParameters]: BrewParameters[K] } = { method };
  const doseChance = mode === 'clean' ? 0 : 0.5;
  let dose: number | undefined;
  if (rng.chance(doseChance)) {
    dose = rng.chance(0.3) ? rng.int(500, 1000) : rng.int(50, 400);
    parameters.dose_dg = dose;
  }
  if (rng.chance(0.55)) {
    const ratio = rng.int(1, 25);
    parameters.water_g = dose === undefined ? rng.int(10, 1500) : Math.min(1500, Math.max(10, Math.round((dose / 10) * ratio)));
  } else if (dose === undefined && rng.chance(0.3)) {
    parameters.water_g = rng.int(10, 1500);
  }
  if (rng.chance(0.4)) parameters.water_temp_c = rng.int(80, 100);
  else if (rng.chance(0.05)) parameters.water_temp_special = 'cold';
  if (rng.chance(0.4)) parameters.brew_time_s = rng.chance(0.05) ? rng.int(1, 172_800) : rng.int(1, 700);
  if (rng.chance(0.4)) parameters.grind_normalised = rng.int(2, 20) / 2;
  return parameters;
}

function ratingOf(rng: Rng, single: number | undefined, next: () => number = () => score(rng)): Rating {
  const value = (): number => single ?? next();
  const rating: { -readonly [K in keyof Rating]: Rating[K] } = { scores: scoresOf(value) };
  const intensities: { acidity?: IntensityLevel; body?: IntensityLevel; bitterness?: IntensityLevel } = {};
  for (const dimension of ['acidity', 'body', 'bitterness'] as const) if (rng.chance(0.3)) intensities[dimension] = rng.pick(IntensityLevelSchema.options);
  if (Object.keys(intensities).length > 0) rating.intensities = intensities;
  if (rng.chance(0.4)) {
    const notes: FlavourNote[] = rng.shuffle(FlavourNoteSchema.options).slice(0, rng.int(1, 5));
    rating.flavour_notes = notes;
  }
  if (rng.chance(0.4)) rating.buy_again = rng.chance(0.6);
  return rating;
}

const dayString = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function genBeans(rng: Rng, beanIds: readonly string[], present: number): Bean[] {
  const beans: Bean[] = [];
  for (const id of beanIds) {
    if (!rng.chance(present)) continue;
    beans.push({
      bean_id: id,
      vocabulary_version: 3,
      verified: rng.chance(0.6),
      open_food_facts_match: false,
      picked_attributes: {},
      operator_attributes: {
        ...(rng.chance(0.6) ? { process: rng.pick(ProcessSchema.options) } : {}),
        ...(rng.chance(0.6) ? { roast_level: rng.pick(RoastLevelSchema.options) } : {}),
        ...(rng.chance(0.6) ? { origin: rng.pick(OriginSchema.options) } : {}),
      },
    });
  }
  return beans;
}

export function genHistory(rng: Rng, mode: Mode = 'wild'): RebuildInput {
  const wild = mode === 'wild';
  const userCount = rng.int(3, 12);
  const beanCount = rng.int(1, 3);
  const users = Array.from({ length: userCount }, (_, i) => `usr${String(i)}x${rng.hex(8)}`);
  const beanIds = Array.from({ length: beanCount }, (_, i) => `bean${String(i)}`);

  const consentByUser = new Map<string, boolean>();
  for (const user of users) {
    if (!wild) consentByUser.set(user, rng.chance(0.9));
    else if (rng.chance(0.85)) consentByUser.set(user, true);
    else if (rng.chance(0.55)) consentByUser.set(user, false);
  }

  const beans = genBeans(rng, beanIds, 0.85);

  const shelfEntries: RebuildShelfEntry[] = [];
  const brews: RebuildBrew[] = [];
  let brewNumber = 0;
  const bands = PriceBandSchema.options;
  const bags = ['g_250', 'g_250', 'g_500', 'g_1000'] as const;

  users.forEach((user, userIndex) => {
    const entries: ShelfEntry[] = Array.from({ length: rng.int(1, 3) }, (_, i) => ({
      shelf_entry_id: `ent${String(userIndex)}n${String(i)}`,
      values: {
        vocabulary_version: 3,
        bean_id: rng.pick(beanIds),
        purchase_date: '2026-11-01',
        ...(wild && rng.chance(0.4) ? { roast_date: dayString(RUN_MS - rng.int(0, 9) * DAY_MS) } : {}),
        ...(wild && rng.chance(0.55) ? { bag_size: rng.pick(bags) } : {}),
        ...(rng.chance(0.55) ? { price_band: rng.chance(0.8) ? rng.pick(bands.slice(0, 2)) : rng.pick(bands) } : {}),
      },
    }));
    for (const entry of entries) shelfEntries.push({ userId: user, entry });

    const usedSlots = new Set<string>();
    /** A time on `daysBack` days before the run. Clean histories use unique 100 s slots, so no two brews of a user are close. */
    const timeOn = (daysBack: number): number => {
      const dayStart = Date.UTC(2026, 10, 27) - (wild ? daysBack : daysBack + 1) * DAY_MS;
      if (wild) return dayStart + rng.int(0, DAY_MS - 1);
      for (;;) {
        const slot = rng.int(0, 860);
        const key = `${String(slot)}/${String(daysBack)}`;
        if (!usedSlots.has(key)) {
          usedSlots.add(key);
          return dayStart + slot * 100_000;
        }
      }
    };

    const addBrew = (entryId: string, at: number, single: number | undefined, rated: boolean): void => {
      brewNumber += 1;
      const brew: Brew = {
        brew_id: `brw${String(brewNumber).padStart(5, '0')}z${rng.hex(4)}`,
        values: {
          vocabulary_version: 3,
          shelf_entry_id: entryId,
          brewed_at: new Date(at).toISOString(),
          parameters: parametersOf(rng, mode),
          ...(rated ? { rating: ratingOf(rng, single) } : {}),
        },
      };
      brews.push({ userId: user, brew });
    };
    const entryId = (): string => (wild && rng.chance(0.02) ? 'entgone' : rng.pick(entries).shelf_entry_id);
    const rated = (): boolean => !rng.chance(wild ? 0.08 : 0.05);

    const style = rng.pick(wild ? ['sparse', 'sparse', 'busy', 'heavy', 'liner', 'burst'] : ['sparse', 'busy', 'heavy', 'heavy']);
    if (style === 'sparse') {
      for (let i = rng.int(1, 6); i > 0; i -= 1) addBrew(entryId(), timeOn(rng.int(0, 8)), undefined, rated());
    } else if (style === 'busy') {
      for (let i = rng.int(8, 25); i > 0; i -= 1) addBrew(entryId(), timeOn(rng.int(0, 4)), undefined, rated());
    } else if (style === 'heavy') {
      const entry = rng.pick(entries).shelf_entry_id;
      const day = rng.int(0, 6);
      for (let i = rng.int(11, 15); i > 0; i -= 1) addBrew(entry, timeOn(day), undefined, rated());
    } else if (style === 'liner') {
      const value = score(rng);
      for (let i = rng.int(9, 13); i > 0; i -= 1) addBrew(entryId(), timeOn(rng.int(0, 8)), value, rng.chance(0.95));
    } else {
      const start = timeOn(rng.int(0, 6));
      let at = start;
      for (let i = rng.int(6, 9); i > 0; i -= 1) {
        addBrew(entryId(), at, undefined, true);
        at += rng.pick([0, 0, 5_000, 12_000, 15_000, 60_000]);
      }
    }
    if (wild) {
      // The edges: exactly at the skew still counts, one millisecond past does not; a brew a minute after the run.
      if (rng.chance(0.15)) addBrew(entryId(), RUN_MS + 5 * MINUTE_MS, undefined, true);
      if (rng.chance(0.15)) addBrew(entryId(), RUN_MS + 5 * MINUTE_MS + 1, undefined, true);
      if (rng.chance(0.1)) addBrew(entryId(), RUN_MS + rng.int(6, 600) * MINUTE_MS, undefined, true);
      // A brew on the roast date's day and one a day before it.
      const dated = entries.find((e) => e.values.roast_date !== undefined);
      if (dated?.values.roast_date !== undefined && rng.chance(0.5)) {
        const start = Date.parse(`${dated.values.roast_date}T00:00:00.000Z`);
        addBrew(dated.shelf_entry_id, start + rng.int(0, 3600) * 1000, undefined, true);
        addBrew(dated.shelf_entry_id, start - rng.int(1, 3600) * 1000, undefined, true);
      }
    }
  });

  return { brews, shelfEntries, beans, consentByUser, runTimeMs: RUN_MS };
}


/**
 * A history built to fill the ranking lists: 6 to 14 users who nearly all consent, 2 to 4 beans that most
 * users have bought (in one of two price bands) and brewed on 1 to 3 days with 1 to 4 cups of one of two
 * methods. Every bean has a mean of its own, so the lists have an order. No cross-brew rule is triggered
 * on purpose (times are 10 minutes apart, no doses, no future brews), so most cups count.
 */
export function genCrowd(rng: Rng): RebuildInput {
  const users = Array.from({ length: rng.int(6, 14) }, (_, i) => `usr${String(i)}x${rng.hex(8)}`);
  const beanIds = Array.from({ length: rng.int(2, 4) }, (_, i) => `bean${String(i)}`);
  const beans = genBeans(rng, beanIds, 0.9);
  const meanOf = new Map(beanIds.map((id) => [id, 12 + rng.int(0, 3)]));
  const consentByUser = new Map(users.filter(() => rng.chance(0.95)).map((u) => [u, true]));
  const shelfEntries: RebuildShelfEntry[] = [];
  const brews: RebuildBrew[] = [];
  const bands = PriceBandSchema.options.slice(0, 2);
  let brewNumber = 0;
  users.forEach((user, userIndex) => {
    for (const beanId of beanIds) {
      if (!rng.chance(0.85)) continue;
      const entryIds = Array.from({ length: rng.int(1, 3) }, (_, i) => `ent${String(userIndex)}${beanId}n${String(i)}`);
      for (const id of entryIds) {
        shelfEntries.push({
          userId: user,
          entry: { shelf_entry_id: id, values: { vocabulary_version: 3, bean_id: beanId, purchase_date: '2026-11-01', ...(rng.chance(0.8) ? { price_band: rng.pick(bands) } : {}) } },
        });
      }
      const dayList = rng.shuffle([1, 2, 3, 4, 5, 6]).slice(0, rng.int(1, 3));
      for (const daysBack of dayList) {
        const dayStart = Date.UTC(2026, 10, 27) - daysBack * DAY_MS;
        for (let cup = rng.int(1, 4); cup > 0; cup -= 1) {
          brewNumber += 1;
          const centre = meanOf.get(beanId) ?? 12;
          const half = (): number => Math.min(20, Math.max(2, centre + rng.int(-3, 3)));
          brews.push({
            userId: user,
            brew: {
              brew_id: `brw${String(brewNumber).padStart(5, '0')}z${rng.hex(4)}`,
              values: {
                vocabulary_version: 3,
                shelf_entry_id: rng.pick(entryIds),
                brewed_at: new Date(dayStart + (8 * 60 + brewNumber % 40 * 10) * MINUTE_MS).toISOString(),
                parameters: { method: rng.pick(['v60', 'espresso'] as const) },
                rating: ratingOf(rng, undefined, () => half() / 2),
              },
            },
          });
        }
      }
    }
  });
  return { brews, shelfEntries, beans, consentByUser, runTimeMs: RUN_MS };
}


// ---- transformations of a history ----

export function shuffledHistory(rng: Rng, input: RebuildInput): RebuildInput {
  const users = rng.shuffle([...input.consentByUser.entries()]);
  return {
    brews: rng.shuffle(input.brews),
    shelfEntries: rng.shuffle(input.shelfEntries),
    beans: rng.shuffle(input.beans),
    consentByUser: new Map(users),
    runTimeMs: input.runTimeMs,
  };
}

export function withoutBrews(input: RebuildInput, remove: (brew: RebuildBrew) => boolean): RebuildInput {
  return { ...input, brews: input.brews.filter((b) => !remove(b)) };
}

export function withConsent(input: RebuildInput, user: string, value: boolean | undefined): RebuildInput {
  const consentByUser = new Map(input.consentByUser);
  if (value === undefined) consentByUser.delete(user);
  else consentByUser.set(user, value);
  return { ...input, consentByUser };
}

export function sameBrew(a: RebuildBrew, userId: string, brewId: string): boolean {
  return a.userId === userId && a.brew.brew_id === brewId;
}
