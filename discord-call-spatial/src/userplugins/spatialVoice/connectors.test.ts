/**
 * Tests for the connector overlay.
 *
 * Runs with the Node test runner and no dependencies:
 *   node --test src/userplugins/spatialVoice/connectors.test.ts
 *
 * The module is browser-native, so this file carries a small hand-written DOM
 * (rects, classes, attributes, listeners, ResizeObserver, rAF and timers) that
 * records what the module reads and leaves behind. Every geometry expectation
 * below is hand-computed from the rects the test supplies, never compared
 * against the module's own formula.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createConnectorLayer } from "./connectors.ts";
import type { ConnectorLayer, ConnectorOptions, ConnectorParticipant } from "./connectors.ts";

interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

// --------------------------------------------------------------------- DOM

class FakeStyle {
    [key: string]: unknown;
    private readonly properties = new Map<string, string>();

    setProperty(name: string, value: string): void {
        this.properties.set(name, String(value));
    }

    getPropertyValue(name: string): string {
        return this.properties.get(name) ?? "";
    }

    removeProperty(name: string): string {
        const value = this.properties.get(name) ?? "";
        this.properties.delete(name);
        return value;
    }
}

class FakeClassList {
    private readonly values = new Set<string>();

    add(...names: string[]): void {
        for (const name of names) this.values.add(name);
    }

    remove(...names: string[]): void {
        for (const name of names) this.values.delete(name);
    }

    contains(name: string): boolean {
        return this.values.has(name);
    }

    toggle(name: string, force?: boolean): boolean {
        const next = force === undefined ? !this.values.has(name) : force;
        if (next) this.values.add(name);
        else this.values.delete(name);
        return next;
    }

    get value(): string {
        return Array.from(this.values).join(" ");
    }
}

interface FakeListener {
    type: string;
    handler: (event: unknown) => void;
    options: unknown;
}

class FakeElement {
    readonly tagName: string;
    readonly namespaceURI: string | null;
    readonly ownerDocument: FakeDocument;
    parentNode: FakeElement | null = null;
    childNodes: FakeElement[] = [];
    readonly attributes = new Map<string, string>();
    readonly style = new FakeStyle();
    readonly classList = new FakeClassList();
    listeners: FakeListener[] = [];
    rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
    rectReads = 0;
    offsetWidth = 0;
    offsetHeight = 0;
    scrollLeft = 0;
    scrollTop = 0;

    constructor(ownerDocument: FakeDocument, tagName: string, namespaceURI: string | null) {
        this.ownerDocument = ownerDocument;
        this.tagName = tagName;
        this.namespaceURI = namespaceURI;
    }

    get isConnected(): boolean {
        let node: FakeElement | null = this;
        while (node) {
            if (node === this.ownerDocument.rootElement) return true;
            node = node.parentNode;
        }
        return false;
    }

    get firstChild(): FakeElement | null {
        return this.childNodes[0] ?? null;
    }

    get children(): FakeElement[] {
        return this.childNodes.slice();
    }

    appendChild<T extends FakeElement>(child: T): T {
        return this.insertBefore(child, null);
    }

    insertBefore<T extends FakeElement>(child: T, reference: FakeElement | null): T {
        if (child.parentNode) child.parentNode.removeChild(child);
        const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
        if (index < 0) this.childNodes.push(child);
        else this.childNodes.splice(index, 0, child);
        child.parentNode = this;
        return child;
    }

    removeChild<T extends FakeElement>(child: T): T {
        const index = this.childNodes.indexOf(child);
        if (index >= 0) this.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
    }

    remove(): void {
        if (this.parentNode) this.parentNode.removeChild(this);
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, String(value));
    }

    getAttribute(name: string): string | null {
        return this.attributes.has(name) ? (this.attributes.get(name) as string) : null;
    }

    hasAttribute(name: string): boolean {
        return this.attributes.has(name);
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }

    addEventListener(type: string, handler: (event: unknown) => void, options: unknown): void {
        this.listeners.push({ type, handler, options });
    }

    removeEventListener(type: string, handler: (event: unknown) => void): void {
        this.listeners = this.listeners.filter(
            (listener) => !(listener.type === type && listener.handler === handler)
        );
    }

    getBoundingClientRect(): DOMRect {
        this.rectReads += 1;
        const { left, top, width, height } = this.rect;
        return {
            left,
            top,
            width,
            height,
            right: left + width,
            bottom: top + height,
            x: left,
            y: top
        } as DOMRect;
    }
}

class FakeWindow {
    listeners: FakeListener[] = [];
    private readonly frames = new Map<number, (time: number) => void>();
    private readonly timers = new Map<number, () => void>();
    private nextId = 1;

    addEventListener(type: string, handler: (event: unknown) => void, options: unknown): void {
        this.listeners.push({ type, handler, options });
    }

    removeEventListener(type: string, handler: (event: unknown) => void): void {
        this.listeners = this.listeners.filter(
            (listener) => !(listener.type === type && listener.handler === handler)
        );
    }

    requestAnimationFrame(callback: (time: number) => void): number {
        const id = this.nextId++;
        this.frames.set(id, callback);
        return id;
    }

    cancelAnimationFrame(id: number): void {
        this.frames.delete(id);
    }

    setTimeout(callback: () => void, _ms: number): number {
        const id = this.nextId++;
        this.timers.set(id, callback);
        return id;
    }

    clearTimeout(id: number): void {
        this.timers.delete(id);
    }

    pendingFrames(): number {
        return this.frames.size;
    }

    /** Run queued frames, including the ones they queue, up to a hard stop. */
    flushFrames(limit = 500): number {
        let runs = 0;
        while (this.frames.size > 0 && runs < limit) {
            const batch = Array.from(this.frames.entries()).sort((a, b) => a[0] - b[0]);
            this.frames.clear();
            for (const entry of batch) {
                entry[1](0);
                runs += 1;
            }
        }
        return runs;
    }

    runTimers(): void {
        const pending = Array.from(this.timers.values());
        this.timers.clear();
        for (const callback of pending) callback();
    }

    pendingTimers(): number {
        return this.timers.size;
    }
}

