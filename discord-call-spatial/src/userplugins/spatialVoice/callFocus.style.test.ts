/*
 * Checks for the call focus toggle in spatialVoice/style.css, and for the
 * preview page that shows it.
 *
 * The control belongs to the call rather than to the scene: a compact dark
 * circle in the call's top corner that hands the window back to Discord's own
 * interface. callFocus.tsx renders it and owns its behaviour; this file checks
 * the part style.css owns, which a live Discord call cannot check at build
 * time:
 *
 *   - it is scoped, so it can never restyle Discord;
 *   - it is a 32px circular target in a corner, above call content;
 *   - the chevron points right while the call owns the window and reverses
 *     when Discord's interface is showing;
 *   - pointer, keyboard, reduced-motion, forced-colours and more-contrast
 *     states all exist;
 *   - its ink and its focus ring clear WCAG contrast in all nine themes;
 *   - the preview page shows both states using this stylesheet and nothing else.
 *
 * The last test also pins the user's steering note: the avatar glow follows
 * data-sv-speaking, the raw roster flag, so it leaves the moment somebody stops
 * talking instead of lasting the hold setting.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SPATIAL_THEMES, type SpatialThemeId } from "./themes.ts";

const CSS = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const PREVIEW = readFileSync(new URL("./callFocus.preview.html", import.meta.url), "utf8");

const TOGGLE = ".sv-call-focus-toggle";

interface Rule {
    atRule: string;
    selector: string;
    body: string;
    atRules: string[];
}

function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/* Same parser shape as style.test.ts: a rule is what sits between a prelude and
   its closing brace, with the at-rules stacked above it. */
function parseRules(source: string): Rule[] {
    const css = stripComments(source);
    const rules: Rule[] = [];
    const stack: string[] = [];
    let bufferStart = 0;

    for (let index = 0; index < css.length; index++) {
        const char = css[index];
        if (char === "{") {
            stack.push(css.slice(bufferStart, index).trim());
            bufferStart = index + 1;
        } else if (char === "}") {
            const body = css.slice(bufferStart, index);
            const selector = stack.pop();
            if (selector === undefined) continue;
            rules.push({
                atRule: stack[stack.length - 1] ?? "",
                selector,
                body,
                atRules: [...stack]
            });
            bufferStart = index + 1;
        }
    }

    return rules;
}

const RULES = parseRules(CSS);

function declarations(body: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const part of body.split(";")) {
        const colon = part.indexOf(":");
        if (colon < 0) continue;
        const property = part.slice(0, colon).trim().toLowerCase();
        const value = part.slice(colon + 1).trim();
        if (property) map.set(property, value);
    }
    return map;
}

function selectors(rule: Rule): string[] {
    return rule.selector.split(",").map(part => part.trim()).filter(Boolean);
}

function isKeyframeRule(rule: Rule): boolean {
    return rule.atRules.some(atRule => atRule.startsWith("@keyframes"));
}

/** Every rule that styles the toggle, its chevron or one of its states. */
const TOGGLE_RULES = RULES.filter(
    rule => !isKeyframeRule(rule) && selectors(rule).some(selector => selector.includes(TOGGLE))
);

function toggleDeclarations(selector: string): Map<string, string> {
    const rule = RULES.find(
        r => !isKeyframeRule(r) && selectors(r).some(part => part === selector)
    );
    assert.ok(rule, `${selector} is styled in style.css`);
    return declarations(rule.body);
}

/** `12px` or `var(--token, 12px)` read as the length it falls back to. */
function resolvedLength(value: string): string {
    const reference = /^var\((--[a-z0-9-]+),\s*([^)]+)\)$/.exec(value.trim());
    return reference ? reference[2].trim() : value.trim();
}

/* ---- colour maths, the same arithmetic style.test.ts uses --------------- */

interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

function parseColour(value: string | undefined): Rgba | null {
    if (!value) return null;
    const text = value.trim().toLowerCase();
    if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
    if (hex) {
        const digits = hex[1].length === 3
            ? hex[1].split("").map(char => char + char).join("")
            : hex[1];
        return {
            r: Number.parseInt(digits.slice(0, 2), 16),
            g: Number.parseInt(digits.slice(2, 4), 16),
            b: Number.parseInt(digits.slice(4, 6), 16),
            a: 1
        };
    }

    const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
    if (rgb) {
        const parts = rgb[1].split(",").map(part => Number.parseFloat(part.trim()));
        if (parts.length < 3 || parts.some(part => !Number.isFinite(part))) return null;
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }

    return null;
}

