export interface Agent {
    agent_id: string;
    github_username: string;
    api_key: string;
    tasks_used: number;
    tasks_remaining: number;
    registered_at: string;
    last_active?: string;
}
export declare function getAgent(agent_id: string): Agent | null;
export declare function getAgentByApiKey(api_key: string): Agent | null;
export declare function registerAgent(github_username: string): Agent;
export declare function incrementTaskUsage(agent_id: string): Agent;
export declare function validateApiKey(agent_id: string, api_key: string): boolean;
//# sourceMappingURL=agents.d.ts.map