class FakeDocument {
    readonly defaultView: FakeWindow;
    readonly rootElement: FakeElement;
    readonly createdTags: string[] = [];

    constructor(view: FakeWindow) {
        this.defaultView = view;
        this.rootElement = new FakeElement(this, "body", null);
    }

    createElement(tagName: string): FakeElement {
        this.createdTags.push(tagName);
        return new FakeElement(this, tagName, null);
    }

    createElementNS(namespaceURI: string, tagName: string): FakeElement {
        this.createdTags.push(tagName);
        return new FakeElement(this, tagName, namespaceURI);
    }
}

class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];

    readonly targets = new Set<unknown>();
    disconnected = false;
    private readonly callback: () => void;

    constructor(callback: () => void) {
        this.callback = callback;
        FakeResizeObserver.instances.push(this);
    }

    observe(target: unknown): void {
        if (this.disconnected) throw new Error("observe() after disconnect()");
        this.targets.add(target);
    }

    unobserve(target: unknown): void {
        this.targets.delete(target);
    }

    disconnect(): void {
        this.disconnected = true;
        this.targets.clear();
    }

    trigger(): void {
        if (!this.disconnected) this.callback();
    }
}

// ----------------------------------------------------------------- harness

interface Harness {
    window: FakeWindow;
    document: FakeDocument;
    scene: FakeElement;
    controls: FakeElement;
    participant(id: string, rect: Rect, extra?: Partial<ConnectorParticipant>): ConnectorParticipant;
    elementOf(participant: ConnectorParticipant): FakeElement;
    overlayOf(layer: ConnectorLayer): FakeElement;
    linesOf(layer: ConnectorLayer): FakeElement[];
    settle(layer: ConnectorLayer): void;
}

function createHarness(): Harness {
    const view = new FakeWindow();
    const doc = new FakeDocument(view);
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    FakeResizeObserver.instances.length = 0;

    const scene = doc.createElement("div");
    doc.rootElement.appendChild(scene);
    scene.rect = { left: 100, top: 40, width: 800, height: 600 };
    scene.offsetWidth = 800;
    scene.offsetHeight = 600;

    const controls = doc.createElement("div");
    scene.appendChild(controls);
    controls.rect = { left: 400, top: 500, width: 200, height: 60 };
    controls.offsetWidth = 200;
    controls.offsetHeight = 60;

    function participant(
        id: string,
        rect: Rect,
        extra: Partial<ConnectorParticipant> = {}
    ): ConnectorParticipant {
        const element = doc.createElement("div");
        scene.appendChild(element);
        element.rect = rect;
        element.offsetWidth = rect.width;
        element.offsetHeight = rect.height;
        return Object.assign(
            { id, element: element as unknown as Element, cameraOn: false, emphasized: false },
            extra
        ) as ConnectorParticipant;
    }

    function elementOf(candidate: ConnectorParticipant): FakeElement {
        return candidate.element as unknown as FakeElement;
    }

    function overlayOf(layer: ConnectorLayer): FakeElement {
        const overlay = layer.element as unknown as FakeElement | null;
        assert.ok(overlay, "the layer must expose its overlay element");
        return overlay as FakeElement;
    }

    function linesOf(layer: ConnectorLayer): FakeElement[] {
        const found: FakeElement[] = [];
        const walk = (node: FakeElement): void => {
            for (const child of node.childNodes) {
                if (child.tagName === "line") found.push(child);
                walk(child);
            }
        };
        const overlay = layer.element as unknown as FakeElement | null;
        if (overlay) walk(overlay);
        return found;
    }

    /** The overlay sits at the scene's box; mirrors a laid-out absolute child. */
    function settle(layer: ConnectorLayer): void {
        const overlay = overlayOf(layer);
        overlay.rect = { ...scene.rect };
        view.flushFrames();
    }

    return { window: view, document: doc, scene, controls, participant, elementOf, overlayOf, linesOf, settle };
}

function layerFor(harness: Harness, options?: ConnectorOptions): ConnectorLayer {
    return createConnectorLayer(
        harness.scene as unknown as Element,
        harness.controls as unknown as Element,
        options
    );
}

