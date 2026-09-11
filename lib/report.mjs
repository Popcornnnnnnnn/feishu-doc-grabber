import { basename } from 'node:path';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function retryableDocuments(report) {
  return (report?.documents ?? []).filter((document) =>
    document.operationalStatus !== 'success' || document.integrity?.verdict !== 'complete');
}

export function renderResultPage(report) {
  const documents = report?.documents ?? [];
  const generatedAt = report?.generatedAt
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(report.generatedAt))
    : '';
  const counts = { complete: 0, degraded: 0, incomplete: 0, failed: 0 };
  const rows = documents.map((document) => {
    const status = document.operationalStatus === 'success'
      ? document.integrity?.verdict ?? 'incomplete'
      : 'failed';
    counts[status] = (counts[status] ?? 0) + 1;
    const name = document.output ? basename(document.output) : new URL(document.url).pathname.split('/').filter(Boolean).pop();
    const output = document.output
      ? `<a href="${encodeURIComponent(basename(document.output))}">打开导出文件</a>`
      : '<span class="muted">没有输出文件</span>';
    const checks = (document.integrity?.checks ?? [])
      .filter((check) => check.status !== 'pass')
      .map((check) => `<li><b>${escapeHtml(check.name)}</b>：${escapeHtml(check.detail)}</li>`)
      .join('');
    const detail = document.error
      ? `<div class="error">${escapeHtml(document.error)}</div>`
      : checks ? `<ul>${checks}</ul>` : '<span class="muted">所有完整性检查通过</span>';
    return `<article class="result ${escapeHtml(status)}">
      <div class="result-head"><div><h2>${escapeHtml(name)}</h2><a class="source" href="${escapeHtml(document.url)}">源文档</a></div><span class="badge">${escapeHtml(status)}</span></div>
      <div class="output">${output}</div>${detail}
    </article>`;
  }).join('\n');
  const retryCount = retryableDocuments(report).length;
  const retry = retryCount
    ? `<section class="retry"><h2>需要重试 ${retryCount} 篇</h2><p><a href="retry-urls.txt">查看重试清单</a></p><code>feishu-grab --retry export-report.json --out retry-output</code></section>`
    : '<section class="retry done"><h2>全部完成</h2><p>没有需要重试的文档。</p></section>';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feishu export results</title><style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#172033}
*{box-sizing:border-box}body{margin:0}.page{max-width:960px;margin:0 auto;padding:48px 24px 72px}h1{font-size:32px;margin:0 0 8px}.meta,.muted{color:#697386}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.metric,.result,.retry{background:#fff;border:1px solid #e4e7ec;border-radius:14px;padding:18px;box-shadow:0 1px 2px #1018280d}.metric b{display:block;font-size:28px}.metric span{color:#697386}.results{display:grid;gap:14px}.result{border-left:5px solid #98a2b3}.result.complete{border-left-color:#12b76a}.result.degraded{border-left-color:#f79009}.result.incomplete,.result.failed{border-left-color:#f04438}.result-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.result h2,.retry h2{font-size:18px;margin:0 0 5px}.source{font-size:13px}.badge{text-transform:uppercase;font-size:12px;font-weight:700;letter-spacing:.04em;background:#f2f4f7;border-radius:999px;padding:6px 9px}.output{margin:16px 0 10px}.error{color:#b42318}ul{margin:10px 0 0;padding-left:20px;color:#475467}.retry{margin-top:24px}.retry code{display:block;margin-top:12px;padding:12px;border-radius:8px;background:#101828;color:#fff;overflow:auto}.retry.done{border-color:#abefc6}a{color:#175cd3;text-decoration:none}a:hover{text-decoration:underline}
@media(max-width:680px){.summary{grid-template-columns:repeat(2,1fr)}.page{padding:28px 16px}.result-head{align-items:flex-start}}
@media(prefers-color-scheme:dark){:root{background:#101828;color:#f2f4f7}.metric,.result,.retry{background:#1d2939;border-color:#344054}.meta,.muted,.metric span{color:#98a2b3}.badge{background:#344054}.source,a{color:#84adff}}
</style></head><body><main class="page">
<h1>飞书导出结果</h1><p class="meta">${escapeHtml(generatedAt)} · 共 ${documents.length} 篇</p>
<section class="summary">
  <div class="metric"><b>${counts.complete}</b><span>Complete</span></div>
  <div class="metric"><b>${counts.degraded}</b><span>Degraded</span></div>
  <div class="metric"><b>${counts.incomplete}</b><span>Incomplete</span></div>
  <div class="metric"><b>${counts.failed}</b><span>Failed</span></div>
</section>
<section class="results">${rows || '<p class="muted">没有文档结果。</p>'}</section>
${retry}
</main></body></html>\n`;
}
