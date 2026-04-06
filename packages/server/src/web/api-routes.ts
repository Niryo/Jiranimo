import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import type { PipelineManager } from '../pipeline/manager.js';
import type { StateStore } from '../state/store.js';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? '');
}

function isRepoConfirmationAction(value: unknown): value is 'confirm' | 'change' | 'cancel' | 'pause' {
  return value === 'confirm' || value === 'change' || value === 'cancel' || value === 'pause';
}

export function createApiRouter(store: StateStore, pipeline: PipelineManager): Router {
  const router = Router();

  // POST /api/tasks — submit a new task
  router.post('/tasks', (req: Request, res: Response) => {
    const body = req.body;

    if (!body.key || !body.summary || !body.priority || !body.issueType || !body.jiraUrl) {
      res.status(400).json({ error: 'Missing required fields: key, summary, priority, issueType, jiraUrl' });
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

  router.post('/tasks/:key/repo-confirmation', (req: Request, res: Response) => {
    const action = req.body?.action;
    if (!isRepoConfirmationAction(action)) {
      res.status(400).json({ error: 'action must be one of: confirm, change, cancel, pause' });
      return;
    }

    try {
      const result = pipeline.resolveRepoConfirmation(param(req.params.key), {
        action,
        repoName: typeof req.body?.repoName === 'string' ? req.body.repoName : undefined,
      });
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found') || message.includes('not waiting')) {
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

  router.post('/tasks/:key/continue-work', async (req: Request, res: Response) => {
    const key = param(req.params.key);
    try {
      const result = await pipeline.continueTask(key, {
        summary: typeof req.body?.summary === 'string' ? req.body.summary : undefined,
        description: typeof req.body?.description === 'string' ? req.body.description : undefined,
        acceptanceCriteria: typeof req.body?.acceptanceCriteria === 'string' ? req.body.acceptanceCriteria : undefined,
        priority: typeof req.body?.priority === 'string' ? req.body.priority : undefined,
        issueType: typeof req.body?.issueType === 'string' ? req.body.issueType : undefined,
        labels: Array.isArray(req.body?.labels) ? req.body.labels.filter((label): label is string => typeof label === 'string') : undefined,
        comments: Array.isArray(req.body?.comments) ? req.body.comments.filter((comment): comment is { author: string; body: string; created?: string } =>
          !!comment
          && typeof comment === 'object'
          && typeof comment.author === 'string'
          && typeof comment.body === 'string'
          && (comment.created === undefined || typeof comment.created === 'string'),
        ) : undefined,
        subtasks: Array.isArray(req.body?.subtasks) ? req.body.subtasks.filter((subtask): subtask is { key: string; summary: string; status: string } =>
          !!subtask
          && typeof subtask === 'object'
          && typeof subtask.key === 'string'
          && typeof subtask.summary === 'string'
          && typeof subtask.status === 'string',
        ) : undefined,
        linkedIssues: Array.isArray(req.body?.linkedIssues) ? req.body.linkedIssues.filter((issue): issue is { type: string; key: string; summary: string; status: string } =>
          !!issue
          && typeof issue === 'object'
          && typeof issue.type === 'string'
          && typeof issue.key === 'string'
          && typeof issue.summary === 'string'
          && typeof issue.status === 'string',
        ) : undefined,
        attachments: Array.isArray(req.body?.attachments) ? req.body.attachments.filter((attachment): attachment is { filename: string; mimeType: string; url: string } =>
          !!attachment
          && typeof attachment === 'object'
          && typeof attachment.filename === 'string'
          && typeof attachment.mimeType === 'string'
          && typeof attachment.url === 'string',
        ) : undefined,
        assignee: typeof req.body?.assignee === 'string' ? req.body.assignee : undefined,
        reporter: typeof req.body?.reporter === 'string' ? req.body.reporter : undefined,
        components: Array.isArray(req.body?.components) ? req.body.components.filter((component): component is string => typeof component === 'string') : undefined,
        parentKey: typeof req.body?.parentKey === 'string' ? req.body.parentKey : undefined,
        jiraUrl: typeof req.body?.jiraUrl === 'string' ? req.body.jiraUrl : undefined,
      });
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
