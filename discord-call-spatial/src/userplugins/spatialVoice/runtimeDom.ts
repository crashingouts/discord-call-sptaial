/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Spatial Voice — DOM discovery, kept apart from Vencord.
 *
 * Everything the adapter needs to find in Discord's own markup lives here, with
 * no React, no store and no client import, so the rules that were tuned against
 * a live call can be tested directly instead of only through a running client.
 *
 * The rules below were written from what a live Discord call actually renders
 * (Vencord 1.15.12, Discord Canary, 2026-10-29):
 *
 *   - a person's video tile is `[data-call-tile]` and carries
 *     `data-selenium-video-tile="<user id>"`: Discord's own identity attribute,
 *     so matching stays exact instead of guessing from an avatar URL;
 *   - the tile grid is the lowest element holding every call tile, not the
 *     wrapper of one video (a call can render a single live <video>, and the
 *     old "one level above the video" rule then landed inside that one tile);
 *   - the call-control bar's buttons each sit in their own wrapper, so the bar
 *     is a few ancestors above them: counting only a button's direct parent
 *     found nothing and left the connector origin at the scene's bottom edge.
 */

/** How far above a video the search walks looking for Discord's tile identity. */
const OLDEST_ANCESTOR = 14;

/** How far above a control button the bar itself can sit. */
const CONTROL_ANCESTOR_DEPTH = 6;

/** Discord's own identity attribute on a person's video tile. */
export const TILE_ID_ATTRIBUTE = "data-selenium-video-tile";

/** Discord's marker on any call tile, identity attribute or not. */
export const TILE_ATTRIBUTE = "data-call-tile";

/** The marker the adapter puts on its own host, so the scene is never mistaken for Discord's chrome. */
export const HOST_ATTRIBUTE = "data-sv-host";

const CONTROL_WORDS = /mute|unmute|deafen|undeafen|camera|video|screen|share|reaction|disconnect|leave|call|emojis?|soundboard|noise/i;

/** A control bar holds at least this many labelled buttons. */
const CONTROL_MIN_BUTTONS = 3;

/** A bar is wide and short; anything taller is a panel. */
const CONTROL_MAX_HEIGHT = 160;
const CONTROL_MIN_WIDTH = 160;

/** The bar lives in the lower part of the window. */
const CONTROL_MIN_TOP_RATIO = 0.4;

export interface ViewportRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** The fields a participant needs for matching; the store record is wider. */
export interface MatchTarget {
    /** The adapter's participant id (the user id for a person tile). */
    id: string;
    userId: string;
    displayName: string;
}

export function rectOf(element: Element): ViewportRect {
    const rect = element.getBoundingClientRect();

    return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
    };
}

/**
 * A live picture: a `<video>` whose `srcObject` is a stream carrying a video
 * track. This is the rule discordDepth3d/engine.ts already proved in this
 * checkout, and it needs no class name and no React internals.
 */
export function isLiveVideo(element: Element): element is HTMLVideoElement {
    const video = element as HTMLVideoElement;
    if (typeof video.srcObject === "undefined") return false;
    const stream = video.srcObject as MediaStream | null;
    if (!stream || typeof (stream as MediaStream).getVideoTracks !== "function") return false;
    return (stream as MediaStream).getVideoTracks().length > 0;
}

export function liveVideos(doc: Document): HTMLVideoElement[] {
    return Array.from(doc.querySelectorAll("video")).filter(isLiveVideo);
}

/** The lowest element that contains every given element, or null. */
export function lowestCommonAncestor(elements: readonly Element[]): Element | null {
    const first = elements[0];
    if (!first) return null;

    let candidate: Element | null = first;
    while (candidate) {
        if (elements.every(element => candidate!.contains(element))) return candidate;
        candidate = candidate.parentElement;
    }

    return null;
}

/** Steps up starting at the element itself, ignoring the scene's own host. */
function isInsideHost(doc: Document, element: Element): boolean {
    const host = doc.querySelector(`[${HOST_ATTRIBUTE}]`);
    return host !== null && host.contains(element);
}

function depthOf(element: Element): number {
    let depth = 0;
    for (let node: Element | null = element; node; node = node.parentElement) depth++;

    return depth;
}

/**
 * Discord's call-control bar: the lowest element that holds three or more
 * buttons labelled with call verbs, is bar-shaped, and sits in the lower part of
 * the window. It is returned, never rebuilt.
 */
