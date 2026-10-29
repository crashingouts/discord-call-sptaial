import test from "node:test";
import assert from "node:assert/strict";

import {
    computeSpatialLayout,
    DEFAULT_SPATIAL_LAYOUT_OPTIONS,
    resolveSpatialLayoutOptions,
    SPATIAL_LABEL_CLEARANCE,
    SPATIAL_VIDEO_ASPECT,
    spatialItemCenter,
    describeSpatialPage,
    type SpatialLayoutItem,
    type SpatialParticipant
} from "./layout.ts";

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

function overlaps(a: Box, b: Box): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function room(count: number, prefix = "user"): SpatialParticipant[] {
    return Array.from({ length: count }, (_value, index) => ({
        id: `${prefix}-${index}`,
        kind: index % 2 === 0 ? "video" : "avatar"
    }));
}

function collectPages(input: Parameters<typeof computeSpatialLayout>[0]) {
    const first = computeSpatialLayout(input);
    const pages: SpatialLayoutItem[][] = [];
    for (let page = 1; page <= first.pageCount; page++) {
        pages.push(computeSpatialLayout({ ...input, options: { ...input.options, page } }).items);
    }
    return { first, pages };
}

function labelBand(item: Box): Box {
    return { x: item.x, y: item.y + item.height, width: item.width, height: SPATIAL_LABEL_CLEARANCE };
}

function assertSceneIsSane(
    items: readonly SpatialLayoutItem[],
    width: number,
    height: number,
    options: { headerHeight: number; controlsHeight: number }
) {
    const usableTop = options.headerHeight;
    const usableBottom = height - options.controlsHeight;
    for (const item of items) {
        assert.ok(Number.isFinite(item.x) && Number.isFinite(item.y), `${item.id} has a finite position`);
        assert.ok(item.width > 0 && item.height > 0, `${item.id} has a positive size`);
        assert.ok(item.x >= 0, `${item.id} starts inside the scene on x (${item.x})`);
        assert.ok(item.y >= usableTop, `${item.id} clears the header (${item.y})`);
        assert.ok(item.x + item.width <= width, `${item.id} ends inside the scene on x`);
        assert.ok(
            item.y + item.height + SPATIAL_LABEL_CLEARANCE <= usableBottom,
            `${item.id} clears the controls and keeps its label inside the scene (${item.y + item.height} + label)`
        );
    }
}

test("an empty room produces an empty scene with one page", () => {
    const result = computeSpatialLayout({ width: 1280, height: 800, participants: [], selectedId: null });
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.overflowIds, []);
    assert.equal(result.pageCount, 1);
});

test("placement is deterministic and independent of participant array order", () => {
    const participants = room(10);
    const a = computeSpatialLayout({ width: 1280, height: 800, participants, selectedId: "user-4" });
    const b = computeSpatialLayout({ width: 1280, height: 800, participants, selectedId: "user-4" });
    const c = computeSpatialLayout({
        width: 1280,
        height: 800,
        participants: [...participants].reverse(),
        selectedId: "user-4"
    });
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
});

test("every item stays inside the reserved scene frame at every supported size", () => {
    const sizes = [
        [1920, 1080],
        [1440, 900],
        [1280, 800],
        [1024, 768],
        [800, 600],
        [640, 480],
        [480, 320],
        [320, 240],
        [1600, 400]
    ];
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    for (const [width, height] of sizes) {
        const input = { width, height, participants: room(12), selectedId: "user-0", options };
        const { pages } = collectPages(input);
        for (const items of pages) {
            assertSceneIsSane(items, width, height, options);
        }
    }
});