function numberAttribute(line: FakeElement, name: string): number {
    const raw = line.getAttribute(name);
    assert.ok(raw !== null, "line is missing the " + name + " attribute");
    const value = Number(raw);
    assert.ok(Number.isFinite(value), name + " must be a finite number, got " + String(raw));
    return value;
}

function closeTo(actual: number, expected: number, tolerance: number, label: string): void {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        label + ": expected " + expected + " +/- " + tolerance + ", got " + actual
    );
}

// ------------------------------------------------------------------- tests

test("the overlay is a decorative, click-through first child of the scene", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    const overlay = harness.overlayOf(layer);

    assert.equal(overlay.tagName, "svg");
    assert.equal(overlay.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(overlay.getAttribute("class"), "sv-connectors");
    assert.equal(overlay.getAttribute("aria-hidden"), "true");
    assert.equal(overlay.getAttribute("focusable"), "false");
    assert.equal(overlay.style.pointerEvents, "none");
    assert.equal(overlay.parentNode, harness.scene);
    assert.equal(harness.scene.firstChild, overlay, "the overlay must paint before every participant");
    assert.equal(harness.scene.style.position, "relative", "the overlay needs a positioned scene");

    const group = overlay.firstChild as unknown as FakeElement;
    assert.equal(group.tagName, "g");
    assert.equal(group.style.pointerEvents, "none");
    assert.equal(group.getAttribute("pointer-events"), "none");
    assert.equal(group.getAttribute("stroke-linecap"), "round");
    assert.match(String(group.style.stroke), /--sv-line-color/);

    layer.dispose();
    assert.equal(harness.scene.style.position, "", "the scene's inline position is restored on dispose");
});

test("lines run from the control bar's top-centre to the participant boundary", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    harness.settle(layer);

    // Tile at viewport (700,100) 120x90 with the overlay at (100,40):
    // overlay-space tile is (600,60)-(720,150), centre (660,105).
    // Control bar at viewport x 400..600, top 500 -> overlay origin (400,460).
    const p = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    layer.setParticipants([p]);
    harness.settle(layer);

    const lines = harness.linesOf(layer);
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.equal(line.tagName, "line", "connectors are straight segments, never paths");
    assert.equal(line.getAttribute("class"), "sv-connector");
    assert.equal(line.getAttribute("data-sv-connector"), "p1");
    assert.equal(line.getAttribute("visibility"), "visible");

    const x1 = numberAttribute(line, "x1");
    const y1 = numberAttribute(line, "y1");
    const x2 = numberAttribute(line, "x2");
    const y2 = numberAttribute(line, "y2");

    closeTo(x1, 400, 0.01, "origin x is the control bar's centre");
    closeTo(y1, 460, 0.01, "origin y is the control bar's top edge");

    // Hand computation: the ray origin (400,460) -> centre (660,105) leaves the
    // tile through its bottom edge y=150 at t=(150-460)/(105-460)=0.87324, so
    // x=400+0.87324*260=627.05. Pulled 2px back along the ray toward the centre:
    // x2=628.23, y2=148.39.
    closeTo(x2, 628.23, 0.05, "terminates just inside the participant's boundary");
    closeTo(y2, 148.39, 0.05, "terminates just inside the participant's boundary");

    // The segment is straight: the tile centre lies on the origin-to-endpoint line.
    const cross = (x2 - x1) * (105 - y1) - (660 - x1) * (y2 - y1);
    const segmentLength = Math.hypot(x2 - x1, y2 - y1);
    closeTo(Math.abs(cross) / segmentLength, 0, 0.02, "the segment lies on the origin-to-centre ray");

    // And it stops before the centre, not at it.
    assert.ok(y2 < 150 && y2 > 105, "the endpoint sits between the tile centre and its edge");
    assert.ok(!harness.document.createdTags.includes("path"), "no curved path element is ever created");
    layer.dispose();
});

test("a circle participant terminates on its radius", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    harness.settle(layer);

    // Overlay-space circle centred at (600,100) with a 40px radius.
    const p = harness.participant(
        "avatar",
        { left: 660, top: 100, width: 80, height: 80 },
        { shape: "circle" }
    );
    layer.setParticipants([p]);
    harness.settle(layer);

    const line = harness.linesOf(layer)[0];
    const x1 = numberAttribute(line, "x1");
    const y1 = numberAttribute(line, "y1");
    const x2 = numberAttribute(line, "x2");
    const y2 = numberAttribute(line, "y2");
    const distanceFromCentre = Math.hypot(x2 - 600, y2 - 100);
    closeTo(distanceFromCentre, 38, 0.05, "the endpoint stops 2px inside the circle's radius");
    const cross = (x2 - x1) * (100 - y1) - (600 - x1) * (y2 - y1);
    closeTo(Math.abs(cross) / Math.hypot(x2 - x1, y2 - y1), 0, 0.02, "the segment still points at the circle's centre");
    layer.dispose();
});