export function findCallControls(doc: Document): HTMLElement | null {
    const view = doc.defaultView;
    const viewportHeight = view?.innerHeight ?? 0;

    const buttons = Array.from(doc.querySelectorAll<HTMLElement>('button, [role="button"]')).filter(button => {
        const label = button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "";
        if (!CONTROL_WORDS.test(label)) return false;
        const rect = rectOf(button);

        return rect.width > 8 && rect.height > 8;
    });

    if (buttons.length < CONTROL_MIN_BUTTONS) return null;

    // A button's own parent is only its wrapper; the bar is further up. Count
    // each matched button once, against every ancestor within reach.
    const counts = new Map<Element, number>();
    for (const button of buttons) {
        let ancestor: Element | null = button.parentElement;
        for (let depth = 0; ancestor && depth < CONTROL_ANCESTOR_DEPTH; depth++, ancestor = ancestor.parentElement) {
            counts.set(ancestor, (counts.get(ancestor) ?? 0) + 1);
        }
    }

    let best: { element: HTMLElement; count: number; depth: number } | null = null;
    for (const [element, count] of counts) {
        if (count < CONTROL_MIN_BUTTONS) continue;
        if (isInsideHost(doc, element)) continue;

        const rect = rectOf(element);
        if (rect.width < CONTROL_MIN_WIDTH || rect.height > CONTROL_MAX_HEIGHT) continue;
        if (viewportHeight > 0 && rect.top < viewportHeight * CONTROL_MIN_TOP_RATIO) continue;

        const depth = depthOf(element);
        if (!best || count > best.count || (count === best.count && depth > best.depth)) {
            best = { element: element as HTMLElement, count, depth };
        }
    }

    return best?.element ?? null;
}

/**
 * Discord's tile grid: the lowest element that holds every call tile. When the
 * markup carries no tile markers at all (an older client), it falls back to the
 * common ancestor of the live pictures, one level up.
 */
export function findTileGrid(doc: Document): HTMLElement | null {
    const tiles = Array.from(doc.querySelectorAll(`[${TILE_ATTRIBUTE}]`));
    if (tiles.length > 0) {
        const grid = lowestCommonAncestor(tiles);
        if (grid && grid !== doc.body && grid !== doc.documentElement) return grid as HTMLElement;
    }

    const videos = liveVideos(doc);
    if (videos.length === 0) return null;

    const common = lowestCommonAncestor(videos);
    if (!common) return null;

    const parent = common.parentElement;

    return parent && parent !== doc.body && parent.contains(common) ? parent : (common as HTMLElement);
}

/**
 * The element the scene is mounted in: the lowest element that holds both the
 * tile grid and the control bar, i.e. Discord's whole call area. Mounting inside
 * the grid's parent instead put the scene inside a single tile.
 *
 * With no control bar (a client that renders none, or one that appears later),
 * it climbs from the grid until the candidate fills a meaningful part of the
 * window, so the scene still covers the call rather than one tile.
 */
export function findCallSurface(
    doc: Document,
    grid: Element | null,
    controls: Element | null
): HTMLElement | null {
    const parts: Element[] = [];
    if (grid) parts.push(grid);
    if (controls) parts.push(controls);

    // One part alone is not a common ancestor: its own element would answer, and
    // the scene would mount inside the grid instead of around it.
    const common = parts.length > 1 ? lowestCommonAncestor(parts) : null;
    if (common && common !== doc.body && common !== doc.documentElement) return common as HTMLElement;

    if (!grid) return controls?.parentElement ?? null;

    const view = doc.defaultView;
    const minWidth = (view?.innerWidth ?? 0) * 0.4;
    const minHeight = (view?.innerHeight ?? 0) * 0.4;

    let candidate: HTMLElement | null = grid.parentElement;
    for (let depth = 0; candidate && depth < 4; depth++, candidate = candidate.parentElement) {
        if (candidate === doc.body || candidate === doc.documentElement) break;
        const rect = rectOf(candidate);
        if (rect.width >= minWidth && rect.height >= minHeight) return candidate;
    }

    return grid.parentElement;
}

/**
 * How strongly an element looks like it belongs to one participant.
 *
 * 5 points: Discord's own `data-selenium-video-tile` id on the element, which is
 *           the user id itself. Exact, and the reason a tile can never match the
 *           wrong person.
 * 3 points: an avatar image inside it whose URL carries the user id.
 * 2 points: an accessible label that names the participant exactly.
 * 0:        no relation at all.
 */
