# Two-Person Screening Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a restrained, two-person screening mode to the existing countdown room with live screen sharing, bidirectional voice, ephemeral danmaku and honest pause requests.

**Architecture:** Keep the existing authenticated Worker/Durable Object WebSocket for signaling and controls. Send screen and voice tracks over one browser-to-browser WebRTC connection with public STUN only and no TURN relay; render the received stream in a native `<video>` beneath semantic DOM controls. No media frames enter Worker, D1, R2 or Three.js.

**Tech Stack:** Cloudflare Worker + Durable Object (TypeScript), browser ES modules, WebRTC, existing CSS tokens, Node 22 built-in test runner, Wrangler local development, real-browser acceptance checks.

**Spec:** `docs/superpowers/specs/2026-10-16-two-person-screening-room-design.md`

## Global Constraints

- Existing rooms have at most two members and may temporarily contain only the creator; authenticate every WebSocket operation against room membership.
- Only one active screening device per member and one screen sharer per room. A second device must explicitly take over.
- Screen sharing and microphone access require separate user gestures and permission; no automatic capture on entry.
- Pausing an arbitrary external player is a **request plus sharer confirmation**, never a fake freeze or remote-control claim.
- Screen, voice and danmaku are ephemeral. No D1 migration, R2 upload, recording or history for this feature.
- Direct peer-to-peer media only. Do not create a TURN key, Worker TURN secrets, ICE-credential endpoint or relay fallback; tell users plainly when direct ICE fails.
- Starting quality target: 1080p/30 fps; 720p/30 fps fallback. 60 fps is optional, not a promise.
- Use `html-in-canvas-frontend` **overlay** mode: native video and DOM/CSS controls; no video texture upload to the ripple canvas.
- Keep both text themes, the current glass/orb vocabulary, mobile safe areas, keyboard access and `prefers-reduced-motion`.
- Existing unrelated changes and untracked `.DS_Store`, `.codex/`, and `minitool-guide-src/` must be preserved and excluded from feature commits.

## Review Focus

1. A reload during a call must replace stale device/ICE messages without reviving old media; pin this in Task 1 state tests and Task 5 two-browser checks.
2. Dismissing capture permission must leave the room usable and leak no track; pin this in Task 2 media tests.
3. A captured source with no audio track must still show video and visibly say the film audio is absent; pin this in Task 2 tests and Task 3 UI checks.
4. A second tab on the same account must not create two offers or two audible copies; pin explicit takeover in Task 1 tests and Task 5 acceptance.
5. Unsupported mobile screen capture, blocked audio autoplay or direct ICE failure must leave viewing, danmaku and explicit status usable; pin this in Task 3 UI checks and Task 5 mobile acceptance.

## File Map

- `src/screening-protocol.ts`: pure parser, limits, and hibernation-safe transition reducer for screening messages.
- `src/worker.ts`: `CoupleRoom` screening dispatch and WebSocket attachment updates; no media or ICE-credential endpoint.
- `public/screening-media.js`: capture, microphone tracks, direct-only peer negotiation, reconnect, stats and cleanup.
- `public/screening-room.js`: DOM controller, screening state, danmaku, pause request UI and media-controller coordination.
- `public/index.html`, `public/styles.css`: topbar entry and responsive glass-overlay screen.
- `public/app.js`, `public/water-background.js`: integration with existing room/socket lifecycle and GPU suspension.
- `tests/screening-protocol.test.mjs`, `tests/screening-media.test.mjs`, `tests/screening-ui.test.mjs`, `tests/screening-lifecycle.test.mjs`: focused Node tests; browser matrix is run in Task 5.

---

### Task 1: Hibernation-safe screening protocol and room routing

**Files:** Create `src/screening-protocol.ts`, `tests/screening-protocol.test.mjs`; modify `src/worker.ts:731-806`, `package.json` test script.

**Interfaces:** `parseScreeningMessage(raw: string): ScreeningCommand | null`; `transitionScreening(peers: ScreeningPeer[], actorSocketId: string, command: ScreeningCommand, nowMs: number, createSessionId: () => string): ScreeningTransition`. A `ScreeningPeer` is reconstructed from each WebSocket's serialized attachment (`socketId`, authenticated `memberId`, optional `deviceId`/`sessionId`, `lastSeq`, `sharer`, `hasSourceAudio`, `paused`, `lastDanmakuAt`). `ScreeningTransition = { peers: ScreeningPeer[]; events: Array<{ socketId: string; type: string; payload: unknown }> }`, where `events` are addressed deliveries. Commands are `screening.join` (`deviceId`, `takeover`), `leave`, `share` (`active`, `hasSourceAudio`), `signal` (`offer`/`answer`/`ice`, `negotiationId`, `targetDeviceId`), `mic`, `danmaku`, `pause.request`, and `pause.confirm`. All commands after join carry `sessionId` and strictly increasing `seq`; local sharing is confirmed only by `screening.share.changed`, including a rejection race against the other sharer.

