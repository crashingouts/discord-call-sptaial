/*
 * Contract and contrast checks for spatialVoice/style.css.
 *
 * These run without a browser. They answer the questions a live Discord call
 * cannot answer for us at build time: are all nine themes really defined, is
 * every selector scoped to the plugin, do the decorative layers stay
 * non-interactive, does a theme change ever move a participant, does anything
 * scale a video panel, and does each of the nine palettes keep its text, focus
 * ring, status line, connector lines and leave button readable.
 *
 * A live call is still required to see the themes on real video, which is why
 * `style.preview.html` renders the same DOM contract for a visual pass.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SPATIAL_BACKDROP_VARIABLES, SPATIAL_THEMES, type SpatialThemeId } from "./themes.ts";
import { computeSpatialLayout, type SpatialLayoutItem } from "./layout.ts";

const CSS = readFileSync(new URL("./style.css", import.meta.url), "utf8");

interface Rule {
    /** Innermost at-rule prelude, e.g. "@media (max-width: 900px)". */
    atRule: string;
    selector: string;
    body: string;
    atRules: string[];
}

function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseRules(source: string): Rule[] {
    const css = stripComments(source);
    const rules: Rule[] = [];
    const stack: string[] = [];
    let bufferStart = 0;

    for (let index = 0; index < css.length; index++) {
        const char = css[index];
        if (char === "{") {
            const prelude = css.slice(bufferStart, index).trim();
            stack.push(prelude);
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

function rulesFor(selectorIncludes: string): Rule[] {
    return RULES.filter(rule => selectors(rule).some(selector => selector.includes(selectorIncludes)));
}

function isKeyframeRule(rule: Rule): boolean {
    return rule.atRules.some(atRule => atRule.startsWith("@keyframes"));
}

/* ---- colour maths ------------------------------------------------------- */

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

/* ---- theme variables ---------------------------------------------------- */

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

test("the stylesheet parses with balanced braces and parentheses", () => {
    let depth = 0;
    let parens = 0;
    let inComment = false;
    for (let index = 0; index < CSS.length; index++) {
        const char = CSS[index];
        const next = CSS[index + 1];
        if (!inComment && char === "/" && next === "*") {
            inComment = true;
            index++;
            continue;
        }
        if (inComment) {
            if (char === "*" && next === "/") {
                inComment = false;
                index++;
            }
            continue;
        }
        if (char === "{") depth++;
        if (char === "}") depth--;
        if (char === "(") parens++;
        if (char === ")") parens--;
        assert.ok(depth >= 0, `no stray closing brace at ${index}`);
        assert.ok(parens >= 0, `no stray closing paren at ${index}`);
    }
    assert.equal(depth, 0, "every block closes");
    assert.equal(parens, 0, "every function call closes");
    assert.equal(inComment, false, "every comment closes");
});

test("every selector is scoped to the plugin and cannot restyle Discord", () => {
    for (const rule of RULES) {
        if (isKeyframeRule(rule)) continue;
        if (rule.selector.startsWith("@")) continue;
        for (const selector of selectors(rule)) {
            assert.ok(selector.includes(".sv-"), `"${selector}" is scoped to a .sv- class`);
            assert.ok(selector !== "*", "no naked universal selector");
            assert.ok(!selector.includes(":root"), `"${selector}" does not touch :root`);
            assert.ok(
                !/^(html|body)\b/.test(selector),
                `"${selector}" does not target html or body`
            );
        }
    }
});

test("every selector starts at a plugin class, never at a Discord layout node", () => {
    for (const rule of RULES) {
        if (isKeyframeRule(rule)) continue;
        if (rule.selector.startsWith("@")) continue;
        for (const selector of selectors(rule)) {
            assert.ok(
                /^(?:[a-z]+)?\.sv-/.test(selector)
                    || /^:where\(html\.theme-light\) \.sv-/.test(selector),
                `"${selector}" is anchored on a plugin class, so it cannot reach a Discord node`
            );
            assert.ok(!selector.includes("#"), `"${selector}" never selects by id`);
        }
    }
});

test("nothing here can move or repaint the app chrome around the call", () => {
    for (const rule of RULES) {
        if (isKeyframeRule(rule)) continue;
        const body = declarations(rule.body);
        assert.notEqual(body.get("position"), "fixed", `"${rule.selector}" never pins to the window`);
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

test("the scene is a paint container and a scene with no call paints nothing", () => {
    const sceneRules = RULES.filter(
        rule => !isKeyframeRule(rule) && selectors(rule).some(selector => selector === ".sv-scene")
    );
    assert.ok(sceneRules.length > 0, "the scene root is styled");
    assert.ok(
        sceneRules.some(rule => (declarations(rule.body).get("contain") ?? "").includes("paint")),
        "the scene clips everything it paints"
    );
    assert.ok(
        sceneRules.some(rule => declarations(rule.body).get("overflow") === "hidden"),
        "and it carries its own clip"
    );

    const emptyRules = RULES.filter(
        rule => !isKeyframeRule(rule)
            && selectors(rule).some(selector => selector.includes(":not(:has(.sv-participant))"))
    );
    assert.ok(emptyRules.length >= 2, "the no-call state is styled");
    assert.ok(
        emptyRules.some(rule => declarations(rule.body).get("background-color") === "transparent"),
        "its opaque base is dropped while no participant is on screen"
    );
});

test("decorative layers never intercept a click", () => {
    const decorated = [".sv-background", ".sv-connectors", ".sv-connector", ".sv-label", ".sv-badge", ".sv-status"];

    for (const className of decorated) {
        const rules = rulesFor(className).filter(rule => !isKeyframeRule(rule));
        assert.ok(rules.length > 0, `${className} is styled`);

        const blocks = rules.map(rule => declarations(rule.body));
        const declaresNone = blocks.some(map => map.get("pointer-events") === "none");
        const declaresAuto = blocks.some(map => {
            const value = map.get("pointer-events");
            return value !== undefined && value !== "none";
        });

        assert.ok(!declaresAuto, `${className} never re-enables pointer events`);
        if (className !== ".sv-connectors") {
            assert.ok(declaresNone, `${className} sets pointer-events: none`);
        }
    }
});

test("the connector overlay is transparent to input at every level", () => {
    const overlay = RULES.filter(rule => selectors(rule).some(selector => selector.startsWith(".sv-connectors")));
    assert.ok(overlay.length > 0, "the overlay is styled");
    for (const rule of overlay) {
        const declared = declarations(rule.body).get("pointer-events");
        if (declared !== undefined) {
            assert.equal(declared, "none", `${rule.selector} keeps pointer-events: none`);
        }
    }
});

test("video panels are straight, never scaled, and keep the stream's aspect", () => {
    for (const rule of rulesFor(".sv-video")) {
        const body = declarations(rule.body);
        const transform = body.get("transform");
        if (transform !== undefined) {
            assert.equal(transform, "none", `${rule.selector} leaves transform alone (${transform})`);
        }
        const objectFit = body.get("object-fit");
        if (objectFit !== undefined) {
            assert.equal(objectFit, "cover", `${rule.selector} preserves the aspect ratio`);
        }
        const rotation = body.get("rotate") ?? body.get("skew");
        assert.equal(rotation, undefined, `${rule.selector} is not tilted`);
    }
});

test("only a camera-off avatar image ever scales, and only through the setting", () => {
    for (const rule of RULES) {
        if (isKeyframeRule(rule)) continue;
        const body = declarations(rule.body);
        const transform = body.get("transform");
        if (transform === undefined || !transform.includes("scale(")) continue;

        for (const selector of selectors(rule)) {
            if (selector === ".sv-participant") continue; // its -50%/-50% centring
            if (selector.includes(".sv-avatar::after")) continue; // the ring, not the avatar
            assert.ok(
                selector.includes(".sv-avatar-image"),
                `${selector} scales only the avatar image (${transform})`
            );
        }
        assert.ok(
            transform === "scale(1)" || transform.includes("var(--sv-avatar-scale)"),
            `scaling is either the resting scale(1) or the setting: ${transform}`
        );
    }

    const avatarImage = rulesFor(".sv-avatar-image").map(rule => declarations(rule.body));
    const radius = avatarImage.map(map => map.get("border-radius")).filter(Boolean);
    assert.ok(radius.includes("50%"), "the avatar stays circular");
});

test("the render path keeps rockets off the meeting: no remote asset or import", () => {
    assert.equal(/url\(\s*["']?https?:/i.test(CSS), false, "no remote background");
    assert.equal(CSS.includes("@import"), false, "no stylesheet import");
});

test("switching a theme cannot move a participant", () => {
    const positional = ["position", "left", "top", "right", "bottom", "margin", "translate", "transform"];

    for (const theme of SPATIAL_THEMES) {
        for (const rule of RULES) {
            if (isKeyframeRule(rule)) continue;
            const isThemeBlock = selectors(rule).some(
                selector => selector === `.sv-scene[data-sv-theme="${theme.id}"]`
            );
            if (!isThemeBlock) continue;

            for (const property of positional) {
                assert.equal(
                    declarations(rule.body).has(property),
                    false,
                    `${theme.id} theme block sets no ${property}`
                );
            }
        }
    }
});

test("all nine themes define a full palette, and no other theme value exists", () => {
    const declaredThemes = new Set<string>();
    for (const rule of RULES) {
        for (const selector of selectors(rule)) {
            const match = /\[data-sv-theme="([^"]+)"\]/.exec(selector);
            if (match) declaredThemes.add(match[1]);
        }
    }

    assert.deepEqual(
        [...declaredThemes].sort(),
        SPATIAL_THEMES.map(theme => theme.id).sort(),
        "style.css declares exactly the nine theme ids themes.ts knows"
    );

    const required = [
        "--sv-bg-base",
        "--sv-ink",
        "--sv-ink-dim",
        "--sv-accent",
        "--sv-line-color",
        "--sv-line-highlight",
        "--sv-panel",
        "--sv-chip",
        "--sv-control-bg",
        "--sv-focus",
        "--sv-speaking-ring",
        "--sv-danger",
        "--sv-danger-ink"
    ];

    for (const theme of SPATIAL_THEMES) {
        const variables = themeVariables(theme.id);
        for (const name of required) {
            assert.ok(variables.get(name), `${theme.id} defines ${name}`);
        }
        assert.equal(variables.get("--sv-bg-base"), theme.swatch.base, `${theme.id} swatch base matches the sheet`);
        assert.equal(variables.get("--sv-accent"), theme.swatch.accent, `${theme.id} swatch accent matches the sheet`);
        assert.equal(variables.get("--sv-accent-alt"), theme.swatch.accentAlt, `${theme.id} swatch second accent matches the sheet`);
    }

    assert.ok(
        RULES.some(rule => selectors(rule).some(selector => selector.includes(":not([data-sv-theme])"))),
        "a scene without the attribute still renders Dark Space"
    );
});

test("the nine themes are visually distinct, not nine names for one palette", () => {
    const signatures = new Set<string>();
    for (const theme of SPATIAL_THEMES) {
        const variables = themeVariables(theme.id);
        signatures.add(
            [
                variables.get("--sv-bg-base"),
                variables.get("--sv-accent"),
                variables.get("--sv-line-color"),
                variables.get("--sv-particles")
            ].join("|")
        );
    }
    assert.equal(signatures.size, 9, "every theme has its own base, accent, line colour and particles");
});

test("every theme keeps its text, status, focus, lines and leave button readable", () => {
    for (const theme of SPATIAL_THEMES) {
        const variables = themeVariables(theme.id);
        const base = colourOf(variables, "--sv-bg-base");
        const panel = over(colourOf(variables, "--sv-panel"), base);
        const chip = over(colourOf(variables, "--sv-chip"), base);
        const control = over(colourOf(variables, "--sv-control-bg"), base);
        const ink = over(colourOf(variables, "--sv-ink"), panel);
        const inkBright = over(colourOf(variables, "--sv-ink-bright"), chip);
        const inkDim = over(colourOf(variables, "--sv-ink-dim"), base);
        const focus = over(colourOf(variables, "--sv-focus"), base);
        const line = over(colourOf(variables, "--sv-line-color"), base);
        const lineHighlight = over(colourOf(variables, "--sv-line-highlight"), base);
        const speakingRing = over(colourOf(variables, "--sv-speaking-ring"), base);
        const dangerInk = over(colourOf(variables, "--sv-danger-ink"), colourOf(variables, "--sv-danger"));

        const checks: Array<[string, number, number]> = [
            ["ink on the scene", contrast(ink, base), 4.5],
            ["ink on a video panel", contrast(ink, panel), 4.5],
            ["ink on a name plate", contrast(ink, chip), 4.5],
            ["bright ink on a name plate", contrast(inkBright, chip), 4.5],
            ["status ink on the scene", contrast(inkDim, base), 4.5],
            ["ink on the control bar", contrast(ink, control), 4.5],
            ["focus ring", contrast(focus, base), 3],
            ["connector line", contrast(line, base), 3],
            ["speaking connector highlight", contrast(lineHighlight, base), 3],
            ["speaking avatar ring", contrast(speakingRing, base), 3],
            ["leave button label", contrast(dangerInk, colourOf(variables, "--sv-danger")), 4.5]
        ];

        for (const [label, ratio, minimum] of checks) {
            assert.ok(
                ratio >= minimum,
                `${theme.id}: ${label} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`
            );
        }
    }
});

test("the control bar floats above the connectors and above the scene", () => {
    const controls = RULES.find(rule => rule.selector.trim() === ".sv-controls");
    assert.ok(controls, ".sv-controls is styled");
    const body = declarations(controls.body);

    assert.equal(body.get("position"), "absolute");
    assert.equal(body.get("left"), "50%");
    assert.match(body.get("transform") ?? "", /translateX\(-50%\)/);
    assert.ok(body.get("bottom"), "it sits near the bottom");
    assert.ok(Number(body.get("z-index")) > 1, "it paints over the decorative overlay");
    assert.ok(body.get("backdrop-filter") ?? body.get("-webkit-backdrop-filter"), "it is translucent, not opaque");

    const connectors = RULES.find(rule => rule.selector.trim() === ".sv-connectors");
    assert.ok(connectors);
    assert.equal(declarations(connectors.body).get("z-index"), "1");
});

test("avatars are circular and video panels are the only rectangles", () => {
    for (const className of [".sv-avatar", ".sv-avatar-image"]) {
        const map = declarations(RULES.find(rule => rule.selector.trim() === className)?.body ?? "");
        assert.equal(map.get("border-radius"), "50%", `${className} is a circle`);
    }

    const video = declarations(RULES.find(rule => rule.selector.trim() === ".sv-video")?.body ?? "");
    assert.match(video.get("border-radius") ?? "", /var\(--sv-panel-radius/);
});

test("a theme is a palette, not a different interface: layout rules are shared", () => {
    const themeSpecificLayout = RULES.filter(rule => {
        if (isKeyframeRule(rule)) return false;
        const isThemeScoped = selectors(rule).some(selector => selector.startsWith(".sv-scene[data-sv-theme="));
        if (!isThemeScoped) return false;
        const body = declarations(rule.body);
        return body.has("display") || body.has("grid-template") || body.has("flex-direction");
    });
    assert.deepEqual(themeSpecificLayout.map(rule => rule.selector), []);
});

test("reduced motion is honoured, including the speaking enlargement", () => {
    const reduced = RULES.filter(rule => rule.atRule.includes("prefers-reduced-motion"));
    assert.ok(reduced.length > 0, "a prefers-reduced-motion block exists");

    const combined = reduced.map(rule => `${rule.selector} { ${rule.body} }`).join("\n");
    assert.match(combined, /animation:\s*none/, "background and ring animation stops");
    assert.match(combined, /transition-duration:\s*1ms/, "transitions collapse");
    assert.match(combined, /\.sv-avatar-image/, "the avatar scale transition is covered");
    assert.match(combined, /\.sv-connector/, "connector transitions are covered");

    const settingPause = RULES.filter(rule => rule.atRule === "" && declarations(rule.body).get("animation-play-state")?.includes("var(--sv-anim"));
    assert.ok(settingPause.length >= 2, "the reduced-motion setting pauses both background layers");
});


/* ---- reference treatment ------------------------------------------------- */

function ruleForExact(selector: string): Rule | undefined {
    return RULES.find(rule => !isKeyframeRule(rule) && selectors(rule).some(part => part === selector));
}

test("the focused panel keeps a lit gradient rim, and every other tile says LIVE", () => {
    const rim = ruleForExact('.sv-participant[data-sv-selected="true"] .sv-video::before');
    assert.ok(rim, "the focused panel has a rim rule");
    const rimBody = declarations(rim.body);
    assert.match(rimBody.get("background-image") ?? "", /linear-gradient\(/, "the rim is a gradient, not a flat colour");
    assert.match(rimBody.get("mask-composite") ?? rimBody.get("-webkit-mask-composite") ?? "", /exclude|xor/, "the rim is a border, not a fill");

    const live = ruleForExact('.sv-participant:not([data-sv-selected="true"]) .sv-video::after');
    assert.ok(live, "a secondary tile has a badge rule");
    assert.match(declarations(live.body).get("content") ?? "", /LIVE/, "the badge reads LIVE");
    assert.equal(declarations(live.body).get("pointer-events"), "none", "the badge never takes a click");
});

test("a camera panel carries its name inside the panel, an avatar carries it below", () => {
    const inside = ruleForExact(".sv-video + .sv-label");
    assert.ok(inside, "the panel name has its own rule");
    const body = declarations(inside.body);
    assert.equal(body.get("position"), "absolute", "the name is positioned inside the panel");
    assert.ok(body.get("bottom"), "the name sits at the panel's bottom edge");

    const label = declarations((ruleForExact(".sv-label") ?? { body: "" }).body);
    assert.equal(label.get("background"), "none", "the name is text, not a chip");
    assert.equal(label.get("pointer-events"), "none");
});

test("the avatar ring is an arc, and the connector overlay fades from its origin", () => {
    const ring = ruleForExact(".sv-avatar::before");
    assert.ok(ring, "the avatar has a ring rule");
    assert.match(declarations(ring.body).get("background-image") ?? "", /conic-gradient\(/, "the ring is a conic arc");
    assert.match(
        declarations(ring.body).get("mask-image") ?? declarations(ring.body).get("-webkit-mask-image") ?? "",
        /radial-gradient\(/,
        "the ring is masked to a thin circle"
    );

    const fade = RULES.filter(rule => selectors(rule).some(selector => selector === ".sv-connectors"))
        .map(rule => declarations(rule.body).get("mask-image") ?? declarations(rule.body).get("-webkit-mask-image"))
        .filter(Boolean);
    assert.ok(fade.length > 0, "the connector overlay is masked");
    assert.match(String(fade[0]), /radial-gradient\(/, "the mask is centred on the connector origin");
});

test("the backdrop has its orbit arcs, its vortex and its origin bloom", () => {
    const backdrop = declarations((ruleForExact(".sv-background") ?? { body: "" }).body);
    assert.match(backdrop.get("background-image") ?? "", /var\(--sv-orbit-ink\)/, "the orbit arcs are drawn from a theme variable");

    const vortex = declarations((ruleForExact(".sv-scene::after") ?? { body: "" }).body);
    assert.match(vortex.get("background-image") ?? "", /repeating-conic-gradient\(/, "the vortex is a spiral of light");
    assert.match(vortex.get("mask-image") ?? vortex.get("-webkit-mask-image") ?? "", /radial-gradient\(/, "the vortex is masked to a disc");

    const bloom = declarations((ruleForExact(".sv-scene::before") ?? { body: "" }).body);
    assert.ok(bloom.get("bottom"), "the bloom sits above the call controls");
    assert.equal(bloom.get("pointer-events"), "none", "the bloom never takes a click");
});

test("all nine themes paint the backdrop and the LIVE tag, not just a palette", () => {
    for (const theme of SPATIAL_THEMES) {
        const variables = themeVariables(theme.id);
        for (const name of SPATIAL_BACKDROP_VARIABLES) {
            const value = variables.get(name);
            assert.ok(value, theme.id + " defines " + name);
            assert.ok(parseColour(value) || /gradient\(/.test(value ?? ""), theme.id + " " + name + " is a colour (" + value + ")");
        }
    }
    const base = BASE_VARIABLES;
    for (const name of SPATIAL_BACKDROP_VARIABLES) {
        assert.ok(base.get(name), "the base scene block defines " + name);
    }
});

test("the reference-sized stage is exactly what the layout engine computes", () => {
    const html = readFileSync(new URL("./style.preview.html", import.meta.url), "utf8");
    const match = /<script type="application\/json" id="sv-layout-fixture">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match, "the harness embeds its layout fixture");

    const fixture = JSON.parse(match[1]) as {
        participants: Array<{ id: string; kind: "video" | "avatar" }>;
        states: Record<
            string,
            { width: number; height: number; selectedId: string | null; items: SpatialLayoutItem[] }
        >;
    };

    assert.equal(fixture.states.selected.width, 1024, "the stage is the reference's width");
    assert.equal(fixture.states.selected.height, 572, "the stage is the reference's height");
    assert.equal(fixture.states.overview.width, 1024, "the overview stage matches the reference too");

    for (const [state, bakedState] of Object.entries(fixture.states)) {
        const expected = computeSpatialLayout({
            width: bakedState.width,
            height: bakedState.height,
            participants: fixture.participants,
            selectedId: bakedState.selectedId
        });
        const baked = bakedState.items;
        assert.equal(
            baked.length,
            expected.items.length,
            state + " bakes the same number of participants the engine places"
        );
        for (const item of expected.items) {
            const row = baked.find(candidate => candidate.id === item.id);
            assert.ok(row, state + " bakes " + item.id);
            assert.deepEqual(
                { x: row.x, y: row.y, width: row.width, height: row.height },
                { x: item.x, y: item.y, width: item.width, height: item.height },
                state + " bakes the position layout.ts produces for " + item.id
            );
        }
    }
});

test("the light theme overrides the shadow and keeps native controls light", () => {
    const minimal = themeVariables("minimal");
    assert.equal(minimal.get("--sv-label-shadow"), "none", "no dark text shadow on light ink");
    assert.ok(
        RULES.some(rule => selectors(rule).some(selector => selector.includes('[data-sv-scheme="light"]')) &&
            declarations(rule.body).get("color-scheme") === "light"),
        "native scrollbars and carets render light"
    );
});
