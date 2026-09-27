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
    DisconnectReason,
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

    const screenTracks = useTracks([
        {
            source: Track.Source.ScreenShare,
            withPlaceholder: false,
        },
    ]);

    const [activePanel, setActivePanel] =
        useState(null);

    const [shareCopied, setShareCopied] =
        useState(false);

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

    /*
     * explicitAirCanvasWriter is set ONLY by an explicit grant/revoke/
     * state-sync message ("aircanvas-granted", "aircanvas-revoked",
     * "aircanvas-state"). null means "nobody has been explicitly
     * granted control — default to the host."
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

    /*
     * airCanvasUser is DERIVED, computed fresh every render, instead
     * of being "defaulted" inside a useEffect. This used to be a
     * useState that a useEffect would set to hostIdentity once
     * hostIdentity became available. The problem: on a participant's
     * browser, the LiveKit participant list can take a moment to
     * populate right after connecting, so hostIdentity could still be
     * null the one time that effect happened to run — and since
     * nothing else would ever re-trigger the "default to host" logic
     * afterward, airCanvasUser got stuck at null FOREVER for that
     * participant. Every tile's showOverlay check
     * (tileIdentity === airCanvasUser) is false when airCanvasUser is
     * null, so that participant's browser would never show ANY
     * AirCanvas overlay, including the Host's — which is exactly the
     * "Host draws but nobody else sees the marker" bug.
     *
     * Deriving it here instead removes the race entirely: hostIdentity
     * is computed synchronously above from `participants` on every
     * render, so airCanvasUser is correct the moment hostIdentity is.
     */
    const airCanvasUser =
        explicitAirCanvasWriter || hostIdentity;

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

                /* =========================================
                   AIR CANVAS STATE REQUEST
                ========================================= */

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

                /* =========================================
                   AIR CANVAS STATE
                ========================================= */

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
                     * Every participant updates the active AirCanvas
                     * identity. This makes the same canvas appear on
                     * the same camera tile on laptops and phones.
                     */
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

                /* =========================================
                   HOST REVOKES ACCESS
                ========================================= */

                if (
                    message.type ===
                    "aircanvas-revoked"
                ) {
                    /*
                     * Return AirCanvas control to the host for everyone.
                     * null means "no explicit writer" — airCanvasUser
                     * derives back to hostIdentity automatically.
                     */
                    setExplicitAirCanvasWriter(
                        null
                    );

                    setAirCanvasAllowed(
                        isHost
                    );

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

            /*
             * Every client will receive the grant message and update
             * airCanvasUser. The host remains the permission controller,
             * while the selected participant becomes the controller.
             */
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

            /*
             * All clients return the visible AirCanvas to the host.
             * The revoked participant loses controller permission.
             * null means "no explicit writer" — airCanvasUser derives
             * back to hostIdentity automatically.
             */
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
                /*
                 * Always build the clean public meeting URL from
                 * the current origin and room ID.
                 *
                 * The host token is intentionally excluded.
                 */
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

                setError(
                    "Unable to copy the meeting link. Please copy the URL from the browser."
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

                    {screenTracks.length >
                        0 && (
                        <div
                            style={{
                                width: "100%",
                                marginBottom:
                                    "12px",
                                display: "flex",
                                flexDirection:
                                    "column",
                                gap: "12px",
                            }}
                        >
                            {screenTracks.map(
                                (
                                    track
                                ) => (
                                    <div
                                        key={`screen-${track.participant.identity}`}
                                        style={{
                                            position:
                                                "relative",
                                            width: "100%",
                                            aspectRatio:
                                                "16 / 9",
                                            background:
                                                "#000",
                                            borderRadius:
                                                "10px",
                                            overflow:
                                                "hidden",
                                        }}
                                    >
                                        <ParticipantTile
                                            trackRef={
                                                track
                                            }
                                            className="custom-participant-tile"
                                        />

                                        <div
                                            style={{
                                                position:
                                                    "absolute",
                                                top: "10px",
                                                left: "10px",
                                                background:
                                                    "rgba(0,0,0,0.65)",
                                                color:
                                                    "#fff",
                                                padding:
                                                    "5px 12px",
                                                borderRadius:
                                                    "6px",
                                                fontSize:
                                                    "13px",
                                            }}
                                        >
                                            🖥️{" "}
                                            {track
                                                .participant
                                                .name ||
                                                track
                                                    .participant
                                                    .identity}
                                            's
                                            screen
                                            {track
                                                .participant
                                                .identity ===
                                                room
                                                    .localParticipant
                                                    .identity &&
                                                " (you)"}
                                        </div>
                                    </div>
                                )
                            )}
                        </div>
                    )}

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
                                            /*
                                             * Mount one AirCanvas instance for EVERY
                                             * camera tile. All instances receive the
                                             * same LiveKit drawing events and maintain
                                             * the same normalized history. Only the
                                             * currently active participant's overlay
                                             * is visible. This prevents the canvas from
                                             * disappearing when control moves between
                                             * host and participant.
                                             */
                                            <AirCanvas
                                                activeUserIdentity={
                                                    airCanvasUser
                                                }
                                                tileIdentity={
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
                                                showOverlay={
                                                    track.participant.identity ===
                                                    airCanvasUser
                                                }
                                            />
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

                                                <span>
                                                    {participant.identity ===
                                                        room
                                                            .localParticipant
                                                            .identity &&
                                                        "You"}
                                                    {participant.identity ===
                                                        hostIdentity &&
                                                        " • Host"}
                                                </span>

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
            const currentRoomId =
                pathParts[1].toUpperCase();

            setRoomId(currentRoomId);

            /*
             * When the host creates a meeting from localhost,
             * the browser is redirected to the production Vercel
             * meeting URL. The host token is temporarily transferred
             * in the URL fragment because fragments are not sent to
             * the server. We immediately move the token into
             * sessionStorage and remove the fragment from the URL.
             */
            const hashParams =
                new URLSearchParams(
                    window.location.hash.substring(1)
                );

            const transferredHostToken =
                hashParams.get("hostToken");

            if (transferredHostToken) {
                /*
                 * sessionStorage, not localStorage: the host token
                 * must belong to THIS TAB only. localStorage is shared
                 * by every tab/window on the same origin, so opening a
                 * second tab to the same meeting URL would silently
                 * read this token too and both tabs would think they
                 * were the host. sessionStorage is private per tab and
                 * still survives refresh/navigation within that tab.
                 */
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
                 * Save the host token on the current origin too.
                 * This keeps the host authenticated if the user
                 * continues working on the same development origin.
                 *
                 * sessionStorage (not localStorage): this token must
                 * stay bound to the tab that actually clicked "Create
                 * meeting". A second tab opened later to the same
                 * meeting link — even in the same browser — must NOT
                 * inherit host status.
                 */
                if (data.hostToken) {
                    sessionStorage.setItem(
                        `aircanvas-host-${data.roomId}`,
                        data.hostToken
                    );
                }

                /*
                 * The backend now returns the public Vercel meeting
                 * link. We must navigate to that URL instead of using
                 * history.pushState(), because pushState() can only
                 * change URLs on the current origin.
                 *
                 * The host token is transferred in the URL fragment.
                 * Fragments are handled only by the browser and are
                 * not sent to Render. The production App.jsx reads
                 * the fragment, stores the token in sessionStorage,
                 * and immediately removes the fragment from the URL.
                 */
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
                 * Only the creator's ORIGINAL TAB will have this
                 * token (sessionStorage, scoped per tab — see the
                 * matching setItem calls above for why).
                 */
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
            // TEMP DIAGNOSTIC — remove once the "exited after chat" bug is found
            console.warn(
                "[DIAGNOSTIC][DISCONNECTED]",
                "reason code:",
                reason,
                "reason name:",
                DisconnectReason[reason] ||
                    "UNKNOWN",
                "at:",
                new Date().toISOString()
            );

            console.warn(
                "LIVEKIT DISCONNECTED:",
                reason
            );

            setConnectionStatus(
                "Disconnected"
            );
        };

    /* =====================================================
       TEMP DIAGNOSTIC — room/window level listeners
       (remove this whole block once the "exited after chat"
       bug is found)
    ===================================================== */

    useEffect(() => {
        const logState = () => {
            console.warn(
                "[DIAGNOSTIC][ConnectionStateChanged]",
                room.state,
                "at:",
                new Date().toISOString()
            );
        };

        const logReconnecting = () => {
            console.warn(
                "[DIAGNOSTIC][Reconnecting]",
                "at:",
                new Date().toISOString()
            );
        };

        const logSignalReconnecting = () => {
            console.warn(
                "[DIAGNOSTIC][SignalReconnecting]",
                "at:",
                new Date().toISOString()
            );
        };

        const logWindowError = (event) => {
            console.error(
                "[DIAGNOSTIC][window error]",
                event.message,
                event.error
            );
        };

        const logUnhandledRejection = (
            event
        ) => {
            console.error(
                "[DIAGNOSTIC][unhandled rejection]",
                event.reason
            );
        };

        room.on(
            RoomEvent.ConnectionStateChanged,
            logState
        );
        room.on(
            RoomEvent.Reconnecting,
            logReconnecting
        );
        room.on(
            RoomEvent.SignalReconnecting,
            logSignalReconnecting
        );

        window.addEventListener(
            "error",
            logWindowError
        );
        window.addEventListener(
            "unhandledrejection",
            logUnhandledRejection
        );

        return () => {
            room.off(
                RoomEvent.ConnectionStateChanged,
                logState
            );
            room.off(
                RoomEvent.Reconnecting,
                logReconnecting
            );
            room.off(
                RoomEvent.SignalReconnecting,
                logSignalReconnecting
            );

            window.removeEventListener(
                "error",
                logWindowError
            );
            window.removeEventListener(
                "unhandledrejection",
                logUnhandledRejection
            );
        };
    }, [room]);

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