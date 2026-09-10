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
