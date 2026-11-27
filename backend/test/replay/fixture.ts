// The one history of the replay tests, built once per test file: the event
// stream, the state it leaves (the oracle's input and expected output) and
// tables filled in the canonical or in another order.
import type { RebuildInput } from '../../src/aggregation/rebuild/types.ts';
import { FakeTable } from '../repository/fake-table.ts';
import type { Item } from '../repository/fake-table.ts';
import { expectedDump } from './harness.ts';
import { applyEvents, baseItems, finalInput, generateHistory, interleaved } from './history.ts';
import type { History } from './history.ts';

/** The seed of the history and of the shuffles; a failure is reproduced by it. */
export const HISTORY_SEED = 20_261_127;

export interface Fixture {
  readonly history: History;
  readonly input: RebuildInput;
  readonly expected: ReturnType<typeof expectedDump>;
  /** A table filled with the stream in its canonical order (`order` undefined) or interleaved by that seed. */
  readonly table: (order?: number) => FakeTable;
}

export function buildFixture(): Fixture {
  const history = generateHistory(HISTORY_SEED);
  const input = finalInput(history);
  const expected = expectedDump(input);
  const table = (order?: number): FakeTable => {
    const t = new FakeTable();
    for (const item of baseItems(history)) t.put(item);
    applyEvents(t, history, order === undefined ? history.events : interleaved(history.events, order));
    return t;
  };
  return { history, input, expected, table };
}

export function itemsOf(table: FakeTable): Item[] {
  return [...table.items.values()];
}
