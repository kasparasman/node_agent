// config.ts
import dotenv from 'dotenv';
dotenv.config();

export const INDEX_NAME = "chatbot";
export const NAMESPACE = "zinzino";
export const MODEL_NAME = "multilingual-e5-large";
export const EMBED_DIM = 1024;

export const DID_API = {
  key: process.env.DID_API_KEY!, // non-null assertion
  service: "talks", // or 'clips'
  websocketUrl: process.env.DID_WEBSOCKET_URL!, // non-null assertion
};

export const PRESENTER_TYPE = DID_API.service === 'clips' ? 'clip' : 'talk';

export const streamWarmup = true;
export let isStreamReady = streamWarmup ? false : true;

export const IDLE_BITRATE_THRESHOLD = 200; // adjust as needed
export const IDLE_AUDIO_BITRATE_THRESHOLD = 200;  // adjust as needed
