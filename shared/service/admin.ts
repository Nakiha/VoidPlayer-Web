// HTTP response contracts shared by the Node service and browser clients.
// Service return annotations enforce these shapes without importing host classes.
export type AdminStatus = {
    analysis: {
        concurrency: number;
        running: number;
        queued: number;
    };
    runtime: string;
    platform: string;
    uptimeSeconds: number;
    cpuPercent: number;
    logicalCpus: number;
    memory: {
        rss: number;
        heapUsed: number;
        systemTotal: number;
        systemFree: number;
    };
    dataDir: string;
    logsEnabled: boolean;
    library: {
        ready: boolean;
        scanning: boolean;
        job: null | {
            [key: string]: null | string | number | bigint | Uint8Array<ArrayBuffer>;
        };
        roots: ({
            [key: string]: null | string | number | bigint | Uint8Array<ArrayBuffer>;
        })[];
        watch: null | {
            active: number;
            limit: number;
            limited: boolean;
            unavailableRoots: (string)[];
        };
        queuedDirectories: number;
        errorDetailsTruncated: boolean;
    };
    version: string;
    revision: string;
};
export type RootConfiguration = {
    roots: ({
        id: string;
        path: string;
        name: string;
    })[];
    revision: null | string;
    writable: boolean;
    changedExternally: boolean;
    configFile: null | string;
    reasonCode: null | "external-change" | "cli-override" | "no-source" | "not-writable";
    reason: null | string;
};
export type LogPage = {
    entries: ({
        name: string;
        size: number;
        receivedAt: string;
        version: string;
    })[];
    next: null | string;
    enabled: boolean;
};
export type LogDocument = {
    name: string;
    version: string;
    document: unknown;
};
export type AnalysisSettings = {
    min: number;
    max: number;
    revision: null | string;
    writable: boolean;
    reasonCode: null | "external-change" | "cli-override" | "no-source" | "not-writable";
    concurrency: number;
    running: number;
    queued: number;
};
export type AnalysisResources = {
    concurrency: number;
    running: number;
    queued: number;
};
export type LibraryScanStatus = {
    ready: boolean;
    scanning: boolean;
    job: null | {
        [key: string]: null | string | number | bigint | Uint8Array<ArrayBuffer>;
    };
    roots: ({
        [key: string]: null | string | number | bigint | Uint8Array<ArrayBuffer>;
    })[];
    watch: null | {
        active: number;
        limit: number;
        limited: boolean;
        unavailableRoots: (string)[];
    };
    queuedDirectories: number;
    errorDetailsTruncated: boolean;
};
export type CacheOverview = {
    directory: string;
    volume: null | {
        totalBytes: number;
        availableBytes: number;
        usedBytes: number;
    };
    types: ({
        location: string;
        databaseBytes: number;
        journalBytes: number;
        shared: boolean;
        kind: "frame-indexes";
        name: string;
        count: number;
        bytes: number;
        limitBytes: number;
        table: string;
    } | {
        location: string;
        databaseBytes: number;
        journalBytes: number;
        shared: boolean;
        kind: "annotation-previews";
        name: string;
        count: number;
        bytes: number;
        limitBytes: number;
        table: string;
    } | {
        location: string;
        databaseBytes: number;
        journalBytes: number;
        shared: boolean;
        kind: "media-thumbnails";
        name: string;
        count: number;
        bytes: number;
        limitBytes: number;
        table: string;
    })[];
    bytes: number;
    count: number;
};
export type RootReasonCode = 'external-change' | 'cli-override' | 'no-source' | 'not-writable';
