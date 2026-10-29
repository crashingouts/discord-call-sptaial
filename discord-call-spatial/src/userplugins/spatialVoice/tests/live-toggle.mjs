/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs the real callFocus.ts against the live client and presses its chevron:
// mounts the controller into Discord's own call view, presses the button twice,
// then destroys it and checks that nothing of it is left.
//
//   node tests/live-toggle.mjs
//
// The bundle is the same one tests/narrow-window.mjs uses:
//   esbuild callFocus.ts --bundle --format=iife --global-name=SVCallFocus \
//     --outfile=captures/live/callFocus.bundle.js
//
// Every write is the module's own, and the module is destroyed at the end, so
// Discord is left exactly as it was found. Nothing is deployed and the renderer
// is never reloaded.

import { readFileSync } from "node:fs";

const BUNDLE = readFileSync(new URL("../captures/live/callFocus.bundle.js", import.meta.url), "utf8");

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
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);

    return result.result?.value;
};

// The harness lives in the page for the length of this run: it builds the same
// environment integration.tsx builds, and exposes step functions.
await evaluate(`
    ${BUNDLE}
    (() => {
        const module = window.SVCallFocus;
        const env = {
            doc: document,
            rectOf: element => {
                const r = element.getBoundingClientRect();
                return { left: r.left, top: r.top, width: r.width, height: r.height };
            },
            styleOf: element => {
                const style = getComputedStyle(element);
                return {
                    position: style.position,
                    pointerEvents: style.pointerEvents,
                    zIndex: style.zIndex,
                    left: style.left,
                    top: style.top
                };
            },
            viewport: () => ({ width: innerWidth, height: innerHeight })
        };

        const look = () => module.findCallView(env, {
            tiles: Array.from(document.querySelectorAll('[data-call-tile]')),
            buttons: Array.from(document.querySelectorAll('button, [role="button"]')),
            controls: null,
            guildNavs: Array.from(document.querySelectorAll('[data-list-item-id^="guildsnav"]'))
        });

        const callClassName = () => {
            const container = document.querySelector('[class*="callContainer"]');
            return String(container?.className ?? "");
        };

        window.__svHarness = {
            focus: new module.CallFocusController(env),
            sync() {
                return this.focus.sync({ channelId: "live", view: look() });
            },
            state() {
                return this.focus.state;
            },
            // The chevron's own press, as a person's click reaches it.
            press() {
                const toggle = document.querySelector("." + module.FOCUS_TOGGLE_CLASS);
                if (!toggle) return { pressed: false };
                toggle.click();
                return { pressed: true };
            },
            button() {
                const toggle = document.querySelector("." + module.FOCUS_TOGGLE_CLASS);
                if (!toggle) return null;
                const r = toggle.getBoundingClientRect();
                return {
                    className: toggle.className,
                    focused: toggle.getAttribute("data-sv-focused"),
                    label: toggle.getAttribute("aria-label"),
                    parent: String(toggle.parentElement?.className ?? "").slice(0, 40),
                    rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
                    chevron: toggle.querySelector("path")?.getAttribute("d") ?? null
                };
            },
            discordFullscreen() {
                return { className: callClassName(), expanded: /(^|\\s)fullScreen/.test(callClassName()) };
            },
            destroy() {
                this.focus.destroy();
                return { togglesLeft: document.querySelectorAll("." + module.FOCUS_TOGGLE_CLASS).length };
            }
        };

        return true;
    })()
`);

const steps = {};
steps.mount = await evaluate(`(() => { window.__svHarness.sync(); return { state: window.__svHarness.state(), button: window.__svHarness.button(), discord: window.__svHarness.discordFullscreen() }; })()`);

steps.pressOne = await evaluate(`(() => { const pressed = window.__svHarness.press(); return pressed; })()`);
await new Promise(resolve => setTimeout(resolve, 400));
steps.afterOne = await evaluate(`(() => { const state = window.__svHarness.sync(); return { state, button: window.__svHarness.button(), discord: window.__svHarness.discordFullscreen() }; })()`);

steps.pressTwo = await evaluate(`(() => window.__svHarness.press())()`);
await new Promise(resolve => setTimeout(resolve, 400));
steps.afterTwo = await evaluate(`(() => { const state = window.__svHarness.sync(); return { state, button: window.__svHarness.button(), discord: window.__svHarness.discordFullscreen() }; })()`);

steps.pressThree = await evaluate(`(() => window.__svHarness.press())()`);
await new Promise(resolve => setTimeout(resolve, 400));
steps.afterThree = await evaluate(`(() => { const state = window.__svHarness.sync(); return { state, discord: window.__svHarness.discordFullscreen() }; })()`);

// Leave the call's fullscreen as it was found, then tear the harness down.
steps.restore = await evaluate(`(() => {
    if (window.__svHarness.discordFullscreen().expanded) window.__svHarness.press();
    return true;
})()`);
await new Promise(resolve => setTimeout(resolve, 400));

steps.destroy = await evaluate(`(() => {
    const result = window.__svHarness.destroy();
    delete window.__svHarness;
    return { ...result, discord: { className: (() => { const c = document.querySelector('[class*="callContainer"]'); return String(c?.className ?? ""); })() } };
})()`);

ws.close();

process.stdout.write(JSON.stringify(steps, null, 2) + "\n");