function over(foreground: Rgba, background: Rgba): Rgba {
    const a = foreground.a + background.a * (1 - foreground.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
        r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / a,
        g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / a,
        b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / a,
        a
    };
}

function luminance(colour: Rgba): number {
    const channel = (value: number) => {
        const scaled = value / 255;
        return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

function contrast(foreground: Rgba, background: Rgba): number {
    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));
    return (light + 0.05) / (dark + 0.05);
}

const BASE_VARIABLES = (() => {
    const base = RULES.find(rule => rule.selector.trim() === ".sv-scene");
    assert.ok(base, "style.css declares a base .sv-scene block");
    return declarations(base.body);
})();

function themeVariables(theme: SpatialThemeId): Map<string, string> {
    const merged = new Map(BASE_VARIABLES);
    for (const rule of RULES) {
        if (isKeyframeRule(rule)) continue;
        const matches = selectors(rule).some(
            selector => selector === `.sv-scene[data-sv-theme="${theme}"]`
        );
        if (!matches) continue;
        for (const [property, value] of declarations(rule.body)) merged.set(property, value);
    }
    return merged;
}

/** Resolves `var(--token, fallback)` against a theme's variables. */
function colourOf(variables: Map<string, string>, name: string): Rgba {
    const value = variables.get(name);
    assert.ok(value !== undefined, `${name} is declared`);
    const direct = parseColour(value);
    if (direct) return direct;

    const reference = /^var\((--[a-z0-9-]+)(?:,\s*(.+))?\)$/.exec((value ?? "").trim());
    if (reference) {
        const fallback = reference[2];
        const resolved = variables.get(reference[1]) ?? fallback;
        const colour = parseColour(resolved);
        assert.ok(colour, `${name} (${value}) resolves to a colour`);
        return colour;
    }

    assert.fail(`${name} (${value}) is a colour this check understands`);
    return { r: 0, g: 0, b: 0, a: 1 };
}

/* ---- structure ---------------------------------------------------------- */

test("the corner control is styled, and every rule that touches it is scoped to it", () => {
    assert.ok(TOGGLE_RULES.length >= 8, "the toggle has its own rules");

    for (const rule of TOGGLE_RULES) {
        for (const selector of selectors(rule)) {
            assert.ok(
                selector.includes(TOGGLE),
                `"${selector}" is anchored on ${TOGGLE} and cannot restyle Discord`
            );
            assert.ok(!selector.includes(":root"), `"${selector}" does not touch :root`);
            assert.ok(!/^(html|body)\b/.test(selector), `"${selector}" does not target html or body`);
        }
    }
});

