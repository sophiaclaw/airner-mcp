export declare function appendTask(task: {
    task_id: string;
    title: string;
    task_type: string;
    task_description: string;
    payout_usdc: number;
    workers_needed: number;
    deadline_hours: number;
    language: string;
    location?: string;
    job_url: string;
    created_by?: string;
}): Promise<void>;
export declare function updateTaskStatus(task_id: string, status: string, worker_id?: string, proof?: string): Promise<void>;
export declare function getTaskResults(task_id: string): Promise<Array<{
    worker_airtm_id: string;
    proof: string;
    submitted_at: string;
}>>;
export declare function getTaskFromSheet(task_id: string): Promise<any>;
//# sourceMappingURL=sheets.d.ts.map