import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appCode, indexHtml, styles] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

test('affiliate catalog remains the primary paginated view', () => {
  assert.ok(indexHtml.indexOf('class="affiliate-catalog"') < indexHtml.indexOf('id="affiliate-form"'));
  assert.match(indexHtml, /id="affiliate-form"[^>]+hidden/);
  assert.doesNotMatch(indexHtml, /id="affiliate-form"[^>]+novalidate/);
  assert.match(indexHtml, /id="affiliate-pagination"/);
  assert.match(indexHtml, /id="affiliate-page-summary" role="status" aria-live="polite"/);
  assert.match(indexHtml, /id="affiliate-filter-reset"/);
  assert.match(appCode, /const AFFILIATE_PAGE_SIZE = 25/);
  assert.match(appCode, /affiliateExpandedIds: new Set\(\)/);
  assert.doesNotMatch(indexHtml, /class="button button-danger delete-affiliate"/);
});

test('affiliate form keeps native validation, labels, and focus recovery', () => {
  assert.match(indexHtml, /pattern="\(\?:\[A-Z\]\{2\}\|GLOBAL\)"/);
  assert.match(indexHtml, /class="affiliate-link-url"[^>]+type="url"[^>]+required/);
  assert.match(appCode, /affiliateForm\.checkValidity\(\)/);
  assert.match(appCode, /affiliateForm\.reportValidity\(\)/);
  assert.match(appCode, /affiliate-link-url-label'\)\.htmlFor = destination\.id/);
  assert.match(appCode, /row\.querySelector\('\.affiliate-link-url'\)\.focus\(\)/);
  assert.match(appCode, /affiliateFormReturnFocusId/);
  assert.match(appCode, /discardAffiliateFormForCatalogReplacement\(\)/);
});

test('affiliate CSS preserves compact list and mobile form order', () => {
  assert.match(styles, /\.affiliate-items\s*\{[^}]*gap:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.affiliate-item\s*\{[^}]*grid-template-areas:\s*"logo copy links actions";/s);
  assert.match(styles, /\.affiliate-link-badge\.is-global/);
  assert.match(styles, /@media \(max-width: 1080px\)/);
  assert.match(styles, /\.affiliate-layout\.is-form-open \.affiliate-form\s*\{[^}]*grid-row:\s*1;/s);
  assert.match(styles, /\.affiliate-layout\.is-form-open \.affiliate-catalog\s*\{[^}]*grid-row:\s*2;/s);
});
