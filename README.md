# jsbeeb-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that
exposes [jsbeeb](https://github.com/mattgodbolt/jsbeeb), a headless emulator of
the BBC Micro and the Acorn Atom, to AI assistants (Claude, Cursor, etc.).

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
output and an optional screenshot, then clean up. The disc is a file on the
machine running the server (`image_path`), or a reference the way jsbeeb's own
URLs name one (`image_ref`): `sth:Acornsoft/Elite.zip` for a Stairway to Hell disc,
`hfe:<path>` for one from the BBC disc archive, or an `http(s):` or `file:`
URL. Zips are opened and the disc inside used.

```json
{
  "image_path": "/path/to/game.ssd",
  "model": "B-DFS1.2",
  "timeout_secs": 30,
  "screenshot": true
}
```

```json
{
  "image_ref": "sth:Acornsoft/Elite.zip",
  "model": "B-DFS1.2",
  "timeout_secs": 30
}
```

### Session-based tools

For multi-step interaction (debugging, iterative development):

| Tool               | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `create_machine`   | Boot any machine jsbeeb has (BBC B, Master 128, Acorn Atom), returns a `session_id`; optional `tube` attaches a 65C02 second processor |
| `destroy_machine`  | Free a session                                                 |
| `load_basic`       | Tokenise + load BBC BASIC source into PAGE                     |
| `type_input`       | Type text at the current keyboard prompt (RETURN is automatic) |
| `run_until_prompt` | Run until BASIC/OS prompt, return captured screen text         |
| `screenshot`       | Capture the last fully-painted frame as a PNG image, plus the frame counter |
| `read_memory`      | Read bytes from the memory map (with hex dump), reporting which bank was paged; `bank` / `shadow` pick another |
| `write_memory`     | Poke bytes into memory, into a chosen `bank` or `shadow` RAM if asked |
| `read_registers`   | Get 6502 CPU registers (PC, A, X, Y, S, P), the frame counter and elapsed cycles |
| `run_for_cycles`   | Run N CPU cycles, or up to a breakpoint; reports `cycles_run`, the count actually run (drains output by default — use `clear: false` to peek without consuming) |
| `run_frames`       | Advance N painted frames — use this, not `run_for_cycles`, to step the display |
| `load_disc`        | Put a disc in drive 0 or 1, from a file, an archive or a URL   |
| `key_down`         | Press and hold a key, by name (`SHIFT`, `A`, `RETURN`, `F0`) or by BBC internal key number, INKEY number, or matrix col/row |
| `key_up`           | Release a held key, named the same ways                        |
| `keyboard_state`   | What is held (name, matrix position, internal key number) and whether typing is pending |
| `release_all_keys` | Release everything and drop typing an interrupted `type_input` left pending |
| `reset`            | Reset the machine; with `autoboot: true`, holds SHIFT during reset (SHIFT+BREAK) |
| `boot_disc`        | Load a disc image (file, archive or URL) and autoboot it (SHIFT+BREAK) |
| `save_state`       | Snapshot the whole machine server-side, returns a `state_id`   |
| `restore_state`    | Put a session back to a saved state (same model only)          |
| `list_states`      | List saved states, newest first                                |
| `delete_state`     | Discard a saved state and free its memory                      |

### Paged memory

`read_memory` and `save_memory` read whatever the machine has paged in, so
every response carries `paging`: `romsel`, the sideways bank at `&8000`–`&BFFF`,
and on a Master `acccon`, whose bit 2 puts shadow RAM at `&3000`–`&7FFF`. To
sample a particular bank regardless, pass `bank` (0–15) or, on a Master,
`shadow` (true for shadow RAM, false for main); the map is put back afterwards.
`write_memory` takes the same two.

### Checkpointing with save_state

Booting is the slow part of a session, so snapshot a prepared machine once and
restore it between attempts rather than creating a new one each time:

```
create_machine → (load disc, set things up) → save_state → { state_id }
  ↳ try something → restore_state → try something else → restore_state → ...
```

The snapshot covers CPU, RAM, sideways RAM, video, sound chip, discs and tube.
Memory, registers and the cycle count rewind on restore; breakpoints and the
frame counter deliberately carry on.

Snapshots stay on the server and only their IDs cross the connection, so they
are cheap to pass around but must be freed with `delete_state` when finished —
they outlive the session they came from. The server holds at most 100 of them
(roughly 0.4MB each) and refuses a further `save_state` rather than evicting one
you may be about to restore. That is also what lets one state seed
several machines: `restore_state` accepts any session of the same model, so a
single starting point can be run forward in parallel.

### Composable keyboard control

The `key_down`, `key_up`, and `reset` tools are low-level primitives that can be
composed for full manual control. For example, to autoboot a disc:

```
key_down SHIFT → reset → run_for_cycles (1s) → key_up SHIFT → run_until_prompt
```

Or use `reset` with `autoboot: true` / `boot_disc` / `run_disc` for common cases.
Both report `shift_held_at_reset`, so a boot that lands in the tape filing
system can be told apart from a disc that does not autoboot.

Games read the keyboard matrix directly rather than through the OS, by internal
key number (what `OSBYTE 121` takes). `key_down` and `key_up` accept `internal`,
a negative `inkey` number, or `col` and `row`, so a test can press exactly the
key the game's constant names; the response gives the name and numbers of the
matrix key that moved, which also measures what a name maps to.

A breakpoint that fires part way through `type_input` leaves the rest of the
text still to be typed, and the typist keeps the keyboard until it is. Until
then `key_down` and `key_up` refuse rather than dropping the key; `reset` and
`boot_disc` drop the pending text themselves. `keyboard_state` shows what is
held and whether typing is pending, and `release_all_keys` clears both.

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
- ✅ BBC B (8271 and 1770) and Master 128 models, booting DFS, ADFS or ANFS, and the Acorn Atom
- ✅ Multiple concurrent sessions
- ✅ Whole-machine state snapshots (checkpoint once, restore between attempts)
- ✅ Disc image loading and autoboot: `.ssd`/`.dsd`/`.adf` files and zips, discs from the
  Stairway to Hell and BBC disc archives, and any `http(s):` URL, into either drive
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
imported from the package's root, `jsbeeb`. It wraps jsbeeb's `TestMachine`
with a real `Video` instance (full video chip into a 1024×625 RGBA
framebuffer), VDU text capture, and screenshot support via `sharp`.

Framebuffer snapshots are taken inside the `paint_ext` vsync callback (before
the buffer is cleared), ensuring screenshots always show a complete frame. The
same callback drives `run_frames`, which halts the CPU on the paint itself
rather than after a cycle count — a frame is 40000 cycles with interlace on but
39936 with it off, so a fixed cycle step drifts against the display and makes a
sprite caught mid-redraw look like a bug in the program under test.
