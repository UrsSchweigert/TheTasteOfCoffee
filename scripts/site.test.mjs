// Tests for the companion page in site/ (M2-T38): static, no scripts, no third-party loads,
// and the English and German pages carry the same sections and the same open items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const pages = { en: readFileSync(join(site, 'index.html'), 'utf8'), de: readFileSync(join(site, 'de', 'index.html'), 'utf8') };
const css = readFileSync(join(site, 'style.css'), 'utf8');

// Links the page may point at. Nothing is loaded from anywhere else (no fonts, no scripts).
const ALLOWED_EXTERNAL = [/^https:\/\/testflight\.apple\.com\/join\//, /^https:\/\/world\.openfoodfacts\.org\/legal$/];

for (const [lang, html] of Object.entries(pages)) {
  test(`site (${lang}): no script, no inline handler, no form, no embed`, () => {
    assert.doesNotMatch(html, /<script|<iframe|<form|<input|<object|<embed|\son[a-z]+=/i);
  });

  test(`site (${lang}): every absolute link is an allowed one`, () => {
    const urls = [...html.matchAll(/(?:href|src)="(https?:[^"]+)"/g)].map((m) => m[1]);
    assert.ok(urls.length > 0);
    for (const url of urls) {
      assert.ok(ALLOWED_EXTERNAL.some((re) => re.test(url)), `${lang}: ${url} is not allowed`);
    }
    // Only the one stylesheet of the page.
    assert.equal([...html.matchAll(/<link [^>]*rel="stylesheet"/g)].length, 1);
  });

  test(`site (${lang}): declares its language and a viewport`, () => {
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    assert.match(html, /name="viewport"/);
  });
}

test('site: the stylesheet loads nothing from outside', () => {
  assert.doesNotMatch(css, /@import|url\(|https?:/);
});

test('site: both languages have four sections, a footer outside main, and the same number of open items', () => {
  const ids = (html) => [...html.matchAll(/<section id="([^"]+)"/g)].length;
  assert.equal(ids(pages.en), 4);
  assert.equal(ids(pages.de), 4);
  for (const html of Object.values(pages)) {
    assert.ok(html.indexOf('</main>') < html.indexOf('<footer>'), 'the footer is outside main');
  }
  const todos = (html) => [...html.matchAll(/class="todo"/g)].length;
  assert.equal(todos(pages.en), todos(pages.de));
  assert.equal([...pages.en.matchAll(/<h3>/g)].length, [...pages.de.matchAll(/<h3>/g)].length);
});

// The retention figures of the policy come from the infrastructure, not from memory.
const data = readFileSync(join(site, '..', 'infra', 'src', 'data.ts'), 'utf8');
const constant = (name) => Number(data.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`))?.[1]);
const functions = readFileSync(join(site, '..', 'infra', 'src', 'functions.ts'), 'utf8');

test('site: the retention figures match infra/src', () => {
  assert.equal(constant('DELETION_LOG_EXPIRE_AFTER_DAYS'), 400);
  assert.equal(constant('DELETION_LOG_EXPIRE_AFTER_DAYS') + constant('DELETION_LOG_NONCURRENT_DAYS'), 430);
  assert.equal(constant('VERIFIED_PHOTO_EXPIRE_AFTER_DAYS') + constant('PHOTO_NONCURRENT_DAYS'), 120);
  assert.equal(constant('VERIFIED_PHOTO_EXPIRE_AFTER_DAYS'), 90);
  assert.equal(constant('UPLOAD_EXPIRE_AFTER_DAYS') + constant('UPLOAD_NONCURRENT_DAYS'), 2);
  assert.equal(constant('BACKUP_EXPIRE_AFTER_DAYS') + constant('BACKUP_NONCURRENT_DAYS'), 395);
  assert.match(functions, /LOG_RETENTION = logs\.RetentionDays\.TWO_WEEKS/);
  for (const html of Object.values(pages)) {
    assert.match(html, /400/, 'deletion log days');
    assert.match(html, /\b90\b/, 'verified photo days');
    assert.match(html, /35/, 'point-in-time recovery days');
  }
  assert.match(pages.en, /about 14 months/);
  assert.match(pages.en, /about four months/);
  assert.match(pages.de, /etwa vier Monate/);
  assert.match(pages.de, /etwa 14 Monate/);
  assert.match(pages.en, /two weeks/);
  assert.match(pages.de, /zwei Wochen/);
  assert.match(pages.en, /within about two days/);
  assert.match(pages.de, /etwa zwei Tagen/);
});

test('site: the policy says what the metadata handling really is, and not more', () => {
  // ADR 0016: the raw upload keeps its metadata for about two days.
  assert.doesNotMatch(pages.en, /removed from a photo before it is stored/);
  assert.doesNotMatch(pages.en, /your units/);
  assert.doesNotMatch(pages.de, /Einheiten/);
});

test('site: the facts of the policy match the decisions it states', () => {
  for (const html of Object.values(pages)) {
    assert.match(html, /eu-central-1/);
    assert.match(html, /ODbL/);
  }
  // Five raters before any aggregate (CLAUDE.md invariant 4).
  assert.match(pages.en, /at least five different people/);
  assert.match(pages.de, /mindestens fünf verschiedene Personen/);
});

test('site: the privacy text says brew photos stay on the device and are never uploaded, in both languages (M2-T42b)', () => {
  assert.match(pages.en, /Brew photos stay on the device and are never uploaded\./);
  assert.match(pages.de, /Fotos von Zubereitungen bleiben auf dem Gerät und werden nie hochgeladen\./);
  // M2-T45: the backup setting is Apple's service, off by default, and the pages say so alike.
  assert.match(pages.en, /If you turn on "Include brew photos in the device backup" in Settings, Apple includes them in the backup of that phone \(iCloud or a computer\); that backup \(in iCloud, or made by Apple's software on a computer\) is Apple's service under Apple's terms, and Cupmark does not receive the photos\. The setting is off by default\./);
  assert.match(pages.de, /Wenn Sie in den Einstellungen „Fotos von Zubereitungen in die Gerätesicherung einbeziehen“ einschalten, nimmt Apple sie in die Sicherung dieses iPhones auf \(iCloud oder ein Computer\); diese Sicherung \(in iCloud oder mit der Software von Apple auf einem Computer erstellt\) ist ein Dienst von Apple unter den Bedingungen von Apple, und Cupmark erhält die Fotos nicht\. Die Einstellung ist standardmäßig aus\./);
  // The camera section also says the camera photographs a brew, as the permission prompt does.
  assert.match(pages.en, /to photograph a label or a brew/);
  assert.match(pages.de, /um ein Etikett oder eine Zubereitung zu fotografieren/);
});
