// Capture one region of the live Discord page, so a small detail can be read
// without a whole-window screenshot.
//
// Usage: node clip.mjs <x> <y> <width> <height> <scale> <output.png>

const [x, y, width, height, scale, output] = process.argv.slice(2);
const port = 9222;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === "page" && /discord\.com/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
            id: 1,
            method: "Page.captureScreenshot",
            params: { format: "png", clip: { x: Number(x), y: Number(y), width: Number(width), height: Number(height), scale: Number(scale) } }
        }));
    });
    ws.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (message.id === 1) resolve(message.result);
    });
    setTimeout(() => reject(new Error("timeout")), 20000);
});
const { writeFileSync } = await import("node:fs");
writeFileSync(output, Buffer.from(result.data, "base64"));
console.log(JSON.stringify({ captured: output }));
ws.close();
process.exit(0);
