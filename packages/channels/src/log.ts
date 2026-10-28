// Logging carries event IDs, the hashed handle and states. Message text,
// names and numbers must never reach a log line; tests assert that with
// sentinel text.

export type LogFieldValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogFieldValue>;

export type LogSink = (line: string) => void;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export function formatLogLine(level: string, event: string, fields: LogFields = {}): string {
  return JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
}

export function createLogger(sink: LogSink = console.log): Logger {
  return {
    info: (event, fields) => sink(formatLogLine("info", event, fields)),
    warn: (event, fields) => sink(formatLogLine("warn", event, fields)),
  };
}
