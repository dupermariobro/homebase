import { useState } from 'react';
import { IconCircle, IconCircleCheckFilled, IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { api, useLive } from '../api.js';
import { Empty, Modal, toast, toastError } from '../components/ui.jsx';

export default function Lists() {
  const { data } = useLive('/api/lists', ['lists']);
  const [activeId, setActiveId] = useState(null);
  const [text, setText] = useState('');
  const [newList, setNewList] = useState(null);
  const lists = data || [];
  const active = lists.find((l) => l.id === activeId) || lists[0];

  const run = async (fn) => {
    try {
      await fn();
    } catch (e) {
      toastError(e);
    }
  };
  const add = (e) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || !active) return;
    setText('');
    run(() => api('POST', `/api/lists/${active.id}/items`, { text: value }));
  };
  const open = active?.items.filter((i) => !i.done) || [];
  const done = active?.items.filter((i) => i.done) || [];

  return (
    <div className="lists">
      <div className="toolbar">
        <div className="seg">
          {lists.map((l) => (
            <button key={l.id} className={active?.id === l.id ? 'on' : ''} onClick={() => setActiveId(l.id)}>
              {l.name}
              {l.items.some((i) => !i.done) && <span className="count">{l.items.filter((i) => !i.done).length}</span>}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={() => setNewList('')}>
          <IconPlus size={18} /> New list
        </button>
        <span className="grow" />
        {active && lists.length > 1 && (
          <button
            className="btn ghost"
            onClick={() =>
              run(async () => {
                await api('DELETE', `/api/lists/${active.id}`);
                setActiveId(null);
                toast(`Deleted ${active.name}`);
              })
            }
          >
            <IconTrash size={18} /> Delete list
          </button>
        )}
      </div>

      {active && (
        <div className="panel list-panel">
          <form className="add-row" onSubmit={add}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add to ${active.name}`} aria-label="New item" />
            <button className="btn primary" aria-label="Add item">
              <IconPlus size={20} />
            </button>
          </form>
          {open.length === 0 && done.length === 0 && <Empty title="Nothing on this list">Add something above, or send a meal’s ingredients here from Meals.</Empty>}
          <ul className="items">
            {open.map((i) => (
              <li key={i.id}>
                <button className="item" onClick={() => run(() => api('PATCH', `/api/items/${i.id}`, { done: true }))}>
                  <IconCircle size={26} stroke={1.6} /> <span>{i.text}</span>
                </button>
                <button className="icon-btn subtle" onClick={() => run(() => api('DELETE', `/api/items/${i.id}`))} aria-label={`Remove ${i.text}`}>
                  <IconX size={20} />
                </button>
              </li>
            ))}
          </ul>
          {done.length > 0 && (
            <>
              <div className="done-head">
                <h4 className="subhead">In the cart · {done.length}</h4>
                <button className="btn ghost small-btn" onClick={() => run(() => api('POST', `/api/lists/${active.id}/clear-done`))}>
                  Clear
                </button>
              </div>
              <ul className="items done">
                {done.map((i) => (
                  <li key={i.id}>
                    <button className="item" onClick={() => run(() => api('PATCH', `/api/items/${i.id}`, { done: false }))}>
                      <IconCircleCheckFilled size={26} /> <span>{i.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {newList !== null && (
        <Modal title="New list" onClose={() => setNewList(null)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const r = await api('POST', '/api/lists', { name: newList });
                setActiveId(r.id);
                setNewList(null);
              });
            }}
          >
            <label>
              Name
              <input value={newList} onChange={(e) => setNewList(e.target.value)} placeholder="Target run" autoFocus required />
            </label>
            <div className="form-actions">
              <button className="btn primary">Create list</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
