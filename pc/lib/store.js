'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Append-only JSONL store. One line per record so a crash mid-write can at
 * worst lose the final line, never the whole queue.
 */
class LineStore {
  constructor(file, { keep = 1000 } = {}) {
    this.file = file;
    this.keep = keep;
    this.records = [];
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.records = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && typeof rec === 'object' && rec.id) this.records.push(rec);
        } catch {
          // torn trailing line from a hard kill: skip it, keep the rest
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.records = [];
    }
    return this.records;
  }

  append(record) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    this.records.push(record);
    if (this.records.length > this.keep) this.compact();
    return record;
  }

  find(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  update(id, patch) {
    const rec = this.find(id);
    if (!rec) return null;
    Object.assign(rec, patch);
    this._rewrite();
    return rec;
  }

  byStatus(...statuses) {
    return this.records.filter((r) => r.kind === 'utterance' && statuses.includes(r.status));
  }

  compact() {
    this.records = this.records.slice(-this.keep);
    this._rewrite();
  }

  _rewrite() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { LineStore };
