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

test('site: both languages have the same sections and the same number of open items', () => {
  const ids = (html) => [...html.matchAll(/<section id="([^"]+)"/g)].length;
  assert.equal(ids(pages.en), 4);
  assert.equal(ids(pages.de), 4);
  const todos = (html) => [...html.matchAll(/class="todo"/g)].length;
  assert.equal(todos(pages.en), todos(pages.de));
  assert.equal([...pages.en.matchAll(/<h3>/g)].length, [...pages.de.matchAll(/<h3>/g)].length);
});

test('site: the facts of the policy match the decisions it states', () => {
  for (const html of Object.values(pages)) {
    assert.match(html, /eu-central-1/);
    assert.match(html, /35/);
    assert.match(html, /ODbL/);
  }
  // Five raters before any aggregate (CLAUDE.md invariant 4).
  assert.match(pages.en, /at least five different people/);
  assert.match(pages.de, /mindestens fünf verschiedene Personen/);
});
