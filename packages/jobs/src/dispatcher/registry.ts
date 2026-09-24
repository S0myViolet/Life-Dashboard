/**
 * The handlers the deployed dispatcher runs. Only real handlers are listed:
 * a kind without one is never claimed, and its schedule stays disabled in
 * JOB_SCHEDULE_DEFINITIONS (packages/core/src/jobs/schedules.ts). Later
 * milestones add their sync/AI/push handlers here.
 */
import { briefingJobHandlers } from '../briefings/handler.ts'
import { createJobHandlerRegistry, type JobHandlerRegistry } from './types.ts'

export function createDefaultJobHandlerRegistry(): JobHandlerRegistry {
  return createJobHandlerRegistry([...briefingJobHandlers])
}
