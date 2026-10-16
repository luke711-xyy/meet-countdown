/** Screening control state lives only in WebSocket attachments, never in DO memory. */
export type ScreeningPeer = {
  socketId: string;
  memberId: string;
  deviceId?: string;
  sessionId?: string;
  lastSeq?: number;
  sharer?: boolean;
  hasSourceAudio?: boolean;
  paused?: boolean;
  pendingPause?: boolean;
  lastDanmakuAt?: number;
  negotiationId?: string;
  usedNegotiationIds?: string[];
  micEnabled?: boolean;
};

type Control = { sessionId: string; seq: number };
type SignalKind = 'offer' | 'answer' | 'ice';
type SignalData = { type: 'offer' | 'answer'; sdp: string } | {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

export type ScreeningCommand =
  | { type: 'screening.join'; deviceId: string; takeover: boolean }
  | ({ type: 'screening.leave' } & Control)
  | ({ type: 'screening.share'; active: boolean; hasSourceAudio: boolean } & Control)
  | ({ type: 'screening.signal'; kind: SignalKind; negotiationId: string; targetDeviceId: string; data: SignalData } & Control)
  | ({ type: 'screening.mic'; enabled: boolean } & Control)
  | ({ type: 'screening.danmaku'; text: string } & Control)
  | ({ type: 'screening.pause.request' | 'screening.pause.confirm'; paused: boolean } & Control);

export type ScreeningTransition = {
  peers: ScreeningPeer[];
  events: Array<{ socketId: string; type: string; payload: unknown }>;
};

const MAX_MESSAGE_BYTES = 65_536;
const MAX_USED_NEGOTIATIONS = 64;
const MAX_DANMAKU_CHARS = 80;
const DANMAKU_INTERVAL_MS = 1_000;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
// Negotiation IDs are retained in attachments; constrain their encoded size as well as history length.
const negotiationId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Read only top-level property names/values; never parse an oversized packet as a whole.
function topLevelMessageType(raw: string): string | null {
  let index = 0;
  const whitespace = () => { while (/\s/.test(raw[index] ?? '')) index++; };
  const readString = (): string | null => {
    if (raw[index] !== '"') return null;
    index++;
    let value = '';
    let tooLong = false;
    while (index < raw.length) {
      const char = raw[index++];
      if (char === '"') return tooLong ? '' : value;
      let decoded = char;
      if (char === '\\') {
        const escape = raw[index++];
        if (escape === 'u') {
          const hex = raw.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          decoded = String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else {
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escape === undefined || !Object.hasOwn(escapes, escape)) return null;
          decoded = escapes[escape];
        }
      } else if (char.charCodeAt(0) < 32) {
        return null;
      }
      if (!tooLong) {
        value += decoded;
        if (value.length > 128) { tooLong = true; value = ''; }
      }
    }
    return null;
  };
  const skipValue = () => {
    const start = index;
    const closers: string[] = [];
    let inString = false;
    while (index < raw.length) {
      const char = raw[index];
      if (inString) {
        if (char === '\\') { index += 2; continue; }
        if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        closers.push(char === '{' ? '}' : ']');
      } else if (char === '}' || char === ']') {
        if (!closers.length) return char === '}' && index > start;
        if (closers.pop() !== char) return false;
      } else if (char === ',' && !closers.length) {
        return index > start;
      }
      index++;
    }
    return false;
  };

  whitespace();
  if (raw[index++] !== '{') return null;
  let type: string | null = null;
  while (index < raw.length) {
    whitespace();
    if (raw[index] === '}') {
      index++;
      whitespace();
      return index === raw.length ? type : null;
    }
    const key = readString();
    if (key === null) return null;
    whitespace();
    if (raw[index++] !== ':') return null;
    whitespace();
    if (key === 'type') {
      type = readString();
      if (type === null) return null;
    } else if (!skipValue()) {
      return null;
    }
    whitespace();
    if (raw[index] === ',') { index++; continue; }
    if (raw[index] !== '}') return null;
  }
  return null;
}

/** Keep legacy pointer/doodle packets unrestricted; reject other oversized packets before JSON.parse. */
export function shouldRejectOversizedRealtimeMessage(raw: string): boolean {
  if (raw.length <= MAX_MESSAGE_BYTES && new TextEncoder().encode(raw).length <= MAX_MESSAGE_BYTES) return false;
  const type = topLevelMessageType(raw);
  return type !== 'pointer' && type !== 'doodle.preview';
}

export function parseScreeningMessage(raw: string): ScreeningCommand | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) return null;
  try {
    const input: unknown = JSON.parse(raw);
    if (!object(input) || !object(input.payload)) return null;
    const payload = input.payload;
    if (input.type === 'screening.join') {
      if (!id(payload.deviceId) || (payload.takeover !== undefined && typeof payload.takeover !== 'boolean')) return null;
      return { type: 'screening.join', deviceId: payload.deviceId, takeover: payload.takeover === true };
    }
    if (!id(payload.sessionId) || !Number.isSafeInteger(payload.seq) || (payload.seq as number) < 1) return null;
    const control = { sessionId: payload.sessionId, seq: payload.seq as number };
    switch (input.type) {
      case 'screening.leave': return { type: input.type, ...control };
      case 'screening.share':
        if (typeof payload.active !== 'boolean') return null;
        if (payload.active && typeof payload.hasSourceAudio !== 'boolean') return null;
        if (!payload.active && payload.hasSourceAudio !== undefined && payload.hasSourceAudio !== false) return null;
        return { type: input.type, ...control, active: payload.active, hasSourceAudio: payload.active ? payload.hasSourceAudio as boolean : false };
      case 'screening.mic':
        return typeof payload.enabled === 'boolean' ? { type: input.type, ...control, enabled: payload.enabled } : null;
      case 'screening.danmaku': {
        if (typeof payload.text !== 'string') return null;
        const text = payload.text.trim();
        return text && [...text].length <= MAX_DANMAKU_CHARS ? { type: input.type, ...control, text } : null;
      }
      case 'screening.pause.request':
      case 'screening.pause.confirm':
        return typeof payload.paused === 'boolean' ? { type: input.type, ...control, paused: payload.paused } : null;
      case 'screening.signal': {
        const kind = payload.kind;
        if ((kind !== 'offer' && kind !== 'answer' && kind !== 'ice') || !negotiationId(payload.negotiationId) || !id(payload.targetDeviceId) || !object(payload.data)) return null;
        let data: SignalData;
        if (kind === 'offer' || kind === 'answer') {
          if (payload.data.type !== kind || typeof payload.data.sdp !== 'string' || !payload.data.sdp) return null;
          data = { type: kind, sdp: payload.data.sdp };
        } else {
          if (typeof payload.data.candidate !== 'string') return null;
          const { sdpMid, sdpMLineIndex, usernameFragment } = payload.data;
          if (sdpMid !== undefined && sdpMid !== null && typeof sdpMid !== 'string') return null;
          if (sdpMLineIndex !== undefined && sdpMLineIndex !== null && (!Number.isInteger(sdpMLineIndex) || (sdpMLineIndex as number) < 0)) return null;
          if (usernameFragment !== undefined && usernameFragment !== null && typeof usernameFragment !== 'string') return null;
          data = { candidate: payload.data.candidate };
          if (sdpMid !== undefined) data.sdpMid = sdpMid as string | null;
          if (sdpMLineIndex !== undefined) data.sdpMLineIndex = sdpMLineIndex as number | null;
          if (usernameFragment !== undefined) data.usernameFragment = usernameFragment as string | null;
        }
        return { type: input.type, ...control, kind, negotiationId: payload.negotiationId, targetDeviceId: payload.targetDeviceId, data };
      }
      default: return null;
    }
  } catch {
    return null;
  }
}

