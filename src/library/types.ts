export interface CompanyFolder {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
}

export type LibraryKind = "image" | "video" | "carousel" | "logo" | "audio" | "workflow";

export type CompanyLibraryItem = {
    kind: LibraryKind;
    id: string;
    companyId?: string;
    title: string;
    detail: string;
    searchText?: string;
    date: number;
    status?: string;
    preview?: string;
    href?: string;
    audio?: string;
    carouselId?: string;
    workflowId?: string;
    runId?: string;
    videoPreview?: boolean;
};

export type CompanyLibraryPage = {
    page: number;
    pageSize: 15;
    total: number;
    totalPages: number;
};
