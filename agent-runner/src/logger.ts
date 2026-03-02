/**
 * Structured logger for the agent-runner.
 *
 * Logger interface with JSONLogger (stdout, one JSON object per line)
 * and NullLogger (no-op for tests).
 */

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export class JSONLogger implements Logger {
  private readonly baseFields: LogFields;

  constructor(component: string, fields?: LogFields) {
    this.baseFields = { component, ...fields };
  }

  debug(msg: string, fields?: LogFields): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.write('error', msg, fields);
  }

  child(fields: LogFields): Logger {
    return new JSONLogger(
      this.baseFields.component as string,
      { ...this.baseFields, ...fields },
    );
  }

  private write(level: string, msg: string, fields?: LogFields): void {
    const entry = {
      level,
      ts: new Date().toISOString(),
      ...this.baseFields,
      msg,
      ...fields,
    };
    process.stdout.write(JSON.stringify(entry) + '\n');
  }
}

export class NullLogger implements Logger {
  debug(): void { /* no-op */ }
  info(): void { /* no-op */ }
  warn(): void { /* no-op */ }
  error(): void { /* no-op */ }
  child(): Logger { return this; }
}
