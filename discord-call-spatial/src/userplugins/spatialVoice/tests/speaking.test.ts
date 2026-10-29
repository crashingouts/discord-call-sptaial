/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Spatial Voice contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    DEFAULT_AVATAR_SCALE,
    DEFAULT_HOLD_MS,
    DEFAULT_MOTION_MS,
    DEFAULT_SPEAKING_GLOW,
    resolveSpeakingAppearance,
    SpeakingHoldController,
    type SpeakingClock,
    type TimerHandle
} from "../speaking.ts";

/** Deterministic clock: timers fire only when the test advances it. */
class FakeClock implements SpeakingClock {
    private time = 0;
    private nextId = 1;
    private readonly timers = new Map<number, { at: number; callback: () => void; }>();

    now(): number {
        return this.time;
    }

    setTimeout(callback: () => void, delayMs: number): TimerHandle {
        const id = this.nextId++;
        this.timers.set(id, { at: this.time + Math.max(0, delayMs), callback });
        return id;
    }

    clearTimeout(handle: TimerHandle): void {
        if (typeof handle === "number") this.timers.delete(handle);
    }

    pending(): number {
        return this.timers.size;
    }

    advance(ms: number): void {
        const target = this.time + Math.max(0, ms);
        for (;;) {
            let dueId: number | undefined;
            let dueAt = Infinity;
            for (const [id, timer] of this.timers) {
                if (timer.at <= target && timer.at < dueAt) {
                    dueAt = timer.at;
                    dueId = id;
                }
            }
            if (dueId === undefined) break;

            const timer = this.timers.get(dueId)!;
            this.timers.delete(dueId);
            this.time = timer.at;
            timer.callback();
        }
        this.time = target;
    }
}

function setup(options: { enabled?: boolean; holdMs?: number; } = {}) {
    const clock = new FakeClock();
    const controller = new SpeakingHoldController({ ...options, clock });
    return { clock, controller };
}

function speakAndStop(controller: SpeakingHoldController, id: string, cameraOn = false) {
    controller.updateParticipant({ id, cameraOn, speaking: true });
    controller.updateParticipant({ id, cameraOn, speaking: false });
}

test("defaults are enabled with a ten-second hold", () => {
    const { clock, controller } = setup();
    assert.equal(DEFAULT_HOLD_MS, 10_000);

    speakAndStop(controller, "a");
    assert.equal(controller.isEmphasized("a"), true);

    clock.advance(9_999);
    assert.equal(controller.isEmphasized("a"), true, "still inside the default hold");

    clock.advance(1);
    assert.equal(controller.isEmphasized("a"), false, "the default hold is exactly ten seconds");
});

test("a camera-off speaker stays emphasized for the full inactivity interval", () => {
    const { clock, controller } = setup();
    speakAndStop(controller, "a");

    clock.advance(4_999);
    assert.equal(controller.isEmphasized("a"), true);

    clock.advance(5_000);
    assert.equal(controller.isEmphasized("a"), true, "shrinking happens only after the whole interval");

    clock.advance(1);
    assert.equal(controller.isEmphasized("a"), false);
    assert.equal(clock.pending(), 0, "the expired timer is gone");
});

test("every new speaking activity resets the hold", () => {
    const { clock, controller } = setup();

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    clock.advance(4_000);
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    clock.advance(1_000);
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    clock.advance(4_000);
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    // Last activity lands at t = 9000, so the hold must end at t = 19000.
    clock.advance(9_999);
    assert.equal(controller.isEmphasized("a"), true);

    clock.advance(1);
    assert.equal(controller.isEmphasized("a"), false);
});

test("uninterrupted speech never expires", () => {
    const { clock, controller } = setup();
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });

    clock.advance(60_000);
    assert.equal(controller.isEmphasized("a"), true, "sixty seconds of speech keeps the avatar enlarged");
    assert.equal(clock.pending(), 0, "a speaking participant needs no shrink timer");

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    assert.equal(controller.isEmphasized("a"), true, "the hold starts when speech stops");
    clock.advance(9_999);
    assert.equal(controller.isEmphasized("a"), true);
    clock.advance(1);
    assert.equal(controller.isEmphasized("a"), false);
});

