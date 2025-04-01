import zmq from 'zeromq';
import { randomUUID } from 'crypto';
import { logger } from './logger.js';
function printFrames(label, frames) {
    logger.debug(`\n[${label}] Received ${frames.length} frame(s):`);
    frames.forEach((frame, i) => {
        const str = frame.toString('utf-8');
        const hex = frame.toString('hex');
        logger.debug(`  Frame ${i}: "${str}" (hex: ${hex})`);
    });
}
export async function initZmqDealer() {
    const routingId = randomUUID(); // Shared identity for both sockets
    const in_dealer = new zmq.Dealer({ routingId });
    const out_dealer = new zmq.Dealer({ routingId });
    const i = "ipc:///tmp/audio_input.ipc";
    const o = "ipc:///tmp/audio_output.ipc";
    await in_dealer.connect(i);
    await out_dealer.connect(o);
    logger.info(`[ZMQ] DEALER connected with unique ID ${routingId}`);
    await in_dealer.send([`HELLO`]);
    logger.debug("[ZMQ] sent hello through int");
    await out_dealer.send([`HELLO`]);
    logger.debug("[ZMQ] sent hello through out");
    const in_ack = await in_dealer.receive();
    logger.debug(`receiving through in ${in_ack}`);
    printFrames("IN_ACK", in_ack);
    const out_ack = await out_dealer.receive();
    logger.debug("receiving through out");
    printFrames("OUT_ACK", out_ack);
    const in_payload = in_ack[1]?.toString();
    const out_payload = out_ack[1]?.toString();
    logger.debug(`Parsed in_payload: ${in_payload}`);
    logger.debug(`Parsed out_payload: ${out_payload}`);
    if (in_payload !== "ACK" || out_payload !== "ACK") {
        throw new Error("Handshake failed – did not receive proper ACK");
    }
    logger.debug(`[ZMQ] Handshake successful for routing ID: ${routingId}`);
    return { in_dealer, out_dealer };
}
