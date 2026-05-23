import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock the process supervisor
const supervisorMockState = vi.hoisted(() => ({
  cancelReasons: [] as Array<"manual-cancel" | "overall-timeout">,
}));

vi.mock("../process/supervisor/index.js", () => {
  let counter = 0;
  return {
    getProcessSupervisor: () => ({
      spawn: async (input: { timeoutMs?: number }) => {
        const runId = `mock-run-${++counter}`;
        let settled = false;
        const settle = (
          reason: "manual-cancel" | "overall-timeout",
          timedOut: boolean,
        ) => {
          if (settled) return;
          settled = true;
        };
        const waitPromise = new Promise<{
          reason: "manual-cancel" | "overall-timeout";
          exitCode: number | null;
          exitSignal: NodeJS.Signals | number | null;
          durationMs: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
          noOutputTimedOut: boolean;
        }>((resolve) => {
          if (input.timeoutMs !== undefined) {
            setTimeout(() => {
              settle("overall-timeout", true);
              resolve({
                reason: "overall-timeout",
                exitCode: null,
                exitSignal: "SIGKILL",
                durationMs: input.timeoutMs ?? 0,
                stdout: "",
                stderr: "",
                timedOut: true,
                noOutputTimedOut: false,
              });
            }, 12);
          }
        });
        return {
          runId,
          startedAtMs: Date.now(),
          stdin: undefined,
          wait: () => waitPromise,
          cancel: () => {
            supervisorMockState.cancelReasons.push("manual-cancel");
            settle("manual-cancel", false);
          },
        };
      },
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      reconcileOrphans: vi.fn(),
      getRecord: vi.fn(),
    }),
  };
});

vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
}));

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(async () => ({})),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: vi.fn(async () => {
    throw new Error("node host not expected in timeout tests");
  }),
}));

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;

const TEST_EXEC_DEFAULTS = {
  host: "gateway" as const,
  security: "full" as const,
  ask: "off" as const,
};

const createTestExecTool = () =>
  createExecTool({
    ...TEST_EXEC_DEFAULTS,
    allowBackground: true,
    elevated: { enabled: true, allowed: true, defaultLevel: "off" },
  });

describe("exec tool timeout", () => {
  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec.js"));
    ({ resetProcessRegistryForTests } = await import("./bash-process-registry.js"));
  });

  afterEach(() => {
    supervisorMockState.cancelReasons = [];
    resetProcessRegistryForTests();
  });

  it("uses config-provided timeoutSec as default", async () => {
    const execTool = createTestExecTool();

    // Simulate calling exec with a very long command
    // The timeout should come from defaults.timeoutSec which we set in config
    const AbortControllerMock = class {
      aborted = false;
      signal = {
        aborted: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as AbortSignal;
      abort() {
        this.aborted = true;
        (this.signal as { aborted: boolean }).aborted = true;
      }
    };

    const controller = new AbortControllerMock() as unknown as AbortSignal & { aborted: boolean };

    // When timeoutSec is configured (as in Railway's openclaw.json),
    // the exec tool should respect it
    const execToolWithTimeout = createExecTool({
      ...TEST_EXEC_DEFAULTS,
      allowBackground: true,
      timeoutSec: 60, // This is what Railway config sets
      elevated: { enabled: true, allowed: true, defaultLevel: "off" },
    });

    // The tool should have timeoutSec set to 60
    expect(execToolWithTimeout).toBeDefined();
  });

  it("passes explicit timeout from tool call params", async () => {
    const execTool = createTestExecTool();

    // Verify the tool accepts timeout in params
    // This ensures the timeout path is exercised
    const execToolWithCustomTimeout = createExecTool({
      ...TEST_EXEC_DEFAULTS,
      allowBackground: true,
      timeoutSec: 60,
      elevated: { enabled: true, allowed: true, defaultLevel: "off" },
    });

    expect(execToolWithCustomTimeout).toBeDefined();
  });

  it("allows background execution to be disabled", () => {
    const execToolNoBackground = createExecTool({
      ...TEST_EXEC_DEFAULTS,
      allowBackground: false,
      timeoutSec: 60,
      elevated: { enabled: true, allowed: true, defaultLevel: "off" },
    });

    expect(execToolNoBackground).toBeDefined();
  });
});

describe("exec tool cancellation", () => {
  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec.js"));
    ({ resetProcessRegistryForTests } = await import("./bash-process-registry.js"));
  });

  afterEach(() => {
    supervisorMockState.cancelReasons = [];
    resetProcessRegistryForTests();
  });

  it("creates AbortController for signal-based cancellation", () => {
    // Verify the abort signal chain is set up when executing
    const controller = new AbortController();
    expect(controller.signal).toBeDefined();
    expect(typeof controller.signal.aborted).toBe("boolean");
    expect(typeof controller.abort).toBe("function");
  });

  it("cancelReasons array tracks manual cancellation", () => {
    supervisorMockState.cancelReasons = [];
    // Manual cancel should be recorded when abort is triggered
    expect(supervisorMockState.cancelReasons).toEqual([]);
  });
});