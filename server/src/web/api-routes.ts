import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import type { PipelineManager } from '../pipeline/manager.js';
import type { StateStore } from '../state/store.js';

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

  // GET /api/tasks/:key — get single task
  router.get('/tasks/:key', (req: Request, res: Response) => {
    const task = store.getTask(req.params.key);
    if (!task) {
      res.status(404).json({ error: `Task ${req.params.key} not found` });
      return;
    }
    res.json(task);
  });

  // POST /api/tasks/:key/retry — retry a failed task
  router.post('/tasks/:key/retry', (req: Request, res: Response) => {
    try {
      const task = pipeline.retryTask(req.params.key);
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
    const deleted = store.deleteTask(req.params.key);
    if (deleted) {
      res.json({ deleted: true });
    } else {
      res.status(404).json({ error: `Task ${req.params.key} not found` });
    }
  });

  // GET /api/tasks/:key/logs — get task logs
  router.get('/tasks/:key/logs', (req: Request, res: Response) => {
    const task = store.getTask(req.params.key);
    if (!task) {
      res.status(404).json({ error: `Task ${req.params.key} not found` });
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
