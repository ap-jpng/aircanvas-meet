const express = require("express");
const http = require("http");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
const { AccessToken } = require("livekit-server-sdk");

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