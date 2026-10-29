/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Spatial Voice — the scene.
 *
 * One React tree that turns the adapter's snapshot into the spatial view the
 * reference images describe: a decorative background, straight connector lines
 * from the real call-control bar, floating camera tiles, circular camera-off
 * avatars, and a page control when a call has more people than fit.
 *
 * It owns no Discord state. Participants come from {@link NativeCallSnapshot},
 * feeds from {@link SpatialSceneProps.videoFor}, positions from `computeSpatialLayout`
 * (layout.ts, w2), emphasis from `SpeakingHoldController` (speaking.ts, w3) and
 * lines from `createConnectorLayer` (connectors.ts, w4). The styling lives in
 * style.css (w5) which defines the DOM contract this file renders.
 *
 * Selection: Discord's own focused participant is read from the snapshot, never
 * written; a click in the scene sets a local override that survives layout
 * changes but is dropped the moment that person leaves or turns their camera off.
 */

import { openUserProfile } from "@utils/discord";
import { React } from "@webpack/common";
import type { CSSProperties } from "react";

import { ConnectorLayer, ConnectorParticipant, createConnectorLayer } from "./connectors";
import { computeSpatialLayout, SpatialLayoutItem, SpatialLayoutOptions, SpatialLayoutResult } from "./layout";
import { resolveSpeakingAppearance, SpeakingHoldController } from "./speaking";
import { buildSpatialSceneVariables, spatialSceneAttributes } from "./themes";
import { NativeParticipant, SpatialSceneDiagnostics, SpatialSceneProps, SpatialSettingsSnapshot } from "./types";

interface Size {
    width: number;
    height: number;
}

/** Reserved bands inside the scene: the channel header above, the control bar below. */
const HEADER_HEIGHT = 48;
const CONTROLS_HEIGHT = 96;

function clamp(value: number, low: number, high: number): number {
    return Math.min(Math.max(value, low), high);
}

/** Settings -> the numbers layout.ts consumes. Everything is derived, nothing is duplicated. */
function layoutOptions(settings: SpatialSettingsSnapshot, page: number): Partial<SpatialLayoutOptions> {
    // An avatar can only grow while the speaking enlargement is on; with it off
    // the cell reserves nothing extra.
    const speakingScale = settings.speakingAvatars ? settings.avatarScale / 100 : 1;

    return {
        selectedWidthRatio: clamp(settings.selectedWidth / 100, 0.3, 0.6),
        videoWidth: settings.videoSize,
        avatarSize: settings.avatarSize,
        gap: 2 + (settings.spacing / 100) * 62,
        maximumAvatarScale: settings.avoidCollisions ? clamp(speakingScale, 1, 3) : 1,
        headerHeight: HEADER_HEIGHT,
        controlsHeight: CONTROLS_HEIGHT,
        page
    };
}

function layoutParticipants(participants: readonly NativeParticipant[]) {
    return participants.map(participant => ({
        id: participant.id,
        kind: participant.cameraOn ? ("video" as const) : ("avatar" as const)
    }));
}

/**
 * The compact fallback used when automatic positioning is turned off: everyone in
 * the same evenly spaced grid inside the same scene, with the same tiles and
 * avatars. It is deliberately not the spatial engine.
 */
function compactLayout(size: Size, participants: readonly NativeParticipant[], settings: SpatialSettingsSnapshot): SpatialLayoutResult {
    const usableWidth = Math.max(0, size.width - 32);
    const usableHeight = Math.max(0, size.height - HEADER_HEIGHT - CONTROLS_HEIGHT - 16);
    const count = participants.length;

    if (count === 0 || usableWidth <= 0 || usableHeight <= 0) {
        return { items: [], overflowIds: [], pageCount: 1, page: 1, participantCount: count };
    }

    const columns = Math.max(1, Math.ceil(Math.sqrt(count * (usableWidth / Math.max(usableHeight, 1)))));
    const rows = Math.ceil(count / columns);
    const cellWidth = usableWidth / columns;
    const cellHeight = usableHeight / rows;
    const videoWidth = Math.max(48, Math.min(settings.videoSize, cellWidth - 16, (cellHeight - 24) * (16 / 9)));
    const videoHeight = videoWidth * (9 / 16);
    const avatarSize = Math.max(16, Math.min(settings.avatarSize, cellWidth - 16, cellHeight - 24));

    const items: SpatialLayoutItem[] = participants.map((participant, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const width = participant.cameraOn ? videoWidth : avatarSize;
        const height = participant.cameraOn ? videoHeight : avatarSize;

        return {
            id: participant.id,
            kind: participant.cameraOn ? "video" : "avatar",
            x: Math.round(column * cellWidth + (cellWidth - width) / 2),
            y: Math.round(HEADER_HEIGHT + row * cellHeight + (cellHeight - height) / 2),
            width: Math.round(width),
            height: Math.round(height),
            selected: false
        };
    });

    return { items, overflowIds: [], pageCount: 1, page: 1, participantCount: count };
}

