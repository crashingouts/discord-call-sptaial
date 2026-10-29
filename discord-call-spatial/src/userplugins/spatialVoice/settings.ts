/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Spatial Voice — native Vencord settings.
 *
 * Every option here is read by the scene, the connectors, the speaking hold or
 * the background; none is decorative. Changes are published through
 * {@link subscribeSettings} the moment Vencord writes them, so the scene updates
 * without a Discord restart, and Vencord persists them in its own settings file
 * (the plugin's `settings` object is what `definePluginSettings` registers).
 *
 * Option kinds follow this checkout's API — see
 * src/userplugins/discordDepth3d/index.tsx, which uses
 * `definePluginSettings({ key: { type: OptionType.BOOLEAN | SLIDER | SELECT, … } })`
 * with `default`, `markers`, `stickToMarkers`, `onChange` and `hidden`.
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import {
    DEFAULT_SPATIAL_SETTINGS,
    isSpatialTheme,
    SPATIAL_THEMES,
    SpatialLayoutMode,
    SpatialSettingsSnapshot,
    SpatialThemeId
} from "./types";

/** Everyone who has to hear about a settings change immediately. */
const listeners = new Set<(snapshot: SpatialSettingsSnapshot) => void>();

function publish() {
    const snapshot = readSettings();
    for (const listener of Array.from(listeners)) {
        try {
            listener(snapshot);
        } catch {
            /* one bad subscriber must not starve the rest */
        }
    }
}

/**
 * Subscribes to setting changes. The callback runs once per change with the
 * whole resolved snapshot, so the scene has one code path for the first render
 * and for every later change.
 */
export function subscribeSettings(listener: (snapshot: SpatialSettingsSnapshot) => void): () => void {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
}

/** Drops every subscriber; called when the plugin stops. */
export function clearSettingsListeners() {
    listeners.clear();
}

/** Clamps a stored number into the range the option allows. */
function number(value: unknown, fallback: number, low: number, high: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, low), high);
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function layoutMode(value: unknown): SpatialLayoutMode {
    return value === "overview" || value === "selected" || value === "auto" ? value : DEFAULT_SPATIAL_SETTINGS.layoutMode;
}

function theme(value: unknown): SpatialThemeId {
    return isSpatialTheme(value) ? value : DEFAULT_SPATIAL_SETTINGS.theme;
}

const themeOptions = SPATIAL_THEMES.map((option, index) => ({
    label: option.label,
    value: option.id,
    default: index === 0
}));

