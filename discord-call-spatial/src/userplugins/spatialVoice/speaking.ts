/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Spatial Voice contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Framework-neutral speaking-hold state for the Spatial Voice plugin.
 *
 * The controller owns one rule: a camera-off participant is "emphasized" while
 * Discord reports them speaking, and for `holdMs` (10 s by default) after the
 * last genuine speaking activity. Camera-on participants are never emphasized,
 * each participant holds independently, and every participant has at most one
 * pending timer.
 *
 * How `speaking` and `activityTimestamp` are interpreted
 * -----------------------------------------------------
 * `speaking` is the integration layer's read of Discord's genuine speaking
 * state, never a guess derived from mute state or a microphone icon. Discord
 * exposes that state as a roster of the participants it is currently marking
 * as speaking for the channel (the `ChannelRTCStore` Vencord re-exports from
 * `@webpack/common` holds it); reading it is the scene's job, because only the
 * scene knows the channel. This module never reads it, requests no media and
 * listens to no audio. What it can rely on is narrower than it looks: the
 * roster is a set of ids with no per-participant timestamp, so:
 *
 * - a `false -> true` transition is a new activity: the hold restarts at the
 *   clock's now (or at `activityTimestamp` when supplied);
 * - a repeated `true` with no transition and no timestamp is the same activity
 *   continuing, so it neither extends nor shortens the window (and, because a
 *   speaking participant never expires, continuous speech keeps emphasis for
 *   as long as it lasts);
 * - a repeated `true` with an `activityTimestamp` newer than the last one seen
 *   is new activity and restarts the hold (an integration layer that samples
 *   the roster on an interval can pass its sample time this way);
 * - a `true -> false` transition ends the activity: the inactivity interval
 *   starts at that moment, so the participant stays emphasized for the full
 *   `holdMs` after they stop, then shrinks;
 * - an older `activityTimestamp` is ignored, so out-of-order samples cannot
 *   pull the hold backwards;
 * - `activityTimestamp` on a `speaking: false` update is ignored; the stop is
 *   timed from the clock;
 * - a `cameraOn: true` observation contributes no speaking activity at all, so
 *   a participant who talks on camera and then turns the camera off does not
 *   pop up enlarged for speech this feature never tracked. If they are still
 *   speaking when the camera goes off, that observation is a speaking start.
 *
 * While the controller is disabled it still records camera and speaking state
 * (no timers, no emphasis), so re-enabling can reconcile immediately: whoever
 * is speaking at that moment is emphasized at once.
 *
 * Known limitations, all inherited from the roster:
 * -----------------------------------------------
 * - The roster says who is speaking, not when they stopped, so a stop is only
 *   observed when the scene next samples. The hold is timed from that
 *   observation, which can run up to one sampling interval past the real stop.
 * - A stop and a restart between two samples look like continuous speech: the
 *   participant stays emphasized, which is the same thing the user sees anyway.
 * - Speaking state is Discord's own; when Discord reports nobody (deafened
 *   client, missing permissions, RTC unavailable) no avatar is emphasized. The
 *   feature degrades to "small avatar" rather than guessing.
 *
 * Scene wiring (the scene owns this; this module only supplies state)
 * -------------------------------------------------------------------
 * - The controller is per call: build one when the plugin attaches to a voice
 *   channel, feed every participant every sample, call `configure` whenever the
 *   settings change, `retainParticipants` or `removeParticipant` on the roster
 *   diff, and `dispose` when the plugin detaches or the channel changes.
 * - Only a camera-off participant can appear in `getEmphasizedIds()`. A scene
 *   sets `data-sv-speaking` from Discord's roster and `data-sv-emphasized` from
 *   this controller; style.css scales only `.sv-avatar-image` on either, so the
 *   wrapper, the label and the connector anchor never move.
 * - `resolveSpeakingAppearance` gives the numbers style.css reads as
 *   `--sv-avatar-scale` (default 1.4) and `--sv-speaking-glow`; the scene writes
 *   them inline on `.sv-scene`. Layout is separate: the scene passes the same
 *   scale as the layout engine's `maximumAvatarScale` so the reserved cell is
 *   big enough for the enlarged avatar.
 *
 * The controller requests no media and calls no Discord API. It is a pure
 * state machine over the inputs the integration layer feeds it.
 */

