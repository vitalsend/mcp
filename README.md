# @vitalsend/mcp

Send a file end-to-end encrypted from your AI agent. The file is encrypted on your computer, the
recipient downloads it once, and then it no longer exists. The model never sees the download link,
its key or the password.

Built for the moment an agent has to hand something sensitive to a person: an `.env` file, a key,
a database dump, a finished report.

## Install

You need a [VitalSend](https://vitalsend.eu) account. A free account sends a few files a month.

**Claude Code**, as a plugin from this repository:

```
/plugin install vitalsend --marketplace vitalsend/mcp
```

or as a plain MCP server:

```sh
claude mcp add vitalsend -- npx -y @vitalsend/mcp
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project)

```json
{
  "mcpServers": {
    "vitalsend": { "command": "npx", "args": ["-y", "@vitalsend/mcp"] }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`). Claude Desktop does not tell the tool which
folder you work in, so name it:

```json
{
  "mcpServers": {
    "vitalsend": {
      "command": "npx",
      "args": ["-y", "@vitalsend/mcp"],
      "env": { "VITALSEND_ROOT": "/Users/you/projects/acme" }
    }
  }
}
```

**CI and scripts.** Create an API key under Connected apps on your
[account page](https://vitalsend.eu/me/), optionally limited to a list of recipients, and set it:

```json
"env": { "VITALSEND_API_KEY": "vsk_…" }
```

With an API key every send names a recipient, the link is emailed, and there is no password.

**Apps that connect to a URL** (claude.ai in the browser and other web clients) cannot run a local
tool. `https://vitalsend.eu/mcp` tells them how to install it in an app that can.

## Use

Ask your agent: "Send `.env` to kalle@example.com with VitalSend."

The first time, your browser opens on vitalsend.eu: sign in (or create an account) and allow the
connection. After that:

1. You confirm each send: file, recipient and cost.
2. A page on your computer shows the password. Send it to the recipient another way than the link,
   by text message for example.
3. VitalSend emails the link to the recipient. Without a recipient, the link appears on the same
   page for you to share.

The agent is told who it went to and when it expires. Nothing else.

The tool is `send_file(path, recipient_email?, password?)`. It reads files only inside the folders
your client shares with it; if the client shares none, inside `VITALSEND_ROOT`; failing both, inside
the folder it was started in, unless that is your home folder or `/`, where it refuses.

## Security model

- The file is encrypted on your computer with the same code vitalsend.eu runs in the browser
  ([vitalsend/crypto](https://github.com/vitalsend/crypto)). Only ciphertext leaves it.
- The link key, the password, your login and the file id never go to the model: not in a tool
  result, not in an error, not in a log.
- The password never reaches VitalSend. The server gets a value derived from the password and the
  link key, which lets it count wrong attempts and nothing else.
- When VitalSend emails the link, its server handles the link key for that delivery. With a
  password, that key alone does not open the file. To keep VitalSend out entirely, leave out the
  recipient and share the link yourself.
- The page that shows the password lives on `127.0.0.1` at a random address, answers only the
  browser tab that loaded it, and closes afterwards. A program running as you that loads it first
  stops the send. Beyond that, anything running as you can read what you can read.
- Your login is a send-only grant: it can send files and spend credits, nothing else. Revoke it
  under Connected apps on your account page.

## License

AGPL-3.0-or-later. Source: [github.com/vitalsend/mcp](https://github.com/vitalsend/mcp).