test("repeated speaking reports without a transition are not new activity", () => {
    const { clock, controller } = setup();
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });

    clock.advance(5_000);
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    assert.equal(clock.pending(), 0);

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    clock.advance(9_999);
    assert.equal(controller.isEmphasized("a"), true);
    clock.advance(1);
    assert.equal(controller.isEmphasized("a"), false, "the hold runs from the stop, not from a repeat report");
});

test("concurrent participants hold independently", () => {
    const { clock, controller } = setup();
    speakAndStop(controller, "a");
    clock.advance(5_000);
    speakAndStop(controller, "b");

    clock.advance(4_999);
    assert.equal(controller.isEmphasized("a"), true);
    assert.equal(controller.isEmphasized("b"), true);

    clock.advance(1);
    assert.equal(controller.isEmphasized("a"), false, "a shrank on its own schedule");
    assert.equal(controller.isEmphasized("b"), true, "b is still inside its hold");

    clock.advance(5_000);
    assert.equal(controller.isEmphasized("b"), false);
});

test("one participant speaking does not extend another participant's hold", () => {
    const { clock, controller } = setup();
    speakAndStop(controller, "a");
    controller.updateParticipant({ id: "b", cameraOn: false, speaking: true });

    clock.advance(5_000);
    controller.updateParticipant({ id: "b", cameraOn: false, speaking: false });
    controller.updateParticipant({ id: "b", cameraOn: false, speaking: true });

    clock.advance(5_000);
    assert.equal(controller.isEmphasized("a"), false);
    assert.equal(controller.isEmphasized("b"), true);
});

test("camera-on participants are never emphasized", () => {
    const { clock, controller } = setup();
    controller.updateParticipant({ id: "a", cameraOn: true, speaking: true });

    assert.equal(controller.isEmphasized("a"), false);
    assert.equal(clock.pending(), 0);

    clock.advance(30_000);
    assert.equal(controller.isEmphasized("a"), false, "a speaking video tile is never enlarged");
});

test("turning the camera on drops emphasis and cancels the timer immediately", () => {
    const { clock, controller } = setup();
    speakAndStop(controller, "a");
    clock.advance(2_000);
    assert.equal(clock.pending(), 1);

    controller.updateParticipant({ id: "a", cameraOn: true, speaking: false });
    assert.equal(controller.isEmphasized("a"), false);
    assert.equal(clock.pending(), 0, "camera activation cancels the pending shrink timer");

    clock.advance(30_000);
    assert.equal(controller.isEmphasized("a"), false);
});

test("camera activation during speech ends emphasis without a timer", () => {
    const { clock, controller } = setup();
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    assert.equal(controller.isEmphasized("a"), true);

    controller.updateParticipant({ id: "a", cameraOn: true, speaking: true });
    assert.equal(controller.isEmphasized("a"), false);
    assert.equal(clock.pending(), 0);
});

test("turning the camera back off lets a speaking participant emphasize again", () => {
    const { clock, controller } = setup();
    controller.updateParticipant({ id: "a", cameraOn: true, speaking: true });
    assert.equal(controller.isEmphasized("a"), false);

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    assert.equal(controller.isEmphasized("a"), true);

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    clock.advance(10_000);
    assert.equal(controller.isEmphasized("a"), false);
});

test("shortening the hold shrinks an avatar that is already past the new window", () => {
    const { clock, controller } = setup();
    speakAndStop(controller, "a");
    clock.advance(3_000);

    controller.configure({ holdMs: 2_000 });
    assert.equal(controller.isEmphasized("a"), false, "a shorter hold applies immediately");
    assert.equal(clock.pending(), 0);
});

