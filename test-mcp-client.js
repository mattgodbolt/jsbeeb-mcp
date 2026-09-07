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
    const kdResult = await callTool(client, "key_down", { session_id: sid2, key: "A" });
    ok("key_down returns confirmation", textContent(kdResult).includes("Key down"));
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

    // A hit during type_input is reported by the next run before it runs anything.
    await callTool(client, "clear_breakpoint", { session_id: sid2, id: 0 });
    const oswrch = await setBreakpoint(0xffee);
    await callTool(client, "type_input", { session_id: sid2, text: "X" });
    const pending = await runFor(1000);
    ok("a hit during type_input is reported first", pending.stopped_reason === "pending_breakpoint");
    ok("and names the breakpoint", pending.breakpoint?.id === oswrch.breakpoint_id);
    ok("and nothing runs until it has been", pending.cycles_run === 0 && pending.completed === false);
    const onward = await runFor(1000);
    ok("the next run carries on", onward.cycles_run > 0 && onward.stopped_reason !== "pending_breakpoint");
    await callTool(client, "clear_breakpoint", { session_id: sid2, id: 0 });
    const noBreakpoint = await runFor(1000);
    ok("a run with no breakpoint completes", noBreakpoint.completed === true && noBreakpoint.breakpoint === undefined);
    // A stop leaves no unspent budget behind: the run after it is the length asked for, within an instruction.
    ok("the run after a breakpoint stop runs only what was asked", Math.abs(noBreakpoint.cycles_run - 1000) <= 16);

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

    // A state can seed a second machine, so long as it is the same model.
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

    const overLongLabel = await client.callTool({
        name: "save_state",
        arguments: { session_id: sid4, label: "x".repeat(500) },
    });
    ok("save_state rejects an over-long label", overLongLabel.isError === true);

    await callTool(client, "delete_state", { state_id });
    const afterDelete = JSON.parse(textContent(await callTool(client, "list_states", {})));
    ok("delete_state removes it", !afterDelete.states.some((s) => s.state_id === state_id));

    for (const id of [sid4, sid5, masterSid]) await callTool(client, "destroy_machine", { session_id: id });

    // --- Atom ---
    console.log("\n--- Atom ---");
    const atomResult = await callTool(client, "create_machine", { model: "Atom" });
    const { session_id: atomSid, boot_output: atomBoot } = JSON.parse(textContent(atomResult));
    ok("Atom boots to its prompt", atomBoot.screenText.includes("ACORN ATOM"));
    await callTool(client, "type_input", { session_id: atomSid, text: "PRINT 6*7" });
    const atomRun = JSON.parse(textContent(await callTool(client, "run_until_prompt", { session_id: atomSid })));
    console.log("Atom output:", JSON.stringify(atomRun.screenText));
    ok("Atom types and runs to its prompt", atomRun.screenText.includes("42"));
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
