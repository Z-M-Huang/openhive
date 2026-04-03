declare module 'node-cron' {
  interface ScheduledTask {
    start(): void;
    stop(): void;
    now(now?: string): void;
  }

  interface ScheduleOptions {
    scheduled?: boolean;
    timezone?: string;
  }

  function schedule(
    expression: string,
    func: () => void,
    options?: ScheduleOptions,
  ): ScheduledTask;

  function validate(expression: string): boolean;

  export default { schedule, validate };
  export { ScheduledTask, ScheduleOptions, schedule, validate };
}