test("lengthening the hold re-arms the timer from the last activity", () => {
    const { clock, controller } = setup();
    speakAndStop(controller, "a");
    clock.advance(3_000);

    controller.configure({ holdMs: 5_000 });
    assert.equal(controller.isEmphasized("a"), true);
    assert.equal(clock.pending(), 1, "still one timer per participant");

    clock.advance(1_999);
    assert.equal(controller.isEmphasized("a"), true);
    clock.advance(1);
    assert.equal(controller.isEmphasized("a"), false);
});

test("disabling clears emphasis and timers, and enabling reconciles a current speaker", () => {
    const { clock, controller } = setup();
    speakAndStop(controller, "a");
    clock.advance(12_000);
    assert.equal(controller.isEmphasized("a"), false, "a's hold lapsed before disabling");

    controller.updateParticipant({ id: "b", cameraOn: false, speaking: true });
    assert.equal(controller.getEmphasizedIds().join(","), "b");

    controller.configure({ enabled: false });
    assert.deepEqual(controller.getEmphasizedIds(), []);
    assert.equal(clock.pending(), 0, "disabling leaves no orphaned timers");

    controller.updateParticipant({ id: "c", cameraOn: false, speaking: true });
    assert.equal(controller.isEmphasized("c"), false, "a disabled controller never emphasizes");

    controller.configure({ enabled: true });
    assert.equal(controller.isEmphasized("c"), true, "whoever is speaking at re-enable is emphasized at once");
    assert.equal(controller.isEmphasized("a"), false, "a participant whose hold already lapsed stays small");
    assert.equal(controller.isEmphasized("b"), true, "b never stopped speaking");
});

test("a participant who leaves is dropped with its timer", () => {
    const { clock, controller } = setup();
    speakAndStop(controller, "a");
    speakAndStop(controller, "b");
    assert.equal(clock.pending(), 2);

    controller.retainParticipants(["b"]);
    assert.equal(controller.isEmphasized("a"), false);
    assert.equal(controller.isEmphasized("b"), true);
    assert.equal(clock.pending(), 1, "the departed participant's timer is cancelled");

    controller.retainParticipants(["b"]);
    assert.equal(clock.pending(), 1, "repeated cleanup is safe");

    controller.retainParticipants([]);
    assert.deepEqual(controller.getEmphasizedIds(), []);
    assert.equal(clock.pending(), 0);

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    assert.equal(controller.isEmphasized("a"), false, "state does not survive a departure");
});

test("subscribers hear emphasis changes and nothing else", () => {
    const { clock, controller } = setup();
    const seen: string[][] = [];
    const unsubscribe = controller.subscribe(ids => seen.push([...ids]));

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    assert.deepEqual(seen, [["a"]], "emphasis on notifies once");

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    controller.updateParticipant({ id: "b", cameraOn: true, speaking: false });
    clock.advance(1_000);
    assert.deepEqual(seen, [["a"]], "repeats and camera-on participants do not notify");

    controller.updateParticipant({ id: "a", cameraOn: true, speaking: false });
    assert.deepEqual(seen, [["a"], []], "losing emphasis notifies");

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    assert.equal(seen.length, 2, "no activity means no new emphasis and no notification");

    unsubscribe();
    speakAndStop(controller, "c");
    assert.equal(seen.length, 2, "an unsubscribed listener stays silent");
});

test("activity timestamps order activity and older ones are ignored", () => {
    const { clock, controller } = setup();

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true, activityTimestamp: 0 });
    clock.advance(6_000);
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true, activityTimestamp: 6_000 });
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true, activityTimestamp: 1_000 });
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    // Last activity is t = 6000, so the hold runs to t = 16000.
    clock.advance(9_999);
    assert.equal(controller.isEmphasized("a"), true);
    clock.advance(1);
    assert.equal(controller.isEmphasized("a"), false, "the stale timestamp did not pull the hold backwards");

    // A timestamp ahead of the clock is honoured and clamped into the future window.
    controller.updateParticipant({ id: "b", cameraOn: false, speaking: true, activityTimestamp: 20_000 });
    controller.updateParticipant({ id: "b", cameraOn: false, speaking: false });
    clock.advance(13_999);
    assert.equal(controller.isEmphasized("b"), true, "a future timestamp extends the window");
    clock.advance(1);
    assert.equal(controller.isEmphasized("b"), false);
});