test("scrolling and CSS scale do not move the endpoints", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    harness.settle(layer);
    const p = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    layer.setParticipants([p]);
    harness.settle(layer);
    const baseline = harness.linesOf(layer)[0];
    const baselineCoords = ["x1", "y1", "x2", "y2"].map((name) => numberAttribute(baseline, name));

    // Scroll the scene's content by 40px: every rect in the viewport moves up 40.
    const shift = (element: FakeElement, deltaY: number): void => {
        element.rect = { ...element.rect, top: element.rect.top + deltaY };
    };
    shift(harness.scene, -40);
    shift(harness.overlayOf(layer), -40);
    shift(harness.controls, -40);
    shift(harness.elementOf(p), -40);
    harness.scene.scrollTop = 40;
    layer.refresh();
    harness.window.flushFrames();

    const scrolled = ["x1", "y1", "x2", "y2"].map((name) => numberAttribute(harness.linesOf(layer)[0], name));
    for (let index = 0; index < 4; index += 1) {
        closeTo(scrolled[index], baselineCoords[index], 0.02, "endpoint held through scroll");
    }

    // Now scale the whole scene by 2 (ancestor transform / browser zoom):
    // every viewport rect doubles about the viewport origin while the layout
    // size stays 800x600, so the skeleton must be identical.
    harness.scene.rect = { left: 100, top: 40, width: 1600, height: 1200 };
    harness.overlayOf(layer).rect = { left: 100, top: 40, width: 1600, height: 1200 };
    harness.controls.rect = { left: 700, top: 960, width: 400, height: 120 };
    harness.elementOf(p).rect = { left: 1300, top: 160, width: 240, height: 180 };
    layer.refresh();
    harness.window.flushFrames();

    const scaled = ["x1", "y1", "x2", "y2"].map((name) => numberAttribute(harness.linesOf(layer)[0], name));
    for (let index = 0; index < 4; index += 1) {
        closeTo(scaled[index], baselineCoords[index], 0.02, "endpoint held through a 2x scale");
    }
    layer.dispose();
});

test("only camera-off participants supplied as emphasized brighten their line", () => {
    const harness = createHarness();
    const layer = layerFor(harness, {
        glow: 0,
        opacity: 0.32,
        width: 1.25,
        speakingHighlight: 0.7
    });
    harness.settle(layer);

    const cameraOnSpeaking = harness.participant(
        "video",
        { left: 200, top: 120, width: 200, height: 120 },
        { cameraOn: true, emphasized: true }
    );
    const cameraOffSpeaking = harness.participant(
        "avatar-speaking",
        { left: 640, top: 420, width: 72, height: 72 },
        { cameraOn: false, emphasized: true, shape: "circle" }
    );
    const cameraOffQuiet = harness.participant(
        "avatar-quiet",
        { left: 200, top: 420, width: 72, height: 72 },
        { cameraOn: false, emphasized: false, shape: "circle" }
    );
    layer.setParticipants([cameraOnSpeaking, cameraOffSpeaking, cameraOffQuiet]);
    harness.settle(layer);

    const byId = new Map(harness.linesOf(layer).map((line) => [line.getAttribute("data-sv-connector"), line]));
    const video = byId.get("video") as FakeElement;
    const speaking = byId.get("avatar-speaking") as FakeElement;
    const quiet = byId.get("avatar-quiet") as FakeElement;

    assert.equal(video.classList.contains("sv-connector--speaking"), false, "a video tile is never emphasized");
    assert.equal(video.getAttribute("data-sv-emphasized"), "false");
    closeTo(Number(video.getAttribute("stroke-opacity")), 0.32, 1e-9, "camera-on line keeps base opacity");
    closeTo(Number(video.getAttribute("stroke-width")), 1.25, 1e-9, "camera-on line keeps base width");

    assert.equal(speaking.classList.contains("sv-connector--speaking"), true);
    assert.equal(speaking.getAttribute("data-sv-emphasized"), "true");
    closeTo(Number(speaking.getAttribute("stroke-opacity")), 0.8, 1e-9, "0.32 + 0.7 * (1 - 0.32)");
    closeTo(Number(speaking.getAttribute("stroke-width")), 1.78, 0.01, "1.25 * (1 + 0.6 * 0.7)");
    assert.match(String(speaking.style.getPropertyValue("stroke")), /--sv-line-color/);

    assert.equal(quiet.classList.contains("sv-connector--speaking"), false);
    closeTo(Number(quiet.getAttribute("stroke-opacity")), 0.32, 1e-9, "an unemphasized camera-off line stays dim");

    // Emphasis follows the caller: turning it off restores the base look.
    layer.setParticipants([
        cameraOnSpeaking,
        { ...cameraOffSpeaking, emphasized: false },
        cameraOffQuiet
    ]);
    assert.equal(speaking.classList.contains("sv-connector--speaking"), false);
    assert.equal(speaking.getAttribute("data-sv-emphasized"), "false");
    closeTo(Number(speaking.getAttribute("stroke-opacity")), 0.32, 1e-9, "emphasis removed immediately");
    assert.equal(speaking.style.getPropertyValue("stroke"), "", "the inline highlight colour is removed");
    layer.dispose();
});

