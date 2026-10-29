/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Spatial Voice — shared integration types.
 *
 * The one place where the native Discord adapter (integration.tsx), the plugin
 * entry point (index.tsx), the settings (settings.ts) and the scene
 * (SpatialScene.tsx) agree on shapes. Deliberately dependency free: no React, no
 * Vencord, no DOM at module scope, so tests and the layout/connector/speaking
 * modules can import it without pulling a client in.
 *
 * Nothing here invents Discord data. Every field of {@link NativeParticipant}
 * comes from a field the checkout's own store typings declare:
 *
 *   ChannelRTCStore.getParticipants()  -> UserParticipant
 *     .id .user .userNick .speaking .latched .lastSpoke .voiceDb
 *     .voiceState { selfVideo, selfMute, selfDeaf, mute, deaf }
 *     .localVideoDisabled .userVideo .streamId
 *   packages/discord-types/src/stores/ChannelRTCStore.d.ts
 *
 * A field Discord does not expose is absent here rather than guessed.
 */

import type { SpatialThemeId } from "./themes";

export { isSpatialThemeId as isSpatialTheme, SPATIAL_THEMES, type SpatialThemeId } from "./themes";

/**
 * `auto` follows whatever Discord has focused; `overview` never promotes a feed;
 * `selected` promotes as soon as anyone is focused.
 */
export type SpatialLayoutMode = "auto" | "overview" | "selected";

/**
 * Every setting the plugin exposes, already resolved to the numbers the scene
 * and its modules consume. Settings files never read `settings.store` directly:
 * they go through {@link DEFAULT_SPATIAL_SETTINGS} and this shape, so a missing
 * or out-of-range stored value cannot reach the renderer.
 */
export interface SpatialSettingsSnapshot {
    /** Master switch: the scene shows in voice channels while this is on. */
    enabled: boolean;
    layoutMode: SpatialLayoutMode;
    /** 0–100. Drives transition duration and background drift together. */
    motionPercent: number;

    autoPositioning: boolean;
    /** 0–100, mapped onto the layout engine's gap. */
    spacing: number;
    /** Percent of the usable width, 30–60. */
    selectedWidth: number;
    /** Preferred secondary tile width in CSS pixels, 120–420. */
    videoSize: number;
    /** Preferred camera-off avatar diameter in CSS pixels, 32–96. */
    avatarSize: number;
    /** Keeps the speaking enlargement inside each participant's cell. */
    avoidCollisions: boolean;

    showConnectors: boolean;
    /** 0–100, base line opacity. */
    connectorOpacity: number;
    /** 50–300, hundredths of a pixel (125 = 1.25px). */
    connectorWidth: number;
    /** 0–100, glow strength. */
    connectorGlow: number;
    /** 0–100, extra brightness on a camera-off speaker's line. */
    connectorSpeakingHighlight: number;

    theme: SpatialThemeId;
    /** 0–100, atmosphere and particle strength. */
    backgroundIntensity: number;
    particles: boolean;

    /** Applies the spatial look to the real call-control bar. */
    restyleControls: boolean;

    speakingAvatars: boolean;
    /** 100–200, percent. 140 is the 1.4× the design calls for. */
    avatarScale: number;
    /** 1–30 seconds of held enlargement after the last speaking activity. */
    holdSeconds: number;
    /** 0–100, speaking ring and halo strength. */
    speakingGlow: number;
    /** 0–600 ms; also the avatar scale transition. */
    animationDuration: number;
}

export const DEFAULT_SPATIAL_SETTINGS: Readonly<SpatialSettingsSnapshot> = Object.freeze({
    enabled: true,
    layoutMode: "auto",
    motionPercent: 70,

    autoPositioning: true,
    spacing: 50,
    selectedWidth: 45,
    videoSize: 280,
    avatarSize: 60,
    avoidCollisions: true,

    showConnectors: true,
    connectorOpacity: 55,
    connectorWidth: 125,
    connectorGlow: 100,
    connectorSpeakingHighlight: 100,

    theme: "dark-space",
    backgroundIntensity: 100,
    particles: true,

    restyleControls: true,

    speakingAvatars: true,
    avatarScale: 140,
    holdSeconds: 10,
    speakingGlow: 75,
    animationDuration: 220
});

/**
 * One real participant of the voice channel the user is in, flattened out of
 * Discord's own participant record. `id` is the store's participant id (the user
 * id for a person tile), which is what layout, connectors and the speaking hold
 * are keyed by.
 */
export interface NativeParticipant {
    id: string;
    userId: string;
    displayName: string;
    /** A real Discord CDN avatar URL, or null when the user has none. */
    avatarUrl: string | null;
    /** A live camera feed is being sent by this participant. */
    cameraOn: boolean;
    /** Discord's own speaking state for this participant, sampled at render. */
    speaking: boolean;
    /** `lastSpoke` from the participant record, in ms; used as the activity stamp. */
    lastSpoke: number;
    selfMuted: boolean;
    selfDeafened: boolean;
    isSelf: boolean;
    /** Present when this tile is a screen share rather than a camera. */
    streamId: string | null;
}

export interface NativeCallSnapshot {
    channelId: string | null;
    channelName: string | null;
    /** Every person in the channel, camera on or off, in Discord's own order. */
    participants: NativeParticipant[];
    /** Discord's focused participant, i.e. the camera currently promoted. */
    selectedParticipantId: string | null;
}

/** Resolves a participant to the live MediaStream Discord is already rendering. */
export type NativeVideoLookup = (participantId: string) => MediaStream | null;

/** How the adapter found (or failed to find) each participant's live feed. */
export interface NativeVideoDiagnostics {
    /** Live `<video>` elements found in the document. */
    liveVideos: number;
    /** Participants matched to a live video element. */
    matched: number;
    /** Camera-on participants with no live element: shown as avatars, never faked. */
    unmatchedCameraOn: string[];
    /** Participants matched to more than one element; the ambiguous ones are dropped. */
    ambiguous: string[];
}

export interface SpatialSceneProps {
    call: NativeCallSnapshot;
    settings: SpatialSettingsSnapshot;
    /** The stream for a participant, or null when no live feed is available. */
    videoFor: NativeVideoLookup;
    /** The real call-control bar, so the connectors start at its top edge. */
    controlsElement: HTMLElement | null;
    /** A camera was chosen in the scene. */
    onSelect: (participantId: string | null) => void;
    /** The layout the scene settled on, for the adapter's diagnostics. */
    onDiagnostics?: (diagnostics: SpatialSceneDiagnostics) => void;
}

export interface SpatialSceneDiagnostics {
    width: number;
    height: number;
    page: number;
    pageCount: number;
    placed: number;
    overflow: number;
    /** Ids the consequent speaking-hold pass considers emphasized right now. */
    emphasized: string[];
}

/** Everything the host element needs to know before the scene exists. */
export interface SpatialHostOptions {
    /** Where the scene is appended. */
    surface: HTMLElement;
    /** The element that holds Discord's own tiles, hidden while the scene runs. */
    grid: HTMLElement | null;
    /** The real call-control bar. */
    controls: HTMLElement | null;
}
