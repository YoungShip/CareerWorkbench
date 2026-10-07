#!/usr/bin/env node
'use strict';
// CareerWorkbench MCP server（stdio）：把主表与 discovery 的读接口、主表的预览/提交暴露为 MCP 工具。
// stdout 只承载 JSON-RPC，任何诊断信息只写 stderr。
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { STATUSES } = require('../dashboard/store');
const { createToolHandlers } = require('./tools');

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const plan = z
  .object({
    expected_revision: z
      .string()
      .min(1)
      .describe('tracker_query / tracker_validate 返回的最新整体 revision'),
    operations: z
      .array(
        z
          .object({
            type: z
              .string()
              .describe(
                'job.add / job.patch / log.add / event.add / event.patch / event.delete / table.upsert'
              ),
          })
          .passthrough()
      )
      .min(1),
  })
  .strict()
  .describe('主表事务计划，结构见 references/local-tracker.md；不接受 runtime 等额外根字段');

function reply(fn) {
  return async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await fn(args || {}), null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  };
}

function createServer(options = {}) {
  const h = createToolHandlers(options);
  const server = new McpServer({ name: 'career-workbench', version: '0.1.0' });
  server.registerTool(
    'tracker_brief',
    {
      title: '主表行动摘要',
      description:
        '会话开始先调用：汇总临期/过期事项、待补救、时间未知、待投规则冲突、discovery 临近截止线索与同步积压。只读；不是投递授权或写入计划。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('每类最多条数，默认 8'),
      },
      annotations: READ_ONLY,
    },
    reply(h.brief)
  );
  server.registerTool(
    'tracker_rules',
    {
      title: '当前选岗规则与经历边界',
      description:
        '公司研究前调用：从求职档案动态提取「选岗规则」「经历与表述边界」两段。只读，不含联系方式与公司历史。',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    reply(h.rules)
  );
  server.registerTool(
    'tracker_query',
    {
      title: '按需查询岗位',
      description:
        '常规查询入口：按 job_id / 公司 / 状态过滤并投影字段，返回与全量快照同一口径的 revision（写入计划的 expected_revision 用它）。默认不含 JD 与备注；已知对象时务必过滤，避免把全表灌入上下文。未返回的字段不等于空值。',
      inputSchema: {
        job_ids: z.array(z.string()).optional(),
        company: z.string().optional().describe('公司名，精确匹配'),
        status: z.enum(STATUSES).optional(),
        fields: z.array(z.string()).optional().describe('投影字段；默认 15 个常用字段'),
        include_description: z.boolean().optional().describe('附带完整 JD 与事件备注'),
        with_events: z.boolean().optional().describe('是否附带关联日程，默认 true'),
      },
      annotations: READ_ONLY,
    },
    reply(h.query)
  );
  server.registerTool(
    'tracker_validate',
    {
      title: '主表校验',
      description:
        '校验八表完整性，返回 revision、各表行数与告警（如同公司同名岗位）。代替 1MB 的全量快照做轻量审计。',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    reply(h.validate)
  );
  server.registerTool(
    'discovery_next',
    {
      title: '待研究线索队列',
      description:
        '查看尚未研究的公司线索：临近截止候选、运行断点与待研究队列。文本提取的截止只作待确认信号，必须回官方来源核实。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        horizon_hours: z
          .number()
          .int()
          .min(1)
          .max(24 * 60)
          .optional()
          .describe('临近截止窗口，默认 168 小时'),
      },
      annotations: READ_ONLY,
    },
    reply(h.discoveryNext)
  );
  server.registerTool(
    'discovery_query',
    {
      title: '查询公司线索',
      description: '按 lead_id / 状态 / 公司定向读取 discovery 线索。未研究线索不在投递主表中。',
      inputSchema: {
        lead_ids: z.array(z.string()).optional(),
        states: z.array(z.string()).optional(),
        company: z.string().optional(),
        fields: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: READ_ONLY,
    },
    reply(h.discoveryQuery)
  );
  server.registerTool(
    'tracker_preview',
    {
      title: '预览主表写入',
      description:
        '写主表的第一步：对计划做完整校验与差异预览，不改数据，返回 preview_token（10 分钟有效，绑定这份计划）。新研究岗位登记仍须本人选定；由未投变 Submitted 必须带真实投递证据。job.delete 与 sync.ack 不经 MCP。',
      inputSchema: { plan },
      annotations: READ_ONLY,
    },
    reply(h.preview)
  );
  server.registerTool(
    'tracker_apply',
    {
      title: '提交主表写入',
      description:
        '写主表的第二步：只接受与 tracker_preview 完全相同的计划及其 preview_token；计划被改、主表已被其他写入改变或令牌过期都会拒绝，需要重新预览。成功后自动定向读回改动字段，改动进入 sync_queue 待同步 OfferNotes。',
      inputSchema: { plan, preview_token: z.string().describe('tracker_preview 返回的令牌') },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    reply(h.apply)
  );
  return server;
}

if (require.main === module) {
  createServer()
    .connect(new StdioServerTransport())
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { createServer };
