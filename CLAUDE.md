# jsbeeb-mcp

MCP server exposing a headless BBC Micro emulator (jsbeeb) to AI assistants.

## Commit conventions

This project uses **release-please** to automate releases and npm publishing.
Commits to `main` MUST use [Conventional Commits](https://www.conventionalcommits.org/)
prefixes or release-please will not create a release PR:

- `feat:` — new features (triggers minor version bump)
- `fix:` — bug fixes (triggers patch version bump)
- `chore:` / `docs:` / `refactor:` — no release triggered

Examples:
```
feat: add sound chip debugging tools
fix: handle missing disc image gracefully
chore: update dependencies
```

## Architecture

- `server.js` — the MCP server; defines all tools using `server.tool()`
- Depends on `jsbeeb` (the emulator library) via npm
- `MachineSession` (in jsbeeb) wraps the emulator with video, sound, and text capture

## Adding new tools

Follow the existing pattern in `server.js`:
```javascript
server.tool("tool_name", "Description", { params... }, async ({ params }) => {
    const session = requireSession(session_id);
    // ... do work ...
    return { content: [{ type: "text", text: "result" }] };
});
```

Access the emulator internals via `session._machine.processor` (the Cpu6502)
and `session._soundChip` (the InstrumentedSoundChip).

## Testing locally

Point your MCP client to the local server instead of the npm package:
```bash
claude mcp add jsbeeb node /path/to/jsbeeb-mcp/server.js
```

If also developing jsbeeb itself, link the local copy:
```bash
cd /path/to/jsbeeb && npm link
cd /path/to/jsbeeb-mcp && npm link jsbeeb
```
