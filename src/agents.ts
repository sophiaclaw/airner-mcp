/**
 * Agent tracking — reads/writes agents.json
 * Tracks GitHub-registered agents and their free task limits
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const AGENTS_FILE = process.env.AGENTS_FILE ||
  path.join(process.env.HOME || '', '.openclaw', 'workspace', 'airner-hire', 'agents.json');

const FREE_TASK_LIMIT = 10;

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

function loadAgents(): AgentsStore {
  if (!fs.existsSync(AGENTS_FILE)) {
    return { agents: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
  } catch {
    return { agents: {} };
  }
}

function saveAgents(store: AgentsStore): void {
  const dir = path.dirname(AGENTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(store, null, 2));
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

  // Check if already registered
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
  if (agent.tasks_remaining <= 0) {
    throw new Error('Free task limit reached (10/10). Contact airtm.com to upgrade.');
  }

  agent.tasks_used += 1;
  agent.tasks_remaining -= 1;
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
