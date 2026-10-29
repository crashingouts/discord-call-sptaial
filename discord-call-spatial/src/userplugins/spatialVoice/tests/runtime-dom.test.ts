/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Tests for the runtime DOM rules in runtimeDom.ts.
 *
 * Runs with the Node test runner and no dependencies:
 *   node --test src/userplugins/spatialVoice/tests/runtime-dom.test.ts
 *
 * Every fixture below is the shape a live Discord call was measured to render
 * (Vencord 1.15.12, Discord Canary, 2026-10-29):
 *
 *   - four `[data-call-tile]` tiles, each `data-selenium-video-tile="<user id>"`,
 *     every one of them containing the avatars of all three people in the call;
 *   - one live `<video>` for the whole call, inside one tile;
 *   - call-control buttons that each sit in their own wrapper, four ancestors
 *     below the bar that holds them.
 *
 * The fake DOM here supports exactly the selectors the module uses: a tag name,
 * `[attr]`, `[attr="value"]`, and comma lists of those.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    chooseVideo,
    findCallControls,
    findCallSurface,
    findTileGrid,
    isLiveVideo,
    liveVideos,
    lowestCommonAncestor,
    matchLiveVideos,
    matchScore,
    type MatchTarget,
    rectOf,
    tileUserId
} from "../runtimeDom.ts";

// ---------------------------------------------------------------- fake DOM

interface FakeRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

class FakeVideoElement {
    tagName = "VIDEO";
    children: FakeElement[] = [];
    parentElement: FakeElement | null = null;
    srcObject: unknown = null;
    private readonly attrs = new Map<string, string>();
    rect: FakeRect = { left: 0, top: 0, width: 100, height: 100 };

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

    contains(other: unknown): boolean {
        for (let node = other as FakeElement | null; node; node = node.parentElement) {
            if ((node as unknown) === this) return true;
        }

        return false;
    }

    querySelectorAll(): FakeElement[] {
        return [];
    }
}

class FakeElement {
    children: FakeElement[] = [];
    parentElement: FakeElement | null = null;
    rect: FakeRect = { left: 0, top: 0, width: 0, height: 0 };
    readonly tagName: string;
    private readonly attrs = new Map<string, string>();

    constructor(tagName: string) {
        this.tagName = tagName;
    }

    getAttribute(name: string): string | null {
        return this.attrs.get(name) ?? null;
    }

    /** The DOM exposes `src` as a property as well as an attribute. */
    get src(): string {
        return this.attrs.get("src") ?? "";
    }

    get currentSrc(): string {
        return this.src;
    }

    setAttribute(name: string, value: string): void {
        this.attrs.set(name, String(value));
    }

    hasAttribute(name: string): boolean {
        return this.attrs.has(name);
    }

    appendChild(child: FakeElement): FakeElement {
        child.parentElement = this;
        this.children.push(child);

        return child;
    }

    append(...children: FakeElement[]): this {
        for (const child of children) this.appendChild(child);

        return this;
    }

    getBoundingClientRect() {
        const { left, top, width, height } = this.rect;

        return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
    }

    contains(other: unknown): boolean {
        for (let node = other as FakeElement | null; node; node = node.parentElement) {
            if ((node as unknown) === this) return true;
        }

        return false;
    }

    querySelectorAll(selector: string): FakeElement[] {
        const matchers = selector.split(",").map(part => part.trim());
        const found: FakeElement[] = [];

        const walk = (node: FakeElement) => {
            for (const child of node.children) {
                if (matchers.some(matcher => matches(child, matcher))) found.push(child);
                walk(child);
            }
        };

        walk(this);

        return found;
    }

    querySelector(selector: string): FakeElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }
}

class FakeDocument {
    readonly documentElement = new FakeElement("#document");
    readonly body = this.documentElement.appendChild(new FakeElement("BODY"));
    readonly defaultView = { innerWidth: 1920, innerHeight: 1080 };

    querySelectorAll(selector: string): FakeElement[] {
        return this.documentElement.querySelectorAll(selector);
    }

    querySelector(selector: string): FakeElement | null {
        return this.documentElement.querySelector(selector);
    }
}

