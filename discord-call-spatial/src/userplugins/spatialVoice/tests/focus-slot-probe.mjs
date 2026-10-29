/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Read-only geometry probe for the call's top-left corner: what the call view
// is, what sits in its header band, where every native control is, and what the
// pointer actually hits. Nothing is clicked, written or reloaded.
//
//   node src/userplugins/spatialVoice/tests/focus-slot-probe.mjs

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
    const round = n => Math.round(n * 10) / 10;
    const box = element => {
        const r = element.getBoundingClientRect();
        return { left: round(r.left), top: round(r.top), width: round(r.width), height: round(r.height), bottom: round(r.bottom), right: round(r.right) };
    };
    const describe = element => {
        const style = getComputedStyle(element);
        return {
            tag: element.tagName.toLowerCase(),
            cls: String(element.className ?? "").slice(0, 70),
            label: element.getAttribute?.("aria-label") ?? null,
            box: box(element),
            zIndex: style.zIndex,
            position: style.position
        };
    };
    const labelOf = element => element.getAttribute?.("aria-label") ?? element.getAttribute?.("title") ?? "";

    const tiles = Array.from(document.querySelectorAll("[data-call-tile]"));
    if (!tiles.length) return { tiles: 0, note: "no call view on screen", title: document.title };

    let lca = tiles[0];
    while (lca && !tiles.every(tile => lca.contains(tile))) lca = lca.parentElement;

    // the same rule callFocus.ts uses: the nearest ancestor holding a fullscreen control
    let surface = lca, control = null;
    for (let depth = 0; surface && depth < 12; depth++, surface = surface.parentElement) {
        control = Array.from(surface.querySelectorAll("button, [role='button']")).find(button => /full\\s*-?\\s*screen/i.test(labelOf(button)));
        if (control) break;
    }

    const buttons = surface ? Array.from(surface.querySelectorAll("button, [role='button']")).map(describe) : [];

    // every element whose box starts inside the surface's top band and left half
    const surfaceBox = surface ? box(surface) : null;
    const band = [];
    if (surface) {
        const bandBottom = surfaceBox.top + 140;
        for (const element of surface.querySelectorAll("*")) {
            const b = box(element);
            if (b.width === 0 || b.height === 0) continue;
            if (b.top > bandBottom || b.left > surfaceBox.left + 720) continue;
            const style = getComputedStyle(element);
            if (style.visibility === "hidden" || style.display === "none") continue;
            band.push(describe(element));
        }
    }

    // what the pointer hits across the corner slots
    const hit = (x, y) => {
        const element = document.elementFromPoint(x, y);
        if (!element) return null;
        const chain = [];
        let node = element;
        while (node && chain.length < 4) { chain.push(String(node.className ?? node.tagName).slice(0, 50)); node = node.parentElement; }
        return { at: [round(x), round(y)], hit: chain[0], chain };
    };

    const samples = [];
    if (surfaceBox) {
        const inset = 12;
        const spots = {
            "top-left": [surfaceBox.left + inset + 16, surfaceBox.top + inset + 16],
            "top-left below band": [surfaceBox.left + inset + 16, surfaceBox.top + 72 + 16],
            "top-right": [surfaceBox.right - inset - 16, surfaceBox.top + inset + 16],
            "bottom-left": [surfaceBox.left + inset + 16, surfaceBox.bottom - inset - 16],
            "bottom-right": [surfaceBox.right - inset - 16, surfaceBox.bottom - inset - 16]
        };
        for (const [name, [x, y]] of Object.entries(spots)) samples.push({ slot: name, ...hit(x, y) });
    }

    const toggle = document.querySelector(".sv-call-focus-toggle");

    return {
        title: document.title,
        window: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        tiles: tiles.length,
        surface: surface ? describe(surface) : null,
        fullscreenControl: control ? describe(control) : null,
        toggle: toggle ? { ...describe(toggle), focused: toggle.getAttribute("data-sv-focused"), inline: toggle.getAttribute("style") } : null,
        toggleHit: toggle ? hit(...(() => { const b = box(toggle); return [b.left + b.width / 2, b.top + b.height / 2]; })()) : null,
        buttons,
        band,
        samples
    };
})()`);

ws.close();

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
