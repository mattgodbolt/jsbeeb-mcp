# jsbeeb-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that
exposes a headless [BBC Micro emulator](https://github.com/mattgodbolt/jsbeeb)
to AI assistants (Claude, Cursor, etc.).

Write a BASIC program, run it, get the text output and a screenshot — all
without opening a browser.

## Setup

> **Note:** `jsbeeb` is not yet published to npm. The `package.json` currently
> references the `claude/headless-machine` branch. Once that PR merges and
> jsbeeb is on npm this will become a normal versioned dependency.

```bash
npm install
```

## Running

```bash
# Starts the MCP server on stdin/stdout (for use by an MCP client)
node server.js
```

## Connecting to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jsbeeb": {
      "command": "node",
      "args": ["/path/to/jsbeeb-mcp/server.js"]
    }
  }
}
```

## Tools

### `run_basic` _(convenience — no session management needed)_

One-shot: boot a BBC Micro, load a BASIC program, run it, return text output
and an optional screenshot, then clean up.

```json
{
  "source": "10 PRINT \"HELLO WORLD\"\n20 GOTO 10",
  "model": "B-DFS1.2",
  "timeout_secs": 10,
  "screenshot": true
}
```

### Session-based tools

For multi-step interaction (debugging, iterative development):

| Tool               | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `create_machine`   | Boot a BBC Micro (B or Master), returns a `session_id`         |
| `destroy_machine`  | Free a session                                                 |
| `load_basic`       | Tokenise + load BBC BASIC source into PAGE                     |
| `type_input`       | Type text at the current keyboard prompt (RETURN is automatic) |
| `run_until_prompt` | Run until BASIC/OS prompt, return captured screen text         |
| `screenshot`       | Capture the current screen as a PNG image                      |
| `read_memory`      | Read bytes from the memory map (with hex dump)                 |
| `write_memory`     | Poke bytes into memory                                         |
| `read_registers`   | Get 6502 CPU registers (PC, A, X, Y, S, P)                     |
| `run_for_cycles`   | Run exactly N 2MHz CPU cycles                                  |
| `load_disc`        | Load an `.ssd`/`.dsd` disc image into drive 0                  |

## What works

- ✅ BBC BASIC programs (tokenised and loaded directly into memory)
- ✅ Text output capture (position, colour, mode)
- ✅ Screenshots (real Video chip output → PNG via `sharp`)
- ✅ Memory read/write
- ✅ CPU register inspection
- ✅ BBC B and Master models
- ✅ Multiple concurrent sessions
- ✅ Disc image loading (`.ssd`/`.dsd`)

## Known limitations

- **Boot text**: the VDU capture hook is installed after the initial boot
  completes, so the OS startup banner isn't captured. Everything after the
  first `>` prompt is captured.
- **No assembler built in**: to run machine code, poke it via `write_memory`
  and `CALL` it from BASIC, or use the BBC's own inline assembler in BASIC.
- **Sound**: the sound chip runs but produces no audio output (headless mode).

## Architecture

```
server.js   # MCP server — tool definitions, session store
examples/   # Standalone scripts demonstrating MachineSession directly
```

`MachineSession` lives in jsbeeb itself (`src/machine-session.js`) and is
imported here as `jsbeeb/machine-session`. It wraps jsbeeb's `TestMachine`
with a real `Video` instance (full video chip into a 1024×625 RGBA
framebuffer), VDU text capture, and screenshot support via `sharp`.

Framebuffer snapshots are taken inside the `paint_ext` vsync callback (before
the buffer is cleared), ensuring screenshots always show a complete frame.
