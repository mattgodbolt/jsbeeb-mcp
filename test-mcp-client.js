/**
 * End-to-end MCP client test for the jsbeeb MCP server.
 * Starts the server as a subprocess and talks to it over the real stdio transport.
 *
 * Run with: node test-mcp-client.js
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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

    // load_disc
    const discPath = resolve(__dirname, "examples/hello.ssd");
    const ldResult = await callTool(client, "load_disc", { session_id, image_path: discPath });
    ok("load_disc succeeds", textContent(ldResult).includes("hello.ssd"));

    await callTool(client, "type_input", { session_id, text: "*RUN hello" });
    const discRun = await callTool(client, "run_until_prompt", { session_id });
    const discOutput = JSON.parse(textContent(discRun));
    console.log("Disc run output:", JSON.stringify(discOutput.screenText));
    ok("disc program output correct", discOutput.screenText.includes("HELLO FROM BEEBASM"));

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
    ok("autoboot returns output", !!autobootParsed.output);
    console.log("Autoboot output:", JSON.stringify(autobootParsed.output.screenText));

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
    console.log("boot_disc output:", JSON.stringify(bootDiscParsed.output.screenText));
    ok("boot_disc returns output", !!bootDiscParsed.output);
    ok("boot_disc loaded disc", bootDiscParsed.image_path.includes("hello.ssd"));
    await callTool(client, "destroy_machine", { session_id: sid3 });

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
