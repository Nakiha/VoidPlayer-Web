export type MeasurementKind = 'download' | 'upload' | 'storage' | 'concurrent';
export type MeasurementResult = {
    id: string;
    kind: MeasurementKind;
    owner: string;
    state: 'preparing' | 'running' | 'stopping' | 'completed' | 'cancelled' | 'failed';
    seconds: number;
    limitBytes: number;
    concurrency: number;
    startedAt: string;
    bytes: number;
    requests: number;
    errors: number;
    elapsedMs: number;
    activeRequests: number;
    errorCode?: 'measurement-failed';
    reason?: 'duration' | 'limit' | 'user' | 'client' | 'error' | 'shutdown';
    error?: string;
    media?: {
        id: string;
        name: string;
        root: string;
        size: number;
        version: string;
    };
    client?: {
        bytes: number;
        requests: number;
        elapsedMs: number;
    };
};