export const settings = definePluginSettings({
    spatialEnabled: {
        type: OptionType.BOOLEAN,
        description: "Show the spatial scene in the voice channel you are connected to. Off leaves Discord's own call view exactly as it was, with no restart.",
        default: DEFAULT_SPATIAL_SETTINGS.enabled,
        onChange: publish
    },
    layoutMode: {
        type: OptionType.SELECT,
        description: "Which layout opens first. Auto follows whichever camera Discord has focused; Overview never promotes one; Selected always promotes the focused camera.",
        options: [
            { label: "Auto (follow Discord's focused camera)", value: "auto", default: true },
            { label: "Overview (no main camera)", value: "overview" },
            { label: "Selected camera (large main panel)", value: "selected" }
        ],
        onChange: publish
    },
    motionPercent: {
        type: OptionType.SLIDER,
        description: "Scene animation intensity: transition speed, background drift and the avatar emphasis timing all scale from this. 0 leaves the scene still.",
        markers: [0, 25, 50, 75, 100],
        default: DEFAULT_SPATIAL_SETTINGS.motionPercent,
        stickToMarkers: false,
        onChange: publish
    },

    autoPositioning: {
        type: OptionType.BOOLEAN,
        description: "Place participants by the spatial layout engine. Off keeps everyone in a compact grid inside the same scene, for a calmer view.",
        default: DEFAULT_SPATIAL_SETTINGS.autoPositioning,
        onChange: publish
    },
    spacing: {
        type: OptionType.SLIDER,
        description: "Space between participants. Higher keeps more negative space around each tile and avatar; lower packs a large call tighter.",
        markers: [0, 25, 50, 75, 100],
        default: DEFAULT_SPATIAL_SETTINGS.spacing,
        stickToMarkers: false,
        onChange: publish
    },
    selectedWidth: {
        type: OptionType.SLIDER,
        description: "Main camera panel width, as a percentage of the usable scene width. The design targets 40–50%.",
        markers: [30, 35, 40, 45, 50, 55, 60],
        default: DEFAULT_SPATIAL_SETTINGS.selectedWidth,
        stickToMarkers: true,
        onChange: publish
    },
    videoSize: {
        type: OptionType.SLIDER,
        description: "Preferred width of a secondary camera tile in pixels. The scene scales it down automatically in a small window.",
        markers: [120, 180, 240, 280, 340, 420],
        default: DEFAULT_SPATIAL_SETTINGS.videoSize,
        stickToMarkers: false,
        onChange: publish
    },
    avatarSize: {
        type: OptionType.SLIDER,
        description: "Diameter of a camera-off participant's avatar in pixels, before any speaking enlargement.",
        markers: [32, 44, 60, 76, 96],
        default: DEFAULT_SPATIAL_SETTINGS.avatarSize,
        stickToMarkers: false,
        onChange: publish
    },
    avoidCollisions: {
        type: OptionType.BOOLEAN,
        description: "Reserve room for the largest speaking enlargement so an avatar never grows into a neighbour. Off lets tiles sit closer but they can overlap while someone speaks.",
        default: DEFAULT_SPATIAL_SETTINGS.avoidCollisions,
        onChange: publish
    },

    showConnectors: {
        type: OptionType.BOOLEAN,
        description: "Draw the radial connector lines from the call-control bar to each participant.",
        default: DEFAULT_SPATIAL_SETTINGS.showConnectors,
        onChange: publish
    },
    connectorOpacity: {
        type: OptionType.SLIDER,
        description: "Connector line opacity.",
        markers: [0, 25, 50, 75, 100],
        default: DEFAULT_SPATIAL_SETTINGS.connectorOpacity,
        stickToMarkers: false,
        onChange: publish
    },
    connectorWidth: {
        type: OptionType.SLIDER,
        description: "Connector line width, in hundredths of a pixel: 125 is 1.25 pixels.",
        markers: [50, 75, 125, 200, 300],
        default: DEFAULT_SPATIAL_SETTINGS.connectorWidth,
        stickToMarkers: false,
        onChange: publish
    },
    connectorGlow: {
        type: OptionType.SLIDER,
        description: "Glow around the connector lines. 0 draws them flat with no filter at all.",
        markers: [0, 25, 50, 75, 100],
        default: DEFAULT_SPATIAL_SETTINGS.connectorGlow,
        stickToMarkers: false,
        onChange: publish
    },
    connectorSpeakingHighlight: {
        type: OptionType.SLIDER,
        description: "How much brighter a speaking camera-off participant's line gets while their hold lasts.",
        markers: [0, 25, 50, 75, 100],
        default: DEFAULT_SPATIAL_SETTINGS.connectorSpeakingHighlight,
        stickToMarkers: false,
        onChange: publish
    },

    theme: {
        type: OptionType.SELECT,
        description: "Background theme. Applies immediately and does not move anyone: the layout, connectors and controls are shared by all nine.",
        options: themeOptions,
        onChange: publish
    },
    backgroundIntensity: {
        type: OptionType.SLIDER,
        description: "Strength of the background atmosphere: nebula haze, light rays and the vignette.",
        markers: [0, 25, 50, 75, 100],
        default: DEFAULT_SPATIAL_SETTINGS.backgroundIntensity,
        stickToMarkers: false,
        onChange: publish
    },
    particles: {
        type: OptionType.BOOLEAN,
        description: "Drifting stars, dust and bubbles, where the theme has them. Off keeps the gradients and turns the animated layers off.",
        default: DEFAULT_SPATIAL_SETTINGS.particles,
        onChange: publish
    },

    restyleControls: {
        type: OptionType.BOOLEAN,
        description: "Float Discord's own call-control bar over the scene. The buttons are the real ones, so microphone, camera, screen share, reactions and leave keep their handlers, permissions and device menus.",
        default: DEFAULT_SPATIAL_SETTINGS.restyleControls,
        onChange: publish
    },

    speakingAvatars: {
        type: OptionType.BOOLEAN,
        description: "Enlarge a camera-off participant's avatar while they speak, and hold it after they stop. Camera-on tiles are never enlarged.",
        default: DEFAULT_SPATIAL_SETTINGS.speakingAvatars,
        onChange: publish
    },
    avatarScale: {
        type: OptionType.SLIDER,
        description: "Speaking avatar scale, in percent. 140 is 1.4×.",
        markers: [100, 120, 140, 160, 180, 200],
        default: DEFAULT_SPATIAL_SETTINGS.avatarScale,
        stickToMarkers: true,
        onChange: publish
    },
    holdSeconds: {
        type: OptionType.SLIDER,
        description: "Seconds the avatar stays enlarged after the last speaking activity. Each new activity restarts the countdown for that participant alone.",
        markers: [1, 3, 5, 10, 15, 20, 30],
        default: DEFAULT_SPATIAL_SETTINGS.holdSeconds,
        stickToMarkers: true,
        onChange: publish
    },
    speakingGlow: {
        type: OptionType.SLIDER,
        description: "Intensity of the ring and halo on an enlarged speaking avatar.",
        markers: [0, 25, 50, 75, 100],
        default: DEFAULT_SPATIAL_SETTINGS.speakingGlow,
        stickToMarkers: false,
        onChange: publish
    },
    animationDuration: {
        type: OptionType.SLIDER,
        description: "Duration of the avatar scale and emphasis transitions, in milliseconds.",
        markers: [0, 120, 220, 360, 600],
        default: DEFAULT_SPATIAL_SETTINGS.animationDuration,
        stickToMarkers: false,
        onChange: publish
    }
});

