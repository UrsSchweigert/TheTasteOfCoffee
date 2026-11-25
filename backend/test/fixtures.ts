// Valid example payloads, built from what contracts/openapi.yaml defines.
// Ids, barcodes and dates are made up; nothing here is a secret.

export const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const OTHER_ULID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
export const EAN13 = '4006381333931';

export function validBrewInput(): Record<string, unknown> {
  return {
    vocabulary_version: 1,
    shelf_entry_id: ULID,
    brewed_at: '2026-11-25T07:30:00.250+01:00',
    parameters: {
      method: 'v60',
      dose_dg: 150,
      water_g: 250,
      water_temp_c: 94,
      brew_time_s: 180,
      grind_normalised: 4.5,
      water_type: 'filtered',
      milk: 'none',
    },
    rating: {
      scores: {
        aroma: 8,
        flavour: 7.5,
        aftertaste: 7,
        acidity: 8.5,
        body: 6,
        sweetness: 7,
        balance: 7.5,
        overall: 8,
      },
      intensities: { acidity: 'high', body: 'medium', bitterness: 'low' },
      flavour_notes: ['berry', 'jasmine', 'honey'],
      buy_again: true,
    },
  };
}

export function validBeanCreate(): Record<string, unknown> {
  return {
    vocabulary_version: 1,
    barcode: EAN13,
    open_food_facts_confirmed: true,
    attributes: { process: 'washed', roast_level: 'medium_light' },
  };
}

export function validBean(): Record<string, unknown> {
  return {
    bean_id: ULID,
    vocabulary_version: 1,
    verified: false,
    barcode: EAN13,
    open_food_facts_match: true,
    open_food_facts: {
      name: 'Ethiopia Guji <b>natural</b>',
      brand: 'Rösterei Beispiel',
      image_id: OTHER_ULID,
    },
    picked_attributes: { process: 'natural' },
    operator_attributes: {},
  };
}

export function validHealthStatus(): Record<string, unknown> {
  return { status: 'ok' };
}

export function validShelfEntryInput(): Record<string, unknown> {
  return {
    vocabulary_version: 1,
    bean_id: ULID,
    purchase_date: '2028-02-29',
    roast_date: '2028-02-20',
    bag_size: 'g_250',
    price_band: 'from_15_to_30',
  };
}

export function validRecipeInput(): Record<string, unknown> {
  return {
    vocabulary_version: 1,
    parameters: { method: 'cold_brew', water_temp_special: 'cold', dose_dg: 1000, brew_time_s: 172800 },
  };
}

export function validProfile(): Record<string, unknown> {
  return { locale: 'de', consent: { contribute_to_aggregates: false } };
}

export function validBrewPage(): Record<string, unknown> {
  return { items: [{ brew_id: OTHER_ULID, values: validBrewInput() }], next_cursor: 'abc_DEF-123' };
}

export function validShelfEntryPage(): Record<string, unknown> {
  return { items: [{ shelf_entry_id: OTHER_ULID, values: validShelfEntryInput() }], next_cursor: 'abc_DEF-123' };
}

export function validRecipePage(): Record<string, unknown> {
  return { items: [{ recipe_id: OTHER_ULID, values: validRecipeInput() }] };
}
