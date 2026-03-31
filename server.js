const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

// Create HTTP server (required for Railway)
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Multiplayer server running");
});

// Attach WebSocket server
const wss = new WebSocket.Server({ server });

// Store players
const players = new Map();

// Broadcast helper
function broadcast(data) {
  const message = JSON.stringify(data);

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Handle new connections
wss.on("connection", (ws) => {
  console.log("New player connected");

  const id = Math.random().toString(36).substring(2, 10);

  const player = {
    id,
    x: 100,
    y: 100,
  };

  players.set(id, player);

  ws.send(
    JSON.stringify({
      type: "init",
      selfId: id,
      players: Array.from(players.values()),
    })
  );

  broadcast({
    type: "join",
    player,
  });

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "move") {
        const player = players.get(id);
        if (!player) return;

        player.x = data.x;
        player.y = data.y;

        broadcast({
          type: "update",
          player,
        });
      }
    } catch (err) {
      console.error("Invalid message:", err);
    }
  });

  ws.on("close", () => {
    console.log("Player disconnected:", id);

    players.delete(id);

    broadcast({
      type: "leave",
      id,
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
