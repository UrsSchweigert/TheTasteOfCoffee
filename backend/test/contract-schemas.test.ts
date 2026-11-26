import { describe, expect, it } from 'vitest';
import {
  BeanCreateSchema,
  BeanSchema,
  BrewInputSchema,
  BrewPageSchema,
  HealthStatusSchema,
  IdSchema,
  ProfileSchema,
  RecipeInputSchema,
  ScoreSchema,
  ShelfEntryInputSchema,
} from '../src/generated/contract.ts';
import {
  validBean,
  validBeanCreate,
  validBrewInput,
  validBrewPage,
  validProfile,
  validRecipeInput,
  validShelfEntryInput,
} from './fixtures.ts';

type Mutable = Record<string, unknown>;

function child(value: Mutable, key: string): Mutable {
  const next = value[key];
  if (typeof next !== 'object' || next === null || Array.isArray(next)) throw new Error(`no object at ${key}`);
  return next as Mutable;
}

function brewWith(change: (brew: Mutable) => void): Mutable {
  const brew = validBrewInput();
  change(brew);
  return brew;
}

describe('BrewInput', () => {
  it('accepts a valid brew with a rating', () => {
    expect(BrewInputSchema.safeParse(validBrewInput()).success).toBe(true);
  });

  it('accepts a brew with only the required fields', () => {
    const brew = {
      vocabulary_version: 1,
      shelf_entry_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      brewed_at: '2026-11-25T07:30:00Z',
      parameters: { method: 'espresso' },
    };
    expect(BrewInputSchema.safeParse(brew).success).toBe(true);
  });

  it.each([
    ['an unknown top-level property', (b: Mutable) => { b.note = 'tasty'; }],
    ['an unknown nested property', (b: Mutable) => { child(b, 'parameters').grinder = 'x'; }],
    ['an unknown score key', (b: Mutable) => { child(child(b, 'rating'), 'scores').clean_cup = 7; }],
    ['an off-enum method', (b: Mutable) => { child(b, 'parameters').method = 'turkish_press'; }],
    ['an off-enum flavour note', (b: Mutable) => { child(b, 'rating').flavour_notes = ['berry', 'bubblegum']; }],
    ['an off-enum intensity', (b: Mutable) => { child(child(b, 'rating'), 'intensities').body = 'extreme'; }],
    ['a dose below the range', (b: Mutable) => { child(b, 'parameters').dose_dg = 49; }],
    ['a dose above the range', (b: Mutable) => { child(b, 'parameters').dose_dg = 1001; }],
    ['a fractional dose', (b: Mutable) => { child(b, 'parameters').dose_dg = 150.5; }],
    ['a water temperature above 100', (b: Mutable) => { child(b, 'parameters').water_temp_c = 101; }],
    ['a score above 10', (b: Mutable) => { child(child(b, 'rating'), 'scores').overall = 10.5; }],
    ['a score below 1', (b: Mutable) => { child(child(b, 'rating'), 'scores').overall = 0.5; }],
    ['an off-step score (7.25)', (b: Mutable) => { child(child(b, 'rating'), 'scores').overall = 7.25; }],
    ['an almost-on-step score', (b: Mutable) => { child(child(b, 'rating'), 'scores').overall = 7.500000000000001; }],
    ['an off-step grind', (b: Mutable) => { child(b, 'parameters').grind_normalised = 4.2; }],
    ['a score sent as a string', (b: Mutable) => { child(child(b, 'rating'), 'scores').overall = '8'; }],
    ['a missing score', (b: Mutable) => { delete child(child(b, 'rating'), 'scores').overall; }],
    [
      'more than 5 flavour notes',
      (b: Mutable) => { child(b, 'rating').flavour_notes = ['berry', 'cherry', 'plum', 'peach', 'apricot', 'apple']; },
    ],
    ['a repeated flavour note', (b: Mutable) => { child(b, 'rating').flavour_notes = ['berry', 'berry']; }],
    ['a bad shelf entry id', (b: Mutable) => { b.shelf_entry_id = '01ARZ3NDEKTSV4RRFFQ69G5FAI'; }],
    ['a lower-case id', (b: Mutable) => { b.shelf_entry_id = '01arz3ndektsv4rrffq69g5fav'; }],
    ['a timestamp without offset', (b: Mutable) => { b.brewed_at = '2026-11-25T07:30:00'; }],
    ['a timestamp on a day that does not exist', (b: Mutable) => { b.brewed_at = '2026-02-29T07:30:00Z'; }],
    ['a date where a timestamp belongs', (b: Mutable) => { b.brewed_at = '2026-11-25'; }],
    ['an unpublished vocabulary version', (b: Mutable) => { b.vocabulary_version = 4; }],
    ['a missing method', (b: Mutable) => { delete child(b, 'parameters').method; }],
    [
      'both water_temp_c and water_temp_special',
      (b: Mutable) => { child(b, 'parameters').water_temp_special = 'cold'; },
    ],
  ])('rejects %s', (_name, change) => {
    expect(BrewInputSchema.safeParse(brewWith(change)).success).toBe(false);
  });

  it('accepts water_temp_special on its own', () => {
    const brew = brewWith((b) => {
      const parameters = child(b, 'parameters');
      delete parameters.water_temp_c;
      parameters.water_temp_special = 'cold';
    });
    expect(BrewInputSchema.safeParse(brew).success).toBe(true);
  });

  it('rejects a __proto__ key from JSON.parse', () => {
    const brew = JSON.parse(
      '{"vocabulary_version":1,"shelf_entry_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","brewed_at":"2026-11-25T07:30:00Z","parameters":{"method":"v60"},"__proto__":{"x":1}}',
    ) as unknown;
    expect(BrewInputSchema.safeParse(brew).success).toBe(false);
  });
});

