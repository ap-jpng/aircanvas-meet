import {
    useEffect,
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
   MEETING ROOM
========================================================= */

function MeetingRoom({
    roomId,
    connectionStatus,
    onLeave,
    isHost,
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

    const [micEnabled, setMicEnabled] =
        useState(true);

    const [cameraEnabled, setCameraEnabled] =
        useState(true);

    const [screenSharing, setScreenSharing] =
        useState(false);

    const [
        airCanvasAllowed,
        setAirCanvasAllowed,
    ] = useState(false);

    const [
        airCanvasUser,
        setAirCanvasUser,
    ] = useState(null);

    /*
     * The host ALWAYS has AirCanvas access.
     * A participant can additionally be granted access by the host.
     * Host access must not disappear when a participant is granted.
     */
    useEffect(() => {
        if (isHost) {
            setAirCanvasAllowed(true);
            setAirCanvasUser(room.localParticipant.identity);
        }
    }, [
        isHost,
        room,
    ]);

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

                /* =========================================
                   PARTICIPANT REQUESTS ACCESS
                ========================================= */

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

                /* =========================================
                   HOST ALLOWS PARTICIPANT
                ========================================= */

                if (
                    message.type ===
                    "aircanvas-granted"
                ) {
                    /*
                     * The host remains allowed to draw even when a
                     * participant is granted AirCanvas.
                     */
                    if (isHost) {
                        setAirCanvasAllowed(true);
                        setAirCanvasUser(
                            message.identity
                        );
                        return;
                    }

                    if (
                        message.identity ===
                        room.localParticipant
                            .identity
                    ) {
                        setAirCanvasAllowed(true);
                        setAirCanvasUser(
                            message.identity
                        );
                    }

                    return;
                }

                /* =========================================
                   HOST REVOKES ACCESS
                ========================================= */

                if (
                    message.type ===
                    "aircanvas-revoked"
                ) {
                    if (
                        message.identity ===
                        room.localParticipant
                            .identity
                    ) {
                        /* Host cannot be revoked from their own AirCanvas. */
                        setAirCanvasAllowed(isHost);
                        if (isHost) {
                            setAirCanvasUser(
                                room.localParticipant.identity
                            );
                        } else {
                            setAirCanvasUser(null);
                        }
                    }

                    if (
                        message.identity ===
                        airCanvasUser
                    ) {
                        if (isHost) {
                            setAirCanvasUser(
                                room.localParticipant.identity
                            );
                        } else {
                            setAirCanvasUser(null);
                        }
                    }

                    return;
                }

                /* =========================================
                   HOST DENIES REQUEST
                ========================================= */

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
        airCanvasUser,
    ]);

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

            setAirCanvasUser(
                identity
            );

            /*
             * The host keeps their own AirCanvas access.
             * The selected participant receives access separately.
             */
            if (isHost) {
                setAirCanvasAllowed(true);
            } else if (
                identity ===
                room.localParticipant
                    .identity
            ) {
                setAirCanvasAllowed(true);
            }

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

            setAirCanvasUser(
                null
            );

            if (
                identity ===
                room.localParticipant
                    .identity
            ) {
                setAirCanvasAllowed(
                    false
                );
            }
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
                        onClick={() =>
                            navigator.clipboard?.writeText(
                                window.location.href
                            )
                        }
                        title="Copy meeting link"
                    >
                        🔗
                        <span>
                            Share
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
                                (track) => (
                                    <div
                                        className="participant-tile-wrapper"
                                        key={
                                            track
                                                .participant
                                                .identity
                                        }
                                        style={{
                                            position: "relative",
                                            overflow: "hidden",
                                        }}
                                    >

                                        <ParticipantTile
                                            trackRef={
                                                track
                                            }
                                            className="custom-participant-tile"
                                        />

                                        {
                                            (
                                                /* Host always gets a canvas over their own camera. */
                                                (
                                                    isHost &&
                                                    track.participant.identity ===
                                                        room.localParticipant.identity
                                                ) ||
                                                /* Granted participant gets a canvas over their own camera. */
                                                track.participant.identity ===
                                                    airCanvasUser
                                            ) && (
                                                <AirCanvas
                                                    activeUserIdentity={
                                                        track.participant.identity
                                                    }
                                                    isController={
                                                        track.participant.identity ===
                                                            room.localParticipant.identity &&
                                                        (
                                                            isHost ||
                                                            (
                                                                airCanvasAllowed &&
                                                                airCanvasUser ===
                                                                    room.localParticipant.identity
                                                            )
                                                        )
                                                    }
                                                    mirror={
                                                        track.participant.identity ===
                                                        room.localParticipant.identity
                                                    }
                                                />
                                            )
                                        }

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
                                                    room
                                                        .localParticipant
                                                        .identity &&
                                                    isHost && (
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
                                )
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

    /* =====================================================
       READ ROOM FROM URL
    ===================================================== */

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
            setRoomId(
                pathParts[1].toUpperCase()
            );
        }
    }, []);

    /* =====================================================
       CREATE MEETING
    ===================================================== */

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

                /*
                 * Store host token locally.
                 * It is never placed in the URL.
                 */
                localStorage.setItem(
                    `aircanvas-host-${data.roomId}`,
                    data.hostToken
                );

                window.history.pushState(
                    {},
                    "",
                    `/meeting/${data.roomId}`
                );

                setRoomId(
                    data.roomId
                );

                setIsHost(true);
            } catch (err) {
                console.error(
                    "Create meeting error:",
                    err
                );

                setError(
                    err.message ||
                        "Something went wrong while creating the meeting."
                );
            } finally {
                setLoading(false);
            }
        };

    /* =====================================================
       JOIN EXISTING MEETING
    ===================================================== */

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

    /* =====================================================
       JOIN MEETING
    ===================================================== */

    const joinMeeting =
        async () => {
            if (
                !participantName.trim()
            ) {
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

                setConnectionStatus(
                    "Requesting access..."
                );

                /*
                 * Only the creator's browser
                 * will have this token.
                 */
                const hostToken =
                    localStorage.getItem(
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
                                        participantName.trim(),
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

    /* =====================================================
       CONNECTED
    ===================================================== */

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

    /* =====================================================
       LIVEKIT ERROR
    ===================================================== */

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

    /* =====================================================
       MEDIA FAILURE
    ===================================================== */

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

    /* =====================================================
       DISCONNECTED
    ===================================================== */

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

    /* =====================================================
       LEAVE
    ===================================================== */

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

            window.history.pushState(
                {},
                "",
                "/"
            );

            setRoomId(null);
        };

    /* =====================================================
       REAL MEETING
    ===================================================== */

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
                    audio={true}
                    video={true}
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

    /* =====================================================
       JOIN SCREEN
    ===================================================== */

    if (roomId) {
        return (
            <div className="landing-page">

                <div className="join-card">

                    <div className="large-brand-icon">
                        ✋
                    </div>

                    <h1>
                        Join AirCanvas Meet
                    </h1>

                    <p className="subtitle">
                        Join your online meeting
                    </p>

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
                        onChange={(
                            event
                        ) =>
                            setParticipantName(
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
                                joinMeeting();
                            }
                        }}
                    />

                    {error && (
                        <div className="error-message">
                            {error}
                        </div>
                    )}

                    <button
                        className="primary-button"
                        onClick={
                            joinMeeting
                        }
                        disabled={
                            loading
                        }
                    >
                        {loading
                            ? "Connecting..."
                            : "Join Meeting"}
                    </button>

                    <button
                        className="back-button"
                        onClick={() => {
                            window.history.pushState(
                                {},
                                "",
                                "/"
                            );

                            setRoomId(
                                null
                            );

                            setError("");
                        }}
                    >
                        ← Back
                    </button>

                </div>

            </div>
        );
    }

    /* =====================================================
       HOME
    ===================================================== */

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