import { useEffect, useRef } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";
import knnModel from "./knn_model.json";

const TOPIC = "aircanvas-drawing";
const LABELS = ["DRAW", "ERASE", "CLEAR", "NONE"];

function featuresFromLandmarks(landmarks, mirrorX = false) {
    const wrist = landmarks[0];
    const features = [];

    for (const point of landmarks) {
        // The trained model is right-hand oriented.  For a left hand,
        // reflecting X around the wrist converts it into the same canonical
        // shape without changing the user's actual drawing coordinates.
        const relativeX = point.x - wrist.x;
        const canonicalX = mirrorX
            ? -relativeX
            : relativeX;

        features.push(canonicalX);
        features.push(point.y - wrist.y);
        features.push(point.z - wrist.z);
    }

    return features;
}

function predictKNN(features) {
    let bestDistance = Infinity;
    let bestLabel = 3;

    const scaledFeatures = new Array(63);

    for (let j = 0; j < 63; j += 1) {
        const scale = knnModel.scale[j] || 1;
        scaledFeatures[j] =
            (features[j] - knnModel.mean[j]) / scale;
    }

    for (let i = 0; i < knnModel.trainX.length; i += 1) {
        const row = knnModel.trainX[i];
        let distance = 0;

        for (let j = 0; j < 63; j += 1) {
            const diff = scaledFeatures[j] - row[j];
            distance += diff * diff;

            if (distance >= bestDistance) {
                break;
            }
        }

        if (distance < bestDistance) {
            bestDistance = distance;
            bestLabel = Number(knnModel.trainY[i]);
        }
    }

    return {
        label: LABELS[bestLabel] || "NONE",
        distance: bestDistance,
    };
}

/*
 * The original training set is right-hand oriented.  We therefore classify
 * both the detected hand and its X-reflected version and use whichever is
 * closer to the trained gesture space.  This makes the same four gestures
 * work naturally for left- and right-handed writers without retraining.
 */
function predictHandGesture(landmarks) {
    const normalFeatures =
        featuresFromLandmarks(landmarks, false);

    const mirroredFeatures =
        featuresFromLandmarks(landmarks, true);

    const normalPrediction =
        predictKNN(normalFeatures);

    const mirroredPrediction =
        predictKNN(mirroredFeatures);

    if (
        mirroredPrediction.distance <
        normalPrediction.distance
    ) {
        return mirroredPrediction.label;
    }

    return normalPrediction.label;
}

function smoothPoint(previous, current, alpha = 0.58) {
    if (!previous) return current;

    return {
        x:
            previous.x +
            (current.x - previous.x) * alpha,
        y:
            previous.y +
            (current.y - previous.y) * alpha,
    };
}

/*
 * MediaPipe coordinates are normalized against the actual camera frame.
 * ParticipantTile normally uses object-fit: cover, so simply multiplying
 * x/y by the canvas size can be wrong when the aspect ratios differ.
 *
 * This function reproduces the object-fit: cover transform so that the
 * annotation stays on the same visual position as the hand/video.
 */
function normalizedToCanvas(
    point,
    canvasWidth,
    canvasHeight,
    videoWidth,
    videoHeight,
    mirrored
) {
    if (!point) return null;

    if (
        !videoWidth ||
        !videoHeight ||
        !canvasWidth ||
        !canvasHeight
    ) {
        return {
            x: point.x * canvasWidth,
            y: point.y * canvasHeight,
        };
    }

    const scale = Math.max(
        canvasWidth / videoWidth,
        canvasHeight / videoHeight
    );

    const renderedWidth =
        videoWidth * scale;

    const renderedHeight =
        videoHeight * scale;

    const offsetX =
        (canvasWidth - renderedWidth) / 2;

    const offsetY =
        (canvasHeight - renderedHeight) / 2;

    const sourceX = mirrored
        ? 1 - point.x
        : point.x;

    return {
        x:
            offsetX +
            sourceX * renderedWidth,
        y:
            offsetY +
            point.y * renderedHeight,
    };
}