function matches(element: FakeElement, selector: string): boolean {
    const tag = /^([a-zA-Z][\w-]*)/.exec(selector)?.[1];
    if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;

    const attr = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(selector);
    if (attr) {
        const value = element.getAttribute(attr[1]);
        if (value === null) return false;
        if (attr[2] !== undefined && value !== attr[2]) return false;
    }

    return true;
}

function doc(): Document {
    return new FakeDocument() as unknown as Document;
}

function el(parent: FakeElement | FakeDocument, tag: string, attributes: Record<string, string> = {}, rect?: FakeRect): FakeElement {
    const element = new FakeElement(tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    if (rect) element.rect = rect;
    if (parent instanceof FakeDocument) parent.body.appendChild(element);
    else parent.appendChild(element);

    return element;
}

function video(parent: FakeElement, live: boolean): FakeVideoElement {
    const element = new FakeVideoElement();
    element.srcObject = live
        ? { getVideoTracks: () => [{ kind: "video", label: "camera" }] }
        : { getVideoTracks: () => [] };
    element.parentElement = parent;
    parent.children.push(element as unknown as FakeElement);

    return element;
}

function participant(id: string, userId: string, displayName: string): MatchTarget & { cameraOn: boolean } {
    return { id, userId, displayName, cameraOn: true };
}

/**
 * The measured live-call shape: a grid holding four tiles, every tile carrying
 * the avatars of all three people, one live video inside the first tile, and the
 * control bar with each button in its own wrapper.
 */
function liveCall() {
    const document = new FakeDocument();

    const root = el(document.body, "DIV", {}, { left: 432, top: 32, width: 1488, height: 1048 });
    const grid = el(root, "DIV", { role: "list" }, { left: 440, top: 137, width: 1472, height: 846 });
    // Discord lays the tiles out in rows: two tiles per row in this call.
    const rows = [el(grid, "DIV"), el(grid, "DIV")];

    const people = [
        { id: "725832226259992656", name: "PIEP ENJOYER" },
        { id: "1328837447139983468", name: "dawg" },
        { id: "1210062515820564481", name: "Johnny" }
    ];

    const tiles: FakeElement[] = [];
    for (let index = 0; index < 4; index++) {
        const tile = el(rows[Math.floor(index / 2)], "DIV", { "data-call-tile": "", "data-selenium-video-tile": people[index % 3].id }, {
            left: 440 + (index % 2) * 740,
            top: 137 + Math.floor(index / 2) * 420,
            width: 732,
            height: 412
        });
        // Every tile renders the avatars of everyone in the call.
        const avatarStack = el(tile, "DIV");
        for (const person of people) el(avatarStack, "IMG", { src: `https://cdn.discordapp.com/avatars/${person.id}/hash.png` });
        tiles.push(tile);
    }

    const live = video(el(tiles[0], "DIV"), true);

    const controls = el(root, "DIV", { class: "centerControls" }, { left: 964, top: 1022, width: 424, height: 50 });
    const labels = ["Unmute", "Turn On Camera", "Share Your Screen", "Open Soundboard", "Send a Reaction", "Leave Call"];
    const buttons: FakeElement[] = [];
    for (const label of labels) {
        // Each button sits in its own wrapper, five levels below the bar.
        const wrapper = el(el(el(el(el(controls, "DIV"), "DIV"), "DIV"), "DIV"), "DIV", {}, { left: 1000, top: 1027, width: 40, height: 40 });
        buttons.push(el(wrapper, "BUTTON", { "aria-label": label }, { left: 1000, top: 1027, width: 40, height: 40 }));
    }

    return { document: document as unknown as Document, fake: document, root, grid, tiles, live, controls, buttons };
}

// ------------------------------------------------------------------- tests

test("a live video is one whose srcObject carries a video track", () => {
    const parent = new FakeElement("DIV");
    const live = video(parent, true);
    const poster = video(parent, false);
    const empty = new FakeElement("VIDEO");
    empty.parentElement = parent;
    parent.children.push(empty);

    assert.equal(isLiveVideo(live as unknown as Element), true);
    assert.equal(isLiveVideo(poster as unknown as Element), false);
    assert.equal(isLiveVideo(empty as unknown as Element), false);
});

test("liveVideos finds every video with a track and nothing else", () => {
    const { document } = liveCall();

    assert.equal(liveVideos(document).length, 1);
});

test("tile identity beats every avatar in the tile", () => {
    const { document, live } = liveCall();
    const people = [
        participant("725832226259992656", "725832226259992656", "PIEP ENJOYER"),
        participant("1328837447139983468", "1328837447139983468", "dawg"),
        participant("1210062515820564481", "1210062515820564481", "Johnny")
    ];

    const { matched, liveVideos: count } = matchLiveVideos(document, people);

    assert.equal(count, 1);
    assert.deepEqual([...matched.keys()], ["725832226259992656"]);
    assert.equal(matched.get("725832226259992656")?.[0].element, live);
    assert.equal(matched.get("725832226259992656")?.[0].inTile, true);
    // The other two people are not handed someone else's picture.
    assert.equal(matched.has("1328837447139983468"), false);
    assert.equal(matched.has("1210062515820564481"), false);
});

test("without a tile id, an avatar shared by several people is a tie and matches nobody", () => {
    const document = new FakeDocument();
    const tile = el(document.body, "DIV");
    const stack = el(tile, "DIV");
    for (const id of ["111", "222"]) el(stack, "IMG", { src: `https://cdn.discordapp.com/avatars/${id}/hash.png` });
    video(el(tile, "DIV"), true);

    const { matched } = matchLiveVideos(document as unknown as Document, [
        participant("111", "111", "One"),
        participant("222", "222", "Two")
    ]);

    assert.equal(matched.size, 0);
});

test("without a tile id, a single named avatar still resolves that person", () => {
    const document = new FakeDocument();
    const tile = el(document.body, "DIV");
    el(tile, "IMG", { src: "https://cdn.discordapp.com/avatars/111/hash.png" });
    video(el(tile, "DIV"), true);

    const { matched } = matchLiveVideos(document as unknown as Document, [
        participant("111", "111", "One"),
        participant("222", "222", "Two")
    ]);

    assert.deepEqual([...matched.keys()], ["111"]);
});

test("matchScore ranks Discord's tile id above an avatar and a label", () => {
    const tile = new FakeElement("DIV");
    tile.setAttribute("data-selenium-video-tile", "111");
    const one = participant("111", "111", "One");

    assert.equal(matchScore(tile as unknown as Element, one), 5);

    const avatarOnly = new FakeElement("DIV");
    el(avatarOnly, "IMG", { src: "https://cdn.discordapp.com/avatars/111/hash.png" });
    assert.equal(matchScore(avatarOnly as unknown as Element, one), 3);

    const labelled = new FakeElement("DIV");
    labelled.setAttribute("aria-label", "One");
    assert.equal(matchScore(labelled as unknown as Element, one), 2);

    assert.equal(matchScore(new FakeElement("DIV") as unknown as Element, one), 0);
});

test("tileUserId walks up from a video to Discord's own identity attribute", () => {
    const tile = new FakeElement("DIV");
    tile.setAttribute("data-selenium-video-tile", "725832226259992656");
    const inner = el(tile, "DIV");
    const wrapper = el(inner, "DIV");

    assert.equal(tileUserId(wrapper as unknown as Element), "725832226259992656");
    assert.equal(tileUserId(new FakeElement("DIV") as unknown as Element), null);
});

test("the tile grid is the element holding every call tile, not one tile", () => {
    const { document, grid, tiles } = liveCall();
    const found = findTileGrid(document);

    assert.equal(found, grid as unknown as HTMLElement);
    // The regression: the old rule returned the wrapper of the single live video,
    // which lived inside one tile and mounted the scene inside that tile.
    for (const tile of tiles) assert.notEqual(found, tile as unknown as HTMLElement);
});

test("the tile grid falls back to the live pictures when no tile markers exist", () => {
    const document = new FakeDocument();
    const area = el(document.body, "DIV");
    const tile = el(area, "DIV");
    const inner = el(tile, "DIV");
    const live = video(inner, true);

    const found = findTileGrid(document as unknown as Document);

    // Without Discord's markers there is no better signal than the picture's own
    // container; what must never happen is mounting in the <video> or the body.
    assert.notEqual(found, live as unknown as HTMLElement);
    assert.notEqual(found, document.body as unknown as HTMLElement);
    assert.equal(found?.contains(live as unknown as Node), true);
});

test("the control bar is found above per-button wrappers", () => {
    const { document, controls, buttons } = liveCall();
    const found = findCallControls(document);

    assert.equal(found, controls as unknown as HTMLElement);
    // No button's direct parent is the bar: this is why counting one level failed.
    for (const button of buttons) assert.notEqual(button.parentElement, controls);
});

test("the control bar is not the scene's own participant list", () => {
    const document = new FakeDocument();
    const host = el(document.body, "DIV", { "data-sv-host": "" }, { left: 432, top: 32, width: 1488, height: 1048 });
    const scene = el(host, "DIV", { class: "sv-scene" }, { left: 432, top: 32, width: 1488, height: 1048 });
    for (const name of ["PIEP ENJOYER, camera on", "dawg, camera off", "Johnny, camera off"]) {
        el(scene, "DIV", { role: "button", "aria-label": name }, { left: 500, top: 900, width: 120, height: 90 });
    }

    assert.equal(findCallControls(document as unknown as Document), null);
});

test("the call surface holds the grid and the bar, and is never a tile", () => {
    const { document, root, grid, controls, tiles } = liveCall();
    const surface = findCallSurface(document, grid as unknown as Element, controls as unknown as Element);

    assert.equal(surface, root as unknown as HTMLElement);
    assert.equal(surface?.contains(grid as unknown as Node), true);
    assert.equal(surface?.contains(controls as unknown as Node), true);
    for (const tile of tiles) assert.notEqual(surface, tile as unknown as HTMLElement);
});

test("with no control bar the surface still covers the call, not one tile", () => {
    const document = new FakeDocument();
    const area = el(document.body, "DIV", {}, { left: 432, top: 32, width: 1488, height: 1048 });
    const grid = el(area, "DIV", {}, { left: 440, top: 137, width: 1472, height: 846 });
    const tile = el(grid, "DIV", { "data-call-tile": "", "data-selenium-video-tile": "111" }, { left: 440, top: 137, width: 732, height: 412 });
    video(el(tile, "DIV"), true);

    const foundGrid = findTileGrid(document as unknown as Document);
    const surface = findCallSurface(document as unknown as Document, foundGrid, null);

    // The scene must never be mounted inside the element it hides, and never in a
    // tile: the surface is a strict ancestor of the grid.
    assert.notEqual(surface, foundGrid as unknown as HTMLElement);
    assert.equal(surface?.contains(foundGrid as unknown as Node), true);
    assert.notEqual(surface, tile as unknown as HTMLElement);
    assert.equal(area.contains(surface as unknown as Node), true);
});

test("chooseVideo prefers Discord's own tile over a sibling copy of one person", () => {
    const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
    const tile = { element: {} as HTMLVideoElement, stream, score: 5, inTile: true };
    const popout = { element: {} as HTMLVideoElement, stream, score: 5, inTile: false };

    assert.equal(chooseVideo([popout, tile]), tile);
    assert.equal(chooseVideo([]), null);
});

test("lowestCommonAncestor ignores an unrelated element", () => {
    const document = new FakeDocument();
    const a = el(document.body, "DIV");
    const b = el(document.body, "DIV");
    const childA = el(a, "DIV");
    const childB = el(b, "DIV");

    assert.equal(lowestCommonAncestor([childA, childB] as unknown as Element[]), document.body as unknown as Element);
    assert.equal(lowestCommonAncestor([] as unknown as Element[]), null);
});

test("rectOf reports the element's own box", () => {
    const element = el(new FakeDocument().body, "DIV", {}, { left: 10, top: 20, width: 30, height: 40 });

    assert.deepEqual(rectOf(element as unknown as Element), { left: 10, top: 20, width: 30, height: 40 });
});
