const dotenv = require("dotenv");
const { RoomServiceClient } = require("livekit-server-sdk");

dotenv.config();

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

console.log("");
console.log("======================================");
console.log("      LIVEKIT CREDENTIAL TEST");
console.log("======================================");

console.log("LiveKit URL:", LIVEKIT_URL);
console.log(
    "API key loaded:",
    LIVEKIT_API_KEY ? "YES" : "NO"
);
console.log(
    "API secret loaded:",
    LIVEKIT_API_SECRET ? "YES" : "NO"
);

async function testLiveKit() {
    try {
        const roomService = new RoomServiceClient(
            LIVEKIT_URL.replace(/^wss:/, "https:"),
            LIVEKIT_API_KEY,
            LIVEKIT_API_SECRET
        );

        const rooms = await roomService.listRooms();

        console.log("");
        console.log("SUCCESS!");
        console.log(
            "LiveKit accepted the API key and secret."
        );
        console.log(
            "Active rooms:",
            rooms.length
        );
        console.log("");
        console.log("======================================");
    } catch (error) {
        console.log("");
        console.log("FAILED!");
        console.log(
            "LiveKit rejected the backend credentials."
        );
        console.log("");

        console.log(
            "Error message:",
            error.message
        );

        if (error.code) {
            console.log(
                "Error code:",
                error.code
            );
        }

        console.log("");
        console.log("======================================");
    }
}

testLiveKit();