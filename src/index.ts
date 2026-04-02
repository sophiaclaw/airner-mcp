#!/usr/bin/env node
/**
 * Airner MCP Server
 * Exposes three MCP tools for AI agents to hire Airtm community members:
 *   - hire_human
 *   - get_task_status
 *   - get_task_result
 *
 * Also runs an HTTP API server for:
 *   - Worker opt-in/submit endpoints (called by web pages)
 *   - GitHub OAuth registration
 *   - Task detail fetches
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { appendTask, updateTaskStatus, getTaskFromSheet } from './sheets.js';
import { getAgent, incrementTaskUsage, registerAgent, validateApiKey } from './agents.js';

const PORT = parseInt(process.env.PORT || '3000');

// ─────────────────────────────────────────────
// In-memory task store (MVP — complements sheet)
// ─────────────────────────────────────────────
interface TaskRecord {
  task_id: string;
  title: string;
  task_type: string;
  task_description: string;
  payout_usdc: number;
  workers_needed: number;
  workers_accepted: number;
  workers_completed: number;
  deadline_hours: number;
  language: string;
  location: string;
  created_by: string;
  created_at: string;
  status: 'open' | 'in_progress' | 'completed' | 'expired';
  acceptances: Array<{ worker_airtm_id: string; phone?: string; accepted_at: string }>;
  results: Array<{ worker_airtm_id: string; proof: string; submitted_at: string }>;
  instructions: string;
  job_url?: string;
}

const tasks: Record<string, TaskRecord> = {};

// Seed a test agent from environment if provided (for CI/E2E testing)
if (process.env.SEED_AGENT_ID && process.env.SEED_AGENT_KEY) {
  const existing = getAgent(process.env.SEED_AGENT_ID);
  if (!existing) {
    const agent = registerAgent(process.env.SEED_AGENT_ID);
    // Override the auto-generated key with the seed key
    const store = JSON.parse(require('fs').readFileSync(process.env.AGENTS_FILE || '/app/agents.json', 'utf-8'));
    store.agents[agent.agent_id].api_key = process.env.SEED_AGENT_KEY;
    require('fs').writeFileSync(process.env.AGENTS_FILE || '/app/agents.json', JSON.stringify(store, null, 2));
    console.log('Seeded test agent:', process.env.SEED_AGENT_ID);
  }
}

// ─────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────
const mcpServer = new Server(
  { name: 'airner', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'hire_human',
      description: 'Post a task to verified Airtm community members. Returns a task ID and job URL immediately. Workers opt in via the URL and receive USDC payment upon completion.',
      inputSchema: {
        type: 'object',
        properties: {
          task_description: {
            type: 'string',
            description: 'Clear description of what the worker needs to do and what proof to submit.',
          },
          task_type: {
            type: 'string',
            description: 'Type of task (e.g. "data_labeling", "research", "translation", "local_outreach", "survey", "content_moderation")',
          },
          payout_usdc: {
            type: 'number',
            description: 'How much to pay each worker in USDC (e.g. 5.00)',
          },
          workers_needed: {
            type: 'integer',
            description: 'How many workers you need (default: 1)',
          },
          deadline_hours: {
            type: 'integer',
            description: 'Hours until the task expires (default: 24)',
          },
          language: {
            type: 'string',
            description: 'Required language (e.g. "Spanish", "English"). Default: "Any"',
          },
          location: {
            type: 'string',
            description: 'Required location/country (e.g. "Mexico", "Venezuela"). Default: "Any"',
          },
          instructions: {
            type: 'string',
            description: 'Step-by-step instructions shown to the worker after they accept the task. Be specific about what to do and how to submit proof.',
          },
        },
        required: ['task_description', 'task_type', 'payout_usdc'],
      },
    },
    {
      name: 'get_task_status',
      description: 'Check the status of a task you posted — how many workers have accepted and completed it.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID returned by hire_human()',
          },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'get_task_result',
      description: 'Retrieve completed work and worker Airtm IDs for payment. Use worker_airtm_id to send USDC via Airtm.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The task ID returned by hire_human()',
          },
        },
        required: ['task_id'],
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Validate agent credentials from env
  const agent_id = process.env.AIRNER_AGENT_ID;
  const api_key = process.env.AIRNER_API_KEY;

  if (name === 'hire_human') {
    // Validate agent
    if (!agent_id || !api_key || !validateApiKey(agent_id, api_key)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Invalid agent credentials. Register at https://go.airtm.com/hire/register',
          }),
        }],
        isError: true,
      };
    }

    const agent = getAgent(agent_id);
    if (!agent || agent.tasks_remaining <= 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Free task limit reached. Contact sophia@airtm.io to upgrade.' }),
        }],
        isError: true,
      };
    }

    const task_id = uuidv4();
    const task: TaskRecord = {
      task_id,
      title: (args as any).task_description?.slice(0, 60) || 'Task',
      task_type: (args as any).task_type || 'Task',
      task_description: (args as any).task_description,
      payout_usdc: parseFloat((args as any).payout_usdc) || 0,
      workers_needed: parseInt((args as any).workers_needed) || 1,
      workers_accepted: 0,
      workers_completed: 0,
      deadline_hours: parseInt((args as any).deadline_hours) || 24,
      language: (args as any).language || 'Any',
      location: (args as any).location || 'Any',
      created_by: agent_id,
      created_at: new Date().toISOString(),
      status: 'open',
      acceptances: [],
      results: [],
      instructions: (args as any).instructions || (args as any).task_description,
    };

    tasks[task_id] = task;

    // Write to Google Sheet
    try {
      await appendTask({
        task_id,
        title: task.title,
        task_type: task.task_type,
        task_description: task.task_description,
        payout_usdc: task.payout_usdc,
        workers_needed: task.workers_needed,
        deadline_hours: task.deadline_hours,
        language: task.language,
        location: task.location,
        job_url: task.job_url || '',
        created_by: agent_id,
      });
      // Also post to Airner job feed via webhook bridge (Mac Mini handles gws write)
      if (process.env.JOB_FEED_WEBHOOK_URL) {
        try {
          const webhookPayload = JSON.stringify({
            task_id,
            task_description: task.task_description,
            task_type: task.task_type,
            payout_usdc: task.payout_usdc,
            deadline_hours: task.deadline_hours,
            language: task.language,
            location: task.location,
            job_url: task.job_url || '',
          });
          const https = require('https');
          const url = new URL(process.env.JOB_FEED_WEBHOOK_URL);
          const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Secret': process.env.JOB_FEED_WEBHOOK_SECRET || '',
              'Content-Length': Buffer.byteLength(webhookPayload),
            },
          };
          const req = https.request(options);
          req.on('error', () => {}); // non-fatal
          req.write(webhookPayload);
          req.end();
        } catch (e) { /* non-fatal */ }
      }
    } catch (e) {
      console.error('Sheet write error:', e);
      // Non-fatal — task still works via in-memory store
    }

    // Increment usage
    try {
      incrementTaskUsage(agent_id);
    } catch (e) {
      console.error('Usage tracking error:', e);
    }

    const estimated_completion = new Date(
      Date.now() + task.deadline_hours * 3600 * 1000
    ).toISOString();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          task_id,
          job_url: `https://go.airtm.com/hire/task?id=${task_id}`,
          estimated_completion,
          message: `Task posted. Share the job_url with workers or wait for community members to find it. Poll get_task_status() to track progress.`,
        }),
      }],
    };
  }

  if (name === 'get_task_status') {
    const task_id = (args as any).task_id;
    const task = tasks[task_id];

    if (!task) {
      // Try sheet
      try {
        const sheetTask = await getTaskFromSheet(task_id);
        if (sheetTask) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: sheetTask.status || 'unknown',
                workers_accepted: sheetTask.workers_accepted || 0,
                workers_completed: sheetTask.workers_completed || 0,
                pending: (sheetTask.workers_needed || 1) - (sheetTask.workers_completed || 0),
              }),
            }],
          };
        }
      } catch (e) { /* ignore */ }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Task not found' }),
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: task.status,
          workers_accepted: task.workers_accepted,
          workers_completed: task.workers_completed,
          pending: task.workers_needed - task.workers_completed,
          workers_needed: task.workers_needed,
          deadline_at: new Date(
            new Date(task.created_at).getTime() + task.deadline_hours * 3600 * 1000
          ).toISOString(),
        }),
      }],
    };
  }

  if (name === 'get_task_result') {
    const task_id = (args as any).task_id;
    const task = tasks[task_id];

    if (!task) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Task not found' }),
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: task.status,
          results: task.results,
          payout_note: task.results.length > 0
            ? `Send $${task.payout_usdc} USDC to each worker_airtm_id via Airtm. ${task.results.length} worker(s) completed this task.`
            : 'No results yet.',
        }),
      }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool' }) }],
    isError: true,
  };
});

