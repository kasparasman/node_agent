import {
  AutoSubscribe,
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import fetch from 'node-fetch';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Pinecone } from '@pinecone-database/pinecone';
import {
  VideoFrame,
  VideoBufferType,
  TrackPublishOptions,
  LocalVideoTrack,
  VideoSource,
  TrackSource,
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
} from '@livekit/rtc-node';
//@ts-ignore
import pkg from '@roamhq/wrtc';
const { RTCPeerConnection, MediaStream } = pkg;
const { RTCVideoSink, RTCAudioSink } = pkg.nonstandard;

import WebSocket from "ws";
import sdpTransform from 'sdp-transform';
import fs from 'fs';

// =======================
// Configuration Constants
// =======================
dotenv.config();
const INDEX_NAME = "chatbot";
const NAMESPACE = "zinzino";
const MODEL_NAME = "multilingual-e5-large";
const EMBED_DIM = 1024;

const DID_API = {
  key: process.env.DID_API_KEY!, // non-null assertion
  service: "talks", // or 'clips'
  websocketUrl: process.env.DID_WEBSOCKET_URL!, // non-null assertion
};
const PRESENTER_TYPE = DID_API.service === 'clips' ? 'clip' : 'talk';

// Global state variables for D-ID negotiation
let ws: WebSocket | null = null;
let peerConnection: RTCPeerConnection | null = null;
let pcDataChannel: RTCDataChannel | null = null;
let streamId = "";
let sessionId = "";
let sessionClientAnswer: RTCSessionDescriptionInit | null = null;
let isStreamReady = false;
const streamWarmup = true;
isStreamReady = streamWarmup ? false : true;
const IDLE_BITRATE_THRESHOLD = 200; // e.g., 5000 bps
const IDLE_AUDIO_BITRATE_THRESHOLD = 200;  // in bps for audio (adjust as needed)

// Variables for video track monitoring
let statsIntervalId: NodeJS.Timeout;
let videoIsPlaying = false;
let lastBytesReceived = 0;
let lastStatsTimestamp = Date.now();
let audioIsPlaying = false;
let lastAudioBytesReceived = 0;
let lastAudioStatsTimestamp = Date.now();
let audioStatsIntervalId; // audio monitor interval
let currentVideoBitrate = 0;
let currentAudioBitrate = 0;
let statusMessage = "";
let lastVideoStatsTimestamp = Date.now();

// =======================
// Logger Implementation
// =======================
class Logger {
  private fileStream: fs.WriteStream;
  constructor(logFile: string) {
    this.fileStream = fs.createWriteStream(logFile, { flags: 'w' });
  }
  info(message: string) {
    process.stdout.write(`\r[INFO] ${message}`);
    this.fileStream.write(`[INFO] ${message}\n`);
  }
  error(message: string, err?: any) {
    console.error(message, err);
    this.fileStream.write(`[ERROR] ${message} ${err ? JSON.stringify(err) : ''}\n`);
  }
  debug(message: string) {
    // For real-time logging, update the same line on stdout
    // Also write full log to file
    this.fileStream.write(`[DEBUG] ${message}\n`);
  }
  logLatency(step: string, startTime: number) {
    const latency = Date.now() - startTime;
    const logEntry = `[Latency] ${step}: ${latency} ms at ${new Date().toISOString()}`;
    this.info(logEntry);
  }
}
const logger = new Logger('latency.log');
function updateConsoleBitrateLine() {
  // Clear the current line and move the cursor to the beginning
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(
    `[BITRATE] Video: ${currentVideoBitrate.toFixed(2)} bps | Audio: ${currentAudioBitrate.toFixed(2)} bps ${statusMessage}`
  );
}

// =======================
// Utility Functions
// =======================
async function pineconePingLoop() {
  while (true) {
    try {
      const pingQuery = "zinzino";
      const context = await getRetrievedContext(pingQuery);
      logger.info("[Pinecone Ping] Successfully retrieved context.");
    } catch (error) {
      logger.error("[Pinecone Ping] Error during ping:", error);
    }
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

async function waitForVideoOrStreamReady(timeout = 5000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (videoIsPlaying || isStreamReady) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

// =======================
// D-ID WebSocket Helpers
// =======================
async function connectToDIDWebSocket(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = `${url}?authorization=Basic ${encodeURIComponent(token)}`;
    const socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      logger.debug("[D-ID] WebSocket connection opened.");
      resolve(socket);
    };
    socket.onerror = (err) => {
      logger.error("[D-ID] WebSocket error:", err);
      reject(err);
    };
    socket.onclose = () => {
      logger.debug("[D-ID] WebSocket connection closed.");
    };
  });
}

