// server.js — WS Phase A (boot-safe, no beep yet)

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Health check
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Twilio webhook -> TwiML that starts a bidirectional Media Stream
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-ws`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to the Okomo three sixty assistant.</Say>
  <Connect><Stream url="${wsUrl}"/></Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Start HTTP server first (guarantees Cloud Run binds to PORT immediately)
const PORT = Number(process.env.PORT) || 8080;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on", PORT);
});

// Attach WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server, path: "/twilio-ws" });

wss.on("connection", (ws) => {
  console.log("WS connected");
  let streamSid = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("start:", streamSid);
        // Clear Twilio's audio buffer so we can send audio later
        ws.send(JSON.stringify({ event: "clear", streamSid }));
      } else if (msg.event === "media") {
        // Inbound μ-law 8k base64 frames from caller
        // (We'll forward these to Vertex Live in the next step)
      } else if (msg.event === "stop") {
        console.log("stop:", streamSid);
      } else if (msg.event) {
        console.log("event:", msg.event);
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  });

  ws.on("close", () => console.log("WS closed"));
  ws.on("error", (e) => console.error("WS error:", e));
});

