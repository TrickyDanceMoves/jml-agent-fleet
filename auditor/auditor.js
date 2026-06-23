'use strict';

const Anthropic        = require('@anthropic-ai/sdk');
const readline         = require('readline');
const { execFileSync } = require('child_process');
const path             = require('path');
const fs               = require('fs');
const chalk            = require('chalk');
const boxen            = require('boxen');
const {
  collectGroundingFacts,
  groundedFallback,
  validateGroundedAssistantText,
} = require('../electron-app/lib/agent-grounding');

const AUDITOR_DIR = process.pkg
  ? path.resolve(path.dirname(process.execPath), '..')
  : __dirname;

const AGENTS_DIR = process.pkg
  ? path.resolve(path.dirname(process.execPath), '..', '..')
  : path.resolve(__dirname, '..');

const TENANT_DOMAIN = 'contoso.onmicrosoft.com';

const SYSTEM_PROMPT = `
You are the JML Audit Agent - a read-only intelligence layer over a Microsoft Entra ID tenant.
You help operators understand the state of the directory through natural language queries.

You NEVER suggest or make changes. You are strictly observational.

Tenant: ${TENANT_DOMAIN}

Available queries:
- query_user_summary: total, enabled, disabled, member, guest counts
- query_license_report: SKU seat utilization (assigned / total / available)
- query_recent_joins: accounts created in last N days
- query_recent_leavers: accounts disabled in last N days (audit log)
- query_admin_roles: all populated directory roles and members
- query_group_summary: group type breakdown (unified/dynamic/security)
- query_jml_activity: recent JML agent operations from local audit log
- query_stale_accounts: enabled accounts with no recent sign-in
- query_guest_users: external/guest accounts
- query_member_users: member/regular accounts, optionally enabled only

Guidelines:
- Pick the most relevant tool(s) for the question
- Present numbers prominently - they are most useful
- If a query fails due to missing permissions, explain and suggest resolution
- Offer follow-up queries when results suggest something worth investigating
- Cross-reference queries when useful (e.g. stale accounts + recent leavers)
- Never provide tenant counts, UPNs, names, or lists unless they appear in the latest tool result
- For standard/regular users, call query_member_users
`;

const TOOLS = [
  {
    name: 'query_user_summary',
    description: 'Get a count breakdown of all users: total, enabled, disabled, members, guests.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'query_license_report',
    description: 'Show all license SKUs with assigned counts, total seats, and available seats.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'query_recent_joins',
    description: 'List accounts created within the last N days.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Lookback window in days (default 30)' },
        topN: { type: 'integer', description: 'Maximum results (default 20)' }
      },
      required: []
    }
  },
  {
    name: 'query_recent_leavers',
    description: 'List accounts disabled within the last N days, sourced from the directory audit log.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Lookback window in days (default 30)' },
        topN: { type: 'integer', description: 'Maximum results (default 20)' }
      },
      required: []
    }
  },
  {
    name: 'query_admin_roles',
    description: 'List all populated directory roles and their members.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'query_group_summary',
    description: 'Get a summary of all groups: total, M365 unified, dynamic membership, and security groups.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'query_jml_activity',
    description: 'Show recent operations from the JML agent audit log (joiner/mover/leaver/enroller).',
    input_schema: {
      type: 'object',
      properties: {
        topN: { type: 'integer', description: 'Number of recent entries (default 20)' }
      },
      required: []
    }
  },
  {
    name: 'query_stale_accounts',
    description: 'Find enabled accounts with no sign-in activity in the last N days.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Inactivity threshold in days (default 90)' },
        topN: { type: 'integer', description: 'Maximum results (default 20)' }
      },
      required: []
    }
  },
  {
    name: 'query_guest_users',
    description: 'List external/guest accounts in the tenant.',
    input_schema: {
      type: 'object',
      properties: {
        topN: { type: 'integer', description: 'Maximum results (default 20)' }
      },
      required: []
    }
  },
  {
    name: 'query_member_users',
    description: 'List member/regular accounts in the tenant, optionally only enabled accounts.',
    input_schema: {
      type: 'object',
      properties: {
        topN: { type: 'integer', description: 'Maximum results (default 20)' },
        enabledOnly: { type: 'boolean', description: 'Only return enabled member accounts' }
      },
      required: []
    }
  }
];

