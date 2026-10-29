/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Releases a leaked Spatial Voice mount from a running client: removes the
// plugin's own host, scene and button, and puts back every inline value and
// class the plugin is known to write, leaving everything else alone.
//
// Read the plan first with tests/live-probe.mjs --file tests/release-live.js and
// run it with `__plan` set by --apply on the command line:
//   node tests/live-probe.mjs --file tests/release-live.js        (plan only)
//   node tests/live-probe.mjs "$(cat tests/release-live.js)" ...  (see README)
//
// The default (evaluate as-is) is a dry run that reports exactly what it would
// remove or restore; nothing is written.

(() => {
    const apply = globalThis.__SV_RELEASE_APPLY === true;
    const actions = [];
    const skipped = [];

    // 1. The plugin's own nodes. They carry the plugin's own attributes, so
    //    nothing of Discord's can match them.
    const ownNodes = Array.from(document.querySelectorAll("[data-sv-host], .sv-scene, .sv-call-focus-toggle"));

    // 2. The surface the leaked mount gave `position: relative`, found the way
    //    the module finds it: the parent of the host. Collected before anything
    //    is removed, because a removed node has no parent left to read.
    const surfaces = new Set();
    for (const node of ownNodes) {
        const surface = node.parentElement;
        if (surface && surface.style.position === "relative") surfaces.add(surface);
    }

    for (const node of ownNodes) {
        actions.push({ action: "remove", what: `${node.tagName}.${String(node.className ?? "").slice(0, 40)}` });
        if (apply) node.remove();
    }

    for (const surface of surfaces) {
        actions.push({
            action: "restore inline position",
            what: `${surface.tagName}.${String(surface.className ?? "").slice(0, 40)}`,
            from: surface.style.position,
            to: "(stylesheet value)"
        });
        if (apply) surface.style.position = "";
    }

    // 3. Discord's own call-control bar carries the plugin's class and the
    //    stacking number the plugin wrote next to it.
    for (const bar of Array.from(document.querySelectorAll(".sv-controls"))) {
        actions.push({
            action: "restore control bar",
            what: `${bar.tagName}.${String(bar.className ?? "").slice(0, 40)}`,
            classList: bar.className,
            zIndex: bar.style.zIndex
        });
        if (apply) {
            bar.classList.remove("sv-controls");
            if (bar.style.zIndex === "3") bar.style.zIndex = "";
        }
    }

    // 4. Anything else the plugin marks, reported but not touched: this list is
    //    how a new artifact would be noticed instead of silently left behind.
    //    Children of a removed node are not listed: they leave with their parent.
    for (const node of Array.from(document.querySelectorAll("[class*='sv-']"))) {
        if (ownNodes.includes(node) || node.className === "sv-controls") continue;
        if (ownNodes.some(own => own.contains(node))) continue;
        skipped.push({ what: `${node.tagName}.${String(node.className ?? "").slice(0, 40)}`, why: "not a known plugin artifact" });
    }

    return {
        applied: apply,
        removed: actions.filter(entry => entry.action === "remove").length,
        actions,
        skipped
    };
})();
