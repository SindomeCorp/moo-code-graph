import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";

export class JsonlWriter<T> {
  private stream: WriteStream | undefined;
  private readonly ready: Promise<void>;

  constructor(
    private readonly path: string,
    private readonly pretty = false
  ) {
    this.ready = mkdir(dirname(this.path), { recursive: true }).then(() => {
      this.stream = createWriteStream(this.path, { encoding: "utf8" });
    });
  }

  async write(record: T): Promise<void> {
    await this.ready;
    const stream = this.stream!;
    const line = `${JSON.stringify(record)}\n`;
    if (!stream.write(line)) await once(stream, "drain");
  }

  async close(): Promise<void> {
    await this.ready;
    const stream = this.stream!;
    stream.end();
    await once(stream, "finish");
  }
}
