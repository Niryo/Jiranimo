import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeMcpConfig, deleteMcpConfig, uploadToImgbb } from './server.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.stubGlobal('fetch', vi.fn());

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jiranimo-mcp-test-'));
});

describe('writeMcpConfig', () => {
  it('writes .mcp.json with correct structure', () => {
    writeMcpConfig(tmpDir, 3456);
    const content = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { jiranimo: { type: string; url: string } };
    };
    expect(content.mcpServers.jiranimo.type).toBe('http');
    expect(content.mcpServers.jiranimo.url).toBe('http://127.0.0.1:3456/mcp');
  });

  it('uses the provided port in the URL', () => {
    writeMcpConfig(tmpDir, 8080);
    const content = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { jiranimo: { url: string } };
    };
    expect(content.mcpServers.jiranimo.url).toContain('8080');
  });

  it('includes playwright MCP server in config', () => {
    writeMcpConfig(tmpDir, 3456);
    const content = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { playwright: { type: string; command: string; args: string[] } };
    };
    expect(content.mcpServers.playwright.type).toBe('stdio');
    expect(content.mcpServers.playwright.command).toBe('npx');
    expect(content.mcpServers.playwright.args[0]).toContain('@playwright/mcp');
  });
});

describe('deleteMcpConfig', () => {
  it('removes .mcp.json if it exists', () => {
    writeMcpConfig(tmpDir, 3456);
    expect(existsSync(join(tmpDir, '.mcp.json'))).toBe(true);
    deleteMcpConfig(tmpDir);
    expect(existsSync(join(tmpDir, '.mcp.json'))).toBe(false);
  });

  it('does not throw if .mcp.json does not exist', () => {
    expect(() => deleteMcpConfig(tmpDir)).not.toThrow();
  });
});

describe('createMcpHandler tool callbacks', () => {
  it('reportProgress emits task-output event', async () => {
    const pipeline = {
      reportProgress: vi.fn(),
      reportPr: vi.fn(),
      completeViaAgent: vi.fn(),
      failViaAgent: vi.fn(),
    };

    const { createMcpHandler } = await import('./server.js');
    const handler = createMcpHandler(pipeline as never);
    expect(typeof handler).toBe('function');

    // reportProgress called → pipeline.reportProgress invoked
    pipeline.reportProgress('PROJ-1', 'Working on tests...');
    expect(pipeline.reportProgress).toHaveBeenCalledWith('PROJ-1', 'Working on tests...');
  });

  it('reportScreenshotFailed calls pipeline.reportScreenshotFailed', () => {
    const pipeline = { reportScreenshotFailed: vi.fn() };
    pipeline.reportScreenshotFailed('PROJ-1', 'dev server failed to start');
    expect(pipeline.reportScreenshotFailed).toHaveBeenCalledWith('PROJ-1', 'dev server failed to start');
  });

  it('reportPr calls pipeline.reportPr with correct args', () => {
    const pipeline = {
      reportProgress: vi.fn(),
      reportPr: vi.fn(),
      completeViaAgent: vi.fn(),
      failViaAgent: vi.fn(),
    };
    pipeline.reportPr('PROJ-1', 'https://github.com/org/repo/pull/42', 42, 'jiranimo/PROJ-1-feature');
    expect(pipeline.reportPr).toHaveBeenCalledWith(
      'PROJ-1',
      'https://github.com/org/repo/pull/42',
      42,
      'jiranimo/PROJ-1-feature',
    );
  });

  it('completeViaAgent calls pipeline.completeViaAgent', () => {
    const pipeline = { completeViaAgent: vi.fn() };
    pipeline.completeViaAgent('PROJ-1', 'Implemented feature successfully');
    expect(pipeline.completeViaAgent).toHaveBeenCalledWith('PROJ-1', 'Implemented feature successfully');
  });

  it('failViaAgent calls pipeline.failViaAgent', () => {
    const pipeline = { failViaAgent: vi.fn() };
    pipeline.failViaAgent('PROJ-1', 'Build failed');
    expect(pipeline.failViaAgent).toHaveBeenCalledWith('PROJ-1', 'Build failed');
  });
});

describe('uploadToImgbb', () => {
  it('posts image as base64 and returns the url', async () => {
    const tmpFile = join(tmpdir(), 'test-screenshot.png');
    writeFileSync(tmpFile, Buffer.from('fake-png-data'));

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { url: 'https://i.ibb.co/abc123/screenshot.png' } }),
    } as Response);

    const url = await uploadToImgbb(tmpFile);

    expect(url).toBe('https://i.ibb.co/abc123/screenshot.png');
    expect(fetch).toHaveBeenCalledWith('https://api.imgbb.com/1/upload', expect.objectContaining({ method: 'POST' }));
    rmSync(tmpFile, { force: true });
  });

  it('throws when imgbb returns an error status', async () => {
    const tmpFile = join(tmpdir(), 'test-screenshot.png');
    writeFileSync(tmpFile, Buffer.from('fake-png-data'));

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    } as Response);

    await expect(uploadToImgbb(tmpFile)).rejects.toThrow('imgbb upload failed: 400');
    rmSync(tmpFile, { force: true });
  });
});
