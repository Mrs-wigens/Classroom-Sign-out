import { createServer } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const distDirectory = resolve(root, 'dist');
const dataDirectory = resolve(root, 'data');
const dataPath = resolve(dataDirectory, 'tracker-data.json');
const port = Number(process.env.PORT || 4173);
const teacherPin = process.env.TRACKER_TEACHER_PIN;
const kioskPassword = process.env.TRACKER_KIOSK_PASSWORD || 'PAIR';
if (!teacherPin || !/^\d{8,12}$/.test(teacherPin)) {
  throw new Error('Set TRACKER_TEACHER_PIN to a new 8-to-12-digit PIN before starting the LAN server.');
}
if (kioskPassword.length < 4 || kioskPassword.length > 64) {
  throw new Error('TRACKER_KIOSK_PASSWORD must be 4 to 64 characters.');
}
const reasons = new Set(['Washroom', 'Water', 'Locker', 'Library', 'Office', 'Other']);
const sharedReasons = new Set(['Washroom', 'Water', 'Locker']);
const sessions = new Map();
const kioskSessions = new Map();
const loginAttempts = new Map();
const kioskAttempts = new Map();
let state = { history: [], queue: [] };
let writeChain = Promise.resolve();

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function publicState() {
  return {
    history: state.history.filter((trip) => !trip.returnedAt),
    queue: state.queue
  };
}