export const DEFAULT_HOLD_MS = 10_000;

/** Speaking enlargement defaults, matching style.css's own defaults. */
export const DEFAULT_AVATAR_SCALE = 1.4;
export const DEFAULT_SPEAKING_GLOW = 0.75;
export const DEFAULT_MOTION_MS = 220;
/** An "enlargement" below 1 would shrink the avatar; above 2 it swallows the scene. */
export const MIN_AVATAR_SCALE = 1;
export const MAX_AVATAR_SCALE = 2;

/** The enlargement half of the plugin's settings, as the scene reads them. */
export interface SpeakingAppearanceSettings {
    /** Speaking-based enlargement on or off. Defaults to true. */
    enabled?: boolean;
    /** Enlarged avatar scale, default {@link DEFAULT_AVATAR_SCALE}, clamped to 1..2. */
    scale?: number;
    /** Ring and halo strength, 0..1, default {@link DEFAULT_SPEAKING_GLOW}. */
    glow?: number;
    /** Emphasis transition length in ms, default {@link DEFAULT_MOTION_MS}, clamped to 0..1000. */
    motionMs?: number;
}

export interface SpeakingAppearance {
    enabled: boolean;
    /** 1 while enlargement is disabled, so the avatar keeps its normal size. */
    scale: number;
    /** 0 while enlargement is disabled, so no ring or glow is drawn. */
    glow: number;
    motionMs: number;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

/**
 * Normalises the enlargement settings into the numbers style.css consumes:
 * `--sv-avatar-scale` and `--sv-speaking-glow`, plus the emphasis transition
 * length. Pure and total: junk values fall back to the defaults, and disabling
 * enlargement resolves to scale 1 with no glow, so a stale setting can never
 * leave a camera-off avatar enlarged.
 */
export function resolveSpeakingAppearance(settings: SpeakingAppearanceSettings = {}): SpeakingAppearance {
    const enabled = typeof settings?.enabled === "boolean" ? settings.enabled : true;
    const scale = clampNumber(settings?.scale, MIN_AVATAR_SCALE, MAX_AVATAR_SCALE, DEFAULT_AVATAR_SCALE);
    const glow = clampNumber(settings?.glow, 0, 1, DEFAULT_SPEAKING_GLOW);
    const motionMs = clampNumber(settings?.motionMs, 0, 1_000, DEFAULT_MOTION_MS);

    return {
        enabled,
        scale: enabled ? scale : 1,
        glow: enabled ? glow : 0,
        motionMs
    };
}

/** Whatever an injected timer implementation hands back for a scheduled callback. */
export type TimerHandle = unknown;

/** Injectable time source, so tests can run on a fake clock. */
export interface SpeakingClock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
}

export interface SpeakingHoldOptions {
    /** Defaults to true. */
    enabled?: boolean;
    /** Defaults to {@link DEFAULT_HOLD_MS}. Negative values clamp to 0, non-finite values fall back to the default. */
    holdMs?: number;
    /** Overrides any part of the clock; the rest falls back to the global timers. */
    clock?: Partial<SpeakingClock>;
}

export interface SpeakingHoldSettings {
    enabled?: boolean;
    holdMs?: number;
}

export interface SpeakingActivity {
    id: string;
    cameraOn: boolean;
    speaking: boolean;
    /** Optional sample time of this observation; see the header for how it is used. */
    activityTimestamp?: number;
}

export type SpeakingHoldListener = (emphasizedIds: readonly string[]) => void;

