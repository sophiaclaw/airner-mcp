"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAgent = getAgent;
exports.getAgentByApiKey = getAgentByApiKey;
exports.registerAgent = registerAgent;
exports.incrementTaskUsage = incrementTaskUsage;
exports.validateApiKey = validateApiKey;
/**
 * Agent tracking — reads/writes agents.json
 * Tracks GitHub-registered agents and their free task limits
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const AGENTS_FILE = process.env.AGENTS_FILE ||
    path_1.default.join(process.env.HOME || '', '.openclaw', 'workspace', 'airner-hire', 'agents.json');
const FREE_TASK_LIMIT = 10;
function loadAgents() {
    if (!fs_1.default.existsSync(AGENTS_FILE)) {
        return { agents: {} };
    }
    try {
        return JSON.parse(fs_1.default.readFileSync(AGENTS_FILE, 'utf-8'));
    }
    catch {
        return { agents: {} };
    }
}
function saveAgents(store) {
    const dir = path_1.default.dirname(AGENTS_FILE);
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
    fs_1.default.writeFileSync(AGENTS_FILE, JSON.stringify(store, null, 2));
}
function getAgent(agent_id) {
    const store = loadAgents();
    return store.agents[agent_id] || null;
}
function getAgentByApiKey(api_key) {
    const store = loadAgents();
    return Object.values(store.agents).find(a => a.api_key === api_key) || null;
}
function registerAgent(github_username) {
    const store = loadAgents();
    // Check if already registered
    const existing = Object.values(store.agents).find(a => a.github_username === github_username);
    if (existing)
        return existing;
    const agent = {
        agent_id: github_username,
        github_username,
        api_key: `airner_${crypto_1.default.randomBytes(24).toString('hex')}`,
        tasks_used: 0,
        tasks_remaining: FREE_TASK_LIMIT,
        registered_at: new Date().toISOString(),
    };
    store.agents[github_username] = agent;
    saveAgents(store);
    return agent;
}
function incrementTaskUsage(agent_id) {
    const store = loadAgents();
    const agent = store.agents[agent_id];
    if (!agent)
        throw new Error(`Agent ${agent_id} not found`);
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
function validateApiKey(agent_id, api_key) {
    const agent = getAgent(agent_id);
    if (!agent)
        return false;
    return agent.api_key === api_key;
}
//# sourceMappingURL=agents.js.map