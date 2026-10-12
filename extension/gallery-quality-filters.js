// All QA filters consume the same unresolved issues as the badge and viewer.
export function matchesGalleryQualityFilter(record, filter, issues = []) {
  if (!filter || filter === 'all') return true;
  const own = issues.filter(issue => issue.sourceId === record.sourceId
    && issue.generationId === record.generationId && !issue.resolved);
  const codes = new Set(own.map(issue => issue.code));
  switch (filter) {
    case 'warnings': return own.length > 0;
    case 'extraction': return own.some(issue => issue.category === 'extraction');
    case 'quality_issues': return own.some(issue => issue.category === 'value');
    case 'variants': return own.some(issue => issue.category === 'variants');
    case 'error': return own.some(issue => issue.category === 'extraction'
      && /(?:ERROR|INCOMPLETE_RESPONSE)/.test(issue.code));
    case 'missing': return codes.has('EMPTY_FACTS') || codes.has('MISSING_FACTS');
    case 'missing_series': return own.some(issue => /^TITLE_/.test(issue.code)
      || ['MISSING_TITLE_BRAND', 'MISSING_TITLE_MODEL', 'MISSING_SERIES'].includes(issue.code));
    case 'missing_utp': return own.some(issue => ['utp1', 'utp2'].includes(issue.field));
    case 'missing_water': return own.some(issue => issue.field === 'waterResistance');
    case 'missing_size': return own.some(issue => issue.field === 'caseSize');
    default: return true;
  }
}