test("speech on camera never starts a hold for the camera-off avatar", () => {
    const { clock, controller } = setup();
    controller.updateParticipant({ id: "a", cameraOn: true, speaking: true });
    clock.advance(2_000);

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    assert.equal(controller.isEmphasized("a"), false, "turning the camera off does not replay untracked speech");
    assert.equal(clock.pending(), 0);

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    assert.equal(controller.isEmphasized("a"), true, "a genuine camera-off speaker is emphasized");
});

test("at most one pending timer exists per participant", () => {
    const { clock, controller } = setup();

    for (let i = 0; i < 5; i++) {
        controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
        controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    }
    assert.equal(clock.pending(), 1, "repeated activity replaces the timer instead of stacking them");

    for (let i = 0; i < 3; i++) {
        controller.updateParticipant({ id: "b", cameraOn: false, speaking: true });
        controller.updateParticipant({ id: "b", cameraOn: false, speaking: false });
    }
    assert.equal(clock.pending(), 2, "two participants, two timers");
});

test("dispose cancels every timer and makes further calls harmless", () => {
    const { clock, controller } = setup();
    const seen: string[][] = [];
    controller.subscribe(ids => seen.push([...ids]));

    speakAndStop(controller, "a");
    speakAndStop(controller, "b");
    assert.equal(clock.pending(), 2);

    controller.dispose();
    assert.equal(clock.pending(), 0, "disposal leaves no orphaned timers");
    assert.deepEqual(controller.getEmphasizedIds(), []);

    clock.advance(60_000);
    assert.equal(seen.length > 0, true);

    const before = seen.length;
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    controller.retainParticipants([]);
    controller.configure({ enabled: true, holdMs: 1_000 });
    assert.equal(controller.isEmphasized("a"), false);
    assert.equal(clock.pending(), 0);
    assert.equal(seen.length, before, "a disposed controller notifies nobody");

    const unsubscribe = controller.subscribe(ids => seen.push([...ids]));
    unsubscribe();
    controller.dispose();
    controller.dispose();
    assert.equal(clock.pending(), 0);
});

test("the system clock drives a real hold when no clock is injected", async () => {
    const controller = new SpeakingHoldController({ holdMs: 30 });
    const changes: string[][] = [];
    controller.subscribe(ids => changes.push([...ids]));

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: true });
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    await new Promise(resolve => setTimeout(resolve, 120));

    assert.equal(controller.isEmphasized("a"), false);
    assert.deepEqual(changes, [["a"], []], "the default timer path notifies on and off");
    controller.dispose();
});

test("invalid input is ignored and hold values are clamped", () => {
    const { clock, controller } = setup();

    controller.updateParticipant({ id: "", cameraOn: false, speaking: true });
    controller.updateParticipant(undefined as never);
    assert.deepEqual(controller.getEmphasizedIds(), []);

    controller.configure({ holdMs: Number.NaN });
    controller.configure({ holdMs: -500 });
    speakAndStop(controller, "a");
    assert.equal(controller.isEmphasized("a"), false, "a clamped-to-zero hold ends at the stop");
    assert.equal(clock.pending(), 0);
});

test("removeParticipant clears one participant and leaves the rest alone", () => {
    const { clock, controller } = setup();
    const seen: string[][] = [];
    controller.subscribe(ids => seen.push([...ids]));

    speakAndStop(controller, "a");
    speakAndStop(controller, "b");
    assert.equal(clock.pending(), 2);

    assert.equal(controller.removeParticipant("a"), true, "a tracked participant is removed");
    assert.equal(controller.isEmphasized("a"), false);
    assert.equal(controller.isEmphasized("b"), true, "the departure of a does not touch b");
    assert.equal(clock.pending(), 1, "only a's timer is cancelled");
    assert.deepEqual(seen[seen.length - 1], ["b"], "the removal is announced once");

    assert.equal(controller.removeParticipant("a"), false, "removing an unknown id is a no-op");
    assert.equal(controller.removeParticipant(""), false);
    assert.equal(controller.removeParticipant(undefined as never), false);
    assert.deepEqual(seen[seen.length - 1], ["b"], "a no-op does not notify");

    // The same id coming back is a fresh participant: no stale emphasis, no stale activity.
    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    assert.equal(controller.isEmphasized("a"), false);
    assert.equal(clock.pending(), 1);
});

