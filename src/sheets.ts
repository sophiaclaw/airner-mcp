import { execSync, spawnSync } from 'child_process';

const SHEET_ID = '1inaRMstj81yN9J3MhTUzsu8R2GxlqwCNPOvgm_bKqbM';
const GWS = '/Users/clawbot/.npm-global/bin/gws';

export async function appendTask(task: {
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
}) {
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
  const result = spawnSync(GWS, [
    'sheets', 'spreadsheets', 'values', 'append',
    '--params', JSON.stringify(paramsObj),
    '--json', JSON.stringify(jsonObj)
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Sheet append failed');
}

export async function updateTaskStatus(task_id: string, status: string, worker_id?: string, proof?: string) {
  // Read all rows to find the right one
  const params = JSON.stringify({ spreadsheetId: SHEET_ID, range: 'Tasks!A:K' });
  const result = execSync(`${GWS} sheets spreadsheets values get --params '${params}'`, { encoding: 'utf8' });
  const data = JSON.parse(result);
  const rows = data.values || [];
  
  const idx = rows.findIndex((r: string[]) => r[0] === task_id);

  // Always write submission proof if provided (even if task not yet in sheet)
  if (proof && worker_id) {
    const subParams = JSON.stringify({
      spreadsheetId: SHEET_ID,
      range: 'Submissions!A:E',
      valueInputOption: 'USER_ENTERED',
    });
    const subPayload = JSON.stringify({ values: [[task_id, worker_id, proof, new Date().toISOString(), 'pending_payment']] });
    spawnSync(GWS, ['sheets', 'spreadsheets', 'values', 'append', '--params', subParams, '--json', subPayload], { encoding: 'utf8' });
  }

  if (idx === -1) return;

  const rowNum = idx + 1; // 1-indexed
  const updateParams = JSON.stringify({
    spreadsheetId: SHEET_ID,
    range: `Tasks!I${rowNum}`,
    valueInputOption: 'USER_ENTERED',
  });
  const updatePayload = JSON.stringify({ values: [[status]] });
  spawnSync(GWS, ['sheets', 'spreadsheets', 'values', 'update', '--params', updateParams, '--json', updatePayload], { encoding: 'utf8' });

  // (submission already written above)
}

export async function getTaskResults(task_id: string): Promise<Array<{worker_airtm_id: string; proof: string; submitted_at: string}>> {
  try {
    const params = JSON.stringify({ spreadsheetId: SHEET_ID, range: 'Submissions!A:E' });
    const result = execSync(`${GWS} sheets spreadsheets values get --params '${params}'`, { encoding: 'utf8' });
    const data = JSON.parse(result);
    const rows = (data.values || []).slice(1); // skip header
    return rows
      .filter((r: string[]) => r[0] === task_id)
      .map((r: string[]) => ({ worker_airtm_id: r[1], proof: r[2], submitted_at: r[3] }));
  } catch {
    return [];
  }
}

export async function getTaskFromSheet(task_id: string): Promise<any> {
  // For MVP, tasks are tracked in memory. This is a no-op fallback.
  return null;
}

const JOB_FEED_SHEET_ID = process.env.JOB_FEED_SHEET_ID || '16kxUFgFgMWjeETiLK5mOsh12M0eTCOa1wpchn6r1Bak';

export async function appendToJobFeed(task: {
  task_id: string;
  task_description: string;
  task_type: string;
  payout_usdc: number;
  deadline_hours: number;
  language?: string;
  location?: string;
  job_url: string;
}) {
  const row = [
    task.task_description.slice(0, 100),              // Title
    'AI & Data Tasks',                                 // Category
    task.task_type,                                    // Subcategory
    task.task_description,                             // Details
    task.job_url,                                      // ProjectURL
    task.location || 'Any',                            // Location
    '',                                                // Gender
    '',                                                // EducationLevel
    task.language || 'Any',                            // NativeLanguage
    '',                                                // SecondaryLanguage
    '',                                                // SecondaryLanguageProficiency
    '',                                                // Prefix
    task.payout_usdc.toString(),                       // Payrate
    'USDC',                                            // Currency
    'Fixed',                                           // PaymentType
    new Date(Date.now() + task.deadline_hours * 3600000).toISOString().split('T')[0], // ProjectDeadline
    'Airtm Agent',                                     // Platform
    new Date().toISOString().split('T')[0],            // Created
    'AI Agent',                                        // Created by
    new Date().toISOString().split('T')[0],            // Modified
    'Open',                                            // Status
    task.task_id,                                      // Standardized (using for task_id tracking)
  ];

  const params = JSON.stringify({
    spreadsheetId: JOB_FEED_SHEET_ID,
    range: 'Active_Projects STANDARIZED!A:W',
    valueInputOption: 'USER_ENTERED',
  });
  const payload = JSON.stringify({ values: [row] });
  spawnSync(GWS, ['sheets', 'spreadsheets', 'values', 'append', '--params', params, '--json', payload], { encoding: 'utf8' });
}