test("the selected feed is centred, aspect-preserving and 40-50% of the usable width", () => {
    for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 800], [1100, 900]]) {
        const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
        const result = computeSpatialLayout({ width, height, participants: room(9), selectedId: "user-0", options });
        const feed = result.items.find(item => item.selected);
        assert.ok(feed, "the selected participant has an item");
        assert.equal(feed.id, "user-0");

        const usableWidth = width;
        const usableHeight = height - options.headerHeight - options.controlsHeight;
        const ratio = feed.width / usableWidth;
        assert.ok(ratio >= 0.4 && ratio <= 0.5, `feed is ${(ratio * 100).toFixed(1)}% of usable width at ${width}x${height}`);
        assert.ok(Math.abs(feed.width / feed.height - SPATIAL_VIDEO_ASPECT) < 0.02, "feed keeps the video aspect ratio");
        assert.ok(Math.abs(feed.x + feed.width / 2 - width / 2) <= 1, "feed is horizontally centred");
        const feedCenterY = options.headerHeight + (usableHeight - SPATIAL_LABEL_CLEARANCE) / 2;
        assert.ok(
            Math.abs(feed.y + feed.height / 2 - feedCenterY) <= 1,
            "feed is vertically centred above its name plate"
        );
    }
});

test("secondary participants sit around the selected feed and never under it", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const result = computeSpatialLayout({ width: 1280, height: 800, participants: room(11), selectedId: "user-0", options });
    const feed = result.items.find(item => item.selected);
    assert.ok(feed);

    const secondaries = result.items.filter(item => !item.selected);
    assert.ok(secondaries.length >= 4, `expected several secondaries, got ${secondaries.length}`);
    assert.ok(
        secondaries.filter(item => item.x + item.width <= feed.x).length >= 1,
        "at least one secondary is left of the feed"
    );
    assert.ok(
        secondaries.filter(item => item.x >= feed.x + feed.width).length >= 1,
        "at least one secondary is right of the feed"
    );
    for (const item of secondaries) {
        assert.ok(!overlaps(item, feed), `${item.id} does not overlap the feed`);
    }
});

test("the overview uses the centre instead of reserving a main-feed rectangle", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const result = computeSpatialLayout({ width: 1280, height: 800, participants: room(14), selectedId: null, options });
    const usableHeight = 800 - options.headerHeight - options.controlsHeight;
    const centerX = 1280 / 2;
    const centerY = options.headerHeight + usableHeight / 2;
    const nearCentre = result.items.filter(
        item =>
            Math.abs(item.x + item.width / 2 - centerX) <= 1280 * 0.2 &&
            Math.abs(item.y + item.height / 2 - centerY) <= usableHeight * 0.2
    );
    assert.ok(nearCentre.length >= 1, "some participant occupies the centre of the overview");
    assert.ok(
        result.items.every(item => item.width < 1280 * 0.4),
        "no participant takes the giant main-feed footprint in overview"
    );
});

test("no two items collide on any page, including the enlarged avatar footprint", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    for (const selectedId of ["user-0", null]) {
        const { pages } = collectPages({ width: 1280, height: 800, participants: room(18), selectedId, options });
        for (const items of pages) {
            for (let a = 0; a < items.length; a++) {
                for (let b = a + 1; b < items.length; b++) {
                    assert.ok(!overlaps(items[a], items[b]), `${items[a].id} and ${items[b].id} do not overlap`);
                }
            }
        }
    }
});

test("an enlarging avatar never collides with a neighbour or the selected feed", () => {
    const options = { ...DEFAULT_SPATIAL_LAYOUT_OPTIONS, maximumAvatarScale: 1.4 };
    const { pages } = collectPages({ width: 1280, height: 800, participants: room(16), selectedId: "user-0", options });
    for (const items of pages) {
        for (const avatar of items.filter(item => item.kind === "avatar")) {
            const centerX = avatar.x + avatar.width / 2;
            const centerY = avatar.y + avatar.height / 2;
            const grown: Box = {
                x: centerX - (avatar.width * options.maximumAvatarScale) / 2,
                y: centerY - (avatar.height * options.maximumAvatarScale) / 2,
                width: avatar.width * options.maximumAvatarScale,
                height: avatar.height * options.maximumAvatarScale
            };
            for (const other of items) {
                if (other.id === avatar.id) continue;
                assert.ok(!overlaps(grown, other), `enlarged ${avatar.id} clears ${other.id}`);
            }
        }
    }
});

