'use strict';
// SQLite（Node 22 内置 node:sqlite）连接与建表
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  note TEXT,
  page_count INTEGER,
  char_count INTEGER,
  stored_path TEXT,
  pages_json TEXT,
  uploaded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  page INTEGER,
  section TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_material ON chunks(material_id);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  tokens INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_material ON notes(material_id);
CREATE TABLE IF NOT EXISTS knowledge_points (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_chunk_id TEXT,
  mastery INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  last_result TEXT,
  streak_correct INTEGER NOT NULL DEFAULT 0,
  interval_step INTEGER NOT NULL DEFAULT 0,
  next_review_at TEXT,
  last_reviewed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(material_id, name)
);
CREATE INDEX IF NOT EXISTS idx_kp_material ON knowledge_points(material_id);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  knowledge_point_id TEXT,
  type TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT,
  answer_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT '中等',
  source_chunk_id TEXT,
  source_page INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_material ON questions(material_id);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  knowledge_point_id TEXT,
  user_answer_json TEXT NOT NULL,
  is_correct INTEGER,
  score INTEGER,
  ai_comment TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  time_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id);
CREATE TABLE IF NOT EXISTS qa_logs (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  material_ids TEXT,
  insufficient INTEGER NOT NULL DEFAULT 0,
  sources_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_logs (
  id TEXT PRIMARY KEY,
  knowledge_point_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_logs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function getDb() {
  if (!db) {
    db = new DatabaseSync(config.dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    migrate();
  }
  return db;
}

// 轻量迁移：为旧数据库补充新增列
function migrate() {
  const cols = db.prepare('PRAGMA table_info(materials)').all().map((c) => c.name);
  if (!cols.includes('note')) {
    db.exec('ALTER TABLE materials ADD COLUMN note TEXT');
  }
}

function resetAllTables() {
  const d = getDb();
  const tables = [
    'materials', 'chunks', 'notes', 'knowledge_points', 'questions',
    'attempts', 'qa_logs', 'review_logs', 'ai_logs', 'ai_cache', 'sessions',
  ];
  for (const t of tables) d.exec(`DELETE FROM ${t};`);
}

module.exports = { getDb, resetAllTables };