// ─────────────────────────────────────────────
// HTTP API Server (for web pages + OAuth)
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'airner-mcp', version: '0.1.0' });
});

// Get task details (called by task.html)
app.get('/task/:task_id', async (req, res) => {
  const { task_id } = req.params;
  const task = tasks[task_id];

  if (task) {
    res.json({
      task_id: task.task_id,
      title: task.title,
      task_type: task.task_type,
      task_description: task.task_description,
      payout_usdc: task.payout_usdc,
      workers_needed: task.workers_needed,
      workers_accepted: task.workers_accepted,
      deadline_hours: task.deadline_hours,
      language: task.language,
      location: task.location,
      created_at: task.created_at,
      status: task.status,
    });
    return;
  }

  // Fallback to sheet
  try {
    const sheetTask = await getTaskFromSheet(task_id);
    if (sheetTask) {
      res.json(sheetTask);
      return;
    }
  } catch (e) { /* ignore */ }

  res.status(404).json({ error: 'Task not found' });
});

// Worker accepts task
app.post('/task/:task_id/accept', async (req, res) => {
  const { task_id } = req.params;
  const { airtm_username, phone } = req.body;

  if (!airtm_username) {
    res.status(400).json({ error: 'airtm_username required' });
    return;
  }

  const task = tasks[task_id];
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  if (task.status === 'expired') {
    res.status(410).json({ error: 'Task has expired' });
    return;
  }

  if (task.workers_accepted >= task.workers_needed) {
    res.status(409).json({ error: 'Task is full — all spots taken' });
    return;
  }

  // Record acceptance
  task.acceptances.push({
    worker_airtm_id: airtm_username,
    phone,
    accepted_at: new Date().toISOString(),
  });
  task.workers_accepted += 1;
  if (task.workers_accepted >= task.workers_needed) {
    task.status = 'in_progress';
  }

  // Update sheet
  try {
    await updateTaskStatus(task_id, 'In Progress', airtm_username);
  } catch (e) {
    console.error('Sheet update error:', e);
  }

  res.json({
    ok: true,
    instructions: task.instructions || task.task_description,
    payout_usdc: task.payout_usdc,
    submit_url: `https://go.airtm.com/hire/submit?id=${task_id}`,
  });
});