- [ ] **Step 1: Write failing protocol tests.** In `tests/screening-protocol.test.mjs`, name tests `rejects malformed and oversized messages`, `enforces two-member device and sharer ownership`, `rejects stale sequence and negotiation`, `rate-limits short danmaku`, and `requires sharer pause confirmation`. Pin the cases with assertions such as:
  ```js
  assert.equal(parseScreeningMessage('x'.repeat(65_537)), null);
  assert.equal(takeover.events.some((event) => event.type === 'screening.taken-over'), true);
  assert.equal(secondSharer.events.some((event) => event.type === 'screening.share.changed'), false);
  assert.deepEqual(staleIce.events, []);
  ```
- [ ] **Step 2: Run the focused test.** `node --experimental-strip-types --test tests/screening-protocol.test.mjs` → expected FAIL because the module/export does not exist.
- [ ] **Step 3: Implement parser/reducer and DO adapter.** Add the signatures above; `CoupleRoom.fetch` assigns `socketId` in serialized attachment, `webSocketMessage` routes `screening.*` through the reducer and writes changed attachments with `serializeAttachment`, and `webSocketClose`/`webSocketError` notify the remaining device. Accepted `screening.share` events echo authenticated `requestSeq: command.seq` so a retry cannot consume a stale confirmation. Never trust `memberId` or `actorId` in JSON. Reconstruct state from `ctx.getWebSockets()` on every message so hibernation preserves it. Do not alter existing pointer/doodle behavior. Add `"test": "node --experimental-strip-types --test tests/screening-*.test.mjs"` to `package.json`.
- [ ] **Step 4: Run verification.** Focused test PASS; `npx tsc --noEmit --allowImportingTsExtensions --module esnext --moduleResolution bundler --target es2022 src/screening-protocol.ts` and `npm run deploy:dry` PASS.
- [ ] **Step 5: Commit only Task 1 files.** `git add src/screening-protocol.ts src/worker.ts tests/screening-protocol.test.mjs package.json && git commit -m "feat: add screening room signaling protocol"`.

### Task 2: Direct-only browser media session with audio-first adaptation

**Files:** Create `public/screening-media.js`, `tests/screening-media.test.mjs`.

**Interfaces:** `createScreeningMedia({ sendSignal, onShareChange, onMicChange, onRemoteStream, onStatus, onQuality, mediaDevices = navigator.mediaDevices, PeerConnection = RTCPeerConnection })` returns `{ startSharing, stopSharing, enableMic, setMicEnabled, handleSignal, restartIce, close }`. `sendSignal({ kind, negotiationId, data })` emits media-only SDP/ICE; the Task 3 controller adds the authenticated session, sequence and target device. `onShareChange({ active, hasSourceAudio })` and `onMicChange(enabled)` report local state to that controller, which sends Task 1's share/mic commands. The only ICE server is `{ urls: 'stun:stun.cloudflare.com:3478' }`; no `turn:` or `turns:` URL and no ICE-credential fetch. `startSharing()` invokes `getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true })` synchronously from its button handler before its first `await`; it reports `{ hasVideo: true, hasSourceAudio: boolean }`. `close()` is idempotent and stops every owned track/timer.

- [ ] **Step 1: Write failing fake-media tests.** Name tests `cancelled capture leaves session intact`, `video-only source reports no film audio`, `mic is opt-in and processed`, `close stops every owned track once`, `stale signal is ignored`, `direct ICE failure is explicit`, and `sustained loss degrades video first`. Use injected media/RTC fakes; pin assertions including:
  ```js
  await assert.rejects(session.startSharing(), { name: 'NotAllowedError' });
  assert.equal(shareChanges.length, 0);
  assert.equal((await videoOnly.startSharing()).hasSourceAudio, false);
  assert.equal(screenTrack.stopCalls, 1);
  assert.equal(JSON.stringify(peer.config.iceServers).includes('turn:'), false);
  ```
