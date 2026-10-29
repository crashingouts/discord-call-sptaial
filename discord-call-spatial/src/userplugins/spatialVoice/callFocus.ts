/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Spatial Voice — call view and the fullscreen toggle.
 *
 * This module answers two questions and does nothing else:
 *
 *   1. is Discord's real call view on screen, and where is it?
 *   2. one small chevron in the call's top-left corner that turns Discord's own
 *      call fullscreen on and off.
 *
 * It writes no layout of its own. The earlier version collapsed the app shell's
 * grid columns, hid the server and channel list and hid chat and member panels
 * to imitate a fullscreen call, which fought Discord's own layout and, when the
 * call view was not on screen at all, painted the scene over the Friends page
 * (measured in a live client on 2026-10-29: the scene mounted into
 * `notAppAsidePanel`, the whole application area, while the user was reading
 * Friends). Discord already has this exact view, so the chevron presses Discord's
 * own control and the layout is Discord's.
 *
 * What a live client was measured to render (Discord Canary 1.15.12,
 * Vencord 1.15.12, 2026-10-29, read over the DevTools protocol):
 *
 *   - a person's tile is `[data-call-tile]`; a real call view of nine people
 *     rendered nine of them, and the Friends page with a call joined rendered
 *     none. This is the rule that keeps the scene out of the Friends page.
 *   - the call's own fullscreen control is a `<button>` inside the call
 *     container whose accessible label is `Full Screen` / `Exit Full Screen`.
 *     Pressing it was measured to do all of the following by itself: the app
 *     grid's computed columns became `[start] 0px [guildsEnd] 0px
 *     [channelsEnd] 1920px [end]`, the call container grew from 432..1920 to
 *     0..1920, and the call wrapper and container both gained a `fullScreen`
 *     class. Nothing needs to be imitated, and nothing of Discord's is written.
 *   - while the call is fullscreen the call container's class list carries
 *     `fullScreen_<hash>`, and in the normal view it does not. That class is
 *     the state this module reports, so the chevron follows a state change made
 *     by Discord itself (its own control, Escape, a window change).
 *   - the server list's own items carry `data-list-item-id="guildsnav___…"`.
 *     A candidate surface that contains one of those is the application shell,
 *     not a call view, which is the second rule that keeps the scene out of
 *     Discord's other pages.
 *
 * The chevron's contract with the stylesheet: the authored path always points
 * right, and `[data-sv-focused="false"]` reverses it in CSS. `data-sv-focused`
 * is `"true"` only while the call is expanded, so the module never writes two
 * different paths and the drawing stays one glyph with one CSS rule.
 *
 * Why `.ts` and not `.tsx`: this module is plain DOM (no JSX, no React), and
 * Node's test runner refuses a `.tsx` extension outright
 * (`ERR_UNKNOWN_FILE_EXTENSION`), which would have left the behaviour untested.
 */

import type { ViewportRect } from "./runtimeDom";

/** The class the visual layer styles. */
export const FOCUS_TOGGLE_CLASS = "sv-call-focus-toggle";

/** A marker on the button, so discovery can never mistake it for a panel. */
export const FOCUS_TOGGLE_ATTRIBUTE = "data-sv-call-focus-toggle";

/** `"true"` while Discord's call fullscreen is on, `"false"` while it is not. */
export const FOCUS_ATTRIBUTE = "data-sv-focused";

/** What the button says it will do, which is what it does. */
export const LABEL_EXPAND = "Fullscreen the call";
export const LABEL_RESTORE = "Show the rest of Discord";

/** The authored chevron: it points right, and CSS reverses it when collapsed. */
export const CHEVRON_PATH = "M9.5 5.5 16 12l-6.5 6.5";

/** Discord's own marker on a call tile. */
export const CALL_TILE_ATTRIBUTE = "data-call-tile";

/** The prefix Discord puts on its server-list items. */
export const GUILD_NAV_PREFIX = "guildsnav";

/** The class token Discord puts on the call while its fullscreen is on. */
export const FULLSCREEN_CLASS_MARKER = "fullScreen";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** A tile grid smaller than this share of the window is a mini player, not the call view. */
const MIN_TILE_GRID_RATIO = 0.3;

/** How many ancestors above the tiles the call view can sit. */
const SURFACE_SEARCH_DEPTH = 12;

/** Discord's accessible labels for its own fullscreen control, in this build's language. */
const FULLSCREEN_LABEL = /full\s*-?\s*screen/i;

/** The square the chevron occupies, in CSS pixels. */
export const TOGGLE_SIZE = 32;

/** The corner inset the chevron sits at when nothing of Discord's is there. */
export const TOGGLE_INSET = 12;

/** The gap the chevron keeps from a native control it has to step below. */
export const TOGGLE_CLEARANCE = 8;

/** The prefix on every class this plugin writes, which is how a hit tells ours apart. */
export const PLUGIN_CLASS_PREFIX = "sv-";

/** The attribute carrying the measured slot, as `left,top` in the call view's own pixels. */
export const SLOT_ATTRIBUTE = "data-sv-slot";

/** How many native controls the chevron may step down past. */
const SLOT_STEPS = 3;

/** The points sampled inside the chevron's own box: four inset corners and the centre. */
const SLOT_SAMPLES: readonly (readonly [number, number])[] = [
    [2, 2],
    [TOGGLE_SIZE - 2, 2],
    [2, TOGGLE_SIZE - 2],
    [TOGGLE_SIZE - 2, TOGGLE_SIZE - 2],
    [TOGGLE_SIZE / 2, TOGGLE_SIZE / 2]
];

/** Elements that exist for a person to press or read: what the chevron must never sit on. */
const OCCUPANT_TAGS = new Set([
    "A", "BUTTON", "H1", "H2", "H3", "H4", "H5", "H6", "INPUT", "LABEL", "SELECT", "SUMMARY", "TEXTAREA"
]);

/** The same, by ARIA role, for the controls Discord builds out of divs. */
const OCCUPANT_ROLES = new Set([
    "button", "checkbox", "heading", "link", "menuitem", "radio", "slider", "switch", "tab", "textbox"
]);

/** The subset of the computed style this module reads, so tests can supply it. */
export interface FocusStyle {
    position?: string;
    pointerEvents?: string;
    zIndex?: string;
    left?: string;
    top?: string;
}

/** Everything the controller needs from the document, injectable for tests. */
export interface CallFocusEnvironment {
    doc: Document;
    styleOf(element: Element): FocusStyle;
    rectOf(element: Element): ViewportRect;
    viewport(): { width: number; height: number };
    /**
     * What paints at a point, topmost first: the clearance test. A browser
     * supplies `elementsFromPoint`; a host without one leaves the chevron at its
     * corner inset, which is the placement this module shipped with.
     */
    stackAt?(x: number, y: number): readonly Element[];
}

/** Where the chevron sits, in the call view's own coordinate space. */
export interface ToggleSlot {
    left: number;
    top: number;
}

/** The elements the adapter found for one look, so discovery rules stay here. */
export interface CallViewLookup {
    /** Every `[data-call-tile]` in the document. */
    tiles: readonly Element[];
    /** Every button in the document, so the fullscreen control can be found by label. */
    buttons: readonly Element[];
    /** The call-control bar, as the adapter found it, when it found one. */
    controls?: Element | null;
    /** Every `[data-list-item-id^="guildsnav"]`: the server list, i.e. the app shell's mark. */
    guildNavs?: readonly Element[];
}

/** A real call view: Discord's own element, its tiles, its fullscreen state. */
export interface CallView {
    /** The call view itself: holds the tiles and Discord's fullscreen control. */
    surface: HTMLElement;
    /** The lowest element holding every call tile. */
    grid: HTMLElement;
    /** The call-control bar when it sits inside the surface. */
    controls: HTMLElement | null;
    /** Discord's own fullscreen control, the button this module presses. */
    fullscreen: HTMLElement | null;
    /** Whether Discord's call fullscreen is on right now. */
    expanded: boolean;
}

/** What the adapter tells the controller, once per look. */
export interface CallFocusInput {
    /** The voice channel the call runs in, or null when there is no call. */
    channelId: string | null;
    /** The call view, as {@link findCallView} resolved it. */
    view: CallView | null;
}

export interface CallFocusState {
    channelId: string | null;
    /** True while Discord's call fullscreen is on. */
    expanded: boolean;
    /** True while the chevron is in the document. */
    mounted: boolean;
    /** What the chevron says it will do. */
    label: string;
    /** The button's own `data-sv-focused` value. */
    focused: "true" | "false" | null;
}

/* --------------------------------------------------------------- discovery */

function parentOf(element: Element): HTMLElement | null {
    const parent = element.parentElement;

    return parent as HTMLElement | null;
}

/** The lowest element that contains every given element, or null. */
function lowestCommonAncestor(elements: readonly Element[]): HTMLElement | null {
    const first = elements[0];
    if (!first) return null;

    let candidate: Element | null = first;
    while (candidate) {
        if (elements.every(element => candidate!.contains(element))) return candidate as HTMLElement;
        candidate = candidate.parentElement;
    }

    return null;
}

/** A class token that names Discord's fullscreen state, hash or no hash. */
export function hasFullScreenClass(className: string): boolean {
    return className
        .split(/\s+/)
        .some(token => token === FULLSCREEN_CLASS_MARKER || token.startsWith(`${FULLSCREEN_CLASS_MARKER}_`));
}

/** The accessible label Discord put on an element, which is how its own control is named. */
function labelOf(element: Element): string {
    return element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "";
}

/** Whether an element is Discord's own call fullscreen control. */
export function isFullScreenControl(element: Element): boolean {
    if (element.hasAttribute?.(FOCUS_TOGGLE_ATTRIBUTE)) return false;

    return FULLSCREEN_LABEL.test(labelOf(element));
}

function containsGuildNav(surface: Element, guildNavs: readonly Element[]): boolean {
    return guildNavs.some(nav => surface === nav || surface.contains(nav));
}

/**
 * Whether Discord's call fullscreen is on, read from the class Discord puts on
 * the call itself.
 *
 * The walk starts at the tiles and goes up past the surface: in a live client
 * the class lands on the call container and on the call wrapper, and the surface
 * this module mounts in (the call root, `root_…`) sits *below* both, so stopping
 * at the surface reported "not fullscreen" while Discord's own control already
 * read `Exit Full Screen`. Measured live on 2026-10-29.
 */
function readExpanded(grid: Element): boolean {
    for (let node: Element | null = grid; node; node = node.parentElement) {
        if (hasFullScreenClass(String(node.className ?? ""))) return true;
    }

    return false;
}

/**
 * The call view, or null when the real call view is not on screen.
 *
 * null is the answer for the Friends page, a text channel, a mini player and a
 * PiP window: none of them is where Discord renders a call, and mounting there
 * is exactly the defect this rule exists to prevent.
 */
export function findCallView(env: CallFocusEnvironment, lookup: CallViewLookup): CallView | null {
    const tiles = lookup.tiles.filter(tile => tile.isConnected !== false);
    if (tiles.length === 0) return null;

    const grid = lowestCommonAncestor(tiles);
    if (!grid || grid === env.doc.body || grid === env.doc.documentElement) return null;

    // A mini player or a popout renders tiles too, but in a small box. The call
    // view is the largest thing in its column.
    const viewport = env.viewport();
    const gridRect = env.rectOf(grid);
    if (viewport.width > 0 && gridRect.width < viewport.width * MIN_TILE_GRID_RATIO) return null;
    if (viewport.height > 0 && gridRect.height < viewport.height * MIN_TILE_GRID_RATIO) return null;

    // The call view is the nearest ancestor of the tiles that also holds
    // Discord's own fullscreen control: only the real call view renders one.
    let surface: HTMLElement | null = grid;
    let fullscreen: HTMLElement | null = null;

    for (let depth = 0; surface && depth < SURFACE_SEARCH_DEPTH; depth++, surface = parentOf(surface)) {
        const found = lookup.buttons.find(button => isFullScreenControl(button) && surface!.contains(button));
        if (found) {
            fullscreen = found as HTMLElement;
            break;
        }
    }

    if (!surface || !fullscreen) return null;

    // The application shell contains the server list; a call view never does.
    if (containsGuildNav(surface, lookup.guildNavs ?? [])) return null;

    const controls = lookup.controls && surface.contains(lookup.controls) ? (lookup.controls as HTMLElement) : null;

    return {
        surface,
        grid,
        controls,
        fullscreen,
        expanded: readExpanded(grid)
    };
}

/** The label for a state, which is what `aria-pressed` reports. */
export function toggleLabel(expanded: boolean): string {
    return expanded ? LABEL_RESTORE : LABEL_EXPAND;
}

/* ------------------------------------------------------------- environment */

/** Measures an element's box; the adapter passes runtimeDom's own rule. */
export type ElementMeasure = (element: Element) => ViewportRect;

/**
 * The live environment: computed styles from the client's window, boxes from the
 * caller's measure. The measure is handed in rather than imported so this module
 * has no runtime import, which is what lets the project's Node test runner load
 * it with no build step (an extensionless import it cannot resolve, and a `.ts`
 * one the repo's tsconfig rejects, would both have left the behaviour tested
 * only by hand).
 */
export function createCallFocusEnvironment(measure: ElementMeasure, doc: Document = document): CallFocusEnvironment {
    const view = doc.defaultView;

    return {
        doc,
        styleOf: element => {
            const style = view ? view.getComputedStyle(element) : (element as HTMLElement).style;

            return {
                position: style.position,
                pointerEvents: style.pointerEvents,
                zIndex: style.zIndex,
                left: style.left,
                top: style.top
            };
        },
        rectOf: measure,
        viewport: () => ({
            width: view?.innerWidth ?? 0,
            height: view?.innerHeight ?? 0
        })
    };
}

/* ------------------------------------------------------------- the controller */

/**
 * Owns the chevron for one client.
 *
 * `sync` is called by the adapter on every look at the document, which happens
 * on a mutation, a resize, a channel change and a voice-state update. It is
 * idempotent, and it writes nothing of Discord's except the one inline
 * `position` the button needs when the call view does not already establish a
 * containing block.
 *
 * The controller never decides what fullscreen means: it presses Discord's own
 * control and reports the class Discord puts on the call, so a state change made
 * by Discord (its control, Escape, a window change) is what the chevron shows.
 */
export class CallFocusController {
    private readonly env: CallFocusEnvironment;

    private channelId: string | null = null;
    private view: CallView | null = null;
    private expanded = false;
    /** True when this controller's own press is what turned fullscreen on. */
    private expandedByUs = false;
    /**
     * Looks still allowed to disagree with the press this module made. Discord
     * re-renders a frame or two after its own control is pressed, and the adapter
     * looks on every mutation, so the first look after a press can still read the
     * state before it. Eight looks keeps the chevron steady through that gap
     * without ever ignoring Discord for long.
     */
    private pendingLooks = 0;
    private disposed = false;

    private button: HTMLButtonElement | null = null;
    private buttonHost: HTMLElement | null = null;
    private chevron: SVGPathElement | null = null;
    /** The call view's own inline position, when this module had to write one. */
    private surfacePosition: { element: HTMLElement; had: boolean; value: string } | null = null;

    private readonly onToggleClick = (event: Event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        this.toggleFullScreen();
    };

    constructor(environment: CallFocusEnvironment) {
        this.env = environment;
    }

    get state(): CallFocusState {
        const { button } = this;

        return {
            channelId: this.channelId,
            expanded: this.expanded,
            mounted: button !== null && button.parentElement !== null,
            label: button?.getAttribute("aria-label") ?? "",
            focused: (button?.getAttribute(FOCUS_ATTRIBUTE) as "true" | "false" | null) ?? null
        };
    }

    /** Looks at the client again. Safe to call on every frame. */
    sync(input: CallFocusInput): CallFocusState {
        if (this.disposed) return this.state;

        const { channelId, view } = input;

        if (channelId !== this.channelId) {
            // A different call: the previous one's expansion belonged to it.
            this.channelId = channelId;
            this.expandedByUs = false;
            this.pendingLooks = 0;
        }

        const previous = this.view;

        // The call view went away while this module had expanded it: give Discord
        // its normal layout back through Discord's own control, so no fullscreen
        // outlives the view that owned it. A fullscreen the user turned on with
        // Discord's own control is theirs and is left alone.
        if (!view) {
            const control = previous?.fullscreen;
            if (this.expandedByUs && this.expanded && control?.isConnected !== false) {
                control?.click?.();
            }

            this.view = null;
            this.expanded = false;
            this.expandedByUs = false;
            this.pendingLooks = 0;
            this.removeButton();
            this.restoreSurfacePosition();

            return this.state;
        }

        this.view = view;

        // Discord's own class is the truth, with one exception: the look that
        // lands between this module's press and Discord's re-render still reads
        // the state before it. A few looks are allowed to disagree so the
        // chevron does not flicker; after that Discord wins.
        if (view.expanded === this.expanded) {
            this.pendingLooks = 0;
            this.expandedByUs = this.expandedByUs && view.expanded;
        } else if (this.pendingLooks > 0) {
            this.pendingLooks--;
        } else {
            this.expanded = view.expanded;
            this.expandedByUs = this.expandedByUs && view.expanded;
        }

        this.mountButton(view);
        this.paintButton();

        return this.state;
    }

    /** Turns the call fullscreen on, through Discord's own control. */
    expand(): void {
        if (!this.expanded) this.toggleFullScreen();
    }

    /** Returns Discord's normal view, through Discord's own control. */
    collapse(): void {
        if (this.expanded) this.toggleFullScreen();
    }

    /** What the chevron does. */
    toggleFullScreen(): void {
        if (this.disposed) return;

        const control = this.view?.fullscreen;
        if (!control) return;

        // Discord's own action: the same press a person makes on its control.
        control.click?.();

        this.expanded = !this.expanded;
        this.expandedByUs = this.expanded;
        // Discord re-renders a frame or two after its own control is pressed.
        this.pendingLooks = 8;
        this.paintButton();
    }

    /**
     * Takes the chevron away without touching Discord's view: used while the
     * scene's own switch is off. A later look mounts it again.
     */
    suspend(): void {
        if (this.disposed) return;

        this.removeButton();
        this.restoreSurfacePosition();
    }

    /**
     * Stops working and leaves Discord as a person would expect: the chevron is
     * removed, and a fullscreen this module turned on is turned off again.
     * A fullscreen the user turned on with Discord's own control is theirs and
     * is left alone.
     */
    destroy(): void {
        if (this.disposed) return;

        this.disposed = true;

        if (this.expandedByUs && this.expanded) {
            const control = this.view?.fullscreen;
            if (control?.isConnected !== false) control?.click?.();
        }

        this.removeButton();
        this.restoreSurfacePosition();

        this.expandedByUs = false;
        this.expanded = false;
        this.pendingLooks = 0;
        this.view = null;
        this.channelId = null;
    }

    /* ---------------------------------------------------------------- internals */

    private mountButton(view: CallView): void {
        const host = view.surface;

        if (!this.button) this.createButton();

        const button = this.button!;
        if (this.buttonHost !== host || button.parentElement !== host) {
            button.remove?.();
            host.appendChild(button);
            this.buttonHost = host;
            this.positionButton(button);
        }

        this.claimSurfacePosition(host);
    }

    private claimSurfacePosition(surface: HTMLElement): void {
        if (this.surfacePosition?.element === surface) return;

        this.restoreSurfacePosition();

        const style = this.env.styleOf(surface);
        if (style.position && style.position !== "static") return;

        this.surfacePosition = { element: surface, had: surface.style.position !== "", value: surface.style.position };
        surface.style.position = "relative";
    }

    private restoreSurfacePosition(): void {
        const held = this.surfacePosition;
        if (!held) return;

        held.element.style.position = held.had ? held.value : "";
        this.surfacePosition = null;
    }

    private createButton(): void {
        const { doc } = this.env;

        const button = doc.createElement("button");
        button.type = "button";
        button.className = FOCUS_TOGGLE_CLASS;
        button.setAttribute(FOCUS_TOGGLE_ATTRIBUTE, "");

        const svg = doc.createElementNS(SVG_NAMESPACE, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "16");
        svg.setAttribute("height", "16");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");

        const path = doc.createElementNS(SVG_NAMESPACE, "path");
        path.setAttribute("d", CHEVRON_PATH);
        svg.appendChild(path);
        button.appendChild(svg);

        button.addEventListener("click", this.onToggleClick);

        this.button = button;
        this.chevron = path as unknown as SVGPathElement;
    }

    /**
     * Placement the button needs to work with no stylesheet at all. Anything the
     * stylesheet does set is left alone, so the visual layer keeps control of
     * where the button looks like it sits.
     */
    private positionButton(button: HTMLButtonElement): void {
        const style = this.env.styleOf(button);

        if (!style.position || style.position === "static") button.style.position = "absolute";
        // Above Discord's call header layer (z-index 1001 inside the same call
        // root), or the header's back control takes the press in the windowed view.
        if (!style.zIndex || style.zIndex === "auto") button.style.zIndex = "1100";
        if (style.pointerEvents === "none") button.style.pointerEvents = "auto";
        // The call's own top-left corner, where the supplied picture puts it.
        if (!style.left || style.left === "auto") button.style.left = "12px";
        if (!style.top || style.top === "auto") button.style.top = "12px";
    }

    private paintButton(): void {
        const { button } = this;
        if (!button) return;

        const { expanded } = this;
        const label = toggleLabel(expanded);

        button.setAttribute(FOCUS_ATTRIBUTE, expanded ? "true" : "false");
        button.setAttribute("aria-pressed", expanded ? "true" : "false");
        button.setAttribute("aria-label", label);
        button.setAttribute("title", label);

        // One path, always the authored right-pointing chevron: the stylesheet
        // reverses it while data-sv-focused is "false".
        if (this.chevron) this.chevron.setAttribute("d", CHEVRON_PATH);
    }

    private removeButton(): void {
        const { button } = this;
        if (!button) return;

        button.removeEventListener("click", this.onToggleClick);
        button.remove?.();

        this.button = null;
        this.buttonHost = null;
        this.chevron = null;
    }
}
