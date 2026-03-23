/**
 * Schedule trigger handler -- fires a callback on a cron schedule.
 *
 * Uses node-cron for cron expression parsing and scheduling.
 */

import { schedule, type ScheduledTask } from 'node-cron';

export class ScheduleHandler {
  private task: ScheduledTask | null = null;

  constructor(
    private readonly expression: string,
    private readonly callback: () => void,
  ) {}

  start(): void {
    this.task = schedule(this.expression, () => {
      this.callback();
    }, { scheduled: true });
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
  }
}
