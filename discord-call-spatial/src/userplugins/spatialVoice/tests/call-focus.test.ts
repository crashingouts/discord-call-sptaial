/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Tests for the call view and its fullscreen chevron in callFocus.ts.
 *
 * Runs with the Node test runner and no dependencies:
 *   node --test src/userplugins/spatialVoice/tests/call-focus.test.ts
 *
 * Every fixture below is a shape measured in a live client (Vencord 1.15.12,
 * Discord Canary, 2026-10-29, read over the DevTools protocol):
 *
 *   Friends page, call joined, camera in a picture-in-picture window:
 *     0 x [data-call-tile], one live <video> inside `pictureInPictureWindow`, the
 *     channel list's voice panel holding Mute / Deafen / Disconnect, and the app
 *     shell (`notAppAsidePanel`) around everything. This is the page the scene
 *     used to cover.
 *
 *   Call view, 9 participants:
 *     9 x [data-call-tile] in a 1472 x 848 grid inside `callContainer`, whose
 *     control tray holds `Pop Out` and `Full Screen`; the server list items carry
 *     `data-list-item-id="guildsnav___…"`.
 *
 *   The same call while Discord's fullscreen is on:
 *     `callContainer` and the wrapper carry `fullScreen_<hash>`, the app grid's
 *     computed columns are `[start] 0px [guildsEnd] 0px [channelsEnd] 1920px [end]`
 *     and the fullscreen control reads `Exit Full Screen`.
 *
 * The fake DOM carries the two things the module reads: a box and a computed
 * style. Discord's own fullscreen control is a fake button that flips its own
 * label and the call's class when pressed, exactly as the live client did.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    CALL_TILE_ATTRIBUTE,
    CallFocusController as Controller,
    type CallFocusEnvironment,
    CHEVRON_PATH,
    findCallView,
    FOCUS_ATTRIBUTE,
    FOCUS_TOGGLE_ATTRIBUTE,
    FOCUS_TOGGLE_CLASS,
    hasFullScreenClass,
    isFullScreenControl,
    toggleLabel
} from "../callFocus.ts";

// ------------------------------------------------------------------ fake DOM

interface FakeRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

class FakeEvent {
    defaultPrevented = false;
    propagationStopped = false;

    preventDefault(): void {
        this.defaultPrevented = true;
    }

    stopPropagation(): void {
        this.propagationStopped = true;
    }
}

class FakeElement {
    readonly tagName: string;
    children: FakeElement[] = [];
    parentElement: FakeElement | null = null;
    rect: FakeRect = { left: 0, top: 0, width: 0, height: 0 };

    /** The values Discord's stylesheet gives the element. */
    base: Record<string, string> = {};
    /** The element's inline style, which is what this module writes. */
    style: Record<string, string> = {};

    className = "";
    id = "";
    type = "";

    private readonly attrs = new Map<string, string>();
    private readonly listeners = new Map<string, Set<(event: FakeEvent) => void>>();
    /** What a press on this element does, for Discord's own controls. */
    onPress: (() => void) | null = null;
    presses = 0;

    constructor(tagName: string) {
        this.tagName = tagName;
    }

    get isConnected(): boolean {
        let node: FakeElement | null = this;
        while (node.parentElement) node = node.parentElement;

        return node.tagName === "#document";
    }

    getAttribute(name: string): string | null {
        return this.attrs.get(name) ?? null;
    }

    setAttribute(name: string, value: string): void {
        this.attrs.set(name, String(value));
    }

    hasAttribute(name: string): boolean {
        return this.attrs.has(name);
    }

    getBoundingClientRect() {
        const { left, top, width, height } = this.rect;

        return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
    }

    appendChild(child: FakeElement): FakeElement {
        child.remove();
        child.parentElement = this;
        this.children.push(child);

        return child;
    }

    remove(): void {
        const parent = this.parentElement;
        if (!parent) return;

        const index = parent.children.indexOf(this);
        if (index >= 0) parent.children.splice(index, 1);

        this.parentElement = null;
    }

    contains(other: unknown): boolean {
        for (let node = other as FakeElement | null; node; node = node.parentElement) {
            if (node === this) return true;
        }

        return false;
    }

