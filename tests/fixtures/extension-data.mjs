export const sourceURL = 'https://fixture.feishu.cn/docx/ExtensionFixture';
export const imageBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ZkAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
export const attachmentBytes = new TextEncoder().encode('Attachment contents Ω\n');
const paragraph = (id, value) => ({ id, data: { type: 'text', parent_id: 'page', text: { initialAttributedTexts: { text: { 0: value } } } } });

export function fixtureData() {
  return {
    id: 'page', has_more: true, next_cursors: ['tail'],
    meta_map: { page: { title: 'Extension fixture Ω' } },
    block_map: {
      page: { id: 'page', data: { type: 'page', children: ['intro', 'image', 'file'] } },
      intro: paragraph('intro', 'FIRST-PAGE-SENTINEL'),
      image: { id: 'image', data: { type: 'image', parent_id: 'page', image: { token: 'FixtureImage', name: 'pixel.png' } } },
      file: { id: 'file', data: { type: 'file', parent_id: 'page', file: { token: 'FixtureFile', name: '../../notes Ω.txt' } } },
    },
  };
}
export function responseFor(url, { scenario = 'complete' } = {}) {
  const target = new URL(url);
  if (target.pathname.startsWith('/space/api/wiki/v2/tree/get_node')) {
    const objType = ['bitable-node', 'bitable'].includes(scenario) ? 8 : 22;
    return { type: 'application/json', body: JSON.stringify({ code: 0, data: { obj_type: objType, obj_token: scenario === 'bitable' ? 'BitableApp' : 'ExtensionFixture', title: '任务管理' } }) };
  }
  if (target.pathname.startsWith('/space/api/bitable/')) {
    if (/tables\/?$/.test(target.pathname)) {
      return { type: 'application/json', body: JSON.stringify({ code: 0, data: { items: [{ table_id: 'tblA', name: '任务' }, { table_id: 'tblB', name: '人员' }] } }) };
    }
    if (target.pathname.endsWith('/fields')) {
      return { type: 'application/json', body: JSON.stringify({ code: 0, data: { items: [
        { field_name: '任务描述', type: 1 }, { field_name: '截止日期', type: 5 },
        { field_name: '负责人', type: 11 }, { field_name: '数量', type: 2 },
      ] } }) };
    }
    if (target.pathname.endsWith('/records/search')) {
      return { type: 'application/json', body: JSON.stringify({ code: 0, data: { items: [
        { record_id: 'r1', fields: { 任务描述: [{ type: 'text', text: '写报告' }], 截止日期: 1700000000000, 负责人: [{ name: '张三' }], 数量: 42 } },
        { record_id: 'r2', fields: { 任务描述: [{ type: 'text', text: '带"引号",和逗号' }] } },
      ], has_more: false, total: 2 } }) };
    }
  }
  if (target.pathname.startsWith('/space/api/bitable/') && target.pathname.endsWith('/tablesv3/')) {
    const fieldMap = {
      fldDesc: { name: '任务描述', type: 1 },
      fldDate: { name: '截止日期', type: 5 },
      fldOwner: { name: '负责人', type: 11 },
      fldNum: { name: '数量', type: 2 },
      fldStatus: { name: '状态', type: 3, property: { options: [{ id: 'optDone', name: '已完成' }, { id: 'optTodo', name: '进行中' }] } },
    };
    const viewMap = { vewMain: { name: '表格', type: 1, property: { fields: ['fldDesc', 'fldDate', 'fldOwner', 'fldNum', 'fldStatus'] } } };
    return { type: 'application/json', body: JSON.stringify({ code: 0, data: { tblA: { meta: { rev: 7, recordsNum: 2 }, fieldMap, viewMap } } }) };
  }
  if (target.pathname.startsWith('/space/api/v1/bitable/')) {
    const recordMap = {
      rec1: {
        fldDesc: { value: [{ type: 'text', text: '写报告' }] },
        fldDate: { value: 1700000000000 },
        fldOwner: { value: { users: [{ name: '张三' }] } },
        fldNum: { value: 42 },
        fldStatus: { value: 'optDone' },
      },
      rec2: { fldDesc: { value: [{ type: 'text', text: '带"引号",和逗号' }] } },
    };
    return { type: 'application/json', body: JSON.stringify({ code: 0, data: { records: { tableRecordNum: 2, groupList: [{ recordIDList: ['rec1', 'rec2'], firstRecordOffset: 0 }], recordMap } } }) };
  }
  if (target.pathname.startsWith('/docx/') || target.pathname.startsWith('/wiki/') || target.pathname.startsWith('/docs/')) {
    const data = fixtureData();
    if (target.pathname === '/docx/SecondFixture') data.meta_map.page.title = 'Second document';
    if (scenario === 'unknown-pagination') { delete data.has_more; data.next_cursors = []; }
    if (scenario === 'missing-block') data.block_map.page.data.children.push('missing-paragraph');
    if (scenario === 'whiteboard') {
      data.block_map.page.data.children.push('board');
      data.block_map.board = { id: 'board', data: { type: 'whiteboard', parent_id: 'page', token: 'FixtureBoard' } };
    }
    return { type: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>${data.meta_map.page.title}</title><h1>Export test document</h1><script>window.DATA = {clientVars: Object(${JSON.stringify({ data })})};</script>` };
  }
  let data;
  if (target.pathname === '/space/api/docx/pages/client_vars') {
    if (scenario === 'pagination-failure') return { status: 403, body: '{}' };
    data = { has_more: false, next_cursors: [], block_sequence: ['tail'], block_map: { tail: paragraph('tail', 'LAST-PAGE-SENTINEL') } };
  } else if (target.pathname === '/space/api/comment/commentid/all') {
    if (scenario === 'comment-failure') return { status: 403, body: '{}' };
    data = { wholeCommentIDs: [], partCommentIDs: ['comment1'], commentRelations: { comment1: { positionInfo: { blockID: 'intro' } } } };
  } else if (target.pathname === '/space/api/comment/batch') {
    data = { comments: { comment1: { quote: 'FIRST-PAGE-SENTINEL', comment_list: [
      { name: 'Reviewer', content: 'COMMENT-SENTINEL <script>not executable</script>', time: '2026-09-16' },
      { name: 'Author', content: 'REPLY-SENTINEL', time: '2026-09-16' },
    ] } } };
  } else if (target.pathname.includes('/download/preview/FixtureImage/')) {
    if (scenario === 'media-failure') return { type: 'application/json', body: '{"code":403,"message":"Access denied"}' };
    return { type: 'image/png', body: imageBytes };
  } else if (target.pathname.includes('/download/preview/FixtureFile/')) {
    return { type: 'application/octet-stream', body: attachmentBytes };
  } else throw new Error(`Unexpected fixture request: ${target.pathname}`);
  return { type: 'application/json', body: JSON.stringify({ code: 0, data }) };
}

export function fixtureTransport(options = {}) {
  return {
    async request(url) {
      const result = responseFor(url, options);
      if (result.status >= 400) throw new Error(`HTTP ${result.status}`);
      return result.body;
    },
    async media(url) {
      const result = responseFor(url, options);
      return { bytes: typeof result.body === 'string' ? new TextEncoder().encode(result.body) : result.body, contentType: result.type };
    },
    async bitableTables() {
      return options.scenario === 'bitable' ? [{ id: 'tblA', name: '任务' }] : [];
    },
  };
}
