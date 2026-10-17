export type SavedWorkspace = {
    id: string;
    name: string;
    owner: string;
    ownerName?: string;
    createdAt: string;
    updatedAt: string;
    updatedBy: string;
    revision: number;
    bytes: number;
    tracks: number;
    marks: number;
    space: string | null;
};
