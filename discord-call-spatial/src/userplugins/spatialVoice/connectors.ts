/**
 * Spatial Voice — measured radial connector lines.
 *
 * A framework-independent, browser-native module. It owns exactly one decorative
 * `<svg class="sv-connectors">` overlay inside the scene element and draws one
 * straight `<line class="sv-connector">` per participant: from the measured
 * top-centre of the real call-control bar to the participant's measured
 * boundary. Nothing here reads React, Vencord, or a sibling module.
 *
 * Visual contract (reference images 1 and 2): thin, low-opacity straight
 * segments radiating from the control bar, painted behind participant tiles and
 * behind the control bar, with only camera-off speakers brightened.
 *
 * Coordinate model: every element is measured with getBoundingClientRect() in
 * viewport space, so scroll offsets, ancestor transforms and CSS scale are
 * already baked into each rect. Endpoints are translated into the overlay's own
 * coordinate system by subtracting the overlay's rect and dividing by the
 * overlay's own layout-to-screen scale, which keeps the viewBox in untransformed
 * CSS pixels and keeps the geometry right during scroll, resize and transform.
 * The viewBox is the overlay's box, never the scene's: the scene may carry a
 * border, padding or a transform that the overlay does not inherit, and a
 * viewBox measured from the wrong box slides every endpoint by the difference.
 *
 * Integration hooks for the scene component:
 *   - bind the real call-control bar at creation, or later with setControls()
 *     when React mounts the bar after the scene;
 *   - pass `anchor` for camera-off avatars: the node that actually scales (the
 *     avatar image), so the line follows the rendered avatar;
 *   - pass `visible: false` for participants that are on another page or faded
 *     out, so no stray segment points at them.
 */

export interface ConnectorParticipant {
    /** Stable identity; lines are diffed by this id across renders. */
    id: string;
    /** The participant's positioned container (video tile or avatar host). */
    element: Element;
    /** Camera state as reported by the caller. Only camera-off lines may brighten. */
    cameraOn: boolean;
    /** Speaking emphasis supplied by the caller; never derived here. */
    emphasized: boolean;
    /** Boundary used to terminate the line. Defaults to "rect". */
    shape?: "rect" | "circle";
    /**
     * The element whose *rendered* box is the visible anchor, when that is not
     * the container itself. A camera-off avatar enlarges through a CSS transform
     * on its image, and a transform on a descendant is invisible to the
     * container's own rect: pass the scaling node here and the line follows the
     * avatar while it grows and shrinks. A detached or missing anchor falls back
     * to `element`.
     */
    anchor?: Element | null;
    /**
     * Whether the caller currently shows this participant. `false` hides the
     * line without dropping it, so paginated or fading participants do not
     * leave a stray segment while they are off the scene.
     */
    visible?: boolean;
}

export interface ConnectorOptions {
    /** Master visibility toggle. */
    visible?: boolean;
    /** Base stroke opacity, 0..1. */
    opacity?: number;
    /** Base stroke width in CSS pixels. */
    width?: number;
    /** Glow strength, 0..1 (0 disables the filter entirely). */
    glow?: number;
    /** Extra brightness applied to an emphasized camera-off line, 0..1. */
    speakingHighlight?: number;
}

export interface ConnectorLayer {
    /** The overlay element (null when the layer was created without a scene). */
    readonly element: SVGSVGElement | null;
    setParticipants(participants: readonly ConnectorParticipant[]): void;
    configure(options: ConnectorOptions): void;
    /**
     * Point the lines at the real call-control bar once it exists, or detach it
     * with null. React can mount the bar after the scene, so the origin must be
     * bindable later without recreating the layer.
     */
    setControls(controls: Element | null | undefined): void;
    refresh(): void;
    dispose(): void;
}

interface ResolvedOptions {
    visible: boolean;
    opacity: number;
    width: number;
    glow: number;
    speakingHighlight: number;
}

interface LineRecord {
    id: string;
    element: Element;
    anchor: Element | null;
    line: Element;
    cameraOn: boolean;
    emphasized: boolean;
    visible: boolean;
    shape: "rect" | "circle";
}

interface ViewportRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const OVERLAY_CLASS = "sv-connectors";
const LINE_CLASS = "sv-connector";
const EMPHASIS_CLASS = "sv-connector--speaking";
const LINE_COLOR = "var(--sv-line-color, #8fa6ff)";
const HIGHLIGHT_COLOR = "var(--sv-line-highlight, var(--sv-line-color, #8fa6ff))";
const GLOW_COLOR = "var(--sv-connector-glow-color, var(--sv-line-glow, var(--sv-line-color, #8fa6ff)))";