test("a subscriber that throws cannot corrupt timers or shadow other subscribers", () => {
    const { clock, controller } = setup();
    const seen: string[][] = [];
    controller.subscribe(() => { throw new Error("listener blew up"); });
    controller.subscribe(ids => seen.push([...ids]));

    assert.doesNotThrow(() => controller.updateParticipant({ id: "a", cameraOn: false, speaking: true }));
    assert.deepEqual(seen, [["a"]], "the second subscriber still hears the emphasis");

    controller.updateParticipant({ id: "a", cameraOn: false, speaking: false });
    assert.equal(clock.pending(), 1, "the shrink timer was still armed");

    clock.advance(10_000);
    assert.equal(controller.isEmphasized("a"), false);
    assert.deepEqual(seen, [["a"], []], "the expiry still reaches the surviving subscriber");
    assert.equal(clock.pending(), 0);
});

test("lengthening the hold back after it shortened re-evaluates the same activity", () => {
    const { clock, controller } = setup();
    speakAndStop(controller, "a");
    clock.advance(3_000);

    controller.configure({ holdMs: 2_000 });
    assert.equal(controller.isEmphasized("a"), false, "the short hold already lapsed");

    // No new speech: the window is re-evaluated against the last genuine activity,
    // so raising the slider brings back everyone who spoke inside the new window.
    controller.configure({ holdMs: 10_000 });
    assert.equal(controller.isEmphasized("a"), true);
    assert.equal(clock.pending(), 1);

    clock.advance(6_999);
    assert.equal(controller.isEmphasized("a"), true);
    clock.advance(1);
    assert.equal(controller.isEmphasized("a"), false, "and still ends ten seconds after the activity");
});

test("enlargement settings resolve to the numbers the stylesheet consumes", () => {
    assert.deepEqual(resolveSpeakingAppearance(), {
        enabled: true,
        scale: DEFAULT_AVATAR_SCALE,
        glow: DEFAULT_SPEAKING_GLOW,
        motionMs: DEFAULT_MOTION_MS
    });
    assert.equal(DEFAULT_AVATAR_SCALE, 1.4, "the default scale is 1.4");

    assert.deepEqual(resolveSpeakingAppearance({ scale: 1.6, glow: 0.4, motionMs: 120 }), {
        enabled: true,
        scale: 1.6,
        glow: 0.4,
        motionMs: 120
    });

    const clamped = resolveSpeakingAppearance({ scale: 0.2, glow: 9, motionMs: -50 });
    assert.equal(clamped.scale, 1, "a scale below 1 would shrink the avatar");
    assert.equal(clamped.glow, 1, "glow is a 0..1 strength");
    assert.equal(clamped.motionMs, 0);

    assert.equal(resolveSpeakingAppearance({ scale: 7 }).scale, 2);
    assert.equal(resolveSpeakingAppearance({ motionMs: 5_000 }).motionMs, 1_000);

    const junk = resolveSpeakingAppearance({ scale: Number.NaN, glow: Number.POSITIVE_INFINITY, motionMs: undefined });
    assert.equal(junk.scale, DEFAULT_AVATAR_SCALE);
    assert.equal(junk.glow, DEFAULT_SPEAKING_GLOW);
    assert.equal(junk.motionMs, DEFAULT_MOTION_MS);

    assert.deepEqual(resolveSpeakingAppearance({ enabled: false, scale: 1.9, glow: 0.9 }), {
        enabled: false,
        scale: 1,
        glow: 0,
        motionMs: DEFAULT_MOTION_MS
    }, "disabling enlargement can never leave an avatar enlarged or ringed");
});
