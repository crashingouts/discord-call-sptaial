/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Spatial Voice — plugin entry point and lifecycle.
 *
 * The plugin is deliberately thin: it registers the settings and the stylesheet,
 * mounts one host inside Discord's own voice view, and takes that host down
 * again. Everything else lives in the module that owns it:
 *
 *   settings.ts       native Vencord settings, resolved into one snapshot
 *   integration.tsx   the Discord adapter: participants, live feeds, native chrome
 *   callFocus.ts      the call view, and the chevron that toggles Discord's own fullscreen
 *   SpatialScene.tsx  the scene: positioning, tiles, avatars, connectors, paging
 *   layout.ts         deterministic spatial layout            (w2)
 *   speaking.ts       per-participant speaking hold            (w3)
 *   connectors.ts     measured radial lines                    (w4)
 *   style.css         themes and the visual layer              (w5)
 *
 * Lifecycle: `start` mounts, `stop` unmounts and restores every Discord node the
 * adapter touched. Leaving a channel, joining another, switching cameras and
 * resizing the window are all handled inside the host, which re-attaches itself
 * when Discord replaces the call surface; the handlers below only shorten the
 * wait by asking for that re-attach at the moment the client says it changed.
 */

import definePlugin from "@utils/types";

import { mountSpatialHost,SpatialHost } from "./integration";
import { clearSettingsListeners, settings } from "./settings";
import spatialStyles from "./style.css?managed";

let host: SpatialHost | null = null;

/**
 * The master switch, read from the option's own key.
 *
 * `settings.store` also carries Vencord's `enabled` flag for the plugin itself,
 * which is true whenever the plugin is running: reading `enabled` there (as the
 * resolved snapshot does) made the switch invisible, because the scene stayed
 * mounted with the option off. The scene's own option is `spatialEnabled`.
 */
function sceneEnabled(): boolean {
    const value = (settings.store as Record<string, unknown>).spatialEnabled;

    return typeof value === "boolean" ? value : true;
}

/** Brings the host in line with the current settings and call surface. */
function reconcile() {
    if (!sceneEnabled()) {
        host?.destroy();
        host = null;

        return;
    }

    if (host === null) {
        host = mountSpatialHost();
    } else {
        host.refresh();
    }
}

export default definePlugin({
    name: "Spatial Voice",
    description:
        "Turns a voice channel into a spatial scene: real camera feeds float as panels around the scene, camera-off people sit as avatars, thin lines run from Discord's own control bar to each person, and a speaking avatar grows and holds. Nine background themes, all settings applied without a restart.",
    tags: ["Voice", "Appearance"],
    authors: [{ name: "User", id: 0n }],
    settings,
    managedStyle: spatialStyles,

    // A channel change swaps the whole call surface out, and a voice-state update
    // can add or remove the participants that decide whether a scene exists at
    // all. Both are just "look again", never a remount of a live call.
    flux: {
        VOICE_CHANNEL_SELECT: () => reconcile(),
        VOICE_STATE_UPDATES: () => reconcile(),
        RTC_CONNECTION_STATE: () => reconcile()
    },

    start() {
        reconcile();
    },

    stop() {
        host?.destroy();
        host = null;
        clearSettingsListeners();
    }
});
