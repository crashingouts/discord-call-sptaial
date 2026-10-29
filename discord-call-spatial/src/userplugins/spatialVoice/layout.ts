/**
 * Spatial Voice — deterministic spatial layout engine.
 *
 * Pure and dependency-free: no React, no Discord, no DOM, no sibling modules.
 * The same input always produces the same scene, so re-renders never shuffle
 * participants.
 *
 * The scene is a lattice of disjoint cells over the usable area, each cell
 * slightly larger than the biggest tile plus its clearance. Every item's
 * footprint is kept inside its own cell, so two different cells can never
 * collide and a participant only moves when its own cell is taken. Each
 * participant's cell comes from its own id (FNV-1a into the cell list), and its
 * size and scatter inside that cell come from its id too, so positions are
 * steady across participant churn and the field reads as scattered rather than
 * as a uniform grid.
 *
 * The lattice is cut away in the middle: in the overview the centre is the
 * reference composition's vortex, and in the selected state it is the main feed.
 * Either way the cells that remain ring the middle instead of covering it, which
 * is what makes the scene read as a surround rather than as a page of tiles.
 *
 * Coordinates are scene-local pixels with the origin at the scene's top-left.
 * The reserved header band sits above `usable` and the reserved call-controls
 * band sits below it; no item is ever placed into either.
 *
 * Placement contract: an item's x/y is the top-left of the tile itself (the
 * video panel or the avatar circle), never of a name plate. A wrapper that CSS
 * centres with translate(-50%, -50%) must therefore be centred on
 * `spatialItemCenter(item)`, and a wrapper that also carries a plate below the
 * tile is taller than the tile, so the scene offsets by half that extra height
 * (or positions the plate absolutely) before handing the point to CSS.
 */

export const SPATIAL_VIDEO_ASPECT = 16 / 9;
/** Vertical space kept below every tile for its name plate. */
export const SPATIAL_LABEL_CLEARANCE = 18;

export type SpatialParticipantKind = "video" | "avatar";

export interface SpatialParticipant {
    id: string;
    kind: SpatialParticipantKind;
}

export interface SpatialLayoutOptions {
    /** Main feed width as a fraction of the usable width (0.4–0.5 by design). */
    selectedWidthRatio: number;
    /** Preferred secondary video tile width in CSS pixels. */
    videoWidth: number;
    /** Preferred camera-off avatar diameter in CSS pixels. */
    avatarSize: number;
    /** Minimum breathing room between footprints. */
    gap: number;
    /** Largest speaking enlargement the avatar must not collide with. */
    maximumAvatarScale: number;
    /** Reserved top band (channel header). */
    headerHeight: number;
    /** Reserved bottom band (floating call controls). */
    controlsHeight: number;
    /** 1-based overflow page. */
    page: number;
}

export const DEFAULT_SPATIAL_LAYOUT_OPTIONS: Readonly<SpatialLayoutOptions> = Object.freeze({
    selectedWidthRatio: 0.45,
    // 220 at a 1280-wide scene puts a secondary tile at 17% of the width, which is
    // where the reference compositions put theirs; 280 read as a second row of
    // main feeds and crowded the focal panel.
    videoWidth: 220,
    avatarSize: 60,
    gap: 20,
    maximumAvatarScale: 1.4,
    headerHeight: 48,
    controlsHeight: 88,
    page: 1
});

export interface SpatialLayoutItem {
    id: string;
    kind: SpatialParticipantKind;
    x: number;
    y: number;
    width: number;
    height: number;
    selected: boolean;
}

export interface SpatialLayoutInput {
    width: number;
    height: number;
    participants: readonly SpatialParticipant[];
    selectedId?: string | null;
    options?: Partial<SpatialLayoutOptions> | null;
}

