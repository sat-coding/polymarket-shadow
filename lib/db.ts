import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), '.data');
const DB_PATH = path.join(DATA_DIR, 'shadow.db');

// Ensure .data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      market_id TEXT,
      question TEXT,
      outcome TEXT,
      market_price REAL,
      llm_estimate REAL,
      ev REAL,
      reasoning TEXT,
      news_summary TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      market_id TEXT,
      question TEXT,
      outcome TEXT,
      entry_price REAL,
      shares REAL DEFAULT 100,
      entry_at INTEGER DEFAULT (unixepoch()),
      closed_at INTEGER,
      close_price REAL,
      status TEXT DEFAULT 'open'
    );

    CREATE TABLE IF NOT EXISTS pnl_snapshots (
      ts INTEGER PRIMARY KEY,
      realized REAL DEFAULT 0,
      unrealized REAL DEFAULT 0,
      total REAL DEFAULT 0
    );
  `);
}

export type Signal = {
  id: string;
  market_id: string;
  question: string;
  outcome: string;
  market_price: number;
  llm_estimate: number;
  ev: number;
  reasoning: string;
  news_summary: string;
  created_at: number;
};

export type Position = {
  id: string;
  market_id: string;
  question: string;
  outcome: string;
  entry_price: number;
  shares: number;
  entry_at: number;
  closed_at: number | null;
  close_price: number | null;
  status: 'open' | 'closed';
};
