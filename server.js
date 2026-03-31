const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
    return;
  }
  res.end("Running");
});

const wss = new WebSocket.Server({ server });

const players = new Map();
const sockets = new Map();

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  for (const [id, ws] of sockets) {
    if (id === exclude) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function makeId() {
  return crypto.randomBytes(4).toString("hex");
}

wss.on("connection", (ws) => {
  const id = makeId();

  const player = { id, username: "Guest", x: 100, y: 100 };
  players.set(id, player);
  sockets.set(id, ws);

  ws.send(JSON.stringify({
    type: "init",
    selfId: id,
    players: [...players.values()]
  }));

  broadcast({ type: "join", player }, id);

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    if (data.type === "join" && data.username) {
      player.username = data.username;
      broadcast({ type: "update", player });
    }

    if (data.type === "move") {
      player.x = data.x;
      player.y = data.y;
      broadcast({ type: "update", player });
    }

    if (data.type === "shoot") {
      broadcast({
        type: "shoot",
        projectile: {
          id: makeId(),
          ownerId: id,
          x: player.x,
          y: player.y,
          vx: data.vx,
          vy: data.vy
        }
      });
    }
  });

  ws.on("close", () => {
    players.delete(id);
    sockets.delete(id);
    broadcast({ type: "leave", id });
  });
});

server.listen(PORT, () => {
  console.log("Server running on", PORT);
});