function getCanvasPoint(
    point,
    canvas,
    video,
    mirrored
) {
    return normalizedToCanvas(
        point,
        canvas.clientWidth || canvas.width,
        canvas.clientHeight || canvas.height,
        video?.videoWidth || 0,
        video?.videoHeight || 0,
        mirrored
    );
}

/*
 * `color` is new: both draw helpers now accept an explicit stroke/fill
 * color instead of the old hardcoded "#00ff66". Falling back to
 * "#00ff66" when color is missing keeps old history entries (drawn
 * before this feature existed, with no `color` field) rendering
 * exactly as they always did.
 */
function drawLine(
    ctx,
    from,
    to,
    mode,
    width,
    color
) {
    if (!from || !to) return;

    ctx.save();

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = width;

    if (mode === "ERASE") {
        ctx.globalCompositeOperation =
            "destination-out";
    } else {
        ctx.globalCompositeOperation =
            "source-over";
        ctx.strokeStyle = color || "#00ff66";
    }

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    ctx.restore();
}

function drawDot(
    ctx,
    point,
    mode,
    width,
    color
) {
    if (!point) return;

    ctx.save();

    ctx.globalCompositeOperation =
        mode === "ERASE"
            ? "destination-out"
            : "source-over";

    ctx.fillStyle = color || "#00ff66";

    ctx.beginPath();
    ctx.arc(
        point.x,
        point.y,
        width / 2,
        0,
        Math.PI * 2
    );
    ctx.fill();

    ctx.restore();
}

