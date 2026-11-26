// Method field rules and grinder scales from vocabulary v3 (M2-T5; docs/04-specification.md F2;
// docs/07 D13; ADR 0021). The expectations below are the decision as the spec states it,
// written out per method; the rules themselves come from src/generated/vocabulary.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrewSchema, RecipeSchema, ShelfEntrySchema } from '../../src/generated/contract.ts';
import { publishedVocabularies } from '../../src/generated/vocabulary.ts';
import { methodRulesFor, methodRulesHold, violatesGrindScale, violatesGrinderVersion, violatesMethodRules } from '../../src/vocabulary/method-rules.ts';
import { brewBody, harness, shelfBody } from './helpers.ts';
import type { Harness } from './helpers.ts';

const METHODS = ['espresso', 'moka_pot', 'v60', 'chemex', 'kalita', 'batch_filter', 'aeropress', 'french_press', 'cold_brew', 'cezve', 'siphon', 'fully_automatic'];

/** Methods that do not allow a field, per D13. */
const DISALLOWED: Record<string, readonly string[]> = {
  water_temp_special: METHODS.filter((m) => m !== 'cold_brew'),
  water_temp_c: ['cold_brew', 'moka_pot', 'cezve'],
  grinder: ['fully_automatic'],
  grind_setting: ['fully_automatic'],
};
/** A valid value of each ruled field (grind_setting needs a grinder). */
const VALUE: Record<string, Record<string, unknown>> = {
  water_temp_special: { water_temp_special: 'cold' },
  water_temp_c: { water_temp_c: 92 },
  grinder: { grinder: 'comandante_c40' },
  grind_setting: { grinder: 'comandante_c40', grind_setting: 20 },
};
/** Fields every method allows. */
const ANY_METHOD: Record<string, unknown> = { dose_dg: 150, water_g: 250, brew_time_s: 180, grind_normalised: 4.5, water_type: 'filtered', milk: 'none' };

let h: Harness;
let shelfId = '';

beforeEach(async () => {
  h = harness();
  shelfId = ShelfEntrySchema.parse((await h.call('POST', '/shelf', { json: shelfBody() })).body).shelf_entry_id;
});

function brew(parameters: Record<string, unknown>, version: number): Record<string, unknown> {
  return { ...brewBody(shelfId), vocabulary_version: version, parameters };
}
function recipe(parameters: Record<string, unknown>, version: number): Record<string, unknown> {
  return { vocabulary_version: version, parameters };
}
async function status(verb: 'POST' | 'PUT', route: 'brews' | 'recipes', parameters: Record<string, unknown>, version = 3): Promise<number> {
  const body = route === 'brews' ? brew(parameters, version) : recipe(parameters, version);
  if (verb === 'POST') return (await h.call('POST', `/${route}`, { json: body })).status;
  // PUT replaces an existing item (created valid under v1), so the answer is the rules' own.
  const created = await h.call('POST', `/${route}`, { json: route === 'brews' ? brew({ method: 'v60' }, 1) : recipe({ method: 'v60' }, 1) });
  expect(created.status).toBe(201);
  const id = route === 'brews' ? BrewSchema.parse(created.body).brew_id : RecipeSchema.parse(created.body).recipe_id;
  return (await h.call('PUT', `/${route}/${id}`, { json: body })).status;
}

describe('methodRulesFor reads the generated vocabulary', () => {
  it('has no rule for versions 1 and 2, nor for an unknown version', () => {
    for (const version of [1, 2, 0, 4, -1, 2.5]) expect(methodRulesFor(version), String(version)).toEqual([]);
  });

  it('has the rules of v3 brew.json, field_rules, and nothing else', () => {
    const file = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'contracts', 'vocabulary', 'v3', 'brew.json'), 'utf8')) as {
      field_rules: Record<string, { allowed_methods: Record<string, true> }>;
    };
    const rules = methodRulesFor(3);
    expect(rules.map((r) => r.field).sort()).toEqual(Object.keys(file.field_rules).sort());
    for (const rule of rules) expect([...rule.allowedMethods], rule.field).toEqual(Object.keys(file.field_rules[rule.field]?.allowed_methods ?? {}));
  });

  it('allows exactly what D13 allows, method by method', () => {
    const rules = methodRulesFor(3);
    expect(rules.map((r) => r.field).sort()).toEqual(Object.keys(DISALLOWED).sort());
    for (const [field, disallowed] of Object.entries(DISALLOWED)) {
      const rule = rules.find((r) => r.field === field);
      expect([...(rule?.allowedMethods ?? [])].sort(), field).toEqual(METHODS.filter((m) => !disallowed.includes(m)).sort());
    }
  });

  it('knows every method of v3', () => {
    expect([...(publishedVocabularies[3]?.lists.methods ?? [])]).toEqual(METHODS);
  });
});

