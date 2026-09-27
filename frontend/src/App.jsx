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

/*
 * ATTENDANCE REPORT (PDF).
 * Requires: npm install jspdf jspdf-autotable
 */
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

const BACKEND_URL =
   "https://aircanvas-meet.onrender.com";

const AIR_CANVAS_TOPIC =
    "aircanvas-control";

const REACTION_TOPIC =
    "aircanvas-reaction";

const MEETING_CONTROL_TOPIC =
    "aircanvas-meeting-control";

/* =========================================================
   DATA HELPERS
========================================================= */

function sendDataMessage(room, message, topic) {
    try {
        const data = new TextEncoder().encode(
            JSON.stringify(message)
        );

        room.localParticipant.publishData(
            data,
            {
                reliable: true,
                topic,
            }
        );
    } catch (error) {
        console.error(
            "Data message error:",
            error
        );
    }
}

function sendAirCanvasMessage(room, message) {
    sendDataMessage(room, message, AIR_CANVAS_TOPIC);
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

    /*
     * FIX (screen share): screen-share tracks were never subscribed
     * to anywhere. cameraTracks only ever asks LiveKit for
     * Track.Source.Camera, so when a participant called
     * setScreenShareEnabled(true) the track WAS published, but no
     * component ever mapped over it — not even for the sharer's own
     * remote view on other browsers. This is a separate, additive
     * subscription; it doesn't touch cameraTracks or the grid below.
     */
    const screenShareTracks = useTracks([
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
        useState(initialMicEnabled);

    const [cameraEnabled, setCameraEnabled] =
        useState(initialCameraEnabled);

    const [screenSharing, setScreenSharing] =
        useState(false);

    /*
     * The writer's chosen AirCanvas marker color/size. Passed straight
     * through to every <AirCanvas> instance below — only the instance
     * that is currently this browser's controller ever actually reads
     * them (see the matching comment in AirCanvas.jsx), so handing them
     * to every tile unconditionally is harmless.
     */
    const [markerColor, setMarkerColor] =
        useState("#00ff66");

    const [markerWidth, setMarkerWidth] =
        useState(4);

    const [eraserWidth, setEraserWidth] =
        useState(68);

    const [showMarkerPopover, setShowMarkerPopover] =
        useState(false);

    const [showReactionPicker, setShowReactionPicker] =
        useState(false);

    const [reactions, setReactions] =
        useState([]);

    /*
     * END MEETING (host-only "End meeting for everyone").
     * showEndMeetingConfirm gates the confirmation dialog the host
     * sees before the broadcast goes out. meetingEndedNotice is shown
     * on every OTHER participant's screen the moment the host's
     * "meeting-ended" message arrives, right before that client
     * disconnects itself.
     */
    const [
        showEndMeetingConfirm,
        setShowEndMeetingConfirm,
    ] = useState(false);

    const [
        meetingEndedNotice,
        setMeetingEndedNotice,
    ] = useState(false);

    const MARKER_COLOR_PRESETS = [
        "#00ff66",
        "#25d3ee",
        "#ff4d6d",
        "#ffd23f",
        "#ffffff",
    ];

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
     * Whether the LOCAL browser is currently the one allowed to draw
     * (on its own tile), regardless of which tile is being displayed
     * where. Mirrors the per-tile `isController` expression used below
     * for the tile that happens to match this browser's own identity.
     * Used only to decide whether to show the marker color/size
     * controls — it doesn't change who can draw.
     */
    const isLocalController =
        airCanvasAllowed &&
        airCanvasUser ===
            room.localParticipant.identity;

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

    /*
     * ATTENDANCE REPORT.
     * identity -> { identity, name, email, joinedAt, leftAt }.
     * A ref (not state) because it's only ever read at the moment
     * the host clicks "Attendance Report" — it doesn't need to
     * trigger re-renders as participants come and go.
     */
    const attendanceLogRef = useRef(
        new Map()
    );

    const parseParticipantMetadata =
        (participant) => {
            try {
                return JSON.parse(
                    participant.metadata ||
                        "{}"
                );
            } catch {
                return {};
            }
        };

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

                    /*
                     * FIX (#5): the host was never actually notified of
                     * a request — it just sat in state until the host
                     * happened to open the AirCanvas panel themselves.
                     * Open it automatically so the request can't be
                     * missed. (A badge dot on the AirCanvas button, set
                     * up below, also stays visible if the host closes
                     * the panel again before responding.)
                     */
                    setActivePanel(
                        "aircanvas"
                    );

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
       REACTIONS
       A separate, self-contained listener on its own topic, so it
       never interferes with the existing AirCanvas control-message
       handling above. Each incoming reaction is shown as a small
       floating emoji over the sender's own tile for ~1.8s, then
       removed.
    ===================================================== */

    /*
     * FIX (#3): shared by both the network listener below and
     * sendReaction() further down. LiveKit does not echo a
     * participant's own published data back to themselves via
     * RoomEvent.DataReceived, so relying only on the listener meant
     * the person who actually clicked a reaction would never see it
     * float over their own tile — it only ever appeared for everyone
     * else. Showing it locally the instant it's sent (same as
     * AirCanvas already does for its own strokes) fixes that.
     */
    const showReactionLocally = (
        identity,
        emoji
    ) => {
        const reactionId = `${
            identity || "unknown"
        }-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 7)}`;

        setReactions((current) => [
            ...current,
            {
                id: reactionId,
                identity,
                emoji,
            },
        ]);

        window.setTimeout(() => {
            setReactions((current) =>
                current.filter(
                    (reaction) =>
                        reaction.id !==
                        reactionId
                )
            );
        }, 1800);
    };

    useEffect(() => {
        const handleReaction = (
            payload,
            participant,
            _kind,
            topic
        ) => {
            if (topic !== REACTION_TOPIC) {
                return;
            }

            try {
                const message = JSON.parse(
                    new TextDecoder().decode(
                        payload
                    )
                );

                if (
                    message.type !==
                    "reaction"
                ) {
                    return;
                }

                showReactionLocally(
                    message.identity ||
                        participant?.identity,
                    message.emoji
                );
            } catch (error) {
                console.error(
                    "Reaction message error:",
                    error
                );
            }
        };

        room.on(
            RoomEvent.DataReceived,
            handleReaction
        );

        return () => {
            room.off(
                RoomEvent.DataReceived,
                handleReaction
            );
        };
    }, [room]);

    const sendReaction = (emoji) => {
        const identity =
            room.localParticipant.identity;

        showReactionLocally(
            identity,
            emoji
        );

        try {
            const data = new TextEncoder().encode(
                JSON.stringify({
                    type: "reaction",
                    emoji,
                    identity,
                })
            );

            room.localParticipant.publishData(
                data,
                {
                    reliable: true,
                    topic: REACTION_TOPIC,
                }
            );
        } catch (error) {
            console.error(
                "Reaction send error:",
                error
            );
        }

        setShowReactionPicker(false);
    };

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
       END MEETING FOR EVERYONE (host only)
       Broadcasts a "meeting-ended" control message so every other
       participant's client shows the notice below and disconnects
       itself, then (best-effort) asks the backend to close the
       LiveKit room server-side so the meeting ID can't be rejoined,
       and finally disconnects the host too.
    ===================================================== */

    const endMeetingForAll =
        async () => {
            if (!isHost) {
                return;
            }

            setShowEndMeetingConfirm(
                false
            );

            sendDataMessage(
                room,
                {
                    type:
                        "meeting-ended",
                },
                MEETING_CONTROL_TOPIC
            );

            try {
                const hostToken =
                    sessionStorage.getItem(
                        `aircanvas-host-${roomId}`
                    );

                await fetch(
                    `${BACKEND_URL}/api/meeting/end`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json",
                        },
                        body: JSON.stringify(
                            {
                                roomId,
                                hostToken,
                            }
                        ),
                    }
                );
            } catch (error) {
                /*
                 * Non-fatal: even if the backend doesn't expose this
                 * endpoint (yet) or the request fails, every other
                 * participant has already been told to leave via the
                 * broadcast above, and the host still disconnects
                 * below.
                 */
                console.error(
                    "End meeting backend error:",
                    error
                );
            }

            /*
             * Small delay so the reliable data message above has a
             * moment to actually go out over the wire before this
             * client tears its own connection down.
             */
            window.setTimeout(() => {
                handleLeave();
            }, 300);
        };

    /* =====================================================
       LISTEN FOR "MEETING ENDED" (all participants)
    ===================================================== */

    useEffect(() => {
        const handleMeetingControl = (
            payload,
            participant,
            _kind,
            topic
        ) => {
            if (
                topic !==
                MEETING_CONTROL_TOPIC
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
                    "meeting-ended"
                ) {
                    setMeetingEndedNotice(
                        true
                    );

                    window.setTimeout(() => {
                        handleLeave();
                    }, 1800);
                }
            } catch (error) {
                console.error(
                    "Meeting control message error:",
                    error
                );
            }
        };

        room.on(
            RoomEvent.DataReceived,
            handleMeetingControl
        );

        return () => {
            room.off(
                RoomEvent.DataReceived,
                handleMeetingControl
            );
        };
    }, [room]);

    /* =====================================================
       ATTENDANCE TRACKING
       Records a join/leave row per participant (host included).
       Seeds from whoever is already in the room the moment this
       mounts (using LiveKit's own participant.joinedAt so an
       existing participant's time is accurate, not "now"), then
       keeps the log updated as people come and go for the rest
       of the meeting.
    ===================================================== */

    useEffect(() => {
        const recordJoin = (
            participant
        ) => {
            const metadata =
                parseParticipantMetadata(
                    participant
                );

            const identity =
                participant.identity;

            const existing =
                attendanceLogRef.current.get(
                    identity
                );

            attendanceLogRef.current.set(
                identity,
                {
                    identity,
                    name:
                        metadata.name ||
                        participant.name ||
                        identity,
                    email:
                        metadata.email ||
                        existing?.email ||
                        "",
                    joinedAt:
                        participant.joinedAt
                            ? new Date(
                                  participant.joinedAt
                              )
                            : existing?.joinedAt ||
                              new Date(),
                    leftAt: null,
                }
            );
        };

        const recordLeave = (
            participant
        ) => {
            const record =
                attendanceLogRef.current.get(
                    participant.identity
                );

            if (record && !record.leftAt) {
                record.leftAt = new Date();
            }
        };

        /*
         * Seed with everyone already connected (host's own local
         * participant plus any remote participants who joined
         * before this listener was attached).
         */
        recordJoin(room.localParticipant);

        room.remoteParticipants.forEach(
            (participant) => {
                recordJoin(participant);
            }
        );

        room.on(
            RoomEvent.ParticipantConnected,
            recordJoin
        );

        room.on(
            RoomEvent.ParticipantDisconnected,
            recordLeave
        );

        return () => {
            room.off(
                RoomEvent.ParticipantConnected,
                recordJoin
            );

            room.off(
                RoomEvent.ParticipantDisconnected,
                recordLeave
            );
        };
    }, [room]);

    /*
     * A participant's real name (and, sometimes, their metadata)
     * can arrive slightly AFTER they're first seen — recordJoin()
     * above may have only had their bare identity to fall back on
     * at that exact moment. `participants` (from useParticipants(),
     * already subscribed above) re-renders live as LiveKit fills
     * that info in, so keep each attendance row's name/email in
     * sync with it whenever it changes, rather than trusting
     * whatever was known at the single instant they joined.
     */
    useEffect(() => {
        participants.forEach(
            (participant) => {
                const record =
                    attendanceLogRef.current.get(
                        participant.identity
                    );

                if (!record) {
                    return;
                }

                const metadata =
                    parseParticipantMetadata(
                        participant
                    );

                const freshName =
                    metadata.name ||
                    participant.name;

                if (freshName) {
                    record.name = freshName;
                }

                if (
                    !record.email &&
                    metadata.email
                ) {
                    record.email =
                        metadata.email;
                }
            }
        );
    }, [participants]);

    /* =====================================================
       GENERATE ATTENDANCE REPORT (PDF, host only)
    ===================================================== */

    const formatDuration =
        (seconds) => {
            if (
                !Number.isFinite(
                    seconds
                ) ||
                seconds < 0
            ) {
                return "—";
            }

            const hrs = Math.floor(
                seconds / 3600
            );

            const mins = Math.floor(
                (seconds % 3600) / 60
            );

            const secs = Math.floor(
                seconds % 60
            );

            return [
                hrs,
                mins,
                secs,
            ]
                .map((value) =>
                    String(
                        value
                    ).padStart(2, "0")
                )
                .join(":");
        };

    const generateAttendanceReport =
        () => {
            if (!isHost) {
                return;
            }

            /*
             * Mark anyone still connected right now as leaving "now"
             * for the purposes of this report, without mutating the
             * live log — the meeting keeps running after the host
             * downloads the PDF.
             */
            const now = new Date();

            const rows = Array.from(
                attendanceLogRef.current
                    .values()
            )
                .map((record) => {
                    const leftAt =
                        record.leftAt ||
                        now;

                    const durationSeconds =
                        (leftAt.getTime() -
                            record.joinedAt.getTime()) /
                        1000;

                    /*
                     * Belt-and-suspenders name resolution: look up the
                     * LIVE participant object (if they're still in the
                     * meeting) and re-derive their name from it right
                     * now, instead of trusting whatever the cached
                     * record picked up earlier. "Unknown participant"
                     * is the last-resort fallback so the cell is never
                     * truly empty even if every other source is blank.
                     */
                    const liveParticipant =
                        participants.find(
                            (
                                candidate
                            ) =>
                                candidate.identity ===
                                record.identity
                        );

                    const liveMetadata =
                        liveParticipant
                            ? parseParticipantMetadata(
                                  liveParticipant
                              )
                            : {};

                    const resolvedName =
                        liveMetadata.name ||
                        liveParticipant?.name ||
                        record.name ||
                        record.identity ||
                        "Unknown participant";

                    return {
                        ...record,
                        name: resolvedName,
                        leftAt,
                        stillHere:
                            !record.leftAt,
                        durationSeconds,
                    };
                })
                .sort(
                    (a, b) =>
                        a.joinedAt.getTime() -
                        b.joinedAt.getTime()
                );

            const doc = new jsPDF();

            doc.setFontSize(15);
            doc.text(
                "Attendance Report",
                14,
                17
            );

            doc.setFontSize(10);
            doc.setTextColor(110);
            doc.text(
                `Meeting ID: ${roomId}    Generated: ${now.toLocaleString()}`,
                14,
                24
            );

            autoTable(doc, {
                startY: 30,
                head: [
                    [
                        "Name",
                        "Email",
                        "Joined",
                        "Left",
                        "Duration",
                    ],
                ],
                body: rows.map(
                    (row) => [
                        row.name,
                        row.email || "—",
                        row.joinedAt.toLocaleTimeString(),
                        row.stillHere
                            ? "Still in meeting"
                            : row.leftAt.toLocaleTimeString(),
                        formatDuration(
                            row.durationSeconds
                        ),
                    ]
                ),
                headStyles: {
                    fillColor: [
                        37, 211, 238,
                    ],
                    textColor: [
                        6, 16, 24,
                    ],
                },
                styles: {
                    fontSize: 9,
                },
            });

            doc.save(
                `attendance-${roomId}.pdf`
            );
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

            <ThemeToggle />

            {/* END MEETING CONFIRMATION (host) */}

            {showEndMeetingConfirm && (
                <div className="confirm-overlay">
                    <div className="confirm-dialog">
                        <h3>
                            End meeting for everyone?
                        </h3>

                        <p>
                            Every participant will be
                            disconnected immediately.
                            This can't be undone.
                        </p>

                        <div className="confirm-dialog-actions">
                            <button
                                className="secondary-button"
                                onClick={() =>
                                    setShowEndMeetingConfirm(
                                        false
                                    )
                                }
                            >
                                Cancel
                            </button>

                            <button
                                className="danger-button"
                                onClick={
                                    endMeetingForAll
                                }
                            >
                                End Meeting
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* MEETING ENDED NOTICE (everyone else) */}

            {meetingEndedNotice && (
                <div className="confirm-overlay">
                    <div className="confirm-dialog">
                        <h3>
                            Meeting ended
                        </h3>

                        <p>
                            The host ended this
                            meeting for everyone.
                            You're being disconnected...
                        </p>
                    </div>
                </div>
            )}

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

                    {/*
                     * FIX (screen share): render any active screen
                     * shares in their own row, above the camera grid.
                     * screenShareTracks is a separate useTracks
                     * subscription (Track.Source.ScreenShare) added
                     * above — this does not alter the camera grid,
                     * AirCanvas, or anything else below.
                     */}
                    {screenShareTracks.length > 0 && (
                        <div className="screen-share-grid">
                            {screenShareTracks.map(
                                (track) => (
                                    <div
                                        className="screen-share-tile-wrapper"
                                        key={`${track.participant.identity}-screen`}
                                    >
                                        <ParticipantTile
                                            trackRef={track}
                                            className="custom-participant-tile screen-share-tile"
                                        />

                                        <div className="participant-overlay">
                                            <div className="participant-name">
                                                {(track.participant.name ||
                                                    track.participant.identity)}
                                                's screen
                                            </div>
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

                                        {/*
                                         * FIX (#1): this used to be a single
                                         * fixed-position button pinned to the
                                         * top-right of the whole screen, which
                                         * sat directly on top of the side
                                         * panel's close (✕) button whenever a
                                         * panel was open. It's now rendered
                                         * inside the controller's own tile,
                                         * so it only ever overlaps that tile.
                                         */}
                                        {track
                                            .participant
                                            .identity ===
                                            room
                                                .localParticipant
                                                .identity &&
                                            isLocalController && (
                                                <div className="marker-fab-wrap">
                                                    <button
                                                        type="button"
                                                        className="marker-fab-button"
                                                        onClick={() =>
                                                            setShowMarkerPopover(
                                                                (
                                                                    value
                                                                ) =>
                                                                    !value
                                                            )
                                                        }
                                                        title="Marker color & size"
                                                        style={{
                                                            background:
                                                                markerColor,
                                                        }}
                                                    >
                                                        🖊️
                                                    </button>

                                                    {showMarkerPopover && (
                                                        <div className="marker-fab-popover">

                                                            <div className="marker-color-row">
                                                                {MARKER_COLOR_PRESETS.map(
                                                                    (
                                                                        preset
                                                                    ) => (
                                                                        <button
                                                                            key={
                                                                                preset
                                                                            }
                                                                            type="button"
                                                                            className="marker-color-dot"
                                                                            onClick={() =>
                                                                                setMarkerColor(
                                                                                    preset
                                                                                )
                                                                            }
                                                                            title={
                                                                                preset
                                                                            }
                                                                            style={{
                                                                                background:
                                                                                    preset,
                                                                                outline:
                                                                                    markerColor ===
                                                                                    preset
                                                                                        ? "2px solid #25d3ee"
                                                                                        : "none",
                                                                            }}
                                                                        />
                                                                    )
                                                                )}

                                                                <input
                                                                    type="color"
                                                                    value={
                                                                        markerColor
                                                                    }
                                                                    onChange={(
                                                                        event
                                                                    ) =>
                                                                        setMarkerColor(
                                                                            event
                                                                                .target
                                                                                .value
                                                                        )
                                                                    }
                                                                    title="Custom color"
                                                                    className="marker-color-custom"
                                                                />
                                                            </div>

                                                            <label className="marker-slider-label">
                                                                <span>
                                                                    Marker size
                                                                </span>

                                                                <span>
                                                                    {
                                                                        markerWidth
                                                                    }
                                                                    px
                                                                </span>
                                                            </label>

                                                            <input
                                                                type="range"
                                                                min="2"
                                                                max="14"
                                                                step="1"
                                                                value={
                                                                    markerWidth
                                                                }
                                                                onChange={(
                                                                    event
                                                                ) =>
                                                                    setMarkerWidth(
                                                                        Number(
                                                                            event
                                                                                .target
                                                                                .value
                                                                        )
                                                                    )
                                                                }
                                                                className="marker-slider"
                                                            />

                                                            <label className="marker-slider-label">
                                                                <span>
                                                                    Eraser size
                                                                </span>

                                                                <span>
                                                                    {
                                                                        eraserWidth
                                                                    }
                                                                    px
                                                                </span>
                                                            </label>

                                                            <input
                                                                type="range"
                                                                min="24"
                                                                max="120"
                                                                step="2"
                                                                value={
                                                                    eraserWidth
                                                                }
                                                                onChange={(
                                                                    event
                                                                ) =>
                                                                    setEraserWidth(
                                                                        Number(
                                                                            event
                                                                                .target
                                                                                .value
                                                                        )
                                                                    )
                                                                }
                                                                className="marker-slider"
                                                            />

                                                        </div>
                                                    )}
                                                </div>
                                            )}

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
                                                    airCanvasAllowed &&
                                                    airCanvasUser ===
                                                        room.localParticipant.identity
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

                                        {reactions
                                            .filter(
                                                (
                                                    reaction
                                                ) =>
                                                    reaction.identity ===
                                                    track
                                                        .participant
                                                        .identity
                                            )
                                            .map(
                                                (
                                                    reaction
                                                ) => (
                                                    <div
                                                        key={
                                                            reaction.id
                                                        }
                                                        className="floating-reaction"
                                                    >
                                                        {
                                                            reaction.emoji
                                                        }
                                                    </div>
                                                )
                                            )}

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
                            <div className="aircanvas-panel-content">

                                {isHost ? (
                                    <>
                                        <div className="aircanvas-box neutral">
                                            <strong>
                                                ✋ Host
                                                Control
                                            </strong>

                                            <p>
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
                                            <div className="aircanvas-box active">
                                                <strong>
                                                    AirCanvas
                                                    active
                                                </strong>

                                                <p>
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
                                            <div className="aircanvas-box neutral">
                                                <strong>
                                                    No participant
                                                    has control
                                                </strong>

                                                <p>
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
                                                <div className="aircanvas-box request">

                                                    <strong>
                                                        AirCanvas
                                                        Request
                                                    </strong>

                                                    <p>
                                                        {
                                                            pendingRequest.name
                                                        }{" "}
                                                        wants
                                                        to use
                                                        AirCanvas.
                                                    </p>

                                                    <div className="aircanvas-box-actions">

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
                                        <div className="aircanvas-box active spacious">
                                            <strong>
                                                ✓ AirCanvas
                                                Access Granted
                                            </strong>

                                            <p>
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
                                        <div className="aircanvas-box neutral spacious">
                                            <strong>
                                                AirCanvas
                                                Permission
                                            </strong>

                                            <p>
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

                    <div
                        style={{
                            position: "relative",
                        }}
                    >
                        <ControlButton
                            icon="🙂"
                            label="React"
                            active={
                                showReactionPicker
                            }
                            onClick={() =>
                                setShowReactionPicker(
                                    (
                                        value
                                    ) =>
                                        !value
                                )
                            }
                        />

                        {showReactionPicker && (
                            <div className="reaction-picker">
                                {[
                                    "👍",
                                    "😂",
                                    "❤️",
                                    "✋",
                                ].map(
                                    (
                                        emoji
                                    ) => (
                                        <button
                                            key={
                                                emoji
                                            }
                                            type="button"
                                            className="reaction-picker-button"
                                            onClick={() =>
                                                sendReaction(
                                                    emoji
                                                )
                                            }
                                        >
                                            {
                                                emoji
                                            }
                                        </button>
                                    )
                                )}
                            </div>
                        )}
                    </div>

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
                        badge={
                            isHost &&
                            Boolean(
                                pendingRequest
                            ) &&
                            !pendingRequest?.waiting
                        }
                        onClick={
                            handleAirCanvas
                        }
                    />

                </div>

                <div className="controls-right">

                    {isHost && (
                        <button
                            type="button"
                            className="attendance-button"
                            onClick={
                                generateAttendanceReport
                            }
                            title="Download attendance report (PDF)"
                        >
                            <span>
                                📋
                            </span>

                            <span>
                                Attendance Report
                            </span>
                        </button>
                    )}

                    {isHost && (
                        <button
                            type="button"
                            className="end-meeting-button"
                            onClick={() =>
                                setShowEndMeetingConfirm(
                                    true
                                )
                            }
                            title="End meeting for everyone"
                        >
                            <span>
                                ⏹
                            </span>

                            <span>
                                End Meeting
                            </span>
                        </button>
                    )}

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
   THEME TOGGLE
   Self-contained: reads the saved theme (or defaults to dark),
   writes it to document.body's [data-theme] attribute (which
   App.css's light-theme overrides key off), and persists the
   choice. Safe to mount in more than one place at once — only
   one of the three screens (home / lobby / meeting) is ever on
   screen at a time.
========================================================= */

function ThemeToggle() {
    const [theme, setTheme] = useState(
        () => {
            try {
                return (
                    localStorage.getItem(
                        "aircanvas-theme"
                    ) || "dark"
                );
            } catch {
                return "dark";
            }
        }
    );

    useEffect(() => {
        document.body.dataset.theme =
            theme;

        try {
            localStorage.setItem(
                "aircanvas-theme",
                theme
            );
        } catch {
            // Storage can be unavailable (private browsing, etc.);
            // the theme just won't persist across reloads.
        }
    }, [theme]);

    return (
        <button
            type="button"
            className="theme-toggle-fab"
            onClick={() =>
                setTheme((current) =>
                    current === "dark"
                        ? "light"
                        : "dark"
                )
            }
            title={
                theme === "dark"
                    ? "Switch to light theme"
                    : "Switch to dark theme"
            }
        >
            {theme === "dark" ? "☀️" : "🌙"}
        </button>
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
    badge = false,
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

            {badge && (
                <span
                    className="control-badge-dot"
                    aria-hidden="true"
                />
            )}
        </button>
    );
}

/* =========================================================
   JOIN LOBBY
   A pre-join screen with a live camera/mic preview and toggle
   buttons, in the style of Zoom/Meet, instead of dropping the
   user straight into a browser permission popup.

   This preview is a PLAIN getUserMedia stream, deliberately kept
   separate from LiveKit. LiveKit requests its own camera/mic
   tracks once we actually connect (see the "REAL MEETING" render
   branch below, which passes the chosen initial mic/camera state
   into <LiveKitRoom>). We release this preview stream right
   before handing off to LiveKit so the two never fight over the
   same device at once.
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

    /*
     * Optional. Only used to populate the host's Attendance Report
     * PDF with an email column — the meeting still works fine if
     * someone leaves it blank.
     */
    const [participantEmail, setParticipantEmail] =
        useState("");

    const [micEnabled, setMicEnabled] =
        useState(true);

    const [cameraEnabled, setCameraEnabled] =
        useState(true);

    const [previewError, setPreviewError] =
        useState("");

    /*
     * Start the preview as soon as the lobby mounts, and always
     * release the camera/mic when it unmounts (whether that's
     * because the user hit Back, or because they successfully
     * joined and this screen is being replaced by the meeting).
     */
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

        /*
         * Release the preview stream right away. LiveKitRoom will
         * request its own camera/mic tracks the moment it connects,
         * and holding onto this one too can make some browsers show
         * a stale preview frame or double-prompt for permissions.
         */
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
            email: participantEmail.trim(),
        });
    };

    return (
        <div className="landing-page">

            <ThemeToggle />

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

                <label>
                    Email (optional)
                </label>

                <input
                    type="email"
                    placeholder="you@example.com"
                    value={
                        participantEmail
                    }
                    onChange={(event) =>
                        setParticipantEmail(
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

    /*
     * Chosen on the pre-join lobby screen, and used as the initial
     * mic/camera state when we actually connect to LiveKit.
     */
    const [
        initialMicEnabled,
        setInitialMicEnabled,
    ] = useState(true);

    const [
        initialCameraEnabled,
        setInitialCameraEnabled,
    ] = useState(true);

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
       Called by the JoinLobby screen once the user has chosen
       their name and their initial mic/camera state.
    ===================================================== */

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
                                        trimmedName,
                                    participantEmail:
                                        options.email ||
                                        undefined,
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

            setInitialMicEnabled(true);
            setInitialCameraEnabled(true);

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

    /* =====================================================
       PRE-JOIN LOBBY
    ===================================================== */

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

    /* =====================================================
       HOME
    ===================================================== */

    return (
        <div className="landing-page">

            <ThemeToggle />

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