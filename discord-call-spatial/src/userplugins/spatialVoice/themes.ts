/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Spatial Voice contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Framework-neutral theme catalogue and scene-variable builder for Spatial
 * Voice.
 *
 * Where the palette lives
 * ----------------------
 * The nine palettes, gradients, particle fields and motion timings are declared
 * once, in `style.css`, as custom properties inside each
 * `.sv-scene[data-sv-theme="…"]` block. This module never repeats a colour: it
 * owns the part TypeScript has to own, which is
 *
 * - the list of theme ids, their settings labels and their accessible
 *   direction, so a settings select and a preview harness can enumerate them;
 * - the validation of a persisted theme value, so an unknown or stale id from
 *   an old config resolves to the default instead of painting an unstyled
 *   scene;
 * - the mapping from the plugin's functional settings to the CSS variables
 *   `style.css` reads, so a setting reaches the visual layer without a second
 *   hardcoded palette and without a stylesheet per combination.
 *
 * What it deliberately does not do
 * --------------------------------
 * No DOM, no React, no Vencord import: the same functions run in the plugin,
 * in the settings UI and under `node --test`. It never sets position, layout,
 * connector geometry or participant state; those stay with `layout.ts`,
 * `connectors.ts` and `speaking.ts`. Switching a theme therefore changes
 * palette, atmosphere and motion variables only, and cannot move a participant
 * or touch the call.
 *
 * Swatch colours are for the settings UI (a small theme chip) and for the style
 * harness. They mirror the accent of each `style.css` block and are not used to
 * paint the scene.
 */

/** The nine themes, in the order they appear in the settings select. */
export type SpatialThemeId =
    | "dark-space"
    | "aurora"
    | "sunset"
    | "forest"
    | "ocean"
    | "cyberpunk"
    | "minimal"
    | "dark-red"
    | "purple-galaxy";

/** Whether a theme puts dark ink on a light surface, or the reverse. */
export type SpatialThemeScheme = "dark" | "light";

export interface SpatialThemeSwatch {
    /** Scene base colour, the surface everything else composites over. */
    base: string;
    /** Primary accent: selection borders, focus ring, speaking ring. */
    accent: string;
    /** Secondary accent, the second light in the background. */
    accentAlt: string;
}

export interface SpatialThemeDefinition {
    id: SpatialThemeId;
    /** Value shown in the settings select. */
    label: string;
    /** One line of visual direction, shown under the select and in the harness. */
    description: string;
    scheme: SpatialThemeScheme;
    /** Representative colours for settings swatches; the scene palette is in style.css. */
    swatch: SpatialThemeSwatch;
    /** True for the one theme the plugin starts on. */
    isDefault?: boolean;
}

export const DEFAULT_SPATIAL_THEME_ID: SpatialThemeId = "dark-space";

export const SPATIAL_THEMES: readonly SpatialThemeDefinition[] = Object.freeze([
    {
        id: "dark-space",
        label: "Default (Dark Space)",
        description: "Deep navy space, blue and cyan light, violet nebula haze and fine stars.",
        scheme: "dark",
        swatch: { base: "#04070f", accent: "#5ad1ff", accentAlt: "#a78bfa" },
        isDefault: true
    },
    {
        id: "aurora",
        label: "Aurora (Neon Gradient)",
        description: "Teal, emerald, blue and magenta bands of flowing aurora light.",
        scheme: "dark",
        swatch: { base: "#04121b", accent: "#5eead4", accentAlt: "#f472b6" }
    },
    {
        id: "sunset",
        label: "Sunset (Warm)",
        description: "Warm orange, coral, gold and purple dusk over a luminous horizon.",
        scheme: "dark",
        swatch: { base: "#180811", accent: "#ffb066", accentAlt: "#ff7ac6" }
    },
    {
        id: "forest",
        label: "Forest (Green)",
        description: "Near-black forest green, emerald highlights and low green atmospheric light.",
        scheme: "dark",
        swatch: { base: "#04120b", accent: "#4ade9f", accentAlt: "#a7f3d0" }
    },
    {
        id: "ocean",
        label: "Ocean (Blue)",
        description: "Deep blue water, soft light rays and drifting bubble particles.",
        scheme: "dark",
        swatch: { base: "#031726", accent: "#38d9e8", accentAlt: "#60a5fa" }
    },
    {
        id: "cyberpunk",
        label: "Cyberpunk (Purple/Pink)",
        description: "Violet and hot pink neon city ambience with electric blue accents.",
        scheme: "dark",
        swatch: { base: "#0b0418", accent: "#ff2d95", accentAlt: "#22d3ee" }
    },
    {
        id: "minimal",
        label: "Minimal (Light)",
        description: "A genuine light theme: off-white surfaces, soft blue accents, dark readable ink.",
        scheme: "light",
        swatch: { base: "#f3f6fb", accent: "#2563eb", accentAlt: "#0ea5e9" }
    },
    {
        id: "dark-red",
        label: "Dark Red (Aesthetic)",
        description: "Black and burgundy with restrained crimson energy from the connector origin.",
        scheme: "dark",
        swatch: { base: "#070203", accent: "#ff4d5e", accentAlt: "#e0233b" }
    },
    {
        id: "purple-galaxy",
        label: "Purple Galaxy (Space Dust)",
        description: "Midnight purple and indigo nebula with bright stars and drifting dust.",
        scheme: "dark",
        swatch: { base: "#08031a", accent: "#c084fc", accentAlt: "#e879f9" }
    }
]);

