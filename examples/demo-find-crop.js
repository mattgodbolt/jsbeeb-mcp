import { MachineSession } from "../machine-session.js";
import { writeFileSync } from "fs";
import sharp from "sharp";

const CYCLES_PER_FRAME = 40_000;

async function main() {
    const session = new MachineSession("B-DFS1.2");
    await session.initialise();
    await session.boot(30);
    session.loadDisc("/home/molty/dev/beebasm/demo.ssd");
    await session.type("*RUN Code\r");
    await session.runFor(CYCLES_PER_FRAME * 155);

    const png = await session.screenshot();

    // R0=127 total → 1024/128 = 8 fb pixels per char clock
    // R1=64 displayed chars × 8 fb px/char = 512 active fb px wide
    // R9+1=8 scanlines × 2 fb lines/scanline = 16 fb lines per char row
    // R6=32 char rows × 16 = 512 fb px tall
    const crops = [
        { name: "std",    left: 80,  top: 12, width: 512, height: 512 },
        { name: "narrow", left: 80,  top: 12, width: 512, height: 256 }, // half height
        { name: "wide",   left: 80,  top: 12, width: 640, height: 512 },
        { name: "sq2x",   left: 80,  top: 12, width: 512, height: 512, scalew: 256 }, // halve width
    ];

    for (const c of crops) {
        let pipeline = sharp(png).extract({ left: c.left, top: c.top, width: c.width, height: c.height });
        if (c.scalew) pipeline = pipeline.resize(c.scalew, c.height, { kernel: "nearest" });
        const out = await pipeline.png().toBuffer();
        writeFileSync(`/home/molty/.openclaw/workspace/crop-${c.name}.png`, out);
        console.log(`crop-${c.name}.png`);
    }

    session.destroy();
}

main().catch(err => { console.error(err); process.exit(1); });
