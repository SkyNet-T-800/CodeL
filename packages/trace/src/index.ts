import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentEvent, EventSink } from "@repo-circuit/core";

export class JsonlEventWriter implements EventSink {
  readonly #handle: FileHandle;
  #closed = false;

  private constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  static async create(filePath: string): Promise<JsonlEventWriter> {
    await mkdir(dirname(filePath), { recursive: true });
    const handle = await open(filePath, "w");
    return new JsonlEventWriter(handle);
  }

  async append(event: AgentEvent): Promise<void> {
    if (this.#closed) {
      throw new Error("Cannot append to a closed JSONL event writer");
    }
    await this.#handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      await this.#handle.close();
    }
  }
}