/**
 * The store as the rest of the plugin sees it: every value clamped to the range
 * its option offers, and every enum validated. A hand-edited settings file with
 * nonsense in it cannot reach the renderer.
 */
export function readSettings(): SpatialSettingsSnapshot {
    const store = settings.store as Record<string, unknown>;
    const defaults = DEFAULT_SPATIAL_SETTINGS;

    return {
        enabled: bool(store.enabled, defaults.enabled),
        layoutMode: layoutMode(store.layoutMode),
        motionPercent: number(store.motionPercent, defaults.motionPercent, 0, 100),

        autoPositioning: bool(store.autoPositioning, defaults.autoPositioning),
        spacing: number(store.spacing, defaults.spacing, 0, 100),
        selectedWidth: number(store.selectedWidth, defaults.selectedWidth, 30, 60),
        videoSize: number(store.videoSize, defaults.videoSize, 120, 420),
        avatarSize: number(store.avatarSize, defaults.avatarSize, 32, 96),
        avoidCollisions: bool(store.avoidCollisions, defaults.avoidCollisions),

        showConnectors: bool(store.showConnectors, defaults.showConnectors),
        connectorOpacity: number(store.connectorOpacity, defaults.connectorOpacity, 0, 100),
        connectorWidth: number(store.connectorWidth, defaults.connectorWidth, 50, 300),
        connectorGlow: number(store.connectorGlow, defaults.connectorGlow, 0, 100),
        connectorSpeakingHighlight: number(
            store.connectorSpeakingHighlight,
            defaults.connectorSpeakingHighlight,
            0,
            100
        ),

        theme: theme(store.theme),
        backgroundIntensity: number(store.backgroundIntensity, defaults.backgroundIntensity, 0, 100),
        particles: bool(store.particles, defaults.particles),

        restyleControls: bool(store.restyleControls, defaults.restyleControls),

        speakingAvatars: bool(store.speakingAvatars, defaults.speakingAvatars),
        avatarScale: number(store.avatarScale, defaults.avatarScale, 100, 200),
        holdSeconds: number(store.holdSeconds, defaults.holdSeconds, 1, 30),
        speakingGlow: number(store.speakingGlow, defaults.speakingGlow, 0, 100),
        animationDuration: number(store.animationDuration, defaults.animationDuration, 0, 600)
    };
}