    addEventListener(type: string, listener: (event: FakeEvent) => void): void {
        const set = this.listeners.get(type) ?? new Set();
        set.add(listener);
        this.listeners.set(type, set);
    }

    removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    /** A real click: the element's own action runs, then the event runs down the tree. */
    click(): FakeEvent {
        const event = new FakeEvent();

        if (this.onPress) this.onPress();
        this.presses++;

        for (let node: FakeElement | null = this; node; node = node.parentElement) {
            for (const listener of Array.from(node.listeners.get("click") ?? [])) {
                listener(event);
                if (event.propagationStopped) return event;
            }
        }

        return event;
    }

    /** Every descendant carrying the toggle class, in document order. */
    toggles(): FakeElement[] {
        const found: FakeElement[] = [];
        const walk = (node: FakeElement) => {
            for (const child of node.children) {
                if (child.className === FOCUS_TOGGLE_CLASS) found.push(child);
                walk(child);
            }
        };
        walk(this);

        return found;
    }
}

class FakeDocument {
    readonly documentElement = new FakeElement("#document");
    readonly body = this.documentElement.appendChild(new FakeElement("BODY"));

    createElement(tagName: string): FakeElement {
        return new FakeElement(tagName.toUpperCase());
    }

    createElementNS(_namespace: string, tagName: string): FakeElement {
        return new FakeElement(tagName.toUpperCase());
    }
}

/**
 * The computed style a browser would report: stylesheet values, overridden by
 * inline ones, with an emptied inline value falling back to the stylesheet.
 */
function environment(doc: FakeDocument, viewport = { width: 1920, height: 1080 }): CallFocusEnvironment {
    return {
        doc: doc as unknown as Document,
        styleOf: element => {
            const fake = element as unknown as FakeElement;
            const computed: Record<string, string> = {
                position: "static",
                pointerEvents: "auto",
                zIndex: "auto",
                left: "auto",
                top: "auto",
                ...fake.base
            };

            for (const [property, value] of Object.entries(fake.style)) {
                if (value !== "") computed[property] = value;
            }

            return computed as unknown as ReturnType<CallFocusEnvironment["styleOf"]>;
        },
        rectOf: element => (element as unknown as FakeElement).rect,
        viewport: () => viewport
    };
}

// --------------------------------------------------------------- the fixtures

function div(parent: FakeElement, rect: FakeRect, base: Record<string, string> = {}): FakeElement {
    const element = parent.appendChild(new FakeElement("DIV"));
    element.rect = rect;
    element.base = base;

    return element;
}

/** A button with Discord's accessible label and, optionally, a press handler. */
function button(parent: FakeElement, label: string, press?: () => void): FakeElement {
    const element = parent.appendChild(new FakeElement("BUTTON"));
    element.setAttribute("aria-label", label);
    element.onPress = press ?? null;

    return element;
}

/** Discord's server list: its own marker on every item. */
function guildNavs(shell: FakeElement, count = 3): FakeElement[] {
    const found: FakeElement[] = [];

    for (let index = 0; index < count; index++) {
        const item = div(shell, { left: 16, top: 32 + index * 48, width: 40, height: 40 });
        item.setAttribute("data-list-item-id", `guildsnav___guild-${index}`);
        found.push(item);
    }

    return found;
}

/**
 * Discord's own call fullscreen control: pressing it flips its own label and the
 * `fullScreen` class on the call *container*, which is what the live client did.
 * The container is an ancestor of the call root, i.e. above the surface this
 * module mounts in, which is the shape that made an earlier version report "not
 * fullscreen" while Discord's own control read `Exit Full Screen`.
 */
function fullscreenControl(tray: FakeElement, container: FakeElement): FakeElement {
    const control = button(tray, "Full Screen");
    control.onPress = () => {
        const expanded = !hasFullScreenClass(container.className);
        container.className = expanded
            ? "callContainer_cb9592 fullScreen_cb9592 theme-dark"
            : "callContainer_cb9592 theme-dark";
        control.setAttribute("aria-label", expanded ? "Exit Full Screen" : "Full Screen");
    };

    return control;
}

/**
 * The live call view: 9 tiles, a control tray, Discord's fullscreen control.
 *
 * `container` is the call container that carries Discord's `fullScreen` class;
 * `root` is the element the module mounts in and the chevron lives in, one level
 * below it.
 */