function sendDIDMessage(ws: WebSocket, message: any) {
  if (ws.readyState === ws.OPEN) {
    const json = JSON.stringify(message);
    logger.debug("[D-ID] Sending message.");
    ws.send(json);
  } else {
    logger.error("[D-ID] WebSocket not open. Cannot send message.");
  }
}

// =======================
// Video Track Monitoring
// =======================
function monitorVideoTrack(event) {
  if (!event.track) return;
  lastVideoStatsTimestamp = Date.now();

  setInterval(async () => {
    try {
      const now = Date.now();
      const elapsedSeconds = (now - lastVideoStatsTimestamp) / 1000;
      lastVideoStatsTimestamp = now;

      const stats = await peerConnection.getStats(event.track);
      stats.forEach((report) => {
        //logger.debug(`Stats Report ID: ${report.id}`);
        //logger.debug(JSON.stringify(report, null, 2)); // readable JSON format
        //logger.debug("Report keys:", Object.keys(report));

        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const reportData = report.toJSON ? report.toJSON() : report;
          const bytesDelta = report.bytesReceived - lastVideoBytesReceived;
          logger.debug(`Video bytes received: ${reportData.bytesReceived}`);
          logger.debug("lastVideoBytesReceived: ", lastVideoBytesReceived)          
          lastVideoBytesReceived = report.bytesReceived;
          logger.debug("lastVideoBytesReceived:(updated): ", lastVideoBytesReceived)

          const bitrate = (bytesDelta * 8) / elapsedSeconds;
          currentVideoBitrate = bitrate;
          logger.debug("bitrate: ", currentVideoBitrate)

          // Check state transitions only when state changes.
          if (bitrate < IDLE_VIDEO_BITRATE_THRESHOLD) {
            if (videoIsPlaying !== false) {
              // Log once to file if desired:
              // logger.info(`[Monitor-Video] Transitioning to idle (bitrate ${bitrate.toFixed(2)} bps).`);
              videoIsPlaying = false;
              // Update statusMessage (replacing any previous video state).
              statusMessage = statusMessage.replace(/\[Video.*?\]/, "") + " [Video Idle]";
            }
          } else {
            if (videoIsPlaying !== true) {
              // logger.info(`[Monitor-Video] Transitioning to active (bitrate ${bitrate.toFixed(2)} bps).`);
              videoIsPlaying = true;
              statusMessage = statusMessage.replace(/\[Video.*?\]/, "") + " [Video Active]";
            }
          }
          updateConsoleBitrateLine();
        }
      });

    } catch (e) {
      // Optionally log error to file (avoid printing to stdout).
      // logger.error("[Monitor-Video] Error getting stats:", e);
    }
  }, 500);
}
async function waitForTrackBitrate(kind, threshold, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (kind === 'video' && currentVideoBitrate >= threshold) {
      return true;
    }
    if (kind === 'audio' && currentAudioBitrate >= threshold) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

// -------------------------
// Audio Track Monitoring (Dynamic Output Only)
// -------------------------
function monitorAudioTrack(event) {
  if (!event.track) return;
  lastAudioStatsTimestamp = Date.now();

  setInterval(async () => {
    try {
      const now = Date.now();
      const elapsedSeconds = (now - lastAudioStatsTimestamp) / 1000;
      lastAudioStatsTimestamp = now;

      const stats = await peerConnection.getStats(event.track);


      stats.forEach((report) => {
        //logger.debug(`Stats Report ID: ${report.id}`);
        //logger.debug(JSON.stringify(report, null, 2)); // readable JSON format
        //logger.debug("Report keys:", Object.keys(report));

        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          const reportData = report.toJSON ? report.toJSON() : report;

          const bytesDelta = reportData.bytesReceived - lastAudioBytesReceived;
          logger.debug(`Audio bytes received: ${reportData.bytesReceived}`);

          lastAudioBytesReceived = reportData.bytesReceived;
          logger.debug(`updated lastAudioBytesReceived: ${lastAudioBytesReceived}`)
          logger.debug(`elapsedSeconds: ${elapsedSeconds}`)

          const currentAudioBitrate = (bytesDelta * 8) / elapsedSeconds;
          logger.debug(`audio bitrate: ${currentAudioBitrate}`)

          // Check state transitions for audio.
          if (currentAudioBitrate < IDLE_AUDIO_BITRATE_THRESHOLD) {
            if (audioIsPlaying !== false) {
              // logger.info(`[Monitor-Audio] Transitioning to idle (bitrate ${bitrate.toFixed(2)} bps).`);
              audioIsPlaying = false;
              statusMessage = statusMessage.replace(/\[Audio.*?\]/, "") + " [Audio Idle]";
            }
          } else {
            if (audioIsPlaying !== true) {
              // logger.info(`[Monitor-Audio] Transitioning to active (bitrate ${bitrate.toFixed(2)} bps).`);
              audioIsPlaying = true;
              statusMessage = statusMessage.replace(/\[Audio.*?\]/, "") + " [Audio Active]";
            }
          }
          updateConsoleBitrateLine();
        }
      });

    } catch (e) {
      // logger.error("[Monitor-Audio] Error getting stats:", e);
    }
  }, 500);
}