const QUERY_TYPE_MAP = {
  query_user_summary:   'UserSummary',
  query_license_report: 'LicenseReport',
  query_recent_joins:   'RecentJoins',
  query_recent_leavers: 'RecentLeavers',
  query_admin_roles:    'AdminRoles',
  query_group_summary:  'GroupSummary',
  query_jml_activity:   'JMLActivity',
  query_stale_accounts: 'StaleAccounts',
  query_guest_users:    'GuestUsers',
  query_member_users:   'MemberUsers'
};

function collectConversationToolContents(messages) {
  const contents = [];
  for (const msg of messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && block.type === 'tool_result') contents.push(block.content);
    }
  }
  return contents;
}

function printAssistantText(text) {
  process.stdout.write('\n');
  for (const line of text.split('\n')) {
    const fmt = line.replace(/\*\*([^*]+)\*\*/g, (_, t) => chalk.bold(t));
    console.log('  ' + fmt);
  }
}

function runQuery(toolName, input) {
  const script = path.join(AUDITOR_DIR, 'Invoke-AuditorQuery.ps1');
  if (!fs.existsSync(script)) throw new Error('Invoke-AuditorQuery.ps1 not found at: ' + script);

  const queryType = QUERY_TYPE_MAP[toolName];
  const args = ['-NonInteractive', '-File', script, '-QueryType', queryType];
  if (input.days) args.push('-Days', String(input.days));
  if (input.topN) args.push('-TopN',  String(input.topN));
  if (input.enabledOnly !== undefined) args.push('-EnabledOnly', String(!!input.enabledOnly));

  const raw = execFileSync('powershell', args, { encoding: 'utf8', timeout: 60000 });
  const jsonLine = raw.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
  if (!jsonLine) return { error: 'No JSON output from query' };
  return JSON.parse(jsonLine);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('ERROR: ANTHROPIC_API_KEY environment variable not set.'); process.exit(1); }

const client = new (require('@anthropic-ai/sdk').default)({ apiKey });

async function runAuditLoop(messages) {
  while (true) {
    const resp = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages
    });

    const assistantContent = [];
    for (const block of resp.content) {
      assistantContent.push(block);
    }

    const textBlocks = assistantContent.filter(block => block.type === 'text');
    if (textBlocks.length) {
      const text = textBlocks.map(block => block.text || '').join('');
      const facts = collectGroundingFacts(collectConversationToolContents(messages));
      const validation = validateGroundedAssistantText(text, facts);
      const safeText = validation.ok ? text : groundedFallback(validation.reason);
      for (let i = assistantContent.length - 1; i >= 0; i--) {
        if (assistantContent[i].type === 'text') assistantContent.splice(i, 1);
      }
      assistantContent.push({ type: 'text', text: safeText });
      printAssistantText(safeText);
    }

    messages.push({ role: 'assistant', content: assistantContent });
    if (resp.stop_reason === 'end_turn') break;

    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      process.stdout.write('  ' + chalk.dim('querying ' + QUERY_TYPE_MAP[block.name] + '...'));
      let result;
      try {
        result = runQuery(block.name, block.input || {});
        process.stdout.write(' ' + chalk.green('done') + '\n');
      } catch (err) {
        process.stdout.write(' ' + chalk.red('failed') + '\n');
        result = { error: err.message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    } else {
      break;
    }
  }
}

async function main() {
  console.log(boxen(
    chalk.bold('JML Audit Agent') + '\n' +
    chalk.dim('Tenant: ' + TENANT_DOMAIN) + '\n\n' +
    chalk.cyan('Read-only  --  no changes will be made'),
    { padding: 1, borderStyle: 'round', borderColor: 'cyan' }
  ));
  console.log(chalk.dim("  Type 'exit' to quit.\n"));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const messages = [];

  const prompt = () => {
    rl.question(chalk.cyan('Operator') + chalk.dim(' > '), async (input) => {
      input = input.trim();
      if (!input) { prompt(); return; }
      if (input.toLowerCase() === 'exit') { rl.close(); return; }

      messages.push({ role: 'user', content: input });
      try {
        await runAuditLoop(messages);
      } catch (err) {
        console.error(chalk.red('\n  Error: ' + err.message));
      }
      console.log();
      prompt();
    });
  };

  prompt();
}

main().catch(err => { console.error(chalk.red('Fatal: ' + err.message)); process.exit(1); });
