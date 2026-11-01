// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildServer } from '../src/server.js';

async function rpc(clientTransport, message) {
  return new Promise((resolve) => {
    clientTransport.onmessage = (m) => { if (m.id === message.id) resolve(m); };
    clientTransport.send(message);
  });
}

describe('MCP server', () => {
  it('lists exactly one tool, send_file, with path, recipient_email and password', async () => {
    const server = buildServer({ sendFileDeps: () => ({}) });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    await clientT.start?.();
    await rpc(clientT, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await rpc(clientT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = res.result.tools;
    expect(tools.map((t) => t.name)).toEqual(['send_file']);
    expect(Object.keys(tools[0].inputSchema.properties).sort()).toEqual(['password', 'path', 'recipient_email']);
    expect(tools[0].inputSchema.required).toEqual(['path']);
  });

  it('an unexpected error becomes a fixed text, never its own message', async () => {
    const server = buildServer({ sendFileDeps: () => { throw new Error('boom https://vitalsend.eu/download/?file=X#k=key vsr_token'); } });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    await rpc(clientT, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await rpc(clientT, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_file', arguments: { path: 'x' } } });
    const text = JSON.stringify(res);
    expect(res.result.isError).toBe(true);
    expect(text).not.toMatch(/boom|#k=|vsr_|download/);
  });
});
