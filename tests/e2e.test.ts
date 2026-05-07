#!/usr/bin/env ts-node
/**
 * Airner MCP — End-to-End Test Suite
 * Tests both the agent-side flow and worker-side flow via HTTP API.
 *
 * Usage:
 *   npm run test:e2e
 *   TEST_BASE_URL=https://airner-mcp.onrender.com TEST_API_KEY=<key> TEST_AGENT_ID=<id> npm run test:e2e
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const API_KEY  = process.env.TEST_API_KEY  || 'test_key_missing';
const AGENT_ID = process.env.TEST_AGENT_ID || 'test_agent_missing';

let passed = 0;
let failed = 0;
const results: string[] = [];

function pass(name: string) {
  passed++;
  results.push(`  [PASS] ${name}`);
}

function fail(name: string, detail: string) {
  failed++;
  results.push(`  [FAIL] ${name}\n         └─ ${detail}`);
}

async function post(path: string, body: object, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  return { status: res.status, data };
}

async function get(path: string) {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json() as any;
  return { status: res.status, data };
}

const authHeaders = {
  'X-API-Key': API_KEY,
  'X-Agent-Id': AGENT_ID,
};

async function runTests() {
  console.log(`\nAirner MCP — E2E Test Suite`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Agent:  ${AGENT_ID}`);
  console.log('─'.repeat(55));

  // ─────────────────────────────────────────────────
  // SECTION 1: Infrastructure
  // ─────────────────────────────────────────────────
  console.log('\n[1] Infrastructure');

  // Test 1: Health check
  try {
    const { status, data } = await get('/health');
    if (status === 200 && data.ok === true) {
      pass('Health check → ok:true');
    } else {
      fail('Health check', `Expected ok:true, got: ${JSON.stringify(data)}`);
    }
  } catch (e: any) {
    fail('Health check', `Request failed: ${e.message}`);
  }

  // ─────────────────────────────────────────────────
  // SECTION 2: Agent flow — hire_human
  // ─────────────────────────────────────────────────
  console.log('\n[2] Agent flow — hire_human');

  // Test 2: hire_human without credentials
  try {
    const { status, data } = await post('/tools/hire_human', {
      task_description: 'Test task',
      task_type: 'research',
      payout_usdc: 5,
    });
    if (status === 401 && data.error) {
      pass('hire_human without credentials → 401');
    } else {
      fail('hire_human without credentials', `Expected 401, got ${status}: ${JSON.stringify(data)}`);
    }
  } catch (e: any) {
    fail('hire_human without credentials', e.message);
  }

  // Test 3: hire_human with payout=0
  try {
    const { status, data } = await post('/tools/hire_human', {
      task_description: 'Test task',
      task_type: 'research',
      payout_usdc: 0,
    }, authHeaders);
    if (status === 400 && data.error) {
      pass('hire_human with payout_usdc=0 → 400');
    } else {
      fail('hire_human with payout_usdc=0', `Expected 400, got ${status}: ${JSON.stringify(data)}`);
    }
  } catch (e: any) {
    fail('hire_human with payout_usdc=0', e.message);
  }

  // Test 4: hire_human valid — creates task 1 (approval flow)
  let task1_id = '';
  try {
    const { status, data } = await post('/tools/hire_human', {
      task_description: 'E2E test task — please ignore. Translate "Hello World" to Spanish.',
      task_type: 'translation',
      payout_usdc: 1,
      deadline_hours: 1,
      instructions: 'Translate the phrase and submit the translation as proof.',
    }, authHeaders);
    if (status === 200 && data.task_id && data.job_url) {
      task1_id = data.task_id;
      pass(`hire_human valid → task_id: ${task1_id.slice(0, 8)}...`);
    } else {
      fail('hire_human valid', `Expected task_id+job_url, got ${status}: ${JSON.stringify(data)}`);
    }
  } catch (e: any) {
    fail('hire_human valid', e.message);
  }

  // Test 5: hire_human valid — creates task 2 (rejection flow)
  let task2_id = '';
  try {
    const { status, data } = await post('/tools/hire_human', {
      task_description: 'E2E test task 2 — please ignore. Count to 5 in Portuguese.',
      task_type: 'translation',
      payout_usdc: 1,
      deadline_hours: 1,
      instructions: 'Count to 5 in Portuguese and submit as proof.',
    }, authHeaders);
    if (status === 200 && data.task_id) {
      task2_id = data.task_id;
      pass(`hire_human (task 2 — rejection flow) → task_id: ${task2_id.slice(0, 8)}...`);
    } else {
      fail('hire_human (task 2)', `Expected task_id, got ${status}: ${JSON.stringify(data)}`);
    }
  } catch (e: any) {
    fail('hire_human (task 2)', e.message);
  }

  // ─────────────────────────────────────────────────
  // SECTION 3: Agent flow — query before submission
  // ─────────────────────────────────────────────────
  console.log('\n[3] Agent flow — query before submission');

  if (task1_id) {
    // Test 6: get_task_status on new task
    try {
      const { status, data } = await post('/tools/get_task_status', { task_id: task1_id }, authHeaders);
      if (status === 200 && data.status === 'open') {
        pass('get_task_status on new task → status:open');
      } else {
        fail('get_task_status on new task', `Expected status:open, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('get_task_status on new task', e.message);
    }

    // Test 7: get_task_result on new task (no results yet)
    try {
      const { status, data } = await post('/tools/get_task_result', { task_id: task1_id }, authHeaders);
      if (status === 200 && Array.isArray(data.results) && data.results.length === 0) {
        pass('get_task_result on new task → empty results');
      } else {
        fail('get_task_result on new task', `Expected empty results, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('get_task_result on new task', e.message);
    }

    // Test 8: approve_task before any submission
    try {
      const { status, data } = await post('/tools/approve_task', { task_id: task1_id, approved: true }, authHeaders);
      if (status === 409 && data.error && data.error.includes('No submission')) {
        pass('approve_task before submission → 409 "No submission to review yet"');
      } else {
        fail('approve_task before submission', `Expected 409 with "No submission" error, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('approve_task before submission', e.message);
    }
  } else {
    fail('get_task_status (skipped)', 'task1_id not set — hire_human failed');
    fail('get_task_result (skipped)', 'task1_id not set — hire_human failed');
    fail('approve_task before submission (skipped)', 'task1_id not set');
  }

  // ─────────────────────────────────────────────────
  // SECTION 4: Worker flow — task 1
  // ─────────────────────────────────────────────────
  console.log('\n[4] Worker flow — task 1 (accept → submit)');

  const testWorker = 'e2e_test_worker_' + Date.now();

  if (task1_id) {
    // Test 9: GET /task/:id
    try {
      const { status, data } = await get(`/task/${task1_id}`);
      if (status === 200 && data.task_id === task1_id && data.status === 'open') {
        pass(`GET /task/:id → task details returned, status:open`);
      } else {
        fail('GET /task/:id', `Expected task details, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('GET /task/:id', e.message);
    }

    // Test 10: Worker accepts task
    try {
      const { status, data } = await post(`/task/${task1_id}/accept`, { airtm_username: testWorker });
      if (status === 200 && data.ok && data.instructions) {
        pass('Worker accepts task → ok:true, instructions returned');
      } else {
        fail('Worker accepts task', `Expected ok:true + instructions, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('Worker accepts task', e.message);
    }

    // Test 11: Duplicate accept (task full)
    try {
      const { status, data } = await post(`/task/${task1_id}/accept`, { airtm_username: 'another_worker' });
      if (status === 409 && data.error) {
        pass('Duplicate accept (task full) → 409');
      } else {
        fail('Duplicate accept (task full)', `Expected 409, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('Duplicate accept (task full)', e.message);
    }

    // Test 12: Worker submits proof
    try {
      const { status, data } = await post(`/task/${task1_id}/submit`, {
        airtm_username: testWorker,
        proof: 'E2E test proof: "Hola Mundo"',
      });
      if (status === 200 && data.ok) {
        pass('Worker submits proof → ok:true');
      } else {
        fail('Worker submits proof', `Expected ok:true, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('Worker submits proof', e.message);
    }

    // Test 13: Duplicate submission
    try {
      const { status, data } = await post(`/task/${task1_id}/submit`, {
        airtm_username: testWorker,
        proof: 'Duplicate proof attempt',
      });
      if (status === 409 && data.error) {
        pass('Duplicate submission → 409');
      } else {
        fail('Duplicate submission', `Expected 409, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('Duplicate submission', e.message);
    }

  } else {
    ['GET /task/:id', 'Worker accepts task', 'Duplicate accept', 'Worker submits proof', 'Duplicate submission'].forEach(t => {
      fail(t + ' (skipped)', 'task1_id not set');
    });
  }

  // ─────────────────────────────────────────────────
  // SECTION 5: Agent flow — review after submission
  // ─────────────────────────────────────────────────
  console.log('\n[5] Agent flow — review after submission (task 1)');

  if (task1_id) {
    // Test 14: get_task_status after submission
    try {
      const { status, data } = await post('/tools/get_task_status', { task_id: task1_id }, authHeaders);
      if (status === 200 && data.workers_completed === 1) {
        pass(`get_task_status after submission → workers_completed:1, status:${data.status}`);
      } else {
        fail('get_task_status after submission', `Expected workers_completed:1, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('get_task_status after submission', e.message);
    }

    // Test 15: get_task_result with proof
    try {
      const { status, data } = await post('/tools/get_task_result', { task_id: task1_id }, authHeaders);
      if (status === 200 && Array.isArray(data.results) && data.results.length === 1 && data.results[0].proof) {
        pass(`get_task_result with proof → 1 result, worker: ${data.results[0].worker_airtm_id}`);
      } else {
        fail('get_task_result with proof', `Expected 1 result with proof, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('get_task_result with proof', e.message);
    }

    // Test 16: approve_task → approved=true
    try {
      const { status, data } = await post('/tools/approve_task', {
        task_id: task1_id,
        approved: true,
        feedback: 'E2E test approval — good work',
      }, authHeaders);
      if (status === 200 && data.ok && data.worker_airtm_id && data.payout_usdc) {
        pass(`approve_task approved=true → ok:true, payment $${data.payout_usdc} to ${data.worker_airtm_id}`);
      } else {
        fail('approve_task approved=true', `Expected ok+worker+payout, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('approve_task approved=true', e.message);
    }

    // Test 17: get_task_status after approval → status:approved
    try {
      const { status, data } = await post('/tools/get_task_status', { task_id: task1_id }, authHeaders);
      if (status === 200 && data.status === 'approved') {
        pass('get_task_status after approval → status:approved');
      } else {
        fail('get_task_status after approval', `Expected status:approved, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('get_task_status after approval', e.message);
    }
  } else {
    ['get_task_status after submission', 'get_task_result with proof', 'approve_task approved=true', 'get_task_status after approval'].forEach(t => {
      fail(t + ' (skipped)', 'task1_id not set');
    });
  }

  // ─────────────────────────────────────────────────
  // SECTION 6: Rejection flow — task 2
  // ─────────────────────────────────────────────────
  console.log('\n[6] Rejection flow — task 2 (reject → re-open)');

  const testWorker2 = 'e2e_test_worker2_' + Date.now();

  if (task2_id) {
    // Accept task 2
    try {
      const { status } = await post(`/task/${task2_id}/accept`, { airtm_username: testWorker2 });
      if (status === 200) {
        pass('Worker 2 accepts task 2');
      } else {
        fail('Worker 2 accepts task 2', `Expected 200, got ${status}`);
      }
    } catch (e: any) {
      fail('Worker 2 accepts task 2', e.message);
    }

    // Submit proof for task 2
    try {
      const { status } = await post(`/task/${task2_id}/submit`, {
        airtm_username: testWorker2,
        proof: 'E2E test proof task 2: um, dois, três, quatro, cinco',
      });
      if (status === 200) {
        pass('Worker 2 submits proof for task 2');
      } else {
        fail('Worker 2 submits proof for task 2', `Expected 200, got ${status}`);
      }
    } catch (e: any) {
      fail('Worker 2 submits proof for task 2', e.message);
    }

    // Reject task 2
    try {
      const { status, data } = await post('/tools/approve_task', {
        task_id: task2_id,
        approved: false,
        feedback: 'E2E test rejection',
      }, authHeaders);
      if (status === 200 && data.ok && data.message.includes('rejected')) {
        pass('approve_task approved=false → ok:true, "rejected"');
      } else {
        fail('approve_task approved=false', `Expected ok+rejected message, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('approve_task approved=false', e.message);
    }

    // Verify task 2 is re-opened
    try {
      const { status, data } = await post('/tools/get_task_status', { task_id: task2_id }, authHeaders);
      if (status === 200 && data.status === 'open' && data.workers_completed === 0) {
        pass('get_task_status after rejection → status:open, workers_completed:0 (re-opened)');
      } else {
        fail('get_task_status after rejection', `Expected status:open + workers_completed:0, got ${status}: ${JSON.stringify(data)}`);
      }
    } catch (e: any) {
      fail('get_task_status after rejection', e.message);
    }
  } else {
    ['Worker 2 accepts task 2', 'Worker 2 submits proof', 'approve_task approved=false', 'Task re-opened after rejection'].forEach(t => {
      fail(t + ' (skipped)', 'task2_id not set');
    });
  }

  // ─────────────────────────────────────────────────
  // SECTION 7: Edge cases
  // ─────────────────────────────────────────────────
  console.log('\n[7] Edge cases');

  // GET nonexistent task
  try {
    const { status } = await get('/task/nonexistent-task-id-12345');
    if (status === 404) {
      pass('GET /task/nonexistent → 404');
    } else {
      fail('GET /task/nonexistent', `Expected 404, got ${status}`);
    }
  } catch (e: any) {
    fail('GET /task/nonexistent', e.message);
  }

  // approve_task on nonexistent task
  try {
    const { status, data } = await post('/tools/approve_task', { task_id: 'fake-id', approved: true }, authHeaders);
    if (status === 404 && data.error) {
      pass('approve_task on nonexistent task → 404');
    } else {
      fail('approve_task on nonexistent task', `Expected 404, got ${status}: ${JSON.stringify(data)}`);
    }
  } catch (e: any) {
    fail('approve_task on nonexistent task', e.message);
  }

  // approve_task missing required fields
  try {
    const { status, data } = await post('/tools/approve_task', { task_id: 'some-id' }, authHeaders);
    if (status === 400 && data.error) {
      pass('approve_task missing approved field → 400');
    } else {
      fail('approve_task missing approved field', `Expected 400, got ${status}: ${JSON.stringify(data)}`);
    }
  } catch (e: any) {
    fail('approve_task missing approved field', e.message);
  }

  // ─────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────
  const total = passed + failed;
  console.log('\n' + '─'.repeat(55));
  console.log('Results:');
  results.forEach(r => console.log(r));
  console.log('─'.repeat(55));
  console.log(`\n${passed}/${total} passed${failed > 0 ? ` | ${failed} failed ❌` : ' ✅'}\n`);

  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch(e => {
  console.error('Fatal test error:', e);
  process.exitCode = 1;
});
