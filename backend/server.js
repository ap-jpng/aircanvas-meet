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

app.use(
    cors({
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
    })
);

app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "AirCanvas Meet Backend",
        version: "2.0.0",
    });
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        message: "AirCanvas Meet backend is running",
        livekitConfigured: Boolean(
            LIVEKIT_URL &&
                LIVEKIT_API_KEY &&
                LIVEKIT_API_SECRET
        ),
    });
});

// ------------------------------------------------------------
// CREATE MEETING
// ------------------------------------------------------------
// The creator receives a signed hostToken.
// This token proves that this participant is the host
// when they later join the room.
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
        const meetingLink = `${getFrontendUrl(req)}/meeting/${roomId}`;

        res.json({
            success: true,
            roomId,
            meetingLink,
            hostToken,
        });
    } catch (error) {
        console.error("Create meeting error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to create meeting",
        });
    }
});

// ------------------------------------------------------------
// GENERATE LIVEKIT TOKEN
// ------------------------------------------------------------
app.post("/api/meeting/token", async (req, res) => {
    try {
        const {
            roomId,
            participantName,
            hostToken,
        } = req.body;

        if (!roomId) {
            return res.status(400).json({
                success: false,
                message: "roomId is required",
            });
        }

        if (!participantName || !participantName.trim()) {
            return res.status(400).json({
                success: false,
                message: "participantName is required",
            });
        }

        if (
            !LIVEKIT_URL ||
            !LIVEKIT_API_KEY ||
            !LIVEKIT_API_SECRET
        ) {
            return res.status(500).json({
                success: false,
                message: "LiveKit credentials are not configured",
            });
        }

        // Only the signed token created by /meeting/create
        // can grant host status.
        const isHost = verifyHostToken(roomId, hostToken);

        const identity = crypto.randomUUID();

        const cleanName = participantName
            .trim()
            .slice(0, 80);

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

        token.addGrant({
            roomJoin: true,
            room: roomId,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        });

        const jwt = await token.toJwt();

        res.json({
            success: true,
            token: jwt,
            serverUrl: LIVEKIT_URL,
            roomId,
            participantName: cleanName,
            isHost,
        });
    } catch (error) {
        console.error("Token generation error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to generate LiveKit token",
        });
    }
});

// ------------------------------------------------------------
// HOST TOKEN HELPERS
// ------------------------------------------------------------

function createHostToken(roomId) {
    const signature = crypto
        .createHmac("sha256", LIVEKIT_API_SECRET)
        .update(`aircanvas-host:${roomId}`)
        .digest("base64url");

    return `${roomId}.${signature}`;
}

function verifyHostToken(roomId, hostToken) {
    if (!hostToken || !LIVEKIT_API_SECRET) {
        return false;
    }

    const expected = createHostToken(roomId);

    const expectedBuffer = Buffer.from(
        expected,
        "utf8"
    );

    const receivedBuffer = Buffer.from(
        hostToken,
        "utf8"
    );

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

// ------------------------------------------------------------
// FRONTEND URL
// ------------------------------------------------------------

function getFrontendUrl(req) {
    const origin = req.headers.origin;

    if (origin) {
        return origin;
    }

    // Used when testing the backend directly
    // from PowerShell.
    return "http://localhost:5173";
}

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------

server.listen(PORT, () => {
    console.log("");
    console.log("======================================");
    console.log("        AIRCANVAS MEET SERVER");
    console.log("======================================");
    console.log(`Backend: http://localhost:${PORT}`);
    console.log(
        `LiveKit: ${LIVEKIT_URL || "NOT CONFIGURED"}`
    );
    console.log(
        `Credentials: ${
            LIVEKIT_API_KEY && LIVEKIT_API_SECRET
                ? "CONFIGURED"
                : "MISSING"
        }`
    );
    console.log("Host token system: ENABLED");
    console.log("======================================");
    console.log("");
});