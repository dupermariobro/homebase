import { useEffect, useRef, useState } from 'react';
import { IconPhotoPlus, IconTrash, IconPhoto, IconRefresh, IconCheck, IconAlertTriangle, IconX } from '@tabler/icons-react';
import { api, useLive } from '../api.js';
import { resizeImage } from '../image.js';
import { Empty, toast, toastError } from '../components/ui.jsx';

const TIMEOUT_MS = 90000;
const ORIGINAL_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

function logToServer(message) {
  fetch('/api/client-log', { method: 'POST', headers: { 'content-type': 'application/json', 'x-homebase': '1' }, body: JSON.stringify({ message }) }).catch(() => {});
}

function guessType(file) {
  if (file.type) return file.type.toLowerCase();
  return /\.hei[cf]$/i.test(file.name) ? 'image/heic' : '';
}

/** Shrink on the phone when possible; otherwise send the original for the Mac to convert. */
async function uploadOne(file, cancelSignal) {
  let body;
  let type = 'image/jpeg';
  try {
    body = await resizeImage(file);
  } catch (err) {
    type = guessType(file);
    if (!ORIGINAL_TYPES.includes(type)) throw new Error(`${file.name || 'File'} isn’t a supported photo`);
    if (file.size > 38 * 1024 * 1024) throw new Error(`${file.name || 'Photo'} is too large`);
    logToServer(`resize failed (${err.message}); sending original ${type} ${Math.round(file.size / 1024)}KB`);
    body = file;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onCancel = () => ctrl.abort();
  cancelSignal.addEventListener('abort', onCancel);
  try {
    const res = await fetch('/api/photos', { method: 'POST', headers: { 'content-type': type, 'x-homebase': '1' }, body, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      if (cancelSignal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      throw new Error('Timed out — the connection to Homebase is too slow or dropped');
    }
    if (err instanceof TypeError) throw new Error('Can’t reach Homebase — check Wi-Fi or Tailscale');
    throw err;
  } finally {
    clearTimeout(timer);
    cancelSignal.removeEventListener('abort', onCancel);
  }
}

export default function Photos() {
  const { data } = useLive('/api/photos', ['photos']);
  const [job, setJob] = useState(null); // { total, done, ok, failed: [{file, error}], running }
  const fileRef = useRef(null);
  const cancelRef = useRef(null);
  const photos = data || [];

  // Leaving the Photos tab cancels any upload in progress.
  useEffect(() => () => cancelRef.current?.abort(), []);

  const run = async (files) => {
    const cancel = new AbortController();
    cancelRef.current = cancel;
    const state = { total: files.length, done: 0, ok: 0, failed: [], running: true, cancelled: 0 };
    setJob({ ...state });
    for (const [i, file] of files.entries()) {
      if (cancel.signal.aborted) {
        state.cancelled = files.length - i;
        state.failed.push(...files.slice(i).map((f) => ({ file: f, error: 'Cancelled' })));
        break;
      }
      try {
        await uploadOne(file, cancel.signal);
        state.ok++;
      } catch (err) {
        state.failed.push({ file, error: err.message });
        if (!err.cancelled) logToServer(`photo upload failed: ${err.message}`);
      }
      state.done++;
      setJob({ ...state, failed: [...state.failed] });
    }
    state.running = false;
    cancelRef.current = null;
    setJob({ ...state, failed: [...state.failed] });
    if (state.ok && !state.failed.length) toast(`Added ${state.ok} photo${state.ok === 1 ? '' : 's'}`, 'success');
  };
  const pick = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) run(files);
  };
  const remove = async (p) => {
    try {
      await api('DELETE', `/api/photos/${p.id}`);
    } catch (err) {
      toastError(err);
    }
  };
  const pct = job ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <div className="photos-view">
      <div className="toolbar">
        <h2 className="toolbar-title">Photos</h2>
        <span className="muted small">Shown as a slideshow when the board is idle during the day.</span>
        <span className="grow" />
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={pick} />
        <button className="btn primary" onClick={() => fileRef.current.click()} disabled={job?.running}>
          <IconPhotoPlus size={20} /> Add photos
        </button>
      </div>

      {job && (
        <div className={`panel upload-panel ${job.failed.length && !job.running ? 'has-errors' : ''}`} role="status" aria-live="polite">
          <div className="upload-head">
            {job.running ? (
              <strong>
                Uploading {Math.min(job.done + 1, job.total)} of {job.total}…
              </strong>
            ) : (
              <strong className="upload-done">
                {job.ok > 0 && (
                  <>
                    <IconCheck size={18} /> Added {job.ok} photo{job.ok === 1 ? '' : 's'}
                  </>
                )}
                {job.failed.length > 0 && (
                  <span className="upload-fail">
                    <IconAlertTriangle size={18} /> {job.failed.length} {job.failed.every((f) => f.error === 'Cancelled') ? 'cancelled' : 'didn’t upload'}
                  </span>
                )}
              </strong>
            )}
            <span className="grow" />
            {job.running && (
              <button className="btn small-btn" onClick={() => cancelRef.current?.abort()}>
                <IconX size={16} /> Cancel
              </button>
            )}
            {!job.running && job.failed.length > 0 && (
              <button className="btn small-btn" onClick={() => run(job.failed.map((f) => f.file))}>
                <IconRefresh size={16} /> Retry
              </button>
            )}
            {!job.running && (
              <button className="btn ghost small-btn" onClick={() => setJob(null)}>
                Done
              </button>
            )}
          </div>
          <div className="progress" aria-hidden="true">
            <div style={{ width: `${pct}%` }} />
          </div>
          {job.running && <p className="muted small">Keep this screen open until it finishes — phones pause uploads in the background.</p>}
          {!job.running && job.failed.some((f) => f.error !== 'Cancelled') && (
            <p className="small upload-err">{job.failed.find((f) => f.error !== 'Cancelled').error}</p>
          )}
        </div>
      )}

      {photos.length === 0 ? (
        <Empty icon={IconPhoto} title="Start the family slideshow">
          Add photos from your phone — open Homebase there, tap Photos, then Add photos.
        </Empty>
      ) : (
        <div className="photo-grid">
          {photos.map((p) => (
            <figure key={p.id} className="photo-tile">
              <img src={`/photos/${p.filename}`} alt="" loading="lazy" />
              <button className="icon-btn photo-del" onClick={() => remove(p)} aria-label="Delete photo">
                <IconTrash size={20} />
              </button>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