// =======================
// PeerConnection Setup and SDP Handling
// =======================
function onStreamEvent(messageEvent: MessageEvent) {
  if (pcDataChannel && pcDataChannel.readyState === 'open') {
    const [event, _] = messageEvent.data.split(':');
    let status = '';
    switch (event) {
      case 'stream/started':
        status = 'started';
        break;
      case 'stream/done':
        status = 'done';
        break;
      case 'stream/ready':
        status = 'ready';
        break;
      case 'stream/error':
        status = 'error';
        break;
      default:
        status = 'dont-care';
        break;
    }
    if (status === 'ready') {
      setTimeout(() => {
        logger.info('stream/ready received from data channel');
        isStreamReady = true;
      }, 1000);
    } else {
      logger.info(`Received data channel event: ${status}`);
    }
  }
}

async function createPeerConnection(ctx: JobContext, offer: RTCSessionDescriptionInit, iceServers: any): Promise<RTCSessionDescriptionInit> {
  if (!peerConnection) {
    logger.debug("[D-ID] Creating new RTCPeerConnection with ICE servers.");
    peerConnection = new RTCPeerConnection({ iceServers });
    
    // Data channel for warmup events
    pcDataChannel = peerConnection.createDataChannel('JanusDataChannel');
    pcDataChannel.onmessage = (event) => {
      onStreamEvent(event);
      // Attempt JSON parsing for structured messages
      try {
        const messageData = typeof event.data === "string"
          ? JSON.parse(event.data)
          : JSON.parse(new TextDecoder().decode(new Uint8Array(event.data)));
        logger.info("[D-ID] Received data channel JSON message.");
      } catch (err) {
        logger.info("[D-ID] Received data channel text message:", event.data);
      }
    };
        
    // ICE candidate handling
    peerConnection.onicecandidate = (event) => {
      if (ws) {
        if (event.candidate) {
          const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
          sendDIDMessage(ws, {
            type: 'ice',
            payload: { session_id: sessionId, candidate, sdpMid, sdpMLineIndex },
          });
        } else {
          sendDIDMessage(ws, {
            type: 'ice',
            payload: { session_id: sessionId, candidate: null, stream_id: streamId, presenter_type: PRESENTER_TYPE },
          });
        }
      }
    };

    // Remote track handling for audio and video
    peerConnection.ontrack = async (event: RTCTrackEvent) => {
      if (event.track.kind === 'audio') {
        logger.debug(`[D-ID] Audio track received: ${event.track.id}`);
        try {
          

          let sampleRate = 48000, channelCount = 1;
          if (typeof event.track.getSettings === "function") {
            const settings = event.track.getSettings();
            sampleRate = settings.sampleRate || sampleRate;
            channelCount = settings.channelCount || channelCount;
          }
          logger.debug(`[RTC] Using audio settings: sampleRate=${sampleRate}, channelCount=${channelCount}`);
          
          const livekitAudioSource = new AudioSource(sampleRate, channelCount);
          const localAudioTrack = LocalAudioTrack.createAudioTrack('did-audio', livekitAudioSource);
          const audioSink = new RTCAudioSink(event.track);
          logger.debug(`[RTC] Created RTCAudioSink for track: ${event.track.id}`);
          
          let canLogMismatch = true;
          const mismatchLogThrottleMs = 5000;
          let lastCaptureLogTime = 0;
          const captureLogThrottleMs = 5000;
          
          audioSink.ondata = (data) => {
            try {
              if (data.sampleRate !== sampleRate || data.channelCount !== channelCount) {
                if (canLogMismatch) {
                  logger.debug(`[Audio Config Mismatch] Expected sampleRate=${sampleRate}, channelCount=${channelCount} but received sampleRate=${data.sampleRate}, channelCount=${data.channelCount}. Skipping frame.`);
                  canLogMismatch = false;
                  setTimeout(() => { canLogMismatch = true; }, mismatchLogThrottleMs);
                }
                return;
              }
              if (currentAudioBitrate < IDLE_AUDIO_BITRATE_THRESHOLD) {
                logger.debug("[Guard] Skipping audio frame due to low bitrate.");
                return;
              }
          
              const audioFrame = new AudioFrame(
                data.samples,
                data.sampleRate,
                data.channelCount,
                data.numberOfFrames
              );
              livekitAudioSource.captureFrame(audioFrame);
              if (Date.now() - lastCaptureLogTime > captureLogThrottleMs) {
                logger.debug("[LiveKit] Captured audio frame.");
                lastCaptureLogTime = Date.now();
              }
            } catch (err) {
              logger.error("Error during audio frame processing:", err);
            }
          };
          monitorAudioTrack(event);
          const audioActive = await waitForTrackBitrate('audio', IDLE_AUDIO_BITRATE_THRESHOLD, 1000);
          if (!audioActive) {
            logger.info("[LiveKit] audio track bitrate did not reach threshold; skipping publish.");
            return;
          }
          event.track.onended = () => {
            logger.info("[RTC] Audio track ended. Stopping RTCAudioSink.");
            audioSink.stop();
          };
        
          const publishOptions = new TrackPublishOptions();
          publishOptions.source = TrackSource.SOURCE_MICROPHONE;
          if (ctx.room && ctx.room.localParticipant) {
            const publication = await ctx.room.localParticipant.publishTrack(localAudioTrack, publishOptions);
            logger.info(`[LiveKit] Published audio track: ${publication.sid || "Unknown SID"}`);
          }
        } catch (err) {
          logger.error("[LiveKit] Error publishing audio track:", err);
        }
      } else if (event.track.kind === 'video') {
        logger.debug(`[D-ID] Video track received: ${event.track.id}`);
        const settings = event.track.getSettings();
        const width = settings.width || 480;
        const height = settings.height || 480;
        logger.info(`[D-ID] Video resolution: ${width}x${height}`);
        
        const ready = await waitForVideoOrStreamReady(5000);
        if (!ready) {
          logger.info("[D-ID] Video track not ready within timeout; skipping publish.");
          return;
        }

        try {
          const livekitVideoSource = new VideoSource(width, height);
          const localVideoTrack = LocalVideoTrack.createVideoTrack("did-video", livekitVideoSource);
          const videoSink = new RTCVideoSink(event.track);
          logger.debug(`[RTC] Created RTCVideoSink for track: ${event.track.id}`);
          
          let lastVideoReceivedLogTime = 0;
          let lastVideoCaptureLogTime = 0;
          const videoLogThrottleMs = 5000;
          
          videoSink.onframe = ({ frame: rtcFrame }) => {
            try {
              const now = Date.now();
              if (now - lastVideoReceivedLogTime > videoLogThrottleMs) {
                logger.debug(`[RTC] Received frame: ${rtcFrame.width}x${rtcFrame.height}, rotation: ${rtcFrame.rotation}`);
                lastVideoReceivedLogTime = now;
              }
              if (currentVideoBitrate < IDLE_BITRATE_THRESHOLD) {
                // Skip forwarding frame if below threshold.
                logger.info("[Guard] Skipping video frame due to low bitrate.");
                return;
              }
          
              const frameData = new Uint8Array(rtcFrame.data.buffer);
              const livekitFrame = new VideoFrame(
                frameData,
                rtcFrame.width,
                rtcFrame.height,
                VideoBufferType.I420
              );
              livekitVideoSource.captureFrame(livekitFrame);
              if (now - lastVideoCaptureLogTime > videoLogThrottleMs) {
                logger.debug("[LiveKit] Captured video frame.");
                lastVideoCaptureLogTime = now;
              }
            } catch (err) {
              logger.error("Error during frame processing:", err);
            }
          };
          const videoActive = await waitForTrackBitrate('video', IDLE_BITRATE_THRESHOLD, 5000);
          if (!videoActive) {
            logger.info("[LiveKit] Video track bitrate did not reach threshold; skipping publish.");
            return;
          }
          monitorVideoTrack(event);
  
          event.track.onended = () => videoSink.stop();
          
          const options = new TrackPublishOptions();
          options.source = TrackSource.SOURCE_CAMERA;
          if (ctx.room && ctx.room.localParticipant) {
            const publication = await ctx.room.localParticipant.publishTrack(localVideoTrack, options);
            logger.info(`[LiveKit] Published video track: ${publication.sid || "Unknown SID"}`);
          }
        } catch (err) {
          logger.error("[LiveKit] Error publishing video track:", err);
        }
      }
    };

    logger.debug("[D-ID] Remote SDP offer received.");
    try {
      await peerConnection.setRemoteDescription(offer);
      logger.debug("[D-ID] Remote SDP set.");
    } catch (error) {
      logger.error("[D-ID] Error setting remote description:", error);
      throw error;
    }
    
    let sessionClientAnswer: RTCSessionDescriptionInit;
    try {
      sessionClientAnswer = await peerConnection.createAnswer();
      logger.debug("[D-ID] Local SDP answer created.");
    } catch (error) {
      logger.error("[D-ID] Error creating SDP answer:", error);
      throw error;
    }
    
    if (!sessionClientAnswer.sdp) {
      throw new Error("SDP is undefined");
    }
    const sdpObj = sdpTransform.parse(sessionClientAnswer.sdp);
    const videoMedia = sdpObj.media.find((m) => m.type === "video");
    if (videoMedia && (!videoMedia.payloads || videoMedia.payloads.toString().trim() === "0")) {
      logger.info("[D-ID] Video m-section empty. Applying fallback.");
      videoMedia.payloads = "100 101";
      videoMedia.direction = "recvonly";
      if (!videoMedia.rtp || videoMedia.rtp.length === 0) {
        videoMedia.rtp = [
          { payload: 100, codec: "VP8", rate: 90000 },
          { payload: 101, codec: "rtx", rate: 90000 },
        ];
      }
      if (!videoMedia.fmtp || videoMedia.fmtp.length === 0) {
        videoMedia.fmtp = [{ payload: 101, config: "apt=100" }];
      }
      if (!videoMedia.rtcpFb || videoMedia.rtcpFb.length === 0) {
        videoMedia.rtcpFb = [
          { payload: 100, type: "nack" },
          { payload: 100, type: "nack", subtype: "pli" },
          { payload: 100, type: "goog-remb" },
        ];
      }
      sessionClientAnswer.sdp = sdpTransform.write(sdpObj);
      logger.debug("[D-ID] Modified SDP answer.");
    } else {
      logger.debug("[D-ID] Video m-section valid.");
    }
    
    logger.debug("[D-ID] Setting local SDP answer...");
    try {
      await peerConnection.setLocalDescription(sessionClientAnswer);
      logger.debug("[D-ID] Local SDP set successfully.");
    } catch (error) {
      logger.error("[D-ID] Error setting local SDP answer:", error);
      throw error;
    }
    
    return sessionClientAnswer;
}}

