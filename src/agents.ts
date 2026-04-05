/**
 * Agent tracking — reads/writes agents.json
 * Tracks GitHub-registered agents and their free task limits
 *
 * Persistence strategy (Render-safe):
 * 1. SEED_AGENTS env var — JSON array of pre-seeded agents (never lost on restart)
 * 2. Filesystem agents.json — ephemeral on Render, used as runtime cache
 *
 * On restart: seed agents are always available. GitHub-registered agents
 * are re-registered on next OAuth login (handled gracefully — same key returned).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const AGENTS_FILE = process.env.AGENTS_FILE ||
  path.join(process.cwd(), 'agents.json');

const FREE_TASK_LIMIT = 999; // effectively unlimited for now

export interface Agent {
  agent_id: string;
  github_username: string;
  api_key: string;
  tasks_used: number;
  tasks_remaining: number;
  registered_at: string;
  last_active?: string;
}

interface AgentsStore {
  agents: Record<string, Agent>;
}

function loadSeedAgents(): Record<string, Agent> {
  const seeds: Record<string, Agent> = {};

  // Single seed agent from env vars (primary)
  const seedId = process.env.SEED_AGENT_ID;
  const seedKey = process.env.SEED_AGENT_KEY;
  if (seedId && seedKey) {
    seeds[seedId] = {
      agent_id: seedId,
      github_username: seedId,
      api_key: seedKey,
      tasks_used: 0,
      tasks_remaining: FREE_TASK_LIMIT,
      registered_at: '2026-01-01T00:00:00Z',
    };
  }

  // Multi-agent seed from SEED_AGENTS env var (JSON array)
  if (process.env.SEED_AGENTS) {
    try {
      const arr = JSON.parse(process.env.SEED_AGENTS) as Agent[];
      for (const a of arr) {
        seeds[a.agent_id] = { ...a, tasks_remaining: FREE_TASK_LIMIT };
      }
    } catch (e) {
      console.error('[agents] Failed to parse SEED_AGENTS:', (e as Error).message);
    }
  }

  return seeds;
}

function loadAgents(): AgentsStore {
  const seeds = loadSeedAgents();
  let stored: AgentsStore = { agents: {} };

  if (fs.existsSync(AGENTS_FILE)) {
    try {
      stored = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
    } catch {
      stored = { agents: {} };
    }
  }

  // Merge: seeds take precedence for their keys, stored adds registered agents
  return { agents: { ...stored.agents, ...seeds } };
}

function saveAgents(store: AgentsStore): void {
  try {
    const dir = path.dirname(AGENTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    // Non-fatal on Render — seed agents still work from env
    console.warn('[agents] Could not write agents.json:', (e as Error).message);
  }
}

export function getAgent(agent_id: string): Agent | null {
  const store = loadAgents();
  return store.agents[agent_id] || null;
}

export function getAgentByApiKey(api_key: string): Agent | null {
  const store = loadAgents();
  return Object.values(store.agents).find(a => a.api_key === api_key) || null;
}

export function registerAgent(github_username: string): Agent {
  const store = loadAgents();

  // Check if already registered (by github username)
  const existing = Object.values(store.agents).find(a => a.github_username === github_username);
  if (existing) return existing;

  const agent: Agent = {
    agent_id: github_username,
    github_username,
    api_key: `airner_${crypto.randomBytes(24).toString('hex')}`,
    tasks_used: 0,
    tasks_remaining: FREE_TASK_LIMIT,
    registered_at: new Date().toISOString(),
  };

  store.agents[github_username] = agent;
  saveAgents(store);
  return agent;
}

export function incrementTaskUsage(agent_id: string): Agent {
  const store = loadAgents();
  const agent = store.agents[agent_id];
  if (!agent) throw new Error(`Agent ${agent_id} not found`);

  agent.tasks_used += 1;
  agent.tasks_remaining = Math.max(0, agent.tasks_remaining - 1);
  agent.last_active = new Date().toISOString();
  store.agents[agent_id] = agent;
  saveAgents(store);
  return agent;
}

export function validateApiKey(agent_id: string, api_key: string): boolean {
  const agent = getAgent(agent_id);
  if (!agent) return false;
  return agent.api_key === api_key;
}