describe('Score', () => {
  it.each([1, 1.5, 7, 7.5, 10])('accepts %s', (value) => {
    expect(ScoreSchema.safeParse(value).success).toBe(true);
  });
  it.each([0, 0.5, 7.25, 7.1, 10.5, 11, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (value) => {
    expect(ScoreSchema.safeParse(value).success).toBe(false);
  });
});

describe('BeanCreate', () => {
  it('accepts a valid bean', () => {
    expect(BeanCreateSchema.safeParse(validBeanCreate()).success).toBe(true);
  });
  it('accepts a bean without barcode or Open Food Facts confirmation', () => {
    expect(BeanCreateSchema.safeParse({ vocabulary_version: 1, attributes: {} }).success).toBe(true);
  });
  it('rejects open_food_facts_confirmed without a barcode (dependentRequired)', () => {
    const bean = validBeanCreate();
    delete bean.barcode;
    expect(BeanCreateSchema.safeParse(bean).success).toBe(false);
  });
  it.each(['400638133393', '4006381333931'])('accepts the barcode %s', (barcode) => {
    expect(BeanCreateSchema.safeParse({ ...validBeanCreate(), barcode }).success).toBe(true);
  });
  it.each(['40063813339', '40063813339312', '400638133393a', ' 4006381333931', '٤٠٠٦٣٨١٣٣٣٩٣١'])(
    'rejects the barcode %j',
    (barcode) => {
      expect(BeanCreateSchema.safeParse({ ...validBeanCreate(), barcode }).success).toBe(false);
    },
  );
  it('rejects a name or brand (no free text)', () => {
    expect(BeanCreateSchema.safeParse({ ...validBeanCreate(), name: 'House blend' }).success).toBe(false);
    expect(BeanCreateSchema.safeParse({ ...validBeanCreate(), attributes: { roaster: 'x' } }).success).toBe(false);
  });
  it('takes origin, species and variety as vocabulary v2 ids only', () => {
    const attributes = { origin: 'sumatra', species: 'arabica', variety: 'java' };
    expect(BeanCreateSchema.safeParse({ ...validBeanCreate(), vocabulary_version: 2, attributes }).success).toBe(true);
    expect(BeanCreateSchema.safeParse({ ...validBeanCreate(), vocabulary_version: 2, attributes: { origin: 'Sumatra' } }).success).toBe(false);
    expect(BeanCreateSchema.safeParse({ ...validBeanCreate(), vocabulary_version: 2, attributes: { variety: 'robusta' } }).success).toBe(false);
    expect(BeanCreateSchema.safeParse({ ...validBeanCreate(), vocabulary_version: 2, attributes: { country: 'indonesia' } }).success).toBe(false);
  });
});

describe('Bean', () => {
  it('accepts a valid bean with picked_attributes', () => {
    expect(BeanSchema.safeParse(validBean()).success).toBe(true);
  });
  it('requires picked_attributes', () => {
    const bean = validBean();
    delete bean.picked_attributes;
    expect(BeanSchema.safeParse(bean).success).toBe(false);
  });
});

describe('Open Food Facts text (ADR 0005)', () => {
  function beanWith(fields: Record<string, unknown>): Mutable {
    const bean = validBean();
    bean.open_food_facts = { ...child(bean, 'open_food_facts'), ...fields };
    return bean;
  }
  it('is accepted in a bean response up to its length limit, counted in code points', () => {
    expect(BeanSchema.safeParse(beanWith({ name: 'x'.repeat(150), brand: 'x'.repeat(100) })).success).toBe(true);
    expect(BeanSchema.safeParse(beanWith({ name: '\u{1F600}'.repeat(150) })).success).toBe(true);
  });
  it.each([
    ['a name over 150', { name: 'x'.repeat(151) }],
    ['a brand over 100', { brand: 'x'.repeat(101) }],
    ['an empty name', { name: '' }],
    ['an unknown field', { origin: 'Guji' }],
    ['an image URL instead of the stored copy id (ADR 0011)', { image_id: 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.400.jpg' }],
    ['a lower-case image id', { image_id: '01arz3ndektsv4rrffq69g5fav' }],
    ['the removed image_ref', { image_ref: 'https://images.openfoodfacts.org/images/products/400/638/133/3931/front_de.3.400.jpg' }],
  ])('rejects %s', (_name, fields) => {
    expect(BeanSchema.safeParse(beanWith(fields)).success).toBe(false);
  });
  it('is never accepted in a request', () => {
    expect(BeanCreateSchema.safeParse({ ...validBeanCreate(), open_food_facts: { name: 'Ethiopia Guji' } }).success).toBe(false);
  });
});

describe('HealthStatus (ADR 0007)', () => {
  it('is exactly {"status":"ok"}', () => {
    expect(HealthStatusSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(HealthStatusSchema.safeParse({ status: 'degraded' }).success).toBe(false);
    expect(HealthStatusSchema.safeParse({ status: 'ok', version: '1' }).success).toBe(false);
  });
});

describe('ShelfEntryInput', () => {
  it('accepts a valid entry on a leap day', () => {
    expect(ShelfEntryInputSchema.safeParse(validShelfEntryInput()).success).toBe(true);
  });
  it.each(['2026-02-29', '2026-13-01', '2026-04-31', '2026-00-10', '2026-1-1', '26-11-25', '2026-11-25T00:00:00Z', '2026/11/25'])(
    'rejects the purchase date %s',
    (purchase_date) => {
      expect(ShelfEntryInputSchema.safeParse({ ...validShelfEntryInput(), purchase_date }).success).toBe(false);
    },
  );
  it('rejects an off-enum bag size and price band', () => {
    expect(ShelfEntryInputSchema.safeParse({ ...validShelfEntryInput(), bag_size: 'g_750' }).success).toBe(false);
    expect(ShelfEntryInputSchema.safeParse({ ...validShelfEntryInput(), price_band: 'cheap' }).success).toBe(false);
  });
});

describe('RecipeInput, Profile and pages', () => {
  it('accepts valid values', () => {
    expect(RecipeInputSchema.safeParse(validRecipeInput()).success).toBe(true);
    expect(ProfileSchema.safeParse(validProfile()).success).toBe(true);
    expect(BrewPageSchema.safeParse(validBrewPage()).success).toBe(true);
  });
  it('rejects an off-enum locale and a missing consent', () => {
    expect(ProfileSchema.safeParse({ ...validProfile(), locale: 'fr' }).success).toBe(false);
    expect(ProfileSchema.safeParse({ locale: 'en' }).success).toBe(false);
  });
  it('rejects a page of more than 100 items and a bad cursor', () => {
    const items = Array.from({ length: 101 }, () => ({ brew_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', values: validBrewInput() }));
    expect(BrewPageSchema.safeParse({ items }).success).toBe(false);
    expect(BrewPageSchema.safeParse({ items: [], next_cursor: 'a/b' }).success).toBe(false);
    expect(BrewPageSchema.safeParse({ items: [], next_cursor: 'a'.repeat(513) }).success).toBe(false);
  });
});

describe('Id', () => {
  it('accepts a ULID and rejects anything else', () => {
    expect(IdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true);
    expect(IdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FA').success).toBe(false);
    expect(IdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAU').success).toBe(false);
    expect(IdSchema.safeParse(42).success).toBe(false);
  });
});
