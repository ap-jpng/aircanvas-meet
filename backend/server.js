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
        version: "1.0.0",
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

app.post("/api/meeting/create", (req, res) => {
    try {
        const roomId = crypto
            .randomBytes(4)
            .toString("hex")
            .toUpperCase();

        const meetingLink = `${getFrontendUrl(req)}/meeting/${roomId}`;

        res.json({
            success: true,
            roomId,
            meetingLink,
        });
    } catch (error) {
        console.error("Create meeting error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to create meeting",
        });
    }
});

app.post("/api/meeting/token", async (req, res) => {
    try {
        const { roomId, participantName } = req.body;

        if (!roomId) {
            return res.status(400).json({
                success: false,
                message: "roomId is required",
            });
        }

        if (!participantName) {
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

        const identity = crypto.randomUUID();

        const token = new AccessToken(
            LIVEKIT_API_KEY,
            LIVEKIT_API_SECRET,
            {
                identity,
                name: participantName.trim().slice(0, 80),
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
            participantName: participantName.trim().slice(0, 80),
        });
    } catch (error) {
        console.error("Token generation error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to generate LiveKit token",
        });
    }
});

function getFrontendUrl(req) {
    const origin = req.headers.origin;

    if (origin) {
        return origin;
    }

    return "http://localhost:5173";
}

server.listen(PORT, () => {
    console.log("");
    console.log("======================================");
    console.log("        AIRCANVAS MEET SERVER");
    console.log("======================================");
    console.log(`Backend: http://localhost:${PORT}`);
    console.log(`LiveKit: ${LIVEKIT_URL || "NOT CONFIGURED"}`);
    console.log(
        `Credentials: ${
            LIVEKIT_API_KEY &&
            LIVEKIT_API_SECRET
                ? "CONFIGURED"
                : "MISSING"
        }`
    );
    console.log("======================================");
    console.log("");
});