#!/usr/bin/env node
// Checks the hand-written Xcode project on Linux (M2-T33), so a broken
// project file fails before a Mac ever opens it:
// - ios/Cupmark.xcodeproj/project.pbxproj parses as an old-style plist, and
//   no object id is defined twice (also no key twice in any dictionary);
// - every object id the file references (lists, build phases, dependencies,
//   productReference, buildConfigurationList, remoteGlobalIDString,
//   TargetAttributes, rootObject, ...) is defined;
// - every native target has a configuration list with a Debug and a Release
//   configuration, build phases that exist, a product reference, and target
//   dependencies whose proxy points at the target they name; every target is in
//   the project's target list and TargetAttributes;
// - a unit-test target has TEST_HOST, a UI-test target has TEST_TARGET_NAME
//   and no TEST_HOST, and both name their app in TestTargetID;
// - the shared Cupmark scheme references existing targets by id, name and
//   product, and its TestAction lists every test target of the project.
//
// Needs Node 22 and nothing else.
// Usage: node scripts/check-xcode-project.mjs
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_FILE = join(root, 'ios', 'Cupmark.xcodeproj', 'project.pbxproj');
export const SCHEME_FILE = join(root, 'ios', 'Cupmark.xcodeproj', 'xcshareddata', 'xcschemes', 'Cupmark.xcscheme');

const ID = /^[0-9A-F]{24}$/;
const TEST_TYPES = {
  'com.apple.product-type.bundle.unit-test': 'unit',
  'com.apple.product-type.bundle.ui-testing': 'ui',
};
const APP_TYPE = 'com.apple.product-type.application';

/**
 * Parses an old-style (OpenStep) plist as Xcode writes project.pbxproj.
 * Dictionaries become objects, arrays arrays, every scalar a string. Throws
 * on a syntax error and on a key defined twice in one dictionary (which is how
 * a duplicated object id shows).
 */
export function parsePbxproj(text) {
  let i = 0;
  const n = text.length;
  const fail = (message) => {
    const line = text.slice(0, i).split('\n').length;
    throw new Error(`project.pbxproj:${line}: ${message}`);
  };
  const skip = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i += 1;
      if (text.startsWith('//', i)) {
        const eol = text.indexOf('\n', i);
        i = eol === -1 ? n : eol;
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end === -1) fail('unterminated comment');
        i = end + 2;
      } else {
        return;
      }
    }
  };
  const scalar = () => {
    if (text[i] === '"') {
      let out = '';
      i += 1;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') {
          out += text[i + 1] ?? '';
          i += 2;
        } else {
          out += text[i];
          i += 1;
        }
      }
      if (i >= n) fail('unterminated string');
      i += 1;
      return out;
    }
    const start = i;
    while (i < n && !/[\s{}()=;,"]/.test(text[i]) && !text.startsWith('/*', i)) i += 1;
    if (i === start) fail(`unexpected ${JSON.stringify(text[i] ?? 'end of file')}`);
    return text.slice(start, i);
  };
  const expect = (ch) => {
    skip();
    if (text[i] !== ch) fail(`expected ${ch}, found ${JSON.stringify(text[i] ?? 'end of file')}`);
    i += 1;
  };
  const value = () => {
    skip();
    if (text[i] === '{') {
      i += 1;
      const dict = {};
      for (;;) {
        skip();
        if (text[i] === '}') {
          i += 1;
          return dict;
        }
        const key = scalar();
        if (Object.hasOwn(dict, key)) fail(`${key} is defined twice`);
        expect('=');
        dict[key] = value();
        expect(';');
      }
    }
    if (text[i] === '(') {
      i += 1;
      const list = [];
      for (;;) {
        skip();
        if (text[i] === ')') {
          i += 1;
          return list;
        }
        list.push(value());
        skip();
        if (text[i] === ',') i += 1;
        else if (text[i] !== ')') fail('expected , or )');
      }
    }
    return scalar();
  };
  const result = value();
  skip();
  if (i !== n) fail('text after the root dictionary');
  return result;
}