interface ParticipantEntry {
    cameraOn: boolean;
    speaking: boolean;
    hasActivity: boolean;
    /** Clock time (or supplied timestamp) of the last genuine speaking activity. */
    lastActivityAt: number;
    emphasized: boolean;
    timer: TimerHandle | null;
}

const systemClock: SpeakingClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

function normaliseHoldMs(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.max(0, value);
}

export class SpeakingHoldController {
    private readonly clock: SpeakingClock;
    private enabled: boolean;
    private holdMs: number;
    private disposed = false;

    private readonly entries = new Map<string, ParticipantEntry>();
    private readonly listeners = new Set<SpeakingHoldListener>();
    private readonly emphasized = new Set<string>();
    private dirty = false;

    constructor(options: SpeakingHoldOptions = {}) {
        const clock = options.clock ?? {};
        this.clock = {
            now: typeof clock.now === "function" ? clock.now.bind(clock) : systemClock.now,
            setTimeout: typeof clock.setTimeout === "function" ? clock.setTimeout.bind(clock) : systemClock.setTimeout,
            clearTimeout: typeof clock.clearTimeout === "function" ? clock.clearTimeout.bind(clock) : systemClock.clearTimeout
        };
        this.enabled = typeof options.enabled === "boolean" ? options.enabled : true;
        this.holdMs = normaliseHoldMs(options.holdMs) ?? DEFAULT_HOLD_MS;
    }

    /** Applies new settings immediately, reconciling every participant already tracked. */
    configure(settings: SpeakingHoldSettings): void {
        if (this.disposed || !settings) return;

        let changed = false;
        if (typeof settings.enabled === "boolean" && settings.enabled !== this.enabled) {
            this.enabled = settings.enabled;
            changed = true;
        }

        const holdMs = normaliseHoldMs(settings.holdMs);
        if (holdMs !== undefined && holdMs !== this.holdMs) {
            this.holdMs = holdMs;
            changed = true;
        }

        if (!changed) return;

        const now = this.clock.now();
        for (const [id, entry] of this.entries) this.reconcile(id, entry, now);
        this.flush();
    }

    /**
     * Feeds one observation for one participant. A speaking start, a speaking
     * stop and a newer activity timestamp are the only things that move the
     * hold; a camera change re-evaluates emphasis immediately.
     */
    updateParticipant(activity: SpeakingActivity): void {
        if (this.disposed || !activity) return;

        const id = activity.id;
        if (typeof id !== "string" || id === "") return;

        const now = this.clock.now();
        let entry = this.entries.get(id);
        if (!entry) {
            entry = {
                cameraOn: false,
                speaking: false,
                hasActivity: false,
                lastActivityAt: 0,
                emphasized: false,
                timer: null
            };
            this.entries.set(id, entry);
        }

        const cameraOn = Boolean(activity.cameraOn);
        const speaking = Boolean(activity.speaking);
        const stamp = typeof activity.activityTimestamp === "number" && Number.isFinite(activity.activityTimestamp)
            ? activity.activityTimestamp
            : undefined;

        if (cameraOn) {
            // Camera-on tiles are out of scope, so their speech never starts a hold.
            entry.speaking = false;
            entry.hasActivity = false;
            entry.lastActivityAt = 0;
        } else {
            const wasSpeaking = entry.speaking;
            if (speaking) {
                const isNewActivity = !wasSpeaking || (stamp !== undefined && (!entry.hasActivity || stamp > entry.lastActivityAt));
                if (isNewActivity) this.markActivity(entry, stamp ?? now);
            } else if (wasSpeaking) {
                // The inactivity interval starts when the participant stops speaking.
                this.markActivity(entry, now);
            }

            entry.speaking = speaking;
        }

        entry.cameraOn = cameraOn;

        this.reconcile(id, entry, now);
        this.flush();
    }

