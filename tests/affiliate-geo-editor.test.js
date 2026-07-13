import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expandAffiliateLinkEditorRows,
  groupAffiliateLinksForEditor,
} from '../lib/affiliate-geo-editor.js';

test('same logical link is edited as one row with multiple GEO tags', () => {
  const rows = groupAffiliateLinksForEditor([
    { id: 'global', geo: 'GLOBAL', label: '', destination_url: 'https://tracking.example.test/path' },
    { id: 'at', geo: 'AT', label: '', destination_url: 'https://tracking.example.test/path' },
  ]);

  assert.deepEqual(rows, [{
    geos: ['GLOBAL', 'AT'],
    ids_by_geo: { GLOBAL: 'global', AT: 'at' },
    label: '',
    destination_url: 'https://tracking.example.test/path',
  }]);
});

test('different destinations and labels remain independent editor rows', () => {
  const rows = groupAffiliateLinksForEditor([
    { id: 'global', geo: 'GLOBAL', label: '', destination_url: 'https://tracking.example.test/primary' },
    { id: 'at-backup', geo: 'AT', label: 'Backup', destination_url: 'https://tracking.example.test/backup' },
  ]);

  assert.equal(rows.length, 2);
});

test('GEO tags expand to the existing one-link-per-GEO contract', () => {
  const links = expandAffiliateLinkEditorRows([{
    geos: ['AT', 'GLOBAL', 'AT'],
    ids_by_geo: { GLOBAL: 'global' },
    label: '',
    destination_url: 'https://tracking.example.test/path',
  }]);

  assert.deepEqual(links, [
    { id: 'global', geo: 'GLOBAL', label: '', destination_url: 'https://tracking.example.test/path' },
    { id: '', geo: 'AT', label: '', destination_url: 'https://tracking.example.test/path' },
  ]);
});