/** Every theme id, in select order. */
export const SPATIAL_THEME_IDS: readonly SpatialThemeId[] = Object.freeze(
    SPATIAL_THEMES.map(theme => theme.id)
);

const THEMES_BY_ID = new Map<SpatialThemeId, SpatialThemeDefinition>(
    SPATIAL_THEMES.map(theme => [theme.id, theme])
);

export function isSpatialThemeId(value: unknown): value is SpatialThemeId {
    return typeof value === "string" && THEMES_BY_ID.has(value as SpatialThemeId);
}

/**
 * The theme definition for an id, or the default theme when the value is
 * missing, unknown or of the wrong type. A stale id in a saved config therefore
 * renders the default theme rather than an unstyled scene.
 */
export function resolveSpatialTheme(value: unknown): SpatialThemeDefinition {
    if (isSpatialThemeId(value)) return THEMES_BY_ID.get(value) as SpatialThemeDefinition;
    return THEMES_BY_ID.get(DEFAULT_SPATIAL_THEME_ID) as SpatialThemeDefinition;
}

/** The theme id for any stored value, falling back to the default. */
export function resolveSpatialThemeId(value: unknown): SpatialThemeId {
    return resolveSpatialTheme(value).id;
}

/** Shape Vencord's `OptionType.Select` takes, minus the Vencord import. */
export interface SpatialThemeSelectOption {
    label: string;
    value: SpatialThemeId;
    default?: boolean;
}

export const SPATIAL_THEME_SELECT_OPTIONS: readonly SpatialThemeSelectOption[] = Object.freeze(
    SPATIAL_THEMES.map(theme => ({
        label: theme.label,
        value: theme.id,
        ...(theme.isDefault ? { default: true } : {})
    }))
);

/* ==========================================================================
   Settings to scene variables
   ========================================================================== */

export interface SpatialSceneVariableBounds {
    min: number;
    max: number;
    fallback: number;
}

/**
 * Accepted range and fallback for every numeric visual setting. The fallbacks
 * are the values `style.css` declares for the same variable, so a setting that
 * is absent leaves the stylesheet's own default in place.
 */
export const SPATIAL_SCENE_BOUNDS = Object.freeze({
    backgroundIntensity: { min: 0, max: 1, fallback: 1 },
    connectorOpacity: { min: 0, max: 1, fallback: 0.55 },
    connectorWidthPx: { min: 0.5, max: 4, fallback: 1.25 },
    connectorGlow: { min: 0, max: 3, fallback: 1 },
    speakingHighlight: { min: 0, max: 2, fallback: 1 },
    avatarScale: { min: 1, max: 2, fallback: 1.4 },
    avatarSizePx: { min: 24, max: 128, fallback: 60 },
    speakingGlow: { min: 0, max: 1, fallback: 0.75 },
    motionDurationMs: { min: 0, max: 1200, fallback: 220 }
} satisfies Record<string, SpatialSceneVariableBounds>);

/**
 * The functional settings the visual layer consumes. Every field is optional:
 * an absent field emits no variable, so the stylesheet default applies.
 */
export interface SpatialSceneSettings {
    theme?: SpatialThemeId | string | null;
    /** 0 to 1, strength of the atmosphere, haze and particles. */
    backgroundIntensity?: number;
    /** False switches the particle and dust layer off. */
    particles?: boolean;
    /** False hides the connector lines without touching their geometry. */
    connectors?: boolean;
    connectorOpacity?: number;
    connectorWidthPx?: number;
    connectorGlow?: number;
    speakingHighlight?: number;
    avatarSizePx?: number;
    avatarScale?: number;
    speakingGlow?: number;
    motionDurationMs?: number;
    /** True reduces transitions and pauses the background animations. */
    reducedMotion?: boolean;
}

export type SpatialSceneVariableName =
    | "--sv-bg-intensity"
    | "--sv-particle-opacity"
    | "--sv-anim"
    | "--sv-motion-duration"
    | "--sv-avatar-size"
    | "--sv-avatar-scale"
    | "--sv-speaking-glow"
    | "--sv-connector-opacity"
    | "--sv-connector-width"
    | "--sv-connector-glow"
    | "--sv-connector-highlight";

export type SpatialSceneVariables = Partial<Record<SpatialSceneVariableName, string>>;

/** Clamp a value into its bounds, ignoring anything that is not a finite number. */
export function clampSpatialSceneValue(name: keyof typeof SPATIAL_SCENE_BOUNDS, value: unknown): number {
    const bounds = SPATIAL_SCENE_BOUNDS[name];
    if (typeof value !== "number" || !Number.isFinite(value)) return bounds.fallback;
    return Math.min(bounds.max, Math.max(bounds.min, value));
}

function isProvidedNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** Round for CSS output, so a float setting does not produce a 17-digit string. */
function cssNumber(value: number, digits = 3): string {
    const factor = 10 ** digits;
    return String(Math.round(value * factor) / factor);
}

function cssTime(ms: number): string {
    return `${cssNumber(Math.max(0, ms), 0)}ms`;
}

/**
 * Build the custom properties to set on the scene root for a given set of
 * settings. Only fields the caller actually supplied are emitted, so this is
 * safe to call with a partial settings object straight from Vencord.
 *
 * Motion: `reducedMotion` shortens every transition and pauses the background
 * animations through `--sv-anim`, which `style.css` applies as
 * `animation-play-state`. The stylesheet's own `prefers-reduced-motion` block
 * stays in force on top of this, so the system preference wins either way.
 */
export function buildSpatialSceneVariables(
    settings?: SpatialSceneSettings | null
): SpatialSceneVariables {
    const variables: SpatialSceneVariables = {};
    if (!settings || typeof settings !== "object") return variables;

    if (isProvidedNumber(settings.backgroundIntensity)) {
        variables["--sv-bg-intensity"] = cssNumber(
            clampSpatialSceneValue("backgroundIntensity", settings.backgroundIntensity)
        );
    }

    // The particle layer's opacity is the product of the intensity, this value
    // and the responsive --sv-fx-scale, so 0 removes the layer entirely.
    if (settings.particles === false) variables["--sv-particle-opacity"] = "0";

    if (isProvidedNumber(settings.connectorOpacity)) {
        variables["--sv-connector-opacity"] = cssNumber(
            clampSpatialSceneValue("connectorOpacity", settings.connectorOpacity)
        );
    }

    // Applied after the opacity so that "hide the lines" wins over a stored
    // opacity, whatever order the two settings arrive in.
    if (settings.connectors === false) variables["--sv-connector-opacity"] = "0";

    if (isProvidedNumber(settings.connectorWidthPx)) {
        variables["--sv-connector-width"] = `${cssNumber(
            clampSpatialSceneValue("connectorWidthPx", settings.connectorWidthPx),
            2
        )}px`;
    }

    if (isProvidedNumber(settings.connectorGlow)) {
        variables["--sv-connector-glow"] = cssNumber(
            clampSpatialSceneValue("connectorGlow", settings.connectorGlow)
        );
    }

    if (isProvidedNumber(settings.speakingHighlight)) {
        variables["--sv-connector-highlight"] = cssNumber(
            clampSpatialSceneValue("speakingHighlight", settings.speakingHighlight)
        );
    }

    if (isProvidedNumber(settings.avatarSizePx)) {
        variables["--sv-avatar-size"] = `${cssNumber(
            clampSpatialSceneValue("avatarSizePx", settings.avatarSizePx)
        )}px`;
    }

    if (isProvidedNumber(settings.avatarScale)) {
        variables["--sv-avatar-scale"] = cssNumber(
            clampSpatialSceneValue("avatarScale", settings.avatarScale)
        );
    }

    if (isProvidedNumber(settings.speakingGlow)) {
        variables["--sv-speaking-glow"] = cssNumber(
            clampSpatialSceneValue("speakingGlow", settings.speakingGlow)
        );
    }

    if (isProvidedNumber(settings.motionDurationMs)) {
        variables["--sv-motion-duration"] = cssTime(
            clampSpatialSceneValue("motionDurationMs", settings.motionDurationMs)
        );
    }

    if (settings.reducedMotion === true) {
        variables["--sv-anim"] = "paused";
        variables["--sv-motion-duration"] = "1ms";
    }

    return variables;
}

/**
 * The custom properties every theme block must also define for the backdrop and
 * the LIVE tag, on top of the palette in {@link SPATIAL_THEMES}.
 *
 * They are declared once here rather than in each theme so a test can prove all
 * nine themes paint the same three backdrop layers the reference compositions
 * are built on (orbit arcs, the vortex, the origin bloom) and the same red LIVE
 * tag. A theme that forgot one would render a hole in the scene that no palette
 * check would catch.
 */
export const SPATIAL_BACKDROP_VARIABLES = Object.freeze([
    "--sv-live",
    "--sv-orbit-ink",
    "--sv-vortex-ink",
    "--sv-vortex-core"
] as const);

export interface SpatialSceneAttributes {
    "data-sv-theme": SpatialThemeId;
    "data-sv-scheme": SpatialThemeScheme;
}

/**
 * The attributes the scene root carries. `data-sv-theme` selects the palette
 * block; `data-sv-scheme` lets the stylesheet and native controls know whether
 * the surface is dark or light, which is what makes Minimal a real light theme
 * rather than a dark one with brighter colours.
 */
export function spatialSceneAttributes(settings?: SpatialSceneSettings | null): SpatialSceneAttributes {
    const theme = resolveSpatialTheme(settings?.theme);
    return {
        "data-sv-theme": theme.id,
        "data-sv-scheme": theme.scheme
    };
}
