/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Live inspection of the installed Spatial Voice plugin and the view it drives,
// evaluated inside the running Discord renderer. Run it through
// tests/live-probe.mjs --file tests/focus-probe.js.
//
// It measures, never mutates: the only writes are the ones the installed plugin
// makes for itself. Every number it reports is read off the live document.

(() => {
    const plugins = window.Vencord?.Plugins?.plugins ?? {};
    const spatial = plugins["Spatial Voice"] ?? plugins.spatialVoice ?? null;

    const find = props => {
        try {
            return window.Vencord?.Webpack?.findByProps?.(...(Array.isArray(props) ? props : [props])) ?? null;
        } catch { return null; }
    };

    const voiceStates = find("getCurrentClientVoiceChannelId");
    const selected = find("getChannelId");

    let voiceChannelId = null;
    try {
        voiceChannelId = voiceStates?.getCurrentClientVoiceChannelId?.(null) ?? null;
    } catch { /* store shape differs */ }

    let selectedChannelId = null;
    try {
        selectedChannelId = selected?.getChannelId?.() ?? null;
    } catch { /* store shape differs */ }

    const toggle = document.querySelector(".sv-call-focus-toggle");
    const host = document.querySelector("[data-sv-host]");
    const scene = document.querySelector(".sv-scene");

    const rect = element => {
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    };

    const styleOf = element => (element ? getComputedStyle(element) : null);

    // Everything the plugin wrote inline on Discord's own nodes, so a leftover
    // can be seen instead of guessed at.
    const inlineWrites = [];
    for (const element of document.querySelectorAll("[style]")) {
        if (element.closest("[data-sv-host]")) continue;
        const inline = element.getAttribute("style") ?? "";
        if (!/grid-template-columns|display:\s*none|position:\s*relative/.test(inline)) continue;
        inlineWrites.push({
            tag: element.tagName,
            className: String(element.className ?? "").slice(0, 60),
            inline: inline.slice(0, 200),
            rect: rect(element)
        });
    }

    // The call area, as the installed rules would find it.
    const tiles = Array.from(document.querySelectorAll("[data-call-tile]"));
    const videos = Array.from(document.querySelectorAll("video")).filter(video => {
        const stream = video.srcObject;
        return !!stream && typeof stream.getVideoTracks === "function" && stream.getVideoTracks().length > 0;
    });

    const pageColumn = host?.closest('[class*="page_"]') ?? scene?.parentElement ?? null;
    const layoutGrid = pageColumn?.parentElement?.parentElement ?? null;

    const sidebar = document.querySelector('[class*="sidebar__"]') ?? null;
    const guilds = document.querySelector('[class*="guilds__"]') ?? null;

    return {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        plugin: spatial ? {
            name: spatial.name,
            enabled: !!spatial.settings?.store?.enabled,
            spatialEnabled: spatial.settings?.store?.spatialEnabled,
            started: !!spatial._started
        } : null,
        call: {
            voiceChannelId,
            selectedChannelId,
            tileCount: tiles.length,
            liveVideoCount: videos.length,
            videoRects: videos.map(video => rect(video))
        },
        mounted: { host: !!host, scene: !!scene, toggle: !!toggle },
        hostRect: rect(host),
        toggle: toggle ? {
            focused: toggle.getAttribute("data-sv-focused"),
            label: toggle.getAttribute("aria-label"),
            chevron: toggle.querySelector("[data-sv-chevron]")?.getAttribute("data-sv-chevron") ?? null,
            rect: rect(toggle),
            zIndex: styleOf(toggle)?.zIndex ?? null
        } : null,
        layout: {
            layoutGridClass: layoutGrid?.className ?? null,
            columns: styleOf(layoutGrid)?.gridTemplateColumns ?? null,
            columnsInline: layoutGrid?.style?.gridTemplateColumns ?? "",
            page: rect(pageColumn),
            sidebar: rect(sidebar),
            sidebarDisplay: styleOf(sidebar)?.display ?? null,
            guilds: rect(guilds),
            bodyScrollWidth: document.body.scrollWidth
        },
        inlineWrites,
        sceneDiag: window.__spatialVoiceScene ?? null
    };
})();