/** Every string anywhere in `node` that looks like an object id, with the key path it sits at. */
function referencedIDs(node, path = [], out = []) {
  if (typeof node === 'string') {
    if (ID.test(node)) out.push({ id: node, path: path.join('.') });
  } else if (Array.isArray(node)) {
    node.forEach((item, index) => referencedIDs(item, [...path, String(index)], out));
  } else if (node && typeof node === 'object') {
    for (const [key, item] of Object.entries(node)) {
      // A TargetAttributes key is a target id.
      if (ID.test(key) && path.at(-1) === 'TargetAttributes') out.push({ id: key, path: [...path, key].join('.') });
      referencedIDs(item, [...path, key], out);
    }
  }
  return out;
}

/** The BuildableReference elements of a scheme, with whether each sits inside <TestAction>. */
export function schemeReferences(schemeText) {
  const refs = [];
  const testStart = schemeText.indexOf('<TestAction');
  const testEnd = schemeText.indexOf('</TestAction>');
  for (const match of schemeText.matchAll(/<BuildableReference\b([^>]*)>/g)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([A-Za-z]+)\s*=\s*"([^"]*)"/g)) attrs[attr[1]] = attr[2];
    const inTestAction = testStart !== -1 && match.index > testStart && match.index < testEnd;
    // Only a reference directly under <TestableReference> is a test target of the action.
    const before = schemeText.slice(0, match.index);
    const testable = inTestAction && before.lastIndexOf('<TestableReference') > before.lastIndexOf('</TestableReference>');
    refs.push({ ...attrs, inTestAction, testable });
  }
  return refs;
}

