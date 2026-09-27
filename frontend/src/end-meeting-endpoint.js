/**
 * OPTIONAL backend addition for your Render/Node server.
 *
 * The frontend's "End Meeting" button already works without this —
 * it broadcasts a data message that disconnects every participant's
 * browser immediately. This endpoint is only for also closing the
 * LiveKit room itself server-side, so the meeting ID can't be
 * rejoined afterward. Skip it if you don't need that.
 *
 * Wire it into your existing Express app next to your other
 * /api/meeting/* routes (create + token), reusing whatever
 * RoomServiceClient / API key+secret setup those already use.
 */

const { RoomServiceClient } = require("livekit-server-sdk");

// Reuse the same host/key/secret your /api/meeting/create and
// /api/meeting/token routes already use to talk to LiveKit.
const roomService = new RoomServiceClient(
    process.env.LIVEKIT_URL,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET
);

// In-memory example — swap for whatever store you already use to
// remember each room's host token (the same one /api/meeting/create
// generated and /api/meeting/token validates).
// e.g. hostTokensByRoom.get(roomId) === hostToken
async function isValidHost(roomId, hostToken) {
    // TODO: replace with your existing host-token lookup/validation.
    return Boolean(hostToken);
}

app.post("/api/meeting/end", async (req, res) => {
    try {
        const { roomId, hostToken } = req.body || {};

        if (!roomId) {
            return res.status(400).json({
                success: false,
                message: "roomId is required.",
            });
        }

        const authorized = await isValidHost(roomId, hostToken);

        if (!authorized) {
            return res.status(403).json({
                success: false,
                message: "Only the host can end this meeting.",
            });
        }

        // Kicks every remaining participant and deletes the room.
        await roomService.deleteRoom(roomId);

        return res.json({ success: true });
    } catch (error) {
        console.error("End meeting error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to end the meeting.",
        });
    }
});