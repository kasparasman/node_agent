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
import { VideoFrame, VideoBufferType, TrackPublishOptions } from '@livekit/rtc-node';

import { LocalVideoTrack, VideoStream, Track, VideoSource, TrackSource, AudioFrame, AudioSource, LocalAudioTrack } from '@livekit/rtc-node';
//@ts-ignore
import pkg from '@roamhq/wrtc';
const { RTCPeerConnection, MediaStream, RTCRtpSender } = pkg;
const { RTCVideoSink, RTCAudioSink } = pkg.nonstandard;

import WebSocket from "ws";
import sdpTransform from 'sdp-transform';
import fs from 'fs'; // Added for latency logging

// ====================================================
// Latency Logging Setup
// ====================================================
// Create (or append to) a log file in the same directory.
async function pineconePingLoop() {
  while (true) {
    try {
      const pingQuery = "zinzino"; // Adjust the query if needed
      const context = await getRetrievedContext(pingQuery);
      console.info("[Pinecone Ping] Successfully retrieved context:", context);
    } catch (error) {
      console.error("[Pinecone Ping] Error during ping:", error);
    }
    // Wait for 60 seconds before the next ping
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

const latencyLogStream = fs.createWriteStream('latency.log', { flags: 'a' });
function logLatency(step, startTime) {
  const latency = Date.now() - startTime;
  const logEntry = `[Latency] ${step}: ${latency} ms at ${new Date().toISOString()}\n`;
  latencyLogStream.write(logEntry);
  console.info(logEntry.trim());
}

async function waitForVideoOrStreamReady(timeout = 5000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (videoIsPlaying || isStreamReady) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

dotenv.config();
// ====================================================
// MediaStreamTrackVideoSource Adapter for D-ID
// ====================================================

// ====================================================
// Configuration: Pinecone & D-ID
// ====================================================

const INDEX_NAME = "chatbot";
const NAMESPACE = "zinzino";
const MODEL_NAME = "multilingual-e5-large";
const EMBED_DIM = 1024;

const DID_API = {
  key: process.env.DID_API_KEY!,  // non-null assertion
  service: "talks", // or 'clips'
  websocketUrl: process.env.DID_WEBSOCKET_URL!,  // non-null assertion
};
const PRESENTER_TYPE = DID_API.service === 'clips' ? 'clip' : 'talk';
console.log(DID_API.key, DID_API.websocketUrl);

// Global state for D-ID connection/stream negotiation
let ws: WebSocket | null = null;
let peerConnection: RTCPeerConnection | null = null;
let pcDataChannel: RTCDataChannel | null = null;
let streamId = "";
let sessionId = "";
let sessionClientAnswer: RTCSessionDescriptionInit | null = null;
let isStreamReady = false;
const streamWarmup = true;
isStreamReady = streamWarmup ? false : true;

// For monitoring video track activity
let statsIntervalId: NodeJS.Timeout;
let videoIsPlaying = false;
let lastBytesReceived = 0;

// ====================================================
// D-ID WebSocket Helpers
// ====================================================

async function connectToDIDWebSocket(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = `${url}?authorization=Basic ${encodeURIComponent(token)}`;
    const socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      console.debug("[D-ID] WebSocket connection opened.");
      resolve(socket);
    };
    socket.onerror = (err) => {
      console.error("[D-ID] WebSocket error:", err);
      reject(err);
    };
    socket.onclose = () => {
      console.debug("[D-ID] WebSocket connection closed.");
    };
  });
}

function sendDIDMessage(ws: WebSocket, message: any) {
  if (ws.readyState === ws.OPEN) {
    const json = JSON.stringify(message);
    console.debug("[D-ID] Sending message:", json);
    ws.send(json);
  } else {
    console.error("[D-ID] WebSocket not open. Cannot send message.");
  }
}

// ====================================================
// Video Track Monitoring
// ====================================================

