// logger.ts
import fs from 'fs';
export class Logger {
    constructor(logFile) {
        this.fileStream = fs.createWriteStream(logFile, { flags: 'w' });
    }
    info(message) {
        process.stdout.write(`\r[INFO] ${message}`);
        this.fileStream.write(`[INFO] ${message}\n`);
    }
    error(message, err) {
        console.error(message, err);
        this.fileStream.write(`[ERROR] ${message} ${err ? JSON.stringify(err) : ''}\n`);
    }
    debug(message) {
        // For real-time logging, you might choose to write to stdout if desired.
        this.fileStream.write(`[DEBUG] ${message}\n`);
    }
    logLatency(step, startTime) {
        const latency = Date.now() - startTime;
        const logEntry = `[Latency] ${step}: ${latency} ms at ${new Date().toISOString()}`;
        this.info(logEntry);
    }
}
export const logger = new Logger('latency.log');
