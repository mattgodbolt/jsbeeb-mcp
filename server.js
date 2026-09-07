#!/usr/bin/env node
/**
 * jsbeeb MCP Server
 *
 * Exposes a headless BBC Micro emulator to AI assistants via the Model
 * Context Protocol.  Start it with:
 *
 *   node server.js
 *
 * and connect it from Claude Desktop, Cursor, or any MCP-compatible client
 * by adding it to mcp_servers in the client config.
 *
 * Capabilities:
 *   - Boot any machine jsbeeb emulates (BBC B, BBC Master, Acorn Atom)
 *   - Load and run BBC BASIC programs
 *   - Type at the keyboard
 *   - Capture text output
 *   - Take screenshots (PNG, base64-encoded)
 *   - Read/write memory
 *   - Inspect CPU registers
 *   - Persistent sessions (multiple machines at once)
 *   - One-shot `run_basic` convenience tool (no session management needed)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MachineSession, allModels, findModel } from "jsbeeb";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// BBC key name → browser keyCode mapping
// ---------------------------------------------------------------------------

const KeyNameToCode = {
    // Modifiers
    SHIFT: 16,
    CTRL: 17,
    // Special keys
    RETURN: 13,
    SPACE: 32,
    DELETE: 46,
    BACKSPACE: 8,
    ESCAPE: 27,
    TAB: 9,
    CAPS_LOCK: 20,
    // Arrow keys
    UP: 38,
    DOWN: 40,
    LEFT: 37,
    RIGHT: 39,
    // Function keys (BBC f0–f9 map to keyCodes 112–121)
    F0: 112,
    F1: 113,
    F2: 114,
    F3: 115,
    F4: 116,
    F5: 117,
    F6: 118,
    F7: 119,
    F8: 120,
    F9: 121,
    // Punctuation / symbols
    COMMA: 188,
    PERIOD: 190,
    SLASH: 191,
    SEMICOLON: 186,
    QUOTE: 222,
    OPEN_BRACKET: 219,
    CLOSE_BRACKET: 221,
    BACKSLASH: 220,
    MINUS: 189,
    EQUALS: 187,
    BACKTICK: 192,
};

// Letters A–Z (keyCode = ASCII uppercase)
for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    KeyNameToCode[letter] = 65 + i;
}
// Digits 0–9 (keyCode = ASCII '0'..'9')
for (let i = 0; i <= 9; i++) {
    KeyNameToCode[String(i)] = 48 + i;
}

function resolveKeyCode(keyName) {
    const code = KeyNameToCode[keyName.toUpperCase()];
    if (code === undefined) {
        throw new Error(
            `Unknown key name "${keyName}". Valid names: ${Object.keys(KeyNameToCode).join(", ")}`,
        );
    }
    return code;
}

// Every machine jsbeeb can build, by the short name findModel takes. The Tube models are
// second processors, not machines, and are the only ones without a short name.
const MachineModels = allModels.filter((m) => m.synonyms.length > 0);
const ModelNames = MachineModels.map((m) => m.synonyms[0]);
const ModelDescription =
    "Machine to emulate: " + MachineModels.map((m) => `${m.synonyms[0]} (${m.name})`).join(", ");

function secondsOfCycles(modelName, seconds) {
    return seconds * findModel(modelName).cyclesPerSecond;
}

const DiscParams = {
    image_path: z
        .string()
        .optional()
        .describe("Absolute path to a disc image on this machine: .ssd, .dsd, .adf, or a zip holding one"),
    image_ref: z
        .string()
        .optional()
        .describe(
            "A disc as jsbeeb's own URL names it: 'sth:Acornsoft/Elite.zip' for a Stairway to Hell disc, " +
                "'hfe:<path>' for one from the BBC disc archive, or an http(s) or file: URL",
        ),
};

/** The reference the session's resolver takes for a disc given by path or by reference. */
function discRef({ image_path, image_ref }) {
    if (!image_path === !image_ref) throw new Error("Give exactly one of image_path or image_ref");
    return image_path ? pathToFileURL(image_path).href : image_ref;
}