test("configure applies visibility, opacity, width, glow and highlight immediately", () => {
    const harness = createHarness();
    const layer = layerFor(harness);
    harness.settle(layer);
    const p = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    layer.setParticipants([p]);
    harness.settle(layer);
    const overlay = harness.overlayOf(layer);
    const group = overlay.firstChild as unknown as FakeElement;
    const line = harness.linesOf(layer)[0];

    layer.configure({ opacity: 0.5, width: 2.5, glow: 0 });
    assert.equal(line.getAttribute("stroke-opacity"), "0.5");
    assert.equal(line.getAttribute("stroke-width"), "2.5");
    assert.equal(group.style.filter, "", "glow 0 removes the drop-shadow entirely");

    layer.configure({ glow: 1 });
    assert.match(String(group.style.filter), /drop-shadow\(0 0 5px/);
    assert.equal(overlay.style.getPropertyValue("--sv-connector-glow"), "5px");

    layer.configure({ visible: false });
    assert.equal(overlay.style.display, "none");
    layer.refresh();
    harness.window.flushFrames();
    assert.equal(line.getAttribute("visibility"), "hidden", "hidden lines are not measured");

    layer.configure({ visible: true });
    layer.refresh();
    harness.window.flushFrames();
    assert.equal(overlay.style.display, "");
    assert.equal(line.getAttribute("visibility"), "visible");

    // Out-of-range values are clamped rather than trusted.
    layer.configure({ opacity: 9, width: 400, glow: -3, speakingHighlight: 4 });
    closeTo(Number(line.getAttribute("stroke-opacity")), 1, 1e-9, "opacity clamped to 1");
    closeTo(Number(line.getAttribute("stroke-width")), 12, 1e-9, "width clamped to 12");
    assert.equal(group.style.filter, "", "a negative glow clamps to 0");
    layer.dispose();
});

test("participants are diffed by id: added, updated and removed cleanly", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    harness.settle(layer);

    const first = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    const second = harness.participant("p2", { left: 200, top: 140, width: 120, height: 90 });
    layer.setParticipants([first, second]);
    harness.settle(layer);
    assert.equal(harness.linesOf(layer).length, 2);

    const observer = FakeResizeObserver.instances[0];
    assert.ok(observer, "a ResizeObserver watches the scene, the controls and each participant");
    assert.equal(observer.targets.size, 4, "scene + controls + two participants");

    // Same id, new element: the line survives, the observation moves.
    const replacement = harness.participant("p1", { left: 720, top: 120, width: 120, height: 90 });
    layer.setParticipants([replacement, second]);
    harness.settle(layer);
    assert.equal(harness.linesOf(layer).length, 2);
    assert.equal(observer.targets.has(harness.elementOf(replacement)), true);
    assert.equal(observer.targets.has(harness.elementOf(first)), false, "the old element is unobserved");

    // Duplicate ids in one call are ignored rather than duplicated.
    layer.setParticipants([replacement, replacement, second]);
    assert.equal(harness.linesOf(layer).length, 2);

    // Removal drops the line and its observation.
    layer.setParticipants([second]);
    harness.settle(layer);
    assert.equal(harness.linesOf(layer).length, 1);
    assert.equal(observer.targets.has(harness.elementOf(replacement)), false);
    assert.equal(harness.linesOf(layer)[0].getAttribute("data-sv-connector"), "p2");

    // Garbage entries are skipped without throwing.
    layer.setParticipants([null as unknown as ConnectorParticipant, second]);
    assert.equal(harness.linesOf(layer).length, 1);
    layer.dispose();
});

test("hidden scenes, detached participants and short arrows are handled safely", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    harness.settle(layer);

    const visible = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    const detached = harness.participant("p2", { left: 300, top: 200, width: 80, height: 80 });
    (harness.elementOf(detached).parentNode as FakeElement).removeChild(harness.elementOf(detached));
    layer.setParticipants([visible, detached]);
    harness.settle(layer);

    const byId = new Map(harness.linesOf(layer).map((line) => [line.getAttribute("data-sv-connector"), line]));
    assert.equal((byId.get("p1") as FakeElement).getAttribute("visibility"), "visible");
    assert.equal((byId.get("p2") as FakeElement).getAttribute("visibility"), "hidden", "detached elements are skipped");

    // A scene with no layout size (display:none) hides every line instead of
    // emitting NaN coordinates or throwing.
    harness.scene.offsetWidth = 0;
    harness.scene.offsetHeight = 0;
    harness.scene.rect = { left: 0, top: 0, width: 0, height: 0 };
    layer.refresh();
    harness.window.flushFrames();
    for (const line of harness.linesOf(layer)) {
        assert.equal(line.getAttribute("visibility"), "hidden");
    }

    harness.scene.offsetWidth = 800;
    harness.scene.offsetHeight = 600;
    harness.scene.rect = { left: 100, top: 40, width: 800, height: 600 };
    layer.refresh();
    harness.window.flushFrames();
    const recovered = harness.linesOf(layer).find((line) => line.getAttribute("data-sv-connector") === "p1");
    assert.equal(recovered?.getAttribute("visibility"), "visible", "geometry recovers when the scene reappears");

    // A participant sitting under the control bar has no room for a segment.
    const overlapping = harness.participant("p3", { left: 420, top: 470, width: 160, height: 100 });
    layer.setParticipants([visible, overlapping]);
    harness.settle(layer);
    const p3 = harness.linesOf(layer).find((line) => line.getAttribute("data-sv-connector") === "p3");
    assert.equal(p3?.getAttribute("visibility"), "hidden");
    layer.dispose();
});

