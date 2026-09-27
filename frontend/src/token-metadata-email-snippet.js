/**
 * OPTIONAL backend change for your existing /api/meeting/token route.
 *
 * The Attendance Report PDF reads each participant's email from their
 * LiveKit metadata (the same place your existing code already stores
 * { isHost: true/false }). This only adds an "email" field alongside
 * it — nothing else about token creation changes.
 *
 * The frontend now sends participantEmail (optional, may be "" or
 * undefined) in the POST body to /api/meeting/token, next to the
 * existing roomId / participantName / hostToken fields.
 */

app.post("/api/meeting/token", async (req, res) => {
    const {
        roomId,
        participantName,
        participantEmail, // <-- new, optional
        hostToken,
    } = req.body || {};

    // ...your existing validation / hostToken checks stay the same...

    const isHost = /* your existing isHost determination */ false;

    const at = new AccessToken(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
        {
            identity: /* your existing identity generation */ undefined,
            name: participantName,
            metadata: JSON.stringify({
                isHost,
                email: participantEmail || "",
            }),
        }
    );

    // ...grant, addGrant(roomJoin, room: roomId), etc. stay the same...

    // ...respond with { success: true, token, serverUrl, isHost } as before
});