// didWebSocket.ts
import WebSocket from "ws";
import { logger } from "./logger.js";
export async function connectToDIDWebSocket(url, token) {
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
export function sendDIDMessage(ws, message) {
    if (ws.readyState === ws.OPEN) {
        const json = JSON.stringify(message);
        logger.debug("[D-ID] Sending message.");
        ws.send(json);
    }
    else {
        logger.error("[D-ID] WebSocket not open. Cannot send message.");
    }
}
