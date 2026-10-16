/**
 * End-to-end MCP client test for the jsbeeb MCP server.
 * Starts the server as a subprocess and talks to it over the real stdio transport.
 *
 * Run with: node test-mcp-client.js
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findModel } from "jsbeeb";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { crc32 } from "zlib";
import { tmpdir } from "os";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function ok(label, value) {
    if (value) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}`);
        failed++;
    }
}

function textContent(result) {
    return result.content.find((c) => c.type === "text")?.text ?? "";
}

function imageContent(result) {
    return result.content.find((c) => c.type === "image");
}

/** The CFS block checksum, high byte first as the tape holds it. */
function cfsCrc(bytes) {
    let crc = 0;
    for (const byte of bytes) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? (((crc ^ 0x0810) << 1) | 1) & 0xffff : (crc << 1) & 0xffff;
    }
    return [crc >> 8, crc & 0xff];
}

function uefChunk(id, data) {
    return [id & 0xff, id >> 8, data.length & 0xff, data.length >> 8, 0, 0, ...data];
}

/** A UEF tape holding `program` as the one block of a BASIC file called `name`. */
function basicTape(name, program) {
    const lastBlockFlag = 0x80;
    const header = [
        ...Buffer.from(name), 0,
        0x00, 0x19, 0xff, 0xff, // load address
        0x23, 0x80, 0xff, 0xff, // execution address
        0, 0, // block number
        program.length & 0xff, program.length >> 8,
        lastBlockFlag,
        0, 0, 0, 0,
    ];
    const block = [0x2a, ...header, ...cfsCrc(header), ...program, ...cfsCrc(program)];
    const carrierTone = uefChunk(0x110, [0xdc, 0x05]);
    return Uint8Array.from([...Buffer.from("UEF File!\0"), 10, 0, ...carrierTone, ...uefChunk(0x100, block), ...carrierTone]);
}

/** A zip holding `data` as `name`, stored uncompressed. */
function storedZip(name, data) {
    const u16 = (n) => [n & 0xff, n >> 8];
    const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
    const nameBytes = [...Buffer.from(name)];
    const sizes = [...u32(crc32(data)), ...u32(data.length), ...u32(data.length)];
    const local = [...u32(0x04034b50), ...u16(10), 0, 0, 0, 0, 0, 0, 0, 0, ...sizes, ...u16(nameBytes.length), 0, 0, ...nameBytes];
    const central = [
        ...u32(0x02014b50), ...u16(10), ...u16(10), 0, 0, 0, 0, 0, 0, 0, 0, ...sizes,
        ...u16(nameBytes.length), ...Array(16).fill(0), ...nameBytes,
    ];
    const centralStart = local.length + data.length;
    const end = [...u32(0x06054b50), 0, 0, 0, 0, ...u16(1), ...u16(1), ...u32(central.length), ...u32(centralStart), 0, 0];
    return Uint8Array.from([...local, ...data, ...central, ...end]);
}

