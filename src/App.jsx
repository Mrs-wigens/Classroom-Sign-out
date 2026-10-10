import React, { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
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
const LOCAL_ONLY_HOSTS = new Set(['localhost', '127.0.0.1']);
const LOCAL_ONLY_MODE =
  LOCAL_ONLY_HOSTS.has(window.location.hostname) || window.location.hostname.endsWith('.github.io');

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
  const [storageMode, setStorageMode] = useState(LOCAL_ONLY_MODE ? 'local' : 'connecting');
  const [storageError, setStorageError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [teacherToken, setTeacherToken] = useState('');
  const [kioskToken, setKioskToken] = useState(() =>
    LOCAL_ONLY_MODE ? '' : sessionStorage.getItem('student-exit-kiosk-token') || ''
  );
  const [kioskPassword, setKioskPassword] = useState('');
  const [kioskError, setKioskError] = useState('');
  const [kioskQrOpen, setKioskQrOpen] = useState(false);
  const [kioskUrls, setKioskUrls] = useState([]);
  const [kioskUrl, setKioskUrl] = useState('');
  const [kioskQr, setKioskQr] = useState('');
  const [kioskQrError, setKioskQrError] = useState('');
  const [rtcRole, setRtcRole] = useState('');
  const [rtcConnected, setRtcConnected] = useState(false);
  const [pairingMode, setPairingMode] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [pairingQr, setPairingQr] = useState('');
  const [pairingError, setPairingError] = useState('');
  const peerRef = useRef(null);
  const channelRef = useRef(null);
  const videoRef = useRef(null);
  const scannerRef = useRef(null);
  const pendingActionsRef = useRef(new Map());
  const peerActionHandlerRef = useRef(null);
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

  function stopScanner() {
    scannerRef.current?.stop();
    scannerRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function closePeer() {
    pendingActionsRef.current.forEach(({ reject }) => reject(new Error('The classroom connection closed.')));
    pendingActionsRef.current.clear();
    channelRef.current?.close();
    channelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    setRtcConnected(false);
    setRtcRole('');
    setPairingMode('');
    setPairingCode('');
    setPairingQr('');
  }

  function sendPeerState() {
    if (rtcRole !== 'host' || channelRef.current?.readyState !== 'open') return;
    channelRef.current.send(JSON.stringify({
      type: 'state',
      history: history.filter((trip) => !trip.returnedAt),
      queue
    }));
  }

  function attachDataChannel(channel, role) {
    channelRef.current = channel;
    channel.onopen = () => {
      setRtcConnected(true);
      setPairingError('');
      if (role === 'host') sendPeerState();
      else setStorageMode('shared');
    };
    channel.onclose = () => {
      setRtcConnected(false);
      if (role === 'client') {
        setStorageMode('error');
        setStorageError('The teacher monitor disconnected. Reconnect before continuing.');
      }
    };
    channel.onerror = () => {
      setPairingError('The classroom connection encountered a network error.');
    };
    channel.onmessage = async (event) => {
      let messageData;
      try {
        messageData = JSON.parse(event.data);
      } catch {
        setPairingError('Received an invalid classroom connection message.');
        return;
      }
      if (messageData.type === 'state') {
        if (role === 'client') {
          setHistory(messageData.history);
          setQueue(messageData.queue);
          setStorageMode('shared');
        }
        return;
      }
      if (messageData.type === 'action') {
        if (role !== 'host') return;
        try {
          const result = await peerActionHandlerRef.current(messageData.action);
          channel.send(JSON.stringify({ type: 'action-result', requestId: messageData.requestId, result }));
        } catch (error) {
          channel.send(JSON.stringify({
            type: 'action-result',
            requestId: messageData.requestId,
            error: error instanceof Error ? error.message : 'Could not record that action.'
          }));
        }
        return;
      }
      if (messageData.type === 'action-result') {
        const pending = pendingActionsRef.current.get(messageData.requestId);
        if (!pending) return;
        pendingActionsRef.current.delete(messageData.requestId);
        if (messageData.error) pending.reject(new Error(messageData.error));
        else pending.resolve(messageData.result);
      }
    };
  }

  function configurePeer(peer, role) {
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setRtcConnected(true);
        if (role === 'client') setStorageMode('shared');
      }
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        setRtcConnected(false);
        if (role === 'client') {
          setStorageMode('error');
          setStorageError('The teacher monitor connection was interrupted. Reconnect before continuing.');
        }
        setPairingError('The devices could not establish or maintain a direct connection. The school network may block peer connections.');
      }
      if (peer.connectionState === 'closed' && role === 'client') {
        setStorageMode('error');
        setStorageError('The teacher monitor disconnected. Reconnect before continuing.');
      }
    };
    if (role === 'client') {
      peer.ondatachannel = (event) => attachDataChannel(event.channel, role);
    }
  }

  async function waitForIceGathering(peer) {
    if (peer.iceGatheringState === 'complete') return;
    await new Promise((resolve) => {
      const timeout = window.setTimeout(finish, 12_000);
      function finish() {
        window.clearTimeout(timeout);
        peer.removeEventListener('icegatheringstatechange', onStateChange);
        resolve();
      }
      function onStateChange() {
        if (peer.iceGatheringState === 'complete') finish();
      }
      peer.addEventListener('icegatheringstatechange', onStateChange);
    });
    if (peer.iceGatheringState !== 'complete') {
      throw new Error('Network setup timed out. Try pairing again on the same classroom Wi-Fi.');
    }
  }

  async function createPairingQr(type, description) {
    const value = JSON.stringify({ version: 1, type, description });
    const image = await QRCode.toDataURL(value, { errorCorrectionLevel: 'L', margin: 2, width: 420 });
    setPairingCode(value);
    setPairingQr(image);
  }

  async function beginMonitorPairing() {
    try {
      closePeer();
      setPairingError('');
      setPairingMode('creating-offer');
      const peer = new RTCPeerConnection({ iceServers: [] });
      peerRef.current = peer;
      setRtcRole('host');
      configurePeer(peer, 'host');
      attachDataChannel(peer.createDataChannel('classroom-tracker'), 'host');
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIceGathering(peer);
      await createPairingQr('offer', peer.localDescription);
      setPairingMode('show-offer');
    } catch (error) {
      closePeer();
      setPairingError(error instanceof Error ? error.message : 'Could not create the pairing code.');
      setPairingMode('');
    }
  }

  async function processPairingCode(value) {
    let payload;
    try {
      payload = JSON.parse(value);
    } catch {
      let scannedUrl;
      try {
        scannedUrl = new URL(value);
      } catch {
        throw new Error('That QR code is not a valid classroom pairing code.');
      }
      if (scannedUrl.protocol === 'http:' || scannedUrl.protocol === 'https:') {
        throw new Error(
          'This QR opens the classroom app; it is not a monitor pairing code. Close this scanner, scan the QR with the tablet camera, open the local classroom link, then enter PAIR.'
        );
      }
      throw new Error('That QR code is not a valid classroom pairing code.');
    }
    if (payload.version !== 1 || !payload.description?.sdp) {
      throw new Error('That pairing code is incomplete or unsupported.');
    }

    if (payload.type === 'offer' && pairingMode === 'scan-offer') {
      const peer = new RTCPeerConnection({ iceServers: [] });
      peerRef.current = peer;
      setRtcRole('client');
      configurePeer(peer, 'client');
      await peer.setRemoteDescription(payload.description);
      await peer.setLocalDescription(await peer.createAnswer());
      await waitForIceGathering(peer);
      await createPairingQr('answer', peer.localDescription);
      setStorageMode('connecting');
      setPairingMode('show-answer');
      return;
    }

    if (payload.type === 'answer' && pairingMode === 'scan-answer') {
      const peer = peerRef.current;
      if (!peer || rtcRole !== 'host') throw new Error('Create a teacher pairing code before scanning the tablet.');
      await peer.setRemoteDescription(payload.description);
      setPairingMode('waiting');
      return;
    }

    throw new Error('Use the matching teacher or student pairing step for this QR code.');
  }

  async function startQrScanner() {
    setPairingError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setPairingError('Camera access is unavailable. Use the paste-code box below or open the app in a secure browser.');
      return;
    }
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
        if (!result) return;
        const value = result.getText();
        stopScanner();
        setPairingCode(value);
        processPairingCode(value).catch((error) => {
          setPairingError(error instanceof Error ? error.message : 'Could not use the scanned QR code.');
        });
      });
      scannerRef.current = controls;
    } catch (error) {
      stopScanner();
      setPairingError(error instanceof Error ? error.message : 'Could not start the camera.');
    }
  }

  async function submitPairingCode() {
    try {
      setPairingError('');
      await processPairingCode(pairingCode.trim());
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : 'Could not use that pairing code.');
    }
  }

  function endMonitorPairing() {
    closePeer();
    setPairingError('');
    if (!LOCAL_ONLY_MODE) setStorageMode('shared');
  }

  function closePairingDialog() {
    stopScanner();
    if (!rtcConnected) {
      const wasClient = rtcRole === 'client';
      closePeer();
      if (wasClient && LOCAL_ONLY_MODE) setStorageMode('local');
    } else {
      setPairingMode('');
    }
    setPairingError('');
  }

  function renderPairingDialog() {
    if (!pairingMode) return null;
    return (
      <div className="modal-backdrop">
        <section className="modal panel pairing-modal" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
          <div className="modal-title-row">
            <div>
              <p className="eyebrow">Classroom device connection</p>
              <h2 id="pairing-title">Pair monitor and kiosk</h2>
            </div>
            <button className="icon-btn" onClick={closePairingDialog} aria-label="Close pairing"><X /></button>
          </div>

          {pairingMode === 'creating-offer' && <p>Preparing the teacher monitor code…</p>}
          {pairingMode === 'show-offer' && (
            <>
              <p>On the student tablet, tap <strong>Connect to teacher monitor</strong> and scan this code. Keep both pages open.</p>
              <img className="pairing-qr" src={pairingQr} alt="QR code to pair the student kiosk with this teacher monitor" />
              <button className="btn btn-primary pairing-action" onClick={() => { setPairingMode('scan-answer'); setPairingCode(''); }}>
                Scan the tablet's response
              </button>
            </>
          )}
          {pairingMode === 'scan-offer' && (
            <>
              <p>Scan the teacher monitor's pairing QR code. The tablet will show a response QR code for the teacher to scan.</p>
              <video className="pairing-video" ref={videoRef} muted playsInline />
              <button className="btn btn-primary pairing-action" onClick={startQrScanner}>Start camera scan</button>
            </>
          )}
          {pairingMode === 'show-answer' && (
            <>
              <p>Show this response code to the teacher monitor and keep this page open while it connects.</p>
              <img className="pairing-qr" src={pairingQr} alt="QR response code for the teacher monitor" />
              <p className="muted">Waiting for the teacher monitor to scan this code…</p>
            </>
          )}
          {pairingMode === 'scan-answer' && (
            <>
              <p>Scan the response QR code displayed on the student tablet.</p>
              <video className="pairing-video" ref={videoRef} muted playsInline />
              <button className="btn btn-primary pairing-action" onClick={startQrScanner}>Start camera scan</button>
            </>
          )}
          {pairingMode === 'waiting' && <p>Pairing code accepted. Waiting for the tablet to connect…</p>}
          {pairingError && <p className="operation-error" role="alert">{pairingError}</p>}
          {(pairingMode === 'scan-offer' || pairingMode === 'scan-answer') && (
            <details className="pairing-manual">
              <summary>Enter a pairing code manually</summary>
              <textarea
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value)}
                placeholder="Paste the scanned pairing code here"
                rows={4}
              />
              <button className="btn btn-outline pairing-action" disabled={!pairingCode.trim()} onClick={submitPairingCode}>
                Use pairing code
              </button>
            </details>
          )}
        </section>
      </div>
    );
  }

  useEffect(() => {
    if (storageMode !== 'local') return;
    localStorage.setItem('student-exit-trips', JSON.stringify(history));
  }, [history, storageMode]);
  useEffect(() => {
    if (storageMode !== 'local') return;
    localStorage.setItem('student-exit-queue', JSON.stringify(queue));
  }, [queue, storageMode]);
  useEffect(() => {
    if (!kioskUrl) {
      setKioskQr('');
      return;
    }
    QRCode.toDataURL(kioskUrl, { errorCorrectionLevel: 'M', margin: 2, width: 420 })
      .then(setKioskQr)
      .catch((error) => {
        setKioskQrError(error instanceof Error ? error.message : 'Could not create the kiosk QR code.');
      });
  }, [kioskUrl]);
  useEffect(() => {
    const id = setInterval(() => tick((value) => value + 1), 30000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    sendPeerState();
  }, [history, queue, rtcConnected, rtcRole]);
  useEffect(() => () => {
    stopScanner();
    pendingActionsRef.current.forEach(({ reject }) => reject(new Error('The classroom page closed.')));
    channelRef.current?.close();
    peerRef.current?.close();
  }, []);
  useEffect(() => {
    if (LOCAL_ONLY_MODE) return undefined;
    if (!teacherToken && !kioskToken) {
      setStorageMode('connecting');
      return undefined;
    }

    let stopped = false;
    async function refreshSharedState() {
      try {
        const token = teacherMode ? teacherToken : kioskToken;
        const response = await fetch(
          teacherMode && teacherToken ? '/api/teacher/history' : '/api/state',
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (response.status === 401 && teacherMode && teacherToken) {
          if (stopped) return;
          setTeacherToken('');
          setTeacherMode(false);
          setKioskToken('');
          sessionStorage.removeItem('student-exit-kiosk-token');
          setPin('');
          setPinError('Teacher session expired. Please sign in again.');
          setPinOpen(true);
          setStorageMode('shared');
          setStorageError('');
          return;
        }
        if (response.status === 401 && !teacherMode && kioskToken) {
          if (stopped) return;
          setKioskToken('');
          sessionStorage.removeItem('student-exit-kiosk-token');
          setKioskError('Your kiosk connection expired. Enter the pairing password again.');
          setStorageMode('connecting');
          return;
        }
        if (!response.ok) throw new Error(`Tracker server returned ${response.status}.`);
        const state = await response.json();
        if (stopped) return;
        setHistory(state.history);
        setQueue(state.queue);
        setStorageMode('shared');
        setStorageError('');
      } catch (error) {
        if (stopped) return;
        setStorageMode('error');
        setStorageError(
          error instanceof Error ? error.message : 'Could not connect to the classroom tracker server.'
        );
      }
    }

    refreshSharedState();
    const id = window.setInterval(refreshSharedState, 2000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [teacherMode, teacherToken, kioskToken]);

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

  async function postSharedAction(action, values) {
    if (rtcRole === 'client') {
      const channel = channelRef.current;
      if (channel?.readyState !== 'open') {
        throw new Error('The teacher monitor is disconnected. Reconnect before continuing.');
      }
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingActionsRef.current.delete(requestId);
          reject(new Error('The teacher monitor did not respond. Check the connection and try again.'));
        }, 10_000);
        pendingActionsRef.current.set(requestId, {
          resolve: (result) => { window.clearTimeout(timeout); resolve(result); },
          reject: (error) => { window.clearTimeout(timeout); reject(error); }
        });
        try {
          channel.send(JSON.stringify({
            type: 'action',
            requestId,
            action: { action, ...values }
          }));
        } catch (error) {
          window.clearTimeout(timeout);
          pendingActionsRef.current.delete(requestId);
          reject(error instanceof Error ? error : new Error('Could not send the tracker action.'));
        }
      });
    }

    const response = await fetch('/api/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken || kioskToken}`
      },
      body: JSON.stringify({ action, ...values })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Tracker server returned ${response.status}.`);
    setHistory(result.history);
    setQueue(result.queue);
  }

  function reasonStatus(reason, student = selectedStudent) {
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
      !sameName(sharedQueue[0].student, student)
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
      !libraryQueue.slice(0, availableLibrarySpaces).some((item) => sameName(item.student, student))
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

  async function joinQueue(reason, student = selectedStudent) {
    const group = SHARED_GROUP.includes(reason) ? 'shared' : 'library';
    if (queue.some((item) => sameName(item.student, student) && item.group === group)) {
      finish(`${student}, you are already in this line.`);
      return;
    }
    try {
      if (storageMode === 'shared') {
        await postSharedAction('join-queue', { student, reason });
      } else {
        setQueue((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            student,
            reason,
            group,
            joinedAt: new Date().toISOString()
          }
        ]);
      }
      setOperationError('');
      finish(`${student}, you have joined the line for ${reason}.`);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Could not join the line.');
    }
  }

  async function startTrip(student, reason, queueId = null) {
    const now = new Date().toISOString();
    if (storageMode === 'shared') {
      try {
        await postSharedAction('start-trip', { student, reason, queueId });
        setOperationError('');
        finish(`${student}, you are signed out to ${reason}.`);
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Could not record the sign-out.');
      }
      return;
    }
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

  async function signIn(trip) {
    const now = new Date().toISOString();
    if (storageMode === 'shared') {
      try {
        await postSharedAction('return-trip', { tripId: trip.id });
        setOperationError('');
        finish(`Welcome back, ${trip.student}.`);
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Could not record the return.');
      }
      return;
    }
    setHistory((current) =>
      current.map((item) => (item.id === trip.id ? { ...item, returnedAt: now } : item))
    );
    finish(`Welcome back, ${trip.student}.`);
  }

  peerActionHandlerRef.current = async (action) => {
    if (action.action === 'join-queue') {
      const student = cleanName(action.student || '');
      if (outNow.some((trip) => sameName(trip.student, student))) {
        throw new Error(`${student} is already signed out.`);
      }
      const group = SHARED_GROUP.includes(action.reason) ? 'shared' : action.reason === 'Library' ? 'library' : null;
      if (!group) throw new Error('Choose a limited destination before joining a line.');
      if (queue.some((item) => sameName(item.student, student) && item.group === group)) {
        throw new Error(`${student} is already in this line.`);
      }
      setQueue((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          student,
          reason: action.reason,
          group,
          joinedAt: new Date().toISOString()
        }
      ]);
      return { ok: true };
    }

    if (action.action === 'start-trip') {
      const student = cleanName(action.student || '');
      if (outNow.some((trip) => sameName(trip.student, student))) {
        throw new Error(`${student} is already signed out.`);
      }
      const status = reasonStatus(action.reason, student);
      if (status.blocked) throw new Error(status.note);
      await startTrip(student, action.reason, action.queueId || null);
      return { ok: true };
    }

    if (action.action === 'return-trip') {
      const trip = outNow.find((item) => item.id === action.tripId);
      if (!trip) throw new Error('That sign-out is no longer active.');
      await signIn(trip);
      return { ok: true };
    }

    throw new Error('Unknown classroom action.');
  };

  async function connectKiosk() {
    try {
      setKioskError('');
      const response = await fetch('/api/kiosk/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: kioskPassword })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not connect the kiosk.');
      sessionStorage.setItem('student-exit-kiosk-token', result.token);
      setKioskToken(result.token);
      setKioskPassword('');
    } catch (error) {
      setKioskError(error instanceof Error ? error.message : 'Could not connect the kiosk.');
    }
  }

  function unlockTeacher() {
    if (!LOCAL_ONLY_MODE) {
      fetch('/api/teacher/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      })
        .then(async (response) => {
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Teacher sign-in failed.');
          setTeacherToken(result.token);
          setTeacherMode(true);
          setPinOpen(false);
          setPin('');
          setPinError('');
        })
        .catch((error) => {
          setPinError(error instanceof Error ? error.message : 'Teacher sign-in failed.');
          setPin('');
        });
      return;
    }
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

  async function openKioskQr() {
    try {
      setKioskQrError('');
      const response = await fetch('/api/kiosk/urls', {
        headers: { Authorization: `Bearer ${teacherToken}` }
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load classroom network addresses.');
      if (!result.urls?.length) throw new Error('No local network address was found. Connect the host computer to classroom Wi-Fi and try again.');
      setKioskUrls(result.urls);
      setKioskUrl(result.urls[0]);
      setKioskQrOpen(true);
    } catch (error) {
      setKioskQrError(error instanceof Error ? error.message : 'Could not create the kiosk QR code.');
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

  if (!LOCAL_ONLY_MODE && storageMode === 'connecting' && !teacherMode && !kioskToken) {
    return (
      <main className="app student-background">
        <div className="shell">
          <section className="panel hero-panel">
            <h2>Connect to the classroom tracker</h2>
            <p className="lead">Enter the pairing password shown by your teacher.</p>
            <div className="name-form">
              <input
                className="pin-input"
                type="password"
                autoCapitalize="characters"
                autoComplete="off"
                value={kioskPassword}
                onChange={(event) => { setKioskPassword(event.target.value); setKioskError(''); }}
                onKeyDown={(event) => event.key === 'Enter' && connectKiosk()}
                placeholder="Pairing password"
                aria-label="Pairing password"
              />
              <button className="btn btn-primary big-btn" disabled={!kioskPassword.trim()} onClick={connectKiosk}>
                Connect kiosk
              </button>
              {kioskError && <p className="error" role="alert">{kioskError}</p>}
              <button className="btn btn-ghost big-btn" onClick={() => { setPin(''); setPinError(''); setPinOpen(true); }}>
                Teacher access
              </button>
            </div>
          </section>
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
                  maxLength={12}
                  value={pin}
                  onChange={(event) => { setPin(event.target.value.replace(/\D/g, '').slice(0, 12)); setPinError(''); }}
                  onKeyDown={(event) => event.key === 'Enter' && unlockTeacher()}
                  placeholder="Teacher PIN"
                />
                {pinError && <p className="error">{pinError}</p>}
                <div className="two-buttons">
                  <button className="btn btn-outline" onClick={() => setPinOpen(false)}>Cancel</button>
                  <button className="btn btn-primary" onClick={unlockTeacher} disabled={!pin.length}>
                    <Lock size={18} /> Unlock
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    );
  }

  if (storageMode === 'connecting') {
    return <main className="app student-background"><div className="shell"><section className="panel hero-panel"><h2>Connecting to the classroom tracker…</h2><p>Keep this page open while the teacher monitor accepts the connection.</p></section>{renderPairingDialog()}</div></main>;
  }

  if (storageMode === 'error') {
    return <main className="app student-background"><div className="shell"><section className="panel hero-panel"><h2>Classroom tracker unavailable</h2><p className="error">{storageError}</p><p className="muted">No changes have been saved. Reconnect to the teacher monitor before continuing.</p>{LOCAL_ONLY_MODE && <button className="btn btn-primary pairing-action" onClick={() => { closePeer(); setPairingError(''); setPairingMode('scan-offer'); }}>Reconnect to teacher monitor</button>}</section>{renderPairingDialog()}</div></main>;
  }

  if (teacherMode) {
    return (
      <main className="app teacher-background">
        <div className="shell wide-shell">
          <header className="header">
            <div>
              <p className="eyebrow">Teacher dashboard</p>
              <h1>Student Exit Tracker</h1>
              <p className="muted">
                {LOCAL_ONLY_MODE
                  ? rtcConnected ? 'Student kiosk connected' : 'Student kiosk not connected'
                  : 'Shared tracker active on this classroom network'}
              </p>
            </div>
            <div className="dashboard-actions">
              {LOCAL_ONLY_MODE && (
                rtcConnected
                  ? <button className="btn btn-outline" onClick={endMonitorPairing}>Disconnect kiosk</button>
                  : <button className="btn btn-primary" onClick={beginMonitorPairing}>Pair student kiosk</button>
              )}
              {!LOCAL_ONLY_MODE && <button className="btn btn-primary" onClick={openKioskQr}>Show kiosk QR</button>}
              <button className="btn btn-outline" onClick={() => { setTeacherMode(false); setTeacherToken(''); setHistory(history.filter((item) => !item.returnedAt)); }}>
                <ArrowLeft size={18} /> Lock & return to kiosk
              </button>
            </div>
          </header>
          {operationError && <p className="operation-error" role="alert">{operationError}</p>}

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
                <p className="muted">{storageMode === 'shared' ? 'Shared with devices connected to this classroom tracker.' : 'Stored on this device. Export creates an Excel-compatible CSV.'}</p>
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
        {renderPairingDialog()}
        {kioskQrError && <p className="operation-error" role="alert">{kioskQrError}</p>}
        {kioskQrOpen && (
          <div className="modal-backdrop">
            <section className="modal panel pairing-modal" role="dialog" aria-modal="true" aria-labelledby="kiosk-qr-title">
              <div className="modal-title-row">
                <div>
                  <p className="eyebrow">Classroom kiosk</p>
                  <h2 id="kiosk-qr-title">Open and connect a tablet</h2>
                </div>
                <button className="icon-btn" onClick={() => setKioskQrOpen(false)} aria-label="Close kiosk QR"><X /></button>
              </div>
              <p>Scan this QR on the tablet, then enter the pairing password <strong>PAIR</strong>. Keep this classroom server running.</p>
              {kioskUrls.length > 1 && (
                <label className="kiosk-url-select">
                  Tablet network address
                  <select value={kioskUrl} onChange={(event) => setKioskUrl(event.target.value)}>
                    {kioskUrls.map((url) => <option key={url} value={url}>{new URL(url).host}</option>)}
                  </select>
                </label>
              )}
              {kioskQr && <img className="pairing-qr" src={kioskQr} alt="QR code that opens this classroom kiosk" />}
              <p className="muted kiosk-url">{kioskUrl}</p>
              {kioskQrError && <p className="operation-error" role="alert">{kioskQrError}</p>}
            </section>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="app student-background">
      <div className="shell">
        {storageMode === 'shared' && <p className="connection-note">Connected to the classroom tracker. Activity is shared with this classroom network.</p>}
        {storageMode === 'local' && <p className="connection-note">Local-only mode: activity on this device is not shared with other devices.</p>}
        {operationError && <p className="operation-error" role="alert">{operationError}</p>}
        <header className="header">
          <div>
            <p className="eyebrow">Classroom sign-out</p>
            <h1>Student Exit Tracker</h1>
          </div>
          {rtcRole !== 'client' && (
            <button className="btn btn-ghost" onClick={() => { setPin(''); setPinError(''); setPinOpen(true); }}>
              <Lock size={18} /> Teacher
            </button>
          )}
        </header>
        {LOCAL_ONLY_MODE && !rtcConnected && rtcRole !== 'host' && (
          <button className="btn btn-outline pairing-connect" onClick={() => { setPairingError(''); setPairingCode(''); setPairingMode('scan-offer'); }}>
            Connect to teacher monitor
          </button>
        )}
        {rtcConnected && rtcRole === 'client' && <p className="connection-note">Connected to teacher monitor; activity is shared live.</p>}

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
                maxLength={12}
                value={pin}
                onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 12)); setPinError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && unlockTeacher()}
                placeholder="Teacher PIN"
              />
              {pinError && <p className="error">{pinError}</p>}
              <div className="two-buttons">
                <button className="btn btn-outline" onClick={() => setPinOpen(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={unlockTeacher} disabled={!pin.length}>
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
      {renderPairingDialog()}
    </main>
  );
}
