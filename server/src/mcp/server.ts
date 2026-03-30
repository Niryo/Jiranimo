import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import type { PipelineManager } from '../pipeline/manager.js';

export function createMcpHandler(pipeline: PipelineManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const server = new McpServer({ name: 'jiranimo', version: '1.0.0' });

    server.tool(
      'jiranimo_progress',
      { task_key: z.string(), message: z.string() },
      async ({ task_key, message }) => {
        pipeline.reportProgress(task_key, message);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    );

    server.tool(
      'jiranimo_report_pr',
      {
        task_key: z.string(),
        pr_url: z.string(),
        pr_number: z.number().int(),
        branch_name: z.string(),
      },
      async ({ task_key, pr_url, pr_number, branch_name }) => {
        pipeline.reportPr(task_key, pr_url, pr_number, branch_name);
        return { content: [{ type: 'text' as const, text: 'PR recorded' }] };
      },
    );

    server.tool(
      'jiranimo_complete',
      { task_key: z.string(), summary: z.string() },
      async ({ task_key, summary }) => {
        pipeline.completeViaAgent(task_key, summary);
        return { content: [{ type: 'text' as const, text: 'Task marked complete' }] };
      },
    );

    server.tool(
      'jiranimo_fail',
      { task_key: z.string(), error_message: z.string() },
      async ({ task_key, error_message }) => {
        pipeline.failViaAgent(task_key, error_message);
        return { content: [{ type: 'text' as const, text: 'Task marked failed' }] };
      },
    );

    server.tool(
      'jiranimo_screenshot_failed',
      { task_key: z.string(), reason: z.string() },
      async ({ task_key, reason }) => {
        pipeline.reportScreenshotFailed(task_key, reason);
        return { content: [{ type: 'text' as const, text: 'Screenshot failure recorded' }] };
      },
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body as Record<string, unknown>);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
  };
}

export function writeMcpConfig(dir: string, port: number): void {
  const config = {
    mcpServers: {
      jiranimo: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
      },
      playwright: {
        type: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest', '--headless'],
      },
    },
  };
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify(config, null, 2));
}

export function deleteMcpConfig(dir: string): void {
  try {
    unlinkSync(join(dir, '.mcp.json'));
  } catch {
    // ignore if already deleted
  }
}
