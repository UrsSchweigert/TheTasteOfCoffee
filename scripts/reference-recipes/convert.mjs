// Converts a table of published brew recipes into the reference recipe set (M2-T46, ADR 0034).
//
// The input is a CSV the owner compiled from public sources; it is NOT in the repository and
// carries names, links and free text. The output keeps none of it: only a method id from the
// closed vocabulary and the numeric brew parameters of vocabulary v3, plus a list of the fields
// that were inferred. Nothing here is a rating or a community figure (invariants 1 and 4).
//
//   node scripts/reference-recipes/convert.mjs <recipes.csv> [--out contracts/reference/recipes.v1.json]
//
// Pure functions are exported so the tests can feed fixtures to the code the CLI runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VOCABULARY_VERSION = 3;
export const DATASET_VERSION = 1;

/** Grind words of the source to the normalised coarseness of vocabulary v3 (1 finest to 10, half steps). */
export const GRIND_WORDS = {
  'extra fine': 1.5,
  fine: 3,
  'medium-fine': 4.5,
  medium: 5.5,
  'medium-coarse': 7,
  coarse: 8.5,
  'extra coarse': 9.5,
};

/** Methods whose recipes may carry a water temperature (vocabulary field_rules.water_temp_c). */
const TEMPERATURE_METHODS = ['espresso', 'v60', 'chemex', 'kalita', 'batch_filter', 'aeropress', 'french_press', 'siphon', 'fully_automatic'];

/**
 * The vocabulary method a source row stands for, or null when none of ours fits (Orea, Cafec,
 * Origami, Clever, Switch, Pulsar, cloth and ceramic filters, phin, and so on: a wrong method
 * would give wrong numbers, so they are dropped, not forced).
 */
export function methodOf(method, brewer) {
  const m = String(method ?? '').trim().toLowerCase();
  const b = String(brewer ?? '').trim().toLowerCase();
  if (m === 'aeropress') return 'aeropress';
  if (m === 'french press') return 'french_press';
  if (m === 'cold brew') return 'cold_brew';
  if (m === 'ibrik / turkish') return 'cezve';
  if (m === 'moka pot') return 'moka_pot';
  if (m === 'siphon') return 'siphon';
  if (m === 'chemex pour-over' || /chemex/.test(b)) return 'chemex';
  if (m === 'pour-over' && /kalita/.test(b)) return 'kalita';
  if (m === 'pour-over' && /\bv60\b/.test(b)) return 'v60';
  return null;
}

/** Parses CSV text with quoted fields (commas, doubled quotes and line breaks inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ''])));
}

const toNumber = (value) => {
  const text = String(value ?? '').trim();
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : null;
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Linear-interpolated percentile of an ascending list, p in 0..1. */
const percentile = (sorted, p) => {
  if (sorted.length === 1) return sorted[0];
  const at = (sorted.length - 1) * p;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
};

const round = (value, step) => Math.round(value / step) * step;
const clean = (value) => Number(value.toFixed(3));

/**
 * @param rows parsed CSV rows
 * @param brew the `brew` list of the vocabulary (ranges and field rules)
 * @returns { recipes, ranges, report }
 */