function callView() {
    const doc = new FakeDocument();

    const shell = div(doc.body, { left: 0, top: 0, width: 1920, height: 1080 }, { position: "relative" });
    const nav = guildNavs(shell);

    const content = div(shell, { left: 0, top: 32, width: 1920, height: 1048 }, { position: "relative" });
    div(content, { left: 0, top: 32, width: 432, height: 1048 });

    const page = div(content, { left: 432, top: 32, width: 1488, height: 1048 }, { position: "relative" });
    const container = div(page, { left: 432, top: 32, width: 1488, height: 1048 }, { position: "relative" });
    container.className = "callContainer_cb9592 theme-dark";

    const call = div(container, { left: 432, top: 32, width: 1488, height: 1048 }, { position: "relative" });
    call.className = "root_bfe55a idle_bfe55a";

    const grid = div(call, { left: 440, top: 100, width: 1472, height: 848 });
    const tiles: FakeElement[] = [];
    for (let index = 0; index < 9; index++) {
        const tile = div(grid, {
            left: 440 + (index % 3) * 490,
            top: 100 + Math.floor(index / 3) * 283,
            width: 486,
            height: 279
        });
        tile.setAttribute(CALL_TILE_ATTRIBUTE, "");
        tile.setAttribute("data-selenium-video-tile", `user-${index}`);
        tiles.push(tile);
    }

    const controls = div(call, { left: 1000, top: 1000, width: 480, height: 48 });
    button(controls, "Mute");
    button(controls, "Deafen");
    button(controls, "Disconnect");
    button(controls, "Pop Out");
    // Discord's own fullscreen control sits in the call's control tray, inside the
    // call root, and flips the class on the container above it (measured live).
    const fullscreen = fullscreenControl(controls, container);

    return { doc, shell, nav, content, page, container, call, grid, tiles, controls, fullscreen };
}

/** The Friends page with the same call joined, its camera in a PiP window. */
function friendsPage() {
    const doc = new FakeDocument();

    const shell = div(doc.body, { left: 0, top: 0, width: 1920, height: 1080 }, { position: "relative" });
    const nav = guildNavs(shell);

    const content = div(shell, { left: 0, top: 32, width: 1920, height: 1048 }, { position: "relative" });
    const sidebar = div(content, { left: 0, top: 32, width: 432, height: 1048 });

    // The channel list's voice panel: three labelled call buttons in a bar.
    const panel = div(sidebar, { left: 12, top: 939, width: 408, height: 125 });
    button(panel, "Mute");
    button(panel, "Deafen");
    button(panel, "Disconnect");

    const page = div(content, { left: 432, top: 32, width: 1488, height: 1048 });
    const pip = div(page, { left: 1520, top: 768, width: 320, height: 180 });
    const video = pip.appendChild(new FakeElement("VIDEO"));
    video.srcObject = { getVideoTracks: () => [{ kind: "video" }] };

    return { doc, shell, nav, sidebar, panel, page, pip, video };
}

/** The same call in Discord's mini player: real tiles, a small box. */
function miniPlayer() {
    const doc = new FakeDocument();
    const shell = div(doc.body, { left: 0, top: 0, width: 1920, height: 1080 });
    const nav = guildNavs(shell);

    const page = div(shell, { left: 432, top: 32, width: 1488, height: 1048 });
    const mini = div(page, { left: 1560, top: 760, width: 320, height: 200 });
    const grid = div(mini, { left: 1560, top: 760, width: 320, height: 180 });
    const tile = div(grid, { left: 1560, top: 760, width: 320, height: 180 });
    tile.setAttribute(CALL_TILE_ATTRIBUTE, "");

    return { doc, shell, nav, page, mini, grid, tile };
}

function lookup(
    tiles: FakeElement[],
    buttons: FakeElement[],
    navs: FakeElement[],
    controls: FakeElement | null = null
) {
    return {
        tiles: tiles as unknown as Element[],
        buttons: buttons as unknown as Element[],
        controls: controls as unknown as Element | null,
        guildNavs: navs as unknown as Element[]
    };
}

