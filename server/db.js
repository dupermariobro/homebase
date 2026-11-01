import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('adult','child')),
  birthday TEXT,
  color TEXT NOT NULL,
  rewards_enabled INTEGER NOT NULL DEFAULT 0,
  ical_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chores (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  points INTEGER NOT NULL DEFAULT 1,
  schedule_type TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_type IN ('daily','weekdays')),
  days TEXT NOT NULL DEFAULT '',
  icon TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS chore_completions (
  id INTEGER PRIMARY KEY,
  chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  points INTEGER NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (chore_id, date)
);
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  cost INTEGER NOT NULL,
  icon TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY,
  reward_id INTEGER REFERENCES rewards(id) ON DELETE SET NULL,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  cost INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meals (
  date TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT,
  ingredients TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  title TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT
);
CREATE INDEX IF NOT EXISTS events_start ON events(start);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export const SEED_PEOPLE = [
  { name: 'Alex', role: 'adult', birthday: '1985-03-12', color: 'blue', rewards_enabled: 0 },
  { name: 'Sam', role: 'adult', birthday: '1986-08-20', color: 'green', rewards_enabled: 0 },
  { name: 'Jordan', role: 'child', birthday: '2008-02-02', color: 'teal', rewards_enabled: 0 },
  { name: 'Riley', role: 'child', birthday: '2014-10-05', color: 'purple', rewards_enabled: 1 },
  { name: 'Casey', role: 'child', birthday: '2018-04-22', color: 'orange', rewards_enabled: 1 },
  { name: 'Family', role: 'calendar', birthday: null, color: 'amber', rewards_enabled: 0 },
];

// Starter content so the board isn't empty on day one; everything is editable in the app.
const SEED_CHORES = [
  ['Make bed', 'Casey', 1, 'daily', ''],
  ['Brush teeth', 'Casey', 1, 'daily', ''],
  ['Toys away', 'Casey', 2, 'daily', ''],
  ['Feed the pets', 'Riley', 2, 'daily', ''],
  ['Unload dishwasher', 'Riley', 3, 'weekdays', '1,3,5'],
  ['Homework', 'Riley', 2, 'weekdays', '1,2,3,4,5'],
  ['Take out trash', 'Jordan', 2, 'weekdays', '2'],
  ['Mow the lawn', 'Jordan', 5, 'weekdays', '6'],
];
const SEED_REWARDS = [
  ['30 min extra screen time', 15],
  ['Pick dinner', 25],
  ['Stay up 30 min late', 30],
  ['Trip for ice cream', 50],
];

// v2: calendar-only members, rotation/approval, tasks, local events, recipes,
// photos, notes, countdowns, reminders. Runs once per database (user_version).
function migrateV2(db) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE people_v2 (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('adult','child','calendar')),
        birthday TEXT,
        color TEXT NOT NULL,
        rewards_enabled INTEGER NOT NULL DEFAULT 0,
        ical_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        ntfy_topic TEXT
      );
      INSERT INTO people_v2 (id, name, role, birthday, color, rewards_enabled, ical_url, sort_order)
        SELECT id, name, role, birthday, color, rewards_enabled, ical_url, sort_order FROM people;
      DROP TABLE people;
      ALTER TABLE people_v2 RENAME TO people;

      ALTER TABLE chores ADD COLUMN rotation TEXT NOT NULL DEFAULT '';
      ALTER TABLE chores ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chore_completions ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
      ALTER TABLE meals ADD COLUMN recipe_id INTEGER;

      CREATE TABLE IF NOT EXISTS local_events (
        id INTEGER PRIMARY KEY,
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
        due_date TEXT,
        points INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        done_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS recipes (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        ingredients TEXT NOT NULL DEFAULT '[]',
        instructions TEXT,
        source_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        uploaded_by INTEGER REFERENCES people(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL,
        person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
        expires_on TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS countdowns (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        icon TEXT
      );
      CREATE TABLE IF NOT EXISTS reminders_sent (
        key TEXT PRIMARY KEY,
        sent_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  })();
  db.pragma('foreign_keys = ON');
}

// v3: paired devices for away-from-home access (see remote.js).
function migrateV3(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT
    );
    CREATE TABLE IF NOT EXISTS pair_codes (
      code_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// v4: repeating Homebase events.
function migrateV4(db) {
  db.exec(`
    ALTER TABLE local_events ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE local_events ADD COLUMN repeat_until TEXT;
  `);
}

const MIGRATIONS = [null, null, migrateV2, migrateV3, migrateV4]; // index = target user_version

export function openDb(file = process.env.HOMEBASE_DB || path.resolve('data/family.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  let version = db.pragma('user_version', { simple: true });
  if (version === 0) version = 1; // v1 schema was just ensured above
  for (let v = version + 1; v < MIGRATIONS.length; v++) {
    MIGRATIONS[v](db);
    db.pragma(`user_version = ${v}`);
  }
  return db;
}

export function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM people').get().n > 0) return false;
  const tx = db.transaction(() => {
    const insPerson = db.prepare(
      'INSERT INTO people (name, role, birthday, color, rewards_enabled, sort_order) VALUES (?,?,?,?,?,?)'
    );
    const ids = {};
    SEED_PEOPLE.forEach((p, i) => {
      ids[p.name] = insPerson.run(p.name, p.role, p.birthday, p.color, p.rewards_enabled, i).lastInsertRowid;
    });
    const insChore = db.prepare(
      'INSERT INTO chores (title, person_id, points, schedule_type, days) VALUES (?,?,?,?,?)'
    );
    for (const [title, who, pts, type, days] of SEED_CHORES) insChore.run(title, ids[who], pts, type, days);
    const insReward = db.prepare('INSERT INTO rewards (title, cost) VALUES (?,?)');
    for (const [title, cost] of SEED_REWARDS) insReward.run(title, cost);
    db.prepare("INSERT INTO lists (name, sort_order) VALUES ('Groceries', 0)").run();
  });
  tx();
  return true;
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, String(value));
  }
}