/** A ref to any element; the scene's own ref is a div, so this must accept it. */
interface ElementRef {
    readonly current: HTMLElement | null;
}

function useElementSize(ref: ElementRef): Size {
    const [size, setSize] = React.useState<Size>({ width: 0, height: 0 });

    React.useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const measure = () => {
            const rect = element.getBoundingClientRect();
            setSize(previous =>
                Math.abs(previous.width - rect.width) < 1 && Math.abs(previous.height - rect.height) < 1
                    ? previous
                    : { width: rect.width, height: rect.height }
            );
        };

        measure();

        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);

        return () => observer.disconnect();
    }, [ref]);

    return size;
}

function useReducedMotion(): boolean {
    const [reduced, setReduced] = React.useState(false);

    React.useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

        const query = window.matchMedia("(prefers-reduced-motion: reduce)");
        const update = () => setReduced(query.matches);
        update();
        query.addEventListener("change", update);

        return () => query.removeEventListener("change", update);
    }, []);

    return reduced;
}

export function SpatialScene({
    call,
    settings,
    videoFor,
    controlsElement,
    onSelect,
    onDiagnostics
}: SpatialSceneProps) {
    const sceneRef = React.useRef<HTMLDivElement | null>(null);
    const size = useElementSize(sceneRef);
    const reducedMotion = useReducedMotion();

    const [page, setPage] = React.useState(1);
    const [chosenId, setChosenId] = React.useState<string | null>(null);
    const [emphasized, setEmphasized] = React.useState<readonly string[]>([]);

    const speakingController = React.useRef<SpeakingHoldController | null>(null);
    if (speakingController.current === null) {
        speakingController.current = new SpeakingHoldController({
            enabled: settings.speakingAvatars,
            holdMs: settings.holdSeconds * 1000
        });
    }

    const participantNodes = React.useRef(new Map<string, HTMLElement>());
    const videoNodes = React.useRef(new Map<string, HTMLVideoElement>());
    const avatarNodes = React.useRef(new Map<string, HTMLImageElement>());
    const connectorLayer = React.useRef<ConnectorLayer | null>(null);

    const { participants } = call;
    const cameraOnIds = React.useMemo(
        () => new Set(participants.filter(participant => participant.cameraOn).map(participant => participant.id)),
        [participants]
    );

    /* ------------------------------------------------------------ selection */

    const nativeSelected = call.selectedParticipantId;

    // Two different questions, deliberately kept apart:
    //   focusId    which camera the layout promotes — only a camera-on person can
    //              be promoted, because there is no picture to enlarge otherwise;
    //   markedId   which tile the user pointed at — any participant, so clicking a
    //              camera-off avatar gives the same visible feedback as a tile.
    // Tying the two together meant a click on an avatar was accepted, rejected by
    // the camera-on rule a render later, and left no trace at all.
    const chosenExists = chosenId !== null && participants.some(participant => participant.id === chosenId);

    React.useEffect(() => {
        if (chosenId !== null && !chosenExists) setChosenId(null);
    }, [chosenId, chosenExists]);

    const focusId = React.useMemo(() => {
        const candidate =
            chosenId && cameraOnIds.has(chosenId)
                ? chosenId
                : settings.layoutMode === "overview"
                    ? null
                    : nativeSelected;

        if (candidate && cameraOnIds.has(candidate)) return candidate;
        if (settings.layoutMode === "selected") {
            const first = participants.find(participant => participant.cameraOn);
            return first?.id ?? null;
        }

        return null;
    }, [chosenId, settings.layoutMode, nativeSelected, cameraOnIds, participants]);

    const selectedId = focusId;
    const markedId = chosenId ?? focusId;

    const select = (participantId: string | null) => {
        setChosenId(previous => (previous === participantId ? null : participantId));
        onSelect(participantId);
    };

    /* --------------------------------------------------------------- layout */

    const layout = React.useMemo(() => {
        if (size.width < 2 || size.height < 2) {
            return { items: [], overflowIds: [], pageCount: 1, page: 1, participantCount: participants.length };
        }

        if (!settings.autoPositioning) return compactLayout(size, participants, settings);

        return computeSpatialLayout({
            width: size.width,
            height: size.height,
            participants: layoutParticipants(participants),
            selectedId,
            options: layoutOptions(settings, page)
        });
    }, [size, participants, selectedId, settings, page]);

    const placedIds = React.useMemo(() => new Set(layout.items.map(item => item.id)), [layout]);

    /* ------------------------------------------------------------ speaking */

    React.useEffect(() => {
        speakingController.current?.configure({
            enabled: settings.speakingAvatars,
            holdMs: settings.holdSeconds * 1000
        });
    }, [settings.speakingAvatars, settings.holdSeconds]);

    React.useEffect(() => {
        const controller = speakingController.current;
        if (!controller) return;

        const unsubscribe = controller.subscribe(ids => {
            setEmphasized(previous =>
                previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids
            );
        });

        return () => {
            unsubscribe();
            controller.dispose();
            speakingController.current = null;
        };
    }, []);

    // One observation per participant per change. `lastSpoke` is Discord's own
    // activity stamp, so a long utterance keeps restarting the hold and a stop is
    // measured from when the participant actually stopped.
    const activitySignature = participants
        .map(participant => `${participant.id}:${participant.cameraOn ? 1 : 0}:${participant.speaking ? 1 : 0}:${participant.lastSpoke}`)
        .join("|");

    React.useEffect(() => {
        const controller = speakingController.current;
        if (!controller) return;

        controller.retainParticipants(participants.map(participant => participant.id));
        for (const participant of participants) {
            controller.updateParticipant({
                id: participant.id,
                cameraOn: participant.cameraOn,
                speaking: participant.speaking,
                activityTimestamp: participant.lastSpoke > 0 ? participant.lastSpoke : undefined
            });
        }
    }, [activitySignature]);

    const emphasizedSet = React.useMemo(() => new Set(emphasized), [emphasized]);

    /* ------------------------------------------------------------ connectors */

    React.useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;

        const layer = createConnectorLayer(scene, controlsElement, {
            visible: settings.showConnectors,
            opacity: settings.connectorOpacity / 100,
            width: settings.connectorWidth / 100,
            glow: settings.connectorGlow / 100,
            speakingHighlight: settings.connectorSpeakingHighlight / 100
        });

        // The layer paints itself at z-index 0, and style.css puts the SVG at 1 so
        // it sits above .sv-background (0) and below the participants (2). The
        // module's inline 0 overrides the stylesheet, and React mounts the
        // background after the SVG, so the gradient covered every line. Setting the
        // stacking order the stylesheet documents keeps the lines visible.
        if (layer.element) layer.element.style.zIndex = "1";

        connectorLayer.current = layer;

        return () => {
            layer.dispose();
            connectorLayer.current = null;
        };
    }, [controlsElement]);

    React.useEffect(() => {
        const layer = connectorLayer.current;
        if (!layer) return;

        layer.configure({
            visible: settings.showConnectors,
            opacity: settings.connectorOpacity / 100,
            width: settings.connectorWidth / 100,
            glow: settings.connectorGlow / 100,
            speakingHighlight: settings.connectorSpeakingHighlight / 100
        });

        const lines: ConnectorParticipant[] = [];
        for (const item of layout.items) {
            const element = participantNodes.current.get(item.id);
            if (!element) continue;
            const participant = participants.find(candidate => candidate.id === item.id);
            if (!participant) continue;

            lines.push({
                id: item.id,
                element,
                // A camera-off avatar grows through a transform on its image, which
                // the host's own rect does not report; the image is the visible edge.
                anchor: participant.cameraOn ? null : (avatarNodes.current.get(item.id) ?? null),
                cameraOn: participant.cameraOn,
                emphasized: emphasizedSet.has(item.id),
                shape: participant.cameraOn ? "rect" : "circle"
            });
        }

        layer.setParticipants(lines);
    }, [layout, emphasizedSet, participants, settings.showConnectors, settings.connectorOpacity, settings.connectorWidth, settings.connectorGlow, settings.connectorSpeakingHighlight]);

    /* ------------------------------------------------------------- binding */

    // Rebinding is what keeps the picture alive across a re-render: the stream is
    // Discord's, the element is ours, and one is simply pointed at the other.
    const streamSignature = participants
        .filter(participant => participant.cameraOn)
        .map(participant => `${participant.id}:${videoFor(participant.id) ? 1 : 0}`)
        .join("|");

    React.useEffect(() => {
        for (const [participantId, element] of videoNodes.current) {
            const stream = videoFor(participantId);
            if (element.srcObject === stream) continue;
            element.srcObject = stream ?? null;
            if (stream && typeof element.play === "function") {
                element.play().catch(() => {
                    /* autoplay refusal leaves the poster frame; nothing to recover here */
                });
            }
        }
    }, [streamSignature, layout]);

    /* --------------------------------------------------------- diagnostics */

    React.useEffect(() => {
        if (!onDiagnostics) return;
        onDiagnostics({
            width: Math.round(size.width),
            height: Math.round(size.height),
            page,
            pageCount: layout.pageCount,
            placed: layout.items.length,
            overflow: layout.overflowIds.length,
            emphasized: [...emphasized]
        });
    }, [onDiagnostics, size, page, layout, emphasized]);

    React.useEffect(() => {
        if (page > layout.pageCount) setPage(1);
    }, [layout.pageCount, page]);

    /* -------------------------------------------------------------- render */

    // One resolved appearance for the speaking enlargement: disabled resolves to
    // scale 1 and no glow, so turning the feature off cannot leave a stale ring.
    const speakingAppearance = React.useMemo(
        () =>
            resolveSpeakingAppearance({
                enabled: settings.speakingAvatars,
                scale: settings.avatarScale / 100,
                glow: settings.speakingGlow / 100,
                motionMs: settings.animationDuration
            }),
        [settings.speakingAvatars, settings.avatarScale, settings.speakingGlow, settings.animationDuration]
    );

    // Every visual setting style.css consumes, emitted by themes.ts, which owns
    // the bounds and the variable names. Writing them by hand here meant a theme
    // change moved `data-sv-theme` while the palette variables stayed at their
    // stylesheet defaults.
    const sceneVariables = React.useMemo(
        () =>
            buildSpatialSceneVariables({
                theme: settings.theme,
                backgroundIntensity: settings.backgroundIntensity / 100,
                particles: settings.particles,
                connectors: settings.showConnectors,
                connectorOpacity: settings.connectorOpacity / 100,
                connectorWidthPx: settings.connectorWidth / 100,
                connectorGlow: settings.connectorGlow / 100,
                speakingHighlight: settings.connectorSpeakingHighlight / 100,
                avatarSizePx: settings.avatarSize,
                avatarScale: speakingAppearance.scale,
                speakingGlow: speakingAppearance.glow,
                motionDurationMs: reducedMotion
                    ? 0
                    : Math.round(settings.animationDuration * (0.5 + settings.motionPercent / 100)),
                reducedMotion
            }),
        [
            settings.theme,
            settings.backgroundIntensity,
            settings.particles,
            settings.showConnectors,
            settings.connectorOpacity,
            settings.connectorWidth,
            settings.connectorGlow,
            settings.connectorSpeakingHighlight,
            settings.avatarSize,
            settings.motionPercent,
            settings.animationDuration,
            speakingAppearance.scale,
            speakingAppearance.glow,
            reducedMotion
        ]
    );

    const sceneAttributes = React.useMemo(() => spatialSceneAttributes({ theme: settings.theme }), [settings.theme]);

    const sceneStyle: CSSProperties & Record<string, string | number> = { ...sceneVariables };

    // Selection promotes a camera to the main panel, and the tiles that give it
    // room have to travel there instead of teleporting. style.css transitions
    // colour and opacity but not position or size, so the glide is set here, on
    // the two elements whose geometry the layout owns.
    const glideEasing = "cubic-bezier(0.22, 0.8, 0.24, 1)";
    const glideDuration = "var(--sv-motion-duration, 220ms)";
    const glideStyle: CSSProperties = {
        transition: `left ${glideDuration} ${glideEasing}, top ${glideDuration} ${glideEasing}, opacity ${glideDuration} ease, filter ${glideDuration} ease`
    };
    const panelGlideStyle: CSSProperties = {
        transition: `width ${glideDuration} ${glideEasing}, height ${glideDuration} ${glideEasing}, border-color ${glideDuration} ease, box-shadow ${glideDuration} ease`
    };

    const sceneWidth = Math.max(size.width, 1);
    const sceneHeight = Math.max(size.height, 1);

    return (
        <div
            ref={sceneRef}
            className="sv-scene"
            data-sv-theme={sceneAttributes["data-sv-theme"]}
            data-sv-scheme={sceneAttributes["data-sv-scheme"]}
            data-sv-active={settings.enabled ? "true" : "false"}
            aria-label={
                call.channelName
                    ? `Spatial view of ${call.channelName}, ${participants.length} ${participants.length === 1 ? "person" : "people"}`
                    : "Spatial voice view"
            }
            role="region"
            style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                ...sceneStyle
            }}
        >
            <div className="sv-background" aria-hidden="true" />

            {layout.items.map(item => {
                const participant = participants.find(candidate => candidate.id === item.id);
                if (!participant) return null;

                const marked = item.id === markedId;
                const emphasizedNow = emphasizedSet.has(item.id);
                const isSpeaking = participant.speaking;
                const stream = participant.cameraOn ? videoFor(item.id) : null;

                const label = [
                    participant.displayName,
                    participant.cameraOn ? "camera on" : "camera off",
                    participant.selfMuted ? "muted" : null,
                    marked ? "selected" : null,
                    isSpeaking ? "speaking" : null
                ]
                    .filter(Boolean)
                    .join(", ");

                const centerX = ((item.x + item.width / 2) / sceneWidth) * 100;
                const centerY = ((item.y + item.height / 2) / sceneHeight) * 100;

                return (
                    <div
                        key={item.id}
                        ref={element => {
                            if (element) participantNodes.current.set(item.id, element);
                            else participantNodes.current.delete(item.id);
                        }}
                        className="sv-participant"
                        data-sv-participant-id={item.id}
                        data-sv-selected={marked ? "true" : "false"}
                        data-sv-speaking={isSpeaking ? "true" : "false"}
                        data-sv-emphasized={emphasizedNow ? "true" : "false"}
                        role="button"
                        tabIndex={0}
                        aria-label={label}
                        aria-pressed={marked}
                        style={{ pointerEvents: "auto", left: `${centerX}%`, top: `${centerY}%`, ...glideStyle }}
                        // Capture phase: the video inside the tile is also decorated
                        // by another plugin, whose overlay swallows the click before it
                        // bubbles. A click on a tile must always select that person.
                        onClickCapture={() => select(item.id)}
                        onKeyDown={event => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                select(item.id);
                            }
                        }}
                        onContextMenu={event => {
                            event.preventDefault();
                            void openUserProfile(participant.userId).catch(() => {
                                /* the profile modal is Discord's; if it refuses, nothing changes here */
                            });
                        }}
                    >
                        {item.kind === "video" ? (
                            <div
                                className="sv-video"
                                data-sv-selected={marked ? "true" : "false"}
                                style={{ width: item.width, height: item.height, ...panelGlideStyle }}
                            >
                                {stream ? (
                                    <video
                                        ref={element => {
                                            if (element) videoNodes.current.set(item.id, element);
                                            else videoNodes.current.delete(item.id);
                                        }}
                                        muted
                                        autoPlay
                                        playsInline
                                    />
                                ) : (
                                    <img src={participant.avatarUrl ?? undefined} alt="" />
                                )}
                                {/*
                                 * A click surface of our own above the picture. The
                                 * video in a camera tile is also decorated by another
                                 * client plugin, whose overlay consumes the click, so a
                                 * click on the picture itself never reached this tile.
                                 * It carries no handler of its own: the participant's
                                 * capture handler already fires for any target inside,
                                 * and a second handler would toggle the choice twice.
                                 */}
                                <span
                                    className="sv-hit"
                                    aria-hidden="true"
                                    style={{ position: "absolute", inset: 0, zIndex: 2, cursor: "pointer" }}
                                />
                                {marked ? <span className="sv-badge">Live</span> : null}
                            </div>
                        ) : (
                            <div className="sv-avatar" style={{ width: item.width, height: item.height, ...panelGlideStyle }}>
                                <img
                                    className="sv-avatar-image"
                                    ref={element => {
                                        if (element) avatarNodes.current.set(item.id, element);
                                        else avatarNodes.current.delete(item.id);
                                    }}
                                    src={participant.avatarUrl ?? undefined}
                                    alt=""
                                />
                            </div>
                        )}

                        <span className="sv-label">{participant.displayName}</span>
                    </div>
                );
            })}

            {layout.pageCount > 1 ? (
                <div
                    style={{
                        position: "absolute",
                        left: "50%",
                        bottom: CONTROLS_HEIGHT + 8,
                        transform: "translateX(-50%)",
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        pointerEvents: "auto"
                    }}
                >
                    <button type="button" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page <= 1}>
                        Previous
                    </button>
                    <span className="sv-label">
                        {page} / {layout.pageCount}
                    </span>
                    <button
                        type="button"
                        onClick={() => setPage(current => Math.min(layout.pageCount, current + 1))}
                        disabled={page >= layout.pageCount}
                    >
                        Next
                    </button>
                </div>
            ) : null}
        </div>
    );
}

/** The participants the layout actually placed, for the adapter's page control. */
export function placedParticipantIds(layout: SpatialLayoutResult): string[] {
    return layout.items.map(item => item.id);
}

export type { SpatialSceneDiagnostics };
