const express = require("express");
const http = require("http");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
const {
    AccessToken,
    RoomServiceClient,
    TrackSource,
} = require("livekit-server-sdk");

dotenv.config();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5001;

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// Production frontend URL
const FRONTEND_URL =
    process.env.FRONTEND_URL ||
    "https://aircanvas-meet.vercel.app";

/*
 * HOST CONTROLS (mute / remove participant).
 * Used only by the two new endpoints below. Built lazily inside
 * each endpoint (not here at startup) so a missing LiveKit config
 * can never crash server boot — it just makes those two endpoints
 * return a clean error instead.
 */
function getRoomServiceClient() {
    if (
        !LIVEKIT_URL ||
        !LIVEKIT_API_KEY ||
        !LIVEKIT_API_SECRET
    ) {
        return null;
    }

    return new RoomServiceClient(
        LIVEKIT_URL,
        LIVEKIT_API_KEY,
        LIVEKIT_API_SECRET
    );
}

app.use(
    cors({
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
    })
);

app.use(express.json());

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "AirCanvas Meet Backend",
        version: "2.1.0",
    });
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        message: "AirCanvas Meet backend is running",
        livekitConfigured: Boolean(
            LIVEKIT_URL &&
                LIVEKIT_API_KEY &&
                LIVEKIT_API_SECRET
        ),
        frontendUrl: FRONTEND_URL,
    });
});

// ============================================================
// CREATE MEETING
// ============================================================
// Creates a new room ID and a signed host token.
//
// IMPORTANT:
// The meeting link is ALWAYS generated using FRONTEND_URL.
// Therefore, even when the request comes from localhost,
// the shareable link will be:
//
// https://aircanvas-meet.vercel.app/meeting/XXXXXXXX
// ============================================================

app.post("/api/meeting/create", (req, res) => {
    try {
        if (!LIVEKIT_API_SECRET) {
            return res.status(500).json({
                success: false,
                message: "LiveKit credentials are not configured",
            });
        }

        const roomId = crypto
            .randomBytes(4)
            .toString("hex")
            .toUpperCase();

        const hostToken = createHostToken(roomId);

        const meetingLink =
            `${FRONTEND_URL}/meeting/${roomId}`;

        res.json({
            success: true,
            roomId,
            meetingLink,
            hostToken,
        });
    } catch (error) {
        console.error(
            "Create meeting error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Failed to create meeting",
        });
    }
});

// ============================================================
// GENERATE LIVEKIT TOKEN
// ============================================================

app.post("/api/meeting/token", async (req, res) => {
    try {
        const {
            roomId,
            participantName,
            hostToken,
        } = req.body;

        // ----------------------------------------------------
        // Validate room ID
        // ----------------------------------------------------

        if (!roomId) {
            return res.status(400).json({
                success: false,
                message: "roomId is required",
            });
        }

        // ----------------------------------------------------
        // Validate participant name
        // ----------------------------------------------------

        if (
            !participantName ||
            !participantName.trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "participantName is required",
            });
        }

        // ----------------------------------------------------
        // Validate LiveKit configuration
        // ----------------------------------------------------

        if (
            !LIVEKIT_URL ||
            !LIVEKIT_API_KEY ||
            !LIVEKIT_API_SECRET
        ) {
            return res.status(500).json({
                success: false,
                message:
                    "LiveKit credentials are not configured",
            });
        }

        // ----------------------------------------------------
        // Determine whether this participant is the host
        // ----------------------------------------------------

        const isHost = verifyHostToken(
            roomId,
            hostToken
        );

        const identity = crypto.randomUUID();

        const cleanName = participantName
            .trim()
            .slice(0, 80);

        // ----------------------------------------------------
        // Create LiveKit access token
        // ----------------------------------------------------

        const token = new AccessToken(
            LIVEKIT_API_KEY,
            LIVEKIT_API_SECRET,
            {
                identity,
                name: cleanName,

                metadata: JSON.stringify({
                    isHost,
                }),

                ttl: "2h",
            }
        );

        // ----------------------------------------------------
        // Room permissions
        // ----------------------------------------------------

        token.addGrant({
            roomJoin: true,
            room: roomId,

            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        });

        // ----------------------------------------------------
        // Generate JWT
        // ----------------------------------------------------

        const jwt = await token.toJwt();

        // ----------------------------------------------------
        // Return token + host status
        // ----------------------------------------------------

        res.json({
            success: true,

            token: jwt,

            serverUrl: LIVEKIT_URL,

            roomId,

            participantName: cleanName,

            isHost,
        });
    } catch (error) {
        console.error(
            "Token generation error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Failed to generate LiveKit token",
        });
    }
});

// ============================================================
// HOST: MUTE / UNMUTE A PARTICIPANT'S MIC OR CAMERA
// ============================================================
// Body: { roomId, hostToken, participantIdentity, trackType, muted }
// trackType is "microphone" or "camera". muted is true/false.
// Only the meeting host (verified the same way as every other
// endpoint here, via the signed hostToken) can call this.
// ============================================================

