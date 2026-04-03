import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import type { PipelineManager } from '../pipeline/manager.js';
import type { StateStore } from '../state/store.js';
import type { JiraBoardType } from '../state/types.js';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? '');
}

function isBoardType(value: unknown): value is JiraBoardType {
  return value === 'scrum' || value === 'kanban';
}

export function createApiRouter(store: StateStore, pipeline: PipelineManager): Router {
  const router = Router();

  // POST /api/tasks — submit a new task
  router.post('/tasks', (req: Request, res: Response) => {
    const body = req.body;

    if (!body.key || !body.summary || !body.priority || !body.issueType || !body.jiraUrl || !body.boardId || !isBoardType(body.boardType)) {
      res.status(400).json({ error: 'Missing required fields: key, summary, priority, issueType, jiraUrl, boardId, boardType' });
      return;
    }

    try {
      const task = pipeline.submitTask({
        key: body.key,
        summary: body.summary,
        description: body.description || body.summary,
        acceptanceCriteria: body.acceptanceCriteria,
        priority: body.priority,
        issueType: body.issueType,
        labels: body.labels ?? [],
        comments: body.comments ?? [],
        subtasks: body.subtasks,
        linkedIssues: body.linkedIssues,
        attachments: body.attachments,
        assignee: body.assignee,
        reporter: body.reporter,
        components: body.components,
        parentKey: body.parentKey,
        jiraUrl: body.jiraUrl,
        boardId: body.boardId,
        boardType: body.boardType,
        projectKey: typeof body.projectKey === 'string' ? body.projectKey : undefined,
      });
      res.status(201).json(task);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('already')) {
        res.status(409).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // GET /api/tasks — list all tasks
  router.get('/tasks', (_req: Request, res: Response) => {
    const tasks = store.getAllTasks();
    res.json(tasks);
  });

  router.get('/sync', (req: Request, res: Response) => {
    const jiraHost = typeof req.query.jiraHost === 'string' ? req.query.jiraHost : undefined;
    res.json(pipeline.getSyncSnapshot(jiraHost));
  });

  router.put('/boards/:boardId/presence', (req: Request, res: Response) => {
    const boardId = param(req.params.boardId);
    const jiraHost = req.body?.jiraHost;
    const boardType = req.body?.boardType;
    const issueKeys = req.body?.issueKeys;

    if (!boardId || typeof jiraHost !== 'string' || !isBoardType(boardType) || !Array.isArray(issueKeys)) {
      res.status(400).json({ error: 'Missing required fields: jiraHost, boardType, issueKeys' });
      return;
    }

    try {
      const result = pipeline.syncBoardPresence({
        boardId,
        jiraHost,
        boardType,
        projectKey: typeof req.body?.projectKey === 'string' ? req.body.projectKey : undefined,
        issueKeys: issueKeys.filter((issueKey): issueKey is string => typeof issueKey === 'string'),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/tasks/:key — get single task
  router.get('/tasks/:key', (req: Request, res: Response) => {
    const key = param(req.params.key);
    const task = store.getTask(key);
    if (!task) {
      res.status(404).json({ error: `Task ${key} not found` });
      return;
    }
    res.json(task);
  });

  // POST /api/tasks/:key/retry — retry a failed task
  router.post('/tasks/:key/retry', (req: Request, res: Response) => {
    const key = param(req.params.key);
    try {
      const task = pipeline.retryTask(key);
      res.json(task);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(400).json({ error: message });
      }
    }
  });

  router.post('/tasks/:key/fix-comments', async (req: Request, res: Response) => {
    const key = param(req.params.key);
    try {
      const result = await pipeline.fixGithubComments(key);
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(400).json({ error: message });
      }
    }
  });

  router.post('/tasks/:key/cancel-resume', (req: Request, res: Response) => {
    try {
      const task = pipeline.cancelResume(param(req.params.key));
      res.json(task);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(400).json({ error: message });
      }
    }
  });

  router.post('/tasks/:key/resume', (req: Request, res: Response) => {
    try {
      const task = pipeline.resumeTask(param(req.params.key));
      res.json(task);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(400).json({ error: message });
      }
    }
  });

  // DELETE /api/tasks/:key — remove a task (e.g. when moved back to To Do in Jira)
  router.delete('/tasks/:key', (req: Request, res: Response) => {
    const key = param(req.params.key);
    const deleted = pipeline.deleteTask(key);
    if (deleted) {
      res.json({ deleted: true });
    } else {
      res.status(404).json({ error: `Task ${key} not found` });
    }
  });

  router.post('/effects/:id/claim', (req: Request, res: Response) => {
    const clientId = req.body?.clientId;
    if (!clientId || typeof clientId !== 'string') {
      res.status(400).json({ error: 'clientId is required' });
      return;
    }
    try {
      const effect = pipeline.claimEffect(param(req.params.id), clientId);
      res.json(effect);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(409).json({ error: message });
      }
    }
  });

  router.post('/effects/:id/ack', (req: Request, res: Response) => {
    const acked = pipeline.ackEffect(param(req.params.id));
    res.json({ acked });
  });

  // GET /api/tasks/:key/compact-log — get compact log summary
  router.get('/tasks/:key/compact-log', (req: Request, res: Response) => {
    const key = param(req.params.key);
    const task = store.getTask(key);
    if (!task) {
      res.status(404).json({ error: `Task ${key} not found` });
      return;
    }
    if (!task.compactLog) {
      res.status(404).json({ error: 'Compact log not available for this task' });
      return;
    }
    res.json({ compactLog: task.compactLog });
  });

  // GET /api/tasks/:key/logs — get task logs
  router.get('/tasks/:key/logs', (req: Request, res: Response) => {
    const key = param(req.params.key);
    const task = store.getTask(key);
    if (!task) {
      res.status(404).json({ error: `Task ${key} not found` });
      return;
    }
    if (!task.logPath) {
      res.status(404).json({ error: 'No logs available for this task' });
      return;
    }
    try {
      const content = readFileSync(task.logPath, 'utf-8');
      res.type('text/plain').send(content);
    } catch {
      res.status(404).json({ error: 'Log file not found' });
    }
  });

  return router;
}
