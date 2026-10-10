import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Download,
  Lock,
  LogIn,
  MapPin,
  Search,
  Users,
  X
} from 'lucide-react';

const REASONS = ['Washroom', 'Water', 'Locker', 'Library', 'Office', 'Other'];
const SHARED_GROUP = ['Washroom', 'Water', 'Locker'];
const TEACHER_PIN = '1987';

const cleanName = (value) => value.trim().replace(/\s+/g, ' ');
const sameName = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const minutesBetween = (start, end = new Date()) =>
  Math.max(0, Math.floor((new Date(end) - new Date(start)) / 60000));
const formatTime = (value) =>
  value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '';

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

export default function App() {
  const [history, setHistory] = useState(() => readStorage('student-exit-trips'));
  const [queue, setQueue] = useState(() => readStorage('student-exit-queue'));
  const [typedName, setTypedName] = useState('');
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [teacherMode, setTeacherMode] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [reasonFilter, setReasonFilter] = useState('All');
  const [, tick] = useState(0);

  useEffect(() => localStorage.setItem('student-exit-trips', JSON.stringify(history)), [history]);
  useEffect(() => localStorage.setItem('student-exit-queue', JSON.stringify(queue)), [queue]);
  useEffect(() => {
    const id = setInterval(() => tick((value) => value + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const outNow = useMemo(() => history.filter((item) => !item.returnedAt), [history]);
  const activeTrip = selectedStudent
    ? outNow.find((item) => sameName(item.student, selectedStudent))
    : null;
  const sharedTrip = outNow.find((item) => SHARED_GROUP.includes(item.reason));
  const libraryCount = outNow.filter((item) => item.reason === 'Library').length;
  const sharedQueue = queue.filter((item) => item.group === 'shared');
  const libraryQueue = queue.filter((item) => item.group === 'library');
  const availableLibrarySpaces = Math.max(0, 5 - libraryCount);
  const readyNow = [
    !sharedTrip ? sharedQueue[0] : null,
    ...(availableLibrarySpaces > 0 ? libraryQueue.slice(0, availableLibrarySpaces) : [])
  ].filter(Boolean);

  const filteredHistory = history.filter((item) => {
    const nameMatches = item.student.toLowerCase().includes(search.trim().toLowerCase());
    const reasonMatches = reasonFilter === 'All' || item.reason === reasonFilter;
    return nameMatches && reasonMatches;
  });

  function finish(text) {
    setMessage(text);
    window.setTimeout(() => {
      setMessage('');
      setSelectedStudent(null);
      setTypedName('');
    }, 1900);
  }

  function reasonStatus(reason) {
    if (SHARED_GROUP.includes(reason) && sharedTrip) {
      return {
        blocked: true,
        group: 'shared',
        note: `${sharedTrip.student} is currently out for ${sharedTrip.reason}. Join the line.`
      };
    }
    if (
      SHARED_GROUP.includes(reason) &&
      sharedQueue.length > 0 &&
      !sameName(sharedQueue[0].student, selectedStudent)
    ) {
      return {
        blocked: true,
        group: 'shared',
        note: `${sharedQueue[0].student} is next. Join the line.`
      };
    }
    if (reason === 'Library' && libraryCount >= 5) {
      return { blocked: true, group: 'library', note: 'All five library spaces are in use. Join the line.' };
    }
    if (
      reason === 'Library' &&
      libraryQueue.length >= availableLibrarySpaces &&
      !libraryQueue.slice(0, availableLibrarySpaces).some((item) => sameName(item.student, selectedStudent))
    ) {
      return { blocked: true, group: 'library', note: 'Students already waiting have priority.' };
    }
    if (reason === 'Library') {
      return {
        blocked: false,
        group: 'library',
        note: `${availableLibrarySpaces} library space${availableLibrarySpaces === 1 ? '' : 's'} available.`
      };
    }
    if (reason === 'Office' || reason === 'Other') {
      return { blocked: false, group: null, note: 'No limit.' };
    }
    return { blocked: false, group: null, note: 'Available.' };
  }

  function continueWithName() {
    const name = cleanName(typedName);
    if (name) setSelectedStudent(name);
  }

  function joinQueue(reason) {
    const group = SHARED_GROUP.includes(reason) ? 'shared' : 'library';
    if (queue.some((item) => sameName(item.student, selectedStudent) && item.group === group)) {
      finish(`${selectedStudent}, you are already in this line.`);
      return;
    }
    setQueue((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        student: selectedStudent,
        reason,
        group,
        joinedAt: new Date().toISOString()
      }
    ]);
    finish(`${selectedStudent}, you have joined the line for ${reason}.`);
  }

  function startTrip(student, reason, queueId = null) {
    const now = new Date().toISOString();
    setHistory((current) => [
      {
        id: crypto.randomUUID(),
        student,
        reason,
        leftAt: now,
        returnedAt: null
      },
      ...current
    ]);
    if (queueId) setQueue((current) => current.filter((item) => item.id !== queueId));
    else {
      const group = SHARED_GROUP.includes(reason) ? 'shared' : reason === 'Library' ? 'library' : null;
      if (group) {
        setQueue((current) =>
          current.filter((item) => !(sameName(item.student, student) && item.group === group))
        );
      }
    }
    finish(`${student}, you are signed out to ${reason}.`);
  }

  function signOut(reason) {
    const status = reasonStatus(reason);
    if (!selectedStudent || status.blocked) return;
    startTrip(selectedStudent, reason);
  }

  function signOutQueued(item) {
    if (!readyNow.some((ready) => ready.id === item.id)) return;
    startTrip(item.student, item.reason, item.id);
  }

  function signIn(trip) {
    const now = new Date().toISOString();
    setHistory((current) =>
      current.map((item) => (item.id === trip.id ? { ...item, returnedAt: now } : item))
    );
    finish(`Welcome back, ${trip.student}.`);
  }

  function unlockTeacher() {
    if (pin === TEACHER_PIN) {
      setTeacherMode(true);
      setPinOpen(false);
      setPin('');
      setPinError('');
    } else {
      setPinError('Incorrect PIN. Please try again.');
      setPin('');
    }
  }

  function exportCsv() {
    const rows = history.map((item) => [
      item.student,
      item.reason,
      formatDate(item.leftAt),
      formatTime(item.leftAt),
      item.returnedAt ? formatTime(item.returnedAt) : 'Still out',
      item.returnedAt ? minutesBetween(item.leftAt, item.returnedAt) : '',
      item.returnedAt ? 'Returned' : 'Out'
    ]);
    const headers = ['Student', 'Reason', 'Date', 'Time Left', 'Time Returned', 'Minutes Out', 'Status'];
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `student-exit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  if (teacherMode) {
    return (
      <main className="app teacher-background">
        <div className="shell wide-shell">
          <header className="header">
            <div>
              <p className="eyebrow">Teacher dashboard</p>
              <h1>Student Exit Tracker</h1>
            </div>
            <button className="btn btn-outline" onClick={() => setTeacherMode(false)}>
              <ArrowLeft size={18} /> Lock & return to kiosk
            </button>
          </header>

          <section className="dashboard-grid">
            <article className="panel amber-panel">
              <h2>Currently out: {outNow.length}</h2>
              <div className="stack">
                {!outNow.length && <p className="muted">Everyone is in class.</p>}
                {outNow.map((item) => (
                  <div className="record-card" key={item.id}>
                    <strong>{item.student}</strong>
                    <span>{item.reason} · left {formatTime(item.leftAt)} · {minutesBetween(item.leftAt)} min</span>
                  </div>
                ))}
              </div>
            </article>

            <article className="panel indigo-panel">
              <h2>Waiting lines</h2>
              <h3>Washroom, water and locker</h3>
              {!sharedQueue.length && <p className="muted">No one waiting.</p>}
              {sharedQueue.map((item, index) => (
                <div className="queue-row" key={item.id}>{index + 1}. {item.student} · {item.reason}</div>
              ))}
              <h3 className="section-gap">Library</h3>
              {!libraryQueue.length && <p className="muted">No one waiting.</p>}
              {libraryQueue.map((item, index) => (
                <div className="queue-row" key={item.id}>{index + 1}. {item.student}</div>
              ))}
            </article>
          </section>

          <article className="panel history-panel">
            <div className="history-header">
              <div>
                <h2>Trip history</h2>
                <p className="muted">Stored on this device. Export creates an Excel-compatible CSV.</p>
              </div>
              <button className="btn btn-primary" onClick={exportCsv} disabled={!history.length}>
                <Download size={18} /> Export CSV
              </button>
            </div>
            <div className="filter-row">
              <label className="search-box">
                <Search size={18} />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search student" />
              </label>
              <select value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)}>
                <option>All</option>
                {REASONS.map((reason) => <option key={reason}>{reason}</option>)}
              </select>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Student</th><th>Reason</th><th>Date</th><th>Left</th><th>Returned</th><th>Duration</th></tr></thead>
                <tbody>
                  {filteredHistory.map((item) => (
                    <tr key={item.id}>
                      <td><strong>{item.student}</strong></td>
                      <td>{item.reason}</td>
                      <td>{formatDate(item.leftAt)}</td>
                      <td>{formatTime(item.leftAt)}</td>
                      <td>{item.returnedAt ? formatTime(item.returnedAt) : <span className="status-out">Still out</span>}</td>
                      <td>{item.returnedAt ? `${minutesBetween(item.leftAt, item.returnedAt)} min` : `${minutesBetween(item.leftAt)} min`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </div>
      </main>
    );
  }

  return (
    <main className="app student-background">
      <div className="shell">
        <header className="header">
          <div>
            <p className="eyebrow">Classroom sign-out</p>
            <h1>Student Exit Tracker</h1>
          </div>
          <button className="btn btn-ghost" onClick={() => { setPin(''); setPinError(''); setPinOpen(true); }}>
            <Lock size={18} /> Teacher
          </button>
        </header>

        {pinOpen && (
          <div className="modal-backdrop">
            <div className="modal panel">
              <div className="modal-title-row">
                <div><p className="eyebrow">Teacher access</p><h2>Enter PIN</h2></div>
                <button className="icon-btn" onClick={() => setPinOpen(false)} aria-label="Close"><X /></button>
              </div>
              <p className="muted">Teacher dashboard access is protected.</p>
              <input
                className="pin-input"
                autoFocus
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setPinError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && unlockTeacher()}
                placeholder="4-digit PIN"
              />
              {pinError && <p className="error">{pinError}</p>}
              <div className="two-buttons">
                <button className="btn btn-outline" onClick={() => setPinOpen(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={unlockTeacher} disabled={pin.length !== 4}>
                  <Lock size={18} /> Unlock
                </button>
              </div>
            </div>
          </div>
        )}

        {!selectedStudent && !message && outNow.length > 0 && (
          <section className="panel amber-panel compact-panel">
            <h2>Tap your name when you are back</h2>
            <div className="button-wrap">
              {outNow.map((trip) => (
                <button className="btn return-chip" key={trip.id} onClick={() => signIn(trip)}>
                  <LogIn size={20} /> {trip.student} · {trip.reason}
                </button>
              ))}
            </div>
          </section>
        )}

        {!selectedStudent && !message && (
          <section className="panel green-panel compact-panel">
            <h2 className="icon-heading"><Users size={22} /> Who can go next</h2>
            {readyNow.length ? (
              <div className="button-wrap">
                {readyNow.map((item) => (
                  <button className="btn next-chip" key={item.id} onClick={() => signOutQueued(item)}>
                    <MapPin size={20} /> {item.student} · Go to {item.reason}
                  </button>
                ))}
              </div>
            ) : <p className="muted">No one is currently waiting for an available space.</p>}
          </section>
        )}

        {message ? (
          <section className="panel success-panel hero-panel">
            <CheckCircle2 size={82} />
            <h2>{message}</h2>
            <p>The request has been recorded.</p>
          </section>
        ) : !selectedStudent ? (
          <section className="panel hero-panel">
            <h2>Enter your name</h2>
            <p className="lead">Type your first and last name to leave or join a line.</p>
            <div className="name-form">
              <input
                autoFocus
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && continueWithName()}
                placeholder="First and last name"
              />
              <button className="btn btn-primary big-btn" disabled={!typedName.trim()} onClick={continueWithName}>Continue</button>
            </div>
          </section>
        ) : (
          <section className="panel student-panel">
            <button className="btn btn-ghost" onClick={() => { setSelectedStudent(null); setTypedName(''); }}>
              <ArrowLeft size={18} /> Change name
            </button>
            <div className="student-content">
              <h2>Hi, {selectedStudent}</h2>
              {activeTrip ? (
                <>
                  <p className="lead">You are currently out for <strong>{activeTrip.reason}</strong>.</p>
                  <button className="btn back-btn" onClick={() => signIn(activeTrip)}><LogIn size={26} /> I am back</button>
                </>
              ) : (
                <>
                  {queue.filter((item) => sameName(item.student, selectedStudent)).length > 0 && (
                    <div className="my-queue">
                      <strong>Your place in line</strong>
                      {queue.filter((item) => sameName(item.student, selectedStudent)).map((entry) => {
                        const groupQueue = entry.group === 'shared' ? sharedQueue : libraryQueue;
                        const position = groupQueue.findIndex((item) => item.id === entry.id) + 1;
                        return <p key={entry.id}>{entry.reason}: position {position}{readyNow.some((item) => item.id === entry.id) ? ' · You may go now' : ''}</p>;
                      })}
                    </div>
                  )}
                  <p className="lead">Choose a destination. If it is full, join the line.</p>
                  <div className="reason-grid">
                    {REASONS.map((reason) => {
                      const status = reasonStatus(reason);
                      const alreadyQueued = queue.some((item) => sameName(item.student, selectedStudent) && item.group === status.group);
                      return (
                        <div className="reason-cell" key={reason}>
                          <button className={`reason-btn ${status.blocked ? 'blocked' : ''}`} disabled={status.blocked} onClick={() => signOut(reason)}>
                            <span>{status.blocked ? <Lock size={23} /> : <MapPin size={23} />}{reason}</span>
                            <small>{status.note}</small>
                          </button>
                          {status.blocked && status.group && (
                            <button className="btn queue-btn" disabled={alreadyQueued} onClick={() => joinQueue(reason)}>
                              <Clock3 size={18} /> {alreadyQueued ? 'Already in line' : 'Join line'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
