import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    buildSpatialSceneVariables,
    clampSpatialSceneValue,
    DEFAULT_SPATIAL_THEME_ID,
    isSpatialThemeId,
    resolveSpatialTheme,
    resolveSpatialThemeId,
    SPATIAL_SCENE_BOUNDS,
    SPATIAL_THEME_IDS,
    SPATIAL_THEME_SELECT_OPTIONS,
    SPATIAL_THEMES,
    spatialSceneAttributes,
    type SpatialSceneVariableName
} from "./themes.ts";

const STYLE_SHEET = readFileSync(new URL("./style.css", import.meta.url), "utf8");

test("the nine themes are present, unique and in select order", () => {
    assert.deepEqual(
        [...SPATIAL_THEME_IDS],
        [
            "dark-space",
            "aurora",
            "sunset",
            "forest",
            "ocean",
            "cyberpunk",
            "minimal",
            "dark-red",
            "purple-galaxy"
        ]
    );
    assert.equal(new Set(SPATIAL_THEME_IDS).size, 9);
    assert.equal(SPATIAL_THEMES.length, 9);

    for (const theme of SPATIAL_THEMES) {
        assert.match(theme.id, /^[a-z]+(-[a-z]+)*$/, `${theme.id} is a kebab-case id`);
        assert.ok(theme.label.length > 0, `${theme.id} has a settings label`);
        assert.ok(theme.description.length > 20, `${theme.id} has a real description`);
        assert.match(theme.swatch.base, /^#[0-9a-f]{6}$/);
        assert.match(theme.swatch.accent, /^#[0-9a-f]{6}$/);
        assert.match(theme.swatch.accentAlt, /^#[0-9a-f]{6}$/);
    }
});

test("exactly one theme is the default and it is Dark Space", () => {
    const defaults = SPATIAL_THEMES.filter(theme => theme.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, "dark-space");
    assert.equal(DEFAULT_SPATIAL_THEME_ID, "dark-space");
});

test("Minimal is a genuine light theme and every other theme is dark", () => {
    const light = SPATIAL_THEMES.filter(theme => theme.scheme === "light").map(theme => theme.id);
    assert.deepEqual(light, ["minimal"]);
});

test("an unknown or missing stored theme resolves to the default", () => {
    assert.equal(resolveSpatialThemeId("nope"), "dark-space");
    assert.equal(resolveSpatialThemeId(undefined), "dark-space");
    assert.equal(resolveSpatialThemeId(null), "dark-space");
    assert.equal(resolveSpatialThemeId(7), "dark-space");
    assert.equal(resolveSpatialThemeId({ id: "forest" }), "dark-space");
    assert.equal(resolveSpatialThemeId("forest"), "forest");
    assert.equal(resolveSpatialTheme("ocean").scheme, "dark");
    assert.equal(isSpatialThemeId("minimal"), true);
    assert.equal(isSpatialThemeId("Minimal"), false);
});

test("select options cover every theme, once, with one default", () => {
    assert.equal(SPATIAL_THEME_SELECT_OPTIONS.length, 9);
    assert.deepEqual(
        SPATIAL_THEME_SELECT_OPTIONS.map(option => option.value),
        [...SPATIAL_THEME_IDS]
    );
    assert.equal(SPATIAL_THEME_SELECT_OPTIONS.filter(option => option.default).length, 1);
    assert.equal(new Set(SPATIAL_THEME_SELECT_OPTIONS.map(option => option.label)).size, 9);
});

test("scene attributes name the resolved theme and its scheme", () => {
    assert.deepEqual(spatialSceneAttributes({ theme: "minimal" }), {
        "data-sv-theme": "minimal",
        "data-sv-scheme": "light"
    });
    assert.deepEqual(spatialSceneAttributes({ theme: "gone" }), {
        "data-sv-theme": "dark-space",
        "data-sv-scheme": "dark"
    });
    assert.deepEqual(spatialSceneAttributes(null), {
        "data-sv-theme": "dark-space",
        "data-sv-scheme": "dark"
    });
});

test("with no settings the variables are empty, so style.css defaults apply", () => {
    assert.deepEqual(buildSpatialSceneVariables(), {});
    assert.deepEqual(buildSpatialSceneVariables(null), {});
    assert.deepEqual(buildSpatialSceneVariables(undefined), {});
});

test("each supplied setting emits exactly the variable style.css reads", () => {
    const variables = buildSpatialSceneVariables({
        backgroundIntensity: 0.5,
        connectors: false,
        connectorOpacity: 0.4,
        connectorWidthPx: 2,
        connectorGlow: 1.5,
        speakingHighlight: 1.2,
        avatarSizePx: 72,
        avatarScale: 1.6,
        speakingGlow: 0.5,
        motionDurationMs: 300
    });

    assert.equal(variables["--sv-bg-intensity"], "0.5");
    assert.equal(variables["--sv-connector-opacity"], "0");
    assert.equal(variables["--sv-connector-width"], "2px");
    assert.equal(variables["--sv-connector-glow"], "1.5");
    assert.equal(variables["--sv-connector-highlight"], "1.2");
    assert.equal(variables["--sv-avatar-size"], "72px");
    assert.equal(variables["--sv-avatar-scale"], "1.6");
    assert.equal(variables["--sv-speaking-glow"], "0.5");
    assert.equal(variables["--sv-motion-duration"], "300ms");
});

test("every emitted variable name is consumed by style.css", () => {
    const names: SpatialSceneVariableName[] = [
        "--sv-bg-intensity",
        "--sv-particle-opacity",
        "--sv-anim",
        "--sv-motion-duration",
        "--sv-avatar-size",
        "--sv-avatar-scale",
        "--sv-speaking-glow",
        "--sv-connector-opacity",
        "--sv-connector-width",
        "--sv-connector-glow",
        "--sv-connector-highlight"
    ];

    for (const name of names) {
        assert.ok(
            STYLE_SHEET.includes(`var(${name}`),
            `style.css reads ${name}`
        );
    }
});

test("particles off and connectors off reach zero, not a hidden but painted layer", () => {
    const variables = buildSpatialSceneVariables({ particles: false, connectors: false });
    assert.equal(variables["--sv-particle-opacity"], "0");
    assert.equal(variables["--sv-connector-opacity"], "0");
    assert.equal("--sv-particle-opacity" in buildSpatialSceneVariables({ particles: true }), false);
});

test("connector opacity is not overwritten by the hide flag when only one is set", () => {
    assert.deepEqual(buildSpatialSceneVariables({ connectors: true }), {});
    assert.equal(buildSpatialSceneVariables({ connectors: false, connectorOpacity: 0.9 })["--sv-connector-opacity"], "0");
});

test("out of range, NaN and infinity clamp instead of reaching the stylesheet", () => {
    assert.equal(clampSpatialSceneValue("avatarScale", 99), 2);
    assert.equal(clampSpatialSceneValue("avatarScale", 0.1), 1);
    assert.equal(clampSpatialSceneValue("avatarScale", Number.NaN), 1.4);
    assert.equal(clampSpatialSceneValue("avatarScale", Number.POSITIVE_INFINITY), 1.4);
    assert.equal(clampSpatialSceneValue("avatarScale", "1.8"), 1.4);
    assert.equal(clampSpatialSceneValue("motionDurationMs", -40), 0);
    assert.equal(clampSpatialSceneValue("connectorWidthPx", 12), SPATIAL_SCENE_BOUNDS.connectorWidthPx.max);

    const variables = buildSpatialSceneVariables({
        backgroundIntensity: 4,
        avatarScale: Number.NaN,
        connectorWidthPx: -3,
        motionDurationMs: 1e9
    });
    assert.equal(variables["--sv-bg-intensity"], "1");
    // a NaN never reaches the stylesheet: the field is skipped, so the value
    // style.css declares for that variable stays in force
    assert.equal("--sv-avatar-scale" in variables, false);
    assert.equal(variables["--sv-connector-width"], "0.5px");
    assert.equal(variables["--sv-motion-duration"], "1200ms");
});

test("reduced motion pauses the background and shortens every transition", () => {
    const variables = buildSpatialSceneVariables({ reducedMotion: true, motionDurationMs: 800 });
    assert.equal(variables["--sv-anim"], "paused");
    assert.equal(variables["--sv-motion-duration"], "1ms");
    assert.equal(STYLE_SHEET.includes("animation-play-state: var(--sv-anim"), true);

    const normal = buildSpatialSceneVariables({ reducedMotion: false });
    assert.equal("--sv-anim" in normal, false);
});

test("the bounds fall back to the defaults style.css declares", () => {
    assert.equal(SPATIAL_SCENE_BOUNDS.backgroundIntensity.fallback, 1);
    assert.equal(SPATIAL_SCENE_BOUNDS.connectorOpacity.fallback, 0.55);
    assert.equal(SPATIAL_SCENE_BOUNDS.connectorWidthPx.fallback, 1.25);
    assert.equal(SPATIAL_SCENE_BOUNDS.avatarScale.fallback, 1.4);
    assert.equal(SPATIAL_SCENE_BOUNDS.speakingGlow.fallback, 0.75);
    assert.equal(SPATIAL_SCENE_BOUNDS.motionDurationMs.fallback, 220);
});
