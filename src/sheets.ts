import { execSync, spawnSync } from 'child_process';
import * as https from 'https';

// Google Sheets API helper using service account JWT
let _accessToken: string | null = null;
let _tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken!;
  
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  
  const sa = JSON.parse(saJson);
  const now = Math.floor(Date.now() / 1000);
  
  const crypto = require('crypto');
  
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const payloadObj = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  
  const signInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const sig = sign.sign({ key: sa.private_key, padding: crypto.constants.RSA_PKCS1_PADDING }, 'base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const jwt = `${signInput}.${sig}`;
  
  const tokenBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });
  const data = await res.json() as any;
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _accessToken!;
}

async function sheetsAppend(spreadsheetId: string, range: string, values: any[][]): Promise<void> {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error(`Sheets API error: ${await res.text()}`);
}

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

  try {
    await sheetsAppend(SHEET_ID, 'Tasks!A:K', [row]);
    console.log('[sheets] Task written:', task.task_id);
  } catch (e) {
    console.error('[sheets] TASK WRITE FAILED:', (e as Error).message);
  }
}

export async function updateTaskStatus(task_id: string, status: string, worker_id?: string, proof?: string, payout_usdc?: number) {
  // Read all rows to find the right one
  const tokenRead = await getAccessToken();
  const readRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Tasks!A:K')}`, {
    headers: { 'Authorization': `Bearer ${tokenRead}` }
  });
  const data = await readRes.json() as any;
  const rows = data.values || [];
  
  const idx = rows.findIndex((r: string[]) => r[0] === task_id);

  // Always write submission proof if provided (even if task not yet in sheet)
  if (proof && worker_id) {
    const subParams = JSON.stringify({
      spreadsheetId: SHEET_ID,
      range: 'Submissions!A:E',
      valueInputOption: 'USER_ENTERED',
    });
    const subPayload = JSON.stringify({ values: [[task_id, worker_id, proof, new Date().toISOString(), 'pending_payment', payout_usdc !== undefined ? String(payout_usdc) : '', 'USDC']] });
    try {
      const subRow = [task_id, worker_id, (proof || '').substring(0, 500), new Date().toISOString(), 'pending_payment', payout_usdc !== undefined ? String(payout_usdc) : '', 'USDC'];
      await sheetsAppend(SHEET_ID, 'Submissions!A:G', [subRow]);
      console.log('[sheets] ✅ Submission written:', task_id, worker_id, '$'+payout_usdc);
    } catch (subErr) {
      console.error('[sheets] ❌ Submission write failed:', (subErr as Error).message);
    }
  }

  if (idx === -1) return;

  const rowNum = idx + 1; // 1-indexed
  const updateParams = JSON.stringify({
    spreadsheetId: SHEET_ID,
    range: `Tasks!I${rowNum}`,
    valueInputOption: 'USER_ENTERED',
  });
  const updatePayload = JSON.stringify({ values: [[status]] });
  const updateData = JSON.parse(updatePayload);
  const token2 = await getAccessToken();
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Tasks!I' + rowNum)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token2}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(updateData),
  });

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
  await sheetsAppend(JOB_FEED_SHEET_ID, 'Active_Projects STANDARIZED!A:W', JSON.parse(payload).values);
}

export async function loadTasksFromSheet(): Promise<Array<{
  task_id: string;
  title: string;
  task_type: string;
  task_description: string;
  payout_usdc: number;
  workers_needed: number;
  deadline_hours: number;
  language: string;
  status: string;
  job_url: string;
  created_at: string;
}>> {
  try {
    const params = JSON.stringify({ spreadsheetId: SHEET_ID, range: 'Tasks!A2:K10000' });
    const token = await getAccessToken();
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Tasks!A2:K10000')}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json() as any;
    const rows = (data.values || []) as string[][];
    return rows
      .filter(r => r[0] && r[0].length > 5) // valid task_id
      .map(r => ({
        task_id: r[0] || '',
        title: r[1] || '',
        task_type: r[2] || '',
        task_description: r[3] || '',
        payout_usdc: parseFloat(r[4]) || 0,
        workers_needed: parseInt(r[5]) || 1,
        deadline_hours: parseInt(r[6]) || 24,
        language: r[7] || 'Any',
        status: r[8] || 'Open',
        created_at: r[9] || '',
        job_url: r[10] || '',
      }));
  } catch {
    return [];
  }
}

export async function loadSubmissionsFromSheet(task_id: string): Promise<Array<{
  worker_airtm_id: string;
  proof: string;
  submitted_at: string;
}>> {
  try {
    const params = JSON.stringify({ spreadsheetId: SHEET_ID, range: 'Submissions!A2:E10000' });
    const token = await getAccessToken();
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Tasks!A2:K10000')}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json() as any;
    const rows = (data.values || []) as string[][];
    return rows
      .filter(r => r[0] === task_id)
      .map(r => ({ worker_airtm_id: r[1] || '', proof: r[2] || '', submitted_at: r[3] || '' }));
  } catch {
    return [];
  }
}
