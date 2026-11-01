import { useState } from 'react';
import { IconChevronLeft, IconChevronRight, IconGift, IconPencil, IconPlus, IconStar, IconTrash, IconChecklist, IconShieldCheck } from '@tabler/icons-react';
import { api, useLive } from '../api.js';
import { addDays, dayKey, fmt, fromKey } from '../dates.js';
import { personVars } from '../colors.js';
import { ChoreCard, money } from '../components/shared.jsx';
import { TaskForm, TaskList, members } from '../components/extras.jsx';
import { Avatar, Modal, toast, toastError } from '../components/ui.jsx';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function scheduleLabel(c, people) {
  const when = c.schedule_type === 'daily' ? 'Every day' : [...c.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WEEKDAYS[d]).join(', ');
  if (c.rotation?.length > 1) {
    const names = c.rotation.map((id) => people.find((p) => p.id === id)?.name).filter(Boolean);
    return `${when} · rotates ${names.join(' → ')}`;
  }
  return when;
}

function ChoreForm({ people: all, chore, onDone }) {
  const people = members(all);
  const [f, setF] = useState(
    chore
      ? { ...chore, rotation: chore.rotation || [], requires_approval: Boolean(chore.requires_approval) }
      : {
          title: '',
          person_id: people.find((p) => p.role === 'child')?.id || people[0]?.id,
          points: 1,
          schedule_type: 'daily',
          days: [],
          rotation: [],
          requires_approval: false,
        }
  );
  const rotating = f.rotation.length > 1;
  const toggleRot = (id) => {
    const next = f.rotation.includes(id) ? f.rotation.filter((x) => x !== id) : [...f.rotation, id];
    setF({ ...f, rotation: next, person_id: next[0] || f.person_id });
  };
  const set = (k, v) => setF({ ...f, [k]: v });
  const save = async (e) => {
    e.preventDefault();
    try {
      if (chore) await api('PUT', `/api/chores/${chore.id}`, f);
      else await api('POST', '/api/chores', f);
      toast(chore ? 'Chore updated' : 'Chore added', 'success');
      onDone();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <form className="form" onSubmit={save}>
      <label>
        Chore
        <input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Feed the fish" autoFocus required />
      </label>
      <div className="field">
        <span className="label">Who</span>
        <div className="seg">
          <button type="button" className={!rotating ? 'on' : ''} onClick={() => setF({ ...f, rotation: [] })}>
            One person
          </button>
          <button
            type="button"
            className={rotating ? 'on' : ''}
            onClick={() => setF({ ...f, rotation: f.rotation.length > 1 ? f.rotation : people.filter((p) => p.role === 'child').map((p) => p.id) })}
          >
            Take turns weekly
          </button>
        </div>
        <div className="avatars wrap">
          {people.map((p) =>
            rotating ? (
              <span key={p.id} className="rot-pick">
                <Avatar person={p} size={48} dim={!f.rotation.includes(p.id)} onClick={() => toggleRot(p.id)} title={p.name} />
                {f.rotation.includes(p.id) && <span className="rot-order">{f.rotation.indexOf(p.id) + 1}</span>}
              </span>
            ) : (
              <Avatar key={p.id} person={p} size={48} dim={f.person_id !== p.id} onClick={() => set('person_id', p.id)} title={p.name} />
            )
          )}
        </div>
        {rotating && <span className="hint">Tap in turn order. It moves to the next person every Sunday.</span>}
      </div>
      <label>
        Points
        <input type="number" min="0" max="100" value={f.points} onChange={(e) => set('points', Number(e.target.value))} />
      </label>
      <div className="field">
        <span className="label">Repeats</span>
        <div className="seg">
          <button type="button" className={f.schedule_type === 'daily' ? 'on' : ''} onClick={() => set('schedule_type', 'daily')}>
            Every day
          </button>
          <button type="button" className={f.schedule_type === 'weekdays' ? 'on' : ''} onClick={() => set('schedule_type', 'weekdays')}>
            Certain days
          </button>
        </div>
        {f.schedule_type === 'weekdays' && (
          <div className="day-picker">
            {WEEKDAYS.map((w, i) => (
              <button
                type="button"
                key={w}
                className={f.days.includes(i) ? 'on' : ''}
                onClick={() => set('days', f.days.includes(i) ? f.days.filter((d) => d !== i) : [...f.days, i].sort())}
              >
                {w}
              </button>
            ))}
          </div>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={f.requires_approval} onChange={(e) => set('requires_approval', e.target.checked)} />
        A parent checks it before points count
      </label>
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary">{chore ? 'Save' : 'Add chore'}</button>
      </div>
    </form>
  );
}

function ManageChores({ people, onClose }) {
  const { data } = useLive('/api/chores/all', ['chores']);
  const [editing, setEditing] = useState(null); // null | 'new' | chore
  const all = (data || []).filter((c) => c.active);
  const remove = async (c) => {
    try {
      await api('DELETE', `/api/chores/${c.id}`);
      toast(`Removed "${c.title}"`);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal title={editing ? (editing === 'new' ? 'New chore' : 'Edit chore') : 'Manage chores'} onClose={onClose} wide>
      {editing ? (
        <ChoreForm people={people} chore={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
      ) : (
        <>
          <button className="btn primary" onClick={() => setEditing('new')}>
            <IconPlus size={18} /> New chore
          </button>
          {members(people).map((p) => {
            const mine = all.filter((c) => c.person_id === p.id);
            if (!mine.length) return null;
            return (
              <div key={p.id} className="manage-group" style={personVars(p.color)}>
                <h4>{p.name}</h4>
                {mine.map((c) => (
                  <div key={c.id} className="manage-row">
                    <span className="grow">{c.title}</span>
                    <span className="muted small">{scheduleLabel(c, people)}</span>
                    <span className="muted small">{c.points} {c.points === 1 ? 'pt' : 'pts'}</span>
                    <button className="icon-btn" onClick={() => setEditing(c)} aria-label={`Edit ${c.title}`}>
                      <IconPencil size={20} />
                    </button>
                    <button className="icon-btn" onClick={() => remove(c)} aria-label={`Remove ${c.title}`}>
                      <IconTrash size={20} />
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}
    </Modal>
  );
}

function RedeemModal({ reward, people, onClose }) {
  const earners = people.filter((p) => p.rewards_enabled);
  const redeem = async (p) => {
    try {
      const r = await api('POST', `/api/rewards/${reward.id}/redeem`, { person_id: p.id });
      toast(`${p.name} redeemed ${reward.title} · ${r.balance} left`, 'success');
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal title={`Redeem: ${reward.title}`} onClose={onClose}>
      <p className="muted">Costs {reward.cost} points. Who’s cashing in?</p>
      <div className="redeem-grid">
        {earners.map((p) => {
          const bal = p.points?.balance ?? 0;
          return (
            <button key={p.id} className="redeem-who" style={personVars(p.color)} disabled={bal < reward.cost} onClick={() => redeem(p)}>
              <Avatar person={p} size={44} />
              <span>{p.name}</span>
              <span className="small">{bal} pts</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

function RewardForm({ onClose }) {
  const [title, setTitle] = useState('');
  const [cost, setCost] = useState(10);
  const save = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/rewards', { title, cost });
      toast('Reward added', 'success');
      onClose();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Modal title="New reward" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <label>
          Reward
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Movie night pick" autoFocus required />
        </label>
        <label>
          Cost (points)
          <input type="number" min="1" value={cost} onChange={(e) => setCost(Number(e.target.value))} />
        </label>
        <div className="form-actions">
          <button className="btn primary">Add reward</button>
        </div>
      </form>
    </Modal>
  );
}

function Approvals({ now }) {
  const { data } = useLive('/api/chores/pending', ['chores']);
  if (!data?.length) return null;
  const approve = async (p) => {
    try {
      await api('POST', `/api/chores/${p.chore_id}/approve`, { date: p.date });
      toast(`Approved ${p.name}’s “${p.title}”`, 'success');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <section className="panel approvals">
      <h3 className="panel-title">
        <IconShieldCheck size={20} /> Waiting for a parent
      </h3>
      {data.map((p) => (
        <div key={`${p.chore_id}-${p.date}`} className="manage-row">
          <span className="grow">
            <strong>{p.name}</strong> · {p.title}
            {p.date !== dayKey(now) && <span className="muted small"> · {fmt.short(fromKey(p.date))}</span>}
          </span>
          <span className="muted small">{p.points} {p.points === 1 ? 'pt' : 'pts'}</span>
          <button className="btn small-btn primary" onClick={() => approve(p)}>
            Approve
          </button>
        </div>
      ))}
    </section>
  );
}

export default function Chores({ now, people, settings }) {
  const [date, setDate] = useState(() => dayKey(now));
  const [manage, setManage] = useState(false);
  const [redeeming, setRedeeming] = useState(null);
  const [newReward, setNewReward] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const tasks = useLive('/api/tasks?done=1', ['tasks']);
  const chores = useLive(`/api/chores?date=${date}`, ['chores']);
  const rewards = useLive('/api/rewards', ['rewards']);
  const list = chores.data?.chores || [];
  const d = fromKey(date);
  const isToday = date === dayKey(now);
  const earners = people.filter((p) => p.rewards_enabled);

  const removeReward = async (r) => {
    try {
      await api('DELETE', `/api/rewards/${r.id}`);
      toast(`Removed ${r.title}`);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="chores-view">
      <div className="toolbar">
        <button className="icon-btn" onClick={() => setDate(dayKey(addDays(d, -1)))} aria-label="Previous day">
          <IconChevronLeft />
        </button>
        <h2 className="toolbar-title">{isToday ? 'Today' : fmt.long(d)}</h2>
        <button className="icon-btn" onClick={() => setDate(dayKey(addDays(d, 1)))} aria-label="Next day">
          <IconChevronRight />
        </button>
        {!isToday && (
          <button className="btn" onClick={() => setDate(dayKey(now))}>
            Back to today
          </button>
        )}
        <span className="grow" />
        <button className="btn" onClick={() => setManage(true)}>
          <IconPencil size={18} /> Manage chores
        </button>
      </div>

      <div className="chores-layout">
        <div className="chores-main">
          <Approvals now={now} />
          <div className="board-grid">
            {members(people).map((p) => (
              <ChoreCard key={p.id} person={p} chores={list.filter((c) => c.person_id === p.id)} date={date} settings={settings} />
            ))}
          </div>
          <section className="panel">
            <div className="section-head">
              <h3 className="panel-title">
                <IconChecklist size={20} /> To-dos
              </h3>
              <button className="btn small-btn" onClick={() => setNewTask(true)}>
                <IconPlus size={18} /> New to-do
              </button>
            </div>
            <TaskList tasks={tasks.data || []} people={people} today={dayKey(now)} empty="No to-dos. One-off jobs with due dates go here." />
          </section>
        </div>

        <aside className="panel rewards">
          <h3 className="panel-title">
            <IconGift size={20} /> Rewards
          </h3>
          <div className="balances">
            {earners.map((p) => (
              <div key={p.id} className="balance" style={personVars(p.color)}>
                <Avatar person={p} size={36} />
                <span className="grow">{p.name}</span>
                <span className="points">
                  <IconStar size={18} /> {p.points?.balance ?? 0}
                  {money(p.points?.balance ?? 0, settings) && <span className="money">{money(p.points.balance, settings)}</span>}
                </span>
              </div>
            ))}
          </div>
          <ul className="reward-list">
            {(rewards.data?.rewards || []).map((r) => (
              <li key={r.id}>
                <button className="reward" onClick={() => setRedeeming(r)}>
                  <span className="grow">{r.title}</span>
                  <span className="cost">{r.cost}</span>
                </button>
                <button className="icon-btn subtle" onClick={() => removeReward(r)} aria-label={`Remove ${r.title}`}>
                  <IconTrash size={18} />
                </button>
              </li>
            ))}
          </ul>
          <button className="btn ghost" onClick={() => setNewReward(true)}>
            <IconPlus size={18} /> Add reward
          </button>
          {rewards.data?.recent?.length > 0 && (
            <>
              <h4 className="subhead">Recently redeemed</h4>
              <ul className="recent">
                {rewards.data.recent.slice(0, 5).map((r) => (
                  <li key={r.id} className="small muted">
                    {r.name} · {r.title}
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>

      {manage && <ManageChores people={people} onClose={() => setManage(false)} />}
      {redeeming && <RedeemModal reward={redeeming} people={people} onClose={() => setRedeeming(null)} />}
      {newReward && <RewardForm onClose={() => setNewReward(false)} />}
      {newTask && <TaskForm people={people} onClose={() => setNewTask(false)} />}
    </div>
  );
}