test("measurement is coalesced into one frame per tick", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    const p = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    layer.setParticipants([p]);
    harness.settle(layer);
    const element = harness.elementOf(p);

    // Nothing is measured synchronously: the work waits for the frame.
    const beforeTick = element.rectReads;
    layer.refresh();
    layer.refresh();
    layer.refresh();
    assert.equal(element.rectReads, beforeTick, "refresh() must not measure on the calling stack");
    harness.window.flushFrames();
    const oneTick = element.rectReads - beforeTick;

    // The same three calls in a later tick produce exactly the same work as one.
    const beforeSecond = element.rectReads;
    layer.refresh();
    harness.window.flushFrames();
    const singleRefresh = element.rectReads - beforeSecond;
    assert.ok(oneTick > 0, "a tick does measure");
    assert.equal(oneTick, singleRefresh, "three refreshes in one tick coalesce into one measurement pass");

    // Observer notifications coalesce the same way: three callbacks in one tick
    // schedule one measurement, not three.
    const observer = FakeResizeObserver.instances[0];
    const beforeObserver = element.rectReads;
    observer.trigger();
    observer.trigger();
    observer.trigger();
    assert.equal(element.rectReads, beforeObserver, "observer callbacks do not measure on the calling stack");
    harness.window.flushFrames();
    assert.equal(element.rectReads - beforeObserver, 1, "three observer callbacks share one measurement pass");
    layer.dispose();
});

test("transition tracking is bounded, not a permanent frame loop", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    const p = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    layer.setParticipants([p]);
    harness.settle(layer);
    const element = harness.elementOf(p);

    const before = element.rectReads;
    // A transition on a descendant starts a burst of bounded follow-up frames.
    const transition = harness.scene.listeners.find((listener) => listener.type === "transitionrun");
    assert.ok(transition, "a delegated transition listener is installed");
    (transition as { handler: (event: unknown) => void }).handler({});
    const frames = harness.window.flushFrames();
    const passes = element.rectReads - before;

    assert.ok(passes >= 1, "the burst measures while the transition runs");
    assert.ok(passes <= 24, "the burst stops after at most 24 frames, got " + passes);
    assert.ok(frames <= 48, "the frame queue drains, got " + frames);
    assert.equal(harness.window.pendingFrames(), 0, "no frame is left queued");

    // Once the burst window elapses nothing measures again on its own.
    harness.window.runTimers();
    const settled = element.rectReads;
    assert.equal(harness.window.flushFrames(), 0);
    assert.equal(element.rectReads, settled, "measurement is idle after the burst window");
    layer.dispose();
});

test("dispose removes the overlay, listeners, observers and pending work", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    const p = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    layer.setParticipants([p]);
    harness.settle(layer);

    const overlay = harness.overlayOf(layer);
    const element = harness.elementOf(p);
    const observer = FakeResizeObserver.instances[0];
    assert.equal(harness.window.listeners.length, 2, "window resize + scroll are the only window listeners");
    assert.equal(harness.scene.listeners.length, 4, "3 transition types + scroll on the scene");

    // A frame is in flight when disposal happens.
    layer.refresh();
    assert.ok(harness.window.pendingFrames() > 0);
    const readsBeforeDispose = element.rectReads;

    layer.dispose();

    assert.equal(overlay.parentNode, null, "the overlay leaves the scene");
    assert.equal(harness.window.listeners.length, 0, "window listeners are removed");
    assert.equal(harness.scene.listeners.length, 0, "scene listeners are removed");
    assert.equal(observer.disconnected, true, "the ResizeObserver is disconnected");
    assert.equal(observer.targets.size, 0, "every observed element is unobserved");
    assert.equal(harness.window.pendingFrames(), 0, "pending frames are cancelled");
    assert.equal(harness.window.pendingTimers(), 0, "the burst timer is cleared");
    assert.equal(harness.window.flushFrames(), 0, "no frame runs after disposal");
    assert.equal(element.rectReads, readsBeforeDispose, "nothing measures after disposal");

    // Repeated disposal, and calls after disposal, are safe no-ops.
    layer.dispose();
    layer.setParticipants([p]);
    layer.configure({ opacity: 0.9 });
    layer.refresh();
    assert.equal(harness.window.flushFrames(), 0);
    assert.equal(harness.linesOf(layer).length, 0, "participants cannot resurrect a disposed layer");
});

test("the control bar and the participant elements are only ever measured", () => {
    const harness = createHarness();
    const controlsAttributes = Array.from(harness.controls.attributes.entries());
    const controlsListeners = harness.controls.listeners.length;
    const controlsStyleKeys = Object.keys(harness.controls.style);

    const layer = layerFor(harness, { glow: 0 });
    const p = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    layer.setParticipants([p]);
    harness.settle(layer);
    layer.refresh();
    harness.window.flushFrames();

    assert.deepEqual(Array.from(harness.controls.attributes.entries()), controlsAttributes, "no attribute is written on the bar");
    assert.equal(harness.controls.listeners.length, controlsListeners, "no listener is attached to the bar");
    assert.deepEqual(Object.keys(harness.controls.style), controlsStyleKeys, "no inline style is written on the bar");
    assert.equal(harness.elementOf(p).listeners.length, 0, "participant elements get no listeners");
    assert.equal(harness.elementOf(p).attributes.size, 0, "no attribute is written on the participant");
    layer.dispose();
});