test("name plates keep their clearance below every item", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const { pages } = collectPages({ width: 1024, height: 768, participants: room(14), selectedId: "user-2", options });
    for (const items of pages) {
        for (let a = 0; a < items.length; a++) {
            const band = labelBand(items[a]);
            for (let b = 0; b < items.length; b++) {
                if (a === b) continue;
                assert.ok(!overlaps(band, items[b]), `label of ${items[a].id} stays clear of ${items[b].id}`);
            }
        }
    }
});

test("items never enter the reserved call-controls band", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const { pages } = collectPages({ width: 1280, height: 800, participants: room(14), selectedId: "user-0", options });
    const controlsTop = 800 - options.controlsHeight;
    for (const items of pages) {
        for (const item of items) {
            assert.ok(item.y + item.height + SPATIAL_LABEL_CLEARANCE <= controlsTop, `${item.id} clears the controls`);
        }
    }
});

test("tiny containers stay in bounds and report the rest as overflow", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    for (const [width, height] of [[1, 1], [40, 30], [120, 90], [200, 160], [320, 240]]) {
        const participants = room(6);
        const result = computeSpatialLayout({ width, height, participants, selectedId: null, options });
        assert.ok(result.pageCount >= 1);
        for (const item of result.items) {
            assert.ok(item.x >= 0 && item.y >= 0, `${item.id} in ${width}x${height} starts in bounds`);
            assert.ok(item.x + item.width <= width, `${item.id} in ${width}x${height} stays in width`);
            assert.ok(item.y + item.height <= height, `${item.id} in ${width}x${height} stays in height`);
        }
        const seen = new Set(result.items.map(item => item.id));
        for (const participant of participants) {
            assert.ok(
                seen.has(participant.id) || result.overflowIds.includes(participant.id),
                `${participant.id} is placed or reported as overflow at ${width}x${height}`
            );
        }
    }
});

test("a large room paginates and every participant is reachable", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const participants = room(26);
    const input = { width: 900, height: 640, participants, selectedId: null, options };
    const { first, pages } = collectPages(input);

    assert.ok(first.pageCount > 1, `expected pagination, got ${first.pageCount} page(s)`);
    const seen = new Set<string>();
    for (const items of pages) {
        for (const item of items) {
            assert.ok(!seen.has(item.id), `${item.id} appears on one page only`);
            seen.add(item.id);
        }
    }
    assert.equal(seen.size, participants.length, "every participant is reachable by paging");

    const laterPages = new Set(pages.slice(1).flat().map(item => item.id));
    assert.deepEqual(new Set(first.overflowIds), laterPages, "overflow ids name exactly the later pages");
});

test("the selected feed appears on every page and is never listed as overflow", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const { first, pages } = collectPages({
        width: 900,
        height: 640,
        participants: room(24),
        selectedId: "user-0",
        options
    });
    assert.ok(first.pageCount > 1);
    for (const items of pages) {
        const feed = items.find(item => item.selected);
        assert.ok(feed, "the feed is present on every page");
        assert.equal(feed.id, "user-0");
    }
    assert.ok(!first.overflowIds.includes("user-0"));
});

test("a dense room with a selected feed still reaches every secondary", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const participants = room(20);
    const { first, pages } = collectPages({ width: 900, height: 640, participants, selectedId: "user-0", options });
    assert.ok(first.pageCount > 1);
    const seen = new Set<string>();
    for (const items of pages) {
        const feed = items.find(item => item.selected);
        assert.ok(feed && feed.id === "user-0", "the feed is present on every page");
        for (const item of items) {
            if (item.selected) continue;
            assert.ok(!seen.has(item.id), `${item.id} appears on one page only`);
            seen.add(item.id);
        }
    }
    assert.equal(seen.size, participants.length - 1, "every secondary participant is reachable");
    for (const participant of participants) {
        if (participant.kind === "video" && participant.id !== "user-0") {
            assert.ok(seen.has(participant.id), `${participant.id} (a camera feed) is never dropped`);
        }
    }
});