/** Distance the line stops short of the participant boundary, in CSS pixels. */
const BOUNDARY_GAP = 2;
/** A burst follows CSS transitions for at most this many frames... */
const BURST_FRAME_LIMIT = 24;
/** ...and for at most this long, then measurement stops completely. */
const BURST_WINDOW_MS = 480;
/** Extra stroke width on an emphasized line, as a fraction, at full highlight. */
const EMPHASIS_WIDTH_GAIN = 0.6;
/** Drop-shadow radius in CSS pixels at full glow. */
const GLOW_RADIUS_GAIN = 5;
const EPSILON = 1e-6;

const DEFAULT_OPTIONS: ResolvedOptions = {
    visible: true,
    opacity: 0.32,
    width: 1.25,
    glow: 0.55,
    speakingHighlight: 0.7
};

function clamp01(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(1, Math.max(0, value));
}

function clampWidth(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(12, Math.max(0.25, value));
}

function resolveOptions(base: ResolvedOptions, patch: ConnectorOptions | null | undefined): ResolvedOptions {
    if (!patch || typeof patch !== "object") return base;
    return {
        visible: typeof patch.visible === "boolean" ? patch.visible : base.visible,
        opacity: clamp01(patch.opacity, base.opacity),
        width: clampWidth(patch.width, base.width),
        glow: clamp01(patch.glow, base.glow),
        speakingHighlight: clamp01(patch.speakingHighlight, base.speakingHighlight)
    };
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function setAttribute(element: Element, name: string, value: string): void {
    if (typeof element.getAttribute !== "function") return;
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setClass(element: Element, name: string, on: boolean): void {
    const list = element.classList;
    if (!list) return;
    if (on) {
        if (!list.contains(name)) list.add(name);
    } else if (list.contains(name)) {
        list.remove(name);
    }
}

function readRect(element: Element | null | undefined): ViewportRect | null {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    let rect: DOMRect;
    try {
        rect = element.getBoundingClientRect();
    } catch {
        return null;
    }
    if (!rect) return null;
    const left = Number(rect.left);
    const top = Number(rect.top);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
    }
    return { left, top, width, height };
}

function readLayoutSize(element: Element | null | undefined): { width: number; height: number } {
    if (!element) return { width: 0, height: 0 };
    const candidate = element as unknown as { offsetWidth?: number; offsetHeight?: number };
    const width = typeof candidate.offsetWidth === "number" ? candidate.offsetWidth : 0;
    const height = typeof candidate.offsetHeight === "number" ? candidate.offsetHeight : 0;
    return { width, height };
}

/** The first finite extent above zero, or 0 when every candidate is unusable. */
function firstPositive(...values: number[]): number {
    for (const value of values) {
        if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
}

function isDetached(element: Element | null | undefined): boolean {
    if (!element) return true;
    const candidate = element as unknown as { isConnected?: boolean };
    return candidate.isConnected === false;
}

function createInertLayer(): ConnectorLayer {
    return {
        element: null,
        setParticipants() {
            /* no scene: nothing to draw */
        },
        configure() {
            /* no scene: nothing to configure */
        },
        setControls() {
            /* no scene: no origin to bind */
        },
        refresh() {
            /* no scene: nothing to measure */
        },
        dispose() {
            /* nothing was created */
        }
    };
}

/**
 * Create the connector overlay for a scene.
 *
 * @param sceneElement    The positioned scene container (the overlay becomes its first child).
 * @param controlsElement The real call-control bar; lines originate at its top-centre.
 * @param options         Initial connector appearance.
 */
export function createConnectorLayer(
    sceneElement: Element | null | undefined,
    controlsElement: Element | null | undefined,
    options: ConnectorOptions = {}
): ConnectorLayer {
    const doc = sceneElement ? sceneElement.ownerDocument : null;
    if (!sceneElement || !doc || typeof doc.createElementNS !== "function") return createInertLayer();

    const ownerDocument: Document = doc;
    const view = doc.defaultView ?? null;
    const globalScope = globalThis as unknown as {
        requestAnimationFrame?: (callback: (time: number) => void) => number;
        cancelAnimationFrame?: (handle: number) => void;
        setTimeout?: (callback: () => void, ms: number) => number;
        clearTimeout?: (handle: number) => void;
        ResizeObserver?: unknown;
    };

    const raf =
        (view && typeof view.requestAnimationFrame === "function" ? view.requestAnimationFrame.bind(view) : null) ??
        (typeof globalScope.requestAnimationFrame === "function" ? globalScope.requestAnimationFrame.bind(globalScope) : null);
    const cancelRaf =
        (view && typeof view.cancelAnimationFrame === "function" ? view.cancelAnimationFrame.bind(view) : null) ??
        (typeof globalScope.cancelAnimationFrame === "function" ? globalScope.cancelAnimationFrame.bind(globalScope) : null);
    const setTimer: (callback: () => void, ms: number) => number =
        (view && typeof view.setTimeout === "function" ? view.setTimeout.bind(view) : null) ??
        ((callback: () => void, ms: number) => (globalScope.setTimeout as (cb: () => void, ms: number) => number)(callback, ms));
    const clearTimer: (handle: number) => void =
        (view && typeof view.clearTimeout === "function" ? view.clearTimeout.bind(view) : null) ??
        ((handle: number) => (globalScope.clearTimeout as (h: number) => void)(handle));

    const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    const group = doc.createElementNS(SVG_NS, "g") as SVGGElement;

    let disposed = false;
    let resolved = resolveOptions(DEFAULT_OPTIONS, options);
    const records = new Map<string, LineRecord>();
    let controls: Element | null = controlsElement ?? null;

    let measureHandle = 0;
    let burstFrameHandle = 0;
    let burstTimerHandle = 0;
    let burstRemaining = 0;

    let observer: ResizeObserver | null = null;
    const observed = new Set<Element>();

    const listeners: Array<{ target: EventTarget; type: string; handler: EventListener; capture: boolean }> = [];
    let previousScenePosition: string | null = null;
    let scenePositionTouched = false;

    // ---------------------------------------------------------------- overlay

    svg.setAttribute("class", OVERLAY_CLASS);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.position = "absolute";
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    svg.style.zIndex = "0";
    svg.style.contain = "layout style";

    group.setAttribute("class", "sv-connector-layer");
    group.setAttribute("pointer-events", "none");
    group.setAttribute("fill", "none");
    group.setAttribute("stroke-linecap", "round");
    group.style.pointerEvents = "none";
    group.style.fill = "none";
    group.style.stroke = LINE_COLOR;
    svg.appendChild(group);

    // The overlay must position against the scene itself, not an ancestor.
    const sceneStyle = sceneElement as unknown as { style?: { position?: string } };
    if (sceneStyle.style && !sceneStyle.style.position) {
        previousScenePosition = sceneStyle.style.position ?? "";
        sceneStyle.style.position = "relative";
        scenePositionTouched = true;
    }

    // First child: painted behind every participant and the control bar.
    if (sceneElement.firstChild) sceneElement.insertBefore(svg, sceneElement.firstChild);
    else sceneElement.appendChild(svg);

    // Container resizes arrive from the observer; viewport resizes from the window.
    observe(sceneElement);
    if (controls) observe(controls);

    // ------------------------------------------------------------- appearance

    function applyAppearance(record: LineRecord): void {
        const emphasized = record.cameraOn === false && record.emphasized === true;
        setClass(record.line, EMPHASIS_CLASS, emphasized);
        const opacity = emphasized
            ? clamp01(resolved.opacity + resolved.speakingHighlight * (1 - resolved.opacity), resolved.opacity)
            : resolved.opacity;
        const width = emphasized ? resolved.width * (1 + EMPHASIS_WIDTH_GAIN * resolved.speakingHighlight) : resolved.width;
        setAttribute(record.line, "stroke-opacity", String(round(opacity)));
        setAttribute(record.line, "stroke-width", String(round(width)));
        setAttribute(record.line, "data-sv-emphasized", emphasized ? "true" : "false");

        const style = (record.line as unknown as {
            style?: { setProperty?: (name: string, value: string) => void; removeProperty?: (name: string) => void };
        }).style;
        if (!style || typeof style.setProperty !== "function" || typeof style.removeProperty !== "function") return;
        if (emphasized) style.setProperty("stroke", HIGHLIGHT_COLOR);
        else style.removeProperty("stroke");
    }

    function applyChrome(): void {
        svg.style.display = resolved.visible ? "" : "none";
        const glowRadius = round(resolved.glow * GLOW_RADIUS_GAIN);
        group.style.filter = resolved.glow > 0 ? "drop-shadow(0 0 " + glowRadius + "px " + GLOW_COLOR + ")" : "";
        svg.style.setProperty("--sv-connector-glow", glowRadius + "px");
        svg.style.setProperty("--sv-connector-width", round(resolved.width) + "px");
        svg.style.setProperty("--sv-connector-opacity", String(round(resolved.opacity)));
    }

    function applyAllAppearance(): void {
        for (const record of records.values()) applyAppearance(record);
    }

    function hideLine(record: LineRecord): void {
        setAttribute(record.line, "visibility", "hidden");
    }

    function hideAllLines(): void {
        for (const record of records.values()) hideLine(record);
    }

    // --------------------------------------------------------------- geometry

    function measure(): void {
        if (disposed) return;
        if (!resolved.visible) {
            hideAllLines();
            return;
        }

        const sceneRect = readRect(sceneElement);
        const overlayRect = readRect(svg as unknown as Element);
        if (!sceneRect || !overlayRect || overlayRect.width <= 0 || overlayRect.height <= 0) {
            hideAllLines();
            return;
        }

        const svgLayout = readLayoutSize(svg as unknown as Element);
        const sceneLayout = readLayoutSize(sceneElement);
        // The viewBox maps onto the overlay's own box, so the extents and the
        // screen scale both come from the overlay: a scene border, padding or
        // transform that the overlay does not share can never drift endpoints.
        const layoutWidth = firstPositive(svgLayout.width, sceneLayout.width, sceneRect.width);
        const layoutHeight = firstPositive(svgLayout.height, sceneLayout.height, sceneRect.height);
        if (layoutWidth <= 0 || layoutHeight <= 0) {
            hideAllLines();
            return;
        }

        const scaleX = overlayRect.width > 0 ? overlayRect.width / layoutWidth : 1;
        const scaleY = overlayRect.height > 0 ? overlayRect.height / layoutHeight : 1;
        const safeScaleX = scaleX > 0 ? scaleX : 1;
        const safeScaleY = scaleY > 0 ? scaleY : 1;

        const viewWidth = round(layoutWidth);
        const viewHeight = round(layoutHeight);
        setAttribute(svg as unknown as Element, "viewBox", "0 0 " + viewWidth + " " + viewHeight);
        setAttribute(svg as unknown as Element, "width", String(viewWidth));
        setAttribute(svg as unknown as Element, "height", String(viewHeight));

        // Origin: the real control bar's top-centre, in overlay units. When the
        // bar is unavailable, fall back to the bottom-centre of the scene.
        let originX = viewWidth / 2;
        let originY = viewHeight;
        const controlsRect = controls ? readRect(controls) : null;
        if (controlsRect && controlsRect.width > 0 && controlsRect.height > 0 && !isDetached(controls)) {
            originX = (controlsRect.left + controlsRect.width / 2 - overlayRect.left) / safeScaleX;
            originY = (controlsRect.top - overlayRect.top) / safeScaleY;
        }

        for (const record of records.values()) {
            if (record.visible === false) {
                hideLine(record);
                continue;
            }
            // The visible anchor wins when the caller supplied one: a camera-off
            // avatar scales through a transform on its image, which the avatar
            // host's own rect does not report.
            const target = record.anchor && !isDetached(record.anchor) ? record.anchor : record.element;
            const rect = isDetached(target) ? null : readRect(target);
            if (!rect || rect.width < 1 || rect.height < 1) {
                hideLine(record);
                continue;
            }

            const left = (rect.left - overlayRect.left) / safeScaleX;
            const top = (rect.top - overlayRect.top) / safeScaleY;
            const width = rect.width / safeScaleX;
            const height = rect.height / safeScaleY;
            const centerX = left + width / 2;
            const centerY = top + height / 2;

            const deltaX = originX - centerX;
            const deltaY = originY - centerY;
            const distance = Math.hypot(deltaX, deltaY);
            if (!Number.isFinite(distance) || distance <= BOUNDARY_GAP) {
                hideLine(record);
                continue;
            }

            const unitX = deltaX / distance;
            const unitY = deltaY / distance;

            // Distance from the participant centre to its boundary along the ray
            // that points at the origin: rect uses the nearest edge, circle uses
            // the radius.
            let boundary: number;
            if (record.shape === "circle") {
                boundary = Math.min(width, height) / 2;
            } else {
                const hitX = Math.abs(unitX) > EPSILON ? width / 2 / Math.abs(unitX) : Number.POSITIVE_INFINITY;
                const hitY = Math.abs(unitY) > EPSILON ? height / 2 / Math.abs(unitY) : Number.POSITIVE_INFINITY;
                boundary = Math.min(hitX, hitY);
            }
            if (!Number.isFinite(boundary) || boundary <= 0 || distance <= boundary) {
                // The control bar overlaps this participant: no segment exists.
                hideLine(record);
                continue;
            }

            const endDistance = Math.max(0, boundary - BOUNDARY_GAP);
            const endX = centerX + unitX * endDistance;
            const endY = centerY + unitY * endDistance;

            setAttribute(record.line, "x1", String(round(originX)));
            setAttribute(record.line, "y1", String(round(originY)));
            setAttribute(record.line, "x2", String(round(endX)));
            setAttribute(record.line, "y2", String(round(endY)));
            setAttribute(record.line, "visibility", "visible");
        }
    }

    // ------------------------------------------------------------ coalescing

    function requestMeasure(): void {
        if (disposed || measureHandle !== 0) return;
        if (!raf) {
            measure();
            return;
        }
        measureHandle = raf(() => {
            measureHandle = 0;
            measure();
        });
    }

    /**
     * Follow a layout transition for a bounded window: at most BURST_FRAME_LIMIT
     * frames inside BURST_WINDOW_MS, then stop. There is no permanent
     * requestAnimationFrame loop.
     */
    function beginBurst(): void {
        if (disposed) return;
        // A burst already in flight keeps its remaining frame budget; a new
        // event only extends the time window, so N calls in one tick do the
        // same work as one call.
        if (burstFrameHandle === 0) burstRemaining = BURST_FRAME_LIMIT;
        if (burstTimerHandle !== 0) clearTimer(burstTimerHandle);
        burstTimerHandle = setTimer(() => {
            burstTimerHandle = 0;
            burstRemaining = 0;
        }, BURST_WINDOW_MS);
        stepBurst();
    }

    function stepBurst(): void {
        if (disposed || burstRemaining <= 0 || burstFrameHandle !== 0) return;
        burstRemaining -= 1;
        requestMeasure();
        if (!raf) {
            burstRemaining = 0;
            return;
        }
        burstFrameHandle = raf(() => {
            burstFrameHandle = 0;
            stepBurst();
        });
    }

    // -------------------------------------------------------------- lifecycle

    function addListener(
        target: EventTarget | null | undefined,
        type: string,
        handler: EventListener,
        capture: boolean
    ): void {
        if (!target || typeof target.addEventListener !== "function") return;
        target.addEventListener(type, handler, capture);
        listeners.push({ target, type, handler, capture });
    }

    function removeListeners(): void {
        for (const entry of listeners) {
            try {
                entry.target.removeEventListener(entry.type, entry.handler, entry.capture);
            } catch {
                /* a target in a torn-down document is already clean */
            }
        }
        listeners.length = 0;
    }

    const onTransition: EventListener = () => {
        beginBurst();
    };
    const onScroll: EventListener = () => {
        requestMeasure();
    };
    const onWindowResize: EventListener = () => {
        beginBurst();
    };

    addListener(sceneElement, "transitionrun", onTransition, true);
    addListener(sceneElement, "transitionend", onTransition, true);
    addListener(sceneElement, "transitioncancel", onTransition, true);
    addListener(sceneElement, "scroll", onScroll, true);
    addListener(view as unknown as EventTarget, "resize", onWindowResize, false);
    addListener(view as unknown as EventTarget, "scroll", onScroll, false);

    function ensureObserver(): ResizeObserver | null {
        if (observer) return observer;
        const ctor = (globalScope as unknown as {
            ResizeObserver?: new (callback: () => void) => ResizeObserver;
        }).ResizeObserver;
        if (typeof ctor !== "function") return null;
        observer = new ctor(() => {
            requestMeasure();
        });
        return observer;
    }

    function observe(element: Element | null | undefined): void {
        if (!element || observed.has(element)) return;
        const active = ensureObserver();
        if (!active) return;
        try {
            active.observe(element);
            observed.add(element);
        } catch {
            /* an element from another document cannot be observed */
        }
    }

    function unobserve(element: Element): void {
        if (!observer || !observed.has(element)) return;
        observed.delete(element);
        try {
            observer.unobserve(element);
        } catch {
            /* already gone */
        }
    }

    function createLine(participant: ConnectorParticipant): LineRecord {
        const line = ownerDocument.createElementNS(SVG_NS, "line");
        line.setAttribute("class", LINE_CLASS);
        line.setAttribute("data-sv-connector", participant.id);
        line.setAttribute("vector-effect", "non-scaling-stroke");
        line.setAttribute("visibility", "hidden");
        group.appendChild(line);
        const anchor = participant.anchor ?? null;
        const record: LineRecord = {
            id: participant.id,
            element: participant.element,
            anchor,
            line,
            cameraOn: participant.cameraOn === true,
            emphasized: participant.emphasized === true,
            visible: participant.visible !== false,
            shape: participant.shape === "circle" ? "circle" : "rect"
        };
        applyAppearance(record);
        observe(participant.element);
        if (anchor) observe(anchor);
        return record;
    }

    function destroyRecord(record: LineRecord): void {
        unobserve(record.element);
        if (record.anchor) unobserve(record.anchor);
        const parent = record.line.parentNode;
        if (parent) parent.removeChild(record.line);
        else if (typeof (record.line as unknown as Element).remove === "function") {
            (record.line as unknown as Element).remove();
        }
    }

    // ------------------------------------------------------------- public API

    function setParticipants(participants: readonly ConnectorParticipant[]): void {
        if (disposed || !Array.isArray(participants)) return;
        const seen = new Set<string>();
        for (const participant of participants) {
            if (!participant || typeof participant.id !== "string" || !participant.element) continue;
            if (seen.has(participant.id)) continue;
            seen.add(participant.id);
            const existing = records.get(participant.id);
            if (existing) {
                if (existing.element !== participant.element) {
                    unobserve(existing.element);
                    existing.element = participant.element;
                    observe(participant.element);
                }
                const anchor = participant.anchor ?? null;
                if (existing.anchor !== anchor) {
                    if (existing.anchor) unobserve(existing.anchor);
                    existing.anchor = anchor;
                    if (anchor) observe(anchor);
                }
                existing.cameraOn = participant.cameraOn === true;
                existing.emphasized = participant.emphasized === true;
                existing.visible = participant.visible !== false;
                existing.shape = participant.shape === "circle" ? "circle" : "rect";
                applyAppearance(existing);
            } else {
                records.set(participant.id, createLine(participant));
            }
        }
        for (const entry of Array.from(records.entries())) {
            const id = entry[0];
            if (seen.has(id)) continue;
            records.delete(id);
            destroyRecord(entry[1]);
        }
        beginBurst();
    }

    function configure(patch: ConnectorOptions): void {
        if (disposed) return;
        resolved = resolveOptions(resolved, patch);
        applyChrome();
        applyAllAppearance();
        beginBurst();
    }

    function setControls(next: Element | null | undefined): void {
        if (disposed) return;
        const element = next ?? null;
        if (element === controls) return;
        if (controls) unobserve(controls);
        controls = element;
        if (element) observe(element);
        beginBurst();
    }

    function refresh(): void {
        if (disposed) return;
        beginBurst();
    }

    function dispose(): void {
        if (disposed) return;
        disposed = true;

        if (measureHandle !== 0 && cancelRaf) cancelRaf(measureHandle);
        measureHandle = 0;
        if (burstFrameHandle !== 0 && cancelRaf) cancelRaf(burstFrameHandle);
        burstFrameHandle = 0;
        if (burstTimerHandle !== 0) clearTimer(burstTimerHandle);
        burstTimerHandle = 0;
        burstRemaining = 0;

        removeListeners();

        if (observer) {
            for (const element of observed) {
                try {
                    observer.unobserve(element);
                } catch {
                    /* already gone */
                }
            }
            observer.disconnect();
            observer = null;
        }
        observed.clear();

        for (const record of records.values()) destroyRecord(record);
        records.clear();

        const parent = svg.parentNode;
        if (parent) parent.removeChild(svg);
        else if (typeof (svg as unknown as Element).remove === "function") (svg as unknown as Element).remove();

        if (scenePositionTouched && sceneStyle.style) {
            sceneStyle.style.position = previousScenePosition ?? "";
            scenePositionTouched = false;
        }
    }

    applyChrome();
    applyAllAppearance();

    return { element: svg, setParticipants, configure, setControls, refresh, dispose };
}

export default createConnectorLayer;
