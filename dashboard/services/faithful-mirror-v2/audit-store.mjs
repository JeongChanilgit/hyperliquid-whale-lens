import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonlAuditStore {
  constructor({ eventsPath, snapshotPath }) {
    this.eventsPath = eventsPath;
    this.snapshotPath = snapshotPath;
    this.writeTail = Promise.resolve();
  }

  record(event) {
    const line = `${JSON.stringify(event)}\n`;
    this.writeTail = this.writeTail.then(async () => {
      await mkdir(dirname(this.eventsPath), { recursive: true });
      await appendFile(this.eventsPath, line, "utf8");
    });
    return this.writeTail;
  }

  writeSnapshot(snapshot) {
    this.writeTail = this.writeTail.then(async () => {
      await mkdir(dirname(this.snapshotPath), { recursive: true });
      const temporary = `${this.snapshotPath}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(temporary, this.snapshotPath);
    });
    return this.writeTail;
  }

  async close() {
    await this.writeTail;
  }
}
