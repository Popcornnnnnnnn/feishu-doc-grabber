const SEARCH_PATH = '/space/api/search/search_wiki/';

const TYPE_PATHS = new Map([[2, 'docs'], [3, 'sheets'], [8, 'base'], [22, 'docx']]);

export function searchURL(source, { query, offset = 0, count = 20 } = {}) {
  const url = new URL(SEARCH_PATH, source);
  url.searchParams.set('query', query);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('count', String(count));
  return url.href;
}

export function documentLink(type, token, origin) {
  const path = TYPE_PATHS.get(Number(type));
  return path ? `${origin}/${path}/${token}` : `${origin}/file/${token}`;
}

export function plainText(value) {
  return String(value ?? '')
    .replace(/<\/?em>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseSearchResults(payload, origin) {
  const data = payload?.data ?? {};
  const items = Object.values(data.entities?.objs ?? {}).map((object) => {
    const wiki = Array.isArray(object.wiki_infos) ? object.wiki_infos[0] : null;
    return {
      title: plainText(object.title),
      token: object.token,
      type: Number(object.type),
      url: wiki?.wiki_url || object.url || documentLink(object.type, object.token, origin),
      space: wiki?.space_name || '',
      author: object.edit_name || object.author || '',
      editedAt: object.edit_time ? new Date(Number(object.edit_time) * 1000).toISOString() : null,
      preview: plainText(object.preview),
    };
  });
  return { total: Number(data.total ?? items.length), hasMore: Boolean(data.has_more), items };
}

export function formatSearchResults({ total, hasMore, items }) {
  if (!items.length) return 'No matching documents.\n';
  const lines = items.map((item) => {
    const where = item.space ? `  [${item.space}]` : '';
    const author = item.author ? `  @${item.author}` : '';
    const edited = item.editedAt ? `  ${item.editedAt.slice(0, 10)}` : '';
    const preview = item.preview ? `\n  > ${item.preview.replace(/\s+/g, ' ').trim()}` : '';
    return `${item.title}\n  ${item.url}${where}${author}${edited}${preview}\n`;
  });
  return `${items.length} of ${total} result(s)${hasMore ? ' (more available)' : ''}:\n` + lines.join('');
}
