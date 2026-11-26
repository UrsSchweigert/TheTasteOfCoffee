// Method-dependent brew fields (docs/04-specification.md, F2: "Fields depend on
// the method; all are optional except method").
//
// The spec does not say which field applies to which method, vocabulary v1
// defines no such mapping, and contracts/openapi.yaml says so on
// BrewParameters ("Which fields apply to which method is not defined in
// vocabulary v1 yet", until v3). So the rule set is still empty (M2-T5 adds the
// v3 rules): every field is allowed with every method. This module is the hook where rules go once they exist. They
// belong in the vocabulary (CLAUDE.md, invariant 2), so `methodRulesFor`
// should then read them from src/generated/vocabulary.ts, not from a list
// written here.
//
// The one cross-field rule the contract does define, water_temp_c and
// water_temp_special excluding each other, does not depend on the method and is
// enforced by the generated schema (`not: { required: [...] }`).
import type { BrewParameters, Method } from '../generated/contract.ts';

/** A brew field that only some methods allow. */
export interface MethodFieldRule {
  readonly field: Exclude<keyof BrewParameters, 'method'>;
  /** The methods with which the field may be set; with any other method it must be absent. */
  readonly allowedMethods: readonly Method[];
}

/** The rules of a vocabulary version. None are defined for any published version (see above). */
export function methodRulesFor(_version: number): readonly MethodFieldRule[] {
  return [];
}

/** True if `parameters` sets a field that its method does not allow under `rules`. */
export function violatesMethodRules(parameters: BrewParameters, rules: readonly MethodFieldRule[]): boolean {
  return rules.some((rule) => parameters[rule.field] !== undefined && !rule.allowedMethods.includes(parameters.method));
}