- [ ] **Step 2: Run focused tests.** `node --test tests/screening-media.test.mjs` → expected FAIL for missing module.
- [ ] **Step 3: Implement media controller.** Use the direct-only STUN configuration above, attach separate source-audio and mic tracks, negotiate with Task 1 targeted signal events, and use `getStats()` every 2–5 seconds for frame rate, resolution, loss, jitter, RTT and candidate type. Start at 1080p/30 where source/device allows, fall back to 720p/30 and bounded bitrates; attempt a bounded ICE restart after disconnection. After bounded failure, report that direct connection failed and suggest changing networks; never imply relay fallback. Keep an HTML-video stream separate from WebGL.
- [ ] **Step 4: Verify.** Focused tests PASS; `node --check public/screening-media.js` PASS.
- [ ] **Step 5: Commit only Task 2 files.** `git add public/screening-media.js tests/screening-media.test.mjs && git commit -m "feat: add peer-to-peer screening media session"`.

### Task 3: Glass screening surface and controls

**Files:** Create `public/screening-room.js`, `tests/screening-ui.test.mjs`; modify `public/index.html:50-110`, `public/styles.css:120-160,310-382`, `package.json`, `package-lock.json` for a test DOM dependency.

**Interfaces:** `createScreeningRoom({ root, trigger, send, getContext, onOpenChange, createMedia = createScreeningMedia })` returns `{ open, close, handleEvent, onSocketOpen, onSocketClose, dispose }`. `getContext()` returns `{ roomId, memberId, members }`; `send(command)` uses the existing authenticated socket. The controller owns the Task 1 session/sequence/target-device envelope, maps media `sendSignal` to `screening.signal`, and maps `onShareChange`/`onMicChange` to Task 1 commands. The optional media factory is a test seam; production uses Task 2's factory.

- [ ] **Step 1: Add a DOM test dependency.** Run `npm install -D jsdom`; verify `package.json` and `package-lock.json` include it, without changing runtime dependencies.
- [ ] **Step 2: Write failing UI checks.** In `tests/screening-ui.test.mjs`, name tests `entry and glass controls remain accessible`, `unsupported capture leaves viewer controls usable`, `missing source audio is explicit`, `direct connection failure is explicit`, and `pause and autoplay states are honest`. Assert:
  ```js
  assert.equal(trigger.getAttribute('aria-label'), '进入放映室');
  assert.equal(shareButton.disabled, true);
  assert.equal(micButton.disabled, false);
  assert.match(status.textContent, /未共享影片声音|开启声音|等待分享者确认/);
  ```
- [ ] **Step 3: Run UI checks and observe failure.** `node --test tests/screening-ui.test.mjs` → expected FAIL because no screening DOM/controller exists.
- [ ] **Step 4: Implement semantic overlay and controller.** Add the screen-outline topbar orb next to settings. Use existing `--ink`, `--line`, `--surface`, `--ease-out`, 38–42 px circles and translucent glass. Native `<video>` is `object-fit: contain`; danmaku has length/rate/lane caps and never covers the bottom controls. Keep the overlay above rails/settings but below auth; add mobile safe-area layout, keyboard Escape/focus return, reduced-motion fallback and an honest direct-connection-failed status. No copy-heavy panel or extra slogans.
- [ ] **Step 5: Verify visually and accessibly.** `node --test tests/screening-ui.test.mjs` PASS; inspect screenshots at 1440×900, 390×844 and 768×1024 in both themes; verify focus order, tap targets, contrast and non-overlap with video.
- [ ] **Step 6: Commit only Task 3 files.** `git add public/screening-room.js public/index.html public/styles.css package.json package-lock.json tests/screening-ui.test.mjs && git commit -m "feat: add restrained screening room interface"`.

### Task 4: Integrate room lifecycle and suspend background GPU work

**Files:** Create `tests/screening-lifecycle.test.mjs`; modify `public/app.js:1-28,592-625,690-720,730-855`, `public/water-background.js:296-370`; update asset query versions in `public/index.html`.

**Interfaces:** Task 3 controller receives the existing room socket and authenticated identity. Add `WaterBackground.setSuspended(suspended: boolean): void`: `true` stops scheduling frames and ignores ripple wakes; `false` restores current content and resumes on demand.