test("a layer without a scene is inert instead of throwing", () => {
    const layer = createConnectorLayer(null, null);
    assert.equal(layer.element, null);
    layer.setParticipants([]);
    layer.configure({ visible: true });
    layer.refresh();
    layer.dispose();
    layer.dispose();
});

// --------------------------------------------------- visible anchors and scale

function anchorElement(harness: Harness, rect: Rect): FakeElement {
    const element = harness.document.createElement("img");
    harness.scene.appendChild(element);
    element.rect = rect;
    element.offsetWidth = rect.width;
    element.offsetHeight = rect.height;
    return element;
}

test("a scaled avatar anchor is measured where the avatar is drawn", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    harness.settle(layer);

    // Host circle, 72px across, centred at viewport (676,456) = overlay (576,416).
    const host = harness.participant("avatar", { left: 640, top: 420, width: 72, height: 72 }, { shape: "circle" });
    // The speaking enlargement is a CSS transform on the image: 1.4x about the
    // same centre, so the image renders 100.8px across at (625.6,405.6).
    const image = anchorElement(harness, { left: 625.6, top: 405.6, width: 100.8, height: 100.8 });
    layer.setParticipants([{ ...host, anchor: image as unknown as Element }]);
    harness.settle(layer);

    const observer = FakeResizeObserver.instances[0];
    assert.equal(observer.targets.has(image), true, "the visible anchor is observed too");

    const line = harness.linesOf(layer)[0];
    const x2 = numberAttribute(line, "x2");
    const y2 = numberAttribute(line, "y2");

    // Hand computation: origin (400,460), centre (576,416), distance 181.4166,
    // unit (-0.970139, 0.242547), endpoint 50.4 - 2 = 48.4 from the centre:
    // x2 = 576 - 46.9547 = 529.045, y2 = 416 + 11.7393 = 427.739.
    closeTo(x2, 529.05, 0.05, "the endpoint follows the enlarged avatar image");
    closeTo(y2, 427.74, 0.05, "the endpoint follows the enlarged avatar image");
    const fromCentre = Math.hypot(x2 - 576, y2 - 416);
    closeTo(fromCentre, 48.4, 0.05, "terminates 2px inside the enlarged radius");
    assert.ok(fromCentre > 40, "a nominal 36px radius would end 34px out, inside the avatar");

    // Shrinking back is the same measurement with a smaller rect: the endpoint
    // returns to the nominal radius without any new participant list.
    image.rect = { left: 640, top: 420, width: 72, height: 72 };
    layer.refresh();
    harness.window.flushFrames();
    const shrunk = harness.linesOf(layer)[0];
    closeTo(
        Math.hypot(numberAttribute(shrunk, "x2") - 576, numberAttribute(shrunk, "y2") - 416),
        34,
        0.05,
        "the endpoint returns to the nominal radius when the avatar shrinks"
    );

    layer.dispose();
    assert.equal(observer.targets.size, 0, "the anchor is unobserved on dispose");
});

test("an anchor that is replaced, detached or absent falls back safely", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    harness.settle(layer);

    const host = harness.participant("avatar", { left: 640, top: 420, width: 72, height: 72 }, { shape: "circle" });
    const first = anchorElement(harness, { left: 625.6, top: 405.6, width: 100.8, height: 100.8 });
    layer.setParticipants([{ ...host, anchor: first as unknown as Element }]);
    harness.settle(layer);

    const observer = FakeResizeObserver.instances[0];
    const second = anchorElement(harness, { left: 611.2, top: 391.2, width: 129.6, height: 129.6 });
    layer.setParticipants([{ ...host, anchor: second as unknown as Element }]);
    harness.settle(layer);
    assert.equal(observer.targets.has(second), true, "the new anchor is observed");
    assert.equal(observer.targets.has(first), false, "the old anchor is unobserved");
    closeTo(
        Math.hypot(numberAttribute(harness.linesOf(layer)[0], "x2") - 576, numberAttribute(harness.linesOf(layer)[0], "y2") - 416),
        62.8,
        0.05,
        "a 1.8x avatar anchors on its rendered radius"
    );

    // The anchor leaves the DOM (a remount, a camera-on swap): the line falls
    // back to the host rather than disappearing or reading a stale rect.
    (second.parentNode as FakeElement).removeChild(second);
    layer.refresh();
    harness.window.flushFrames();
    const fallback = harness.linesOf(layer)[0];
    assert.equal(fallback.getAttribute("visibility"), "visible");
    closeTo(
        Math.hypot(numberAttribute(fallback, "x2") - 576, numberAttribute(fallback, "y2") - 416),
        34,
        0.05,
        "a detached anchor falls back to the host's radius"
    );
    layer.dispose();
});

