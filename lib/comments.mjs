export function collectCommentIds(data = {}) {
  const relations = data.commentRelations ?? {};
  const list = [
    ...Object.keys(relations),
    ...(Array.isArray(data.wholeCommentIDs) ? data.wholeCommentIDs : []),
    ...(Array.isArray(data.partCommentIDs) ? data.partCommentIDs : []),
    ...(Array.isArray(data.finishCommentIDs) ? data.finishCommentIDs : []),
  ];
  return [...new Set(list.filter(Boolean))];
}

function parsePosition(position) {
  if (typeof position !== 'string' || !position.trim().startsWith('{')) return position;
  try { return JSON.parse(position); } catch { return position; }
}

function commentBlockId(comment, relation) {
  const position = parsePosition(comment.position);
  return relation?.positionInfo?.blockID
    || position?.positionInfo?.blockID
    || position?.blockID
    || position?.blockId
    || position?.block_id
    || comment.extra?.content_anchor_id
    || null;
}

function cleanCommentContent(value = '') {
  return value
    .replace(/<at[^>]*>@([^<]+)<\/at>/g, '@$1')
    .replace(/\n/g, ' ')
    .trim();
}

export function normalizeCommentThreads(idData = {}, batchData = {}) {
  const relations = idData.commentRelations ?? {};
  const comments = batchData.comments ?? batchData;
  const resolvedIds = new Set(idData.finishCommentIDs ?? []);
  const threads = [];

  for (const id of collectCommentIds(idData)) {
    const relationValues = relations[id]?.relation ? Object.values(relations[id].relation) : [];
    const relation = relationValues[0] ?? null;
    const comment = comments[id] ?? {};
    if (comment.delete_flag) continue;
    const entries = (comment.comment_list ?? [])
      .filter((entry) => !entry.delete_flag && cleanCommentContent(entry.content))
      .map((entry, index) => ({
        name: entry.name || 'Anonymous',
        time: (entry.create_time || '').slice(5, 16),
        content: cleanCommentContent(entry.content),
        isReply: index > 0,
      }));
    if (!entries.length) continue;
    const blockId = commentBlockId(comment, relation);
    const quote = (comment.quote || '').trim();
    const resolved = resolvedIds.has(id) || Boolean(comment.finish);
    const whole = Boolean(comment.is_whole) && !blockId && !quote;
    threads.push({ id, blockId, quote, resolved, whole, entries });
  }
  return threads;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function applyComments(body, threads) {
  if (!threads.length) return body;
  threads.forEach((thread, index) => {
    const marker = `⟦REF${index}⟧`;
    const ref = `<span id="cmt-ref-${index}"><sup><a href="#cmt-note-${index}">【💬${index + 1}】</a></sup></span>`;
    const quote = (thread.quote || '').trim();
    if (quote && body.includes(quote + marker)) {
      body = body.split(quote + marker).join(`<mark>${escapeHtml(quote)}</mark>${ref}`);
    } else if (body.includes(marker)) {
      body = body.split(marker).join(ref);
    } else {
      body += `\n\n${ref}`;
    }
  });
  const notes = threads.map((thread, index) => {
    const status = thread.resolved ? ' <span data-comment-status="resolved">(Resolved)</span>' : '';
    const lines = thread.entries
      .map((entry, entryIndex) => `${entryIndex > 0 ? '<br>↳ ' : ''}<b>${escapeHtml(entry.name)}</b> (${escapeHtml(entry.time)}): ${escapeHtml(entry.content)}`)
      .join('');
    return `<div id="cmt-note-${index}"><b>💬${index + 1}</b>${status} ${lines} <a href="#cmt-ref-${index}">↩ Back to source</a></div>`;
  }).join('\n');
  return body + `\n\n---\n\n## 💬 Comments\n\n${notes}\n`;
}

export function commentStats(threads) {
  return {
    threads: threads.length,
    anchored: threads.filter((thread) => !thread.whole && Boolean(thread.blockId || thread.quote)).length,
    whole: threads.filter((thread) => thread.whole).length,
    resolved: threads.filter((thread) => thread.resolved).length,
    replies: threads.reduce((sum, thread) => sum + thread.entries.filter((entry) => entry.isReply).length, 0),
  };
}
