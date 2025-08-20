import http from "http";
import express from "express";
import bodyParser from "body-parser";
import { createServer } from "http";
import { xml } from "xmlbuilder2";
import { WebSocketServer } from "ws";

// μ-law helpers -> beep we send back to prove bidirectional audio
const MU_LAW_MAX=0x1FFF,BIAS=0x84,SIGN_BIT=0x80,QUANT_MASK=0x0F,SEG_SHIFT=4;
function linear2ulaw(sample){let pcm=Math.max(-32768,Math.min(32767,sample));let sign=(pcm>>8)&0x80;if(sign!==0)pcm=-pcm;if(pcm>MU_LAW_MAX)pcm=MU_LAW_MAX;pcm=pcm+BIAS;let seg=0;for(let v=pcm>>7;v;v>>=1)seg++;let uval=(seg<<SEG_SHIFT)|((pcm>>(seg+3))&QUANT_MASK);return ~(uval|sign)&0xFF;}
function* beepChunks(){const sr=8000,secs=1,freq=440,N=sr*secs,chunk=160;const samples=new Uint8Array(N);for(let i=0;i<N;i++){const s=Math.sin((2*Math.PI*freq*i)/sr)*0.5;const i16=(Math.max(-1,Math.min(1,s))*32767)|0;samples[i]=linear2ulaw(i16);}for(let i=0;i<samples.length;i+=chunk){yield Buffer.from(samples.slice(i,i+chunk)).toString("base64");}}

const app=express();
app.use(bodyParser.urlencoded({extended:false}));
app.use(bodyParser.json());

// health
app.get("/healthz",(_,res)=>res.status(200).send("ok"));

// Twilio webhook -> return TwiML that starts bidirectional Media Stream
app.post("/voice",(req,res)=>{
  const wsUrl=process.env.STREAM_URL||`${req.protocol}://${req.get("host")}/twilio-ws`;
  const twiml=xml({version:"1.0",encoding:"UTF-8"})
    .ele("Response")
      .ele("Say").txt("Connecting you to the Okomo three sixty assistant.").up()
      .ele("Connect").ele("Stream",{url:wsUrl}).up().up()
    .up().end({prettyPrint:true});
  res.type("application/xml").send(twiml);
});

// http + ws on same port
const server=createServer(app);
const wss=new WebSocketServer({server,path:"/twilio-ws"});

wss.on("connection",(ws)=>{
  console.log("WS connected"); let streamSid=null;
  ws.on("message",(raw)=>{
    try{
      const msg=JSON.parse(raw.toString());
      if(msg.event==="start"){
        streamSid=msg.start.streamSid; console.log("Stream start:",streamSid);
        ws.send(JSON.stringify({event:"clear",streamSid}));
        for(const b64 of beepChunks()){
          ws.send(JSON.stringify({event:"media",streamSid,media:{payload:b64}}));
        }
      }else if(msg.event==="media"){
        // inbound μ-law 8k base64 from caller (we'll feed to Vertex in next step)
      }else if(msg.event==="stop"){ console.log("Stream stop:",streamSid); }
    }catch(e){ console.error("WS parse error",e); }
  });
  ws.on("close",()=>console.log("WS closed"));
  ws.on("error",(e)=>console.error("WS error",e));
});

const PORT=process.env.PORT||8080;
server.listen(PORT,()=>console.log("Voice bridge listening on",PORT));
