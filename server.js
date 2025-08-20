// server.js — Twilio <-> Cloud Run bridge (ESM), with beep + diagnostics

import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import textToSpeech from "@google-cloud/text-to-speech";
const ttsClient = new textToSpeech.TextToSpeechClient();


/* ===================== ENV / SECRETS ===================== */
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM  = process.env.TWILIO_FROM        || ""; // e.g., +17755490708 (Twilio-owned) or a verified caller ID

const mask = (s) => (s ? s.replace(/^(.{6}).*(.{4})$/, "$1…$2") : "(missing)");
console.log("[boot] TWILIO_ACCOUNT_SID:", mask(TWILIO_SID));
console.log("[boot] TWILIO_FROM:", TWILIO_FROM || "(missing)");

/* ===================== μ-LAW + BEEP HELPERS ===================== */
// μ-law constants
const MU_LAW_MAX = 0x1FFF, BIAS = 0x84, QUANT_MASK = 0x0F, SEG_SHIFT = 4;

function linear2ulaw(sample) {
  let pcm = Math.max(-32768, Math.min(32767, sample));
  const sign = (pcm >> 8) & 0x80;
  if (sign !== 0) pcm = -pcm;
  if (pcm > MU_LAW_MAX) pcm = MU_LAW_MAX;
  pcm = pcm + BIAS;
  let seg = 0; for (let v = pcm >> 7; v; v >>= 1) seg++;
  const uval = (seg << SEG_SHIFT) | ((pcm >> (seg + 3)) & QUANT_MASK);
  return ~(uval | sign) & 0xFF;
}

// precompute a 2-second A4 beep at 8 kHz, chunked into 20 ms (160-sample) frames
function makeBeepFrames({ secs = 2, freq = 440 }) {
  const sr = 8000, N = sr * secs, CHUNK = 160;
  const ulaw = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / sr) * 0.4; // ~-8 dBFS
    ulaw[i] = linear2ulaw((s * 32767) | 0);
  }
  const frames = [];
  for (let i = 0; i < ulaw.length; i += CHUNK) {
    frames.push(Buffer.from(ulaw.slice(i, i + CHUNK)).toString("base64"));
  }
  return frames;
}
const BEEP_FRAMES = makeBeepFrames({ secs: 2, freq: 440 });

/* ===================== APP ===================== */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Health
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

/* ===== Twilio webhook: return TwiML that opens the bidirectional stream ===== */
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

/* ===== Outbound call API: POST /call { "to": "+91...", "from": "+1..."(optional) } ===== */
async function twilioCreateCall({ to, from, voiceUrl }) {
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    throw new Error("Missing Twilio SID/TOKEN env vars");
  }
  const api = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`;
  const body = new URLSearchParams({
    To: to,
    From: from || TWILIO_FROM,  // allow per-request override
    Url: voiceUrl,
    Method: "POST",
  }).toString();

  const r = await fetch(api, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Twilio call failed ${r.status} ${text}`);
  }
  return r.json();
}

app.post("/call", async (req, res) => {
  try {
    const to = (req.body?.to || "").trim();
    const from = (req.body?.from || "").trim(); // optional override
    if (!to || !/^\+\d{8,15}$/.test(to)) {
      return res.status(400).json({ error: "`to` must be E.164 like +919650669952" });
    }
    if (from && !/^\+\d{8,15}$/.test(from)) {
      return res.status(400).json({ error: "`from` must be E.164 if provided" });
    }
    const voiceUrl = `https://${req.get("host")}/voice`;
    const result = await twilioCreateCall({ to, from, voiceUrl });
    console.log("[/call] created", result.sid, result.status);
    res.json({ sid: result.sid, status: result.status || "queued" });
  } catch (e) {
    console.error("[/call] error", e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ===================== Diagnostics ===================== */
app.get("/diag", (_req, res) => {
  res.json({
    sid_masked: mask(TWILIO_SID),
    from: TWILIO_FROM || null,
    has_token: Boolean(TWILIO_TOKEN),
  });
});

app.get("/diag/twilio", async (_req, res) => {
  try {
    if (!TWILIO_SID || !TWILIO_TOKEN) {
      return res.status(400).json({ error: "Missing Twilio SID/TOKEN env vars" });
    }
    const auth = "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
    const base = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}`;

    const [ocidsResp, ownedResp] = await Promise.all([
      fetch(`${base}/OutgoingCallerIds.json`, { headers: { Authorization: auth } }),
      fetch(`${base}/IncomingPhoneNumbers.json`, { headers: { Authorization: auth } }),
    ]);

    const ocids = await ocidsResp.json();
    const owned = await ownedResp.json();

    const verified = (ocids?.outgoing_caller_ids || []).map(x => x.phone_number);
    const ownedNums = (owned?.incoming_phone_numbers || []).map(x => x.phone_number);

    res.json({ sid_masked: mask(TWILIO_SID), verified, owned: ownedNums });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ===================== Start HTTP (Cloud Run) ===================== */
const PORT = Number(process.env.PORT) || 8080;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("[boot] HTTP listening on", PORT);
});

/* ===================== WebSocket: /twilio-ws ===================== */
const wss = new WebSocketServer({ server, path: "/twilio-ws" });

wss.on("connection", (ws) => {
  console.log("[ws] connected");
  let streamSid = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "connected") {
        console.log("[ws] proto:", msg.protocol, "version:", msg.version);
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid;
        console.log("[ws] start", streamSid, "tracks:", msg.start?.tracks);

        // 1) clear Twilio’s buffer
        ws.send(JSON.stringify({ event: "clear", streamSid }));

        // 2) small delay so Twilio is ready to play
        setTimeout(() => {
          // 3) send 2s beep @20ms per frame
          let i = 0;
          const t = setInterval(() => {
            if (ws.readyState !== ws.OPEN) { clearInterval(t); return; }
            if (i >= BEEP_FRAMES.length) {
              clearInterval(t);
              // 4) send 'mark' so Twilio can ack playback completion
              const label = `beep-${Date.now()}`;
              ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: label } }));
              console.log("[ws] mark sent:", label);
              return;
            }
            ws.send(JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: BEEP_FRAMES[i++] }
            }));
          }, 20);
        }, 200);
      }

      else if (msg.event === "media") {
        // inbound μ-law 8k base64 frames from caller (future: stream to STT)
      }

      else if (msg.event === "mark") {
        console.log("[ws] mark ack from Twilio:", msg.mark?.name);
      }

      else if (msg.event === "stop") {
        console.log("[ws] stop", streamSid);
      }
    } catch (e) {
      console.error("[ws] parse error", e);
    }
  });

  ws.on("close", () => console.log("[ws] closed"));
  ws.on("error", (e) => console.error("[ws] error", e));
});




