"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendTask = appendTask;
exports.updateTaskStatus = updateTaskStatus;
exports.getTaskResults = getTaskResults;
exports.getTaskFromSheet = getTaskFromSheet;
const child_process_1 = require("child_process");
const SHEET_ID = '1inaRMstj81yN9J3MhTUzsu8R2GxlqwCNPOvgm_bKqbM';
const GWS = '/Users/clawbot/.npm-global/bin/gws';
async function appendTask(task) {
    const row = [
        task.task_id,
        task.title,
        task.task_type,
        task.task_description,
        task.payout_usdc,
        task.workers_needed,
        task.deadline_hours,
        task.language,
        'Open',
        new Date().toISOString(),
        task.job_url,
    ];
    const paramsObj = { spreadsheetId: SHEET_ID, range: 'Tasks!A:K', valueInputOption: 'USER_ENTERED' };
    const jsonObj = { values: [row] };
    const result = (0, child_process_1.spawnSync)(GWS, [
        'sheets', 'spreadsheets', 'values', 'append',
        '--params', JSON.stringify(paramsObj),
        '--json', JSON.stringify(jsonObj)
    ], { encoding: 'utf8' });
    if (result.status !== 0)
        throw new Error(result.stderr || 'Sheet append failed');
}
async function updateTaskStatus(task_id, status, worker_id, proof) {
    // Read all rows to find the right one
    const params = JSON.stringify({ spreadsheetId: SHEET_ID, range: 'Tasks!A:K' });
    const result = (0, child_process_1.execSync)(`${GWS} sheets spreadsheets values get --params '${params}'`, { encoding: 'utf8' });
    const data = JSON.parse(result);
    const rows = data.values || [];
    const idx = rows.findIndex((r) => r[0] === task_id);
    // Always write submission proof if provided (even if task not yet in sheet)
    if (proof && worker_id) {
        const subParams = JSON.stringify({
            spreadsheetId: SHEET_ID,
            range: 'Submissions!A:E',
            valueInputOption: 'USER_ENTERED',
        });
        const subPayload = JSON.stringify({ values: [[task_id, worker_id, proof, new Date().toISOString(), 'pending_payment']] });
        (0, child_process_1.spawnSync)(GWS, ['sheets', 'spreadsheets', 'values', 'append', '--params', subParams, '--json', subPayload], { encoding: 'utf8' });
    }
    if (idx === -1)
        return;
    const rowNum = idx + 1; // 1-indexed
    const updateParams = JSON.stringify({
        spreadsheetId: SHEET_ID,
        range: `Tasks!I${rowNum}`,
        valueInputOption: 'USER_ENTERED',
    });
    const updatePayload = JSON.stringify({ values: [[status]] });
    (0, child_process_1.spawnSync)(GWS, ['sheets', 'spreadsheets', 'values', 'update', '--params', updateParams, '--json', updatePayload], { encoding: 'utf8' });
    // (submission already written above)
}
async function getTaskResults(task_id) {
    try {
        const params = JSON.stringify({ spreadsheetId: SHEET_ID, range: 'Submissions!A:E' });
        const result = (0, child_process_1.execSync)(`${GWS} sheets spreadsheets values get --params '${params}'`, { encoding: 'utf8' });
        const data = JSON.parse(result);
        const rows = (data.values || []).slice(1); // skip header
        return rows
            .filter((r) => r[0] === task_id)
            .map((r) => ({ worker_airtm_id: r[1], proof: r[2], submitted_at: r[3] }));
    }
    catch {
        return [];
    }
}
async function getTaskFromSheet(task_id) {
    // For MVP, tasks are tracked in memory. This is a no-op fallback.
    return null;
}
//# sourceMappingURL=sheets.js.map