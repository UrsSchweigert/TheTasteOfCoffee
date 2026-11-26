// Method-dependent brew fields (docs/04-specification.md, F2: "Fields depend on
// the method; all are optional except method"; docs/07 D13; ADR 0021).
//
// From vocabulary v3 on, `brew.json` holds `field_rules`: for each
// BrewParameters field that only some methods allow, the methods that allow it.
// Versions 1 and 2 have none, so every field is allowed with every method there
// and existing brews and recipes stay valid. The rules and the grinder scales
// are read from src/generated/vocabulary.ts (CLAUDE.md, invariant 2); no list
// is written here.
//
// Two rules go beyond "this method allows this field":
// - `grind_setting` lies on the scale of the `grinder` sent. A grinder without a
//   scale (`pre_ground`, `other`, one whose dial is not in steps of 1 or 0.5)
//   takes no `grind_setting`. The contract states this relation in prose
//   (GrindSetting, BrewParameters); it is the one name pair written here.
// - `grinder` needs vocabulary_version 3 or later. v1 and v2 define no
//   `grinders` list, so the vocabulary check (check.ts) already rejects it;
//   `violatesMethodRules` also states it, so the rule does not depend on that.
//
// The cross-field rule that does not depend on the method, water_temp_c and
// water_temp_special excluding each other, is enforced by the generated schema
// (`not: { required: [...] }`).
import type { BrewParameters, Method } from '../generated/contract.ts';
import { publishedVocabulary } from './check.ts';

/** A brew field that only some methods allow. */
export interface MethodFieldRule {
  readonly field: Exclude<keyof BrewParameters, 'method'>;
  /** The methods with which the field may be set; with any other method it must be absent. */
  readonly allowedMethods: readonly Method[];
}

/** The numeric scale of a grinder is in the `grinders` list; `grind_setting` is checked against it. */
const SCALED_FIELD = 'grind_setting';
const SCALED_BY = 'grinder';
const SCALED_LIST = 'grinders';

/** The rules of a vocabulary version, from its generated data. Versions 1 and 2, and unknown versions, have none. */
export function methodRulesFor(version: number): readonly MethodFieldRule[] {
  const fieldRules = publishedVocabulary(version)?.fieldRules;
  if (fieldRules === undefined) return [];
  return Object.entries(fieldRules).map(([field, allowedMethods]) => ({
    field: field as MethodFieldRule['field'],
    allowedMethods: allowedMethods as readonly Method[],
  }));
}

/** True if `parameters` sets a field that its method does not allow under `rules`. */
export function violatesMethodRules(parameters: BrewParameters, rules: readonly MethodFieldRule[]): boolean {
  return rules.some((rule) => parameters[rule.field] !== undefined && !rule.allowedMethods.includes(parameters.method));
}

/**
 * True if `grind_setting` is not allowed by the grinder sent: no grinder, a
 * grinder with no scale in this version, or a value outside the scale or off
 * its step. Nothing is wrong when `grind_setting` is absent.
 */
export function violatesGrindScale(parameters: BrewParameters, version: number): boolean {
  const setting = parameters[SCALED_FIELD];
  if (setting === undefined) return false;
  const grinder = parameters[SCALED_BY];
  if (grinder === undefined) return true;
  const entries = publishedVocabulary(version)?.entryRanges?.[SCALED_LIST];
  const scale = entries !== undefined && Object.hasOwn(entries, grinder) ? entries[grinder] : undefined;
  if (scale === undefined) return true;
  // Exact: every step is a multiple of 2^-20 (generator) and the value a double.
  return setting < scale.minimum || setting > scale.maximum || setting % scale.multipleOf !== 0;
}

/** True if `grinder` is sent under a version that does not define grinders (v1, v2). */
export function violatesGrinderVersion(parameters: BrewParameters, version: number): boolean {
  if (parameters[SCALED_BY] === undefined) return false;
  const grinders = publishedVocabulary(version)?.lists[SCALED_LIST];
  return grinders === undefined;
}

/** All method-dependent rules for a brew or recipe input: true if it satisfies them. */
export function methodRulesHold(input: { vocabulary_version: number; parameters: BrewParameters }): boolean {
  const { vocabulary_version: version, parameters } = input;
  return (
    !violatesMethodRules(parameters, methodRulesFor(version)) &&
    !violatesGrinderVersion(parameters, version) &&
    !violatesGrindScale(parameters, version)
  );
}
