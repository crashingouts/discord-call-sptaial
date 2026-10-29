/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Read-only: what the live renderer exposes to a probe, so the store and the
// call view can be found without guessing at internals.

(() => {
    const api = window.Vencord ?? {};
    const out = {
        hasVencord: !!window.Vencord,
        apiKeys: Object.keys(api),
        webpackKeys: api.Webpack ? Object.keys(api.Webpack) : null,
        commonKeys: api.Webpack?.Common ? Object.keys(api.Webpack.Common).slice(0, 40) : null
    };

    const common = api.Webpack?.Common ?? {};
    const stores = ["SelectedChannelStore", "ChannelStore", "VoiceStateStore", "ChannelRTCStore", "SelectedGuildStore", "UserStore"];
    out.stores = {};
    for (const name of stores) {
        const store = common[name];
        out.stores[name] = store ? Object.keys(store).slice(0, 20) : null;
    }

    try {
        out.selectedChannel = common.SelectedChannelStore?.getChannelId?.() ?? null;
    } catch (err) { out.selectedChannelError = String(err); }
    try {
        out.voiceChannel = common.VoiceStateStore?.getCurrentClientVoiceChannelId?.(null) ?? null;
    } catch (err) { out.voiceChannelError = String(err); }
    try {
        out.guildId = common.SelectedGuildStore?.getGuildId?.() ?? null;
    } catch (err) { out.guildIdError = String(err); }

    // Every button on screen, with its label, so the call view's own controls
    // (including a fullscreen toggle) can be named from evidence.
    out.buttons = Array.from(document.querySelectorAll("button, [role='button']")).map(button => {
        const r = button.getBoundingClientRect();
        return {
            label: button.getAttribute("aria-label") ?? button.getAttribute("title") ?? button.textContent?.trim().slice(0, 40) ?? "",
            pressed: button.getAttribute("aria-pressed"),
            className: String(button.className ?? "").slice(0, 50),
            rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
        };
    }).filter(entry => entry.rect.w > 8 && entry.rect.h > 8);

    out.tiles = Array.from(document.querySelectorAll("[data-call-tile]")).map(tile => {
        const r = tile.getBoundingClientRect();
        return { tileId: tile.getAttribute("data-selenium-video-tile"), rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
    });

    return out;
})();