/** SHIFT+BREAK: the SHIFT stays held for a second of the machine's time so the OS sees it. */
async function autobootMachine(session, hard = true) {
    session.keyDown(16); // SHIFT
    try {
        session.reset(hard);
        await session.runFor(secondsOfCycles(session.modelName, 1));
    } finally {
        session.keyUp(16);
    }
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

const sessions = new Map(); // sessionId → MachineSession

// Snapshots are big (RAM plus every ROM bank), so they stay here and only their
// IDs cross the wire.  They outlive the session they came from, which is what
// lets one state seed several machines.
const states = new Map(); // stateId → { model, label, saved_from, saved_at, snapshot }

// A snapshot is about 0.4MB, so this caps the store around 40MB: far more than
// any real checkpointing needs, and enough to stop a runaway caller filling the
// heap and taking every live session down with it.
const MaxSavedStates = 100;
const MaxStateLabelLength = 200;

/** The CPU registers with the frame and cycle counters, as every tool that reports a stop returns them. */
function registersWithCounters(session) {
    return { ...session.registers(), frame_count: session.frameCount, elapsed_cycles: session.elapsedCycles };
}

/** The breakpoint hit since the last call to this, if any, cleared so the next run is not stopped by it again. */
function takeBreakpointHit(session) {
    const hit = session.hitBreakpoint();
    if (hit) session.resetBreakpointHits();
    return hit;
}

/**
 * A breakpoint hit during an earlier call that does not report hits itself
 * (type_input, say) is reported before anything more runs, so the caller sees
 * the machine where the breakpoint left it.
 */
function pendingBreakpointResult(session, clear, counters) {
    const hit = takeBreakpointHit(session);
    if (!hit) return null;
    return {
        ...counters,
        completed: false,
        stopped_reason: "pending_breakpoint",
        output: session.drainOutput({ clear }),
        breakpoint: hit,
        registers: registersWithCounters(session),
    };
}

/** Adds what a run stopped by a breakpoint reports to `result`. */
function addBreakpointStop(session, result) {
    const hit = takeBreakpointHit(session);
    if (!hit) return result;
    return {
        ...result,
        completed: false,
        stopped_reason: "breakpoint",
        breakpoint: hit,
        registers: registersWithCounters(session),
    };
}

function requireSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error(`No session with id "${sessionId}". Call create_machine first.`);
    return s;
}