// =======================
// Pinecone Retrieval Function
// =======================
async function getRetrievedContext(queryText: string): Promise<string> {
  let vector: number[] = [];
  try {
    const pc = new Pinecone();
    const embedResponse = await pc.inference.embed(MODEL_NAME, [queryText], {
      inputType: "query",
      truncate: "END",
    });
    const denseEmbedding = embedResponse.data[0] as { values: number[] };
    vector = denseEmbedding.values;
    logger.debug("[Pinecone] Generated query vector.");
  } catch (err) {
    logger.error("[Pinecone] Error generating embedding:", err);
  }
  let retrievedContext = "RELEVANT CONTEXT:\n";
  try {
    const pc = new Pinecone();
    const index = pc.index(INDEX_NAME).namespace(NAMESPACE);
    const queryResponse = await index.query({
      topK: 4,
      vector,
      includeMetadata: true,
    });
    if (queryResponse.matches?.length) {
      queryResponse.matches.forEach((match: any) => {
        const snippet = match.metadata?.text || "No text found.";
        retrievedContext += `- ${snippet}\n`;
      });
    } else {
      retrievedContext += "- No relevant docs found.\n";
    }
    logger.debug("[Pinecone] Query completed.");
  } catch (err) {
    logger.error("[Pinecone] Error querying index:", err);
  }
  return retrievedContext;
}