async function callTool(client, name, args) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`Tool ${name} returned error: ${JSON.stringify(result.content)}`);
    return result;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
    console.log("Starting jsbeeb MCP server...");
    const transport = new StdioClientTransport({
        command: "node",
        args: [resolve(__dirname, "server.js")],
        cwd: resolve(__dirname, ".."),
    });

    const client = new Client({ name: "jsbeeb-test-client", version: "0.0.1" });
    // The transport reports each stdout line that is not a JSON-RPC message here, then carries on.
    const transportErrors = [];
    client.onerror = (err) => transportErrors.push(err.message);
    await client.connect(transport);
    console.log("Connected.\n");

    // --- List tools ---
    console.log("--- list tools ---");
    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);
    console.log("Tools:", toolNames.join(", "));
    ok("has create_machine", toolNames.includes("create_machine"));
    ok("has run_basic", toolNames.includes("run_basic"));
    ok("has load_disc", toolNames.includes("load_disc"));
    ok("has screenshot", toolNames.includes("screenshot"));
    ok("has read_memory", toolNames.includes("read_memory"));
    ok("has write_memory", toolNames.includes("write_memory"));
    ok("has read_registers", toolNames.includes("read_registers"));
    ok("has key_down", toolNames.includes("key_down"));
    ok("has key_up", toolNames.includes("key_up"));
    ok("has reset", toolNames.includes("reset"));
    ok("has boot_disc", toolNames.includes("boot_disc"));
    ok("has run_disc", toolNames.includes("run_disc"));
    ok("has run_frames", toolNames.includes("run_frames"));
    ok("has load_tape", toolNames.includes("load_tape"));
    ok("has flush_keyboard_buffer", toolNames.includes("flush_keyboard_buffer"));

    // Every model create_machine offers must be one jsbeeb actually knows, or the
    // client is invited to pick a name that fails deep inside MachineSession.
    const advertisedModels = tools.find((t) => t.name === "create_machine")?.inputSchema?.properties?.model?.enum ?? [];
    ok("create_machine advertises models", advertisedModels.length > 0);
    const unknownModels = advertisedModels.filter((m) => findModel(m) === null);
    const modelLabel = unknownModels.length ? `unknown: ${unknownModels.join(", ")}` : "none unknown";
    ok(`all ${advertisedModels.length} advertised models exist (${modelLabel})`, unknownModels.length === 0);

    // --- One-shot run_basic ---
    console.log("\n--- run_basic (one-shot) ---");
    const rb = await callTool(client, "run_basic", {
        source: '10 PRINT "MCP WORKS"\n20 PRINT 6*7\n',
        screenshot: true,
    });
    const rbText = textContent(rb);
    const rbParsed = JSON.parse(rbText);
    console.log("screenText:", JSON.stringify(rbParsed.output.screenText));
    ok("output contains MCP WORKS", rbParsed.output.screenText.includes("MCP WORKS"));
    ok("output contains 42", rbParsed.output.screenText.includes("42"));
    const rbImg = imageContent(rb);
    ok("got a screenshot image", !!rbImg);
    ok("image is PNG (base64)", rbImg?.data?.length > 100);
    if (rbImg) {
        const screenshotPath = resolve(__dirname, "mcp-test-screenshot.png");
        writeFileSync(screenshotPath, Buffer.from(rbImg.data, "base64"));
        console.log(`  Screenshot saved to ${screenshotPath}`);
    }

    // --- Session-based workflow ---
    console.log("\n--- session workflow ---");
    const createResult = await callTool(client, "create_machine", { model: "B-DFS1.2" });
    const { session_id, boot_output } = JSON.parse(textContent(createResult));
    console.log("Session:", session_id);
    console.log("Boot text:", JSON.stringify(boot_output.screenText));
    ok("got session_id", !!session_id);
    ok("boot output has BBC Computer", boot_output.screenText.includes("BBC Computer"));
    ok("boot output has BASIC", boot_output.screenText.includes("BASIC"));

    // load_basic
    await callTool(client, "load_basic", {
        session_id,
        source: "10 FOR I=1 TO 3\n20 PRINT I*I\n30 NEXT I\n",
    });

    // type + run
    await callTool(client, "type_input", { session_id, text: "RUN" });
    const runResult = await callTool(client, "run_until_prompt", { session_id });
    const runOutput = JSON.parse(textContent(runResult));
    console.log("Run output:", JSON.stringify(runOutput.screenText));
    ok("output has 1", runOutput.screenText.includes("1"));
    ok("output has 4", runOutput.screenText.includes("4"));
    ok("output has 9", runOutput.screenText.includes("9"));

    // read_memory (zero page)
    const memResult = await callTool(client, "read_memory", { session_id, address: 0, length: 16 });
    const mem = JSON.parse(textContent(memResult));
    ok("got 16 bytes", mem.bytes.length === 16);
    ok("has hex dump", mem.hexDump.includes("0000"));

    // write + read back
    await callTool(client, "write_memory", { session_id, address: 0x700, bytes: [0xde, 0xad, 0xbe, 0xef] });
    const mem2 = await callTool(client, "read_memory", { session_id, address: 0x700, length: 4 });
    const mem2data = JSON.parse(textContent(mem2));
    ok("write_memory round-trips", JSON.stringify(mem2data.bytes) === JSON.stringify([0xde, 0xad, 0xbe, 0xef]));

    // paged memory: a read says which bank it saw, and can be pointed at another
    ok("read_memory reports the bank paged in", typeof mem2data.paging?.romsel === "number");
    ok("and no ACCCON on a BBC B", mem2data.paging.acccon === undefined);
    const readBank = async (bank) =>
        JSON.parse(
            textContent(await callTool(client, "read_memory", { session_id, address: 0x8000, length: 3, bank })),
        );
    await callTool(client, "write_memory", { session_id, address: 0x8000, bytes: [1, 2, 3], bank: 4 });
    await callTool(client, "write_memory", { session_id, address: 0x8000, bytes: [7, 8, 9], bank: 5 });
    const bank4 = await readBank(4);
    ok("a sideways RAM bank reads back what was written to it", JSON.stringify(bank4.bytes) === "[1,2,3]");
    ok("and another bank holds its own", JSON.stringify((await readBank(5)).bytes) === "[7,8,9]");
    ok("the read says which bank it used", bank4.paging.bank === 4);
    const pagedBack = JSON.parse(
        textContent(await callTool(client, "read_memory", { session_id, address: 0x8000, length: 3 })),
    );
    ok("the machine's own bank is paged back afterwards", pagedBack.paging.romsel === mem2data.paging.romsel);
    const noShadow = await client.callTool({
        name: "read_memory",
        arguments: { session_id, address: 0x3000, length: 1, shadow: true },
    });
    ok("a BBC B has no shadow RAM to read", noShadow.isError === true);
    const savePath = resolve(tmpdir(), `jsbeeb-mcp-test-${process.pid}.bin`);
    const saveArgs = { session_id, address: 0x8000, length: 3, path: savePath, bank: 5 };
    const saved = JSON.parse(textContent(await callTool(client, "save_memory", saveArgs)));
    ok("save_memory writes the bank asked for", JSON.stringify([...readFileSync(savePath)]) === "[7,8,9]");
    ok("and reports it", saved.paging.bank === 5 && saved.saved === 3);
    unlinkSync(savePath);

    // read_registers
    const regsResult = await callTool(client, "read_registers", { session_id });
    const regs = JSON.parse(textContent(regsResult));
    ok("has PC register", typeof regs.pc === "number");
    ok("has pcHex", regs.pcHex.startsWith("0x"));

    // screenshot
    const ssResult = await callTool(client, "screenshot", { session_id, active_only: true });
    const ssImg = imageContent(ssResult);
    ok("screenshot returns image", !!ssImg);
    ok("screenshot is base64 PNG", ssImg?.data?.length > 100);
    const ssFrame = JSON.parse(textContent(ssResult)).frame_count;
    ok("screenshot reports a frame count", typeof ssFrame === "number");

    // run_frames — the first step lands on a frame boundary (it collects
    // whatever was left of the frame in progress), so measure from the second.
    const alignResult = await callTool(client, "run_frames", { session_id });
    const baseFrame = JSON.parse(textContent(alignResult)).frame_count;
    ok("run_frames picks up where screenshot left off", baseFrame === ssFrame + 1);

    const framesResult = await callTool(client, "run_frames", { session_id, count: 3 });
    const frames = JSON.parse(textContent(framesResult));
    console.log("run_frames:", JSON.stringify({ ...frames, output: undefined }));
    ok("run_frames runs the frames asked for", frames.frames_run === 3 && frames.completed === true);
    ok("run_frames steps whole frames", Math.abs(frames.cycles_run - 3 * 40000) <= 16);
    ok("run_frames advances the frame count", frames.frame_count === baseFrame + 3);
    const ssAfter = await callTool(client, "screenshot", { session_id, active_only: true });
    ok("screenshot agrees with run_frames", JSON.parse(textContent(ssAfter)).frame_count === frames.frame_count);

    // read_registers carries the same counter
    const regsWithFrame = JSON.parse(textContent(await callTool(client, "read_registers", { session_id })));
    ok("read_registers reports the frame count", regsWithFrame.frame_count === frames.frame_count);
    ok("read_registers reports elapsed cycles", regsWithFrame.elapsed_cycles > 0);

    // load_disc
    const discPath = resolve(__dirname, "examples/hello.ssd");
    const ldResult = await callTool(client, "load_disc", { session_id, image_path: discPath });
    const loaded = JSON.parse(textContent(ldResult));
    ok("load_disc names the disc", loaded.disc.endsWith("hello.ssd") && loaded.drive === 0);

    await callTool(client, "type_input", { session_id, text: "*RUN hello" });
    const discRun = await callTool(client, "run_until_prompt", { session_id });
    const discOutput = JSON.parse(textContent(discRun));
    console.log("Disc run output:", JSON.stringify(discOutput.screenText));
    ok("disc program output correct", discOutput.screenText.includes("HELLO FROM BEEBASM"));

    // load_disc by reference, into the other drive
    const byRef = await callTool(client, "load_disc", { session_id, image_ref: pathToFileURL(discPath).href, drive: 1 });
    ok("load_disc takes a URL into drive 1", JSON.parse(textContent(byRef)).drive === 1);
    await callTool(client, "type_input", { session_id, text: "*RUN :1.hello" });
    const drive1Run = JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id })));
    ok("the disc in drive 1 runs", drive1Run.screenText.includes("HELLO FROM BEEBASM"));
    const bothGiven = await client.callTool({
        name: "load_disc",
        arguments: { session_id, image_path: discPath, image_ref: pathToFileURL(discPath).href },
    });
    ok("load_disc refuses a path and a reference together", bothGiven.isError === true);

    // destroy
    const destroyResult = await callTool(client, "destroy_machine", { session_id });
    ok("destroy succeeds", textContent(destroyResult).includes("destroyed"));

    // --- key_down / key_up ---
    console.log("\n--- key_down / key_up ---");
    const createResult2 = await callTool(client, "create_machine", { model: "B-DFS1.2" });
    const { session_id: sid2 } = JSON.parse(textContent(createResult2));

    // Press 'A' via key_down, run cycles, release, then press RETURN to flush the line.
    // Use clear=false on intermediate run_for_cycles so output accumulates.
    const kdResult = JSON.parse(textContent(await callTool(client, "key_down", { session_id: sid2, key: "A" })));
    ok("key_down reports the matrix key that went down", kdResult.pressed?.[0]?.name === "A");
    ok("with the internal key number a name maps to", kdResult.pressed?.[0]?.internal === 0x41);
    await callTool(client, "run_for_cycles", { session_id: sid2, cycles: 200000, clear: false });
    await callTool(client, "key_up", { session_id: sid2, key: "A" });
    // Press RETURN to flush the line — VDU capture buffers printable chars until CR/LF
    await callTool(client, "key_down", { session_id: sid2, key: "RETURN" });
    await callTool(client, "run_for_cycles", { session_id: sid2, cycles: 200000, clear: false });
    await callTool(client, "key_up", { session_id: sid2, key: "RETURN" });
    // Now run until the BASIC prompt returns and check for the 'A'
    const keyOutput = await callTool(client, "run_until_prompt", { session_id: sid2 });
    const keyText = JSON.parse(textContent(keyOutput));
    console.log("key_down output:", JSON.stringify(keyText.screenText));
    ok("key_down produced character", keyText.screenText.includes("A"));

    // --- reset ---
    console.log("\n--- reset ---");
    const resetResult = await callTool(client, "reset", { session_id: sid2, hard: true });
    const resetParsed = JSON.parse(textContent(resetResult));
    ok("reset returns success", resetParsed.reset === true);
    // After reset, run until prompt and check for BBC Computer banner
    const postReset = await callTool(client, "run_until_prompt", { session_id: sid2 });
    const postResetText = JSON.parse(textContent(postReset));
    console.log("Post-reset output:", JSON.stringify(postResetText.screenText));
    ok("reset reboots machine", postResetText.screenText.includes("BBC Computer"));

    // --- reset with autoboot ---
    console.log("\n--- reset with autoboot (after loading disc) ---");
    const discPathBoot = resolve(__dirname, "examples/hello.ssd");
    await callTool(client, "load_disc", { session_id: sid2, image_path: discPathBoot });
    const autobootResult = await callTool(client, "reset", { session_id: sid2, hard: true, autoboot: true });
    const autobootParsed = JSON.parse(textContent(autobootResult));
    ok("autoboot confirms", autobootParsed.autoboot === true);
    // Run until the disc program finishes and we're back at the prompt
    const autobootRun = await callTool(client, "run_until_prompt", { session_id: sid2 });
    const autobootOutput = JSON.parse(textContent(autobootRun));
    console.log("Autoboot output:", JSON.stringify(autobootOutput.screenText));
    ok("autoboot ran disc", autobootOutput.screenText.includes("HELLO FROM BEEBASM"));

    // --- breakpoints ---
    console.log("\n--- breakpoints ---");
    const runFor = async (cycles) =>
        JSON.parse(textContent(await callTool(client, "run_for_cycles", { session_id: sid2, cycles })));
    const registersOf = async () =>
        JSON.parse(textContent(await callTool(client, "read_registers", { session_id: sid2 })));

    // IRQ1V is entered every interrupt, so a breakpoint on it fires within a frame.
    const irq1v = JSON.parse(
        textContent(await callTool(client, "read_memory", { session_id: sid2, address: 0x204, length: 2 })),
    );
    const irqAddress = irq1v.bytes[0] | (irq1v.bytes[1] << 8);
    const setBreakpoint = async (address) =>
        JSON.parse(textContent(await callTool(client, "set_breakpoint", { session_id: sid2, address })));
    const bpResult = await setBreakpoint(irqAddress);
    ok("set_breakpoint returns an id", bpResult.breakpoint_id > 0);

    // Three runs in a row from the breakpoint: each must move on and stop at the next interrupt.
    const sweep = [];
    for (let i = 0; i < 3; i++) {
        const before = (await registersOf()).elapsed_cycles;
        const run = await runFor(600000);
        sweep.push({ ...run, actual: (await registersOf()).elapsed_cycles - before });
    }
    console.log("sweep:", JSON.stringify(sweep.map(({ cycles_run, actual }) => ({ cycles_run, actual }))));
    ok(
        "each run stops at the breakpoint",
        sweep.every((r) => r.breakpoint?.id === bpResult.breakpoint_id && r.completed === false),
    );
    ok("each run says why it stopped", sweep.every((r) => r.stopped_reason === "breakpoint"));
    ok("each run from the breakpoint moves on", sweep.every((r) => r.cycles_run > 0));
    ok("cycles_run is the count run, not requested", sweep.every((r) => r.cycles_run === r.actual));
    ok("a stopped run reports fewer cycles than asked", sweep.every((r) => r.cycles_run < 600000));
    ok("registers carry the cycle counter", sweep.every((r) => typeof r.registers.elapsed_cycles === "number"));
    ok("registers stop at the breakpoint", sweep.every((r) => r.registers.pc === irqAddress));

    // A hit during type_input is reported by type_input itself, and the next run carries on.
    await callTool(client, "clear_breakpoint", { session_id: sid2, id: 0 });
    const oswrch = await setBreakpoint(0xffee);
    const typedX = JSON.parse(textContent(await callTool(client, "type_input", { session_id: sid2, text: "X" })));
    ok("a hit during type_input is reported by it", typedX.stopped_reason === "breakpoint");
    ok("and names the breakpoint", typedX.breakpoint?.id === oswrch.breakpoint_id && typedX.completed === false);
    const onward = await runFor(1000);
    ok("the next run carries on", onward.cycles_run > 0 && onward.stopped_reason !== "pending_breakpoint");
    await callTool(client, "clear_breakpoint", { session_id: sid2, id: 0 });
    const noBreakpoint = await runFor(1000);
    ok("a run with no breakpoint completes", noBreakpoint.completed === true && noBreakpoint.breakpoint === undefined);
    // A stop leaves no unspent budget behind: the run after it is the length asked for, within an instruction.
    ok("the run after a breakpoint stop runs only what was asked", Math.abs(noBreakpoint.cycles_run - 1000) <= 16);

    // --- keyboard state / interrupted typing ---
    console.log("\n--- keyboard state ---");
    const keyboard = async () =>
        JSON.parse(textContent(await callTool(client, "keyboard_state", { session_id: sid2 })));
    const releaseAll = async () =>
        JSON.parse(textContent(await callTool(client, "release_all_keys", { session_id: sid2 })));

    await releaseAll();
    const quiet = await keyboard();
    ok("a released keyboard reports nothing held", quiet.held_keys.length === 0 && quiet.typing_pending === false);

    await callTool(client, "key_down", { session_id: sid2, key: "A" });
    const holdingA = await keyboard();
    console.log("held:", JSON.stringify(holdingA.held_keys));
    ok("a held key is reported by name", holdingA.held_keys.some((k) => k.name === "A"));
    ok(
        "with its internal key number and INKEY number",
        holdingA.held_keys.some((k) => k.internal === 0x41 && k.inkey === -66),
    );
    const releasedA = await releaseAll();
    ok("release_all_keys says what it released", releasedA.released.some((k) => k.name === "A"));
    ok("and that no typing was pending", releasedA.cancelled_typing === false);
    ok("and leaves nothing held", (await keyboard()).held_keys.length === 0);

    // A breakpoint part way through type_input leaves the typist holding the keyboard.
    const echo = await setBreakpoint(0xffee);
    const typed = JSON.parse(textContent(await callTool(client, "type_input", { session_id: sid2, text: "X" })));
    ok("type_input reports the breakpoint that cut it short", typed.breakpoint?.id === echo.breakpoint_id);
    ok("and that it did not finish", typed.completed === false);
    ok("keyboard_state shows the typing pending", (await keyboard()).typing_pending === true);
    const refused = await client.callTool({ name: "key_down", arguments: { session_id: sid2, key: "SHIFT" } });
    ok("key_down refuses while typing is pending", refused.isError === true);
    ok("and says how to recover", textContent(refused).includes("release_all_keys"));
    await callTool(client, "clear_breakpoint", { session_id: sid2, id: 0 });

    // boot_disc drops the pending typing itself, so SHIFT really is down at the reset.
    const bootWhileTyping = JSON.parse(
        textContent(await callTool(client, "boot_disc", { session_id: sid2, image_path: discPathBoot })),
    );
    ok("boot_disc drops the pending typing", bootWhileTyping.cancelled_typing === true);
    ok("and saw SHIFT held at the reset", bootWhileTyping.shift_held_at_reset === true);
    const bootedWhileTyping = JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id: sid2 })));
    ok("so the disc autoboots", bootedWhileTyping.screenText.includes("HELLO FROM BEEBASM"));
    const afterBoot = await keyboard();
    ok("and the keyboard is clear afterwards", afterBoot.held_keys.length === 0 && afterBoot.typing_pending === false);

    // --- keys by number ---
    console.log("\n--- keys by number ---");
    const pressAndRelease = async (selector) => {
        const down = JSON.parse(textContent(await callTool(client, "key_down", { session_id: sid2, ...selector })));
        await callTool(client, "run_for_cycles", { session_id: sid2, cycles: 200000, clear: false });
        const up = JSON.parse(textContent(await callTool(client, "key_up", { session_id: sid2, ...selector })));
        await callTool(client, "run_for_cycles", { session_id: sid2, cycles: 200000, clear: false });
        return { down, up };
    };
    const byInternal = await pressAndRelease({ internal: 66 });
    ok("a key pressed by internal number is named", byInternal.down.pressed[0]?.name === "X");
    ok("and released by it", byInternal.up.released[0]?.name === "X");
    const byInkey = await pressAndRelease({ inkey: -67 });
    ok("a key pressed by INKEY number is named", byInkey.down.pressed[0]?.name === "X");
    const byMatrix = await pressAndRelease({ col: 1, row: 4 });
    ok("a key pressed by matrix position is named", byMatrix.down.pressed[0]?.name === "A");
    const byBeebName = await pressAndRelease({ key: "COLON_STAR" });
    ok("a key pressed by the machine's own name is that key", byBeebName.down.pressed[0]?.name === "COLON_STAR");
    await pressAndRelease({ key: "K1" });
    await pressAndRelease({ key: "RETURN" });
    const numbered = JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id: sid2 })));
    console.log("typed by number:", JSON.stringify(numbered.screenText));
    ok("the keys reached BASIC", numbered.screenText.includes("XXA:1"));

    const hostName = await client.callTool({ name: "key_down", arguments: { session_id: sid2, key: "QUOTE" } });
    ok("a host keyboard's name for a key is refused", hostName.isError === true);
    ok("and the refusal lists the machine's names", textContent(hostName).includes("COLON_STAR"));
    const inherited = await client.callTool({
        name: "key_down",
        arguments: { session_id: sid2, key: "constructor" },
    });
    ok("a name the table only inherits is refused too", inherited.isError === true);

    const noKey = await client.callTool({ name: "key_down", arguments: { session_id: sid2 } });
    ok("key_down needs a key", noKey.isError === true);
    const twoKeys = await client.callTool({
        name: "key_down",
        arguments: { session_id: sid2, key: "A", internal: 66 },
    });
    ok("but only one", twoKeys.isError === true);
    const halfMatrix = await client.callTool({ name: "key_down", arguments: { session_id: sid2, col: 1 } });
    ok("and col needs row", halfMatrix.isError === true);
    const farInkey = await client.callTool({ name: "key_down", arguments: { session_id: sid2, inkey: -1000 } });
    ok("and an INKEY number must name a matrix key", farInkey.isError === true);
    ok("nothing is left held after the refusals", (await keyboard()).held_keys.length === 0);

    await callTool(client, "destroy_machine", { session_id: sid2 });

    // --- boot_disc ---
    console.log("\n--- boot_disc ---");
    const createResult3 = await callTool(client, "create_machine", { model: "B-DFS1.2" });
    const { session_id: sid3 } = JSON.parse(textContent(createResult3));
    const bootDiscResult = await callTool(client, "boot_disc", {
        session_id: sid3,
        image_path: resolve(__dirname, "examples/hello.ssd"),
    });
    const bootDiscParsed = JSON.parse(textContent(bootDiscResult));
    ok("boot_disc confirms", bootDiscParsed.booting === true);
    ok("boot_disc loaded disc", bootDiscParsed.disc.endsWith("hello.ssd"));
    // Run until prompt to verify the disc actually booted
    const bootDiscRun = await callTool(client, "run_until_prompt", { session_id: sid3 });
    const bootDiscOutput = JSON.parse(textContent(bootDiscRun));
    console.log("boot_disc output:", JSON.stringify(bootDiscOutput.screenText));
    ok("boot_disc ran disc", bootDiscOutput.screenText.includes("HELLO FROM BEEBASM"));
    await callTool(client, "destroy_machine", { session_id: sid3 });

    // --- save_state / restore_state ---
    console.log("\n--- save_state / restore_state ---");
    const createResult4 = await callTool(client, "create_machine", { model: "B-DFS1.2" });
    const { session_id: sid4 } = JSON.parse(textContent(createResult4));

    async function runBasicLine(session_id, line) {
        await callTool(client, "type_input", { session_id, text: line });
        return JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id }))).screenText;
    }

    await runBasicLine(sid4, "A%=42");
    const saveResult = await callTool(client, "save_state", { session_id: sid4, label: "A% is 42" });
    const { state_id } = JSON.parse(textContent(saveResult));
    ok("save_state returns a state_id", !!state_id);

    await runBasicLine(sid4, "A%=99");
    ok("machine moved on after the save", (await runBasicLine(sid4, "PRINT A%")).includes("99"));

    await callTool(client, "restore_state", { session_id: sid4, state_id });
    const restored = await runBasicLine(sid4, "PRINT A%");
    console.log("After restore:", JSON.stringify(restored));
    ok("restore_state rewinds memory", restored.includes("42") && !restored.includes("99"));

    const listed = JSON.parse(textContent(await callTool(client, "list_states", { session_id: sid4 })));
    ok("list_states finds the state", listed.states.some((s) => s.state_id === state_id));
    ok("list_states keeps the label", listed.states[0].label === "A% is 42");

    // A state can seed a second machine, so long as it is the same model, fitted the same way.
    const createResult5 = await callTool(client, "create_machine", { model: "B-DFS1.2" });
    const { session_id: sid5 } = JSON.parse(textContent(createResult5));
    await callTool(client, "restore_state", { session_id: sid5, state_id });
    ok("state restores into another session", (await runBasicLine(sid5, "PRINT A%")).includes("42"));

    const masterResult = await callTool(client, "create_machine", { model: "Master" });
    const { session_id: masterSid } = JSON.parse(textContent(masterResult));
    const crossModel = await client.callTool({
        name: "restore_state",
        arguments: { session_id: masterSid, state_id },
    });
    ok("restoring across models is refused", crossModel.isError === true);

    // shadow RAM on the Master, apart from main RAM
    const shadowArgs = (shadow) => ({ session_id: masterSid, address: 0x3000, shadow });
    await callTool(client, "write_memory", { ...shadowArgs(true), bytes: [10, 20] });
    await callTool(client, "write_memory", { ...shadowArgs(false), bytes: [30, 40] });
    const readShadow = async (shadow) =>
        JSON.parse(textContent(await callTool(client, "read_memory", { ...shadowArgs(shadow), length: 2 })));
    const shadowRead = await readShadow(true);
    ok("shadow RAM reads back apart from main", JSON.stringify(shadowRead.bytes) === "[10,20]");
    ok("and main apart from shadow", JSON.stringify((await readShadow(false)).bytes) === "[30,40]");
    ok("a Master reports ACCCON", typeof shadowRead.paging.acccon === "number" && shadowRead.paging.shadow === true);

    const numpad = JSON.parse(textContent(await callTool(client, "key_down", { session_id: masterSid, key: "NUMPAD7" })));
    ok("a Master presses a numpad key by name", numpad.pressed[0]?.name === "NUMPAD7");
    await callTool(client, "key_up", { session_id: masterSid, key: "NUMPAD7" });

    const overLongLabel = await client.callTool({
        name: "save_state",
        arguments: { session_id: sid4, label: "x".repeat(500) },
    });
    ok("save_state rejects an over-long label", overLongLabel.isError === true);

    await callTool(client, "delete_state", { state_id });
    const afterDelete = JSON.parse(textContent(await callTool(client, "list_states", {})));
    ok("delete_state removes it", !afterDelete.states.some((s) => s.state_id === state_id));

    for (const id of [sid4, sid5, masterSid]) await callTool(client, "destroy_machine", { session_id: id });

    // --- Tape ---
    console.log("\n--- tape ---");
    const tapeSid = JSON.parse(textContent(await callTool(client, "create_machine", {}))).session_id;
    // 10 PRINT 6*7, tokenised
    const tape = basicTape("SIXBY7", [0x0d, 0x00, 0x0a, 0x09, 0xf1, 0x20, 0x36, 0x2a, 0x37, 0x0d, 0xff]);
    const chainFromTape = async (fileName, contents) => {
        const tapePath = resolve(tmpdir(), `jsbeeb-mcp-test-${process.pid}-${fileName}`);
        writeFileSync(tapePath, contents);
        try {
            const loaded = JSON.parse(textContent(await callTool(client, "load_tape", { session_id: tapeSid, image_path: tapePath })));
            await callTool(client, "type_input", { session_id: tapeSid, text: "*TAPE" });
            await callTool(client, "type_input", { session_id: tapeSid, text: 'CHAIN""' });
            const run = JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id: tapeSid })));
            return { loaded, ran: /SIXBY7[\s\S]*\b42\b/.test(run.screenText) };
        } finally {
            unlinkSync(tapePath);
        }
    };
    const fromUef = await chainFromTape("sixby7.uef", tape);
    ok("load_tape names the tape", fromUef.loaded.tape.endsWith("sixby7.uef"));
    ok("a program CHAINed from tape runs", fromUef.ran);
    const fromZip = await chainFromTape("sixby7.zip", storedZip("SIXBY7.UEF", tape));
    ok("load_tape opens a zip for the tape inside", fromZip.loaded.tape === "SIXBY7.UEF" && fromZip.ran);

    await callTool(client, "type_input", { session_id: tapeSid, text: "PRINT 6*7\n" });
    const oneReturn = JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id: tapeSid }))).screenText;
    ok("type_input presses no second RETURN after a newline", oneReturn.includes("42") && !/>\s*\n>/.test(oneReturn));

    // --- Keyboard buffer ---
    console.log("\n--- keyboard buffer ---");
    // Waits a second before reading, so a key pressed meanwhile sits in the buffer.
    const waitThenRead = '10 T%=TIME:REPEAT UNTIL TIME>T%+100\n20 PRINT "GOT[";INKEY$(0);"]"\n';
    const keyWhileWaiting = async (flush) => {
        await callTool(client, "load_basic", { session_id: tapeSid, source: waitThenRead });
        await callTool(client, "type_input", { session_id: tapeSid, text: "RUN" });
        await callTool(client, "key_down", { session_id: tapeSid, key: "X" });
        await callTool(client, "run_frames", { session_id: tapeSid, count: 5, clear: false });
        await callTool(client, "key_up", { session_id: tapeSid, key: "X" });
        if (flush) await callTool(client, "flush_keyboard_buffer", { session_id: tapeSid });
        return JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id: tapeSid }))).screenText;
    };
    ok("a key pressed early waits in the buffer", (await keyWhileWaiting(false)).includes("GOT[X]"));
    ok("flush_keyboard_buffer throws it away", (await keyWhileWaiting(true)).includes("GOT[]"));
    await callTool(client, "destroy_machine", { session_id: tapeSid });

    // --- Breakpoints in a sideways bank ---
    console.log("\n--- breakpoints in a bank ---");
    const bankSid = JSON.parse(textContent(await callTool(client, "create_machine", {}))).session_id;
    const serviceEntry = 0x8003;
    const dfsBank = 14;
    const emptyBank = 4;
    await callTool(client, "set_breakpoint", { session_id: bankSid, address: serviceEntry, bank: emptyBank });
    const unbroken = JSON.parse(textContent(await callTool(client, "type_input", { session_id: bankSid, text: "*HELP" })));
    ok("a breakpoint in a bank nothing runs from stays quiet", unbroken.completed === true && !unbroken.breakpoint);
    await callTool(client, "clear_breakpoint", { session_id: bankSid, id: 0 });
    const setInDfs = JSON.parse(
        textContent(await callTool(client, "set_breakpoint", { session_id: bankSid, address: serviceEntry, bank: dfsBank })),
    );
    ok("set_breakpoint reports its bank", setInDfs.bank === dfsBank);
    const broken = JSON.parse(textContent(await callTool(client, "type_input", { session_id: bankSid, text: "*HELP" })));
    ok("one in DFS's bank stops at DFS's service entry", broken.breakpoint?.bank === dfsBank && broken.registers?.pc === serviceEntry);
    await callTool(client, "destroy_machine", { session_id: bankSid });

    // --- Econet ---
    console.log("\n--- econet ---");
    const econetSid = JSON.parse(
        textContent(await callTool(client, "create_machine", { econet: true, station_id: 42 })),
    ).session_id;
    await callTool(client, "type_input", { session_id: econetSid, text: "PRINT ?&FE18" });
    const station = JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id: econetSid })));
    ok("the station number reads back from the Econet links", /^\s+42$/m.test(station.screenText));
    await callTool(client, "destroy_machine", { session_id: econetSid });
    const stationAlone = await client.callTool({ name: "create_machine", arguments: { station_id: 42 } });
    ok("a station number without Econet is refused", stationAlone.isError === true);

    const masterNetSid = JSON.parse(
        textContent(await callTool(client, "create_machine", { model: "Master", econet: true })),
    ).session_id;
    for (const line of ["*NET", "*I AM SYST", "*CAT"]) await callTool(client, "type_input", { session_id: masterNetSid, text: line });
    const catalogue = JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id: masterNetSid })));
    ok("a Master logs on to the file server and catalogues it", /Dir\. \$ .*Lib\. LIBRARY/.test(catalogue.screenText));
    const { state_id: netState } = JSON.parse(textContent(await callTool(client, "save_state", { session_id: masterNetSid })));
    const listedNet = JSON.parse(textContent(await callTool(client, "list_states", {}))).states.find((s) => s.state_id === netState);
    ok("list_states says how the machine was fitted", listedNet?.fitted?.econet === true && listedNet.fitted.station_id === 101);
    const plainMasterSid = JSON.parse(textContent(await callTool(client, "create_machine", { model: "Master" }))).session_id;
    const intoPlain = await client.callTool({ name: "restore_state", arguments: { session_id: plainMasterSid, state_id: netState } });
    ok("an Econet state will not restore into a machine without Econet", intoPlain.isError === true && textContent(intoPlain).includes("econet true there, false here"));
    const otherNetSid = JSON.parse(textContent(await callTool(client, "create_machine", { model: "Master", econet: true }))).session_id;
    await callTool(client, "restore_state", { session_id: otherNetSid, state_id: netState });
    for (const line of ["*I AM SYST", "*CAT"]) await callTool(client, "type_input", { session_id: otherNetSid, text: line });
    const relogged = JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id: otherNetSid })));
    ok("and another Master with Econet logs on again after restoring it", /Dir\. \$ .*Lib\. LIBRARY/.test(relogged.screenText));
    const tubeSid = JSON.parse(textContent(await callTool(client, "create_machine", { model: "Master", tube: true }))).session_id;
    const { state_id: tubeState } = JSON.parse(textContent(await callTool(client, "save_state", { session_id: tubeSid })));
    const intoNoTube = await client.callTool({ name: "restore_state", arguments: { session_id: plainMasterSid, state_id: tubeState } });
    ok("a tube state will not restore into a machine without one", intoNoTube.isError === true && textContent(intoNoTube).includes("tube true there, false here"));
    await callTool(client, "delete_state", { state_id: tubeState });
    await callTool(client, "destroy_machine", { session_id: tubeSid });
    await callTool(client, "delete_state", { state_id: netState });
    for (const id of [masterNetSid, plainMasterSid, otherNetSid]) await callTool(client, "destroy_machine", { session_id: id });
    const atomNet = await client.callTool({ name: "create_machine", arguments: { model: "Atom", econet: true } });
    ok("the Atom refuses Econet", atomNet.isError === true);

    // --- Atom ---
    console.log("\n--- Atom ---");
    const atomResult = await callTool(client, "create_machine", { model: "Atom" });
    const { session_id: atomSid, boot_output: atomBoot } = JSON.parse(textContent(atomResult));
    ok("Atom boots to its prompt", atomBoot.screenText.includes("ACORN ATOM"));
    const atomInternal = await client.callTool({ name: "key_down", arguments: { session_id: atomSid, internal: 66 } });
    ok("the Atom has no internal key numbers", atomInternal.isError === true);
    const atomRept = JSON.parse(textContent(await callTool(client, "key_down", { session_id: atomSid, key: "REPT" })));
    ok("the Atom presses its own keys by name", atomRept.pressed[0]?.name === "REPT");
    await callTool(client, "key_up", { session_id: atomSid, key: "REPT" });
    const atomHeld = JSON.parse(textContent(await callTool(client, "keyboard_state", { session_id: atomSid })));
    ok("and releases them", atomHeld.held_keys.length === 0);
    const atomCaps = await client.callTool({ name: "key_down", arguments: { session_id: atomSid, key: "CAPSLOCK" } });
    ok("a BBC-only name is refused on the Atom", atomCaps.isError === true);
    ok("with the Atom's own list", textContent(atomCaps).includes("LOCK") && !textContent(atomCaps).includes("CAPSLOCK,"));
    await callTool(client, "type_input", { session_id: atomSid, text: "PRINT 6*7" });
    const atomRun = JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id: atomSid })));
    console.log("Atom output:", JSON.stringify(atomRun.screenText));
    ok("Atom types and runs to its prompt", atomRun.screenText.includes("42"));
    const atomFlush = await client.callTool({ name: "flush_keyboard_buffer", arguments: { session_id: atomSid } });
    ok("the Atom has no keyboard buffer to flush", atomFlush.isError === true);
    await callTool(client, "destroy_machine", { session_id: atomSid });

    // --- run_disc (one-shot) ---
    console.log("\n--- run_disc (one-shot) ---");
    const runDiscResult = await callTool(client, "run_disc", {
        image_path: resolve(__dirname, "examples/hello.ssd"),
        screenshot: true,
    });
    const rdText = textContent(runDiscResult);
    const rdParsed = JSON.parse(rdText);
    console.log("run_disc output:", JSON.stringify(rdParsed.output.screenText));
    ok("run_disc returns output", !!rdParsed.output);
    const rdImg = imageContent(runDiscResult);
    ok("run_disc returns screenshot", !!rdImg);

    const stdoutLabel = transportErrors.length ? `first: ${transportErrors[0]}` : "none";
    ok(`stdout carries only JSON-RPC (${stdoutLabel})`, transportErrors.length === 0);

    // --- Results ---
    console.log(`\n${"─".repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);

    await client.close();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error("Test error:", err);
    process.exit(1);
});
