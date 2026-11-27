// A small seeded random generator for the property tests (M3-T6). fast-check is
// not a dependency. The same seed always gives the same sequence, so a failing
// case is reproduced by its seed alone. Not for anything but tests.

/** mulberry32: 32 bits of state, one number in [0, 1) per call. */
export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** An integer in [low, high], both inclusive. */
  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }

  /** A new array in random order (Fisher-Yates); the input is not changed. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = copy[i];
      const b = copy[j];
      if (a === undefined || b === undefined) throw new Error('hole in shuffle');
      copy[i] = b;
      copy[j] = a;
    }
    return copy;
  }

  /** A random subset of `items` (each kept with probability `p`), in the original order. */
  subset<T>(items: readonly T[], p: number): T[] {
    return items.filter(() => this.chance(p));
  }

  /** Lower-case hex digits, `length` of them. */
  hex(length: number): string {
    let text = '';
    for (let i = 0; i < length; i += 1) text += this.int(0, 15).toString(16);
    return text;
  }
}

/** The seeds of one campaign: 1..count. */
export function seeds(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}
