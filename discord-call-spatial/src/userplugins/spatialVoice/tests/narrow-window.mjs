/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The call view at a narrow size, without touching the real window: the page is
// measured at each viewport with CDP's device-metrics override, then put back.
//
//   node tests/narrow-window.mjs 900x700 1200x800
//
// It reports what the adapter's lookups would see at each size, so a size where
// Discord hides its own right-hand control tray is named instead of guessed.

import { readFileSync } from "node:fs";

const sizes = process.argv.slice(2).map(arg => arg.split("x").map(Number));
if (sizes.length === 0) sizes.push([900, 700], [1200, 800], [1440, 900]);

const PROBE = readFileSync(new URL("./callview-probe.js", import.meta.url), "utf8");
const BUNDLE = readFileSync(new URL("../captures/live/callFocus.bundle.js", import.meta.url), "utf8");

async function page() {
    const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
    const target = targets.find(entry => entry.type === "page" && /discord\.com/.test(entry.url));
    if (!target) throw new Error("no Discord page target");
    return target;
}

function connect(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let nextId = 0;
    const pending = new Map();

    ws.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    });

    const send = (method, params) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });

    const open = new Promise(resolve => ws.addEventListener("open", resolve));

    return { send, open, close: () => ws.close() };
}

const target = await page();
const cdp = connect(target);
await cdp.open;

const results = [];
for (const [width, height] of sizes) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const evaluated = await cdp.send("Runtime.evaluate", {
        expression: `${BUNDLE}\n${PROBE}`,
        returnByValue: true,
        awaitPromise: true
    });
    const decision = evaluated.result?.value ?? { error: evaluated.exceptionDetails?.text };
    results.push({ requested: `${width}x${height}`, got: decision.viewport, decision: decision.decision });
}
await cdp.send("Emulation.clearDeviceMetricsOverride");
cdp.close();

process.stdout.write(JSON.stringify(results, null, 2) + "\n");
