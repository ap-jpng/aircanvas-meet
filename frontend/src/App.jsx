import {
    useEffect,
    useRef,
    useState,
} from "react";

import {
    LiveKitRoom,
    ParticipantTile,
    RoomAudioRenderer,
    Chat,
    useParticipants,
    useTracks,
    useRoomContext,
} from "@livekit/components-react";

import {
    Track,
    RoomEvent,
} from "livekit-client";

import "@livekit/components-styles";
import "./App.css";
import AirCanvas from "./AirCanvas";

const BACKEND_URL =
   "https://aircanvas-meet.onrender.com";

const AIR_CANVAS_TOPIC =
    "aircanvas-control";

/* =========================================================
   DATA HELPERS
========================================================= */

function sendAirCanvasMessage(room, message) {
    try {
        const data = new TextEncoder().encode(
            JSON.stringify(message)
        );

        room.localParticipant.publishData(
            data,
            {
                reliable: true,
                topic: AIR_CANVAS_TOPIC,
            }
        );
    } catch (error) {
        console.error(
            "AirCanvas data error:",
            error
        );
    }
}

/* =========================================================
   MARKER CONTROLS
   Shared between the side panel and the floating popover so
   both stay in sync automatically -- there's only one copy
   of the actual markup and behaviour.
========================================================= */

function MarkerControls({
    color,
    setColor,
    width,
    setWidth,
    presets,
    eraserWidth,
    setEraserWidth,
}) {
    return (
        <>
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginBottom: "12px",
                }}
            >
                {presets.map((preset) => (
                    <button
                        key={preset}
                        type="button"
                        onClick={() =>
                            setColor(preset)
                        }
                        title={preset}
                        style={{
                            width: "26px",
                            height: "26px",
                            borderRadius: "50%",
                            cursor: "pointer",
                            background: preset,
                            border:
                                color === preset
                                    ? "2px solid #ffffff"
                                    : "2px solid rgba(255,255,255,0.15)",
                            boxShadow:
                                color === preset
                                    ? "0 0 0 2px rgba(37,211,238,0.5)"
                                    : "none",
                        }}
                    />
                ))}

                <input
                    type="color"
                    value={color}
                    onChange={(event) =>
                        setColor(event.target.value)
                    }
                    title="Custom color"
                    style={{
                        width: "26px",
                        height: "26px",
                        padding: 0,
                        border: "none",
                        borderRadius: "50%",
                        background: "transparent",
                        cursor: "pointer",
                    }}
                />
            </div>

            <label
                style={{
                    display: "flex",
                    justifyContent: "space-between",
                    color: "#d6dce7",
                    fontSize: "12px",
                    fontWeight: 600,
                    marginBottom: "4px",
                }}
            >
                <span>Marker size</span>
                <span>{width}px</span>
            </label>

            <input
                type="range"
                min="2"
                max="14"
                step="1"
                value={width}
                onChange={(event) =>
                    setWidth(Number(event.target.value))
                }
                style={{ width: "100%", marginBottom: "12px" }}
            />

            {/*
              * Eraser size is intentionally a separate slider with its
              * own, much larger range -- the eraser has always used a
              * fixed 68px footprint in AirCanvas.jsx, so the useful
              * range for "how big an area does one erase gesture
              * clear" is naturally much bigger than the 2-14px range
              * that makes sense for a drawing line.
              */}
            <label
                style={{
                    display: "flex",
                    justifyContent: "space-between",
                    color: "#d6dce7",
                    fontSize: "12px",
                    fontWeight: 600,
                    marginBottom: "4px",
                }}
            >
                <span>Eraser size</span>
                <span>{eraserWidth}px</span>
            </label>

            <input
                type="range"
                min="20"
                max="140"
                step="4"
                value={eraserWidth}
                onChange={(event) =>
                    setEraserWidth(Number(event.target.value))
                }
                style={{ width: "100%" }}
            />
        </>
    );
}

/* =========================================================
   MEETING ROOM
========================================================= */