function monitorVideoTrack(event: RTCTrackEvent) {
  if (!event.track) return;
  statsIntervalId = setInterval(async () => {
    try {
      const stats = await peerConnection!.getStats(event.track);
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          if (report.bytesReceived > lastBytesReceived) {
            if (!videoIsPlaying) {
              console.debug("[Monitor] Video has started playing. Bytes received:", report.bytesReceived);
            }
            videoIsPlaying = true;
          } else {
            videoIsPlaying = false;
          }
          lastBytesReceived = report.bytesReceived;
        }
      });
    } catch (e) {
      console.error("[Monitor] Error getting stats:", e);
    }
  }, 500);
}

// ====================================================
// Create RTCPeerConnection with Dummy Track & Warmup Handling
// ====================================================
function onStreamEvent(messageEvent: MessageEvent) {
  if (pcDataChannel && pcDataChannel.readyState === 'open') {
    let status: string;
    // Split the incoming message (expected format: "event:payload")
    const [event, _] = messageEvent.data.split(':');

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

    // When we receive 'stream/ready', set isStreamReady after a slight delay
    if (status === 'ready') {
      setTimeout(() => {
        console.log('stream/ready received from data channel');
        isStreamReady = true;
        // Optionally update your UI element
      }, 1000);
    } else {
      console.log(`Received data channel event: ${status}`);
    }
  }
}

