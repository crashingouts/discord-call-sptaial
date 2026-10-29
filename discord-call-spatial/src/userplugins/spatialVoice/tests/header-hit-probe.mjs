/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Read-only: does the pointer reach Discord's call header, and at which points?
// Nothing is clicked, written or reloaded.
//
//   node src/userplugins/spatialVoice/tests/header-hit-probe.mjs

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = targets.find(entry => entry.type === "page" && /discord\.com/.test(entry.url));
if (!target) throw new Error("no Discord page target");

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

await new Promise(resolve => ws.addEventListener("open", resolve));

const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);

    return result.result?.value;
};

const report = await evaluate(`(() => {
    const name = element => {
        if (!element) return null;
        const cls = typeof element.className === "string" ? element.className : "";
        return (element.tagName.toLowerCase() + "." + cls.split(/\\s+/).filter(Boolean).slice(0, 2).join(".")).slice(0, 60);
    };
    const chain = (x, y) => (document.elementsFromPoint(x, y) ?? []).slice(0, 6).map(name);

    const tiles = Array.from(document.querySelectorAll("[data-call-tile]"));
    const lca = tiles.length ? (() => { let n = tiles[0]; while (n && !tiles.every(t => n.contains(t))) n = n.parentElement; return n; })() : null;
    const surface = lca ? (() => { let n = lca; for (let d = 0; n && d < 12; d++, n = n.parentElement) { if (Array.from(n.querySelectorAll("button")).some(b => /full\\s*-?\\s*screen/i.test(b.getAttribute("aria-label") ?? ""))) return n; } return null; })() : null;
    if (!surface) return { found: false };

    const header = surface.querySelector('[class*="topControls"]') ?? surface;
    const title = surface.querySelector('[class*="titleWrapper"], [class*="title_"]');
    const headerStyle = getComputedStyle(header);

    const points = {
        "title centre": title ? [title.getBoundingClientRect().left + title.getBoundingClientRect().width / 2, title.getBoundingClientRect().top + title.getBoundingClientRect().height / 2] : null,
        "below the header": [surface.getBoundingClientRect().left + 28, surface.getBoundingClientRect().top + 65],
        "corner 28,28": [surface.getBoundingClientRect().left + 28, surface.getBoundingClientRect().top + 28]
    };

    const samples = {};
    for (const [label, point] of Object.entries(points)) {
        if (!point) { samples[label] = null; continue; }
        samples[label] = { at: point.map(Math.round), chain: chain(point[0], point[1]) };
    }

    return {
        found: true,
        header: { pointerEvents: headerStyle.pointerEvents, box: header.getBoundingClientRect().toJSON(), className: String(header.className).slice(0, 50) },
        title: title ? { box: title.getBoundingClientRect().toJSON(), pointerEvents: getComputedStyle(title).pointerEvents, className: String(title.className).slice(0, 50) } : null,
        samples
    };
})()`);

ws.close();

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
