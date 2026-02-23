/**
 * Run the BeebAsm star globe demo and capture properly-cropped MODE 2 frames.
 * Run: node examples/demo-crop.js /path/to/demo.ssd
 */
import { MachineSession } from "../machine-session.js";
import { writeFileSync } from "fs";
import sharp from "sharp";

const CYCLES_PER_FRAME = 40_000; // 2MHz / 50Hz

// Custom CRTC in the demo: R6=32 rows, R9+1=8 scanlines → 256 scanlines active
// jsbeeb framebuffer has 2 framebuffer lines per scanline → 512px tall active area.
// Borders: left=80, top=12, right=48. MODE 2 is 160 logical pixels in 896 fb pixels.
// We halve the horizontal scale so pixels are roughly square.
const LEFT   = 80;
const TOP    = 12;
const FB_W   = 1024;
const WIDTH  = FB_W - LEFT - 48; // 896
const HEIGHT = 512;               // 256 BBC scanlines × 2

const discPath = process.argv[2] ?? "/tmp/demo.ssd";

async function main() {
    const session = new MachineSession("B-DFS1.2");
    await session.initialise();
    await session.boot(30);
    session.loadDisc(discPath);
    await session.type("*RUN Code\r");

    console.log("Warming up (150 frames)...");
    await session.runFor(CYCLES_PER_FRAME * 150);

    for (let i = 1; i <= 6; i++) {
        await session.runFor(CYCLES_PER_FRAME * 5);
        const png = await session.screenshot();
        const out = await sharp(png) // already PNG-encoded, sharp decodes it
            .extract({ left: LEFT, top: TOP, width: WIDTH, height: HEIGHT })
            .resize(WIDTH / 2, HEIGHT, { kernel: "nearest" })
            .png()
            .toBuffer();
        const path = `/home/molty/.openclaw/workspace/globe3-${i}.png`;
        writeFileSync(path, out);
        console.log(`Frame ${i} → ${path}`);
    }

    session.destroy();
}

main().catch(err => { console.error(err); process.exit(1); });