test("participant churn leaves existing positions alone", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const base = room(8);
    assert.equal(computeSpatialLayout({ width: 1280, height: 800, participants: base, selectedId: null, options }).pageCount, 1);
    const before = computeSpatialLayout({ width: 1280, height: 800, participants: base, selectedId: null, options });

    const grown = computeSpatialLayout({
        width: 1280,
        height: 800,
        participants: [...base, { id: "late-joiner", kind: "avatar" }],
        selectedId: null,
        options
    });
    const movedOnJoin = before.items.filter(item => {
        const match = grown.items.find(candidate => candidate.id === item.id);
        return !match || match.x !== item.x || match.y !== item.y;
    });
    assert.ok(
        movedOnJoin.length <= 1,
        `joining moved ${movedOnJoin.length} of ${before.items.length} participants; only a shared cell may move one`
    );

    const smaller = computeSpatialLayout({
        width: 1280,
        height: 800,
        participants: base.filter(participant => participant.id !== "user-3"),
        selectedId: null,
        options
    });
    const survivors = before.items.filter(item => item.id !== "user-3");
    const movedOnLeave = survivors.filter(item => {
        const match = smaller.items.find(candidate => candidate.id === item.id);
        return !match || match.x !== item.x || match.y !== item.y;
    });
    assert.equal(movedOnLeave.length, 0, `leaving moved ${movedOnLeave.length} participants; nobody should move`);
});

test("videos keep the video aspect ratio while avatars stay square", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const participants: SpatialParticipant[] = [
        { id: "cam-a", kind: "video" },
        { id: "cam-b", kind: "video" },
        { id: "off-a", kind: "avatar" },
        { id: "off-b", kind: "avatar" }
    ];
    const { items } = computeSpatialLayout({ width: 1280, height: 800, participants, selectedId: null, options });
    for (const item of items) {
        if (item.kind === "video") {
            assert.ok(Math.abs(item.width / item.height - SPATIAL_VIDEO_ASPECT) < 0.02, `${item.id} is 16:9`);
        } else {
            assert.equal(item.width, item.height, `${item.id} is circular`);
        }
    }
    const avatars = items.filter(item => item.kind === "avatar");
    const videos = items.filter(item => item.kind === "video");
    assert.ok(avatars.every(avatar => avatar.width <= Math.max(...videos.map(video => video.width))));
});

test("a missing or camera-off selection falls back to the overview", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const ghost = computeSpatialLayout({ width: 1280, height: 800, participants: room(8), selectedId: "nobody", options });
    assert.ok(ghost.items.every(item => !item.selected), "no item is selected for an unknown id");

    const avatarSelected = computeSpatialLayout({
        width: 1280,
        height: 800,
        participants: room(8),
        selectedId: "user-1",
        options
    });
    const chosen = avatarSelected.items.find(item => item.id === "user-1");
    assert.ok(chosen && chosen.selected, "the camera-off participant is still marked selected");
    assert.ok(
        avatarSelected.items.every(item => item.width < 1280 * 0.4),
        "no main feed is fabricated for a camera-off participant"
    );
});

test("the requested page is clamped to the available pages", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const participants = room(26);
    const base = { width: 900, height: 640, participants, selectedId: null };
    const last = computeSpatialLayout({ ...base, options: { ...options, page: 99 } });
    const first = computeSpatialLayout({ ...base, options: { ...options, page: 1 } });
    const clampedLast = computeSpatialLayout({ ...base, options: { ...options, page: last.pageCount } });
    assert.equal(last.pageCount, first.pageCount);
    assert.deepEqual(last.items, clampedLast.items);
    assert.deepEqual(computeSpatialLayout({ ...base, options: { ...options, page: 0 } }).items, first.items);
    assert.ok(last.items.length > 0, "the clamped page still carries items");
});

