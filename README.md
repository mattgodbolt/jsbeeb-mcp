# jsbeeb-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that
exposes a headless [BBC Micro emulator](https://github.com/mattgodbolt/jsbeeb)
to AI assistants (Claude, Cursor, etc.).

Write a BASIC program, run it, get the text output and a screenshot — all
without opening a browser.

## Quick start — no install needed

```bash
npx jsbeeb-mcp
```

That's it. `npx` downloads and runs the server on demand.

## Connecting to your LLM

### Claude Desktop

Add to your config file and restart Claude:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "jsbeeb": {
      "command": "npx",
      "args": ["jsbeeb-mcp"]
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add jsbeeb -- npx jsbeeb-mcp
```

Or add directly in `.claude/settings.json` (project-level) or
`~/.claude/settings.json` (global):

```json
{
  "mcpServers": {
    "jsbeeb": {
      "command": "npx",
      "args": ["jsbeeb-mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "jsbeeb": {
      "command": "npx",
      "args": ["jsbeeb-mcp"]
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "jsbeeb": {
      "type": "stdio",
      "command": "npx",
      "args": ["jsbeeb-mcp"]
    }
  }
}
```

### Anything else that speaks MCP

Run the server and point your client at it:

```bash
npx jsbeeb-mcp
# server speaks JSON-RPC over stdio
```

## Tools

### One-shot convenience tools _(no session management needed)_

#### `run_basic`

Boot a BBC Micro, load a BASIC program, run it, return text output and an
optional screenshot, then clean up.

```json
{
  "source": "10 PRINT \"HELLO WORLD\"\n20 GOTO 10",
  "model": "B-DFS1.2",
  "timeout_secs": 10,
  "screenshot": true
}
```

#### `run_disc`

Boot a BBC Micro, load a disc image, autoboot it (SHIFT+BREAK), return text
output and an optional screenshot, then clean up.

```json
{
  "image_path": "/path/to/game.ssd",
  "model": "B-DFS1.2",
  "timeout_secs": 30,
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
| `read_registers`   | Get 6502 CPU registers (PC, A, X, Y, S, P)                    |
| `run_for_cycles`   | Run exactly N 2MHz CPU cycles (drains output by default — use `clear: false` to peek without consuming) |
| `load_disc`        | Load an `.ssd`/`.dsd` disc image into drive 0                  |
| `key_down`         | Press and hold a key (e.g. `SHIFT`, `A`, `RETURN`, `F0`)      |
| `key_up`           | Release a previously held key                                  |
| `reset`            | Reset the machine; with `autoboot: true`, holds SHIFT during reset (SHIFT+BREAK) |
| `boot_disc`        | Load a disc image and autoboot it (SHIFT+BREAK)                |

### Composable keyboard control

The `key_down`, `key_up`, and `reset` tools are low-level primitives that can be
composed for full manual control. For example, to autoboot a disc:

```
key_down SHIFT → reset → run_for_cycles (1s) → key_up SHIFT → run_until_prompt
```

Or use `reset` with `autoboot: true` / `boot_disc` / `run_disc` for common cases.

**Key names:** `SHIFT`, `CTRL`, `RETURN`, `SPACE`, `DELETE`, `BACKSPACE`,
`ESCAPE`, `TAB`, `CAPS_LOCK`, `UP`, `DOWN`, `LEFT`, `RIGHT`, `F0`–`F9`,
`A`–`Z`, `0`–`9`, plus punctuation (`COMMA`, `PERIOD`, `SLASH`, `SEMICOLON`,
`QUOTE`, `MINUS`, `EQUALS`, etc.).

## What works

- ✅ BBC BASIC programs (tokenised and loaded directly into memory)
- ✅ Text output capture (position, colour, mode)
- ✅ Screenshots (real Video chip output → PNG via `sharp`)
- ✅ Memory read/write
- ✅ CPU register inspection
- ✅ BBC B and Master models
- ✅ Multiple concurrent sessions
- ✅ Disc image loading and autoboot (`.ssd`/`.dsd`)
- ✅ Low-level keyboard control (key_down/key_up)

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
