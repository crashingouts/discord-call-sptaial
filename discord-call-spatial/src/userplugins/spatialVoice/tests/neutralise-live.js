/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Neutralises a Spatial Voice instance that is still live but no longer reachable
// through the plugin manager: its host is hidden, its injected stylesheet is
// removed, and the two artifacts it writes on Discord's own nodes are cleared.
//
// It runs the same way as tests/release-live.js:
//   node tests/live-probe.mjs --file tests/neutralise-live.js          (plan)
//   node tests/live-probe.mjs --file tests/neutralise-live.js --apply  (write)
//
// Hiding the host is what survives the leaked instance's own re-mount: the
// instance re-appends the same element it created, and an inline `display: none`
// on that element is not one of the properties it ever writes.

(() => {
    const apply = globalThis.__SV_RELEASE_APPLY === true;
    const actions = [];

    for (const host of Array.from(document.querySelectorAll("[data-sv-host]"))) {
        actions.push({
            action: "hide host",
            what: `${host.tagName}.${String(host.className ?? "").slice(0, 40)}`,
            display: host.style.display || "(none set)"
        });
        if (apply) host.style.display = "none";
    }

    // The plugin's managed stylesheet: one <style> whose text starts with this
    // plugin's own header. Matched on content, never on position, so no other
    // plugin's styles can be removed by mistake.
    for (const style of Array.from(document.querySelectorAll("style"))) {
        const text = style.textContent ?? "";
        if (!text.includes("Spatial Voice, visual layer for the Vencord userplugin")) continue;

        actions.push({ action: "remove stylesheet", what: "style (Spatial Voice visual layer)", bytes: text.length });
        if (apply) style.remove();
    }

    for (const bar of Array.from(document.querySelectorAll(".sv-controls"))) {
        actions.push({
            action: "clear control-bar class",
            what: `${bar.tagName}.${String(bar.className ?? "").slice(0, 40)}`,
            zIndex: bar.style.zIndex || "(none)"
        });
        if (apply) {
            bar.classList.remove("sv-controls");
            if (bar.style.zIndex === "3") bar.style.zIndex = "";
        }
    }

    for (const surface of Array.from(document.querySelectorAll('[style*="position: relative"]'))) {
        if (!String(surface.className ?? "").includes("notAppAsidePanel")) continue;
        actions.push({ action: "clear surface position", what: String(surface.className ?? "").slice(0, 40) });
        if (apply) surface.style.position = "";
    }

    return { applied: apply, actions };
})();