test("nonsense options and participants are sanitised rather than thrown", () => {
    const options = resolveSpatialLayoutOptions({
        selectedWidthRatio: Number.NaN,
        videoWidth: -40,
        avatarSize: 5000,
        gap: Number.POSITIVE_INFINITY,
        maximumAvatarScale: 0,
        headerHeight: -10,
        controlsHeight: Number.NaN,
        page: -3
    });
    assert.equal(options.selectedWidthRatio, DEFAULT_SPATIAL_LAYOUT_OPTIONS.selectedWidthRatio);
    assert.ok(options.videoWidth >= 96);
    assert.ok(options.avatarSize <= 256);
    assert.equal(options.gap, DEFAULT_SPATIAL_LAYOUT_OPTIONS.gap);
    assert.ok(options.maximumAvatarScale >= 1);
    assert.equal(options.headerHeight, 0);
    assert.equal(options.controlsHeight, DEFAULT_SPATIAL_LAYOUT_OPTIONS.controlsHeight);
    assert.equal(options.page, 1);

    const participants: SpatialParticipant[] = [
        { id: "dup", kind: "video" },
        { id: "dup", kind: "avatar" },
        { id: "", kind: "video" },
        { id: "weird", kind: "hologram" as SpatialParticipant["kind"] }
    ];
    const result = computeSpatialLayout({ width: 0, height: 0, participants, selectedId: "dup", options });
    assert.deepEqual(result.items, []);
    assert.deepEqual(new Set(result.overflowIds), new Set(["dup", "weird"]));
    assert.equal(result.pageCount, 1);
});

test("a room whose only participant is the selected camera still renders it", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    for (const [width, height] of [[1920, 1080], [1280, 800], [640, 480]]) {
        const result = computeSpatialLayout({
            width,
            height,
            participants: [{ id: "solo", kind: "video" }],
            selectedId: "solo",
            options
        });
        assert.equal(result.pageCount, 1);
        assert.equal(result.items.length, 1, "the focus feed renders at " + width + "x" + height);
        assert.equal(result.items[0].id, "solo");
        assert.ok(result.items[0].selected);
        assert.deepEqual(result.overflowIds, []);
    }
});

test("turning a camera on or off moves only that participant", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const participants = room(10);
    const before = computeSpatialLayout({ width: 1280, height: 800, participants, selectedId: null, options });
    const cameraOn = participants.map(participant =>
        participant.id === "user-1" ? { id: participant.id, kind: "video" as const } : participant
    );
    const after = computeSpatialLayout({ width: 1280, height: 800, participants: cameraOn, selectedId: null, options });

    const moved = before.items.filter(item => {
        if (item.id === "user-1") return false;
        const match = after.items.find(candidate => candidate.id === item.id);
        return !match || match.x !== item.x || match.y !== item.y;
    });
    assert.deepEqual(moved.map(item => item.id), [], "nobody else moves when one camera comes on");
});

test("the selected camera keeps focus through joins, leaves and a camera round trip", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const base = room(10);
    const rooms: SpatialParticipant[][] = [
        base,
        [...base, { id: "late", kind: "avatar" }],
        base.filter(participant => participant.id !== "user-5")
    ];
    for (const participants of rooms) {
        const result = computeSpatialLayout({ width: 1280, height: 800, participants, selectedId: "user-0", options });
        const feed = result.items.find(item => item.selected);
        assert.ok(feed && feed.id === "user-0", "the chosen feed keeps focus");
        const ratio = feed.width / 1280;
        assert.ok(ratio >= 0.4 && ratio <= 0.5, "the feed stays between 40 and 50 percent wide");
        assert.ok(!result.overflowIds.includes("user-0"));
    }

    const cameraOff = base.map(participant =>
        participant.id === "user-0" ? { id: participant.id, kind: "avatar" as const } : participant
    );
    const off = computeSpatialLayout({ width: 1280, height: 800, participants: cameraOff, selectedId: "user-0", options });
    assert.ok(off.items.every(item => item.width < 1280 * 0.4), "no giant feed is invented for a camera-off selection");
    assert.ok(off.items.some(item => item.id === "user-0" && item.selected), "the avatar stays marked selected");

    const back = computeSpatialLayout({ width: 1280, height: 800, participants: base, selectedId: "user-0", options });
    assert.ok(back.items.some(item => item.id === "user-0" && item.selected), "the feed returns with the camera");
});

