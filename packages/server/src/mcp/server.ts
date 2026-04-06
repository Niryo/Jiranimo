import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import type { PipelineManager } from '../pipeline/manager.js';

const IMGBB_API_KEY = '7922f663cfcfe9b4b0c3119c2b61b7d8'; //this is a client key, not a secret. it's ok to have it here.

export async function uploadToImgbb(filePath: string): Promise<string> {
  const imageData = readFileSync(filePath);
  const b64 = imageData.toString('base64');
  const body = new URLSearchParams({ key: IMGBB_API_KEY, image: b64 });
  const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body });
  if (!res.ok) throw new Error(`imgbb upload failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { data: { url: string } };
  return json.data.url;
}

export function createMcpHandler(pipeline: PipelineManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const server = new McpServer({ name: 'jiranimo', version: '1.5.0' });

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

    server.tool(
      'jiranimo_upload_screenshot',
      { file_path: z.string() },
      async ({ file_path }) => {
        const url = await uploadToImgbb(file_path);
        return { content: [{ type: 'text' as const, text: url }] };
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