export function matchScore(root: Element, participant: MatchTarget): number {
    if (root.getAttribute(TILE_ID_ATTRIBUTE) === participant.userId) return 5;

    let score = 0;

    const images = root.querySelectorAll("img[src]");
    for (const image of Array.from(images)) {
        const source = (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src || "";
        if (source.includes(`/${participant.userId}/`)) {
            score = Math.max(score, 3);
            break;
        }
    }

    const wanted = participant.displayName.trim().toLowerCase();
    if (wanted) {
        if (root.getAttribute("aria-label")?.trim().toLowerCase().startsWith(wanted)) score = Math.max(score, 2);
        const labelled = root.querySelectorAll("[aria-label]");
        for (const element of Array.from(labelled)) {
            if (element.getAttribute("aria-label")?.trim().toLowerCase() === wanted) {
                score = Math.max(score, 2);
                break;
            }
        }
    }

    return score;
}

/** The user id Discord put on the tile that holds this element, when there is one. */
export function tileUserId(element: Element | null, limit = OLDEST_ANCESTOR): string | null {
    let node: Element | null = element;
    for (let depth = 0; node && depth < limit; depth++, node = node.parentElement) {
        const value = node.getAttribute?.(TILE_ID_ATTRIBUTE);
        if (value) return value;
    }

    return null;
}

export interface VideoMatch {
    element: HTMLVideoElement;
    stream: MediaStream;
    score: number;
    /** The video sits inside one of Discord's own call tiles. */
    inTile: boolean;
}

/**
 * Resolves every live video to at most one participant.
 *
 * Identity first: a video inside a tile with Discord's own user id goes to that
 * participant and to nobody else, which is what the avatar heuristic could not
 * do (one tile in a live call contains the avatars of several people, so every
 * camera participant scored a tie and none was used). Only videos with no tile
 * id fall back to the scored match, where a tie still means "unknown".
 */
export function matchLiveVideos(
    doc: Document,
    participants: readonly MatchTarget[]
): { liveVideos: number; matched: Map<string, VideoMatch[]> } {
    const videos = liveVideos(doc);
    const matched = new Map<string, VideoMatch[]>();

    const push = (participantId: string, match: VideoMatch) => {
        const list = matched.get(participantId) ?? [];
        list.push(match);
        matched.set(participantId, list);
    };

    for (const video of videos) {
        const tileId = tileUserId(video.parentElement);
        if (tileId) {
            const owner = participants.find(participant => participant.userId === tileId || participant.id === tileId);
            if (owner) {
                push(owner.id, {
                    element: video,
                    stream: video.srcObject as MediaStream,
                    score: 5,
                    inTile: true
                });
            }
            continue;
        }

        const best = new Map<string, number>();
        let ancestor: Element | null = video.parentElement;

        for (let depth = 0; ancestor && depth < OLDEST_ANCESTOR; depth++, ancestor = ancestor.parentElement) {
            if (tileId === null && ancestor.hasAttribute?.(TILE_ATTRIBUTE)) {
                // A tile without an identity attribute cannot name its owner.
                continue;
            }
            for (const participant of participants) {
                const score = matchScore(ancestor, participant);
                if (score > 0 && score > (best.get(participant.id) ?? 0)) best.set(participant.id, score);
            }
        }

        if (best.size === 0) continue;

        const ranked = Array.from(best.entries()).sort((a, b) => b[1] - a[1]);
        const [winnerId, winnerScore] = ranked[0];
        // Two people scoring the same is not evidence of either.
        if (ranked.length > 1 && ranked[1][1] === winnerScore) continue;

        push(winnerId, {
            element: video,
            stream: video.srcObject as MediaStream,
            score: winnerScore,
            inTile: false
        });
    }

    return { liveVideos: videos.length, matched };
}

/**
 * Picks the one candidate to bind: Discord's own tile first, then the strongest
 * score, then document order. Two equally good pictures of one person are not a
 * conflict (a call can render the same stream in a tile and in a popout), so the
 * first is used rather than dropping the person from the scene.
 */
export function chooseVideo(candidates: readonly VideoMatch[]): VideoMatch | null {
    if (candidates.length === 0) return null;

    return [...candidates].sort((a, b) => {
        if (a.inTile !== b.inTile) return a.inTile ? -1 : 1;
        if (a.score !== b.score) return b.score - a.score;

        return 0;
    })[0];
}