/** Every button in a document, the way the adapter queries them. */
function allButtons(doc: FakeDocument): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement) => {
        for (const child of node.children) {
            if (child.tagName === "BUTTON") found.push(child);
            walk(child);
        }
    };
    walk(doc.documentElement);

    return found;
}

// ------------------------------------------------------------- the detection

test("the Friends page with a call joined is not a call view", () => {
    const friends = friendsPage();
    const env = environment(friends.doc);

    const view = findCallView(env, lookup([], allButtons(friends.doc), friends.nav, friends.panel));

    assert.equal(view, null);
});

test("the Friends page never mounts a chevron and writes nothing of Discord's", () => {
    const friends = friendsPage();
    const focus = new Controller(environment(friends.doc));

    const state = focus.sync({ channelId: "channel-1", view: null });

    assert.equal(state.mounted, false);
    assert.equal(state.expanded, false);
    assert.equal(friends.doc.documentElement.toggles().length, 0);
    assert.equal(Object.keys(friends.page.style).length, 0);
    assert.equal(Object.keys(friends.panel.style).length, 0);
    assert.equal(Object.keys(friends.sidebar.style).length, 0);
});

test("a mini player's tiles do not qualify as the call view", () => {
    const mini = miniPlayer();
    const env = environment(mini.doc);

    const view = findCallView(env, lookup([mini.tile], allButtons(mini.doc), mini.nav));

    assert.equal(view, null);
});

test("the real call view is found, with Discord's own fullscreen control", () => {
    const call = callView();
    const env = environment(call.doc);

    const view = findCallView(env, lookup(call.tiles, allButtons(call.doc), call.nav, call.controls));

    assert.ok(view);
    assert.equal(view.surface, call.call);
    assert.equal(view.grid, call.grid);
    assert.equal(view.controls, call.controls);
    assert.equal(view.fullscreen, call.fullscreen);
    assert.equal(view.expanded, false);
});

test("a candidate surface that contains the server list is the app shell, not a call view", () => {
    const call = callView();
    const env = environment(call.doc);

    // The fullscreen control is moved up into the application shell, so the only
    // ancestor that holds both it and the tiles would be the shell itself.
    call.shell.appendChild(call.fullscreen);

    const view = findCallView(env, lookup(call.tiles, allButtons(call.doc), call.nav, call.controls));

    assert.equal(view, null);
});

test("a control bar outside the call view is not the call's bar", () => {
    const call = callView();
    const env = environment(call.doc);

    const stray = div(call.shell, { left: 0, top: 940, width: 400, height: 48 });
    button(stray, "Mute");
    button(stray, "Deafen");
    button(stray, "Disconnect");

    const view = findCallView(env, lookup(call.tiles, allButtons(call.doc), call.nav, stray));

    assert.ok(view);
    assert.equal(view.controls, null);
});

test("Discord's own fullscreen state is read from its class, not from our own attribute", () => {
    assert.equal(hasFullScreenClass("callContainer_cb9592 theme-dark"), false);
    assert.equal(hasFullScreenClass("callContainer_cb9592 fullScreen_cb9592 theme-dark"), true);
    assert.equal(hasFullScreenClass("fullScreen"), true);
    assert.equal(hasFullScreenClass("notFullScreen_abc"), false);

    const call = callView();
    call.container.className = "callContainer_cb9592 fullScreen_cb9592";
    call.fullscreen.setAttribute("aria-label", "Exit Full Screen");

    const view = findCallView(environment(call.doc), lookup(call.tiles, allButtons(call.doc), call.nav, call.controls));

    assert.ok(view);
    assert.equal(view.expanded, true);
});

test("the look that lands before Discord re-renders does not undo the press", () => {
    const call = callView();
    const focus = mounted(call.doc, call);

    // A control that has not re-rendered yet: the class is still the normal view.
    const control = call.fullscreen;
    control.onPress = null;

    call.doc.documentElement.toggles()[0].click();
    assert.equal(focus.state.expanded, true);

    // Eight looks before Discord catches up: the chevron must not flicker.
    for (let look = 0; look < 8; look++) {
        resync(call.doc, call, focus);
        assert.equal(focus.state.expanded, true, `look ${look + 1} keeps the press`);
    }

    // Past that, Discord wins: the press never landed, so the button says what
    // Discord says.
    resync(call.doc, call, focus);
    assert.equal(focus.state.expanded, false);
    assert.equal(focus.state.label, "Fullscreen the call");

    focus.destroy();
});