test("a participant the caller marks hidden keeps its line but draws nothing", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 0 });
    harness.settle(layer);

    const p = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    layer.setParticipants([{ ...p, visible: false }]);
    harness.settle(layer);
    const line = harness.linesOf(layer)[0];
    assert.equal(line.getAttribute("visibility"), "hidden", "an off-page participant draws no segment");
    assert.equal(harness.linesOf(layer).length, 1, "the line survives for the participant's return");

    layer.setParticipants([{ ...p, visible: true }]);
    harness.settle(layer);
    assert.equal(line.getAttribute("visibility"), "visible");
    closeTo(numberAttribute(line, "x1"), 400, 0.01, "origin unchanged");
    layer.dispose();
});

test("setControls binds the real bar after mount and unbinds cleanly", () => {
    const harness = createHarness();
    const layer = createConnectorLayer(
        harness.scene as unknown as Element,
        null,
        { glow: 0 }
    );
    const p = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    layer.setParticipants([p]);
    harness.settle(layer);
    const line = harness.linesOf(layer)[0];

    // No bar yet: the origin is the scene's bottom centre.
    closeTo(numberAttribute(line, "x1"), 400, 0.01, "fallback origin x");
    closeTo(numberAttribute(line, "y1"), 600, 0.01, "fallback origin y");

    const observer = FakeResizeObserver.instances[0];
    layer.setControls(harness.controls as unknown as Element);
    harness.window.flushFrames();
    closeTo(numberAttribute(line, "x1"), 400, 0.01, "origin is the bar's centre once bound");
    closeTo(numberAttribute(line, "y1"), 460, 0.01, "origin is the bar's top edge once bound");
    assert.equal(observer.targets.has(harness.controls), true, "the bar is observed once bound");

    layer.setControls(null);
    harness.window.flushFrames();
    closeTo(numberAttribute(line, "y1"), 600, 0.01, "detaching the bar restores the fallback origin");
    assert.equal(observer.targets.has(harness.controls), false, "the bar is unobserved when detached");

    layer.setControls(harness.controls as unknown as Element);
    layer.dispose();
    assert.equal(observer.disconnected, true);
    assert.equal(observer.targets.size, 0, "nothing stays observed after dispose");
});

test("the viewBox and scale come from the overlay's own box, not the scene's", () => {
    const harness = createHarness();
    // A 4px border puts the scene's border box outside the overlay's box.
    harness.scene.rect = { left: 100, top: 40, width: 808, height: 608 };
    harness.scene.offsetWidth = 808;
    harness.scene.offsetHeight = 608;

    const layer = layerFor(harness, { glow: 0 });
    const overlay = harness.overlayOf(layer);
    overlay.rect = { left: 104, top: 44, width: 800, height: 600 };
    overlay.offsetWidth = 800;
    overlay.offsetHeight = 600;
    const p = harness.participant("p1", { left: 700, top: 100, width: 120, height: 90 });
    layer.setParticipants([p]);
    harness.window.flushFrames();

    assert.equal(overlay.getAttribute("viewBox"), "0 0 800 600", "the viewBox is the overlay's layout box");
    assert.equal(overlay.getAttribute("width"), "800");
    assert.equal(overlay.getAttribute("height"), "600");
    const line = harness.linesOf(layer)[0];
    closeTo(numberAttribute(line, "x1"), 396, 0.01, "bar centre minus the overlay's left edge");
    closeTo(numberAttribute(line, "y1"), 456, 0.01, "bar top minus the overlay's top edge");

    // A 2x ancestor zoom scales the overlay's rect while its layout box stays
    // 800x600: coordinates halve, which renders in the same place.
    overlay.rect = { left: 104, top: 44, width: 1600, height: 1200 };
    harness.controls.rect = { left: 700, top: 960, width: 400, height: 120 };
    layer.refresh();
    harness.window.flushFrames();
    closeTo(numberAttribute(line, "x1"), 398, 0.01, "(700 + 400 / 2 - 104) / 2: origin halves under a 2x overlay scale");
    closeTo(numberAttribute(line, "y1"), 458, 0.01, "(960 - 44) / 2");
    layer.dispose();
});

test("the emphasized line uses the theme's highlight variables", () => {
    const harness = createHarness();
    const layer = layerFor(harness, { glow: 1 });
    harness.settle(layer);
    const p = harness.participant(
        "speaker",
        { left: 640, top: 420, width: 72, height: 72 },
        { cameraOn: false, emphasized: true, shape: "circle" }
    );
    layer.setParticipants([p]);
    harness.settle(layer);

    const line = harness.linesOf(layer)[0];
    const stroke = String(line.style.getPropertyValue("stroke"));
    assert.match(stroke, /--sv-line-highlight/, "the inline highlight resolves to the theme's highlight colour");
    assert.match(stroke, /--sv-line-color/, "and still falls back to the theme's line colour");
    const group = harness.overlayOf(layer).firstChild as unknown as FakeElement;
    assert.match(String(group.style.filter), /--sv-line-glow/, "the glow uses the theme's glow colour");
    layer.dispose();
});
