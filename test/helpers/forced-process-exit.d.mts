import type { ChildProcess } from 'node:child_process';
export function assertForcedProcessExit(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): void;
