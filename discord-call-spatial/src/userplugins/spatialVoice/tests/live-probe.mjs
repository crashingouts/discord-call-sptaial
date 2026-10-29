/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Live probe: attaches to a running Discord renderer over the Chrome DevTools
// Protocol, so runtime checks run against the real client instead of a harness.
// The client must have been started with --remote-debugging-port=<port>:
//   DiscordCanary.exe --remote-debugging-port=9222
//
// Usage:
//   node src/userplugins/spatialVoice/tests/live-probe.mjs "<js expression>"
//   node src/userplugins/spatialVoice/tests/live-probe.mjs --file probe.js
//   node src/userplugins/spatialVoice/tests/live-probe.mjs --screenshot out.png
//   node src/userplugins/spatialVoice/tests/live-probe.mjs --reload
//
// --port 9222 selects another debugging port.

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = name => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
};
const has = name => args.includes(name);
const port = Number(flag("--port") ?? 9222);
const shotPath = flag("--screenshot");
const file = flag("--file");
const clickPoint = flag("--click");
// --apply sets the flag a probe script reads before it writes anything, so the
// same file runs once as a plan and once for real.
const applyPrefix = has("--apply") ? "globalThis.__SV_RELEASE_APPLY = true;\n" : "";
const expression = shotPath || has("--reload") || clickPoint
    ? null
    : file
        ? applyPrefix + readFileSync(file, "utf8")
        : args.find(a => !a.startsWith("--") && a !== flag("--port"));

const listUrl = `http://127.0.0.1:${port}/json/list`;

async function findPage() {
    const res = await fetch(listUrl);
    if (!res.ok) throw new Error(`CDP list answered ${res.status}`);
    const targets = await res.json();
    const page = targets.find(t => t.type === "page" && /discord\.com/.test(t.url));
    if (!page) throw new Error(`no Discord page target (saw: ${targets.map(t => t.type + " " + t.url).join(", ")})`);
    return page;
}

function call(page, method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        const timer = setTimeout(() => {
            try { ws.close(); } catch { /* already closed */ }
            reject(new Error(`${method} timed out`));
        }, timeoutMs);

        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ id: 1, method, params }));
        });

        ws.addEventListener("message", event => {
            const msg = JSON.parse(event.data);
            if (msg.id !== 1) return;
            clearTimeout(timer);
            ws.close();
            if (msg.error) return reject(new Error(msg.error.message));
            resolve(msg.result);
        });

        ws.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("WebSocket error talking to the page target"));
        });
    });
}

async function evaluate(page, expr) {
    const r = await call(page, "Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        allowUnsafeEvalBlockedByCSP: true
    });
    if (r.exceptionDetails) {
        return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
    }
    return r.result?.value;
}

try {
    const page = await findPage();

    if (shotPath) {
        const { data } = await call(page, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(shotPath, Buffer.from(data, "base64"));
        process.stdout.write(JSON.stringify({ screenshot: shotPath, bytes: Buffer.byteLength(data, "base64") }) + "\n");
    } else if (has("--reload")) {
        await call(page, "Page.reload", { ignoreCache: false });
        process.stdout.write(JSON.stringify({ reloaded: page.id }) + "\n");
    } else if (clickPoint) {
        // A real pointer event, the way a person clicks the scene: move, press,
        // release. React sees the same onClick a hand would raise.
        const [x, y] = clickPoint.split(",").map(Number);
        await call(page, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
        await call(page, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
        await call(page, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
        process.stdout.write(JSON.stringify({ clicked: [x, y] }) + "\n");
    } else {
        const value = await evaluate(page, expression);
        process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    }
} catch (err) {
    process.stdout.write(JSON.stringify({ __probe_error: String(err?.message ?? err) }, null, 2) + "\n");
    process.exit(1);
}
