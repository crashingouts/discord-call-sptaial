/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs the real callFocus.ts, bundled, against the live document: no copy of the
// rules, the module's own `findCallView`. Read-only; it only reports.
//
// Build the bundle first:
//   esbuild callFocus.ts --bundle --format=iife --global-name=SVCallFocus \
//     --outfile=captures/live/callFocus.bundle.js
//
// Then run with the bundle's text prepended:
//   node tests/live-probe.mjs "$(cat captures/live/callFocus.bundle.js) $(cat tests/callview-probe.js)"

(() => {
    const module = globalThis.SVCallFocus;
    if (!module?.findCallView) return { error: "bundle not loaded" };

    const rectOf = element => {
        const r = element.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    };

    const env = {
        doc: document,
        rectOf,
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
        viewport: () => ({ width: window.innerWidth, height: window.innerHeight })
    };

    // The lookups integration.tsx builds, query for query.
    const lookup = {
        tiles: Array.from(document.querySelectorAll(`[${module.CALL_TILE_ATTRIBUTE}]`)),
        buttons: Array.from(document.querySelectorAll('button, [role="button"]')),
        controls: null,
        guildNavs: Array.from(document.querySelectorAll(`[data-list-item-id^="${module.GUILD_NAV_PREFIX}"]`))
    };

    const view = module.findCallView(env, lookup);
    const className = element => String(element?.className ?? "").slice(0, 60);

    return {
        url: location.href,
        tiles: lookup.tiles.length,
        buttons: lookup.buttons.length,
        guildNavs: lookup.guildNavs.length,
        viewport: env.viewport(),
        decision: view
            ? {
                found: true,
                surface: className(view.surface),
                grid: className(view.grid),
                fullscreenLabel: view.fullscreen?.getAttribute("aria-label") ?? null,
                expanded: view.expanded,
                surfaceRect: rectOf(view.surface),
                gridRect: rectOf(view.grid),
                gridTouchesGuildNav: lookup.guildNavs.some(nav => view.surface.contains(nav))
            }
            : { found: false }
    };
})();