- [ ] **Step 1: Write failing lifecycle checks.** In `tests/screening-lifecycle.test.mjs`, name tests `opening suspends background and drawing`, `exit restores countdown`, `room teardown is idempotent`, and `reconnect discards old media session`. With injected DOM/media fakes, assert:
  ```js
  assert.equal(document.body.classList.contains('is-screening'), true);
  assert.equal(water.running, false);
  assert.equal(media.closeCalls, 1);
  assert.equal(document.body.classList.contains('is-screening'), false);
  ```
- [ ] **Step 2: Run checks and observe failure.** `node --test tests/screening-lifecycle.test.mjs` → expected FAIL because integration/suspension does not exist.
- [ ] **Step 3: Wire modules.** Feed `screening.*` from `applyRealtimeEvent` to the controller and forward WebSocket open/close events. Exclude the screening overlay from doodle hit testing and apply `body.is-screening` while open. Suspend water rendering while open and restore on exit. Keep the existing room-state and pointer/doodle handlers unchanged outside screening. Dispose before auth/room teardown and suppress the existing delayed socket reconnect after explicit room destruction/logout.
- [ ] **Step 4: Verify.** `npm test`, `node --check public/app.js`, `node --check public/water-background.js`, `git diff --check`, and `npm run deploy:dry` PASS.
- [ ] **Step 5: Commit only Task 4 files.** `git add public/app.js public/water-background.js public/index.html tests/screening-lifecycle.test.mjs && git commit -m "feat: integrate screening with countdown room lifecycle"`.

### Task 5: Two-device acceptance, network failure paths and release gate

**Files:** Add `tests/screening-worker.integration.mjs` and focused fixes only where test evidence requires them; update `README.md`, `package.json`, `package-lock.json` for browser WebSocket test client and direct-only limits.

**Interfaces:** Reuse the earlier tasks; no new public API. Local integration test starts against `wrangler dev --local --port 8787` with migrated local D1 and two temporary registered users.

- [ ] **Step 1: Prepare a test client.** Run `npm install -D ws` for authenticated Cookie-header WebSocket clients; apply local D1 migrations with `npx wrangler d1 migrations apply meet-countdown-db --local`.
- [ ] **Step 2: Write failing end-to-end checks.** In `tests/screening-worker.integration.mjs`, name tests `nonmember WebSocket cannot signal`, `signaling reaches only addressed peer`, `takeover invalidates first device`, and `pause and room destruction reach both clients`; pin assertions such as `assert.equal(guestWs.status, 401)`, `assert.equal(otherDeviceOfferCount, 0)`, `assert.equal(oldDeviceCanShare, false)` and `assert.equal(peerEvents.at(-1).type, 'room.destroyed')`. Cover stale-session rejection and danmaku rate limiting.
- [ ] **Step 3: Run the new checks against a local Worker.** Start `npm run dev:cloudflare`, then run `node --test tests/screening-worker.integration.mjs` against port 8787 → expected FAIL before final integration corrections. A test requiring a real browser/media source must be labeled manual, not green by proxy.
- [ ] **Step 4: Fix only observed integration defects and rerun checks.** `node --test tests/screening-worker.integration.mjs`, `npm test`, and `npm run deploy:dry` must PASS with local Wrangler running.
- [ ] **Step 5: Run the real-media matrix.** In two separate browsers/devices test both sharing directions, tab with/without audio, simultaneous conversation with headphones, denied screen/mic permissions, direct ICE, restricted-network failure messaging, network loss/reconnect, a same-account second tab, refresh, room destruction, mobile watch-only path, autoplay recovery and source-ended cleanup. Record actual `getStats()` resolution/fps/loss/jitter/RTT; only claim 1080p/30 when observed. Verify no media payload in Worker/D1/R2.
- [ ] **Step 6: Inspect rendered UI.** Compare entry/orbs with the existing theme at desktop, iPad and phone widths; confirm no overlap, accessible controls, both themes and reduced motion. Fix issues and repeat checks.
- [ ] **Step 7: Document the actual operating boundary.** Update `README.md` with user-gesture permissions, tab-audio limitations, external-player pause-request semantics, direct-only network limits and the tested browsers; no credentials or private room IDs.
- [ ] **Step 8: Commit verified fixes and docs.** Stage `tests/screening-worker.integration.mjs`, `README.md`, `package.json`, `package-lock.json` and only verified fix paths; commit with message `test: verify two-person screening room`. Do not deploy to production until real-browser media is verified; if deployment is requested, deploy then read back the live asset versions and repeat a two-account smoke test.
