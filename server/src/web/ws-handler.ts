import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { PipelineManager } from '../pipeline/manager.js';
import type { TaskRecord, TaskStatus } from '../state/types.js';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * WebSocket handler with offline message queue.
 * When no clients are connected, messages are queued.
 * When a client reconnects, all queued messages are delivered.
 */
export class WsHandler {
  private wss: WebSocketServer;
  private offlineQueue: WsMessage[] = [];
  private maxQueueSize = 1000;

  constructor(server: Server, pipeline: PipelineManager) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (client) => {
      console.log('[WS] Client connected, draining offline queue:', this.offlineQueue.length, 'messages');
      this.drainQueue(client);
    });

    // Pipeline events → broadcast or queue
    pipeline.on('task-created', (task: TaskRecord) => {
      this.send({ type: 'task-created', task });
    });

    pipeline.on('task-status-changed', (task: TaskRecord, oldStatus: TaskStatus) => {
      this.send({ type: 'task-status-changed', taskKey: task.key, oldStatus, newStatus: task.status, task });

      // Tell extension to update Jira status — extension uses its board config to pick the right transition
      if (task.status === 'in-progress' || task.status === 'completed' || task.status === 'failed') {
        this.send({ type: 'update-jira-status', issueKey: task.key, pipelineStatus: task.status });
      }
    });

    pipeline.on('task-output', (taskKey: string, line: string) => {
      this.send({ type: 'task-output', taskKey, line });
    });

    pipeline.on('task-completed', (task: TaskRecord) => {
      this.send({ type: 'task-completed', task });
    });

    pipeline.on('task-plan-ready', (taskKey: string, planContent: string) => {
      this.send({ type: 'task-plan-ready', taskKey, planContent });
    });
  }

  /** Send a message to all connected clients, or queue it if none are connected. */
  send(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    let delivered = false;

    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
        delivered = true;
      }
    }

    if (!delivered) {
      this.enqueue(msg);
    }
  }

  private enqueue(msg: WsMessage): void {
    // Don't queue noisy output messages
    if (msg.type === 'task-output') return;

    this.offlineQueue.push(msg);
    if (this.offlineQueue.length > this.maxQueueSize) {
      this.offlineQueue.shift();
    }
  }

  /** Send all queued messages to a newly connected client. */
  private drainQueue(client: WebSocket): void {
    for (const msg of this.offlineQueue) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg));
      }
    }
    this.offlineQueue = [];
  }

  get queueLength(): number {
    return this.offlineQueue.length;
  }

  get server(): WebSocketServer {
    return this.wss;
  }
}

/** Convenience function matching the old API */
export function attachWebSocket(server: Server, pipeline: PipelineManager): WsHandler {
  return new WsHandler(server, pipeline);
}