async function persist(nextState) {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${dataPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(nextState, null, 2), { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPath, dataPath);
}

function mutate(update) {
  const operation = writeChain.then(async () => {
    const nextState = update(state);
    await persist(nextState);
    state = nextState;
    return publicState();
  });
  writeChain = operation.catch(() => {});
  return operation;
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error('Request body is too large.');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function cleanStudent(value) {
  if (typeof value !== 'string') throw new Error('Enter a student name.');
  const student = value.trim().replace(/\s+/g, ' ');
  if (!student || student.length > 100) throw new Error('Student names must be 1 to 100 characters.');
  return student;
}

function groupForReason(reason) {
  return sharedReasons.has(reason) ? 'shared' : reason === 'Library' ? 'library' : null;
}

function sameName(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function startTrip(next, student, reason, queueId) {
  if (!reasons.has(reason)) throw new Error('Choose a valid destination.');
  if (next.history.some((trip) => !trip.returnedAt && sameName(trip.student, student))) {
    throw new Error(`${student} is already signed out.`);
  }

  const group = groupForReason(reason);
  const matchingQueue = group ? next.queue.filter((item) => item.group === group) : [];
  if (queueId) {
    const queued = matchingQueue.find((item) => item.id === queueId);
    if (!queued || !sameName(queued.student, student) || queued.reason !== reason) {
      throw new Error('That place in line is no longer available. Refresh and try again.');
    }
  }

  const activeTrips = next.history.filter((trip) => !trip.returnedAt);
  if (group === 'shared') {
    if (activeTrips.some((trip) => sharedReasons.has(trip.reason))) {
      throw new Error('The shared space is occupied. Please join the line.');
    }
    if (queueId && matchingQueue[0]?.id !== queueId) {
      throw new Error('Another student is next in line.');
    }
    if (!queueId && matchingQueue.length && !sameName(matchingQueue[0].student, student)) {
      throw new Error(`${matchingQueue[0].student} is next in line.`);
    }
  } else if (group === 'library') {
    const available = Math.max(0, 5 - activeTrips.filter((trip) => trip.reason === 'Library').length);
    if (!available) throw new Error('All five library spaces are in use. Please join the line.');
    const readyQueue = matchingQueue.slice(0, available);
    if (queueId && !readyQueue.some((item) => item.id === queueId)) {
      throw new Error('Students ahead of you have priority. Refresh and try again.');
    }
    if (
      !queueId &&
      matchingQueue.length >= available &&
      !readyQueue.some((item) => sameName(item.student, student))
    ) {
      throw new Error('Students already waiting have priority.');
    }
  }

  const now = new Date().toISOString();
  const history = [{
    id: randomUUID(),
    student,
    reason,
    leftAt: now,
    returnedAt: null
  }, ...next.history];
  const queue = group
    ? next.queue.filter((item) =>
      queueId ? item.id !== queueId : !(sameName(item.student, student) && item.group === group)
    )
    : next.queue;
  return { history, queue };
}

function validTeacherSession(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const expiresAt = token ? sessions.get(token) : null;
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}

function validKioskSession(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const expiresAt = token ? kioskSessions.get(token) : null;
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) kioskSessions.delete(token);
    return false;
  }
  return true;
}

function equalSecret(candidate, expectedSecret) {
  const actual = Buffer.from(String(candidate || ''));
  const expected = Buffer.from(expectedSecret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function serveStatic(pathname, response) {
  let requested;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    return jsonResponse(response, 400, { error: 'Invalid URL path.' });
  }

  const relativePath = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  let filePath = resolve(distDirectory, relativePath);
  if (filePath !== distDirectory && !filePath.startsWith(`${distDirectory}${sep}`)) {
    return jsonResponse(response, 403, { error: 'Forbidden.' });
  }

  try {
    const file = await readFile(filePath);
    const contentTypes = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2'
    };
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(file);
  } catch {
    if (extname(pathname)) return jsonResponse(response, 404, { error: 'File not found.' });
    const index = createReadStream(resolve(distDirectory, 'index.html'));
    index.on('error', () => jsonResponse(response, 500, { error: 'Built app is unavailable.' }));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    index.pipe(response);
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', 'http://localhost');
  if (url.pathname === '/api/kiosk/pair' && request.method === 'POST') {
    const address = request.socket.remoteAddress || 'unknown';
    const attempt = kioskAttempts.get(address);
    if (attempt && attempt.until > Date.now() && attempt.count >= 5) {
      return jsonResponse(response, 429, { error: 'Too many attempts. Wait five minutes and try again.' });
    }

    try {
      const body = await readJson(request);
      if (!equalSecret(body.password, kioskPassword)) {
        const current = attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 300_000 };
        current.count += 1;
        kioskAttempts.set(address, current);
        return jsonResponse(response, 401, { error: 'Incorrect pairing password. Try again.' });
      }
      kioskAttempts.delete(address);
      const token = randomBytes(32).toString('hex');
      kioskSessions.set(token, Date.now() + 8 * 60 * 60_000);
      return jsonResponse(response, 200, { token });
    } catch (error) {
      return jsonResponse(response, 400, {
        error: error instanceof Error ? error.message : 'Could not connect the kiosk.'
      });
    }
  }

  if (url.pathname === '/api/kiosk/urls' && request.method === 'GET') {
    if (!validTeacherSession(request)) {
      return jsonResponse(response, 401, { error: 'Teacher session expired. Sign in again.' });
    }
    const requestHost = request.headers.host || '';
    const hostName = new URL(`http://${requestHost}`).hostname;
    const urls = [];
    if (hostName !== 'localhost' && hostName !== '127.0.0.1') {
      urls.push(`http://${requestHost}/?kiosk=1`);
    }
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal) {
          urls.push(`http://${address.address}:${port}/?kiosk=1`);
        }
      }
    }
    return jsonResponse(response, 200, { urls: [...new Set(urls)] });
  }

  if (url.pathname === '/api/state' && request.method === 'GET') {
    if (!validKioskSession(request) && !validTeacherSession(request)) {
      return jsonResponse(response, 401, { error: 'Enter the kiosk pairing password to connect.' });
    }
    return jsonResponse(response, 200, publicState());
  }

  if (url.pathname === '/api/action' && request.method === 'POST') {
    if (!validKioskSession(request) && !validTeacherSession(request)) {
      return jsonResponse(response, 401, { error: 'Enter the kiosk pairing password to connect.' });
    }
    try {
      const body = await readJson(request);
      const result = await mutate((current) => {
        if (body.action === 'join-queue') {
          const student = cleanStudent(body.student);
          if (!reasons.has(body.reason) || !groupForReason(body.reason)) {
            throw new Error('Choose a limited destination before joining a line.');
          }
          if (current.history.some((trip) => !trip.returnedAt && sameName(trip.student, student))) {
            throw new Error(`${student} is already signed out.`);
          }
          const group = groupForReason(body.reason);
          if (current.queue.some((item) => sameName(item.student, student) && item.group === group)) {
            throw new Error('You are already in this line.');
          }
          return {
            ...current,
            queue: [...current.queue, {
              id: randomUUID(),
              student,
              reason: body.reason,
              group,
              joinedAt: new Date().toISOString()
            }]
          };
        }

        if (body.action === 'start-trip') {
          return startTrip(current, cleanStudent(body.student), body.reason, body.queueId || null);
        }

        if (body.action === 'return-trip') {
          const activeTrip = current.history.find((trip) => trip.id === body.tripId && !trip.returnedAt);
          if (!activeTrip) throw new Error('That sign-out was already returned or could not be found.');
          const history = current.history.map((trip) => {
            if (trip.id !== activeTrip.id) return trip;
            return { ...trip, returnedAt: new Date().toISOString() };
          });
          return { ...current, history };
        }

        throw new Error('Unknown tracker action.');
      });
      return jsonResponse(response, 200, result);
    } catch (error) {
      return jsonResponse(response, 409, {
        error: error instanceof Error ? error.message : 'Could not update the tracker.'
      });
    }
  }

  if (url.pathname === '/api/teacher/login' && request.method === 'POST') {
    const address = request.socket.remoteAddress || 'unknown';
    const attempt = loginAttempts.get(address);
    if (attempt && attempt.until > Date.now() && attempt.count >= 5) {
      return jsonResponse(response, 429, { error: 'Too many attempts. Wait five minutes and try again.' });
    }

    try {
      const body = await readJson(request);
      if (!equalSecret(body.pin, teacherPin)) {
        const current = attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 300_000 };
        current.count += 1;
        loginAttempts.set(address, current);
        return jsonResponse(response, 401, { error: 'Incorrect PIN. Please try again.' });
      }
      loginAttempts.delete(address);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + 30 * 60_000);
      return jsonResponse(response, 200, { token });
    } catch (error) {
      return jsonResponse(response, 400, {
        error: error instanceof Error ? error.message : 'Could not sign in.'
      });
    }
  }

  if (url.pathname === '/api/teacher/history' && request.method === 'GET') {
    if (!validTeacherSession(request)) {
      return jsonResponse(response, 401, { error: 'Teacher session expired. Sign in again.' });
    }
    return jsonResponse(response, 200, state);
  }

  if (url.pathname.startsWith('/api/')) {
    return jsonResponse(response, 404, { error: 'API route not found.' });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(response, 405, { error: 'Method not allowed.' });
  }
  return serveStatic(url.pathname, response);
}

async function start() {
  try {
    const saved = JSON.parse(await readFile(dataPath, 'utf8'));
    if (!Array.isArray(saved.history) || !Array.isArray(saved.queue)) {
      throw new Error('Saved tracker data has an invalid format.');
    }
    state = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persist(state);
  }

  await readFile(resolve(distDirectory, 'index.html'));
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error('Tracker request failed:', error);
      if (!response.headersSent) jsonResponse(response, 500, { error: 'Tracker server error.' });
      else response.destroy();
    });
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Classroom tracker is running on port ${port}.`);
    console.log(`On this computer: http://localhost:${port}/`);
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal) {
          console.log(`On this network: http://${address.address}:${port}/`);
        }
      }
    }
    console.log(`Data file: ${dataPath}`);
    console.warn('Use only on a school-approved, trusted network. HTTP traffic is not encrypted.');
  });
}

start().catch((error) => {
  console.error('Could not start the classroom tracker:', error);
  process.exitCode = 1;
});