test("a fullscreen class above the mount surface is still read as fullscreen", () => {
    // Measured live: the surface the module mounts in is the call root
    // (`root_…`), and Discord puts `fullScreen_<hash>` on the call container one
    // level above it. Stopping the search at the surface reported "not
    // fullscreen" while Discord's own control already read `Exit Full Screen`.
    const call = callView();
    call.container.className = "callContainer_cb9592 fullScreen_cb9592 theme-dark";
    call.fullscreen.setAttribute("aria-label", "Exit Full Screen");

    const view = findCallView(environment(call.doc), lookup(call.tiles, allButtons(call.doc), call.nav, call.controls));

    assert.ok(view);
    assert.equal(view.surface, call.call, "the mount surface is still the call root");
    assert.equal(view.expanded, true, "the class on the ancestor above it still counts");
});

test("our own button is never mistaken for Discord's fullscreen control", () => {
    const doc = new FakeDocument();
    const element = div(doc.body, { left: 0, top: 0, width: 32, height: 32 });
    element.setAttribute("aria-label", "Fullscreen the call");
    assert.equal(isFullScreenControl(element), true);

    element.setAttribute(FOCUS_TOGGLE_ATTRIBUTE, "");
    assert.equal(isFullScreenControl(element), false);
});

// ------------------------------------------------------------- the chevron

/**
 * Mounts the chevron for a call view, refusing to continue when the view is not
 * found: a null view here would make every assertion below vacuous.
 */
function mounted(doc: FakeDocument, call: ReturnType<typeof callView>): Controller {
    const env = environment(doc);
    const view = findCallView(env, lookup(call.tiles, allButtons(doc), call.nav, call.controls));
    assert.ok(view, "the fixture is a call view");

    const focus = new Controller(env);
    focus.sync({ channelId: "channel-1", view });

    return focus;
}

function resync(doc: FakeDocument, call: ReturnType<typeof callView>, focus: Controller): void {
    const env = environment(doc);
    focus.sync({
        channelId: "channel-1",
        view: findCallView(env, lookup(call.tiles, allButtons(doc), call.nav, call.controls))
    });
}

test("joining the call view mounts one chevron inside it, reporting the normal view", () => {
    const call = callView();
    const focus = mounted(call.doc, call);

    const { state } = focus;
    assert.equal(state.mounted, true);
    assert.equal(state.expanded, false);
    assert.equal(state.label, "Fullscreen the call");
    assert.equal(state.focused, "false");

    const toggles = call.doc.documentElement.toggles();
    assert.equal(toggles.length, 1);

    const toggle = toggles[0];
    assert.equal(toggle.parentElement, call.call, "the chevron lives in the call view, not the page");
    assert.equal(toggle.type, "button");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(toggle.getAttribute(FOCUS_ATTRIBUTE), "false");
    assert.equal(toggle.getAttribute("title"), "Fullscreen the call");

    // One authored glyph, pointing right; CSS reverses it while focused is "false".
    const [svg] = toggle.children;
    assert.equal(svg.tagName, "SVG");
    assert.equal(svg.children[0].getAttribute("d"), CHEVRON_PATH);
    assert.ok(CHEVRON_PATH.startsWith("M9.5"));

    focus.destroy();
});

test("pressing the chevron presses Discord's own control, once per press", () => {
    const call = callView();
    const focus = mounted(call.doc, call);

    const toggle = call.doc.documentElement.toggles()[0];
    const event = toggle.click();

    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.equal(call.fullscreen.presses, 1);
    assert.equal(call.container.className.includes("fullScreen"), true);

    // The label follows the optimistic flip at once.
    assert.equal(focus.state.expanded, true);
    assert.equal(focus.state.focused, "true");
    assert.equal(focus.state.label, "Show the rest of Discord");

    focus.destroy();
});