// Worker submits proof
app.post('/task/:task_id/submit', async (req, res) => {
  const { task_id } = req.params;
  const { airtm_username, proof } = req.body;

  if (!airtm_username || !proof) {
    res.status(400).json({ error: 'airtm_username and proof required' });
    return;
  }

  const task = tasks[task_id];
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  task.results.push({
    worker_airtm_id: airtm_username,
    proof,
    submitted_at: new Date().toISOString(),
  });
  task.workers_completed += 1;

  if (task.workers_completed >= task.workers_needed) {
    task.status = 'completed';
  }

  // Update sheet
  try {
    await updateTaskStatus(task_id, 'Completed', airtm_username, proof);
  } catch (e) {
    console.error('Sheet update error:', e);
  }

  res.json({
    ok: true,
    message: 'Proof submitted. Payment will be sent to your Airtm account within 24h.',
    payout_usdc: task.payout_usdc,
  });
});

// GitHub OAuth — redirect to GitHub
app.get('/auth/github', (req, res) => {
  const redirect = req.query.redirect as string || 'https://go.airtm.com/hire/register';
  const client_id = process.env.GITHUB_CLIENT_ID;

  if (!client_id) {
    res.status(503).json({ error: 'GitHub OAuth not configured. Contact sophia@airtm.io' });
    return;
  }

  const state = Buffer.from(JSON.stringify({ redirect })).toString('base64');
  const github_url = `https://github.com/login/oauth/authorize?client_id=${client_id}&scope=read:user&state=${state}`;
  res.redirect(github_url);
});

