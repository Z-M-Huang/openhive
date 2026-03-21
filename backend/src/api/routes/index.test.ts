/**
 * Smoke tests for API routes barrel module.
 *
 * Verifies registerRoutes mounts all route groups without errors.
 * Detailed route tests are in agent-routes.test.ts, container-routes.test.ts, etc.
 *
 * @module api/routes/index.test
 */

import { describe, it, expect } from 'vitest';
import { registerRoutes, type RouteContext } from './index.js';
import { MockFastify, createMockOrgChart, createMockContainerManager, createMockHealthMonitor, createMockTaskStore } from './__test-helpers.js';

describe('registerRoutes', () => {
  it('mounts all route groups without error', () => {
    const app = new MockFastify();
    const ctx: RouteContext = {
      orgChart: createMockOrgChart(),
      containerManager: createMockContainerManager(),
      healthMonitor: createMockHealthMonitor(),
      taskStore: createMockTaskStore(),
    };
    expect(() => {
      registerRoutes(app as unknown as Parameters<typeof registerRoutes>[0], ctx);
    }).not.toThrow();
  });
});
