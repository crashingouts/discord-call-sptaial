/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Spatial Voice — the native Discord adapter.
 *
 * Everything in this file talks to Discord; nothing in it draws. It answers
 * three questions for the scene:
 *
 *   1. who is really in the voice channel, and is their camera on
 *      (ChannelRTCStore.getParticipants — the store's own participant record);
 *   2. where is the real MediaStream for that person, so the scene can show the
 *      actual feed instead of a picture of one;
 *   3. where are Discord's own call view and call-control bar, so the scene can
 *      sit over the first and leave the second working;
 *   4. is Discord's real call view on screen, and where is it, so the scene is
 *      mounted there and nowhere else (callFocus.ts owns that rule, with the
 *      chevron that presses Discord's own fullscreen control).
 *
 * Evidence for each store call:
 *   packages/discord-types/src/stores/ChannelRTCStore.d.ts
 *     getParticipants, getSelectedParticipantId, getSpeakingParticipants
 *   packages/discord-types/src/stores/VoiceStateStore.d.ts
 *     getCurrentClientVoiceChannelId, getVoiceStatesForChannel
 *   src/webpack/common/stores.ts exports SelectedChannelStore, ChannelStore,
 *     SelectedGuildStore, UserStore, VoiceStateStore, ChannelRTCStore and
 *     useStateFromStores.
 *
 * Live feeds are found the way src/userplugins/discordDepth3d/engine.ts finds
 * them: "a `<video>` in the document whose `srcObject` is a stream with a video
 * track is somebody's camera or screen share. No class name, no React
 * internals". A participant's element is identified by the real user id that
 * appears in the avatar URL of the same tile (Discord's own CDN URL shape), with
 * the tile's accessible label as the second signal. No feed is ever invented: an
 * unmatched camera-on participant renders as an avatar and is listed in
 * diagnostics as unmatched.
 */

import {
    ChannelRTCStore,
    ChannelStore,
    createRoot,
    React,
    SelectedChannelStore,
    SelectedGuildStore,
    UserStore,
    useStateFromStores,
    VoiceStateStore
} from "@webpack/common";

import {
    CALL_TILE_ATTRIBUTE,
    CallFocusController,
    createCallFocusEnvironment,
    findCallView,
    GUILD_NAV_PREFIX
} from "./callFocus";
import {
    chooseVideo,
    findCallControls,
    findCallSurface,
    findTileGrid,
    matchLiveVideos,
    rectOf
} from "./runtimeDom";
import { readSettings, subscribeSettings } from "./settings";
import { SpatialScene } from "./SpatialScene";
import {
    DEFAULT_SPATIAL_SETTINGS,
    NativeCallSnapshot,
    NativeParticipant,
    NativeVideoDiagnostics,
    NativeVideoLookup,
    SpatialSceneDiagnostics,
    SpatialSettingsSnapshot
} from "./types";

/* ------------------------------------------------------------------ stores */

/** The participant record shape this adapter reads; see the header for evidence. */
interface RtcParticipant {
    id?: string;
    type?: unknown;
    user?: {
        id?: string;
        username?: string;
        globalName?: string | null;
        avatar?: string | null;
        avatarDecoration?: unknown;
    } | null;
    userNick?: string | null;
    speaking?: boolean;
    latched?: boolean;
    lastSpoke?: number;
    voiceDb?: number;
    localVideoDisabled?: boolean;
    userVideo?: boolean;
    streamId?: string;
    voiceState?: {
        userId?: string;
        selfVideo?: boolean;
        selfMute?: boolean;
        selfDeaf?: boolean;
        mute?: boolean;
        deaf?: boolean;
        channelId?: string | null;
    } | null;
}

interface RtcStore {
    getParticipants(channelId: string): RtcParticipant[];
    getSelectedParticipantId(channelId: string): string | null;
}

interface VoiceStateStoreLike {
    getCurrentClientVoiceChannelId(guildId: string | null): string | undefined;
}

function rtc(): RtcStore | null {
    return (ChannelRTCStore as unknown as RtcStore) ?? null;
}

function currentUserId(): string | null {
    try {
        return UserStore.getCurrentUser()?.id ?? null;
    } catch {
        return null;
    }
}

/**
 * Discord's own avatar URL rules: a custom avatar lives at
 * `/avatars/<id>/<hash>.<ext>`, and a user without one gets one of the six
 * default embed avatars chosen by `(id >> 22) % 6`. Both are Discord CDN paths,
 * so the resulting image is the real avatar, not a stand-in.
 */
export function avatarUrl(user: RtcParticipant["user"]): string | null {
    const id = user?.id;
    if (!id) return null;

    const hash = user?.avatar;
    if (hash) {
        const extension = hash.startsWith("a_") ? "gif" : "png";
        return `https://cdn.discordapp.com/avatars/${id}/${hash}.${extension}?size=128`;
    }

    try {
        const index = Number((BigInt(id) >> 22n) % 6n);
        return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    } catch {
        return null;
    }
}

function displayNameOf(participant: RtcParticipant): string {
    const { user } = participant;
    return (
        participant.userNick ||
        user?.globalName ||
        user?.username ||
        "Unknown participant"
    );
}

/** A camera feed is on when the voice state says so and this client has not turned it off. */
function cameraOn(participant: RtcParticipant): boolean {
    if (participant.localVideoDisabled) return false;
    if (participant.userVideo === true) return true;
    return participant.voiceState?.selfVideo === true;
}

/**
 * The voice channel to render: the selected channel when a call is running in
 * it, otherwise the channel this client is actually connected to (a call can
 * stay joined while the user browses another channel).
 */
export function resolveVoiceChannelId(): string | null {
    const selected = SelectedChannelStore?.getChannelId?.() ?? null;
    const store = rtc();

    if (selected && store && store.getParticipants(selected).length > 0) return selected;

    try {
        const guildId = SelectedGuildStore?.getGuildId?.() ?? null;
        const connected = (VoiceStateStore as unknown as VoiceStateStoreLike).getCurrentClientVoiceChannelId(guildId);
        if (connected) return connected;
    } catch {
        /* not in a call */
    }

    return selected;
}

export function readCallSnapshot(): NativeCallSnapshot {
    const channelId = resolveVoiceChannelId();
    const empty: NativeCallSnapshot = {
        channelId: null,
        channelName: null,
        participants: [],
        selectedParticipantId: null
    };

    if (!channelId) return empty;

    const store = rtc();
    const self = currentUserId();
    let raw: RtcParticipant[] = [];
    try {
        raw = store?.getParticipants(channelId) ?? [];
    } catch {
        raw = [];
    }

    const participants: NativeParticipant[] = [];
    for (const participant of raw) {
        // Person tiles carry a voiceState; stream and activity tiles do not.
        if (!participant || !participant.voiceState) continue;
        const userId = participant.user?.id ?? participant.voiceState.userId ?? participant.id;
        if (!userId) continue;

        const id = participant.id ?? userId;
        participants.push({
            id,
            userId,
            displayName: displayNameOf(participant),
            avatarUrl: avatarUrl(participant.user),
            cameraOn: cameraOn(participant),
            speaking: participant.speaking === true || participant.latched === true,
            lastSpoke: typeof participant.lastSpoke === "number" ? participant.lastSpoke : 0,
            selfMuted: participant.voiceState?.selfMute === true || participant.voiceState?.mute === true,
            selfDeafened: participant.voiceState?.selfDeaf === true || participant.voiceState?.deaf === true,
            isSelf: self !== null && userId === self,
            streamId: participant.streamId ?? null
        });
    }

    let selectedParticipantId: string | null = null;
    try {
        selectedParticipantId = store?.getSelectedParticipantId(channelId) ?? null;
    } catch {
        selectedParticipantId = null;
    }

    let channelName: string | null = null;
    try {
        channelName = ChannelStore?.getChannel?.(channelId)?.name ?? null;
    } catch {
        channelName = null;
    }

    return { channelId, channelName, participants, selectedParticipantId };
}

/**
 * Discord's participant list for the call the user is in, re-read whenever the
 * participant store or the voice state changes. Nothing here polls.
 */
export function useNativeCall(active: boolean): NativeCallSnapshot {
    const snapshot = useStateFromStores(
        [SelectedChannelStore, ChannelRTCStore, VoiceStateStore],
        () => (active ? readCallSnapshot() : null),
        [active]
    );

    return (
        snapshot ?? {
            channelId: null,
            channelName: null,
            participants: [],
            selectedParticipantId: null
        }
    );
}

/** The resolved settings, kept current through the plugin's own change channel. */
export function useSpatialSettings(): SpatialSettingsSnapshot {
    const [snapshot, setSnapshot] = React.useState<SpatialSettingsSnapshot>(() => readSettings());

    React.useEffect(() => {
        setSnapshot(readSettings());

        return subscribeSettings(setSnapshot);
    }, []);

    return snapshot ?? DEFAULT_SPATIAL_SETTINGS;
}

/* ------------------------------------------------------------ live videos */

/**
 * Owns the participant <- video element map. It never copies pixels and never
 * touches Discord's stream: the scene binds the same `MediaStream` to its own
 * `<video>`, which is a second view of one stream, so there is no new WebRTC
 * connection, no second camera capture and no change of ownership.
 *
 * Matching itself lives in runtimeDom.ts, where the live rules are tested: the
 * tile's own `data-selenium-video-tile` id identifies a person exactly, and the
 * avatar/label scores are only a fallback for markup that carries no id.
 */
export class NativeVideoRegistry {
    private readonly streams = new Map<string, MediaStream>();
    private readonly elements = new Map<string, HTMLVideoElement>();
    private diagnostics: NativeVideoDiagnostics = {
        liveVideos: 0,
        matched: 0,
        unmatchedCameraOn: [],
        ambiguous: []
    };

    get current(): NativeVideoDiagnostics {
        return this.diagnostics;
    }

    /** The stream for a participant, or null when no live element carries one. */
    readonly lookup: NativeVideoLookup = (participantId: string) => this.streams.get(participantId) ?? null;

    /** The element currently carrying that participant's feed, for diagnostics. */
    elementFor(participantId: string): HTMLVideoElement | null {
        return this.elements.get(participantId) ?? null;
    }

    scan(doc: Document, participants: readonly NativeParticipant[]) {
        const { liveVideos, matched } = matchLiveVideos(doc, participants);

        this.streams.clear();
        this.elements.clear();

        const ambiguous: string[] = [];
        for (const [participantId, candidates] of matched) {
            const chosen = chooseVideo(candidates);
            if (!chosen) continue;
            // Same score, same standing: two pictures of one person that the
            // rules cannot tell apart. The feed is still used (dropping the
            // person would be worse), and the tie is reported here.
            const rival = candidates.find(candidate => candidate !== chosen);
            if (rival && rival.score === chosen.score && rival.inTile === chosen.inTile) ambiguous.push(participantId);

            this.streams.set(participantId, chosen.stream);
            this.elements.set(participantId, chosen.element);
        }

        const unmatchedCameraOn = participants
            .filter(participant => participant.cameraOn && !this.streams.has(participant.id))
            .map(participant => participant.id);

        this.diagnostics = {
            liveVideos,
            matched: this.streams.size,
            unmatchedCameraOn,
            ambiguous
        };
    }

    clear() {
        this.streams.clear();
        this.elements.clear();
        this.diagnostics = { liveVideos: 0, matched: 0, unmatchedCameraOn: [], ambiguous: [] };
    }
}

/**
 * Keeps the registry in step with the call while the scene is on screen: rescans
 * when participants change, when a picture element appears, and on a slow tick
 * (a stream can arrive on an element that already existed). Every listener and
 * timer is removed on unmount, on disable, and when the channel is left.
 */
export function useNativeVideos(
    call: NativeCallSnapshot,
    active: boolean
): { videoFor: NativeVideoLookup; diagnostics: NativeVideoDiagnostics } {
    const registry = React.useRef<NativeVideoRegistry | null>(null);
    if (registry.current === null) registry.current = new NativeVideoRegistry();

    const [, bump] = React.useReducer((version: number) => version + 1, 0);
    // Identity and camera state, not speaking: a speaking flip does not move a
    // stream, and rebuilding the observers on every syllable would be waste.
    const callSignature = call.participants
        .map(participant => `${participant.id}:${participant.cameraOn ? 1 : 0}`)
        .sort()
        .join(",");

    React.useEffect(() => {
        const { current } = registry;
        if (!current) return;

        if (!active || call.participants.length === 0) {
            current.clear();
            bump();

            return;
        }

        let lastSignature = "";
        let frame = 0;
        let observer: MutationObserver | null = null;

        const scan = () => {
            frame = 0;
            current.scan(document, call.participants);
            const signature = `${current.current.matched}:${current.current.liveVideos}:${current.current.unmatchedCameraOn.join(",")}`;
            if (signature !== lastSignature) {
                lastSignature = signature;
                bump();
            }
        };

        // The document mutates far more often than a stream changes; one scan per
        // frame is enough and it keeps a busy call off the main path.
        const scheduleScan = () => {
            if (frame !== 0) return;
            frame = window.requestAnimationFrame(scan);
        };

        scan();

        const timer = window.setInterval(scheduleScan, 1000);
        if (typeof MutationObserver !== "undefined") {
            observer = new MutationObserver(scheduleScan);
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }

        return () => {
            if (frame !== 0) window.cancelAnimationFrame(frame);
            window.clearInterval(timer);
            observer?.disconnect();
            current.clear();
        };
    }, [active, call.channelId, callSignature]);

    return {
        videoFor: registry.current.lookup,
        diagnostics: registry.current.current
    };
}

/* --------------------------------------------------------- native chrome */

// findCallControls, findTileGrid and findCallSurface live in runtimeDom.ts so
// the rules that were tuned against a live call can be tested without a client.
// They are re-exported here because this module is the adapter's front door.
export { findCallControls, findCallSurface, findTileGrid };

/** Sets or clears a visual hide on Discord's own node, remembering what was there. */
export function setNativeHidden(element: HTMLElement | null, hidden: boolean) {
    if (!element) return;
    const store = element as HTMLElement & { __svHiddenBy?: string };

    if (hidden) {
        if (store.__svHiddenBy === undefined) store.__svHiddenBy = element.style.visibility;
        element.style.visibility = "hidden";
    } else if (store.__svHiddenBy !== undefined) {
        element.style.visibility = store.__svHiddenBy;
        delete store.__svHiddenBy;
    }
}

/** Applies or removes the scene's control-bar class on Discord's real bar. */
export function setControlsRestyle(element: HTMLElement | null, restyle: boolean) {
    if (!element) return;
    const store = element as HTMLElement & { __svZIndex?: string };

    element.classList.toggle("sv-controls", restyle);

    // The bar has to paint over the scene it floats on. Whatever stacking number
    // Discord gave it is remembered and put back when the plugin stops.
    if (restyle) {
        if (store.__svZIndex === undefined) store.__svZIndex = element.style.zIndex;
        element.style.zIndex = "3";
    } else if (store.__svZIndex !== undefined) {
        element.style.zIndex = store.__svZIndex;
        delete store.__svZIndex;
    }
}

/* --------------------------------------------------------------- the host */

export interface SpatialHost {
    /** Looks for the call view again, e.g. after Discord swapped the whole voice view out. */
    refresh(): void;
    destroy(): void;
}

/**
 * What the adapter hands {@link findCallView} for one look: Discord's own
 * markers, queried here because this file is where Discord is known, and judged
 * in callFocus.ts because that is where the rules are tested.
 */
function readCallViewLookup() {
    return {
        tiles: Array.from(document.querySelectorAll(`[${CALL_TILE_ATTRIBUTE}]`)),
        buttons: Array.from(document.querySelectorAll('button, [role="button"]')),
        controls: findCallControls(document),
        guildNavs: Array.from(document.querySelectorAll(`[data-list-item-id^="${GUILD_NAV_PREFIX}"]`))
    };
}

/**
 * Mounts the scene inside Discord's own call view, and nothing anywhere else.
 *
 * The host div is absolutely positioned inside the call view, above the tile
 * grid and below Discord's control bar in the stacking order. Discord's grid
 * keeps rendering underneath (it is only made invisible while the scene covers
 * it), so a live call is never torn down, and the control bar is never moved.
 *
 * When the call view is not on screen — the Friends page, a text channel, a
 * mini player beside a conversation — the host is taken out of the document and
 * the scene is unmounted. That is what keeps the scene off Discord's other
 * pages: a joined call on its own is not a call view.
 */
export function mountSpatialHost(): SpatialHost {
    const host = document.createElement("div");
    host.className = "sv-host";
    host.setAttribute("data-sv-host", "");
    host.style.position = "absolute";
    host.style.inset = "0";
    host.style.zIndex = "1";
    host.style.pointerEvents = "none";

    const focusEnvironment = createCallFocusEnvironment(rectOf);
    const focus = new CallFocusController(focusEnvironment);

    let surface: HTMLElement | null = null;
    let surfacePosition: { had: boolean; value: string } | null = null;
    let grid: HTMLElement | null = null;
    let controls: HTMLElement | null = null;

    let root: ReturnType<typeof createRoot> | null = null;
    let destroyed = false;
    let scheduled = 0;

    /** Puts back the call view's own inline position, when this module wrote one. */
    const releaseSurface = () => {
        if (!surface || !surfacePosition) return;

        surface.style.position = surfacePosition.had ? surfacePosition.value : "";
        surfacePosition = null;
    };

    /** Takes the scene out of whatever it was in, on a page that is not the call view. */
    const unmountScene = () => {
        if (root) root.unmount();
        root = null;

        setNativeHidden(grid, false);
        setControlsRestyle(controls, false);
        host.remove();

        releaseSurface();

        surface = null;
        grid = null;
        controls = null;
    };

    const attach = () => {
        if (destroyed) return;

        const channelId = resolveVoiceChannelId();
        const view = findCallView(focusEnvironment, readCallViewLookup());

        if (!view) {
            unmountScene();
            // No call view: no chevron, and a fullscreen this module turned on
            // is handed back through Discord's own control.
            focus.sync({ channelId, view: null });

            return;
        }

        let shouldRender = root === null;

        if (view.surface !== surface || host.parentElement !== surface) {
            unmountScene();

            surface = view.surface;
            surfacePosition = { had: surface.style.position !== "", value: surface.style.position };
            if (getComputedStyle(surface).position === "static") surface.style.position = "relative";
            surface.appendChild(host);
            // The scene has to be rendered into the new host: the old root left
            // with the old call view.
            shouldRender = true;
        }

        if (view.grid !== grid) {
            setNativeHidden(grid, false);
            grid = view.grid;
        }

        // Hiding the element the scene is mounted in would hide the scene too.
        // That cannot happen while the surface is an ancestor of the grid, and the
        // guard makes it impossible to regress silently if a client nests them.
        if (grid && surface && (grid === surface || grid.contains(surface))) {
            setNativeHidden(grid, false);
            grid = null;
        } else {
            setNativeHidden(grid, true);
        }

        const nextControls = view.controls;
        if (nextControls !== controls) {
            setControlsRestyle(controls, false);
            controls = nextControls;
            shouldRender = true;
        }
        setControlsRestyle(controls, readSettings().restyleControls);

        // The chevron is mounted only for a real call view, and it reports the
        // class Discord put on the call, so Escape and Discord's own control
        // keep it in step.
        focus.sync({ channelId, view });

        // The scene is told about the real control bar so its connectors start at
        // that bar's measured top edge; a new bar means one new render, not a
        // remount of the call.
        if (shouldRender) {
            if (root === null) root = createRoot(host);
            root.render(<SpatialSceneHost controls={controls} />);
        }
    };

    // The document mutates constantly; one look per frame is enough, and it keeps
    // a busy call from measuring the whole tree on every React commit.
    const attachSoon = () => {
        if (destroyed || scheduled !== 0) return;
        scheduled = window.requestAnimationFrame(() => {
            scheduled = 0;
            attach();
        });
    };

    const unsubscribe = subscribeSettings(snapshot => {
        setControlsRestyle(controls, snapshot.restyleControls);
        if (!snapshot.enabled) {
            unmountScene();
            // The scene's switch turns the whole view off, chevron included.
            focus.suspend();
        } else {
            attach();
        }
    });

    attach();

    // The call view is replaced on every channel change and when the window is
    // resized between the call and the grid layouts, so it is looked for again.
    const observer = new MutationObserver(() => attachSoon());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const onResize = () => attachSoon();
    window.addEventListener("resize", onResize);

    const onVisibility = () => {
        if (!document.hidden) attachSoon();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return {
        refresh() {
            attach();
        },

        destroy() {
            destroyed = true;
            if (scheduled !== 0) window.cancelAnimationFrame(scheduled);
            scheduled = 0;
            unsubscribe();
            observer.disconnect();
            window.removeEventListener("resize", onResize);
            document.removeEventListener("visibilitychange", onVisibility);

            unmountScene();

            // Removes the chevron and returns Discord's own view if this module
            // was the one that expanded it.
            focus.destroy();
        }
    };
}

/**
 * The React boundary between the adapter and the scene. It owns nothing that is
 * drawn: it reads the stores, resolves feeds and hands both to {@link SpatialScene}.
 */
function SpatialSceneHost({ controls }: { controls: HTMLElement | null }) {
    const settings = useSpatialSettings();
    const call = useNativeCall(settings.enabled);
    const { videoFor, diagnostics } = useNativeVideos(call, settings.enabled);

    // Discord's focused camera, kept for diagnostics and for the initial state.
    React.useEffect(() => {
        if (diagnostics.matched > 0 || diagnostics.unmatchedCameraOn.length > 0) {
            (window as unknown as Record<string, unknown>).__spatialVoiceVideo = diagnostics;
        }
    }, [diagnostics]);

    // The scene reports what it placed and how many pages it needed. A stable
    // callback keeps that a read, not a re-render loop; the value is published on
    // the window next to the video diagnostics so a live call can be inspected.
    const publishScene = React.useCallback((scene: SpatialSceneDiagnostics) => {
        (window as unknown as Record<string, unknown>).__spatialVoiceScene = scene;
    }, []);

    return (
        <SpatialScene
            call={call}
            settings={settings}
            videoFor={videoFor}
            controlsElement={controls}
            onDiagnostics={publishScene}
            onSelect={() => {
                /* selection lives in the scene; Discord's own focus is read, not written */
            }}
        />
    );
}