function newSessionId() {
    return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
    name: "jsbeeb",
    version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Tool: create_machine
// ---------------------------------------------------------------------------

server.tool(
    "create_machine",
    "Boot one of the machines jsbeeb emulates and return a session ID for use with all other tools. " +
        "The machine runs until the BASIC prompt before this call returns.",
    {
        model: z.enum(ModelNames).default("B-DFS1.2").describe(ModelDescription),
        boot_timeout_secs: z.number().default(30).describe("Max seconds of emulated time to wait for the boot prompt"),
        tube: z
            .boolean()
            .default(false)
            .describe(
                "Attach the second processor this model was sold with: a 3MHz 65C02 for a BBC B, " +
                    "or the 4MHz 65C102 Turbo board for a Master",
            ),
    },
    async ({ model, boot_timeout_secs, tube }) => {
        const session = new MachineSession(model, { tube });
        await session.initialise();
        const bootOutput = await session.boot(boot_timeout_secs);
        const id = newSessionId();
        sessions.set(id, session);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        session_id: id,
                        model,
                        boot_output: bootOutput,
                    }),
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: destroy_machine
// ---------------------------------------------------------------------------

server.tool(
    "destroy_machine",
    "Destroy a BBC Micro session and free its resources.",
    { session_id: z.string().describe("Session ID from create_machine") },
    async ({ session_id }) => {
        const s = sessions.get(session_id);
        if (s) {
            s.destroy();
            sessions.delete(session_id);
        }
        return { content: [{ type: "text", text: "Session destroyed." }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: load_disc
// ---------------------------------------------------------------------------

server.tool(
    "load_disc",
    "Put a disc image in a drive, from a file on this machine (image_path) or from the archives or a " +
        "URL (image_ref). Zips are opened and the disc inside used. " +
        "After loading, use type_input to issue DFS commands (e.g. '*RUN hello', '*DIR', 'CHAIN\"\"'); " +
        "a disc in drive 1 is reached as ':1.name'.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        ...DiscParams,
        drive: z.number().int().min(0).max(1).default(0).describe("Drive to put the disc in"),
    },
    async ({ session_id, image_path, image_ref, drive }) => {
        const session = requireSession(session_id);
        const { name, ignored } = await session.loadDiscImage(discRef({ image_path, image_ref }), drive);
        return { content: [{ type: "text", text: JSON.stringify({ disc: name, drive, ignored }) }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: load_basic
// ---------------------------------------------------------------------------

server.tool(
    "load_basic",
    "Tokenise BBC BASIC source code and load it into the emulator's PAGE memory, " +
        "exactly as if you had typed it in and saved it. Does NOT run the program.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        source: z.string().describe("BBC BASIC source code (plain text, BBC dialect)"),
    },
    async ({ session_id, source }) => {
        const session = requireSession(session_id);
        await session.loadBasic(source);
        return { content: [{ type: "text", text: "BASIC program loaded into PAGE." }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: type_input
// ---------------------------------------------------------------------------

server.tool(
    "type_input",
    "Type text at the current keyboard prompt (simulates key presses). " +
        "A newline/RETURN is automatically sent after the text. " +
        "Use run_until_prompt after this to collect output.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        text: z.string().describe("Text to type (e.g. 'RUN' or '10 PRINT\"HELLO\"')"),
    },
    async ({ session_id, text }) => {
        const session = requireSession(session_id);
        await session.type(text);
        return { content: [{ type: "text", text: `Typed: ${text}` }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: run_until_prompt
// ---------------------------------------------------------------------------

server.tool(
    "run_until_prompt",
    "Run the emulator until it returns to a keyboard input prompt (e.g. the BASIC prompt after RUN completes). " +
        "Returns all text output that was written to the screen since the last call.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        timeout_secs: z.number().default(60).describe("Max emulated seconds to run before giving up"),
        clear: z
            .boolean()
            .default(true)
            .describe(
                "If true (default), clear the output buffer after returning it. " +
                    "Pass false to peek at accumulated output without consuming it.",
            ),
    },
    async ({ session_id, timeout_secs, clear }) => {
        const session = requireSession(session_id);
        const output = await session.runUntilPrompt(timeout_secs, { clear });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(output),
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: screenshot
// ---------------------------------------------------------------------------

server.tool(
    "screenshot",
    "Capture the last fully-painted BBC Micro frame as a PNG image. " +
        "Returns a base64-encoded PNG of the full 1024×625 emulated display, plus the frame counter " +
        "so you can tell a genuinely new frame from the same one captured twice. " +
        "Tip: call run_until_prompt first to let the screen settle, or run_frames to step to the next frame.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        active_only: z
            .boolean()
            .default(true)
            .describe("If true, crop to the active display area and apply 2× pixel scaling for clarity"),
    },
    async ({ session_id, active_only }) => {
        const session = requireSession(session_id);
        const png = active_only ? await session.screenshotActive() : await session.screenshot();
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ frame_count: session.frameCount }),
                },
                {
                    type: "image",
                    data: png.toString("base64"),
                    mimeType: "image/png",
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: read_memory
// ---------------------------------------------------------------------------

server.tool(
    "read_memory",
    "Read bytes from the BBC Micro's memory map. " + "Returns an array of decimal byte values plus a hex dump.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        address: z.number().int().min(0).max(0xffff).describe("Start address (0–65535)"),
        length: z.number().int().min(1).max(256).default(16).describe("Number of bytes to read (max 256)"),
    },
    async ({ session_id, address, length }) => {
        const session = requireSession(session_id);
        const bytes = session.readMemory(address, length);
        const hexDump = formatHexDump(address, bytes);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        address,
                        addressHex: `0x${address.toString(16).toUpperCase()}`,
                        bytes,
                        hexDump,
                    }),
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: write_memory
// ---------------------------------------------------------------------------

server.tool(
    "write_memory",
    "Write bytes into the BBC Micro's memory. " +
        "Useful for poking machine code, modifying variables, or patching running programs.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        address: z.number().int().min(0).max(0xffff).describe("Start address (0–65535)"),
        bytes: z.array(z.number().int().min(0).max(255)).describe("Array of byte values to write"),
    },
    async ({ session_id, address, bytes }) => {
        const session = requireSession(session_id);
        session.writeMemory(address, bytes);
        return {
            content: [
                {
                    type: "text",
                    text: `Wrote ${bytes.length} byte(s) at 0x${address.toString(16).toUpperCase()}.`,
                },
            ],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: read_registers
// ---------------------------------------------------------------------------

server.tool(
    "read_registers",
    "Read the current 6502 CPU register state (PC, A, X, Y, stack pointer, processor status), " +
        "along with the frame and cycle counters.",
    { session_id: z.string().describe("Session ID from create_machine") },
    async ({ session_id }) => {
        const session = requireSession(session_id);
        return { content: [{ type: "text", text: JSON.stringify(registersWithCounters(session)) }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: run_for_cycles
// ---------------------------------------------------------------------------

server.tool(
    "run_for_cycles",
    "Run the emulator for an exact number of CPU cycles (2MHz on a BBC, 1MHz on an Atom). " +
        "Useful for precise timing, or just to advance the clock a bit between interactions. " +
        "Do not use this to step frames: a frame is 40000 cycles with interlace on (the default) " +
        "but 39936 with it off, so a fixed step drifts against the display. Use run_frames instead. " +
        "Reports cycles_run, the cycles actually executed, and accumulated text output. A breakpoint " +
        "stops the run early: completed is false, stopped_reason is 'breakpoint', and the registers " +
        "(with elapsed_cycles) show where it stopped; the next call runs on from there. A breakpoint " +
        "hit during an earlier call that does not report hits itself (type_input) is reported first, " +
        "with stopped_reason 'pending_breakpoint' and cycles_run 0. " +
        "By default the output buffer is cleared after returning — " +
        "pass clear=false when using this as an intermediate step (e.g. between key_down and key_up) " +
        "to avoid losing output that you want to collect later via run_until_prompt.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        cycles: z.number().int().min(1).describe("Number of CPU cycles to execute"),
        clear: z
            .boolean()
            .default(true)
            .describe("If true (default), clear the output buffer after returning it. Pass false to peek."),
    },
    async ({ session_id, cycles, clear }) => {
        const session = requireSession(session_id);
        const pending = pendingBreakpointResult(session, clear, { cycles_run: 0 });
        if (pending) return { content: [{ type: "text", text: JSON.stringify(pending) }] };

        const startCycles = session.elapsedCycles;
        await session.runFor(cycles);
        const output = session.drainOutput({ clear });
        const result = addBreakpointStop(session, {
            cycles_run: session.elapsedCycles - startCycles,
            completed: true,
            output,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: run_frames
// ---------------------------------------------------------------------------

server.tool(
    "run_frames",
    "Run the emulator until it has painted another `count` frames, stopping on the paint itself. " +
        "Use this rather than run_for_cycles for anything frame-oriented: capturing consecutive " +
        "screenshots to see flicker or tearing, or stepping an animation. One frame is exactly one " +
        "new screenshot. Reports frames_run, cycles_run, and frame_count (which only ever climbs, " +
        "so compare it across calls to confirm the screen really did move on). " +
        "completed is false if the machine stopped painting or a breakpoint fired first; a breakpoint " +
        "stop reports stopped_reason 'breakpoint' and the registers, or 'pending_breakpoint' for a hit " +
        "left over from type_input, as run_for_cycles does.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        count: z.number().int().min(1).max(10000).default(1).describe("Number of frames to advance"),
        clear: z
            .boolean()
            .default(true)
            .describe("If true (default), clear the output buffer after returning it. Pass false to peek."),
    },
    async ({ session_id, count, clear }) => {
        const session = requireSession(session_id);
        const pending = pendingBreakpointResult(session, clear, {
            frames_run: 0,
            cycles_run: 0,
            frame_count: session.frameCount,
        });
        if (pending) return { content: [{ type: "text", text: JSON.stringify(pending) }] };

        const { framesRun, cyclesRun, completed } = await session.runFrames(count);
        const output = session.drainOutput({ clear });
        const result = addBreakpointStop(session, {
            frames_run: framesRun,
            cycles_run: cyclesRun,
            frame_count: session.frameCount,
            completed,
            output,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: key_down
// ---------------------------------------------------------------------------

server.tool(
    "key_down",
    "Press and hold a key on the BBC Micro keyboard. " +
        "Use key_up to release it later. Key names: SHIFT, CTRL, RETURN, SPACE, DELETE, " +
        "BACKSPACE, ESCAPE, TAB, CAPS_LOCK, UP, DOWN, LEFT, RIGHT, F0–F9, A–Z, 0–9.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        key: z.string().describe("Key name (e.g. 'SHIFT', 'A', 'RETURN', 'F0')"),
    },
    async ({ session_id, key }) => {
        const session = requireSession(session_id);
        const code = resolveKeyCode(key);
        session.keyDown(code);
        return { content: [{ type: "text", text: `Key down: ${key}` }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: key_up
// ---------------------------------------------------------------------------

server.tool(
    "key_up",
    "Release a previously held key on the BBC Micro keyboard.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        key: z.string().describe("Key name (e.g. 'SHIFT', 'A', 'RETURN', 'F0')"),
    },
    async ({ session_id, key }) => {
        const session = requireSession(session_id);
        const code = resolveKeyCode(key);
        session.keyUp(code);
        return { content: [{ type: "text", text: `Key up: ${key}` }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: reset
// ---------------------------------------------------------------------------

server.tool(
    "reset",
    "Reset the BBC Micro. With autoboot=true, holds SHIFT during reset to trigger " +
        "a disc autoboot (SHIFT+BREAK). The boot sequence is initiated but not run to completion — " +
        "use run_for_cycles or run_until_prompt afterwards as needed.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        hard: z.boolean().default(true).describe("Hard reset (power-on) if true, soft reset if false"),
        autoboot: z
            .boolean()
            .default(false)
            .describe("Hold SHIFT during reset to autoboot the disc in drive 0"),
    },
    async ({ session_id, hard, autoboot }) => {
        const session = requireSession(session_id);
        if (autoboot) {
            await autobootMachine(session, hard);
            return { content: [{ type: "text", text: JSON.stringify({ reset: true, autoboot: true }) }] };
        }
        session.reset(hard);
        return { content: [{ type: "text", text: JSON.stringify({ reset: true, hard }) }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: boot_disc
// ---------------------------------------------------------------------------

server.tool(
    "boot_disc",
    "Load a disc image, from a file here or from the archives or a URL as load_disc takes them, " +
        "and autoboot it (SHIFT+BREAK). Equivalent to: load_disc → key_down SHIFT → reset → key_up SHIFT. " +
        "The boot sequence is initiated but not run to completion — " +
        "use run_for_cycles or run_until_prompt afterwards as needed.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        ...DiscParams,
    },
    async ({ session_id, image_path, image_ref }) => {
        const session = requireSession(session_id);
        const { name, ignored } = await session.loadDiscImage(discRef({ image_path, image_ref }));
        await autobootMachine(session);
        return {
            content: [{ type: "text", text: JSON.stringify({ disc: name, booting: true, ignored }) }],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: run_disc  (convenience: one-shot, no session management needed)
// ---------------------------------------------------------------------------

server.tool(
    "run_disc",
    "One-shot convenience tool: boot a BBC Micro, load a disc image, autoboot it " +
        "(SHIFT+BREAK), return all text output and optionally a screenshot, then destroy the session. " +
        "Like run_basic but for disc images.",
    {
        ...DiscParams,
        model: z.enum(ModelNames).default("B-DFS1.2").describe(ModelDescription),
        timeout_secs: z.number().default(30).describe("Max emulated seconds to allow the disc to boot and run"),
        screenshot: z.boolean().default(true).describe("Include a screenshot of the final screen state"),
    },
    async ({ image_path, image_ref, model, timeout_secs, screenshot: wantScreenshot }) => {
        const ref = discRef({ image_path, image_ref });
        const session = new MachineSession(model);
        try {
            await session.initialise();
            await session.boot(30);
            const { name, ignored } = await session.loadDiscImage(ref);
            await autobootMachine(session);
            await session.runFor(secondsOfCycles(model, timeout_secs));
            const output = session.drainOutput();

            const result = { disc: name, ignored, output };

            if (wantScreenshot) {
                const png = await session.screenshotActive();
                return {
                    content: [
                        { type: "text", text: JSON.stringify(result) },
                        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
                    ],
                };
            }

            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } finally {
            session.destroy();
        }
    },
);

// ---------------------------------------------------------------------------
// Tool: run_basic  (convenience: one-shot, no session management needed)
// ---------------------------------------------------------------------------

server.tool(
    "run_basic",
    "One-shot convenience tool: boot a BBC Micro, load a BASIC program, run it, " +
        "return all text output and a screenshot, then destroy the session. " +
        "Perfect for quickly trying out ideas without managing sessions.",
    {
        source: z.string().describe("BBC BASIC source code to run"),
        model: z.enum(ModelNames).default("B-DFS1.2").describe(ModelDescription),
        timeout_secs: z.number().default(30).describe("Max emulated seconds to allow the program to run"),
        screenshot: z.boolean().default(true).describe("Include a screenshot of the final screen state"),
    },
    async ({ source, model, timeout_secs, screenshot: wantScreenshot }) => {
        const session = new MachineSession(model);
        try {
            await session.initialise();
            await session.boot(30);
            await session.loadBasic(source);
            await session.type("RUN");
            const output = await session.runUntilPrompt(timeout_secs);

            const result = { output };

            if (wantScreenshot) {
                const png = await session.screenshotActive();
                return {
                    content: [
                        { type: "text", text: JSON.stringify(result) },
                        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
                    ],
                };
            }

            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } finally {
            session.destroy();
        }
    },
);

// ---------------------------------------------------------------------------
// Sound chip tools
// ---------------------------------------------------------------------------

server.tool(
    "read_sound_state",
    "Read the SN76489 sound chip's current register state: tone periods for " +
        "channels 0–2, noise register, volume/attenuation for all 4 channels, " +
        "LFSR state, and which register is latched. Useful for verifying what " +
        "the program has written to the sound chip.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
    },
    async ({ session_id }) => {
        const session = requireSession(session_id);
        const sc = session._soundChip;
        if (!sc || !sc.getState) {
            return { content: [{ type: "text", text: "Sound chip not available (session may be using FakeSoundChip)" }] };
        }
        const state = sc.getState();
        // Convert tone periods to frequencies for convenience
        const freqs = state.tone.map((t) => (t === 0 ? 0 : 4000000 / (32 * t)));
        const lines = [
            `CH0: tone=${state.tone[0]} (${freqs[0].toFixed(1)}Hz) vol=${state.volume[0]}`,
            `CH1: tone=${state.tone[1]} (${freqs[1].toFixed(1)}Hz) vol=${state.volume[1]}`,
            `CH2: tone=${state.tone[2]} (${freqs[2].toFixed(1)}Hz) vol=${state.volume[2]}`,
            `CH3: noise=${state.noise} vol=${state.volume[3]}`,
            `Latched register: 0x${state.latchedRegister.toString(16).padStart(2, "0")}`,
            `LFSR: 0x${state.lfsr.toString(16).padStart(4, "0")}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
    },
);

server.tool(
    "start_sound_capture",
    "Start capturing all SN76489 sound chip writes. Every byte written to the " +
        "chip is logged with its cycle timestamp. Use stop_sound_capture to " +
        "retrieve the log. Clears any previous capture.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
    },
    async ({ session_id }) => {
        const session = requireSession(session_id);
        const sc = session._soundChip;
        if (!sc || !sc.startCapture) {
            return { content: [{ type: "text", text: "Sound chip capture not available" }] };
        }
        sc.startCapture();
        return { content: [{ type: "text", text: "Sound capture started. Run the emulator, then call stop_sound_capture." }] };
    },
);

server.tool(
    "stop_sound_capture",
    "Stop capturing SN76489 writes and return the log. Each entry has a cycle " +
        "timestamp and the byte value written. The values are decoded into " +
        "human-readable form (channel, tone/volume, value).",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        max_entries: z.number().default(500).describe("Maximum number of entries to return (most recent if exceeded)"),
    },
    async ({ session_id, max_entries }) => {
        const session = requireSession(session_id);
        const sc = session._soundChip;
        if (!sc || !sc.stopCapture) {
            return { content: [{ type: "text", text: "Sound chip capture not available" }] };
        }
        const writes = sc.stopCapture();
        const total = writes.length;

        // Decode SN76489 writes
        let latched = 0;
        const decoded = writes.slice(-max_entries).map((w) => {
            const v = w.value;
            let desc;
            if (v & 0x80) {
                // LATCH byte
                const ch = (v >> 5) & 3;
                const isVol = (v >> 4) & 1;
                const data = v & 0x0f;
                latched = v & 0x70;
                if (isVol) {
                    desc = `CH${ch} vol atten=${data} ${data === 15 ? "(silent)" : ""}`;
                } else if (ch === 3) {
                    desc = `Noise: ${data}`;
                } else {
                    desc = `CH${ch} tone lo=${data}`;
                }
            } else {
                // DATA byte
                const ch = (latched >> 5) & 3;
                const isVol = (latched >> 4) & 1;
                const data = v & 0x3f;
                const bit6 = (v >> 6) & 1;
                if (isVol) {
                    desc = `CH${ch} vol DATA=${data}`;
                } else {
                    desc = `CH${ch} tone hi=${data}${bit6 ? " [bit6=BASS]" : ""}`;
                }
            }
            return `${w.cycle}: 0x${v.toString(16).padStart(2, "0")} ${desc}`;
        });

        const header = total > max_entries
            ? `Showing last ${max_entries} of ${total} writes:\n`
            : `${total} writes captured:\n`;

        return { content: [{ type: "text", text: header + decoded.join("\n") }] };
    },
);

server.tool(
    "set_breakpoint",
    "Set a persistent breakpoint. The breakpoint stays active across multiple " +
        "run_for_cycles calls until removed with clear_breakpoint. When a breakpoint " +
        "fires, run_for_cycles returns early and reports which breakpoint was hit. " +
        "Types: 'execute' (PC reaches address), 'read' (memory read), 'write' (memory write).",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        address: z.number().min(0).max(65535).describe("Address to break on (0–65535)"),
        type: z.enum(["execute", "read", "write"]).default("execute")
            .describe("Breakpoint type: execute (PC), read (memory read), write (memory write)"),
    },
    async ({ session_id, address, type }) => {
        const session = requireSession(session_id);
        const id = session.addBreakpoint(type, address);
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    breakpoint_id: id,
                    type,
                    address,
                    addressHex: `0x${address.toString(16).padStart(4, "0")}`,
                }),
            }],
        };
    },
);

server.tool(
    "clear_breakpoint",
    "Remove a previously set breakpoint by its ID, or pass id=0 to clear all breakpoints.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        id: z.number().describe("Breakpoint ID to remove (0 = clear all)"),
    },
    async ({ session_id, id }) => {
        const session = requireSession(session_id);
        if (id === 0) {
            session.clearBreakpoints();
            return { content: [{ type: "text", text: "All breakpoints cleared" }] };
        }
        session.removeBreakpoint(id);
        return { content: [{ type: "text", text: `Breakpoint ${id} removed` }] };
    },
);

// ---------------------------------------------------------------------------
// State snapshot tools
// ---------------------------------------------------------------------------

server.tool(
    "save_state",
    "Snapshot the whole machine (CPU, RAM, sideways RAM, video, sound chip, " +
        "discs, tube) and keep it server-side under a state ID. Booting is the " +
        "slow part of a session, so snapshotting once and restoring between " +
        "attempts is much cheaper than creating a machine for each one. The " +
        "snapshot itself never crosses this connection, only its ID.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        label: z
            .string()
            .max(MaxStateLabelLength)
            .default("")
            .describe("Optional note to identify this state in list_states"),
    },
    async ({ session_id, label }) => {
        const session = requireSession(session_id);
        // Refuse rather than evicting: a state is kept because something means to
        // restore it, so dropping the oldest to make room would break the caller
        // that is still holding its ID.
        if (states.size >= MaxSavedStates) {
            throw new Error(
                `Already holding ${states.size} saved states (the limit). ` +
                    "Free one with delete_state; list_states shows what is held.",
            );
        }
        const state_id = crypto.randomUUID();
        states.set(state_id, {
            model: session.modelName,
            label,
            saved_from: session_id,
            saved_at: new Date().toISOString(),
            snapshot: session.snapshot(),
        });
        return {
            content: [{
                type: "text",
                text: JSON.stringify({ state_id, model: session.modelName, label }),
            }],
        };
    },
);

server.tool(
    "restore_state",
    "Put a session back to a state saved by save_state. Memory, registers and " +
        "the cycle count rewind; breakpoints and the frame counter carry on. The " +
        "target session need not be the one the state was saved from, so a state " +
        "can be restored into several machines to run from the same start point, " +
        "but it must be the same model.",
    {
        session_id: z.string().describe("Session ID to restore into"),
        state_id: z.string().describe("State ID from save_state"),
    },
    async ({ session_id, state_id }) => {
        const session = requireSession(session_id);
        const saved = states.get(state_id);
        if (!saved) throw new Error(`No state with id "${state_id}". Call save_state first.`);
        // ROM layout and CPU type differ per model, so a state from one would
        // restore as nonsense into another.
        if (saved.model !== session.modelName) {
            throw new Error(
                `State "${state_id}" was saved from a ${saved.model}, ` +
                    `but session "${session_id}" is a ${session.modelName}.`,
            );
        }
        session.restore(saved.snapshot);
        const regs = session.registers();
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    state_id,
                    model: saved.model,
                    label: saved.label,
                    pcHex: `0x${regs.pc.toString(16).padStart(4, "0")}`,
                    frame_count: session.frameCount,
                }),
            }],
        };
    },
);

server.tool(
    "list_states",
    "List the states held by save_state, newest first.",
    {
        session_id: z.string().default("").describe("Only list states saved from this session (default: all)"),
    },
    async ({ session_id }) => {
        const listed = [...states.entries()]
            .filter(([, saved]) => !session_id || saved.saved_from === session_id)
            .map(([state_id, saved]) => ({
                state_id,
                model: saved.model,
                label: saved.label,
                saved_from: saved.saved_from,
                saved_at: saved.saved_at,
            }))
            .sort((a, b) => b.saved_at.localeCompare(a.saved_at));
        return { content: [{ type: "text", text: JSON.stringify({ count: listed.length, states: listed }) }] };
    },
);

server.tool(
    "delete_state",
    "Discard a saved state and free the memory it holds. States outlive the " +
        "session they came from, so they are only freed when deleted.",
    {
        state_id: z.string().describe("State ID from save_state"),
    },
    async ({ state_id }) => {
        if (!states.delete(state_id)) throw new Error(`No state with id "${state_id}".`);
        return { content: [{ type: "text", text: `State ${state_id} deleted` }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: save_memory
// ---------------------------------------------------------------------------

server.tool(
    "save_memory",
    "Save a range of the BBC Micro's memory to a file on the host filesystem. " +
        "Much faster than multiple read_memory calls for large dumps.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        address: z.number().min(0).max(65535).describe("Start address (0–65535)"),
        length: z.number().min(1).max(65536).describe("Number of bytes to save"),
        path: z.string().describe("Absolute path to write the file to"),
    },
    async ({ session_id, address, length, path: filePath }) => {
        const session = requireSession(session_id);
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) bytes[i] = session._machine.readbyte(address + i);
        writeFileSync(filePath, bytes);
        return {
            content: [{
                type: "text",
                text: `Saved ${length} bytes from $${address.toString(16).padStart(4, "0")} to ${filePath}`,
            }],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: disassemble
// ---------------------------------------------------------------------------

server.tool(
    "disassemble",
    "Disassemble 6502 machine code from the BBC Micro's memory. " +
        "Returns assembly listing with addresses, hex bytes, and mnemonics.",
    {
        session_id: z.string().describe("Session ID from create_machine"),
        address: z.number().min(0).max(65535).describe("Start address (0–65535)"),
        count: z.number().min(1).max(200).default(20).describe("Number of instructions to disassemble"),
    },
    async ({ session_id, address, count }) => {
        const session = requireSession(session_id);
        const dis = session._machine.processor.disassembler;
        const lines = [];
        let addr = address;
        for (let i = 0; i < count && addr <= 0xFFFF; i++) {
            const [text, nextAddr] = dis.disassemble(addr, true);
            const bytes = [];
            for (let b = addr; b < nextAddr; b++) bytes.push(session._machine.readbyte(b));
            const hex = bytes.map(b => b.toString(16).padStart(2, "0")).join(" ");
            lines.push(`${addr.toString(16).padStart(4, "0").toUpperCase()}  ${hex.padEnd(8)}  ${text}`);
            addr = nextAddr;
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
    },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHexDump(startAddr, bytes) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
        const chunk = bytes.slice(i, i + 16);
        const addr = (startAddr + i).toString(16).toUpperCase().padStart(4, "0");
        const hex = chunk.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
        const ascii = chunk.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
        lines.push(`${addr}  ${hex.padEnd(47)}  |${ascii}|`);
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error("Failed to start jsbeeb MCP server:", err);
    process.exit(1);
});