// =======================
// Define the Agent
// =======================
export default defineAgent({
  prewarm: async (proc) => {
    logger.info("[Agent] Prewarming: loading silero VAD...");
    proc.userData.vad = await silero.VAD.load();
    logger.info("[Agent] VAD loaded.");
  },
  entry: async (ctx: JobContext) => {
    const chatMessages: string[] = [];
    pineconePingLoop();

    // --- D-ID Initialization ---
    try {
      logger.info("[D-ID] Initializing connection...");
      ws = await connectToDIDWebSocket(DID_API.websocketUrl, DID_API.key);
      logger.info("[D-ID] WebSocket connected.");
      const startStreamMessage = {
        type: 'init-stream',
        payload: {
          source_url: 'https://create-images-results.d-id.com/google-oauth2%7C109397608805989527240/upl_d_XeAnLU7uXD4SJxQ644Z/image.png',
          presenter_type: PRESENTER_TYPE,
          stream_warmup: true,
          output_resolution: 512,
          compatibility_mode: "on", // force VP8 codec
        },
      };
      sendDIDMessage(ws, startStreamMessage);
      logger.info("[D-ID] Sent init-stream message.");

      ws.onmessage = async (event) => {
        logger.info("[D-ID] Received WebSocket message.");
        let dataStr = "";
        if (typeof event.data === "string") {
          dataStr = event.data;
        } else if (event.data instanceof Buffer) {
          dataStr = event.data.toString();
        } else {
          try {
            dataStr = new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer));
          } catch (err) {
            logger.error("[D-ID] Error decoding WebSocket message data:", err);
            return;
          }
        }
        if (!dataStr.trim()) {
          logger.info("[D-ID] Received empty WebSocket message; skipping.");
          return;
        }
        let data: any;
        try {
          data = JSON.parse(dataStr);
        } catch (err) {
          logger.error("[D-ID] Error parsing WebSocket message:", err, dataStr);
          return;
        }
        logger.debug("[D-ID] Processed WebSocket message.");
        if (data.messageType === "ice" && data.message === "Internal server error") {
          logger.error("[D-ID] ICE candidate error received.");
          return;
        }
        switch (data.messageType) {
          case 'init-stream': {
            const { id, offer, ice_servers, session_id } = data;
            streamId = id;
            sessionId = session_id;
            logger.info("[D-ID] init-stream response received.", JSON.stringify({ streamId, sessionId }));
            let waited = 0;
            const timeout = 5000;
            while (!isStreamReady && waited < timeout) {
              logger.debug("[Sequence] Waiting for D-ID stream signal; flag: " + isStreamReady);
              await new Promise(resolve => setTimeout(resolve, 200));
              waited += 200;
            }
            if (!isStreamReady) {
              logger.info("[Sequence] Stream signal not received after timeout; forcing readiness.");
              isStreamReady = true;
            }
            logger.info("[Sequence] Proceeding with SDP answer creation.");
            sessionClientAnswer = await createPeerConnection(ctx, offer, ice_servers);
            logger.info("[D-ID] Obtained SDP answer.");
            const sdpMessage = {
              type: 'sdp',
              payload: {
                answer: sessionClientAnswer,
                session_id: sessionId,
                presenter_type: PRESENTER_TYPE,
              },
            };
            sendDIDMessage(ws, sdpMessage);
            logger.info("[D-ID] Sent SDP answer message.");
            break;
          }
          case 'sdp':
            break;
          case 'delete-stream':
            logger.info("[D-ID] Received delete-stream message:", JSON.stringify(data));
            break;
          case 'ice':
            break;
          case 'error':
            logger.error("[D-ID] Received error message:", JSON.stringify(data));
            break;
          default:
            logger.debug("[D-ID] Unhandled message type:", JSON.stringify(data));
        }
      };
    } catch (error) {
      logger.error("[D-ID] Failed to initialize connection:", error);
    }
    // --- End D-ID Initialization ---

    // --- LiveKit Connection & Chat Setup ---
    let chatCtx = new llm.ChatContext();
    try {
      logger.info("[LiveKit] Connecting to room...");
      const systemPrompt =
        "You are a voice assistant created by Zinzino. Answer questions concisely using any relevant context.";
      chatCtx.append({ role: llm.ChatRole.SYSTEM, text: systemPrompt });
      
      await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
      logger.info("[LiveKit] Connected. Local participant:", ctx.room.localParticipant?.identity);
      
      const participant = await ctx.waitForParticipant();
      logger.info("[LiveKit] Remote participant joined:", participant.identity);
  
      ctx.room.on("dataReceived", (data: any) => {
        try {
          const jsonString = data instanceof Buffer
            ? data.toString()
            : new TextDecoder().decode(new Uint8Array(data as ArrayBuffer));
          const message = JSON.parse(jsonString);
          if (message.type === "user_message" && message.content) {
            logger.info("[LiveKit] Received user message:", message.content);
            chatMessages.push(message.content);
          }
        } catch (err) {
          logger.error("[LiveKit] Error parsing received data:", err);
        }
      });
    } catch (error) {
      logger.error("[LiveKit] Error during connection/setup:", error);
    }
    // --- End LiveKit Setup ---

    // --- Main Processing Loop ---
    try {
      while (true) {
        if (chatMessages.length === 0) {
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        }
        const messageStartTime = Date.now();
        const userMessage = chatMessages.shift();
        logger.info("[Loop] Processing user message:", userMessage);
        logger.logLatency("User Message Processing Start", messageStartTime);
  
        const contextStartTime = Date.now();
        const retrievedContext = await getRetrievedContext(userMessage!);
        logger.logLatency("Context Retrieval", contextStartTime);
  
        const contextCombinedStartTime = Date.now();
        const userMessageWithContext = `${userMessage}\n\nRelevant context:\n${retrievedContext}\nPlease answer concisely.`;
        chatCtx.append({ role: llm.ChatRole.USER, text: userMessageWithContext });
        logger.logLatency("Message Context Combination", contextCombinedStartTime);
  
        const llmStartTime = Date.now();
        let finalReply = "";
        try {
          const llmModel = new openai.LLM({ model: "gpt-4" });
          const session = llmModel.chat({ chatCtx });
          for await (const token of session) {
            const tokenText = token.choices?.[0]?.delta?.content;
            if (tokenText) {
              finalReply += tokenText;
              logger.debug("[LLM] Received token: " + tokenText);
            }
          }
          logger.info("[LLM] Final reply generated: " + finalReply);
        } catch (err) {
          logger.error("[LLM] Error invoking LLM:", err);
          finalReply = "An error occurred while processing your request.";
        }
        logger.logLatency("LLM Generation", llmStartTime);
  
        chatCtx.append({ role: llm.ChatRole.ASSISTANT, text: finalReply });
  
        const streamStartTime = Date.now();
        const words = finalReply.split(' ');
        words.push(''); // Signal end-of-stream.
        for (const [index, chunk] of words.entries()) {
          const streamMessage = {
            type: 'stream-text',
            payload: {
              script: {
                type: 'text',
                input: chunk,
                provider: { 
                  type: 'microsoft',
                  voice_id: 'lt-LT-LeonasNeural',
                  language: 'Lithuanian (Lithuania)',
                },
                ssml: false,
              },
              config: { stitch: true },
              background: { color: '#FFFFFF' },
              session_id: sessionId,
              stream_id: streamId,
              presenter_type: PRESENTER_TYPE,
            },
          };
          if (ws) {
            sendDIDMessage(ws, streamMessage);
            logger.debug("[D-ID] Sent stream-text chunk.");
            if (index === 0) {
              logger.logLatency("D-ID Stream Start", streamStartTime);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        logger.info("[D-ID] Completed sending stream-text messages.");
      }
    } catch (error) {
      logger.error("[Loop] Error in main processing loop:", error);
    }
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