test("the field reads as scattered rather than as a grid", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const result = computeSpatialLayout({ width: 1440, height: 900, participants: room(11), selectedId: null, options });
    const videos = result.items.filter(item => item.kind === "video");
    assert.ok(videos.length >= 3, "there are several camera tiles to judge");
    assert.ok(new Set(videos.map(video => video.width)).size >= 2, "tiles differ slightly in size");

    const centres = result.items.map(item => Math.round(item.x + item.width / 2) + "," + Math.round(item.y + item.height / 2));
    assert.equal(new Set(centres).size, result.items.length, "no two participants share a centre");
    const columns = result.items.map(item => Math.round(item.x + item.width / 2));
    const rows = result.items.map(item => Math.round(item.y + item.height / 2));
    assert.equal(new Set(columns).size, columns.length, "no two participants share a column");
    assert.equal(new Set(rows).size, rows.length, "no two participants share a row");
});

test("no secondary tile exceeds the configured base size", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const { pages } = collectPages({ width: 1920, height: 1080, participants: room(16), selectedId: "user-0", options });
    for (const items of pages) {
        for (const item of items) {
            if (item.selected) continue;
            const base = item.kind === "video" ? options.videoWidth : options.avatarSize;
            assert.ok(item.width <= base, item.id + " (" + item.width + ") stays within the " + base + " base size");
        }
    }
});


test("the middle stays clear, so the overview has its vortex and a feed has room", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    for (const [width, height] of [[1920, 1080], [1280, 800], [1024, 572], [900, 640]]) {
        const usableHeight = height - options.headerHeight - options.controlsHeight;
        const centreX = width / 2;
        const centreY = options.headerHeight + usableHeight / 2;
        const result = computeSpatialLayout({ width, height, participants: room(16), selectedId: null, options });
        for (const item of result.items) {
            const radius = Math.hypot(
                (item.x + item.width / 2 - centreX) / (width / 2),
                (item.y + item.height / 2 - centreY) / (usableHeight / 2)
            );
            assert.ok(radius >= 0.32, item.id + " sits outside the hollow centre at " + width + "x" + height + " (f=" + radius.toFixed(2) + ")");
        }
    }
});

test("camera tiles sit further out than the avatars around them", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const participants: SpatialParticipant[] = [
        { id: "cam-1", kind: "video" },
        { id: "cam-2", kind: "video" },
        { id: "cam-3", kind: "video" },
        { id: "off-1", kind: "avatar" },
        { id: "off-2", kind: "avatar" },
        { id: "off-3", kind: "avatar" },
        { id: "off-4", kind: "avatar" },
        { id: "off-5", kind: "avatar" },
        { id: "off-6", kind: "avatar" }
    ];
    const width = 1600;
    const height = 900;
    const usableHeight = height - options.headerHeight - options.controlsHeight;
    const result = computeSpatialLayout({ width, height, participants, selectedId: null, options });
    const radiusOf = (item: SpatialLayoutItem) =>
        Math.hypot(
            (item.x + item.width / 2 - width / 2) / (width / 2),
            (item.y + item.height / 2 - (options.headerHeight + usableHeight / 2)) / (usableHeight / 2)
        );
    const videos = result.items.filter(item => item.kind === "video");
    const avatars = result.items.filter(item => item.kind === "avatar");
    assert.ok(videos.length >= 2 && avatars.length >= 2, "both kinds are on the page");
    const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
    assert.ok(
        mean(videos.map(radiusOf)) > mean(avatars.map(radiusOf)) - 0.08,
        "the rectangular feeds are not pulled towards the middle"
    );
});

test("a secondary tile is about a sixth of the scene's width, as in the references", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    for (const [width, height] of [[1280, 800], [1024, 572]]) {
        const result = computeSpatialLayout({ width, height, participants: room(14), selectedId: null, options });
        const videos = result.items.filter(item => item.kind === "video");
        assert.ok(videos.length >= 2, "there are tiles to measure at " + width + "x" + height);
        for (const video of videos) {
            const ratio = video.width / width;
            assert.ok(ratio >= 0.1 && ratio <= 0.2, video.id + " is " + (ratio * 100).toFixed(1) + "% of the scene width");
            assert.ok(Math.abs(video.width / video.height - SPATIAL_VIDEO_ASPECT) < 0.02, video.id + " keeps 16:9");
        }
    }
});