    /**
     * Forgets one participant and cancels its timer: the departure path. Returns
     * true when the participant was tracked. Safe to call for an unknown id.
     */
    removeParticipant(id: string): boolean {
        if (this.disposed || typeof id !== "string") return false;

        const entry = this.entries.get(id);
        if (!entry) return false;

        this.cancelTimer(entry);
        entry.emphasized = false;
        this.entries.delete(id);
        if (this.emphasized.delete(id)) this.dirty = true;

        this.flush();
        return true;
    }

    /** Drops every participant not in `ids`, cancelling their timers. Safe to call repeatedly. */
    retainParticipants(ids: Iterable<string>): void {
        if (this.disposed) return;

        const keep = new Set<string>();
        for (const id of ids) if (typeof id === "string") keep.add(id);

        for (const [id, entry] of this.entries) {
            if (keep.has(id)) continue;
            this.cancelTimer(entry);
            entry.emphasized = false;
            this.entries.delete(id);
            if (this.emphasized.delete(id)) this.dirty = true;
        }

        this.flush();
    }

    /** True while this participant is a camera-off speaker inside the hold window. */
    isEmphasized(id: string): boolean {
        return !this.disposed && this.emphasized.has(id);
    }

    /** Every currently emphasized participant, in the order emphasis began. */
    getEmphasizedIds(): string[] {
        return [...this.emphasized];
    }

    /**
     * Listens for emphasis changes only: the callback fires when the set of
     * emphasized participants changes, never for camera or speaking updates
     * that leave that set alone. Returns an unsubscribe function.
     */
    subscribe(listener: SpeakingHoldListener): () => void {
        if (this.disposed || typeof listener !== "function") return () => { };

        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /** Cancels every timer, forgets every participant and silences listeners. Idempotent. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        for (const entry of this.entries.values()) this.cancelTimer(entry);
        this.entries.clear();
        this.emphasized.clear();
        this.listeners.clear();
        this.dirty = false;
    }

    private markActivity(entry: ParticipantEntry, candidate: number): void {
        entry.lastActivityAt = entry.hasActivity ? Math.max(entry.lastActivityAt, candidate) : candidate;
        entry.hasActivity = true;
    }

    private reconcile(id: string, entry: ParticipantEntry, now: number): void {
        const active = this.enabled
            && !entry.cameraOn
            && (entry.speaking || (entry.hasActivity && now - entry.lastActivityAt < this.holdMs));

        if (!active) {
            this.cancelTimer(entry);
            this.setEmphasized(id, entry, false);
            return;
        }

        this.setEmphasized(id, entry, true);
        this.cancelTimer(entry);

        // Continuous speech never expires, and needs no timer to prove it.
        if (entry.speaking) return;

        this.scheduleExpiry(id, entry, entry.lastActivityAt + this.holdMs - now);
    }

    private scheduleExpiry(id: string, entry: ParticipantEntry, delayMs: number): void {
        entry.timer = this.clock.setTimeout(() => { this.handleExpiry(id); }, Math.max(0, delayMs));
    }

    private handleExpiry(id: string): void {
        if (this.disposed) return;

        const entry = this.entries.get(id);
        if (!entry) return;

        entry.timer = null;
        this.reconcile(id, entry, this.clock.now());
        this.flush();
    }

    private cancelTimer(entry: ParticipantEntry): void {
        if (entry.timer === null) return;
        this.clock.clearTimeout(entry.timer);
        entry.timer = null;
    }

    private setEmphasized(id: string, entry: ParticipantEntry, next: boolean): void {
        if (entry.emphasized === next) return;

        entry.emphasized = next;
        if (next) this.emphasized.add(id);
        else this.emphasized.delete(id);
        this.dirty = true;
    }

    private flush(): void {
        if (this.disposed || !this.dirty) {
            this.dirty = false;
            return;
        }

        this.dirty = false;
        if (this.listeners.size === 0) return;

        const emphasizedIds = [...this.emphasized];
        for (const listener of [...this.listeners]) {
            // A subscriber that throws must not corrupt timers or shadow other subscribers.
            try {
                listener(emphasizedIds);
            } catch { /* ignored by design */ }
        }
    }
}
