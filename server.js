// server.js — Voice bridge (Twilio + Cloud Run), ESM

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";

/* ------------------ Twilio credentials from env (Secret Manager) ------------------ */
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_FROM;       // e.g. +17755490708 (your Twilio number)

/* ----------------------------------- App setup ----------------------------------- */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

/* ---------------------------------- Health check --------------------------------- */
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

/* -------------------- Twilio webhook -> return TwiML with Stream ------------------ */
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-ws`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to the Okomo three sixty assistant.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

/* ----------------------------- Outbound call (REST) ------------------------------ */
/**
 * Create a Twilio call that will fetch our /voice TwiML.
 * @param {string} to   E.164 target, e.g. +91965...
 * @param {string} url  Absolute URL to /voice
 * @param {string} from E.164 caller ID (Twilio number); if falsy, uses TWILIO_FROM
 */
async function twilioCreateCall(to, url, from) {
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
  }
  const api = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`;
  const body = new URLSearchParams({
    To: to,
    From: from || TWILIO_FROM || "",
    Url: url,
    Method: "POST"
  }).toString();

  const r = await fetch(api, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Twilio call failed ${r.status} ${text}`);
  }
  return r.json();
}

/**
 * POST /call  { "to": "+91XXXXXXXXXX", "from": "+1XXXXXXXXXX" (optional) }
 * - On Twilio **trial**, the "to" number must be in Verified Caller IDs for THIS SID.
 * - Caller ID "from" should be a Twilio number owned by the account (e.g. +17755490708).
 */
app.post("/call", async (req, res) => {
  try {
    const to = (req.body?.to || "").trim();
    const fromOverride = (req.body?.from || "").trim();
    if (!to || !to.startsWith("+")) {
      return res.status(400).json({ error: "`to` (E.164, starting with +) is required" });
    }

    const voiceUrl = `https://${req.get("host")}/voice`;
    const resp = await twilioCreateCall(to, voiceUrl, fromOverride);
    res.json({ sid: resp.sid, status: resp.status });
  } catch (e) {
    console.error("outbound error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------- Diagnostics (for troubleshooting) ---------------------- */
function maskSid(s) {
  if (!s) return null;
  return s.slice(0, 6) + "…" + s.slice(-4);
}

// Quick env peek (masked)
app.get("/diag", (_req, res) => {
  res.json({
    sid_masked: maskSid(TWILIO_SID),
    from: TWILIO_FROM || null,
    has_token: Boolean(TWILIO_TOKEN)
  });
});

// Ask Twilio which numbers are verified/owned under THIS SID
app.get("/diag/twilio", async (_req, res) => {
  try {
    if (!TWILIO_SID || !TWILIO_TOKEN) {
      return res.status(500).json({ error: "Missing TWILIO_* env vars" });
    }
    const auth = "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
    const base = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}`;

    const [ocidsResp, ownedResp] = await Promise.all([
      fetch(`${base}/OutgoingCallerIds.json`, { headers: { Authorization: auth } }),
      fetch(`${base}/IncomingPhoneNumbers.json`, { headers: { Authorization: auth } })
    ]);

    const ocids = await ocidsResp.json();
    const owned = await ownedResp.json();

    const verified = (ocids.outgoing_caller_ids || []).map(x => x.phone_number);
    const ownedNums = (owned.incoming_phone_numbers || []).map(x => x.phone_number);

    res.json({ sid_masked: maskSid(TWILIO_SID), verified, owned: ownedNums });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ---------------------------- Start HTTP (Cloud Run) ----------------------------- */
const PORT = Number(process.env.PORT) || 8080;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on", PORT);
});

/* -------------------- WebSocket endpoint for Twilio Media Streams ---------------- */
const wss = new WebSocketServer({ server, path: "/twilio-ws" });

wss.on("connection", (ws) => {
  console.log("WS connected");
  let streamSid = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid;
        console.log("WS start:", streamSid);
        // Clear Twilio’s playback buffer (so we can send audio later if needed)
        ws.send(JSON.stringify({ event: "clear", streamSid }));

      } else if (msg.event === "media") {
        // inbound μ-law 8k base64 from the caller (future: forward to STT/LLM)
        // msg.media.payload
      } else if (msg.event === "stop") {
        console.log("WS stop:", streamSid);
      } else if (msg.event) {
        console.log("WS event:", msg.event);
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  });

  ws.on("close", () => console.log("WS closed"));
  ws.on("error", (e) => console.error("WS error:", e));
});