export default function AirCanvas({
    activeUserIdentity,
    tileIdentity,
    isController = false,
    mirror = false,
    showOverlay = true,
    /*
     * NEW: the writer's chosen marker color/size. Only meaningful on
     * the instance where isController is true — that's the only place
     * that ever calls processGesture and therefore the only place
     * that ever originates a NEW stroke. Every other instance (other
     * tiles, other participants' browsers) only ever replays events
     * it received or read from history, and those events now carry
     * their own `color`/`width`, so they render correctly regardless
     * of what this prop happens to be set to locally.
     */
    markerColor = "#00ff66",
    markerWidth = 4,
    eraserWidth = 68,
}) {
    const canvasTileIdentity =
        tileIdentity || activeUserIdentity;
    const room = useRoomContext();

    const canvasRef =
        useRef(null);

    const processingVideoRef =
        useRef(null);

    const handsRef =
        useRef(null);

    const animationRef =
        useRef(null);

    const lastPointRef =
        useRef(null);

    const lastModeRef =
        useRef("NONE");

    const candidateModeRef =
        useRef("NONE");

    const candidateCountRef =
        useRef(0);

    const stableModeRef =
        useRef("NONE");

    const clearTriggeredRef =
        useRef(false);

    const historyRef =
        useRef([]);

    const processingRef =
        useRef(false);

    const lastVideoTrackIdRef =
        useRef(null);

    const mountedRef =
        useRef(true);

    /*
     * processGesture is invoked from inside a MediaPipe callback that
     * was registered once (see the "Load legacy MediaPipe Hands"
     * effect below) and is not re-created every time markerColor/
     * markerWidth change. Reading them through a ref (kept fresh by
     * the two tiny effects right below) means changing the color or
     * size mid-meeting takes effect on the very next frame, with no
     * need to tear down and reinitialize MediaPipe.
     */
    const markerColorRef =
        useRef(markerColor);

    const markerWidthRef =
        useRef(markerWidth);

    const eraserWidthRef =
        useRef(eraserWidth);

    useEffect(() => {
        markerColorRef.current = markerColor;
    }, [markerColor]);

    useEffect(() => {
        markerWidthRef.current = markerWidth;
    }, [markerWidth]);

    useEffect(() => {
        eraserWidthRef.current = eraserWidth;
    }, [eraserWidth]);

    const send = async (
        message,
        reliable = false
    ) => {
        try {
            const fullMessage = {
                ...message,
                sourceIdentity:
                    room.localParticipant.identity,
                targetIdentity:
                    message.targetIdentity ||
                    canvasTileIdentity,
            };

            /* [AC-SEND] Temporary diagnostic log — remove once the
               drawing-propagation bug is confirmed fixed. */
            console.log(
                "[AC-SEND]",
                fullMessage.event?.type,
                "from",
                fullMessage.sourceIdentity,
                "target",
                fullMessage.targetIdentity
            );

            const payload =
                new TextEncoder().encode(
                    JSON.stringify(fullMessage)
                );

            await room.localParticipant.publishData(
                payload,
                {
                    reliable,
                    topic: TOPIC,
                }
            );
        } catch (error) {
            console.error(
                "AirCanvas data error:",
                error
            );
        }
    };

    const resizeCanvas = () => {
        const canvas =
            canvasRef.current;

        if (!canvas) return;

        const rect =
            canvas.getBoundingClientRect();

        const dpr =
            window.devicePixelRatio || 1;

        const width =
            Math.max(
                1,
                Math.round(
                    rect.width * dpr
                )
            );

        const height =
            Math.max(
                1,
                Math.round(
                    rect.height * dpr
                )
            );

        if (
            canvas.width === width &&
            canvas.height === height
        ) {
            return;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx =
            canvas.getContext("2d");

        ctx.setTransform(
            dpr,
            0,
            0,
            dpr,
            0,
            0
        );

        redrawHistory();
    };

    /*
     * On mount, ask the owner of this tile for whatever they have
     * already drawn (see the "history-request" / "history-dump"
     * handling in the DataReceived effect below). We never need to
     * request our OWN tile's history — nobody but us could have
     * drawn on it, so there is nothing anyone else could send back.
     */
    useEffect(() => {
        /*
         * Guard against the mount-time race where this effect can run
         * before canvasTileIdentity (derived from hostIdentity /
         * LiveKit participant metadata) has resolved yet. Without this
         * guard we'd fire a history-request with targetIdentity: null,
         * which nobody can ever answer — a wasted, silently-dropped
         * packet. Because the effect's dependency array is
         * [canvasTileIdentity], simply bailing out here is enough: the
         * effect automatically re-runs and sends the CORRECT request
         * the moment canvasTileIdentity resolves to a real identity.
         */
        if (!canvasTileIdentity) {
            return;
        }

        if (
            canvasTileIdentity ===
            room.localParticipant.identity
        ) {
            return;
        }

        send(
            {
                type: "canvas-event",
                event: {
                    type: "history-request",
                    targetIdentity: canvasTileIdentity,
                },
            },
            true
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasTileIdentity]);

    const redrawHistory = () => {
        const canvas =
            canvasRef.current;

        if (!canvas) return;

        const ctx =
            canvas.getContext("2d");

        const cssWidth =
            canvas.clientWidth;

        const cssHeight =
            canvas.clientHeight;

        ctx.clearRect(
            0,
            0,
            cssWidth,
            cssHeight
        );

        const video =
            processingVideoRef.current;

        for (
            const event of historyRef.current
        ) {
            if (
                event.type ===
                "clear"
            ) {
                ctx.clearRect(
                    0,
                    0,
                    cssWidth,
                    cssHeight
                );
                continue;
            }

            if (
                event.type ===
                "dot"
            ) {
                const point =
                    getCanvasPoint(
                        event.point,
                        canvas,
                        video,
                        false
                    );

                drawDot(
                    ctx,
                    point,
                    event.mode,
                    event.width,
                    event.color
                );

                continue;
            }

            if (
                event.type ===
                "line"
            ) {
                const from =
                    getCanvasPoint(
                        event.from,
                        canvas,
                        video,
                        false
                    );

                const to =
                    getCanvasPoint(
                        event.to,
                        canvas,
                        video,
                        false
                    );

                drawLine(
                    ctx,
                    from,
                    to,
                    event.mode,
                    event.width,
                    event.color
                );
            }
        }
    };

    const addEvent = (
        event
    ) => {
        historyRef.current.push(
            event
        );

        if (
            historyRef.current.length >
            12000
        ) {
            historyRef.current.splice(
                0,
                2000
            );
        }
    };

    const clearLocalCanvas = (
        record = true
    ) => {
        const canvas =
            canvasRef.current;

        if (!canvas) return;

        const ctx =
            canvas.getContext("2d");

        ctx.clearRect(
            0,
            0,
            canvas.clientWidth,
            canvas.clientHeight
        );

        if (record) {
            addEvent({
                type: "clear",
            });
        }

        lastPointRef.current =
            null;

        lastModeRef.current =
            "NONE";

        candidateModeRef.current =
            "NONE";

        candidateCountRef.current =
            0;

        stableModeRef.current =
            "NONE";
    };

    const processGesture =
        (results) => {
            if (!isController) {
                return;
            }

            const canvas =
                canvasRef.current;

            const video =
                processingVideoRef.current;

            if (
                !canvas ||
                !video
            ) {
                return;
            }

            if (
                !results
                    ?.multiHandLandmarks
                    ?.length
            ) {
                lastPointRef.current =
                    null;

                lastModeRef.current =
                    "NONE";

                candidateModeRef.current =
                    "NONE";

                candidateCountRef.current =
                    0;

                stableModeRef.current =
                    "NONE";

                clearTriggeredRef.current =
                    false;

                return;
            }

            const landmarks =
                results
                    .multiHandLandmarks[0];

            if (
                !landmarks ||
                landmarks.length <
                    21
            ) {
                lastPointRef.current =
                    null;

                lastModeRef.current =
                    "NONE";

                candidateModeRef.current =
                    "NONE";

                candidateCountRef.current =
                    0;

                stableModeRef.current =
                    "NONE";

                clearTriggeredRef.current =
                    false;

                return;
            }

            const detectedGesture =
                predictHandGesture(
                    landmarks
                );

            /*
             * Stabilize the gesture before drawing.  CLEAR gets a slightly
             * shorter confirmation because a closed fist is intentionally a
             * discrete command.  DRAW and ERASE need a few frames so brief
             * MediaPipe pose changes do not break the stroke.
             */
            if (
                detectedGesture ===
                candidateModeRef.current
            ) {
                candidateCountRef.current += 1;
            } else {
                candidateModeRef.current =
                    detectedGesture;
                candidateCountRef.current =
                    1;
            }

            const confirmFrames =
                detectedGesture ===
                "CLEAR"
                    ? 2
                    : 3;

            if (
                candidateCountRef.current >=
                confirmFrames
            ) {
                stableModeRef.current =
                    detectedGesture;
            }

            const gesture =
                stableModeRef.current;

            if (gesture === "CLEAR") {
                lastPointRef.current =
                    null;

                lastModeRef.current =
                    "CLEAR";

                if (!clearTriggeredRef.current) {
                    clearTriggeredRef.current =
                        true;

                    clearLocalCanvas(
                        true
                    );

                    clearTriggeredRef.current =
                        true;

                    send(
                        {
                            type:
                                "canvas-event",
                            event: {
                                type:
                                    "clear",
                                targetIdentity:
                                    canvasTileIdentity,
                            },
                        },
                        true
                    );
                }

                return;
            }

            if (gesture !== "CLEAR") {
                clearTriggeredRef.current =
                    false;
            }

            if (
                gesture !== "DRAW" &&
                gesture !== "ERASE"
            ) {
                lastPointRef.current =
                    null;

                lastModeRef.current =
                    "NONE";

                return;
            }

            const rawPoint = {
                x: Math.max(
                    0,
                    Math.min(
                        1,
                        landmarks[8].x
                    )
                ),
                y: Math.max(
                    0,
                    Math.min(
                        1,
                        landmarks[8].y
                    )
                ),
            };

            /*
             * MIRROR-WRITING CORRECTION.
             *
             * MediaPipe reads the RAW, unmirrored camera feed (the
             * hidden processing <video>, not the visible mirrored
             * tile). But the writer is watching their OWN mirrored
             * self-view while drawing, so they naturally move their
             * real hand in the left-right mirror image of whatever
             * they intend to write — the same reason people write
             * backwards on a foggy mirror or a piece of glass. That
             * means rawPoint.x, exactly as MediaPipe reports it, is
             * already the mirror image of the intended shape.
             *
             * We flip x ONCE here, at the moment of capture, so that
             * `canonicalPoint` is the correctly-oriented, legible
             * coordinate. This is now the ONLY point value that ever
             * goes into smoothing, history, and the network payload
             * (event.point / event.from / event.to).
             *
             * Because the flip already happened here, NOTHING further
             * down the pipeline — local drawing, remote drawing, or
             * history replay — should apply any additional mirroring.
             * Every getCanvasPoint(...) call below now passes `false`
             * for that reason: the coordinate is already correct for
             * everyone, writer included.
             */
            const canonicalPoint = {
                x: 1 - rawPoint.x,
                y: rawPoint.y,
            };

            /* [AC-POINT] Temporary diagnostic log — remove once the
               mirror-writing fix is confirmed on a verified-fresh
               deploy. Throttled to ~once/sec per browser tab so it
               doesn't flood the console during continuous drawing. */
            if (
                !processGesture._lastLog ||
                Date.now() - processGesture._lastLog > 1000
            ) {
                processGesture._lastLog = Date.now();
                console.log(
                    "[AC-POINT]",
                    "who-drew",
                    room.localParticipant.identity,
                    "onTile",
                    canvasTileIdentity,
                    "rawX",
                    rawPoint.x.toFixed(3),
                    "canonicalX",
                    canonicalPoint.x.toFixed(3)
                );
            }

            const point =
                smoothPoint(
                    lastPointRef.current,
                    canonicalPoint
                );

            /*
             * NEW: width/color now come from the writer's current
             * choice (via the refs kept fresh above) instead of a
             * hardcoded "4" / "#00ff66". ERASE keeps its own fixed,
             * separately-tuned width — the "marker size" control is
             * only meant to affect the DRAW marker, not the eraser
             * footprint, so eraser feel is completely unchanged.
             */
            const width =
                gesture === "ERASE"
                    ? eraserWidthRef.current
                    : markerWidthRef.current;

            const color =
                markerColorRef.current;

            const ctx =
                canvas.getContext(
                    "2d"
                );

            const canvasPoint =
                getCanvasPoint(
                    point,
                    canvas,
                    video,
                    false
                );

            if (
                lastModeRef.current !==
                    gesture ||
                !lastPointRef.current
            ) {
                lastPointRef.current =
                    point;

                lastModeRef.current =
                    gesture;

                drawDot(
                    ctx,
                    canvasPoint,
                    gesture,
                    width,
                    color
                );

                const event = {
                    type: "dot",
                    mode: gesture,
                    point,
                    width,
                    color,
                    targetIdentity: canvasTileIdentity,
                };

                addEvent(event);

                send(
                    {
                        type:
                            "canvas-event",
                        event,
                    },
                    false
                );

                return;
            }

            const distance =
                Math.hypot(
                    point.x -
                        lastPointRef.current
                            .x,
                    point.y -
                        lastPointRef.current
                            .y
                );

            /*
             * A very large jump means the hand tracking
             * temporarily lost the finger. Start again
             * instead of drawing a diagonal across the board.
             */
            if (
                distance >
                0.12
            ) {
                lastPointRef.current =
                    point;

                return;
            }

            const event = {
                type: "line",
                mode: gesture,
                from:
                    lastPointRef.current,
                to: point,
                width,
                color,
                targetIdentity: canvasTileIdentity,
            };

            const from =
                getCanvasPoint(
                    event.from,
                    canvas,
                    video,
                    false
                );

            const to =
                getCanvasPoint(
                    event.to,
                    canvas,
                    video,
                    false
                );

            drawLine(
                ctx,
                from,
                to,
                gesture,
                width,
                color
            );

            addEvent(event);

            send(
                {
                    type:
                        "canvas-event",
                    event,
                },
                false
            );

            lastPointRef.current =
                point;
        };

    /*
     * Receive drawing events from every participant.
     * Every client renders the same normalized coordinates
     * over the active participant's video tile.
     */
    useEffect(() => {
        const handler = (
            payload,
            sourceParticipant,
            _kind,
            topic
        ) => {
            /* [AC-RECV] Temporary diagnostic log — remove once the
               drawing-propagation bug is confirmed fixed. Fires for
               EVERY DataReceived event on this room, regardless of
               topic, so we can tell whether the packet is arriving
               on this browser at all. */
            console.log(
                "[AC-RECV] raw",
                {
                    topic,
                    from: sourceParticipant?.identity,
                    myTile: canvasTileIdentity,
                    showing:
                        canvasRef.current
                            ?.style.display,
                }
            );

            if (
                topic !== TOPIC
            ) {
                return;
            }

            try {
                const message =
                    JSON.parse(
                        new TextDecoder().decode(
                            payload
                        )
                    );

                if (
                    message.type !==
                    "canvas-event"
                ) {
                    return;
                }

                const event =
                    message.event;

                if (!event) {
                    return;
                }

                /* [AC-RECV] Temporary diagnostic log — remove once
                   the drawing-propagation bug is confirmed fixed. */
                console.log(
                    "[AC-RECV] parsed",
                    event.type,
                    "src",
                    message.sourceIdentity,
                    "eventTarget",
                    event.targetIdentity,
                    "myTile",
                    canvasTileIdentity
                );

                /*
                 * CANVAS HISTORY SYNC
                 *
                 * A participant whose AirCanvas instance just mounted
                 * (they joined mid-meeting, or a tile just appeared)
                 * starts with an empty historyRef. Without this, they
                 * see nothing already drawn on that tile until its
                 * owner draws something NEW — the "host draws, but a
                 * participant who joined late sees nothing" bug.
                 *
                 * Only the participant whose OWN identity equals a
                 * tile's identity can ever have authoritative history
                 * for that tile (that is the only client that has ever
                 * been allowed to draw on it), so a viewer asks that
                 * owner directly and the owner replies with a one-time
                 * full dump, independent of who currently holds AirCanvas
                 * write permission.
                 */
                if (event.type === "history-request") {
                    if (
                        message.sourceIdentity ===
                        room.localParticipant.identity
                    ) {
                        // Our own request, echoed back to us. Ignore it.
                        return;
                    }

                    if (
                        event.targetIdentity ===
                            canvasTileIdentity &&
                        canvasTileIdentity ===
                            room.localParticipant.identity
                    ) {
                        send(
                            {
                                type: "canvas-event",
                                event: {
                                    type: "history-dump",
                                    history:
                                        historyRef.current,
                                },
                                targetIdentity:
                                    message.sourceIdentity,
                            },
                            true
                        );
                    }

                    return;
                }

                if (event.type === "history-dump") {
                    if (
                        message.targetIdentity ===
                            room.localParticipant.identity &&
                        message.sourceIdentity ===
                            canvasTileIdentity
                    ) {
                        historyRef.current =
                            Array.isArray(event.history)
                                ? event.history
                                : [];

                        redrawHistory();
                    }

                    return;
                }

                /*
                 * Each AirCanvas belongs to exactly one participant tile.
                 * Route a drawing by the identity of the participant who
                 * produced it. This prevents one person's stroke from being
                 * rendered on every tile. targetIdentity is retained only as
                 * a compatibility guard for older packets.
                 */
                const sourceIdentity =
                    event.sourceIdentity ||
                    message.sourceIdentity ||
                    sourceParticipant?.identity;

                if (
                    sourceIdentity &&
                    sourceIdentity !== canvasTileIdentity
                ) {
                    return;
                }

                if (
                    event.targetIdentity &&
                    event.targetIdentity !== canvasTileIdentity
                ) {
                    return;
                }

                const routedEvent = {
                    ...event,
                    sourceIdentity,
                };

                /*
                 * The controller already draws its own event locally.
                 * Ignore the echoed packet from LiveKit on that same
                 * browser so the local stroke is not duplicated.
                 */
                if (
                    sourceParticipant?.identity ===
                    room.localParticipant.identity
                ) {
                    return;
                }

                if (
                    event.type ===
                    "clear"
                ) {
                    historyRef.current.push(
                        routedEvent
                    );

                    clearLocalCanvas(
                        false
                    );

                    return;
                }

                if (
                    event.type !==
                        "line" &&
                    event.type !==
                        "dot"
                ) {
                    return;
                }

                addEvent(routedEvent);

                const canvas =
                    canvasRef.current;

                if (!canvas) {
                    return;
                }

                const ctx =
                    canvas.getContext(
                        "2d"
                    );

                const video =
                    processingVideoRef.current;

                if (
                    event.type ===
                    "dot"
                ) {
                    const point =
                        getCanvasPoint(
                            routedEvent.point,
                            canvas,
                            video,
                            false
                        );

                    drawDot(
                        ctx,
                        point,
                        routedEvent.mode,
                        routedEvent.width,
                        routedEvent.color
                    );
                } else {
                    const from =
                        getCanvasPoint(
                            routedEvent.from,
                            canvas,
                            video,
                            false
                        );

                    const to =
                        getCanvasPoint(
                            routedEvent.to,
                            canvas,
                            video,
                            false
                        );

                    drawLine(
                        ctx,
                        from,
                        to,
                        routedEvent.mode,
                        routedEvent.width,
                        routedEvent.color
                    );
                }
            } catch (error) {
                console.error(
                    "AirCanvas receive error:",
                    error
                );
            }
        };

        room.on(
            RoomEvent.DataReceived,
            handler
        );

        return () => {
            room.off(
                RoomEvent.DataReceived,
                handler
            );
        };
    }, [
        room,
        activeUserIdentity,
        mirror,
    ]);

    /*
     * Attach the controller's existing LiveKit camera
     * track to an invisible processing video.
     *
     * We NEVER create a second camera stream.
     */
    useEffect(() => {
        let stopped =
            false;

        const attachVideo =
            () => {
                if (stopped) return;

                const participant =
                    canvasTileIdentity ===
                    room.localParticipant.identity
                        ? room.localParticipant
                        : room.remoteParticipants.get(
                              canvasTileIdentity
                          );

                const publication =
                    participant?.getTrackPublication(
                        Track.Source.Camera
                    );

                const track =
                    publication?.track;

                const video =
                    processingVideoRef.current;

                if (
                    !video ||
                    !track?.mediaStreamTrack
                ) {
                    return;
                }

                const trackId =
                    track.sid ||
                    track.mediaStreamTrack.id;

                if (
                    lastVideoTrackIdRef.current ===
                    trackId
                ) {
                    return;
                }

                video.srcObject =
                    new MediaStream([
                        track.mediaStreamTrack,
                    ]);

                video.muted =
                    true;

                video.playsInline =
                    true;

                video.play().catch(
                    () => {}
                );

                lastVideoTrackIdRef.current =
                    trackId;
            };

        lastVideoTrackIdRef.current = null;

        if (processingVideoRef.current) {
            processingVideoRef.current.srcObject = null;
        }

        attachVideo();

        const interval =
            window.setInterval(
                attachVideo,
                400
            );

        return () => {
            stopped = true;
            window.clearInterval(
                interval
            );

            if (processingVideoRef.current) {
                processingVideoRef.current.pause?.();
                processingVideoRef.current.srcObject = null;
            }

            lastVideoTrackIdRef.current = null;
        };
    }, [
        room,
        canvasTileIdentity,
    ]);

    /*
     * Load legacy MediaPipe Hands.
     * This keeps the tested KNN model and browser pipeline.
     */
    useEffect(() => {
        if (!isController) {
            return undefined;
        }

        let cancelled =
            false;

        const loadScript =
            (src) =>
                new Promise(
                    (
                        resolve,
                        reject
                    ) => {
                        const existing =
                            document.querySelector(
                                `script[src="${src}"]`
                            );

                        if (
                            existing
                        ) {
                            if (
                                window.Hands
                            ) {
                                resolve();
                            } else {
                                existing.addEventListener(
                                    "load",
                                    resolve,
                                    {
                                        once: true,
                                    }
                                );

                                existing.addEventListener(
                                    "error",
                                    reject,
                                    {
                                        once: true,
                                    }
                                );
                            }

                            return;
                        }

                        const script =
                            document.createElement(
                                "script"
                            );

                        script.src =
                            src;

                        script.async =
                            true;

                        script.onload =
                            resolve;

                        script.onerror =
                            reject;

                        document.head.appendChild(
                            script
                        );
                    }
                );

        const initialize =
            async () => {
                try {
                    await loadScript(
                        "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js"
                    );

                    if (
                        cancelled ||
                        !window.Hands
                    ) {
                        return;
                    }

                    const hands =
                        new window.Hands(
                            {
                                locateFile:
                                    (
                                        file
                                    ) =>
                                        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
                            }
                        );

                    hands.setOptions(
                        {
                            maxNumHands: 1,
                            modelComplexity: 1,
                            minDetectionConfidence: 0.7,
                            minTrackingConfidence: 0.7,
                        }
                    );

                    hands.onResults(
                        (results) => {
                            processGesture(
                                results
                            );
                            processingRef.current =
                                false;
                        }
                    );

                    handsRef.current =
                        hands;
                } catch (error) {
                    console.error(
                        "MediaPipe initialization error:",
                        error
                    );
                }
            };

        initialize();

        return () => {
            cancelled = true;

            handsRef.current?.close?.();

            handsRef.current =
                null;
        };
    }, [
        isController,
        mirror,
    ]);

    /*
     * Run MediaPipe continuously while this participant
     * owns AirCanvas control.
     */
    useEffect(() => {
        if (!isController) {
            return undefined;
        }

        let stopped =
            false;

        const run =
            async () => {
                if (stopped) {
                    return;
                }

                const video =
                    processingVideoRef.current;

                const hands =
                    handsRef.current;

                if (
                    video &&
                    hands &&
                    !processingRef.current &&
                    video.readyState >= 2 &&
                    video.videoWidth > 0
                ) {
                    processingRef.current =
                        true;

                    try {
                        await hands.send(
                            {
                                image:
                                    video,
                            }
                        );
                    } catch (error) {
                        processingRef.current =
                            false;

                        console.error(
                            "AirCanvas AI frame error:",
                            error
                        );
                    }
                }

                if (!stopped) {
                    animationRef.current =
                        requestAnimationFrame(
                            run
                        );
                }
            };

        animationRef.current =
            requestAnimationFrame(
                run
            );

        return () => {
            stopped = true;

            if (
                animationRef.current
            ) {
                cancelAnimationFrame(
                    animationRef.current
                );
            }

            lastPointRef.current =
                null;

            lastModeRef.current =
                "NONE";

            candidateModeRef.current =
                "NONE";

            candidateCountRef.current =
                0;

            stableModeRef.current =
                "NONE";

            clearTriggeredRef.current =
                false;

            processingRef.current =
                false;
        };
    }, [
        isController,
    ]);

    /*
     * Resize the transparent overlay whenever the tile changes.
     */
    useEffect(() => {
        mountedRef.current =
            true;

        const resize =
            () => {
                if (
                    !mountedRef.current
                ) {
                    return;
                }

                resizeCanvas();
            };

        resize();

        const observer =
            new ResizeObserver(
                resize
            );

        if (
            canvasRef.current
        ) {
            observer.observe(
                canvasRef.current
            );
        }

        window.addEventListener(
            "resize",
            resize
        );

        return () => {
            mountedRef.current =
                false;

            observer.disconnect();

            window.removeEventListener(
                "resize",
                resize
            );
        };
    }, []);

    /*
     * Redraw when the tile/video becomes available.
     */
    useEffect(() => {
        const timer =
            window.setTimeout(
                () => {
                    resizeCanvas();
                    redrawHistory();
                },
                150
            );

        return () =>
            window.clearTimeout(
                timer
            );
    }, [
        canvasTileIdentity,
        activeUserIdentity,
        showOverlay,
    ]);

    return (
        <>
            <canvas
                ref={canvasRef}
                className="aircanvas-camera-overlay"
                aria-hidden="true"
                style={{
                    position:
                        "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    zIndex: 25,
                    pointerEvents:
                        "none",
                    display:
                        showOverlay ? "block" : "none",
                }}
            />

            <video
                ref={
                    processingVideoRef
                }
                muted
                playsInline
                autoPlay
                aria-hidden="true"
                style={{
                    position:
                        "fixed",
                    width: "1px",
                    height: "1px",
                    left:
                        "-10000px",
                    top:
                        "-10000px",
                    opacity: 0,
                    pointerEvents:
                        "none",
                }}
            />
        </>
    );
}