export interface SpatialLayoutResult {
    items: SpatialLayoutItem[];
    /** Participants placed on a later page, plus any that fit nowhere at this size. */
    overflowIds: string[];
    pageCount: number;
    /** The page these items belong to, clamped to 1..pageCount. */
    page: number;
    /** Every participant in the room, on this page or not. */
    participantCount: number;
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface Point {
    x: number;
    y: number;
}

interface Size {
    width: number;
    height: number;
}

interface Frame {
    usable: Rect;
    gap: number;
    labelClearance: number;
    videoWidth: number;
    videoHeight: number;
    avatarSize: number;
    maximumAvatarScale: number;
    mainFeed: Rect | null;
}

function finiteOr(value: number | undefined | null, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(Math.max(value, low), high);
}

function bounded(value: number | undefined | null, fallback: number, low: number, high: number): number {
    return clamp(finiteOr(value, fallback), low, high);
}

/** FNV-1a, 32 bit. Stable across runs, platforms and module instances. */
function hashId(id: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < id.length; index++) {
        hash ^= id.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/** Deterministic 0..1 value for a seed (no shared PRNG state). */
function pseudoRandom(seed: number): number {
    let value = seed | 0;
    value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
    value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
    value ^= value >>> 15;
    return (value >>> 0) / 0xffffffff;
}

function compareParticipants(a: SpatialParticipant, b: SpatialParticipant): number {
    const byHash = hashId(a.id) - hashId(b.id);
    if (byHash !== 0) return byHash;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function fitsInside(footprint: Rect, usable: Rect): boolean {
    if (footprint.width <= 0 || footprint.height <= 0) return false;
    return (
        footprint.x >= usable.x - 0.001 &&
        footprint.y >= usable.y - 0.001 &&
        footprint.x + footprint.width <= usable.x + usable.width + 0.001 &&
        footprint.y + footprint.height <= usable.y + usable.height + 0.001
    );
}

function centeredRect(x: number, y: number, width: number, height: number): Rect {
    return {
        x: Math.round(x - width / 2),
        y: Math.round(y - height / 2),
        width: Math.round(width),
        height: Math.round(height)
    };
}

/**
 * The area an item occupies for collision purposes: the tile plus half a gap on
 * every side, its name plate below, and, for camera-off avatars, the footprint
 * of the largest speaking enlargement so an enlarging avatar never collides.
 */
function footprintOf(rect: Rect, kind: SpatialParticipantKind, frame: Frame): Rect {
    const pad = frame.gap / 2;
    let width = rect.width;
    let height = rect.height;
    if (kind === "avatar") {
        width *= frame.maximumAvatarScale;
        height *= frame.maximumAvatarScale;
    }
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    return {
        x: centerX - width / 2 - pad,
        y: centerY - height / 2 - pad,
        width: width + pad * 2,
        height: height + pad * 2 + frame.labelClearance
    };
}

/**
 * A participant's own tile size. The frame's sizes stay the upper bound the
 * lattice is built for; each participant keeps a deterministic fraction of it,
 * so tiles differ a little the way the reference compositions do and the
 * smaller ones get real slack to scatter inside their cell.
 */
function sizeFor(participant: SpatialParticipant, frame: Frame): Size {
    const hash = hashId(participant.id);
    if (participant.kind === "avatar") {
        const scale = 0.88 + pseudoRandom(hash ^ 0x5bf03635) * 0.12;
        const size = Math.max(8, Math.round(frame.avatarSize * scale));
        return { width: size, height: size };
    }
    const scale = 0.84 + pseudoRandom(hash ^ 0x27d4eb2f) * 0.16;
    const width = Math.max(12, Math.round(frame.videoWidth * scale));
    return { width, height: Math.max(8, Math.round(width / SPATIAL_VIDEO_ASPECT)) };
}

/** Deterministic scatter inside a cell, per participant and page, in -1..1. */
function jitterFor(id: string, pageIndex: number): Point {
    const hash = hashId(id);
    return {
        x: pseudoRandom(hash ^ Math.imul(pageIndex + 1, 0x9e3779b1) ^ 0x85ebca6b) * 2 - 1,
        y: pseudoRandom((hash >>> 16) ^ Math.imul(pageIndex + 1, 0xc2b2ae35) ^ 0x27d4eb2f) * 2 - 1
    };
}

function overlapsFeed(footprint: Rect, frame: Frame): boolean {
    if (!frame.mainFeed) return false;
    return rectsOverlap(footprint, footprintOf(frame.mainFeed, "video", frame));
}

export function resolveSpatialLayoutOptions(
    options?: Partial<SpatialLayoutOptions> | null
): SpatialLayoutOptions {
    const source = options ?? {};
    return {
        selectedWidthRatio: bounded(source.selectedWidthRatio, DEFAULT_SPATIAL_LAYOUT_OPTIONS.selectedWidthRatio, 0.3, 0.6),
        videoWidth: bounded(source.videoWidth, DEFAULT_SPATIAL_LAYOUT_OPTIONS.videoWidth, 96, 960),
        avatarSize: bounded(source.avatarSize, DEFAULT_SPATIAL_LAYOUT_OPTIONS.avatarSize, 20, 256),
        gap: bounded(source.gap, DEFAULT_SPATIAL_LAYOUT_OPTIONS.gap, 2, 80),
        maximumAvatarScale: bounded(source.maximumAvatarScale, DEFAULT_SPATIAL_LAYOUT_OPTIONS.maximumAvatarScale, 1, 3),
        headerHeight: bounded(source.headerHeight, DEFAULT_SPATIAL_LAYOUT_OPTIONS.headerHeight, 0, 320),
        controlsHeight: bounded(source.controlsHeight, DEFAULT_SPATIAL_LAYOUT_OPTIONS.controlsHeight, 0, 400),
        page: Math.max(1, Math.floor(bounded(source.page, 1, 1, 1000)))
    };
}

function normalizeParticipants(participants: readonly SpatialParticipant[] | undefined | null): SpatialParticipant[] {
    if (!Array.isArray(participants)) return [];
    const seen = new Set<string>();
    const normalized: SpatialParticipant[] = [];
    for (const participant of participants) {
        if (!participant || typeof participant.id !== "string" || participant.id.length === 0) continue;
        if (seen.has(participant.id)) continue;
        seen.add(participant.id);
        // Anything that is not an explicit camera feed is treated as camera-off.
        normalized.push({ id: participant.id, kind: participant.kind === "video" ? "video" : "avatar" });
    }
    return normalized;
}

function buildMainFeed(usable: Rect, options: SpatialLayoutOptions): Rect | null {
    // The name plate under the feed belongs to its footprint, so the feed is
    // centred inside the usable band minus that clearance.
    const availableHeight = Math.max(0, usable.height - SPATIAL_LABEL_CLEARANCE);
    let width = Math.min(usable.width * options.selectedWidthRatio, usable.width * 0.58);
    let height = width / SPATIAL_VIDEO_ASPECT;
    const maxHeight = availableHeight * 0.72;
    if (height > maxHeight) {
        height = maxHeight;
        width = height * SPATIAL_VIDEO_ASPECT;
    }
    width = Math.round(width);
    height = Math.round(height);
    if (width < 8 || height < 8) return null;
    return {
        x: Math.round(usable.x + (usable.width - width) / 2),
        y: Math.round(usable.y + (availableHeight - height) / 2),
        width,
        height
    };
}

function buildFrame(width: number, height: number, options: SpatialLayoutOptions, hasMainFeed: boolean): Frame {
    const header = Math.min(options.headerHeight, height);
    const usable: Rect = {
        x: 0,
        y: header,
        width,
        height: Math.max(0, height - header - options.controlsHeight)
    };

    // The geometric mean of the two axis fits, not their minimum: a 1024x572 call
    // window is 16:9 but only 436px of usable height, and the minimum would shrink
    // every tile to 60% of the reference proportions.
    const density = clamp(Math.sqrt((usable.width / 1280) * (usable.height / 720)), 0.45, 1);
    const gap = Math.round(clamp(options.gap * density, 4, 64));

    let videoWidth = Math.min(
        options.videoWidth * density,
        usable.width * 0.42,
        usable.height * 0.46 * SPATIAL_VIDEO_ASPECT
    );
    videoWidth = clamp(videoWidth, 48, 960);
    videoWidth = Math.min(videoWidth, usable.width, usable.height * SPATIAL_VIDEO_ASPECT);
    videoWidth = Math.max(0, Math.round(videoWidth));

    let avatarSize = Math.min(
        options.avatarSize * density,
        usable.width * 0.22,
        usable.height * 0.26
    );
    avatarSize = clamp(avatarSize, 12, 256);
    avatarSize = Math.min(avatarSize, usable.width, usable.height);
    avatarSize = Math.max(0, Math.round(avatarSize));

    return {
        usable,
        gap,
        labelClearance: SPATIAL_LABEL_CLEARANCE,
        videoWidth,
        videoHeight: Math.max(1, Math.round(videoWidth / SPATIAL_VIDEO_ASPECT)),
        avatarSize,
        maximumAvatarScale: options.maximumAvatarScale,
        mainFeed: hasMainFeed ? buildMainFeed(usable, options) : null
    };
}

/** A deterministic point inside a cell that keeps an item's own footprint inside it. */
function pointInCell(cell: Rect, size: Size, kind: SpatialParticipantKind, frame: Frame, jitter: Point): Point {
    const footprint = footprintOf({ x: 0, y: 0, width: size.width, height: size.height }, kind, frame);
    const slackX = Math.max(0, cell.width - footprint.width);
    const slackY = Math.max(0, cell.height - footprint.height);
    return {
        x: cell.x + cell.width / 2 + clamp(jitter.x, -1, 1) * (slackX / 2),
        y: cell.y + cell.height / 2 + clamp(jitter.y, -1, 1) * (slackY / 2)
    };
}

/**
 * The cell lattice: disjoint cells that tile the usable area, sized for the
 * biggest footprint plus clearance. An item's footprint never
 * leaves its own cell, so no two items can collide.
 */
function buildLattice(frame: Frame): Rect[] {
    const usable = frame.usable;
    if (usable.width <= 0 || usable.height <= 0) return [];
    if (frame.videoWidth <= 0 || frame.videoHeight <= 0 || frame.avatarSize <= 0) return [];

    const centreX = usable.x + usable.width / 2;
    const centreY = usable.y + usable.height / 2;
    const halfWidth = Math.max(1, usable.width / 2);
    const halfHeight = Math.max(1, usable.height / 2);

    function inHollow(cell: Rect): boolean {
        const radius = Math.hypot(
            (cell.x + cell.width / 2 - centreX) / halfWidth,
            (cell.y + cell.height / 2 - centreY) / halfHeight
        );
        return radius < HOLLOW_CENTRE;
    }

    // Slots are packed in two bands, coarse first: a tile-sized band for the outer
    // field and an avatar-sized band that fills the gaps between and inside it.
    // One band alone either wastes on an avatar the room a rectangle needs or
    // squeezes every tile into a subscription-grid. Packing band-mates on a brick
    // pattern (each odd row shifted by half a slot) and nudging every slot by its
    // own hash keeps the field from lining up into rows and columns.
    const slots: Array<{ width: number; height: number }> = [
        {
            width: frame.videoWidth + frame.gap,
            height: frame.videoHeight + frame.gap + frame.labelClearance
        },
        {
            // The enlarging circle is part of the slot, so a speaking avatar never
            // has to be moved or clipped: the slot is laid out for the size the
            // circle reaches, not the size it starts at.
            width: Math.round(frame.avatarSize * frame.maximumAvatarScale) + frame.gap,
            height: Math.round(frame.avatarSize * frame.maximumAvatarScale) + frame.gap + frame.labelClearance
        }
    ];

    const cells: Rect[] = [];
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
        const slot = slots[slotIndex];
        if (slot.width <= 0 || slot.height <= 0) continue;
        const pitchX = slot.width + frame.gap * 0.3;
        const pitchY = slot.height + frame.gap * 0.3;
        const rows = Math.floor(usable.height / pitchY) + 1;
        const columns = Math.floor(usable.width / pitchX) + 2;

        for (let row = 0; row < rows; row++) {
            const rowY = usable.y + pitchY * (row + 0.5);
            if (rowY > usable.y + usable.height) break;
            const rowShift = (row % 2) * pitchX * 0.5;
            for (let column = 0; column < columns; column++) {
                const columnX = usable.x + pitchX * column + rowShift + pitchX * 0.5;
                if (columnX > usable.x + usable.width) break;

                const nudge = hashId(`cell:${slot.width}:${row}:${column}`);
                const x = columnX + (pseudoRandom(nudge ^ 0x85ebca6b) - 0.5) * pitchX * 0.3;
                const y = rowY + (pseudoRandom(nudge ^ 0x27d4eb2f) - 0.5) * pitchY * 0.3;
                const cell = centeredRect(x, y, slot.width, slot.height);
                if (!fitsInside(cell, usable)) continue;
                // Cut the middle out: the overview's vortex and the selected feed
                // both want it, and a slot there would put a tile over the focal
                // point.
                if (inHollow(cell)) continue;
                if (cells.some(existing => rectsOverlap(existing, cell))) continue;
                // No two slots share a centre row or column, with enough of a floor
                // to absorb the nudge an item adds inside its own slot: that is what
                // keeps the filled field off a visible grid.
                const centre = { x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 };
                if (cells.some(existing =>
                    Math.abs(existing.x + existing.width / 2 - centre.x) < 4
                    || Math.abs(existing.y + existing.height / 2 - centre.y) < 4
                )) continue;
                cells.push(cell);
            }
        }
    }

    return cells;
}



/**
 * The hollow centre, as a fraction of the usable half-width and half-height.
 * No cell centre comes closer than this to the middle of the scene. 0.34 keeps
 * the middle clear for the overview vortex and for a selected feed's lower and
 * upper neighbours, while still leaving room for the innermost ring of avatars
 * the references show: it is a hole, not a band of empty space.
 */
const HOLLOW_CENTRE = 0.34;

interface PageResult {
    items: SpatialLayoutItem[];
    placed: Set<string>;
}

function layoutPage(
    pool: readonly SpatialParticipant[],
    frame: Frame,
    pageIndex: number,
    selectedId: string | null,
    feedParticipant: SpatialParticipant | null
): PageResult {
    const items: SpatialLayoutItem[] = [];
    const occupied: Rect[] = [];
    const placed = new Set<string>();

    if (feedParticipant && frame.mainFeed) {
        const feed = frame.mainFeed;
        items.push({
            id: feedParticipant.id,
            kind: "video",
            x: feed.x,
            y: feed.y,
            width: feed.width,
            height: feed.height,
            selected: true
        });
        occupied.push(footprintOf(feed, "video", frame));
    }

    const cells = buildLattice(frame);
    if (cells.length === 0) return { items, placed };

    const claimed = new Set<Rect>();

    function commit(participant: SpatialParticipant, cell: Rect): boolean {
        if (claimed.has(cell)) return false;
        const size = sizeFor(participant, frame);
        if (size.width <= 0 || size.height <= 0) return false;
        const point = pointInCell(cell, size, participant.kind, frame, jitterFor(participant.id, pageIndex));
        const rect = centeredRect(point.x, point.y, size.width, size.height);
        const footprint = footprintOf(rect, participant.kind, frame);
        if (!fitsInside(footprint, frame.usable)) return false;
        if (overlapsFeed(footprint, frame)) return false;
        // Cells already guarantee separation; this is a belt-and-braces check.
        if (occupied.some(other => rectsOverlap(footprint, other))) return false;

        claimed.add(cell);
        occupied.push(footprint);
        placed.add(participant.id);
        items.push({
            id: participant.id,
            kind: participant.kind,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            selected: participant.id === selectedId
        });
        return true;
    }

    // Pass 1: everyone tries the cell that their own id names, so a participant's
    // position does not depend on who else is in the channel.
    const waiting: Array<{ participant: SpatialParticipant; start: number }> = [];
    for (const participant of pool) {
        if (feedParticipant && participant.id === feedParticipant.id) continue;
        const start = hashId(participant.id) % cells.length;
        if (!commit(participant, cells[start])) waiting.push({ participant, start });
    }

    // Pass 2: the few whose cell was taken probe forward to the nearest free one.
    const stranded: SpatialParticipant[] = [];
    for (const entry of waiting) {
        let settled = false;
        for (let probe = 1; probe < cells.length && !settled; probe++) {
            settled = commit(entry.participant, cells[(entry.start + probe) % cells.length]);
        }
        if (!settled) stranded.push(entry.participant);
    }

    // Pass 3: leftovers may use any cell their own footprint still clears.
    for (const participant of stranded) {
        for (const cell of cells) {
            if (commit(participant, cell)) break;
        }
    }

    items.sort((a, b) => {
        if (a.selected !== b.selected) return a.selected ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return { items, placed };
}

/**
 * Lay out one page of the spatial scene.
 *
 * Returns items in scene-local coordinates, the ids that did not fit on this
 * page, and how many pages the room needs. A selected camera feed is centred on
 * every page; all other participants are scattered around it on stable cells.
 */
export function computeSpatialLayout(input: SpatialLayoutInput): SpatialLayoutResult {
    const options = resolveSpatialLayoutOptions(input ? input.options : null);
    const width = Math.max(0, finiteOr(input ? input.width : 0, 0));
    const height = Math.max(0, finiteOr(input ? input.height : 0, 0));
    const participants = normalizeParticipants(input ? input.participants : null);

    const requestedSelectedId = input && typeof input.selectedId === "string" ? input.selectedId : null;
    const selected = requestedSelectedId === null
        ? undefined
        : participants.find(participant => participant.id === requestedSelectedId);
    const selectedId = selected ? selected.id : null;
    // Only a camera feed can become the large centred panel in selected mode.
    const feedParticipant = selected && selected.kind === "video" ? selected : null;

    const frame = buildFrame(width, height, options, feedParticipant !== null);

    const pool = participants
        .filter(participant => !feedParticipant || participant.id !== feedParticipant.id)
        .sort(compareParticipants);

    if (participants.length === 0 || frame.usable.width <= 0 || frame.usable.height <= 0) {
        return {
            items: [],
            overflowIds: participants.map(participant => participant.id),
            pageCount: 1,
            page: 1,
            participantCount: participants.length
        };
    }

    const pages: SpatialLayoutItem[][] = [];
    let remaining = pool;
    const maxPages = Math.max(1, pool.length);

    // The focus page exists even when the selected feed is the only participant.
    while (remaining.length > 0 || (pages.length === 0 && feedParticipant !== null)) {
        if (pages.length >= maxPages) break;
        const page = layoutPage(remaining, frame, pages.length, selectedId, feedParticipant);
        if (page.placed.size === 0) {
            // Nothing more fits at this size; keep the focus page, then stop.
            pages.push(page.items);
            break;
        }
        pages.push(page.items);
        remaining = remaining.filter(participant => !page.placed.has(participant.id));
    }

    const pageCount = Math.max(1, pages.length);
    const requestedPage = clamp(options.page, 1, pageCount);
    const items = pages[requestedPage - 1] ?? [];

    const laterIds = new Set<string>();
    for (let index = requestedPage; index < pages.length; index++) {
        for (const item of pages[index]) {
            if (!feedParticipant || item.id !== feedParticipant.id) laterIds.add(item.id);
        }
    }
    const strandedIds = new Set(remaining.map(participant => participant.id));
    const overflowIds = pool
        .filter(participant => laterIds.has(participant.id) || strandedIds.has(participant.id))
        .map(participant => participant.id);

    return { items, overflowIds, pageCount, page: requestedPage, participantCount: participants.length };
}

/**
 * The point a participant's tile must be centred on.
 *
 * `.sv-participant` is absolutely positioned and translated by -50%,-50%, so the
 * scene sets its left/top from this point rather than from the rect's corner.
 */
export function spatialItemCenter(item: Pick<SpatialLayoutItem, "x" | "y" | "width" | "height">): Point {
    return { x: item.x + item.width / 2, y: item.y + item.height / 2 };
}

/**
 * One sentence for an aria-live region, so paging through a large room is
 * announced instead of silently swapping the scene.
 */
export function describeSpatialPage(result: SpatialLayoutResult): string {
    const visible = result.items.length;
    const total = result.participantCount;
    if (total === 0) return "No participants in this channel.";
    if (result.pageCount <= 1) return `${visible} of ${total} participants visible.`;
    return `Page ${result.page} of ${result.pageCount}: ${visible} of ${total} participants visible.`;
}
