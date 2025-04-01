// logger.ts
import fs from 'fs';

export class Logger {
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
    // For real-time logging, you might choose to write to stdout if desired.
    this.fileStream.write(`[DEBUG] ${message}\n`);
  }
  logLatency(step: string, startTime: number) {
    const latency = Date.now() - startTime;
    const logEntry = `[Latency] ${step}: ${latency} ms at ${new Date().toISOString()}`;
    this.info(logEntry);
  }
}

export const logger = new Logger('latency.log');
