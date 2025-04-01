// agent.ts
import { AutoSubscribe, type JobContext, WorkerOptions, cli, defineAgent, llm } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { pineconePingLoop, waitForVideoOrStreamReady, waitForTrackBitrate } from './utils.js';
import { connectToDIDWebSocket, sendDIDMessage } from './did_ws.js';
import { monitorVideoTrack, monitorAudioTrack, currentVideoBitrate, currentAudioBitrate } from './monitor';
import { onStreamEvent, createPeerConnection } from './pc.js';
import { getRetrievedContext } from './pinecone.js';
import {initZmqDealer} from './zmq.js'
import { mediaEvents } from './emitter.js';
import { randomUUID } from 'crypto';
import zmq from 'zeromq'
import './audioVideoProcessor.js'; // force listener initialization first
import './audio_recv.js'
import './lk_audio.js'
import './lk_video.js'
import './videoProcessor.js'
import { startVideoRelay } from './livekit_aliver.js';

import { AudioSource, LocalAudioTrack, LocalVideoTrack, VideoSource, VideoBufferType} from '@livekit/rtc-node';
export interface BufferedVideoFrame {
  buffer: Uint8Array;
  width: number;
  height: number;
  format: VideoBufferType;
}


export interface SharedState {
    ws?: WebSocket;
    sessionId?: string;
    streamId?: string;
    peerConnection?: RTCPeerConnection;
    in_dealer?: zmq.Dealer;
    out_dealer?: zmq.Dealer;
    room?: Room; // <- Add this explicitly!,
    audioSource?: AudioSource;
    audioTrack?: LocalAudioTrack;
    audioSessionId?: string;
    audioTrackPublished?: boolean;
    videoSource?: VideoSource;
    videoTrack?: LocalVideoTrack;
    videoTrackPublished?: boolean;
    useDummyVideo: boolean; 
    latestFrame?: BufferedVideoFrame;
    videoFrameBuffer: BufferedVideoFrame[]; // Early-captured frames

  
  }
  
  export default defineAgent({
  prewarm: async (proc) => {
    logger.info("[Agent] Prewarming: loading silero VAD...");
    proc.userData = {
        vad: await silero.VAD.load(),
        shared: {} as SharedState,
      };
    },
  entry: async (ctx: JobContext) => {
    ctx.userData = ctx.userData || {};
    ctx.userData.shared = ctx.userData.shared || {} as SharedState;
    ctx.userData.shared.room = ctx.room; // <- Important to expose the LiveKit room!
    ctx.userData.shared.videoFrameBuffer = ctx.userData.shared.videoFrameBuffer || [];

    const { shared } = ctx.userData;  // now safe to destructure

    const chatMessages: string[] = [];
    pineconePingLoop();
    Object.assign(shared, await initZmqDealer());
    
    shared.ws = await connectToDIDWebSocket(process.env.DID_WEBSOCKET_URL!, process.env.DID_API_KEY!);
    logger.info("[D-ID] WebSocket connected.");
    const startStreamMessage = {
      type: 'init-stream',
      payload: {
        source_url: 'https://create-images-results.d-id.com/google-oauth2%7C109397608805989527240/upl_d_XeAnLU7uXD4SJxQ644Z/image.png',
        presenter_type: process.env.DID_SERVICE === 'clips' ? 'clip' : 'talk',
        stream_warmup: true,
        output_resolution: 512,
        compatibility_mode: "on",
      },
    };
    sendDIDMessage(shared.ws, startStreamMessage);
    logger.info("[D-ID] Sent init-stream message.");

    shared.ws.onmessage = async (event) => {
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
          // Optionally store id and session_id globally if needed.
          shared.sessionId = session_id;
          shared.streamId = id;
    
          shared.peerConnection = await createPeerConnection(shared, offer, ice_servers);
          logger.info("[D-ID] Obtained SDP answer.");
          const sdpMessage = {
            type: 'sdp',
            payload: {
              answer: shared.peerConnection.localDescription,
              session_id: shared.sessionId,
              presenter_type: process.env.DID_SERVICE === 'clips' ? 'clip' : 'talk',
            },
          };
          sendDIDMessage(shared.ws, sdpMessage);
          logger.info("[D-ID] Sent SDP answer message.");
          break;
        }
        case 'sdp':
          break;
        case 'delete-stream':
          data = JSON.stringify(data)
          logger.info(`[D-ID] Received delete-stream message: ${data}`);
          break;
        case 'ice':
          break;
        case 'error':
          data = JSON.stringify(data)
          logger.error(`[D-ID] Received error message: ${data}`);
          break;
        default:
          data = JSON.stringify(data)
          logger.debug(`[D-ID] Unhandled message type: ${data}`);
      }
    };

    // --- LiveKit Connection & Chat Setup ---
    const chatCtx = new llm.ChatContext();
    logger.info("[LiveKit] Connecting to room...");
    const systemPrompt = "You are a voice assistant created by Zinzino. Answer questions concisely using any relevant context.";
    chatCtx.append({ role: llm.ChatRole.SYSTEM, text: systemPrompt });
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    logger.info("[LiveKit] Connected. Local participant:", ctx.room.localParticipant?.identity);
    const participant = await Promise.race([
        ctx.waitForParticipant(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for participant")), 10000))
      ]);
      
    logger.info("[LiveKit] Remote participant joined:", participant.identity);
    await startVideoRelay(shared);

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

    // --- Main Processing Loop ---
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
            session_id: shared.sessionId,
            stream_id: shared.streamId,
            presenter_type: process.env.DID_SERVICE === 'clips' ? 'clip' : 'talk',
          },
        };
        if (shared.ws) {
          sendDIDMessage(shared.ws, streamMessage);
          logger.debug("[D-ID] Sent stream-text chunk.");
          if (index === 0) {
            logger.logLatency("D-ID Stream Start", streamStartTime);
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      logger.info("[D-ID] Completed sending stream-text messages.");
    }
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
