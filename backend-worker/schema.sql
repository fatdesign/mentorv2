-- SQLite Database Schema für Cloudflare D1
-- ==========================================================================

-- 1. Tabelle für Profile (Jugendliche & Eltern)
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('teen', 'parent')),
  parent_code TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabelle für geschützte Nachrichten (Asymmetrisches Konzept)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  sender_role TEXT NOT NULL CHECK(sender_role IN ('child', 'mentor')),
  text TEXT NOT NULL,
  is_hidden_from_parent BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- 3. Tabelle für gebuchte Kalender-Termine
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  day_num INTEGER NOT NULL CHECK(day_num >= 1 AND day_num <= 31),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
