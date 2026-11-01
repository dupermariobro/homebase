// Pure chore/points logic, kept separate from HTTP so it can be tested directly.

export function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

export function weekdayOf(dateStr) {
  // Parse as UTC midnight so the weekday never shifts with the host timezone.
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

export function parseDays(days) {
  if (!days) return [];
  return String(days)
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

export function isDue(chore, dateStr) {
  if (!chore.active) return false;
  if (chore.schedule_type === 'daily') return true;
  if (chore.schedule_type === 'weekdays') return parseDays(chore.days).includes(weekdayOf(dateStr));
  return false;
}

// Rotation weeks start on Sunday; 1970-01-04 was a Sunday.
const EPOCH_SUNDAY = Date.UTC(1970, 0, 4);

export function weekIndex(dateStr) {
  return Math.floor((Date.parse(dateStr + 'T00:00:00Z') - EPOCH_SUNDAY) / (7 * 864e5));
}

export function parseIds(csv) {
  return String(csv || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Who a chore belongs to on a date: rotating chores advance one person per week. */
export function assigneeFor(chore, dateStr) {
  const rot = parseIds(chore.rotation);
  if (rot.length < 2) return chore.person_id;
  const i = ((weekIndex(dateStr) % rot.length) + rot.length) % rot.length;
  return rot[i];
}

export function choresForDate(db, dateStr) {
  const chores = db.prepare('SELECT * FROM chores WHERE active = 1 ORDER BY id').all();
  const done = new Map(
    db
      .prepare('SELECT chore_id, completed_at, status FROM chore_completions WHERE date = ?')
      .all(dateStr)
      .map((r) => [r.chore_id, r])
  );
  return chores
    .filter((c) => isDue(c, dateStr))
    .map((c) => {
      const comp = done.get(c.id);
      return {
        ...c,
        person_id: assigneeFor(c, dateStr),
        owner_id: c.person_id,
        days: parseDays(c.days),
        rotation: parseIds(c.rotation),
        done: Boolean(comp),
        status: comp?.status || null,
        completed_at: comp?.completed_at || null,
      };
    });
}

export function balances(db) {
  const rows = db
    .prepare(
      `SELECT p.id,
         COALESCE((SELECT SUM(points) FROM chore_completions WHERE person_id = p.id AND status = 'approved'), 0)
           + COALESCE((SELECT SUM(points) FROM tasks WHERE person_id = p.id AND done_at IS NOT NULL), 0) AS earned,
         COALESCE((SELECT SUM(points) FROM chore_completions WHERE person_id = p.id AND status = 'pending'), 0) AS pending,
         COALESCE((SELECT SUM(cost) FROM redemptions WHERE person_id = p.id), 0) AS spent
       FROM people p`
    )
    .all();
  return Object.fromEntries(
    rows.map((r) => [r.id, { earned: r.earned, pending: r.pending, spent: r.spent, balance: r.earned - r.spent }])
  );
}

export function completeChore(db, choreId, dateStr, opts = {}) {
  const chore = db.prepare('SELECT * FROM chores WHERE id = ?').get(choreId);
  if (!chore) return { error: 'Chore not found', status: 404 };
  // opts.forceApproval lets a source (e.g. voice via Alexa) require a parent's OK
  // even when the chore itself auto-approves on a tablet tap.
  const status = chore.requires_approval || opts.forceApproval ? 'pending' : 'approved';
  // INSERT OR IGNORE makes a double-tap (or two devices at once) harmless.
  const res = db
    .prepare('INSERT OR IGNORE INTO chore_completions (chore_id, person_id, date, points, status) VALUES (?,?,?,?,?)')
    .run(chore.id, assigneeFor(chore, dateStr), dateStr, chore.points, status);
  return { ok: true, created: res.changes === 1, points: chore.points, status };
}

export function approveCompletion(db, choreId, dateStr) {
  const res = db
    .prepare("UPDATE chore_completions SET status = 'approved' WHERE chore_id = ? AND date = ? AND status = 'pending'")
    .run(choreId, dateStr);
  return res.changes ? { ok: true } : { error: 'Nothing waiting for approval', status: 404 };
}

export function pendingApprovals(db) {
  return db
    .prepare(
      `SELECT cc.chore_id, cc.date, cc.points, cc.person_id, c.title, p.name
       FROM chore_completions cc JOIN chores c ON c.id = cc.chore_id JOIN people p ON p.id = cc.person_id
       WHERE cc.status = 'pending' ORDER BY cc.date, cc.id`
    )
    .all();
}

/**
 * Consecutive days (ending today) on which a person finished every chore due.
 * Days with nothing due don't count or break the streak; today only counts once finished.
 */
export function streaks(db, todayStr, lookback = 60) {
  const chores = db.prepare('SELECT * FROM chores WHERE active = 1').all();
  const start = new Date(Date.parse(todayStr + 'T00:00:00Z') - lookback * 864e5).toISOString().slice(0, 10);
  const doneSet = new Set(
    db.prepare('SELECT chore_id, date FROM chore_completions WHERE date >= ?').all(start).map((r) => `${r.chore_id}|${r.date}`)
  );
  const people = db.prepare("SELECT id FROM people WHERE role != 'calendar'").all();
  const out = {};
  for (const { id } of people) {
    let streak = 0;
    for (let i = 0; i <= lookback; i++) {
      const day = new Date(Date.parse(todayStr + 'T00:00:00Z') - i * 864e5).toISOString().slice(0, 10);
      const due = chores.filter((c) => isDue(c, day) && assigneeFor(c, day) === id);
      if (due.length === 0) continue;
      const allDone = due.every((c) => doneSet.has(`${c.id}|${day}`));
      if (allDone) streak++;
      else if (i === 0) continue;
      else break;
    }
    out[id] = streak;
  }
  return out;
}

export function uncompleteChore(db, choreId, dateStr) {
  const res = db.prepare('DELETE FROM chore_completions WHERE chore_id = ? AND date = ?').run(choreId, dateStr);
  return { ok: true, removed: res.changes === 1 };
}

export function redeem(db, rewardId, personId) {
  const reward = db.prepare('SELECT * FROM rewards WHERE id = ? AND active = 1').get(rewardId);
  if (!reward) return { error: 'Reward not found', status: 404 };
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) return { error: 'Person not found', status: 404 };
  const bal = balances(db)[person.id].balance;
  if (bal < reward.cost) return { error: `${person.name} needs ${reward.cost - bal} more points`, status: 400 };
  db.prepare('INSERT INTO redemptions (reward_id, person_id, title, cost) VALUES (?,?,?,?)').run(
    reward.id,
    person.id,
    reward.title,
    reward.cost
  );
  return { ok: true, balance: bal - reward.cost };
}