// GitHub OAuth callback
app.get('/auth/github/callback', async (req, res) => {
  const { code, state } = req.query;
  const client_id = process.env.GITHUB_CLIENT_ID;
  const client_secret = process.env.GITHUB_CLIENT_SECRET;

  if (!client_id || !client_secret) {
    res.status(503).json({ error: 'GitHub OAuth not configured' });
    return;
  }

  try {
    // Exchange code for token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id, client_secret, code }),
    });
    const tokenData = await tokenRes.json() as any;

    if (tokenData.error) {
      res.status(400).json({ error: tokenData.error_description || 'OAuth failed' });
      return;
    }

    // Get GitHub user
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'Airner' },
    });
    const user = await userRes.json() as any;

    // Register agent
    const agent = registerAgent(user.login);

    res.json({
      agent_id: agent.agent_id,
      github_username: agent.github_username,
      api_key: agent.api_key,
      tasks_used: agent.tasks_used,
      tasks_remaining: agent.tasks_remaining,
    });
  } catch (e) {
    res.status(500).json({ error: 'Internal error during OAuth' });
  }
});

// ─────────────────────────────────────────────
// HTTP Tool endpoints (for agents calling via REST)
// POST /tools/hire_human
// POST /tools/get_task_status
// POST /tools/get_task_result
// Auth: X-API-Key: <api_key>  OR  X-Agent-Id + X-API-Key headers
// ─────────────────────────────────────────────

function authenticateAgent(req: express.Request): { agent_id: string; error?: string } {
  const api_key = (req.headers['x-api-key'] as string) || req.body?.api_key;
  const agent_id_header = (req.headers['x-agent-id'] as string) || req.body?.agent_id;

  if (!api_key) {
    return { agent_id: '', error: 'Missing X-API-Key header. Register at https://go.airtm.com/hire/register' };
  }

  const { getAgentByApiKey } = require('./agents.js');
  const agent = getAgentByApiKey(api_key);
  if (!agent) {
    return { agent_id: '', error: 'Invalid API key. Register at https://go.airtm.com/hire/register' };
  }

  return { agent_id: agent.agent_id };
}