describe('violatesMethodRules and methodRulesHold, per rule, with an allowed and a disallowed method', () => {
  for (const [field, disallowed] of Object.entries(DISALLOWED)) {
    it(`${field}: absent with ${disallowed.join(', ')}, allowed with every other method`, () => {
      for (const method of METHODS) {
        const parameters = { method, ...VALUE[field] } as never;
        const allowed = !disallowed.includes(method);
        expect(violatesMethodRules(parameters, methodRulesFor(3)), `${field} with ${method}`).toBe(!allowed);
        expect(methodRulesHold({ vocabulary_version: 3, parameters }), `${field} with ${method}`).toBe(allowed);
        // The same parameters under v1: no rule (grinder aside, see below).
        if (field !== 'grinder' && field !== 'grind_setting') expect(methodRulesHold({ vocabulary_version: 1, parameters })).toBe(true);
      }
    });
  }

  it('the method-free fields are allowed with every method', () => {
    for (const method of METHODS) expect(methodRulesHold({ vocabulary_version: 3, parameters: { method, ...ANY_METHOD } as never }), method).toBe(true);
  });

  it('grinder is not allowed under v1 or v2, allowed under v3', () => {
    const parameters = { method: 'v60', grinder: 'comandante_c40' } as const;
    expect(violatesGrinderVersion(parameters, 1)).toBe(true);
    expect(violatesGrinderVersion(parameters, 2)).toBe(true);
    expect(violatesGrinderVersion(parameters, 3)).toBe(false);
    expect(violatesGrinderVersion({ method: 'v60' }, 1)).toBe(false);
  });

  it.each([
    ['comandante_c40', 0, false],
    ['comandante_c40', 50, false],
    ['comandante_c40', 24, false],
    ['comandante_c40', 51, true],
    ['comandante_c40', 24.5, true],
    ['baratza_encore', 0, true],
    ['baratza_encore', 1, false],
    ['baratza_encore', 40, false],
    ['baratza_encore', 41, true],
    ['niche_zero', 25.5, false],
    ['niche_zero', 25.25, true],
    ['kingrinder_k6', 240, false],
    ['kingrinder_k6', 241, true],
    ['fellow_ode_gen_2', 5, true],
    ['eureka_mignon_specialita', 5, true],
    ['pre_ground', 5, true],
    ['other', 5, true],
  ] as const)('grind_setting on %s: %s violates is %s', (grinder, setting, violates) => {
    expect(violatesGrindScale({ method: 'v60', grinder, grind_setting: setting }, 3)).toBe(violates);
  });

  it('grind_setting with no grinder, and under a version without scales, violates; absent never does', () => {
    expect(violatesGrindScale({ method: 'v60', grind_setting: 5 }, 3)).toBe(true);
    expect(violatesGrindScale({ method: 'v60', grinder: 'comandante_c40', grind_setting: 5 }, 2)).toBe(true);
    expect(violatesGrindScale({ method: 'v60', grinder: 'pre_ground' }, 3)).toBe(false);
    expect(violatesGrindScale({ method: 'v60' }, 1)).toBe(false);
  });

  it('every grinder with a scale in the vocabulary accepts its own bounds and refuses one step beyond', () => {
    const scales = publishedVocabularies[3]?.entryRanges?.grinders ?? {};
    expect(Object.keys(scales).length).toBeGreaterThan(10);
    for (const [grinder, { minimum, maximum, multipleOf }] of Object.entries(scales)) {
      const at = (grind_setting: number): boolean => violatesGrindScale({ method: 'v60', grinder, grind_setting } as never, 3);
      expect(at(minimum), grinder).toBe(false);
      expect(at(maximum), grinder).toBe(false);
      expect(at(maximum + multipleOf), grinder).toBe(true);
      if (minimum - multipleOf >= 0) expect(at(minimum - multipleOf), grinder).toBe(true);
    }
  });
});

describe.each(['brews', 'recipes'] as const)('%s: POST and PUT answer 400 for what the rules refuse', (route) => {
  for (const verb of ['POST', 'PUT'] as const) {
    const ok = verb === 'POST' ? 201 : 200;

    it(`${verb}: every method against every ruled field`, async () => {
      for (const [field, disallowed] of Object.entries(DISALLOWED)) {
        for (const method of METHODS) {
          expect(await status(verb, route, { method, ...VALUE[field] }), `${field} with ${method}`).toBe(disallowed.includes(method) ? 400 : ok);
        }
      }
    });

    it(`${verb}: grind_setting must lie on the grinder's scale and step`, async () => {
      const set = (grinder: string, grind_setting: number): Promise<number> => status(verb, route, { method: 'v60', grinder, grind_setting });
      expect(await set('comandante_c40', 50)).toBe(ok);
      expect(await set('comandante_c40', 51)).toBe(400);
      expect(await set('comandante_c40', 24.5)).toBe(400);
      expect(await set('niche_zero', 24.5)).toBe(ok);
      expect(await set('baratza_encore', 0)).toBe(400);
      expect(await set('kingrinder_k6', 240)).toBe(ok);
    });

    it(`${verb}: grind_setting with a grinder that has no scale, or with no grinder, is refused; grinder alone is fine`, async () => {
      for (const grinder of ['fellow_ode_gen_2', 'eureka_mignon_specialita', 'pre_ground', 'other']) {
        expect(await status(verb, route, { method: 'v60', grinder, grind_setting: 10 }), grinder).toBe(400);
        expect(await status(verb, route, { method: 'v60', grinder }), grinder).toBe(ok);
      }
      expect(await status(verb, route, { method: 'v60', grind_setting: 10 })).toBe(400);
    });

    it(`${verb}: grinder with vocabulary_version 1 or 2 is refused, with 3 accepted`, async () => {
      for (const version of [1, 2]) {
        expect(await status(verb, route, { method: 'v60', grinder: 'comandante_c40' }, version), `v${String(version)}`).toBe(400);
        expect(await status(verb, route, { method: 'v60', grinder: 'pre_ground', grind_normalised: 4 }, version), `v${String(version)}`).toBe(400);
      }
      expect(await status(verb, route, { method: 'v60', grinder: 'comandante_c40' }, 3)).toBe(ok);
    });

    it(`${verb}: versions 1 and 2 keep every field with every method`, async () => {
      for (const version of [1, 2]) {
        for (const method of ['cold_brew', 'moka_pot', 'fully_automatic']) {
          expect(await status(verb, route, { method, water_temp_c: 90, milk: 'dairy' }, version), `${method} v${String(version)}`).toBe(ok);
        }
        expect(await status(verb, route, { method: 'v60', water_temp_special: 'cold' }, version)).toBe(ok);
      }
    });
  }
});
