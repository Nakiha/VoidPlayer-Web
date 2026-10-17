export type CacheKind = 'frame-indexes' | 'annotation-previews' | 'media-thumbnails';
export type CacheEntry = {
    id: string;
    version: string;
    scope?: string;
    name: string;
    detail: string;
    nameCode?: 'frame-annotation';
    detailData?: {
        kind: 'frames';
        root: string;
        format: string;
        frames: number;
    } | {
        kind: 'thumbnail';
        root: string;
        width: number;
        height: number;
    } | {
        kind: 'annotation';
        space: string;
        text: string;
    };
    bytes: number;
    updatedAt: number;
    previewUrl?: string;
};