app.post(
    "/api/meeting/mute-participant",
    async (req, res) => {
        try {
            const {
                roomId,
                hostToken,
                participantIdentity,
                trackType,
                muted,
            } = req.body;

            if (
                !roomId ||
                !participantIdentity ||
                !trackType
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "roomId, participantIdentity and trackType are required",
                });
            }

            if (
                !verifyHostToken(
                    roomId,
                    hostToken
                )
            ) {
                return res.status(403).json({
                    success: false,
                    message:
                        "Only the host can do that",
                });
            }

            const roomService =
                getRoomServiceClient();

            if (!roomService) {
                return res.status(500).json({
                    success: false,
                    message:
                        "LiveKit credentials are not configured",
                });
            }

            const participant =
                await roomService.getParticipant(
                    roomId,
                    participantIdentity
                );

            const wantedSource =
                trackType === "camera"
                    ? TrackSource.CAMERA
                    : TrackSource.MICROPHONE;

            const track = (
                participant.tracks || []
            ).find(
                (candidate) =>
                    candidate.source ===
                    wantedSource
            );

            if (!track) {
                return res.status(404).json({
                    success: false,
                    message: `That participant has no active ${trackType} track`,
                });
            }

            await roomService.mutePublishedTrack(
                roomId,
                participantIdentity,
                track.sid,
                muted !== false
            );

            res.json({
                success: true,
            });
        } catch (error) {
            console.error(
                "Mute participant error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Failed to mute/unmute participant",
            });
        }
    }
);

// ============================================================
// HOST: REMOVE A PARTICIPANT FROM THE MEETING
// ============================================================
// Body: { roomId, hostToken, participantIdentity }
// Only the meeting host can call this.
// ============================================================

app.post(
    "/api/meeting/remove-participant",
    async (req, res) => {
        try {
            const {
                roomId,
                hostToken,
                participantIdentity,
            } = req.body;

            if (
                !roomId ||
                !participantIdentity
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "roomId and participantIdentity are required",
                });
            }

            if (
                !verifyHostToken(
                    roomId,
                    hostToken
                )
            ) {
                return res.status(403).json({
                    success: false,
                    message:
                        "Only the host can do that",
                });
            }

            const roomService =
                getRoomServiceClient();

            if (!roomService) {
                return res.status(500).json({
                    success: false,
                    message:
                        "LiveKit credentials are not configured",
                });
            }

            await roomService.removeParticipant(
                roomId,
                participantIdentity
            );

            res.json({
                success: true,
            });
        } catch (error) {
            console.error(
                "Remove participant error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Failed to remove participant",
            });
        }
    }
);

// ============================================================
// CREATE SIGNED HOST TOKEN
// ============================================================

function createHostToken(roomId) {
    const signature = crypto
        .createHmac(
            "sha256",
            LIVEKIT_API_SECRET
        )
        .update(
            `aircanvas-host:${roomId}`
        )
        .digest("base64url");

    return `${roomId}.${signature}`;
}

// ============================================================
// VERIFY HOST TOKEN
// ============================================================

function verifyHostToken(
    roomId,
    hostToken
) {
    if (
        !hostToken ||
        !LIVEKIT_API_SECRET
    ) {
        return false;
    }

    const expected =
        createHostToken(roomId);

    const expectedBuffer =
        Buffer.from(
            expected,
            "utf8"
        );

    const receivedBuffer =
        Buffer.from(
            hostToken,
            "utf8"
        );

    // Prevent timingSafeEqual from throwing
    // when lengths are different.
    if (
        expectedBuffer.length !==
        receivedBuffer.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        expectedBuffer,
        receivedBuffer
    );
}

// ============================================================
// FIX (diagnostics): JSON SAFETY NET
// ============================================================
// Everything above already returns JSON on its own success/error
// paths. These two handlers only catch what nothing above catches:
// (a) a request to a route that doesn't exist at all (e.g. the
// frontend calling an endpoint that hasn't been deployed to THIS
// running server yet), which Express would otherwise answer with
// its default HTML "Cannot POST /..." page, and (b) any truly
// unexpected thrown/rejected error that isn't already wrapped in
// a route's own try/catch. Both previously came back as non-JSON,
// which is exactly what made them indistinguishable, on the
// frontend, from a dropped network connection. Placed last, after
// every real route above, so they never intercept a request that
// a real route would otherwise have handled.
// ============================================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: `No route ${req.method} ${req.path} on this backend. If you just added this endpoint, the backend likely needs to be redeployed.`,
    });
});

app.use((error, req, res, next) => {
    console.error(
        "Unhandled server error:",
        error
    );

    res.status(500).json({
        success: false,
        message:
            "Unexpected server error",
    });
});

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, () => {
    console.log("");
    console.log(
        "======================================"
    );
    console.log(
        "        AIRCANVAS MEET SERVER"
    );
    console.log(
        "======================================"
    );

    console.log(
        `Backend: http://localhost:${PORT}`
    );

    console.log(
        `LiveKit: ${
            LIVEKIT_URL ||
            "NOT CONFIGURED"
        }`
    );

    console.log(
        `Credentials: ${
            LIVEKIT_API_KEY &&
            LIVEKIT_API_SECRET
                ? "CONFIGURED"
                : "MISSING"
        }`
    );

    console.log(
        `Frontend: ${FRONTEND_URL}`
    );

    console.log(
        "Host token system: ENABLED"
    );

    console.log(
        "Production meeting links: ENABLED"
    );

    console.log(
        "======================================"
    );

    console.log("");
});