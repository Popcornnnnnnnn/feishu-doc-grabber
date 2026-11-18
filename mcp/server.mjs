#!/usr/bin/env node
// Minimal Model Context Protocol server over stdio. It exposes the same
// session-scoped Feishu reads as the CLI, so any MCP client can use them.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { formatSearchResults } from '../lib/search.mjs';
import { searchKnowledgeBase } from '../lib/search-backend.mjs';
import { readDocumentWithBrowserOS } from '../lib/browseros.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const TOOLS = [
  {
    name: 'feishu_search',
    description: 'Search Feishu/Lark documents and wiki knowledge bases with the signed-in Chrome session. Returns titles, direct links, wiki spaces, and edit dates. Chat messages are never searched or returned.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Results per page (default 20).' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many results (default 0).' },
        site: { type: 'string', description: 'Workspace page to run in, e.g. https://tenant.feishu.cn/drive/home/ (default: the open Feishu tab).' },
        json: { type: 'boolean', description: 'Return the machine-readable result instead of text.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'feishu_read',
    description: 'Read a Feishu/Lark document, wiki page, sheet, or attached file (.docx, .pdf, text) in the background via BrowserOS neo without touching Chrome or stealing focus. Returns Markdown or plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Document, wiki, sheet, or file link.' },
        format: { type: 'string', enum: ['markdown', 'text'], description: 'Output format (default: markdown).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'feishu_export',
    description: 'Export one or more Feishu/Lark documents to local Markdown with assets and an integrity report.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Document, wiki, or docs links.' },
        out: { type: 'string', description: 'Output directory (default: ~/Downloads).' },
        timeout: { type: 'integer', minimum: 1, description: 'Per-request timeout in seconds (default 180).' },
      },
      required: ['urls'],
    },
  },
];

export async function searchDocuments(args, deps = {}) {
  if (typeof args?.query !== 'string' || !args.query.trim()) throw new Error('query is required.');
  const { result } = await searchKnowledgeBase(args.query, {
    count: args.limit ?? 20, offset: args.offset ?? 0, site: args.site,
  }, deps);
  return result;
}

export async function readDocument(args, deps = {}) {
  if (typeof args?.url !== 'string' || !args.url.trim()) throw new Error('url is required.');
  const format = args.format === 'text' ? 'text' : 'markdown';
  return (deps.readWithBrowserOS ?? readDocumentWithBrowserOS)(args.url.trim(), { format }, deps);
}

export function runExport(args, { cli = fileURLToPath(new URL('../cli.mjs', import.meta.url)), spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [cli, 'export', ...args.urls.map(String), '--out', String(args.out ?? `${process.env.HOME}/Downloads`),
      '--timeout', String(args.timeout ?? 180)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { errors += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output: output.trim(), errors: errors.trim() }));
  });
}

async function callTool(name, args, deps) {
  if (name === 'feishu_search') {
    if (typeof args?.query !== 'string' || !args.query.trim()) throw new Error('query is required.');
    const result = await deps.search(args);
    return args.json ? JSON.stringify(result, null, 2) : formatSearchResults(result);
  }
  if (name === 'feishu_read') {
    if (typeof args?.url !== 'string' || !args.url.trim()) throw new Error('url is required.');
    return await deps.read(args);
  }
  if (name === 'feishu_export') {
    if (!Array.isArray(args?.urls) || !args.urls.length) throw new Error('urls must contain at least one link.');
    const { code, output, errors } = await deps.export(args);
    return `${output || '(no output)'}${errors ? `\n${errors}` : ''}\nexit ${code}`;
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function handleMessage(message, deps) {
  if (!message || typeof message !== 'object' || message.id === undefined) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  try {
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'feishu-grab', title: 'Feishu Grab', version: VERSION },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args } = message.params ?? {};
        try {
          return reply({ content: [{ type: 'text', text: await callTool(name, args ?? {}, deps) }] });
        } catch (error) {
          return reply({ content: [{ type: 'text', text: error.message }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    return fail(-32603, error.message);
  }
}

export async function main({ input = process.stdin, output = process.stdout } = {}) {
  const deps = {
    search: (args) => searchDocuments(args),
    read: (args) => readDocument(args),
    export: (args) => runExport(args),
  };
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const response = await handleMessage(message, deps);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => { process.stderr.write(`feishu-grab-mcp: ${error.message}\n`); process.exitCode = 1; });
}
