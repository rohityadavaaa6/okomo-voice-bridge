// server.js — Outbound-ready WS bridge (ESM)

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";

// --- Twilio creds via env (mounted from Secret Manager) ---
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_FROM;

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Health check
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Inbound Twilio webhook -> TwiML that starts bidirectional Media Stream
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

// ---- OUTBOUND: POST /call { "to": "+91XXXXXXXXXX" } ----
async function twilioCreateCall(to, url) {
  const api = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`;
  const body = new URLSearchParams({
    To: to,
    From: TWILIO_FROM,
    Url: url,          // TwiML URL Twilio will fetch (our /voice)
    Method: "POST"
  }).toString();

  const r = await fetch(api, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!r.ok) throw new Error(`Twilio call failed ${r.status} ${await r.text()}`);
  return r.json();
}

app.post("/call", async (req, res) => {
  try {
    const to = (req.body?.to || "").trim();
    if (!to) return res.status(400).json({ error: "`to` (E.164) is required" });

    // Twilio fetches this; it returns our TwiML <Connect><Stream>
    const voiceUrl = `https://${req.get("host")}/voice`;

    const resp = await twilioCreateCall(to, voiceUrl);
    res.json({ sid: resp.sid, status: resp.status });
  } catch (e) {
    console.error("outbound error", e);
    res.status(500).json({ error: e.message });
  }
});

// Start HTTP server first (Cloud Run binds to PORT)
const PORT = Number(process.env.PORT) || 8080;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on", PORT);
});

// WebSocket for Twilio Media Streams
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
        // Clear Twilio's audio buffer; we'll send audio when AI is wired
        ws.send(JSON.stringify({ event: "clear", streamSid }));
      } else if (msg.event === "media") {
        // inbound μ-law 8k base64; will feed to STT in next step
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


