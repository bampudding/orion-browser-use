import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

const server = new URL('../plugins/orion-browser-use/server/index.mjs', import.meta.url);

test('Orion MCP exposes a persistent JavaScript REPL and reset', async () => {
  const child = spawn(process.execPath, [server.pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => stderr.push(chunk));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
    replies.delete(message.id);
  });
  let id = 0;
  const request = (method, params = {}) => {
    const next = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out: ${method}\n${stderr.join('')}`)), 5000);
      replies.set(next, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
    });
  };
  const js = async code => {
    const message = await request('tools/call', { name: 'js', arguments: { title: 'test', code } });
    assert.equal(message.result.isError, undefined);
    return message.result.structuredContent;
  };
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(initialized.result.serverInfo.name, 'orion-browser-use');
    const listed = await request('tools/list');
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ['js', 'js_reset']);
    assert.equal((await js('var saved = 41; saved + 1')).value, 42);
    assert.equal((await js('saved + 1')).value, 42);
    const reset = await request('tools/call', { name: 'js_reset', arguments: {} });
    assert.equal(reset.result.structuredContent.reset, true);
    const afterReset = await request('tools/call', { name: 'js', arguments: { title: 'test', code: 'saved' } });
    assert.equal(afterReset.result.isError, true);
  } finally {
    child.stdin.end();
    await once(child, 'exit');
  }
});