test("spatialItemCenter gives the point the centred CSS wrapper needs", () => {
    assert.deepEqual(spatialItemCenter({ x: 10, y: 20, width: 200, height: 100 }), { x: 110, y: 70 });
});

test("page summaries describe the room for a screen reader", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const single = computeSpatialLayout({ width: 1920, height: 1080, participants: room(4), selectedId: null, options });
    assert.equal(single.pageCount, 1);
    assert.equal(describeSpatialPage(single), "4 of 4 participants visible.");

    const input = { width: 900, height: 640, participants: room(26), selectedId: null, options };
    const first = computeSpatialLayout(input);
    assert.ok(first.pageCount > 1);
    assert.equal(
        describeSpatialPage(first),
        "Page 1 of " + first.pageCount + ": " + first.items.length + " of 26 participants visible."
    );
    const second = computeSpatialLayout({ ...input, options: { ...options, page: 2 } });
    assert.equal(second.page, 2);
    assert.equal(
        describeSpatialPage(second),
        "Page 2 of " + first.pageCount + ": " + second.items.length + " of 26 participants visible."
    );

    const empty = computeSpatialLayout({ width: 1280, height: 800, participants: [], selectedId: null, options });
    assert.equal(describeSpatialPage(empty), "No participants in this channel.");
});

test("invariants hold across viewports, room sizes and camera selection", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    const sizes = [[1920, 1080], [1440, 900], [1280, 800], [1024, 768], [900, 640], [640, 480], [480, 320], [1600, 400]];
    const counts = [1, 2, 6, 13, 24];
    for (const [width, height] of sizes) {
        for (const count of counts) {
            for (const selectedId of [null, "user-0"]) {
                const participants = room(count);
                const { first, pages } = collectPages({ width, height, participants, selectedId, options });
                const feedExpected = selectedId !== null && participants.some(p => p.id === selectedId && p.kind === "video");
                for (const items of pages) {
                    assertSceneIsSane(items, width, height, options);
                    for (let a = 0; a < items.length; a++) {
                        for (let b = a + 1; b < items.length; b++) {
                            assert.ok(
                                !overlaps(items[a], items[b]),
                                items[a].id + " and " + items[b].id + " collide at " + width + "x" + height
                            );
                        }
                    }
                    if (feedExpected) {
                        assert.ok(items.some(item => item.selected), "the feed keeps focus on every page");
                    }
                }
                const seen = new Set(pages.flat().map(item => item.id));
                for (const participant of participants) {
                    assert.ok(
                        seen.has(participant.id) || first.overflowIds.includes(participant.id),
                        participant.id + " is placed or reported at " + width + "x" + height
                    );
                }
                if (feedExpected) {
                    assert.ok(!first.overflowIds.includes(selectedId as string), "the feed is never overflow");
                }
            }
        }
    }
});

test("mixed kinds share the field at small densities without overlapping", () => {
    const options = DEFAULT_SPATIAL_LAYOUT_OPTIONS;
    for (const [width, height] of [[1024, 700], [800, 560], [640, 480]]) {
        const participants: SpatialParticipant[] = [
            { id: "cam-1", kind: "video" },
            { id: "cam-2", kind: "video" },
            { id: "off-1", kind: "avatar" },
            { id: "off-2", kind: "avatar" },
            { id: "off-3", kind: "avatar" },
            { id: "off-4", kind: "avatar" }
        ];
        const { pages } = collectPages({ width, height, participants, selectedId: null, options });
        for (const items of pages) {
            for (let a = 0; a < items.length; a++) {
                for (let b = a + 1; b < items.length; b++) {
                    assert.ok(!overlaps(items[a], items[b]), `${items[a].id} and ${items[b].id} at ${width}x${height}`);
                }
            }
        }
    }
});
