import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { PipelineManager } from '../pipeline/manager.js';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export class WsHandler {
  private wss: WebSocketServer;

  constructor(server: Server, pipeline: PipelineManager) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    pipeline.on('sync-needed', (serverEpoch: number, revision: number) => {
      this.send({ type: 'sync-needed', serverEpoch, revision });
    });
  }

  send(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  get server(): WebSocketServer {
    return this.wss;
  }
}

export function attachWebSocket(server: Server, pipeline: PipelineManager): WsHandler {
  return new WsHandler(server, pipeline);
}