test("the toggle is a 32px circular target, opaque enough to read as a control", () => {
    const body = toggleDeclarations(TOGGLE);

    assert.equal(body.get("width"), "32px");
    assert.equal(body.get("height"), "32px");
    assert.ok(Number.parseFloat(body.get("min-width") ?? "0") >= 32, "the hit target is at least 32px wide");
    assert.ok(Number.parseFloat(body.get("min-height") ?? "0") >= 32, "the hit target is at least 32px tall");
    assert.equal(body.get("border-radius"), "50%", "it is the round control in the screenshot");
    assert.equal(body.get("padding"), "0");
    assert.equal(body.get("cursor"), "pointer");

    assert.match(
        body.get("background-color") ?? "",
        /var\(--sv-control-bg,/,
        "its surface is the theme's control surface, with a dark fallback outside a scene"
    );
    assert.ok(body.get("backdrop-filter") ?? body.get("-webkit-backdrop-filter"), "it is translucent, not a flat chip");
    assert.match(body.get("border") ?? "", /var\(--sv-control-border,/, "its edge is the theme's control edge");
});

test("it sits in a corner and paints above everything the call draws", () => {
    const body = toggleDeclarations(TOGGLE);

    assert.equal(body.get("position"), "absolute");
    const inset = body.get("top");
    assert.ok(inset, "it has a corner inset");
    const insetPx = Number.parseFloat(resolvedLength(inset ?? ""));
    assert.ok(Number.isFinite(insetPx) && insetPx > 0 && insetPx <= 24, `the inset is sensible (${inset})`);
    const horizontal = body.get("inset-inline-start") ?? body.get("left");
    assert.ok(horizontal, "it is inset from the side as well");
    assert.equal(horizontal, inset, "the corner inset is square");
    assert.equal(
        resolvedLength(horizontal ?? ""),
        resolvedLength(inset ?? ""),
        "both insets resolve to the same length"
    );

    const zIndex = Number(body.get("z-index"));
    assert.ok(zIndex > 6, "it paints over the control bar (z-index 6) and the participants");
    // Discord's call header sits in a `z-index: 1001` layer of the same call root
    // (`videoControls`), so anything lower loses the hit test in the windowed
    // call view: measured 2026-10-29, a press at the chevron's centre resolved to
    // that header's back control and the toggle never fired.
    assert.ok(zIndex > 1001, `it wins the hit test against Discord's call header layer (${zIndex})`);
    assert.equal(body.get("pointer-events"), "auto", "it is clickable even inside a scene that disables input elsewhere");
});

test("a hidden control is hidden, not left painted by the display rule", () => {
    const hidden = toggleDeclarations(`${TOGGLE}[hidden]`);
    assert.equal(hidden.get("display"), "none");

    const inline = toggleDeclarations(`${TOGGLE}[data-sv-placement="inline"]`);
    assert.equal(inline.get("position"), "relative", "a host with its own row can take the control into flow");
    assert.equal(inline.get("top"), "auto");
    assert.equal(inline.get("inset-inline-start"), "auto");
});

test("the chevron points right while the call owns the window and reverses exactly once", () => {
    const chevron = toggleDeclarations(`${TOGGLE} svg`);
    assert.equal(chevron.get("transform"), "rotate(0deg)", "as authored, the chevron points right");
    assert.equal(chevron.get("pointer-events"), "none", "the glyph never takes the click from the button");
    assert.match(chevron.get("width") ?? "", /^\d+px$/, "the glyph has its own size");

    // The reversal. One turn is the disclosure convention; a second one on the
    // same glyph would put the arrow back where it started.
    const reversals = TOGGLE_RULES.filter(rule => {
        const transform = declarations(rule.body).get("transform");
        return transform !== undefined && /rotate\(180deg\)/.test(transform);
    });
    assert.ok(reversals.length > 0, "the interface showing reverses the chevron");

    for (const rule of reversals) {
        for (const selector of selectors(rule)) {
            assert.ok(
                selector.includes(`[data-sv-focused="false"]`),
                `${selector} reverses only while Discord's interface is on screen`
            );
            assert.ok(
                /:not\((:has\()?\[data-sv-chevron="left"\]/.test(selector),
                `${selector} skips a glyph that is already drawn leftwards, so two reversals never cancel out`
            );
        }
    }

    for (const rule of TOGGLE_RULES) {
        if (!selectors(rule).some(selector => selector.includes(`[data-sv-focused="true"]`))) continue;
        const transform = declarations(rule.body).get("transform");
        if (transform === undefined) continue;
        assert.match(String(transform), /rotate\(0deg\)/, "the focused state never reverses the chevron");
    }
});

test("hover, press and keyboard states all exist and none of them moves the control", () => {
    const hover = toggleDeclarations(`${TOGGLE}:hover`);
    assert.ok(hover.get("background-color"), "hover has its own surface");
    assert.ok(hover.get("color"), "hover lifts the glyph to the theme's ink");
    assert.ok(hover.get("border-color"), "hover lights the edge");

    const active = toggleDeclarations(`${TOGGLE}:active`);
    assert.ok(active.get("background-color"), "the press has its own surface");
    assert.equal(
        active.get("transform"),
        undefined,
        "the press never transforms: transform is the avatar scaling contract's alone"
    );

    const focus = toggleDeclarations(`${TOGGLE}:focus-visible`);
    assert.match(focus.get("outline") ?? "", /2px solid var\(--sv-focus,/, "the focus ring is 2px in the theme's focus colour");
    assert.ok(Number.parseFloat(focus.get("outline-offset") ?? "0") >= 2, "the ring sits off the edge");
    assert.equal(focus.get("border-radius"), "50%", "the ring follows the circle");

    const disabled = declarations(
        RULES.find(rule => selectors(rule).some(selector => selector === `${TOGGLE}:disabled`))?.body ?? ""
    );
    assert.ok(disabled.get("opacity"), "a disabled control is dimmed");
    assert.equal(disabled.get("cursor"), "not-allowed");
});

test("every theme keeps the control's ink readable and its focus ring visible", () => {
    const body = toggleDeclarations(TOGGLE);
    const hover = toggleDeclarations(`${TOGGLE}:hover`);

    const inkToken = tokenName(body.get("color"), "the chevron ink");
    const surfaceToken = tokenName(body.get("background-color"), "the surface");
    const hoverInkToken = tokenName(hover.get("color"), "the hovered chevron ink");
    const hoverSurfaceToken = tokenName(hover.get("background-color"), "the hover surface");

    for (const theme of SPATIAL_THEMES) {
        const variables = themeVariables(theme.id);
        const base = colourOf(variables, "--sv-bg-base");
        const surface = over(colourOf(variables, surfaceToken), base);
        const hoverSurface = over(colourOf(variables, hoverSurfaceToken), base);
        const ink = colourOf(variables, inkToken);
        const hoverInk = colourOf(variables, hoverInkToken);
        const focus = colourOf(variables, "--sv-focus");

        const checks: Array<[string, number, number]> = [
            ["chevron ink on the control", contrast(ink, surface), 4.5],
            ["hovered chevron ink", contrast(hoverInk, hoverSurface), 4.5],
            ["focus ring against the control", contrast(focus, surface), 3]
        ];

        for (const [label, ratio, minimum] of checks) {
            assert.ok(
                ratio >= minimum,
                `${theme.id}: ${label} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`
            );
        }
    }
});

/** Reads the token name out of a `var(--sv-…, fallback)` declaration. */
function tokenName(value: string | undefined, what: string): string {
    assert.ok(value !== undefined, `${what} is declared`);
    const reference = /^var\((--sv-[a-z0-9-]+),/.exec(value.trim());
    assert.ok(reference, `${what} is a theme token with a fallback (${value})`);
    return reference[1];
}

test("reduced motion, forced colours and more contrast each have a rule for the control", () => {
    const inMedia = (query: string) =>
        TOGGLE_RULES.filter(rule => rule.atRules.some(atRule => atRule.includes(query)));

    const reduced = inMedia("prefers-reduced-motion");
    assert.ok(reduced.length > 0, "a reduced-motion rule exists");
    assert.match(
        reduced.map(rule => rule.body).join("\n"),
        /transition-duration:\s*1ms/,
        "the chevron turn and the hover fade collapse"
    );

    const forced = inMedia("forced-colors");
    assert.ok(forced.length > 0, "a forced-colours rule exists");
    const forcedBody = forced.map(rule => rule.body).join("\n");
    assert.match(forcedBody, /CanvasText/, "the control is drawn in system colours");
    assert.match(forcedBody, /HighlightText?/, "its hover and press states use the system highlight");

    const contrastRules = inMedia("prefers-contrast");
    assert.ok(contrastRules.length > 0, "a more-contrast rule exists");
    assert.match(contrastRules.map(rule => rule.body).join("\n"), /border-width:\s*2px/, "the edge thickens");
});

test("Discord's own light theme is handled, and that override can never enter a scene", () => {
    const lightRules = TOGGLE_RULES.filter(rule => selectors(rule).some(s => s.includes("theme-light")));
    assert.ok(lightRules.length > 0, "a light-Discord rule exists");

    for (const rule of lightRules) {
        for (const selector of selectors(rule)) {
            assert.ok(
                selector.includes(":not(.sv-scene *)"),
                `"${selector}" is guarded so a scene's palette stays the authority`
            );
        }
    }

    const surface = declarations(lightRules[0].body).get("background-color") ?? "";
    const ink = declarations(lightRules[0].body).get("color") ?? "";
    const ratio = contrast(parseColour(ink) ?? { r: 0, g: 0, b: 0, a: 1 }, parseColour(surface) ?? { r: 255, g: 255, b: 255, a: 1 });
    assert.ok(ratio >= 4.5, `the light-theme chevron keeps 4.5:1 (${ratio.toFixed(2)}:1)`);
});

/* ---- containment: the scene never paints over Discord ------------------- */

test("a scene with no participant in it paints nothing over Discord", () => {
    const emptyRules = RULES.filter(
        rule => !isKeyframeRule(rule)
            && selectors(rule).some(selector => selector.includes(":not(:has(.sv-participant))"))
    );
    assert.ok(emptyRules.length >= 2, "the no-call state is styled");

    const bodies = emptyRules.map(rule => declarations(rule.body));
    assert.ok(
        bodies.some(body => body.get("background-color") === "transparent"),
        "the scene's opaque base is dropped while no call is on screen"
    );
    assert.ok(
        emptyRules.some(
            rule => declarations(rule.body).get("display") === "none"
                && selectors(rule).some(selector => selector.includes(".sv-background"))
        ),
        "the backdrop layers, orbit arcs and vortex go with it"
    );

    for (const rule of emptyRules) {
        for (const selector of selectors(rule)) {
            assert.ok(
                selector.includes(":has(.sv-participant)"),
                `"${selector}" keys on the participant list, not on a Discord class`
            );
            assert.ok(
                !selector.includes(".sv-controls"),
                `"${selector}" never hides Discord's control bar with an empty scene`
            );
        }
    }
});

test("the scene is a paint container, and this file makes no global layout change", () => {
    const sceneRules = RULES.filter(
        rule => !isKeyframeRule(rule) && selectors(rule).some(selector => selector === ".sv-scene")
    );
    assert.ok(sceneRules.length > 0, "the scene root is styled");

    const contain = sceneRules.map(rule => declarations(rule.body).get("contain") ?? "");
    assert.ok(contain.some(value => value.includes("paint")), "the scene clips everything it paints");
    const overflow = sceneRules.map(rule => declarations(rule.body).get("overflow") ?? "");
    assert.ok(overflow.some(value => value === "hidden"), "and it carries its own clip");

    for (const rule of RULES) {
        if (isKeyframeRule(rule)) continue;
        const body = declarations(rule.body);
        assert.notEqual(body.get("position"), "fixed", `"${rule.selector}" never pins anything to the window`);
        for (const [property, value] of body) {
            if (value.includes("!important")) {
                assert.ok(
                    rule.atRules.some(atRule => atRule.includes("prefers-reduced-motion")),
                    `"${property}" only outranks a rule inside the reduced-motion block, and ${rule.selector} is not in it`
                );
            }
            assert.ok(
                !/\d(vw|vh|vmin|vmax|dvh|dvw|svh|svw)\b/.test(value),
                `${property} (${value}) is not measured against the viewport`
            );
        }
    }
});

/* ---- the preview -------------------------------------------------------- */

test("the preview shows both states with this stylesheet and nothing else", () => {
    const styles = /<style>([\s\S]*?)<\/style>/.exec(PREVIEW);
    assert.ok(styles, "the page has its own harness style block");
    assert.ok(
        !styles[1].includes(TOGGLE),
        "the harness never styles the control: what it shows is style.css"
    );

    assert.match(PREVIEW, /<link rel="stylesheet" href="style\.css">/, "it loads the real stylesheet");
    assert.match(PREVIEW, /data-sv-focused="true"/, "the call-owns-the-window state is rendered");
    assert.match(PREVIEW, /data-sv-focused="false"/, "the interface-showing state is rendered");
    assert.equal(
        (PREVIEW.match(/class="sv-call-focus-toggle"/g) ?? []).length >= 2,
        true,
        "the control is rendered in both states"
    );
    assert.match(
        PREVIEW,
        /M9 5\.5 16 12l-7 6\.5/,
        "the authored chevron points right, and only the rotation changes it"
    );
    assert.match(PREVIEW, /class="sv-scene"/, "one state puts the control inside a scene, where the theme tokens apply");
});

test("the preview renders a mounted scene with no participant in it", () => {
    const panel = /<section class="panel" id="empty-scene"[\s\S]*?<\/section>/.exec(PREVIEW);
    assert.ok(panel, "the preview has the no-call panel");
    assert.ok(
        panel[0].includes('class="sv-background"'),
        "it mounts the backdrop layer the empty state has to hide"
    );
    assert.ok(!panel[0].includes('class="sv-participant'), "it has no participant, which is the condition under test");
    assert.ok(
        panel[0].includes('class="sv-scene empty-scene"'),
        "the scene overlays the page, the way the plugin mounts it"
    );
});

/* ---- the steering note: the glow leaves when the talking stops ---------- */

function selectorsMentioning(fragment: string): string[] {
    return RULES.filter(rule => !isKeyframeRule(rule) && rule.body.includes(fragment))
        .flatMap(rule => selectors(rule));
}

test("the avatar glow follows live speech, not the held emphasis", () => {
    for (const fragment of ["--sv-speaking-glow-color", "--sv-speaking-ring"]) {
        const found = selectorsMentioning(fragment).filter(selector => selector.includes(".sv-avatar"));
        assert.ok(found.length > 0, `${fragment} is used on the avatar`);
        for (const selector of found) {
            assert.ok(
                !selector.includes('[data-sv-emphasized="true"]'),
                `"${selector}" draws light only while data-sv-speaking is true, so it goes out with the last word`
            );
        }
    }

    const big = RULES.filter(rule => (declarations(rule.body).get("transform") ?? "").includes("var(--sv-avatar-scale)"))
        .flatMap(rule => selectors(rule))
        .filter(selector => selector.includes(".sv-avatar"));
    assert.ok(
        big.some(selector => selector.includes('[data-sv-emphasized="true"]')),
        "the enlargement still follows the held flag: size is the hold, light is the speech"
    );
    assert.ok(
        big.some(selector => selector.includes('[data-sv-speaking="true"]')),
        "the enlargement starts with speech as well"
    );
});