/** Problems with the project file and the shared scheme. Empty when both are consistent. */
export function checkXcodeProject(projectText, schemeText) {
  const problems = [];
  let project;
  try {
    project = parsePbxproj(projectText);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const objects = project.objects;
  if (!objects || typeof objects !== 'object' || Array.isArray(objects)) return ['project.pbxproj has no objects dictionary'];
  for (const id of Object.keys(objects)) {
    if (!ID.test(id)) problems.push(`object key ${id} is not a 24-digit hex id`);
  }
  for (const { id, path } of referencedIDs(project)) {
    if (path === `objects.${id}`) continue;
    if (!Object.hasOwn(objects, id)) problems.push(`${path} references ${id}, which is not defined`);
  }
  const isa = (id, kind) => objects[id]?.isa === kind;
  const rootObject = objects[project.rootObject];
  if (!isa(project.rootObject, 'PBXProject')) {
    problems.push('rootObject is not a PBXProject');
    return problems;
  }
  const targets = Object.entries(objects).filter(([, object]) => object.isa === 'PBXNativeTarget');
  const listed = rootObject.targets ?? [];
  const attributes = rootObject.attributes?.TargetAttributes ?? {};
  const settings = (target, name) => {
    const list = objects[target.buildConfigurationList];
    return (list?.buildConfigurations ?? []).map((id) => ({ name: objects[id]?.name, values: objects[id]?.buildSettings ?? {} }))
      .filter((config) => name === undefined || config.name === name);
  };
  for (const [id, target] of targets) {
    const label = `target ${target.name ?? id}`;
    if (!listed.includes(id)) problems.push(`${label} is not in the project's targets list`);
    if (!Object.hasOwn(attributes, id)) problems.push(`${label} has no TargetAttributes entry`);
    if (!isa(target.buildConfigurationList, 'XCConfigurationList')) {
      problems.push(`${label} has no configuration list`);
    } else {
      const names = settings(target).map((config) => config.name);
      for (const wanted of ['Debug', 'Release']) {
        if (!names.includes(wanted)) problems.push(`${label} has no ${wanted} configuration`);
      }
    }
    const phases = (target.buildPhases ?? []).map((phase) => objects[phase]?.isa);
    for (const wanted of ['PBXSourcesBuildPhase', 'PBXFrameworksBuildPhase', 'PBXResourcesBuildPhase']) {
      if (phases.filter((kind) => kind === wanted).length !== 1) problems.push(`${label} needs exactly one ${wanted}`);
    }
    if (!isa(target.productReference, 'PBXFileReference')) problems.push(`${label} has no product reference`);
    for (const group of target.fileSystemSynchronizedGroups ?? []) {
      if (!isa(group, 'PBXFileSystemSynchronizedRootGroup')) problems.push(`${label} lists ${group}, which is not a synchronized group`);
    }
    for (const dependency of target.dependencies ?? []) {
      const object = objects[dependency];
      if (object?.isa !== 'PBXTargetDependency') {
        problems.push(`${label} dependency ${dependency} is not a PBXTargetDependency`);
        continue;
      }
      const proxy = objects[object.targetProxy];
      if (!isa(object.target, 'PBXNativeTarget')) problems.push(`${label} depends on ${object.target}, which is not a target`);
      if (proxy?.isa !== 'PBXContainerItemProxy' || proxy.remoteGlobalIDString !== object.target || proxy.containerPortal !== project.rootObject) {
        problems.push(`${label} dependency ${dependency} has a proxy that does not point at ${object.target} in this project`);
      }
    }
    const kind = TEST_TYPES[target.productType];
    if (kind !== undefined) {
      const host = attributes[id]?.TestTargetID;
      const app = objects[host];
      if (app?.isa !== 'PBXNativeTarget' || app.productType !== APP_TYPE) {
        problems.push(`${label} has no TestTargetID naming the app target`);
      } else if (!(target.dependencies ?? []).some((dependency) => objects[dependency]?.target === host)) {
        problems.push(`${label} does not depend on its app target ${app.name}`);
      }
      for (const config of settings(target)) {
        const where = `${label} ${config.name}`;
        if (kind === 'unit' && config.values.TEST_HOST === undefined) problems.push(`${where}: a unit-test target needs TEST_HOST`);
        if (kind === 'ui') {
          if (config.values.TEST_HOST !== undefined) problems.push(`${where}: a UI-test target must not set TEST_HOST`);
          if (app && config.values.TEST_TARGET_NAME !== app.name) problems.push(`${where}: TEST_TARGET_NAME must be ${app?.name}`);
        }
      }
    }
  }
  for (const id of listed) {
    if (!isa(id, 'PBXNativeTarget')) problems.push(`targets list names ${id}, which is not a native target`);
  }

  const refs = schemeReferences(schemeText);
  if (refs.length === 0) problems.push('Cupmark.xcscheme has no BuildableReference');
  for (const ref of refs) {
    const target = objects[ref.BlueprintIdentifier];
    const product = objects[target?.productReference];
    if (target?.isa !== 'PBXNativeTarget') {
      problems.push(`Cupmark.xcscheme references ${ref.BlueprintIdentifier}, which is not a target`);
    } else {
      if (ref.BlueprintName !== target.name) problems.push(`Cupmark.xcscheme names ${ref.BlueprintIdentifier} ${ref.BlueprintName}, the project ${target.name}`);
      if (ref.BuildableName !== product?.path) problems.push(`Cupmark.xcscheme builds ${ref.BuildableName} for ${target.name}, the project ${product?.path}`);
    }
    if (ref.ReferencedContainer !== 'container:Cupmark.xcodeproj') problems.push(`Cupmark.xcscheme references a container other than Cupmark.xcodeproj: ${ref.ReferencedContainer}`);
  }
  const testables = refs.filter((ref) => ref.testable).map((ref) => ref.BlueprintIdentifier);
  for (const [id, target] of targets) {
    if (TEST_TYPES[target.productType] !== undefined && !testables.includes(id)) {
      problems.push(`Cupmark.xcscheme TestAction does not list the test target ${target.name}`);
    }
  }
  if (new Set(testables).size !== testables.length) problems.push('Cupmark.xcscheme TestAction lists a target twice');
  return problems;
}

function main() {
  const problems = checkXcodeProject(readFileSync(PROJECT_FILE, 'utf8'), readFileSync(SCHEME_FILE, 'utf8'));
  if (problems.length > 0) {
    console.error('check-xcode-project: FAILED');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const project = parsePbxproj(readFileSync(PROJECT_FILE, 'utf8'));
  const names = project.objects[project.rootObject].targets.map((id) => project.objects[id].name);
  console.log(`check-xcode-project: ok (targets ${names.join(', ')})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
