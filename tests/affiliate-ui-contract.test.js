import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appCode, frameGuardCode, indexHtml, styles] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../frame-guard.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

test('production page hides controls until an early top-level frame guard runs', () => {
  assert.match(indexHtml, /<html lang="ru" class="btm-frame-blocked">/);
  assert.ok(indexHtml.indexOf('./frame-guard.js') < indexHtml.indexOf('challenges.cloudflare.com/turnstile/'));
  assert.doesNotMatch(indexHtml, /http:\/\/(?:127\.0\.0\.1|localhost):/);
  assert.match(frameGuardCode, /globalThis\.top === globalThis\.self/);
  assert.match(frameGuardCode, /classList\.remove\('btm-frame-blocked'\)/);
  assert.match(styles, /\.btm-frame-blocked body\s*\{[^}]*display:\s*none;/s);
});

test('affiliate catalog remains the primary paginated view', () => {
  assert.match(indexHtml, /Управлять GEO-ссылками брендов/);
  assert.doesNotMatch(indexHtml, /Управлять GEO-ссылками и вариантами брендов/);
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
  const linkEditorTemplate = indexHtml.match(/<template id="affiliate-link-editor-template">([\s\S]*?)<\/template>/)?.[1] || '';
  assert.ok(linkEditorTemplate.indexOf('affiliate-link-url-field') < linkEditorTemplate.indexOf('affiliate-link-geo-field'));
  assert.match(indexHtml, /class="affiliate-link-geo-tags" role="list"/);
  assert.match(indexHtml, /class="affiliate-link-geo-hint"/);
  assert.match(linkEditorTemplate, /class="affiliate-link-label" type="hidden"/);
  assert.doesNotMatch(linkEditorTemplate, /Вариант|affiliate-link-variant-label/);
  assert.match(indexHtml, /\+ Добавить другой URL/);
  assert.doesNotMatch(indexHtml, /class="affiliate-link-geo"[^>]+required/);
  assert.match(appCode, /row\.setAttribute\('role', 'group'\)/);
  assert.match(appCode, /remove\.hidden = !hasMultipleRows/);
  assert.match(appCode, /validateAffiliateGeoRows\(\)/);
  assert.match(appCode, /groupAffiliateLinksForEditor\(item\.links\)/);
  assert.match(appCode, /expandAffiliateLinkEditorRows\(rows\)/);
  assert.match(indexHtml, /class="affiliate-link-url"[^>]+type="url"[^>]+required/);
  assert.match(appCode, /affiliateForm\.checkValidity\(\)/);
  assert.match(appCode, /affiliateForm\.reportValidity\(\)/);
  assert.match(appCode, /affiliate-link-url-label'\)\.htmlFor = destination\.id/);
  assert.match(appCode, /row\.querySelector\('\.affiliate-link-url'\)\.focus\(\)/);
  assert.match(appCode, /affiliateFormReturnFocusId/);
  assert.match(appCode, /discardAffiliateFormForCatalogReplacement\(\)/);
});

test('duplicate brand guidance directs creation to the existing catalog entry', () => {
  assert.match(indexHtml, /id="affiliate-existing-brand"[^>]+role="status"[^>]+aria-live="polite"[^>]+hidden/);
  assert.match(indexHtml, /id="affiliate-open-existing-brand"[^>]+type="button"/);
  assert.match(appCode, /affiliateBrandKey\(elements\.affiliateBrand\.value\)/);
  assert.match(appCode, /item\.id !== state\.affiliateEditingId/);
  assert.match(appCode, /affiliateBrand\.setCustomValidity\(existingItem/);
  assert.match(appCode, /Boolean\(state\.affiliateDuplicateBrandId\)/);
  assert.match(appCode, /editAffiliateItem\(item, `btm-affiliate-edit-\$\{item\.id\}`\)/);
});

test('affiliate CSS preserves compact list and mobile form order', () => {
  assert.match(styles, /\.affiliate-items\s*\{[^}]*gap:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.affiliate-item\s*\{[^}]*grid-template-areas:\s*"logo copy links actions";/s);
  assert.match(styles, /\.affiliate-link-badge\.is-global/);
  assert.match(styles, /\.affiliate-link-editor-row\s*\{[^}]*grid-template-columns:\s*1fr;[^}]*align-items:\s*start;/s);
  assert.match(styles, /\.affiliate-link-geo-tags\s*\{[^}]*display:\s*flex;/s);
  assert.match(styles, /@media \(max-width: 1080px\)/);
  assert.match(styles, /\.affiliate-layout\.is-form-open \.affiliate-form\s*\{[^}]*grid-row:\s*1;/s);
  assert.match(styles, /\.affiliate-layout\.is-form-open \.affiliate-catalog\s*\{[^}]*grid-row:\s*2;/s);
});

test('additional affiliate links use an integrated disclosure control', () => {
  assert.match(appCode, /Показать ещё \$\{formatAdditionalLinkCount\(logicalLinks\.length - 1\)\}/);
  assert.match(appCode, /Свернуть дополнительные ссылки/);
  assert.match(appCode, /affiliate-links-toggle-icon/);
  assert.match(appCode, /const logicalLinks = groupAffiliateLinksForEditor\(item\.links\)/);
  assert.match(appCode, /groupAffiliateLinksForEditor\(item\.links\)\.length/);
  assert.match(appCode, /affiliate-link-geos/);
  assert.match(styles, /\.affiliate-item-links\s*\{[^}]*grid-template-columns:\s*70px minmax\(0, 1fr\);/s);
  assert.match(styles, /\.affiliate-link-geos\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s);
  assert.match(styles, /\.affiliate-links-toggle\s*\{[^}]*grid-column:\s*2;[^}]*border-radius:\s*999px;/s);
});
