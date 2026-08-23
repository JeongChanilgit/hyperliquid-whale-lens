import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class DurableMirrorStore {
  constructor(root) {
    this.root = root;
    this.eventPath = join(root, "events.jsonl");
    this.snapshotPath = join(root, "latest-state.json");
    this.writeTail = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
  }

  append(event) {
    const line = `${JSON.stringify(event)}\n`;
    this.writeTail = this.writeTail.then(async () => {
      await mkdir(dirname(this.eventPath), { recursive: true });
      await appendFile(this.eventPath, line, "utf8");
    });
    return this.writeTail;
  }

  writeSnapshot(snapshot) {
    this.writeTail = this.writeTail.then(async () => {
      await mkdir(dirname(this.snapshotPath), { recursive: true });
      const temporary = `${this.snapshotPath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(temporary, this.snapshotPath);
    });
    return this.writeTail;
  }

  async close() {
    await this.writeTail;
  }
}