type ScreeningSocket = {
  serializeAttachment(attachment: Record<string, unknown>): void;
  send(message: string): void;
};

/** Persist the transition before delivering events; a failed attachment write must not relay an offer. */
export function applyScreeningTransition(
  result: ScreeningTransition,
  byId: Map<string, { socket: ScreeningSocket; attachment: Record<string, unknown> }>,
  encodeEvent: (event: ScreeningTransition['events'][number]) => string,
): boolean {
  try {
    for (const peer of result.peers) {
      const entry = byId.get(peer.socketId);
      if (!entry) continue;
      const nextAttachment = { ...entry.attachment, ...peer };
      if (JSON.stringify(entry.attachment) !== JSON.stringify(nextAttachment)) {
        entry.socket.serializeAttachment(nextAttachment);
      }
    }
  } catch {
    return false;
  }
  for (const event of result.events) {
    const socket = byId.get(event.socketId)?.socket;
    if (!socket) continue;
    try { socket.send(encodeEvent(event)); } catch { /* disconnected sockets are cleaned by the runtime */ }
  }
  return true;
}

export function transitionScreening(
  peers: ScreeningPeer[],
  actorSocketId: string,
  command: ScreeningCommand,
  nowMs: number,
  createSessionId: () => string,
): ScreeningTransition {
  const next = peers.map((peer) => ({ ...peer }));
  const events: ScreeningTransition['events'] = [];
  const actor = next.find((peer) => peer.socketId === actorSocketId);
  const result = { peers: next, events };
  if (!actor || !actor.memberId) return result;
  const active = () => next.filter((peer) => peer.sessionId && peer.deviceId);
  const sendActive = (type: string, payload: unknown) => {
    for (const peer of active()) events.push({ socketId: peer.socketId, type, payload });
  };
  const resetNegotiation = () => {
    for (const peer of next) peer.negotiationId = undefined;
  };
  const clear = (peer: ScreeningPeer) => {
    peer.deviceId = undefined;
    peer.sessionId = undefined;
    peer.lastSeq = undefined;
    peer.sharer = undefined;
    peer.paused = undefined;
    peer.pendingPause = undefined;
    peer.lastDanmakuAt = undefined;
    peer.negotiationId = undefined;
    peer.usedNegotiationIds = undefined;
    peer.micEnabled = undefined;
    peer.hasSourceAudio = undefined;
  };

  if (command.type === 'screening.join') {
    if (actor.sessionId) return result;
    const members = new Set(active().map((peer) => peer.memberId));
    if (members.size >= 2 && !members.has(actor.memberId)) return result;
    const prior = active().find((peer) => peer.memberId === actor.memberId);
    if (prior && !command.takeover) {
      events.push({ socketId: actor.socketId, type: 'screening.device-in-use', payload: { memberId: actor.memberId } });
      return result;
    }
    if (prior) {
      const wasSharer = prior.sharer === true;
      const priorDeviceId = prior.deviceId;
      clear(prior);
      if (wasSharer) for (const peer of active()) { peer.paused = false; peer.pendingPause = undefined; }
      events.push({ socketId: prior.socketId, type: 'screening.taken-over', payload: { memberId: actor.memberId, deviceId: command.deviceId } });
      for (const peer of active()) events.push({ socketId: peer.socketId, type: 'screening.peer.left', payload: { memberId: actor.memberId, deviceId: priorDeviceId } });
      if (wasSharer) sendActive('screening.share.changed', { memberId: actor.memberId, deviceId: priorDeviceId, active: false, hasSourceAudio: false });
    }
    resetNegotiation();
    actor.deviceId = command.deviceId;
    actor.sessionId = createSessionId();
    actor.lastSeq = 0;
    actor.usedNegotiationIds = [];
    actor.sharer = false;
    actor.hasSourceAudio = false;
    actor.paused = false;
    const others = active().filter((peer) => peer !== actor);
    events.push({ socketId: actor.socketId, type: 'screening.joined', payload: {
      sessionId: actor.sessionId,
      memberId: actor.memberId,
      deviceId: actor.deviceId,
      peers: others.map((peer) => ({ memberId: peer.memberId, deviceId: peer.deviceId, sharer: peer.sharer === true, paused: peer.paused === true, micEnabled: peer.micEnabled === true, hasSourceAudio: peer.sharer === true && peer.hasSourceAudio === true })),
    } });
    for (const peer of others) events.push({ socketId: peer.socketId, type: 'screening.peer.joined', payload: { memberId: actor.memberId, deviceId: actor.deviceId } });
    return result;
  }

  if (!actor.sessionId || command.sessionId !== actor.sessionId || command.seq <= (actor.lastSeq ?? 0)) return result;
  actor.lastSeq = command.seq;
  if (command.type === 'screening.leave') {
    const wasSharer = actor.sharer === true;
    const deviceId = actor.deviceId;
    clear(actor);
    resetNegotiation();
    if (wasSharer) for (const peer of active()) { peer.paused = false; peer.pendingPause = undefined; }
    sendActive('screening.peer.left', { memberId: actor.memberId, deviceId });
    if (wasSharer) sendActive('screening.share.changed', { memberId: actor.memberId, deviceId, active: false, hasSourceAudio: false });
    return result;
  }

  if (command.type === 'screening.share') {
    if (command.active) {
      if (actor.sharer) {
        if (actor.hasSourceAudio === command.hasSourceAudio) return result;
        actor.hasSourceAudio = command.hasSourceAudio;
        sendActive('screening.share.changed', { memberId: actor.memberId, deviceId: actor.deviceId, active: true, hasSourceAudio: command.hasSourceAudio });
        return result;
      }
      if (active().some((peer) => peer.sharer)) return result;
      actor.sharer = true;
      actor.hasSourceAudio = command.hasSourceAudio;
      for (const peer of active()) { peer.paused = false; peer.pendingPause = undefined; }
    } else {
      if (!actor.sharer) return result;
      actor.sharer = false;
      actor.hasSourceAudio = false;
      for (const peer of active()) { peer.paused = false; peer.pendingPause = undefined; }
    }
    resetNegotiation();
    sendActive('screening.share.changed', { memberId: actor.memberId, deviceId: actor.deviceId, active: command.active, hasSourceAudio: actor.hasSourceAudio === true });
    return result;
  }

  if (command.type === 'screening.signal') {
    const target = active().find((peer) => peer.memberId !== actor.memberId && peer.deviceId === command.targetDeviceId);
    if (!target) return result;
    if (command.kind === 'offer') {
      if (!actor.sharer || target.sharer || actor.negotiationId === command.negotiationId || actor.usedNegotiationIds?.includes(command.negotiationId)) return result;
      actor.usedNegotiationIds = [...(actor.usedNegotiationIds ?? []).slice(1 - MAX_USED_NEGOTIATIONS), command.negotiationId];
      actor.negotiationId = command.negotiationId;
      target.negotiationId = command.negotiationId;
    } else {
      if (actor.negotiationId !== command.negotiationId || target.negotiationId !== command.negotiationId) return result;
      if (command.kind === 'answer' && (actor.sharer || !target.sharer)) return result;
    }
    events.push({ socketId: target.socketId, type: 'screening.signal', payload: {
      memberId: actor.memberId, deviceId: actor.deviceId, sessionId: actor.sessionId,
      kind: command.kind, negotiationId: command.negotiationId, data: command.data,
    } });
    return result;
  }

  if (command.type === 'screening.mic') {
    if (actor.micEnabled === command.enabled) return result;
    actor.micEnabled = command.enabled;
    sendActive('screening.mic.changed', { memberId: actor.memberId, deviceId: actor.deviceId, enabled: command.enabled });
    return result;
  }

  if (command.type === 'screening.danmaku') {
    if (actor.lastDanmakuAt !== undefined && nowMs - actor.lastDanmakuAt < DANMAKU_INTERVAL_MS) return result;
    actor.lastDanmakuAt = nowMs;
    sendActive('screening.danmaku', { memberId: actor.memberId, deviceId: actor.deviceId, text: command.text });
    return result;
  }

  const sharer = active().find((peer) => peer.sharer);
  if (!sharer) return result;
  if (command.type === 'screening.pause.request') {
    if (sharer.paused === command.paused || sharer.pendingPause === command.paused) return result;
    sharer.pendingPause = command.paused;
    sendActive('screening.pause.requested', { memberId: actor.memberId, deviceId: actor.deviceId, paused: command.paused });
  } else if (command.type === 'screening.pause.confirm' && actor === sharer && sharer.pendingPause === command.paused) {
    for (const peer of active()) { peer.paused = command.paused; peer.pendingPause = undefined; }
    sendActive('screening.pause.confirmed', { memberId: actor.memberId, deviceId: actor.deviceId, paused: command.paused });
  }
  return result;
}