export function convert(rows, brew) {
  const { ranges } = brew;
  const report = { rows: rows.length, kept: 0, dropped: {}, duplicates: 0, inferred: {} };
  const drop = (reason) => {
    report.dropped[reason] = (report.dropped[reason] ?? 0) + 1;
  };
  const candidates = [];

  for (const row of rows) {
    const method = methodOf(row.method, row.brewer);
    if (!method) {
      drop('no_matching_method');
      continue;
    }
    const flags = String(row.quality_flags ?? '');
    if (flags.includes('bypass_or_dilution_check_water_basis')) {
      drop('water_basis_unclear');
      continue;
    }
    const dose = toNumber(row.coffee_g_source);
    const water = toNumber(row.water_g_source);
    if (dose === null || water === null) {
      drop('dose_or_water_missing');
      continue;
    }
    const doseDg = Math.round(dose * 10);
    const waterG = Math.round(water);
    if (doseDg < ranges.dose_g.minimum * 10 || doseDg > ranges.dose_g.maximum * 10 || waterG < ranges.water_g.minimum || waterG > ranges.water_g.maximum) {
      drop('outside_vocabulary_range');
      continue;
    }
    const parameters = { method, dose_dg: doseDg, water_g: waterG };
    const inferred = [];

    const temp = toNumber(row.water_temperature_start_c);
    if (TEMPERATURE_METHODS.includes(method)) {
      if (temp !== null && temp >= ranges.water_temp_c.minimum && temp <= ranges.water_temp_c.maximum) {
        parameters.water_temp_c = Math.round(temp);
      } else {
        inferred.push('water_temp_c');
      }
    } else if (method === 'cold_brew') {
      parameters.water_temp_special = 'cold';
    }

    const time = toNumber(row.total_recipe_time_s);
    if (time !== null && time >= ranges.brew_time_s.minimum && time <= ranges.brew_time_s.maximum) {
      parameters.brew_time_s = Math.round(time);
    } else {
      inferred.push('brew_time_s');
    }

    const grind = GRIND_WORDS[String(row.grind ?? '').trim().toLowerCase()];
    if (grind !== undefined) {
      parameters.grind_normalised = grind;
    } else {
      inferred.push('grind_normalised');
    }
    candidates.push({ parameters, inferred });
  }

  // Missing numbers take the median of the same method, marked inferred. Never invented otherwise.
  const byMethod = new Map();
  for (const { parameters } of candidates) {
    if (!byMethod.has(parameters.method)) byMethod.set(parameters.method, []);
    byMethod.get(parameters.method).push(parameters);
  }
  const fill = {
    water_temp_c: (v) => Math.round(v),
    brew_time_s: (v) => Math.round(v),
    grind_normalised: (v) => round(v, ranges.grind_normalised.multipleOf),
  };
  for (const { parameters, inferred } of candidates) {
    for (const field of inferred) {
      const known = byMethod.get(parameters.method).map((p) => p[field]).filter((v) => v !== undefined);
      if (known.length > 0) {
        parameters[field] = fill[field](median(known));
        report.inferred[field] = (report.inferred[field] ?? 0) + 1;
      }
    }
  }

  // One recipe per distinct parameter set: related versions of a recipe repeat the same numbers.
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = JSON.stringify(Object.entries(candidate.parameters).sort());
    if (seen.has(key)) {
      report.duplicates += 1;
    } else {
      seen.add(key);
      unique.push({ ...candidate, inferred: candidate.inferred.filter((f) => candidate.parameters[f] !== undefined).sort() });
    }
  }

  // A stable order that does not follow the source's, then ids that name nothing of the source.
  const order = ['method', 'dose_dg', 'water_g', 'water_temp_c', 'brew_time_s', 'grind_normalised'];
  unique.sort((a, b) => {
    for (const k of order) {
      const x = a.parameters[k] ?? -1;
      const y = b.parameters[k] ?? -1;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
  const recipes = unique.map(({ parameters, inferred }, i) => {
    const ordered = Object.fromEntries(order.filter((k) => parameters[k] !== undefined).map((k) => [k, parameters[k]]));
    if (parameters.water_temp_special) ordered.water_temp_special = parameters.water_temp_special;
    return { id: `ref${String(i + 1).padStart(4, '0')}`, parameters: ordered, inferred };
  });
  report.kept = recipes.length;

  // Typical ranges per method: the spread of the published recipes, not a rating.
  const rangesByMethod = {};
  const methods = [...new Set(recipes.map((r) => r.parameters.method))].sort();
  for (const method of methods) {
    const group = recipes.filter((r) => r.parameters.method === method).map((r) => r.parameters);
    const stat = (values) => {
      const sorted = values.filter((v) => v !== undefined).sort((a, b) => a - b);
      return sorted.length === 0 ? null : { p10: clean(percentile(sorted, 0.1)), median: clean(percentile(sorted, 0.5)), p90: clean(percentile(sorted, 0.9)) };
    };
    rangesByMethod[method] = {
      recipes: group.length,
      dose_g: stat(group.map((p) => p.dose_dg / 10)),
      water_g: stat(group.map((p) => p.water_g)),
      ratio_water_per_dose: stat(group.map((p) => p.water_g / (p.dose_dg / 10))),
      water_temp_c: stat(group.map((p) => p.water_temp_c)),
      brew_time_s: stat(group.map((p) => p.brew_time_s)),
      grind_normalised: stat(group.map((p) => p.grind_normalised)),
    };
  }
  return { recipes, ranges: rangesByMethod, report };
}

export function buildDataset(csvText, brew) {
  const { recipes, ranges, report } = convert(parseCsv(csvText), brew);
  return {
    dataset: {
      kind: 'reference_recipes',
      version: DATASET_VERSION,
      vocabulary_version: VOCABULARY_VERSION,
      note: 'Published brew recipes reduced to numbers. Not ratings, not community data.',
      recipes,
      typical_ranges: ranges,
    },
    report,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args.splice(outIndex, 2)[1] : join(here, '..', '..', 'contracts', 'reference', `recipes.v${DATASET_VERSION}.json`);
  const [input] = args;
  if (!input) {
    console.error('usage: node scripts/reference-recipes/convert.mjs <recipes.csv> [--out file]');
    process.exit(2);
  }
  const brew = JSON.parse(readFileSync(join(here, '..', '..', 'contracts', 'vocabulary', `v${VOCABULARY_VERSION}`, 'brew.json'), 'utf8'));
  const { dataset, report } = buildDataset(readFileSync(input, 'utf8'), brew);
  writeFileSync(out, `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`wrote ${dataset.recipes.length} reference recipes to ${out}`);
}
