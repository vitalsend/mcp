// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jörgen Karlsson <jorgen@karlsson.com, jorgenk@vitalsend.eu>
//
// The MCP server: one tool, send_file.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { sendFile } from './send.js';
import { createIo } from './io.js';

export const VERSION = '0.1.0';

const DESCRIPTION = `Send a file end-to-end encrypted through VitalSend. The file is encrypted on this computer; \
the recipient can download it once. With recipient_email, VitalSend emails the download link; without it, the link \
appears in the user's browser for the user to share. You never see the link, its key or the password. By default a \
password is set and shown to the user in the browser. Each send is confirmed by the user first.`;

export function buildServer({ sendFileDeps, openBrowser }) {
  const server = new McpServer({ name: 'vitalsend', version: VERSION });
  server.registerTool('send_file', {
    description: DESCRIPTION,
    inputSchema: {
      path: z.string().describe('Path of the file to send, inside the folders this client shares.'),
      recipient_email: z.string().optional().describe('Email the download link to this address. Leave out to let the user share the link.'),
      password: z.boolean().optional().describe('Protect the file with a password shown to the user. Default: yes when signed in through the browser.'),
    },
  }, async (args, ctx) => {
    const io = createIo({ server, ctx, openBrowser });
    try {
      const out = await sendFile(args, { ...sendFileDeps(server), io });
      return { content: [{ type: 'text', text: out.text }], isError: out.isError };
    } catch (err) {
      if (err?.inputRequired) return err.value;
      return { content: [{ type: 'text', text: 'Not sent. Something went wrong.' }], isError: true };
    }
  });
  return server;
}