async function createPeerConnection(ctx: JobContext, offer: RTCSessionDescriptionInit, iceServers: any): Promise<RTCSessionDescriptionInit> {

  if (!peerConnection) {
    console.debug("[D-ID] Creating new RTCPeerConnection with ICE servers:", iceServers);
    peerConnection = new RTCPeerConnection({ iceServers });
    
    // Create data channel to receive warmup events.
    pcDataChannel = peerConnection.createDataChannel('JanusDataChannel');
    pcDataChannel.onmessage = (event) => {
      onStreamEvent(event);

      let messageData;
      if (typeof event.data === "string") {
        // Try to parse JSON, but if it fails, fallback to treating it as plain text.
        try {
          messageData = JSON.parse(event.data);
          console.info("[D-ID] Received data channel JSON message:", messageData);
        } catch (err) {
          // Not JSON; handle it as plain text.
          console.info("[D-ID] Received data channel text message:", event.data);
          messageData = event.data;
        }
      } else {
        // If not a string, try decoding it.
        try {
          messageData = new TextDecoder().decode(new Uint8Array(event.data));
          try {
            messageData = JSON.parse(messageData);
            console.info("[D-ID] Received data channel JSON message:", messageData);
          } catch (err) {
            console.info("[D-ID] Received data channel text message:", messageData);
          }
        } catch (err) {
          console.error("[D-ID] Error decoding data channel message:", err);
        }
      }
    };
        
    // Forward ICE candidates.
    peerConnection.onicecandidate = (event) => {
      if (ws) {
        if (event.candidate) {
          const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
          sendDIDMessage(ws, {
            type: 'ice',
            payload: {
              session_id: sessionId,
              candidate,       // the candidate string
              sdpMid,
              sdpMLineIndex,
            },
          });
        } else {
          // Explicitly signal end-of-candidates by sending candidate: null.
          sendDIDMessage(ws, {
            type: 'ice',
            payload: {
              session_id: sessionId,
              candidate: null,  // Explicitly send null
              stream_id: streamId,    // if required by the server
              presenter_type: PRESENTER_TYPE,
            },
          });
        }
      }
    };
    

    // When remote tracks arrive…
    peerConnection.ontrack = async (event: RTCTrackEvent) => {
      if (event.track.kind === 'audio') {
        console.debug("[D-ID] ontrack event received for audio track:", event.track.id);
        
        try {
          // Default to values we expect from D-ID (from SDP, we assume opus/48000/2 for the main stream)
          // However, if the warmup phase uses different settings, we detect that.
          let sampleRate = 48000, channelCount = 1;
          if (typeof event.track.getSettings === "function") {
            const settings = event.track.getSettings();
            if (settings.sampleRate) {
              sampleRate = settings.sampleRate;
            }
            if (settings.channelCount) {
              channelCount = settings.channelCount;
            }
          }
          console.debug(`[RTC] Using audio settings for AudioSource: sampleRate=${sampleRate}, channelCount=${channelCount}`);
          
          // Create the LiveKit AudioSource with the detected configuration.
          const livekitAudioSource = new AudioSource(sampleRate, channelCount);
          const localAudioTrack = LocalAudioTrack.createAudioTrack('did-audio', livekitAudioSource);
          
          // Create an RTCAudioSink on the incoming remote audio track.
          const audioSink = new RTCAudioSink(event.track);
          console.debug("[RTC] RTCAudioSink created for audio track:", event.track.id);
          
          // Variables for throttling mismatch logs.
          let canLogMismatch = true;
          const mismatchLogThrottleMs = 5000; // Log mismatch once every 5 seconds

          let lastCaptureLogTime = 0;
          const captureLogThrottleMs = 5000; // Log capture once every 5 seconds

          audioSink.ondata = (data) => {
            try {
              // Check if the incoming data matches our expected configuration.
              if (data.sampleRate !== sampleRate || data.channelCount !== channelCount) {
                if (canLogMismatch) {
                  console.warn(
                    `[Audio Config Mismatch] Expected sampleRate=${sampleRate}, channelCount=${channelCount} but received sampleRate=${data.sampleRate}, channelCount=${data.channelCount}. Skipping frame.`
                  );
                  canLogMismatch = false;
                  setTimeout(() => {
                    canLogMismatch = true;
                  }, mismatchLogThrottleMs);
                }
                return; // Skip processing this frame.
              }
              
              // Create an AudioFrame from the incoming data.
              const audioFrame = new AudioFrame(
                data.samples,
                data.sampleRate,
                data.channelCount,
                data.numberOfFrames
              );
              
              // Forward the frame to LiveKit's AudioSource.
              livekitAudioSource.captureFrame(audioFrame);
              
              // Throttle the successful capture log.
              const now = Date.now();
              if (now - lastCaptureLogTime > captureLogThrottleMs) {
                console.debug("[LiveKit] Captured audio frame into AudioSource.");
                lastCaptureLogTime = now;
              }
            } catch (err) {
              console.error("Error during audio frame processing:", err);
            }
          };
          
          // Clean up the sink when the audio track ends.
          event.track.onended = () => {
            console.info("[RTC] Audio track ended. Stopping RTCAudioSink.");
            audioSink.stop();
          };
          
          // Publish the local audio track to the LiveKit room.
          const publishOptions = new TrackPublishOptions();
          publishOptions.source = TrackSource.SOURCE_MICROPHONE;
          if (ctx.room && ctx.room.localParticipant) {
            const publication = await ctx.room.localParticipant.publishTrack(localAudioTrack, publishOptions);
            console.info("[LiveKit] Published audio track:", publication.sid || "Unknown SID");
          }
          
        } catch (err) {
          console.error("[LiveKit] Error publishing audio track:", err);
        }
      }
      
      if (event.track.kind === 'video') {
        console.debug("[D-ID] ontrack event received for video track:", event.track.id);
        const settings = event.track.getSettings();
        const width = settings.width || 480;  // Default to 640 if unavailable
        const height = settings.height || 640; // Default to 480 if unavailable
        console.log(`[D-ID] Received video resolution: ${width}x${height}`);

        // Wait for the video stream to be ready.
        const ready = await waitForVideoOrStreamReady(5000);
        if (!ready) {
          console.info("[D-ID] Video track not ready within timeout; skipping publish.");
          return;
        }
        
        try {
          // Create a VideoSource and a LocalVideoTrack via FFI.
          const livekitVideoSource = new VideoSource(width, height);
          const localVideoTrack = LocalVideoTrack.createVideoTrack("did-video", livekitVideoSource);
          
          const videoSink = new RTCVideoSink(event.track);
          console.debug("[RTC] RTCVideoSink created for track:", event.track.id);
          let lastVideoReceivedLogTime = 0;
          let lastVideoCaptureLogTime = 0;
          const videoLogThrottleMs = 5000; // Log at most once every 5 seconds

          videoSink.onframe = ({ frame: rtcFrame }) => {
            try {
              const now = Date.now();

              // Throttle "received frame" log.
              if (now - lastVideoReceivedLogTime > videoLogThrottleMs) {
                console.debug(`[RTC] Received frame: ${rtcFrame.width}x${rtcFrame.height}, rotation: ${rtcFrame.rotation}`);
                lastVideoReceivedLogTime = now;
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
                console.debug("[LiveKit] Captured frame into VideoSource.");
                lastVideoCaptureLogTime = now;
              }
          
            } catch (err) {
              console.error("Error during frame processing:", err);
            }
          };
          
          event.track.onended = () => {
            videoSink.stop();
          };
          const options = new TrackPublishOptions();
          options.source = TrackSource.SOURCE_CAMERA;

          // Publish the track.
          if (ctx.room && ctx.room.localParticipant) {
            const publication = await ctx.room.localParticipant.publishTrack(localVideoTrack, options);
            console.info("[LiveKit] Published track:", publication.sid || "Unknown SID");
          }
        } catch (err) {
          console.error("[LiveKit] Error publishing video track:", err);
        }
      }
    };

    console.debug("[D-ID] Remote SDP offer received:\n", offer.sdp);
    try {
      await peerConnection.setRemoteDescription(offer);
      console.debug("[D-ID] Remote SDP set.");
    } catch (error) {
      console.error("[D-ID] Error setting remote description:", error);
      throw error;
    }
    
    // Create SDP answer.
    let sessionClientAnswer: RTCSessionDescriptionInit;
    try {
      sessionClientAnswer = await peerConnection.createAnswer();
      console.debug("[D-ID] Local SDP answer created:\n", sessionClientAnswer.sdp);
    } catch (error) {
      console.error("[D-ID] Error creating SDP answer:", error);
      throw error;
    }
    
    // --- SDP Modification using sdp-transform (if needed) ---
    if (!sessionClientAnswer.sdp) {
      throw new Error("SDP is undefined");
    }
    const sdpObj = sdpTransform.parse(sessionClientAnswer.sdp);
    const videoMedia = sdpObj.media.find((m) => m.type === "video");
    if (videoMedia && (!videoMedia.payloads || videoMedia.payloads.toString().trim() === "0")) {
      console.warn("[D-ID] Video m-section has an empty payload list. Applying fallback from remote offer.");
      videoMedia.payloads = "100 101";
      videoMedia.direction = "recvonly";
      if (!videoMedia.rtp || videoMedia.rtp.length === 0) {
        videoMedia.rtp = [
          { payload: 100, codec: "VP8", rate: 90000 },
          { payload: 101, codec: "rtx", rate: 90000 }
        ];
      }
      if (!videoMedia.fmtp || videoMedia.fmtp.length === 0) {
        videoMedia.fmtp = [
          { payload: 101, config: "apt=100" }
        ];
      }
      if (!videoMedia.rtcpFb || videoMedia.rtcpFb.length === 0) {
        videoMedia.rtcpFb = [
          { payload: 100, type: "nack" },
          { payload: 100, type: "nack", subtype: "pli" },
          { payload: 100, type: "goog-remb" }
        ];
      }
      sessionClientAnswer.sdp = sdpTransform.write(sdpObj);
      console.debug("[D-ID] Modified SDP answer:\n", sessionClientAnswer.sdp);
    } else {
      console.debug("[D-ID] Video m-section in SDP answer appears valid.");
    }
    
    console.debug("[D-ID] Attempting to set local description with SDP answer...");
    try {
      await peerConnection.setLocalDescription(sessionClientAnswer);
      console.debug("[D-ID] Local SDP set successfully.");
    } catch (error) {
      console.error("[D-ID] Error setting local SDP answer:", error);
      throw error;
    }
    
    return sessionClientAnswer;
}}