function MeetingRoom({
    roomId,
    connectionStatus,
    onLeave,
    isHost,
    initialMicEnabled,
    initialCameraEnabled,
}) {
    const room = useRoomContext();

    const participants =
        useParticipants();

    const cameraTracks = useTracks([
        {
            source: Track.Source.Camera,
            withPlaceholder: true,
        },
    ]);

    const [activePanel, setActivePanel] =
        useState(null);

    const [shareCopied, setShareCopied] =
        useState(false);

    const [micEnabled, setMicEnabled] =
        useState(initialMicEnabled);

    const [cameraEnabled, setCameraEnabled] =
        useState(initialCameraEnabled);

    const [screenSharing, setScreenSharing] =
        useState(false);

    /*
     * The writer's chosen AirCanvas marker color/size. Passed straight
     * through to every <AirCanvas> instance below -- only the instance
     * that is currently this browser's controller ever actually reads
     * them (see the matching comment in AirCanvas.jsx), so handing them
     * to every tile unconditionally is harmless.
     */
    const [markerColor, setMarkerColor] =
        useState("#00ff66");

    const [markerWidth, setMarkerWidth] =
        useState(4);

    /*
     * Eraser size is independent from marker draw width. Defaults to
     * 68 -- the value AirCanvas.jsx used to hardcode -- so nobody's
     * eraser feel changes unless they actually move this slider.
     */
    const [eraserWidth, setEraserWidth] =
        useState(68);

    const MARKER_COLOR_PRESETS = [
        "#00ff66",
        "#25d3ee",
        "#ff4d6d",
        "#ffd23f",
        "#ffffff",
    ];

    /*
     * Whether the small floating marker popover (the pen icon on the
     * local user's own video tile) is open. Independent of the side
     * panel -- either one can be used to change color/size.
     */
    const [showMarkerPopover, setShowMarkerPopover] =
        useState(false);

    const [
        airCanvasAllowed,
        setAirCanvasAllowed,
    ] = useState(false);

    /*
     * explicitAirCanvasWriter is set ONLY by an explicit grant/revoke/
     * state-sync message ("aircanvas-granted", "aircanvas-revoked",
     * "aircanvas-state"). null means "nobody has been explicitly
     * granted control -- default to the host."
     */
    const [
        explicitAirCanvasWriter,
        setExplicitAirCanvasWriter,
    ] = useState(null);

    /*
     * Find the meeting host from LiveKit participant metadata.
     * The backend places { isHost: true } in the host token metadata,
     * so every participant can identify the host.
     */
    const hostParticipant =
        participants.find(
            (participant) => {
                try {
                    const metadata =
                        JSON.parse(
                            participant.metadata ||
                                "{}"
                        );

                    return (
                        metadata.isHost === true
                    );
                } catch {
                    return false;
                }
            }
        );

    const hostIdentity =
        hostParticipant?.identity ||
        (
            isHost
                ? room.localParticipant.identity
                : null
        );

    const airCanvasUser =
        explicitAirCanvasWriter || hostIdentity;

    /*
     * Whether the LOCAL browser is currently the one allowed to draw
     * (on its own tile), regardless of which tile is being displayed
     * where. Mirrors the per-tile `isController` expression used below
     * for the tile that happens to match this browser's own identity.
     * Used only to decide whether to show the marker color/size
     * controls -- it doesn't change who can draw.
     */
    const isLocalController =
        isHost ||
        (
            airCanvasAllowed &&
            airCanvasUser ===
                room.localParticipant.identity
        );

    /*
     * The host always has AirCanvas permission. This no longer needs
     * to touch airCanvasUser at all now that it's derived above.
     */
    useEffect(() => {
        if (isHost) {
            setAirCanvasAllowed(true);
        }
    }, [isHost]);

    const [
        pendingRequest,
        setPendingRequest,
    ] = useState(null);

    /* =====================================================
       PARTICIPANT NAME
    ===================================================== */

    const localName =
        room.localParticipant.name ||
        "Participant";

    /* =====================================================
       AIR CANVAS DATA EVENTS
    ===================================================== */

    useEffect(() => {
        const handleData = (
            payload,
            participant,
            kind,
            topic
        ) => {
            if (
                topic &&
                topic !== AIR_CANVAS_TOPIC
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
                    message.type ===
                    "aircanvas-state-request"
                ) {
                    if (!isHost) {
                        return;
                    }

                    sendAirCanvasMessage(
                        room,
                        {
                            type:
                                "aircanvas-state",
                            identity:
                                airCanvasUser ||
                                room.localParticipant
                                    .identity,
                        }
                    );

                    return;
                }

                if (
                    message.type ===
                    "aircanvas-state"
                ) {
                    const controllerIdentity =
                        message.identity ||
                        hostIdentity;

                    if (controllerIdentity) {
                        setExplicitAirCanvasWriter(
                            controllerIdentity
                        );

                        setAirCanvasAllowed(
                            isHost ||
                            controllerIdentity ===
                                room.localParticipant
                                    .identity
                        );
                    }

                    return;
                }

                if (
                    message.type ===
                    "aircanvas-request"
                ) {
                    if (!isHost) {
                        return;
                    }

                    setPendingRequest({
                        identity:
                            message.identity,
                        name:
                            message.name ||
                            "Participant",
                    });

                    return;
                }

                if (
                    message.type ===
                    "aircanvas-granted"
                ) {
                    setExplicitAirCanvasWriter(
                        message.identity
                    );

                    setAirCanvasAllowed(
                        isHost ||
                        message.identity ===
                            room.localParticipant
                                .identity
                    );

                    return;
                }

                if (
                    message.type ===
                    "aircanvas-revoked"
                ) {
                    setExplicitAirCanvasWriter(
                        null
                    );

                    setAirCanvasAllowed(
                        isHost
                    );

                    return;
                }

                if (
                    message.type ===
                    "aircanvas-denied"
                ) {
                    if (
                        message.identity ===
                        room.localParticipant
                            .identity
                    ) {
                        setAirCanvasAllowed(
                            false
                        );
                    }

                    return;
                }
            } catch (error) {
                console.error(
                    "AirCanvas message error:",
                    error
                );
            }
        };

        room.on(
            RoomEvent.DataReceived,
            handleData
        );

        return () => {
            room.off(
                RoomEvent.DataReceived,
                handleData
            );
        };
    }, [
        room,
        isHost,
        hostIdentity,
        airCanvasUser,
    ]);

    /* =====================================================
       SYNC AIR CANVAS STATE FOR NEW PARTICIPANTS
    ===================================================== */

    useEffect(() => {
        const timer =
            window.setTimeout(() => {
                sendAirCanvasMessage(
                    room,
                    {
                        type:
                            "aircanvas-state-request",
                    }
                );
            }, 500);

        return () =>
            window.clearTimeout(timer);
    }, [room]);

    /* =====================================================
       MICROPHONE
    ===================================================== */

    const toggleMicrophone =
        async () => {
            try {
                const enabled =
                    !room.localParticipant
                        .isMicrophoneEnabled;

                await room.localParticipant
                    .setMicrophoneEnabled(
                        enabled
                    );

                setMicEnabled(
                    enabled
                );
            } catch (error) {
                console.error(
                    "Microphone toggle error:",
                    error
                );
            }
        };

    /* =====================================================
       CAMERA
    ===================================================== */

    const toggleCamera =
        async () => {
            try {
                const enabled =
                    !room.localParticipant
                        .isCameraEnabled;

                await room.localParticipant
                    .setCameraEnabled(
                        enabled
                    );

                setCameraEnabled(
                    enabled
                );
            } catch (error) {
                console.error(
                    "Camera toggle error:",
                    error
                );
            }
        };

    /* =====================================================
       SCREEN SHARE
    ===================================================== */

    const toggleScreenShare =
        async () => {
            try {
                const enabled =
                    !screenSharing;

                await room.localParticipant
                    .setScreenShareEnabled(
                        enabled
                    );

                setScreenSharing(
                    enabled
                );
            } catch (error) {
                console.error(
                    "Screen share error:",
                    error
                );
            }
        };

    /* =====================================================
       REQUEST AIR CANVAS
    ===================================================== */

    const requestAirCanvas =
        () => {
            sendAirCanvasMessage(
                room,
                {
                    type:
                        "aircanvas-request",
                    identity:
                        room.localParticipant
                            .identity,
                    name: localName,
                }
            );

            setPendingRequest({
                waiting: true,
            });
        };

    /* =====================================================
       ALLOW AIR CANVAS
    ===================================================== */

    const allowAirCanvas =
        (identity) => {
            if (!isHost) {
                return;
            }

            sendAirCanvasMessage(
                room,
                {
                    type:
                        "aircanvas-granted",
                    identity,
                }
            );

            setExplicitAirCanvasWriter(
                identity
            );

            setAirCanvasAllowed(
                isHost
            );

            setPendingRequest(
                null
            );
        };

    /* =====================================================
       DENY AIR CANVAS
    ===================================================== */

    const denyAirCanvas =
        (identity) => {
            if (!isHost) {
                return;
            }

            sendAirCanvasMessage(
                room,
                {
                    type:
                        "aircanvas-denied",
                    identity,
                }
            );

            setPendingRequest(
                null
            );
        };

    /* =====================================================
       REVOKE AIR CANVAS
    ===================================================== */

    const revokeAirCanvas =
        (identity) => {
            if (!isHost) {
                return;
            }

            sendAirCanvasMessage(
                room,
                {
                    type:
                        "aircanvas-revoked",
                    identity,
                }
            );

            setExplicitAirCanvasWriter(
                null
            );

            setAirCanvasAllowed(
                isHost
            );
        };

    /* =====================================================
       AIR CANVAS BUTTON
    ===================================================== */

    const handleAirCanvas =
        () => {
            if (isHost) {
                setActivePanel(
                    "aircanvas"
                );

                return;
            }

            if (airCanvasAllowed) {
                setActivePanel(
                    "aircanvas"
                );

                return;
            }

            if (
                pendingRequest?.waiting
            ) {
                return;
            }

            requestAirCanvas();
        };

    /* =====================================================
       LEAVE
    ===================================================== */

    const handleLeave =
        async () => {
            try {
                await room.disconnect();
            } catch (error) {
                console.error(
                    "Disconnect error:",
                    error
                );
            } finally {
                onLeave();
            }
        };

    /* =====================================================
       SHARE CURRENT MEETING
    ===================================================== */

    const handleShareMeeting =
        async () => {
            try {
                const meetingLink =
                    `${window.location.origin}/meeting/${roomId}`;

                if (
                    navigator.clipboard &&
                    window.isSecureContext
                ) {
                    await navigator.clipboard.writeText(
                        meetingLink
                    );
                } else {
                    const textArea =
                        document.createElement("textarea");

                    textArea.value =
                        meetingLink;

                    textArea.style.position =
                        "fixed";
                    textArea.style.opacity =
                        "0";

                    document.body.appendChild(
                        textArea
                    );

                    textArea.focus();
                    textArea.select();

                    document.execCommand(
                        "copy"
                    );

                    document.body.removeChild(
                        textArea
                    );
                }

                setShareCopied(true);

                setTimeout(() => {
                    setShareCopied(false);
                }, 2000);
            } catch (error) {
                console.error(
                    "Share meeting error:",
                    error
                );
            }
        };

    /* =====================================================
       PANEL
    ===================================================== */

    const togglePanel =
        (panel) => {
            setActivePanel(
                (current) =>
                    current === panel
                        ? null
                        : panel
            );
        };

    /* =====================================================
       RENDER
    ===================================================== */

    return (
        <div className="meeting-room">

            {/* HEADER */}

            <header className="meeting-header">

                <div className="brand-section">

                    <div className="brand-icon">
                        ✋
                    </div>

                    <div>
                        <h1>
                            AirCanvas Meet
                        </h1>

                        <span>
                            Online Classroom
                        </span>
                    </div>

                </div>

                <div className="meeting-header-center">

                    <div className="connection-pill">
                        <span className="connection-dot" />
                        {connectionStatus}
                    </div>

                </div>

                <div className="meeting-header-right">

                    <button
                        className="header-action"
                        onClick={
                            handleShareMeeting
                        }
                        title={
                            shareCopied
                                ? "Meeting link copied"
                                : "Copy current meeting link"
                        }
                    >
                        🔗
                        <span>
                            {shareCopied
                                ? "Copied!"
                                : "Share"}
                        </span>
                    </button>

                    <div className="meeting-id-display">
                        Meeting ID
                        <strong>
                            {roomId}
                        </strong>
                    </div>

                </div>

            </header>

            {/* BODY */}

            <div className="meeting-body">

                <main className="video-area">

                    <div
                        className={`participant-grid participant-count-${Math.min(
                            cameraTracks.length,
                            12
                        )}`}
                    >

                        {cameraTracks.length ===
                        0 ? (
                            <div className="empty-meeting">

                                <div className="empty-meeting-icon">
                                    👤
                                </div>

                                <h2>
                                    Waiting for participants
                                </h2>

                                <p>
                                    Share the meeting
                                    link to invite
                                    others.
                                </p>

                            </div>
                        ) : (
                            cameraTracks.map(
                                (track) => {
                                    const isOwnTile =
                                        track.participant.identity ===
                                        room.localParticipant.identity;

                                    return (
                                    <div
                                        className="participant-tile-wrapper"
                                        key={
                                            track
                                                .participant
                                                .identity
                                        }
                                        style={{
                                            position: "relative",
                                        }}
                                    >

                                        {/*
                                          * Inner layer: the video tile and the
                                          * drawing canvas, clipped to the tile's
                                          * rounded corners. The marker popover
                                          * deliberately lives OUTSIDE this div --
                                          * it used to be a sibling INSIDE the
                                          * overflow:hidden wrapper, which silently
                                          * clipped it off-screen even though it was
                                          * rendering and its state was toggling
                                          * correctly on click.
                                          */}
                                        <div
                                            style={{
                                                position: "absolute",
                                                inset: 0,
                                                overflow: "hidden",
                                                borderRadius: "inherit",
                                            }}
                                        >
                                            <ParticipantTile
                                                trackRef={
                                                    track
                                                }
                                                className="custom-participant-tile"
                                            />

                                            <AirCanvas
                                                activeUserIdentity={
                                                    airCanvasUser
                                                }
                                                tileIdentity={
                                                    track.participant.identity
                                                }
                                                isController={
                                                    isOwnTile &&
                                                    (
                                                        isHost ||
                                                        (
                                                            airCanvasAllowed &&
                                                            airCanvasUser ===
                                                                room.localParticipant.identity
                                                        )
                                                    )
                                                }
                                                showOverlay={
                                                    track.participant.identity ===
                                                    airCanvasUser
                                                }
                                                markerColor={
                                                    markerColor
                                                }
                                                markerWidth={
                                                    markerWidth
                                                }
                                                eraserWidth={
                                                    eraserWidth
                                                }
                                            />
                                        </div>

                                        {/*
                                          * Floating marker pen button, shown only on
                                          * the local user's own tile and only when
                                          * they're actually allowed to draw. Sits
                                          * above LiveKit's built-in connection-quality
                                          * icon (top-right of the tile) so it doesn't
                                          * overlap it. Adjust the `top` value below if
                                          * your LiveKit version positions that icon
                                          * differently.
                                          */}
                                        {isOwnTile &&
                                            isLocalController && (
                                            <div
                                                style={{
                                                    position: "absolute",
                                                    top: "10px",
                                                    right: "10px",
                                                    zIndex: 40,
                                                }}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setShowMarkerPopover(
                                                            (value) => !value
                                                        )
                                                    }
                                                    title="Marker settings"
                                                    aria-label="Marker settings"
                                                    aria-expanded={showMarkerPopover}
                                                    style={{
                                                        width: "48px",
                                                        height: "48px",
                                                        borderRadius: "50%",
                                                        border: "2px solid rgba(255,255,255,0.35)",
                                                        background: "rgba(12,15,22,0.85)",
                                                        color: "#fff",
                                                        fontSize: "24px",
                                                        lineHeight: "1",
                                                        cursor: "pointer",
                                                        display: "flex",
                                                        alignItems: "center",
                                                        justifyContent: "center",
                                                        boxShadow: "0 3px 10px rgba(0,0,0,0.45)",
                                                    }}
                                                >
                                                    🖊️
                                                </button>

                                                {showMarkerPopover && (
                                                    <div
                                                        style={{
                                                            position: "absolute",
                                                            top: "56px",
                                                            right: 0,
                                                            width: "220px",
                                                            padding: "14px",
                                                            borderRadius: "10px",
                                                            background: "rgba(13,17,26,0.94)",
                                                            border: "1px solid rgba(255,255,255,0.12)",
                                                            boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
                                                            zIndex: 50,
                                                        }}
                                                    >
                                                        <MarkerControls
                                                            color={markerColor}
                                                            setColor={setMarkerColor}
                                                            width={markerWidth}
                                                            setWidth={setMarkerWidth}
                                                            presets={MARKER_COLOR_PRESETS}
                                                            eraserWidth={eraserWidth}
                                                            setEraserWidth={setEraserWidth}
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        <div className="participant-overlay">

                                            <div className="participant-name">
                                                {track
                                                    .participant
                                                    .name ||
                                                    track
                                                        .participant
                                                        .identity}

                                                {track
                                                    .participant
                                                    .identity ===
                                                    hostIdentity && (
                                                        <span>
                                                            {" "}
                                                            • Host
                                                        </span>
                                                    )}

                                                {airCanvasUser ===
                                                    track
                                                        .participant
                                                        .identity && (
                                                    <span>
                                                        {" "}
                                                        • AirCanvas
                                                    </span>
                                                )}
                                            </div>

                                            <div className="participant-mic">
                                                {track
                                                    .participant
                                                    .isMicrophoneEnabled
                                                    ? "🎤"
                                                    : "🔇"}
                                            </div>

                                        </div>

                                    </div>
                                    );
                                }
                            )
                        )}

                    </div>

                </main>

                {/* SIDE PANEL */}

                {activePanel && (
                    <aside className="side-panel">

                        <div className="side-panel-header">

                            <div>

                                {activePanel ===
                                "participants" ? (
                                    <>
                                        <h2>
                                            Participants
                                        </h2>

                                        <span>
                                            {
                                                participants.length
                                            }{" "}
                                            in meeting
                                        </span>
                                    </>
                                ) : activePanel ===
                                  "aircanvas" ? (
                                    <>
                                        <h2>
                                            AirCanvas
                                        </h2>

                                        <span>
                                            {isHost
                                                ? "Host control"
                                                : airCanvasAllowed
                                                ? "You have access"
                                                : "Permission required"}
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <h2>
                                            Messages
                                        </h2>

                                        <span>
                                            Meeting chat
                                        </span>
                                    </>
                                )}

                            </div>

                            <button
                                className="close-panel"
                                onClick={() =>
                                    setActivePanel(
                                        null
                                    )
                                }
                            >
                                ✕
                            </button>

                        </div>

                        {/* PARTICIPANTS */}

                        {activePanel ===
                            "participants" && (
                            <div className="participants-list">

                                {participants.map(
                                    (
                                        participant
                                    ) => (
                                        <div
                                            className="participant-list-item"
                                            key={
                                                participant.identity
                                            }
                                        >

                                            <div className="participant-avatar">
                                                {(
                                                    participant.name ||
                                                    participant.identity ||
                                                    "U"
                                                )
                                                    .charAt(
                                                        0
                                                    )
                                                    .toUpperCase()}
                                            </div>

                                            <div className="participant-list-info">

                                                <strong>
                                                    {participant.name ||
                                                        participant.identity}
                                                </strong>

                                                {participant.identity ===
                                                    room
                                                        .localParticipant
                                                        .identity && (
                                                    <span>
                                                        You
                                                        {isHost &&
                                                            " • Host"}
                                                    </span>
                                                )}

                                            </div>

                                            <div className="participant-status">

                                                {participant.isMicrophoneEnabled
                                                    ? "🎤"
                                                    : "🔇"}

                                                {participant.isCameraEnabled
                                                    ? "📹"
                                                    : "📹̸"}

                                            </div>

                                        </div>
                                    )
                                )}

                            </div>
                        )}

                        {/* CHAT */}

                        {activePanel ===
                            "chat" && (
                            <div className="chat-panel">
                                <Chat />
                            </div>
                        )}

                        {/* AIR CANVAS CONTROL */}

                        {activePanel ===
                            "aircanvas" && (
                            <div
                                style={{
                                    padding:
                                        "18px",
                                    color:
                                        "#dce3ee",
                                }}
                            >

                                {isLocalController && (
                                    <div
                                        style={{
                                            padding:
                                                "14px",
                                            borderRadius:
                                                "10px",
                                            background:
                                                "#151f31",
                                            marginBottom:
                                                "15px",
                                        }}
                                    >
                                        <strong>
                                            Marker
                                        </strong>

                                        <p
                                            style={{
                                                margin:
                                                    "4px 0 10px",
                                                color:
                                                    "#8995a9",
                                                fontSize:
                                                    "12px",
                                            }}
                                        >
                                            Choose the
                                            color and
                                            size of your
                                            AirCanvas
                                            marker.
                                        </p>

                                        <MarkerControls
                                            color={markerColor}
                                            setColor={setMarkerColor}
                                            width={markerWidth}
                                            setWidth={setMarkerWidth}
                                            presets={MARKER_COLOR_PRESETS}
                                            eraserWidth={eraserWidth}
                                            setEraserWidth={setEraserWidth}
                                        />
                                    </div>
                                )}

                                {isHost ? (
                                    <>
                                        <div
                                            style={{
                                                padding:
                                                    "14px",
                                                borderRadius:
                                                    "10px",
                                                background:
                                                    "#151f31",
                                                marginBottom:
                                                    "15px",
                                            }}
                                        >
                                            <strong>
                                                ✋ Host
                                                Control
                                            </strong>

                                            <p
                                                style={{
                                                    color:
                                                        "#8995a9",
                                                    fontSize:
                                                        "12px",
                                                    lineHeight:
                                                        "1.5",
                                                }}
                                            >
                                                You
                                                always
                                                have
                                                AirCanvas
                                                access.
                                                Participants
                                                must
                                                request
                                                permission
                                                before
                                                using
                                                it.
                                            </p>
                                        </div>

                                        {airCanvasUser ? (
                                            <div
                                                style={{
                                                    padding:
                                                        "14px",
                                                    borderRadius:
                                                        "10px",
                                                    background:
                                                        "#162b2b",
                                                    marginBottom:
                                                        "12px",
                                                }}
                                            >
                                                <strong>
                                                    AirCanvas
                                                    active
                                                </strong>

                                                <p
                                                    style={{
                                                        margin:
                                                            "7px 0 12px",
                                                        color:
                                                            "#9db2b3",
                                                        fontSize:
                                                            "12px",
                                                    }}
                                                >
                                                    {participants.find(
                                                        (
                                                            p
                                                        ) =>
                                                            p.identity ===
                                                            airCanvasUser
                                                    )
                                                        ?.name ||
                                                        "Participant"}
                                                    {" "}
                                                    can
                                                    use
                                                    AirCanvas.
                                                </p>

                                                <button
                                                    className="secondary-button"
                                                    onClick={() =>
                                                        revokeAirCanvas(
                                                            airCanvasUser
                                                        )
                                                    }
                                                >
                                                    Revoke
                                                    Access
                                                </button>
                                            </div>
                                        ) : (
                                            <div
                                                style={{
                                                    padding:
                                                        "14px",
                                                    borderRadius:
                                                        "10px",
                                                    background:
                                                        "#151f31",
                                                    marginBottom:
                                                        "12px",
                                                }}
                                            >
                                                <strong>
                                                    No participant
                                                    has control
                                                </strong>

                                                <p
                                                    style={{
                                                        color:
                                                            "#8995a9",
                                                        fontSize:
                                                            "12px",
                                                    }}
                                                >
                                                    AirCanvas
                                                    is available
                                                    for you.
                                                    It will appear
                                                    directly over
                                                    your camera
                                                    when active.
                                                </p>
                                            </div>
                                        )}

                                        {pendingRequest &&
                                            !pendingRequest.waiting && (
                                                <div
                                                    style={{
                                                        padding:
                                                            "14px",
                                                        borderRadius:
                                                            "10px",
                                                        background:
                                                            "#202a3d",
                                                    }}
                                                >

                                                    <strong>
                                                        AirCanvas
                                                        Request
                                                    </strong>

                                                    <p
                                                        style={{
                                                            color:
                                                                "#c2ccda",
                                                            fontSize:
                                                                "13px",
                                                        }}
                                                    >
                                                        {
                                                            pendingRequest.name
                                                        }{" "}
                                                        wants
                                                        to use
                                                        AirCanvas.
                                                    </p>

                                                    <div
                                                        style={{
                                                            display:
                                                                "flex",
                                                            gap:
                                                                "8px",
                                                        }}
                                                    >

                                                        <button
                                                            className="primary-button"
                                                            onClick={() =>
                                                                allowAirCanvas(
                                                                    pendingRequest.identity
                                                                )
                                                            }
                                                        >
                                                            Allow
                                                        </button>

                                                        <button
                                                            className="secondary-button"
                                                            onClick={() =>
                                                                denyAirCanvas(
                                                                    pendingRequest.identity
                                                                )
                                                            }
                                                        >
                                                            Deny
                                                        </button>

                                                    </div>

                                                </div>
                                            )}

                                    </>
                                ) : airCanvasAllowed ? (
                                    <>
                                        <div
                                            style={{
                                                padding:
                                                    "16px",
                                                borderRadius:
                                                    "10px",
                                                background:
                                                    "#162b2b",
                                            }}
                                        >
                                            <strong>
                                                ✓ AirCanvas
                                                Access Granted
                                            </strong>

                                            <p
                                                style={{
                                                    color:
                                                        "#9db2b3",
                                                    fontSize:
                                                        "12px",
                                                    lineHeight:
                                                        "1.5",
                                                }}
                                            >
                                                The host has
                                                permitted you
                                                to use
                                                AirCanvas.
                                                Your drawing
                                                canvas is
                                                displayed
                                                directly over
                                                the active
                                                camera tile.
                                            </p>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div
                                            style={{
                                                padding:
                                                    "16px",
                                                borderRadius:
                                                    "10px",
                                                background:
                                                    "#151f31",
                                            }}
                                        >
                                            <strong>
                                                AirCanvas
                                                Permission
                                            </strong>

                                            <p
                                                style={{
                                                    color:
                                                        "#8995a9",
                                                    fontSize:
                                                        "12px",
                                                    lineHeight:
                                                        "1.5",
                                                }}
                                            >
                                                You need
                                                permission
                                                from the
                                                meeting host
                                                before you
                                                can use
                                                AirCanvas.
                                            </p>

                                            <button
                                                className="primary-button"
                                                onClick={
                                                    requestAirCanvas
                                                }
                                                disabled={
                                                    pendingRequest?.waiting
                                                }
                                            >
                                                {pendingRequest?.waiting
                                                    ? "Request Sent..."
                                                    : "Request AirCanvas"}
                                            </button>
                                        </div>
                                    </>
                                )}

                            </div>
                        )}

                    </aside>
                )}

            </div>

            {/* CONTROLS */}

            <div className="meeting-controls">

                <div className="controls-left">

                    <ControlButton
                        icon={
                            micEnabled
                                ? "🎤"
                                : "🔇"
                        }
                        label={
                            micEnabled
                                ? "Mute"
                                : "Unmute"
                        }
                        active={
                            micEnabled
                        }
                        onClick={
                            toggleMicrophone
                        }
                    />

                    <ControlButton
                        icon="📹"
                        label={
                            cameraEnabled
                                ? "Camera"
                                : "Camera Off"
                        }
                        active={
                            cameraEnabled
                        }
                        onClick={
                            toggleCamera
                        }
                    />

                    <ControlButton
                        icon="🖥"
                        label={
                            screenSharing
                                ? "Stop Share"
                                : "Share Screen"
                        }
                        active={
                            screenSharing
                        }
                        onClick={
                            toggleScreenShare
                        }
                    />

                    <ControlButton
                        icon="💬"
                        label="Chat"
                        active={
                            activePanel ===
                            "chat"
                        }
                        onClick={() =>
                            togglePanel(
                                "chat"
                            )
                        }
                    />

                    <ControlButton
                        icon="👥"
                        label={`Participants (${participants.length})`}
                        active={
                            activePanel ===
                            "participants"
                        }
                        onClick={() =>
                            togglePanel(
                                "participants"
                            )
                        }
                    />

                    <ControlButton
                        icon="✋"
                        label={
                            isHost
                                ? "AirCanvas"
                                : airCanvasAllowed
                                ? "AirCanvas"
                                : pendingRequest?.waiting
                                ? "Requested"
                                : "Request Canvas"
                        }
                        active={
                            activePanel ===
                            "aircanvas"
                        }
                        special
                        onClick={
                            handleAirCanvas
                        }
                    />

                </div>

                <div className="controls-right">

                    <button
                        className="leave-button"
                        onClick={
                            handleLeave
                        }
                    >
                        <span>
                            🚪
                        </span>

                        <span>
                            Leave
                        </span>
                    </button>

                </div>

            </div>

            <RoomAudioRenderer />

        </div>
    );
}

/* =========================================================
   CONTROL BUTTON
========================================================= */

function ControlButton({
    icon,
    label,
    active,
    onClick,
    special = false,
}) {
    return (
        <button
            type="button"
            className={`meeting-control-button ${
                active
                    ? "active"
                    : ""
            } ${
                special
                    ? "aircanvas-control"
                    : ""
            }`}
            onClick={onClick}
            title={label}
        >
            <span className="control-icon">
                {icon}
            </span>

            <span className="control-label">
                {label}
            </span>
        </button>
    );
}

/* =========================================================
   JOIN LOBBY
========================================================= */

function JoinLobby({
    roomId,
    error,
    loading,
    onBack,
    onJoin,
}) {
    const videoRef = useRef(null);
    const streamRef = useRef(null);

    const [participantName, setParticipantName] =
        useState("");

    const [micEnabled, setMicEnabled] =
        useState(true);

    const [cameraEnabled, setCameraEnabled] =
        useState(true);

    const [previewError, setPreviewError] =
        useState("");

    useEffect(() => {
        let cancelled = false;

        const startPreview = async () => {
            try {
                const stream =
                    await navigator.mediaDevices.getUserMedia(
                        {
                            audio: true,
                            video: true,
                        }
                    );

                if (cancelled) {
                    stream
                        .getTracks()
                        .forEach((track) =>
                            track.stop()
                        );

                    return;
                }

                streamRef.current = stream;

                if (videoRef.current) {
                    videoRef.current.srcObject =
                        stream;
                }
            } catch (err) {
                console.error(
                    "Lobby preview error:",
                    err
                );

                if (!cancelled) {
                    setPreviewError(
                        "Could not access your camera or microphone. You can still join — just check your browser permissions first."
                    );
                }
            }
        };

        startPreview();

        return () => {
            cancelled = true;

            if (streamRef.current) {
                streamRef.current
                    .getTracks()
                    .forEach((track) =>
                        track.stop()
                    );

                streamRef.current = null;
            }
        };
    }, []);

    const toggleMic = () => {
        const stream = streamRef.current;
        const nextEnabled = !micEnabled;

        if (stream) {
            stream
                .getAudioTracks()
                .forEach((track) => {
                    track.enabled =
                        nextEnabled;
                });
        }

        setMicEnabled(nextEnabled);
    };

    const toggleCamera = () => {
        const stream = streamRef.current;
        const nextEnabled = !cameraEnabled;

        if (stream) {
            stream
                .getVideoTracks()
                .forEach((track) => {
                    track.enabled =
                        nextEnabled;
                });
        }

        setCameraEnabled(nextEnabled);
    };

    const handleJoin = () => {
        if (!participantName.trim()) {
            return;
        }

        if (streamRef.current) {
            streamRef.current
                .getTracks()
                .forEach((track) =>
                    track.stop()
                );

            streamRef.current = null;
        }

        onJoin(participantName, {
            micEnabled,
            cameraEnabled,
        });
    };

    return (
        <div className="landing-page">

            <div className="lobby-card">

                <h1>
                    Ready to join?
                </h1>

                <p className="subtitle">
                    Check your camera and
                    mic before you join.
                </p>

                <div className="lobby-preview-wrap">

                    <video
                        ref={videoRef}
                        muted
                        playsInline
                        autoPlay
                        className="lobby-preview-video"
                        style={{
                            visibility:
                                cameraEnabled
                                    ? "visible"
                                    : "hidden",
                        }}
                    />

                    {!cameraEnabled && (
                        <div className="lobby-preview-placeholder">
                            <div className="lobby-preview-avatar">
                                {(
                                    participantName ||
                                    "U"
                                )
                                    .charAt(0)
                                    .toUpperCase()}
                            </div>
                        </div>
                    )}

                    <div className="lobby-preview-controls">

                        <button
                            type="button"
                            className={`lobby-toggle-button ${
                                micEnabled
                                    ? ""
                                    : "off"
                            }`}
                            onClick={
                                toggleMic
                            }
                            title={
                                micEnabled
                                    ? "Mute microphone"
                                    : "Unmute microphone"
                            }
                        >
                            {micEnabled
                                ? "🎤"
                                : "🔇"}
                        </button>

                        <button
                            type="button"
                            className={`lobby-toggle-button ${
                                cameraEnabled
                                    ? ""
                                    : "off"
                            }`}
                            onClick={
                                toggleCamera
                            }
                            title={
                                cameraEnabled
                                    ? "Turn off camera"
                                    : "Turn on camera"
                            }
                        >
                            {cameraEnabled
                                ? "📹"
                                : "📹̸"}
                        </button>

                    </div>

                </div>

                <div className="room-id-box">

                    <span>
                        Meeting ID
                    </span>

                    <strong>
                        {roomId}
                    </strong>

                </div>

                <label>
                    Your name
                </label>

                <input
                    type="text"
                    placeholder="Enter your name"
                    value={
                        participantName
                    }
                    onChange={(event) =>
                        setParticipantName(
                            event.target
                                .value
                        )
                    }
                    onKeyDown={(event) => {
                        if (
                            event.key ===
                            "Enter"
                        ) {
                            handleJoin();
                        }
                    }}
                />

                {previewError && (
                    <div className="error-message">
                        {previewError}
                    </div>
                )}

                {error && (
                    <div className="error-message">
                        {error}
                    </div>
                )}

                <button
                    className="primary-button"
                    onClick={handleJoin}
                    disabled={loading}
                >
                    {loading
                        ? "Connecting..."
                        : "Join Meeting"}
                </button>

                <button
                    className="back-button"
                    onClick={onBack}
                >
                    ← Back
                </button>

            </div>

        </div>
    );
}

/* =========================================================
   MAIN APP
========================================================= */

function App() {
    const [roomId, setRoomId] =
        useState(null);

    const [
        participantName,
        setParticipantName,
    ] = useState("");

    const [token, setToken] =
        useState("");

    const [serverUrl, setServerUrl] =
        useState("");

    const [loading, setLoading] =
        useState(false);

    const [error, setError] =
        useState("");

    const [
        joinRoomInput,
        setJoinRoomInput,
    ] = useState("");

    const [
        connectionStatus,
        setConnectionStatus,
    ] = useState(
        "Not connected"
    );

    const [isHost, setIsHost] =
        useState(false);

    const [
        initialMicEnabled,
        setInitialMicEnabled,
    ] = useState(true);

    const [
        initialCameraEnabled,
        setInitialCameraEnabled,
    ] = useState(true);

    useEffect(() => {
        const pathParts =
            window.location.pathname
                .split("/")
                .filter(Boolean);

        if (
            pathParts.length === 2 &&
            pathParts[0].toLowerCase() ===
                "meeting"
        ) {
            const currentRoomId =
                pathParts[1].toUpperCase();

            setRoomId(currentRoomId);

            const hashParams =
                new URLSearchParams(
                    window.location.hash.substring(1)
                );

            const transferredHostToken =
                hashParams.get("hostToken");

            if (transferredHostToken) {
                sessionStorage.setItem(
                    `aircanvas-host-${currentRoomId}`,
                    transferredHostToken
                );

                window.history.replaceState(
                    {},
                    "",
                    window.location.pathname
                );
            }
        }
    }, []);

    const createMeeting =
        async () => {
            try {
                setLoading(true);
                setError("");

                const response =
                    await fetch(
                        `${BACKEND_URL}/api/meeting/create`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type":
                                    "application/json",
                            },
                        }
                    );

                const data =
                    await response.json();

                if (
                    !response.ok ||
                    !data.success
                ) {
                    throw new Error(
                        data.message ||
                            "Unable to create meeting."
                    );
                }

                if (data.hostToken) {
                    sessionStorage.setItem(
                        `aircanvas-host-${data.roomId}`,
                        data.hostToken
                    );
                }

                const meetingLink =
                    data.meetingLink ||
                    `https://aircanvas-meet.vercel.app/meeting/${data.roomId}`;

                const hostToken =
                    data.hostToken || "";

                const productionMeetingLink =
                    hostToken
                        ? `${meetingLink}#hostToken=${encodeURIComponent(
                              hostToken
                          )}`
                        : meetingLink;

                window.location.href =
                    productionMeetingLink;
            } catch (err) {
                console.error(
                    "Create meeting error:",
                    err
                );

                setError(
                    err.message ||
                        "Something went wrong while creating the meeting."
                );

                setLoading(false);
            }
        };

    const joinExistingMeeting =
        () => {
            const cleanRoomId =
                joinRoomInput
                    .trim()
                    .toUpperCase();

            if (!cleanRoomId) {
                setError(
                    "Please enter a meeting ID."
                );
                return;
            }

            setError("");

            window.history.pushState(
                {},
                "",
                `/meeting/${cleanRoomId}`
            );

            setRoomId(
                cleanRoomId
            );
        };

    const joinMeeting =
        async (
            name,
            options = {}
        ) => {
            const trimmedName = (
                name || ""
            ).trim();

            if (!trimmedName) {
                setError(
                    "Please enter your name."
                );
                return;
            }

            if (!roomId) {
                setError(
                    "Meeting ID is missing."
                );
                return;
            }

            try {
                setLoading(true);
                setError("");

                setParticipantName(
                    trimmedName
                );

                setInitialMicEnabled(
                    options.micEnabled ??
                        true
                );

                setInitialCameraEnabled(
                    options.cameraEnabled ??
                        true
                );

                setConnectionStatus(
                    "Requesting access..."
                );

                const hostToken =
                    sessionStorage.getItem(
                        `aircanvas-host-${roomId}`
                    );

                const response =
                    await fetch(
                        `${BACKEND_URL}/api/meeting/token`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type":
                                    "application/json",
                            },
                            body: JSON.stringify(
                                {
                                    roomId,
                                    participantName:
                                        trimmedName,
                                    hostToken:
                                        hostToken ||
                                        undefined,
                                }
                            ),
                        }
                    );

                const data =
                    await response.json();

                if (
                    !response.ok ||
                    !data.success
                ) {
                    throw new Error(
                        data.message ||
                            "Unable to get meeting access."
                    );
                }

                setIsHost(
                    Boolean(
                        data.isHost
                    )
                );

                setConnectionStatus(
                    "Connecting..."
                );

                setToken(
                    data.token
                );

                setServerUrl(
                    data.serverUrl
                );
            } catch (err) {
                console.error(
                    "Meeting token error:",
                    err
                );

                setConnectionStatus(
                    "Connection failed"
                );

                setError(
                    err.message ||
                        "Unable to connect to the meeting."
                );
            } finally {
                setLoading(false);
            }
        };

    const handleConnected =
        () => {
            console.log(
                "LIVEKIT CONNECTED SUCCESSFULLY"
            );

            setConnectionStatus(
                "Connected"
            );

            setError("");
        };

    const handleLiveKitError =
        (liveKitError) => {
            console.error(
                "LIVEKIT CONNECTION ERROR:",
                liveKitError
            );

            setConnectionStatus(
                "Connection failed"
            );

            setError(
                liveKitError?.message ||
                    "LiveKit could not connect."
            );
        };

    const handleMediaDeviceFailure =
        (failure, kind) => {
            console.error(
                "MEDIA DEVICE ERROR:",
                failure
            );

            setConnectionStatus(
                "Media device problem"
            );

            setError(
                `Could not access your ${
                    kind ===
                    "audioinput"
                        ? "microphone"
                        : kind ===
                          "videoinput"
                        ? "camera"
                        : "media device"
                }. Please check browser permissions.`
            );
        };

    const handleDisconnected =
        (reason) => {
            console.warn(
                "LIVEKIT DISCONNECTED:",
                reason
            );

            setConnectionStatus(
                "Disconnected"
            );
        };

    const leaveMeeting =
        () => {
            setToken("");
            setServerUrl("");
            setParticipantName("");
            setError("");

            setConnectionStatus(
                "Not connected"
            );

            setIsHost(false);

            setInitialMicEnabled(true);
            setInitialCameraEnabled(true);

            window.history.pushState(
                {},
                "",
                "/"
            );

            setRoomId(null);
        };

    if (
        token &&
        serverUrl
    ) {
        return (
            <div className="meeting-app">

                <LiveKitRoom
                    token={token}
                    serverUrl={serverUrl}
                    connect={true}
                    audio={initialMicEnabled}
                    video={initialCameraEnabled}
                    onConnected={
                        handleConnected
                    }
                    onError={
                        handleLiveKitError
                    }
                    onDisconnected={
                        handleDisconnected
                    }
                    onMediaDeviceFailure={
                        handleMediaDeviceFailure
                    }
                >
                    <MeetingRoom
                        roomId={roomId}
                        connectionStatus={
                            connectionStatus
                        }
                        onLeave={
                            leaveMeeting
                        }
                        isHost={isHost}
                        initialMicEnabled={
                            initialMicEnabled
                        }
                        initialCameraEnabled={
                            initialCameraEnabled
                        }
                    />
                </LiveKitRoom>

                {error && (
                    <div className="meeting-error">
                        {error}
                    </div>
                )}

            </div>
        );
    }

    if (roomId) {
        return (
            <JoinLobby
                roomId={roomId}
                error={error}
                loading={loading}
                onBack={() => {
                    window.history.pushState(
                        {},
                        "",
                        "/"
                    );

                    setRoomId(null);
                    setError("");
                }}
                onJoin={joinMeeting}
            />
        );
    }

    return (
        <div className="landing-page">

            <div className="home-card">

                <div className="large-brand-icon">
                    ✋
                </div>

                <h1>
                    AirCanvas Meet
                </h1>

                <p className="subtitle">
                    Real-time video meetings
                    with collaborative AirCanvas
                </p>

                <button
                    className="primary-button"
                    onClick={
                        createMeeting
                    }
                    disabled={
                        loading
                    }
                >
                    {loading
                        ? "Creating..."
                        : "Create New Meeting"}
                </button>

                <div className="divider">
                    <span>
                        OR
                    </span>
                </div>

                <label>
                    Have a meeting ID?
                </label>

                <input
                    type="text"
                    placeholder="Enter meeting ID"
                    value={
                        joinRoomInput
                    }
                    onChange={(
                        event
                    ) =>
                        setJoinRoomInput(
                            event.target
                                .value
                        )
                    }
                    onKeyDown={(
                        event
                    ) => {
                        if (
                            event.key ===
                            "Enter"
                        ) {
                            joinExistingMeeting();
                        }
                    }}
                />

                <button
                    className="secondary-button"
                    onClick={
                        joinExistingMeeting
                    }
                >
                    Join Meeting
                </button>

                {error && (
                    <div className="error-message">
                        {error}
                    </div>
                )}

                <div className="feature-list">

                    <div>
                        <span>✓</span>
                        Real-time video & audio
                    </div>

                    <div>
                        <span>✓</span>
                        Multiple participants
                    </div>

                    <div>
                        <span>✓</span>
                        Host-controlled AirCanvas
                    </div>

                    <div>
                        <span>✓</span>
                        AI gesture interaction
                    </div>

                </div>

            </div>

        </div>
    );
}

export default App;