test("repeated presses alternate and never mount a second chevron", () => {
    const call = callView();
    const focus = mounted(call.doc, call);
    const toggle = call.doc.documentElement.toggles()[0];

    for (let press = 0; press < 5; press++) {
        toggle.click();
        // The adapter looks again after every Discord re-render.
        resync(call.doc, call, focus);

        const expanded = press % 2 === 0;
        assert.equal(focus.state.expanded, expanded);
        assert.equal(toggle.getAttribute(FOCUS_ATTRIBUTE), expanded ? "true" : "false");
        assert.equal(call.doc.documentElement.toggles().length, 1);
    }

    assert.equal(call.fullscreen.presses, 5);
    assert.equal(call.container.className.includes("fullScreen"), true);

    focus.destroy();
});

test("a state change made by Discord, such as Escape, is what the chevron reports", () => {
    const call = callView();
    const focus = mounted(call.doc, call);

    // The user presses Discord's own control: no press from this module.
    call.fullscreen.click();
    assert.equal(call.fullscreen.presses, 1);

    resync(call.doc, call, focus);

    assert.equal(focus.state.expanded, true);
    assert.equal(focus.state.focused, "true");
    assert.equal(focus.state.label, "Show the rest of Discord");

    // Discord leaves fullscreen by itself (Escape), and the next look follows.
    call.container.className = "callContainer_cb9592 theme-dark";
    call.fullscreen.setAttribute("aria-label", "Full Screen");

    resync(call.doc, call, focus);

    assert.equal(focus.state.expanded, false);
    assert.equal(focus.state.focused, "false");
    assert.equal(call.fullscreen.presses, 1, "the plugin pressed nothing to follow Discord's own change");

    focus.destroy();
});

test("leaving the call view takes the chevron away and gives Discord its own layout back", () => {
    const call = callView();
    const focus = mounted(call.doc, call);
    call.doc.documentElement.toggles()[0].click();

    const state = focus.sync({ channelId: "channel-1", view: null });

    assert.equal(state.mounted, false);
    assert.equal(state.expanded, false);
    assert.equal(call.doc.documentElement.toggles().length, 0);

    // The fullscreen this module turned on is handed back through Discord's own
    // control, so no fullscreen outlives the view that owned it.
    assert.equal(call.fullscreen.presses, 2);
    assert.equal(call.container.className.includes("fullScreen"), false);

    // And the call view's own inline position is Discord's again.
    assert.equal(call.call.style.position, undefined);
});

test("teardown restores the call view and removes every write of this module", () => {
    const call = callView();
    const focus = mounted(call.doc, call);
    call.doc.documentElement.toggles()[0].click();

    focus.destroy();

    assert.equal(call.doc.documentElement.toggles().length, 0);
    assert.equal(call.fullscreen.presses, 2, "the expansion this module made is undone");
    assert.equal(call.container.className.includes("fullScreen"), false);
    assert.equal(call.call.style.position, undefined);
    assert.equal(focus.state.mounted, false);
});

test("a fullscreen the user turned on with Discord's control survives teardown", () => {
    const call = callView();
    const focus = mounted(call.doc, call);

    // The user's own press, not ours.
    call.fullscreen.click();

    focus.destroy();

    assert.equal(call.fullscreen.presses, 1, "the plugin pressed nothing");
    assert.equal(call.container.className.includes("fullScreen"), true);
    assert.equal(call.doc.documentElement.toggles().length, 0);
});

test("switching the scene off suspends the chevron without changing Discord's view", () => {
    const call = callView();
    const focus = mounted(call.doc, call);
    call.doc.documentElement.toggles()[0].click();

    focus.suspend();

    assert.equal(focus.state.mounted, false);
    assert.equal(call.doc.documentElement.toggles().length, 0);
    assert.equal(call.fullscreen.presses, 1, "suspend leaves Discord fullscreen as the user left it");
    assert.equal(call.call.style.position, undefined);
});

test("a chevron that stops being the call view's own button is re-mounted there", () => {
    const call = callView();
    const focus = mounted(call.doc, call);

    const toggle = call.doc.documentElement.toggles()[0];
    toggle.remove();

    resync(call.doc, call, focus);

    const toggles = call.doc.documentElement.toggles();
    assert.equal(toggles.length, 1);
    assert.equal(toggles[0].parentElement, call.call);

    focus.destroy();
});

test("the labels name what a press will do", () => {
    assert.equal(toggleLabel(false), "Fullscreen the call");
    assert.equal(toggleLabel(true), "Show the rest of Discord");
});
