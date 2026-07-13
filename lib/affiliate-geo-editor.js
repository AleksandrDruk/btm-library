function sortedGeos(values) {
  return [...new Set(values)].sort((left, right) => {
    if (left === 'GLOBAL') return -1;
    if (right === 'GLOBAL') return 1;
    return left.localeCompare(right, 'en');
  });
}

export function groupAffiliateLinksForEditor(links) {
  const groups = new Map();

  links.forEach((link) => {
    const label = String(link.label || '');
    const destinationUrl = String(link.destination_url || '');
    const key = JSON.stringify([label, destinationUrl]);
    let group = groups.get(key);
    if (!group) {
      group = {
        geos: [],
        ids_by_geo: {},
        label,
        destination_url: destinationUrl,
      };
      groups.set(key, group);
    }

    const geo = String(link.geo || 'GLOBAL');
    group.geos.push(geo);
    group.ids_by_geo[geo] = String(link.id || '');
  });

  return [...groups.values()].map((group) => ({
    ...group,
    geos: sortedGeos(group.geos),
  }));
}

export function expandAffiliateLinkEditorRows(rows) {
  return rows.flatMap((row) => {
    const idsByGeo = row.ids_by_geo && typeof row.ids_by_geo === 'object'
      ? row.ids_by_geo
      : {};
    const geos = Array.isArray(row.geos)
      ? sortedGeos(row.geos.map((geo) => String(geo || '')))
      : [];

    return geos.map((geo) => ({
      id: typeof idsByGeo[geo] === 'string' ? idsByGeo[geo] : '',
      geo,
      label: String(row.label || ''),
      destination_url: String(row.destination_url || ''),
    }));
  });
}