app.post('/tools/hire_human', async (req, res) => {
  const auth = authenticateAgent(req);
  if (auth.error) { res.status(401).json({ error: auth.error }); return; }

  const agent = getAgent(auth.agent_id);
  if (!agent || agent.tasks_remaining <= 0) {
    res.status(403).json({ error: 'Free task limit reached. Contact sophia@airtm.io to upgrade.' });
    return;
  }

  const { task_description, task_type, payout_usdc, workers_needed, deadline_hours, language, location, instructions } = req.body;
  if (!task_description || !task_type || payout_usdc === undefined) {
    res.status(400).json({ error: 'Required: task_description, task_type, payout_usdc' });
    return;
  }

  const task_id = uuidv4();
  const task: TaskRecord = {
    task_id,
    title: task_description.slice(0, 60),
    task_type: task_type || 'Task',
    task_description,
    payout_usdc: parseFloat(payout_usdc) || 0,
    workers_needed: parseInt(workers_needed) || 1,
    workers_accepted: 0,
    workers_completed: 0,
    deadline_hours: parseInt(deadline_hours) || 24,
    language: language || 'Any',
    location: location || 'Any',
    created_by: auth.agent_id,
    created_at: new Date().toISOString(),
    status: 'open',
    acceptances: [],
    results: [],
    instructions: instructions || task_description,
  };

  tasks[task_id] = task;

  // Write to Google Sheet
  try {
    await appendTask({
      task_id,
      title: task.title,
      task_type: task.task_type,
      task_description: task.task_description,
      payout_usdc: task.payout_usdc,
      workers_needed: task.workers_needed,
      deadline_hours: task.deadline_hours,
      language: task.language,
      location: task.location,
      job_url: task.job_url || '',
      created_by: auth.agent_id,
    });
  } catch (e) {
    console.error('Sheet write error (non-fatal):', (e as Error).message);
  }

  try { incrementTaskUsage(auth.agent_id); } catch (e) { /* ignore */ }

  const estimated_completion = new Date(
    Date.now() + task.deadline_hours * 3600 * 1000
  ).toISOString();

  // Build job_url with embedded params for stateless page rendering
  const params = new URLSearchParams({
    id: task_id,
    title: task.title,
    pay: String(task.payout_usdc),
    deadline: String(task.deadline_hours),
    instructions: task.instructions,
    type: task.task_type,
    location: task.location,
  });
  const job_url = `https://go.airtm.com/hire/task?${params.toString()}`;

  res.json({ task_id, job_url, estimated_completion });
});

app.post('/tools/get_task_status', async (req, res) => {
  const auth = authenticateAgent(req);
  if (auth.error) { res.status(401).json({ error: auth.error }); return; }

  const { task_id } = req.body;
  if (!task_id) { res.status(400).json({ error: 'task_id required' }); return; }

  const task = tasks[task_id];
  if (task) {
    res.json({
      status: task.status,
      workers_accepted: task.workers_accepted,
      workers_completed: task.workers_completed,
      pending: task.workers_needed - task.workers_completed,
    });
    return;
  }

  try {
    const sheetTask = await getTaskFromSheet(task_id);
    if (sheetTask) {
      res.json({ status: sheetTask.status || 'unknown', workers_accepted: 0, workers_completed: 0 });
      return;
    }
  } catch (e) { /* ignore */ }

  res.status(404).json({ error: 'Task not found' });
});

app.post('/tools/get_task_result', async (req, res) => {
  const auth = authenticateAgent(req);
  if (auth.error) { res.status(401).json({ error: auth.error }); return; }

  const { task_id } = req.body;
  if (!task_id) { res.status(400).json({ error: 'task_id required' }); return; }

  const task = tasks[task_id];
  if (!task) {
    res.status(404).json({ error: 'Task not found. Note: in-memory tasks are lost on server restart.' });
    return;
  }

  res.json({
    status: task.status,
    results: task.results,
    payout_note: task.results.length > 0
      ? `Send $${task.payout_usdc} USDC to each worker_airtm_id via Airtm. ${task.results.length} worker(s) completed.`
      : 'No results yet. Poll get_task_status first.',
  });
});

// ─────────────────────────────────────────────
// Start both servers
// ─────────────────────────────────────────────
async function main() {
  // Start HTTP server
  app.listen(PORT, () => {
    console.log(`Airner HTTP API running on port ${PORT}`);
  });

  // If running as MCP (stdin is not a TTY), start MCP transport
  if (!process.stdin.isTTY || process.env.MCP_MODE === 'stdio') {
    console.error('Starting MCP stdio transport...');
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error('Airner MCP server connected');
  }
}

main().catch(console.error);