// ====================================================
// Pinecone Retrieval Function
// ====================================================

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
    console.debug("[Pinecone] Generated query vector.");
  } catch (err) {
    console.error("[Pinecone] Error generating embedding:", err);
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
    console.debug("[Pinecone] Query completed.");
  } catch (err) {
    console.error("[Pinecone] Error querying index:", err);
  }
  return retrievedContext;
}

// ====================================================
// Define the Agent
// ====================================================

export default defineAgent({
  prewarm: async (proc) => {
    console.info("[Agent] Prewarming: loading silero VAD...");
    proc.userData.vad = await silero.VAD.load();
    console.info("[Agent] VAD loaded.");
  },
  entry: async (ctx: JobContext) => {
    const chatMessages: string[] = [];
  pineconePingLoop();

    // --- D-ID Initialization ---
    try {
      console.info("[D-ID] Initializing connection...");
      ws = await connectToDIDWebSocket(DID_API.websocketUrl, DID_API.key);
      console.info("[D-ID] WebSocket connected.");
      const startStreamMessage = {
        type: 'init-stream',
        payload: {
          source_url: 'https://create-images-results.d-id.com/google-oauth2%7C109397608805989527240/upl_d_XeAnLU7uXD4SJxQ644Z/image.png',
          presenter_type: PRESENTER_TYPE,
          stream_warmup: true,
          output_resolution: 512,
          compatibility_mode: "on"  // force VP8 codec
        },
      };
      sendDIDMessage(ws!, startStreamMessage);
      console.info("[D-ID] Sent init-stream message.");
      
      ws!.onmessage = async (event) => {
        console.info("[D-ID] Received WebSocket message:", event.data);
        let dataStr: string = "";
        if (typeof event.data === "string") {
          dataStr = event.data;
        } else if (event.data instanceof Buffer) {
          dataStr = event.data.toString();
        } else {
          try {
            dataStr = new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer));
          } catch (err) {
            console.error("[D-ID] Error decoding WebSocket message data:", err);
            return;
          }
        }
        if (!dataStr.trim()) {
          console.warn("[D-ID] Received empty WebSocket message; skipping.");
          return;
        }
        let data: any;
        try {
          data = JSON.parse(dataStr);
        } catch (err) {
          console.error("[D-ID] Error parsing WebSocket message:", err, dataStr);
          return;
        }
        console.debug("[D-ID] Received WebSocket message:", data);
        if (data.messageType === "ice" && data.message && data.message === "Internal server error") {
          console.error("[D-ID] ICE candidate error received:", data);
          // Optionally, you could implement retry logic here or simply ignore it.
          return;
        }
      
        switch (data.messageType) {
          case 'init-stream': {
            const { id, offer, ice_servers, session_id } = data;
            streamId = id;
            sessionId = session_id;
            console.info("[D-ID] init-stream response received:", { streamId, sessionId });
            // Wait for warmup event with a 5-second timeout.
            let waited = 0;
            const timeout = 5000;
            while (!isStreamReady && waited < timeout) {
              console.debug("[Sequence] Waiting for D-ID real stream signal; flag:", isStreamReady);
              await new Promise(resolve => setTimeout(resolve, 200));
              waited += 200;
            }
            if (!isStreamReady) {
              console.warn("[Sequence] Real stream signal not received after timeout; forcing readiness.");
              isStreamReady = true;
            }
            console.info("[Sequence] Proceeding with SDP answer creation.");
            sessionClientAnswer = await createPeerConnection(ctx, offer, ice_servers);
            console.info("[D-ID] Obtained SDP answer:", sessionClientAnswer);
            const sdpMessage = {
              type: 'sdp',
              payload: {
                answer: sessionClientAnswer,
                session_id: sessionId,
                presenter_type: PRESENTER_TYPE,
              },
            };
            sendDIDMessage(ws!, sdpMessage);
            console.info("[D-ID] Sent SDP answer message.");
            break;
          }
          case 'sdp':
            //console.info("[D-ID] Received SDP message:", data);
            break;
          case 'delete-stream':
            console.warn("[D-ID] Received delete-stream message:", data);
            break;
          case 'ice':
            // ICE candidate messages from D-ID—log them and ignore.
            //console.debug("[D-ID] Received ICE message:", data);
            break;
          case 'error':
            console.error("[D-ID] Received error message:", data);
            break;
          default:
            console.debug("[D-ID] Unhandled message type:", data);
        }
      };
    } catch (error) {
      console.error("[D-ID] Failed to initialize connection:", error);
    }
    // --- End D-ID Initialization ---
  
    // --- LiveKit Connection & Chat Setup ---
    let chatCtx = new llm.ChatContext();
    try {
      console.info("[LiveKit] Connecting to room...");
      const systemPrompt =
        "You are a voice assistant created by Zinzino. Answer questions concisely using any relevant context.";
      chatCtx.append({ role: llm.ChatRole.SYSTEM, text: systemPrompt });
      
      await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
      console.info("[LiveKit] Connected. Local participant:", ctx.room.localParticipant?.identity);
      
      const participant = await ctx.waitForParticipant();
      console.info("[LiveKit] Remote participant joined:", participant.identity);
  
      ctx.room.on("dataReceived", (data: any) => {
        try {
          const jsonString = (data instanceof Buffer ? data.toString() : new TextDecoder().decode(new Uint8Array(data as ArrayBuffer)));
          const message = JSON.parse(jsonString);
          if (message.type === "user_message" && message.content) {
            console.info("[LiveKit] Received user message:", message.content);
            chatMessages.push(message.content);
          }
        } catch (err) {
          console.error("[LiveKit] Error parsing received data:", err);
        }
      });
    } catch (error) {
      console.error("[LiveKit] Error during connection/setup:", error);
    }
    // --- End LiveKit Setup ---
  
    // --- Main Processing Loop ---
    try {
      while (true) {
        if (chatMessages.length === 0) {
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        }
        // Mark the start time for processing the user message
        const messageStartTime = Date.now();
        const userMessage = chatMessages.shift();
        console.info("[Loop] Processing user message:", userMessage);
        logLatency("User Message Processing Start", messageStartTime);
  
        // --- Context Retrieval ---
        const contextStartTime = Date.now();
        const retrievedContext = await getRetrievedContext(userMessage!);
        logLatency("Context Retrieval", contextStartTime);
  
        // Combine message with retrieved context
        const contextCombinedStartTime = Date.now();
        const userMessageWithContext = `${userMessage}\n\nRelevant context:\n${retrievedContext}\nPlease answer concisely.`;
        chatCtx.append({ role: llm.ChatRole.USER, text: userMessageWithContext });
        logLatency("Message Context Combination", contextCombinedStartTime);
  
        // --- LLM Generation ---
        const llmStartTime = Date.now();
        let finalReply = "";
        try {
          const llmModel = new openai.LLM({ model: "gpt-4" });
          const session = llmModel.chat({ chatCtx });
          for await (const token of session) {
            const tokenText = token.choices?.[0]?.delta?.content;
            if (tokenText) {
              finalReply += tokenText;
              console.debug("[LLM] Received token:", tokenText);
            }
          }
          console.info("[LLM] Final reply generated:", finalReply);
        } catch (err) {
          console.error("[LLM] Error invoking LLM:", err);
          finalReply = "An error occurred while processing your request.";
        }
        logLatency("LLM Generation", llmStartTime);
  
        chatCtx.append({ role: llm.ChatRole.ASSISTANT, text: finalReply });
  
        // --- D-ID Stream Initiation ---
        // Record the timestamp just before streaming out the response
        const streamStartTime = Date.now();
        const words = finalReply.split(' ');
        words.push(''); // Signal end of stream.
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
            console.debug("[D-ID] Sent stream-text chunk:", chunk);
            // Log the moment we send the very first chunk
            if (index === 0) {
              logLatency("D-ID Stream Start", streamStartTime);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        console.info("[D-ID] Completed sending stream-text messages.");
      }
    } catch (error) {
      console.error("[Loop] Error in main processing loop:", error);
    }
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
