-- Reset - Drop tables if they exist
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS _drizzle_migrations;

-- Create users table with the exact structure from our schema
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  updated_at TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  thumbnail TEXT,
  history TEXT DEFAULT '[]' NOT NULL
);

-- Insert a test user
INSERT INTO users (name, email, history)
VALUES ('Test User', 'test@example.com', '[]');

-- Verify
SELECT * FROM users; 