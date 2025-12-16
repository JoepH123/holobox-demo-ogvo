// ============================
// ========== CONFIG ==========
// ============================

import {
  LiveAvatarSession,
  SessionEvent,
} from "https://esm.run/@heygen/liveavatar-web-sdk@0.0.9";
/**
 * Number of past turns to include when sending context to the backend.
 * Keep small to reduce token/latency costs while preserving coherence.
 */
const MAX_CONTEXT_MESSAGES = 5;

/**
 * Custom endpoint that performs streamed OpenAI completion over fetch.
 * Expected protocol: server sends frames prefixed with `data:` (content)
 * and `sources:` (JSON array of citations), separated by blank lines.
 */

// Initialize to empty string if not defined (fallback), because this is injected in index.html based on the
// tenant which is retrieved from the domain.
window.CUSTOM_API_OPENAI_URL = window.CUSTOM_API_OPENAI_URL || "";

// Init avatar globals, some are from tenant which is retrieved from the domain.
let avatarOnline = false
window.showAvatar = window.showAvatar || false;
window.avatarID = window.avatarID || "";
window.liveAvatar = window.liveAvatar || {
  sessionToken: null,
  sessionInfo: null,
  room: null,
  stop: null,
};

/**
 * File size limits for uploads (enforced client-side prior to upload).
 */
const MAX_PER_FILE = 10 * 1024 * 1024;   // 10 MB per file
const MAX_TOTAL    = 32 * 1024 * 1024;   // 32 MB per message (sum of attachments)

// ===========================
// ========== STATE ==========
// ===========================

const context = [];               // rolling context buffer (chat transcript)
let abortController = null;       // used to cancel in-flight streaming requests
const all_citations = [];         // reserved for global citation collection if needed
const pendingFiles = [];          // uploaded file "intents" for current message
// pendingFiles: { id, displayName, displayUrl, openaiUrl, size }
// - displayUrl: original file URL (what users download)
// - openaiUrl: URL sent to OpenAI (same as displayUrl for PDFs; for DOCX it's the converted PDF URL)
const uploadedFiles = [];         // flat list of all uploaded URLs (telemetry/debug)

// ==========================
// ========== DOM ==========
// ==========================

const messagesDiv     = document.getElementById('messages');
const userInput       = document.getElementById('userInput');
const sendBtn         = document.getElementById('sendBtn');
const resetBtn        = document.getElementById('resetBtn');
const promptContainer = document.getElementById('promptButtons');
const sourcesContainer= document.querySelector('.sources');
const avatarMedia     = document.getElementById("avatarMedia"); // img placeholder
const avatarVideo     = document.getElementById("avatarVideo"); // actual video element
const btnStartStop = document.getElementById("btnStartStop");
const btnInterrupt = document.getElementById("btnInterrupt");

// ======================================
// ========== INLINE SVG ICONS ==========
// ======================================

const ICON_COPY = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M16 8V5.2C16 4.0799 16 3.51984 15.782 3.09202C15.5903 2.71569 15.2843 2.40973 14.908 2.21799C14.4802 2 13.9201 2 12.8 2H5.2C4.0799 2 3.51984 2 3.09202 2.21799C2.71569 2.40973 2.40973 2.71569 2.21799 3.09202C2 3.51984 2 4.0799 2 5.2V12.8C2 13.9201 2 14.4802 2.21799 14.908C2.40973 15.2843 2.71569 15.5903 3.09202 15.782C3.51984 16 4.0799 16 5.2 16H8M11.2 22H18.8C19.9201 22 20.4802 22 20.908 21.782C21.2843 21.5903 21.5903 21.2843 21.782 20.908C22 20.4802 22 19.9201 22 18.8V11.2C22 10.0799 22 9.51984 21.782 9.09202C21.5903 8.71569 21.2843 8.40973 20.908 8.21799C20.4802 8 19.9201 8 18.8 8H11.2C10.0799 8 9.51984 8 9.09202 8.21799C8.71569 8.40973 8.40973 8.71569 8.21799 9.09202C8 9.51984 8 10.0799 8 11.2V18.8C8 19.9201 8 20.4802 8.21799 20.908C8.40973 21.2843 8.71569 21.5903 9.09202 21.782C9.51984 22 10.0799 22 11.2 22Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
</svg>`;

const ICON_CHECK = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M20.6097 5.20743C21.0475 5.54416 21.1294 6.17201 20.7926 6.60976L10.7926 19.6098C10.6172 19.8378 10.352 19.9793 10.0648 19.9979C9.77765 20.0166 9.49637 19.9106 9.29289 19.7072L4.29289 14.7072C3.90237 14.3166 3.90237 13.6835 4.29289 13.2929C4.68342 12.9024 5.31658 12.9024 5.70711 13.2929L9.90178 17.4876L19.2074 5.39034C19.5441 4.95258 20.172 4.87069 20.6097 5.20743Z" fill="currentColor" stroke-width="1.5"></path>
</svg>`;

// ==================================
// ======= Instruction prompt =======
// ==================================
  let instruction_prompt;

  async function loadInstructions() {
    const res = await fetch("/api/get_instructions");
    if (!res.ok) throw new Error("Fetch failed");
    return await res.text();
  }

  (async function init() {
    try {
      instruction_prompt = await loadInstructions();

      // safe to use instruction_prompt here or after this runs
    } catch (e) {
      console.error(e);
      instruction_prompt = "je bent een onderwijs docent assistent"; // fallback if you want it always defined
    }
  })();

// =======================================================
// ======= Resizer: change width of bronnen column =======
// =======================================================

(function () {
  const layout  = document.querySelector('.layout');
  const sidebar = document.querySelector('.sidebar');
  const resizer = document.querySelector('.resizer');
  const root    = document.documentElement;

  // Optional: remember previous size
  const saved = localStorage.getItem('sidebarPct');
  if (saved) root.style.setProperty('--sidebar-pct', saved);

  let dragging = false;

  const clamp = (val, min, max) => Math.min(max, Math.max(min, val));

  function onPointerDown(e) {
    dragging = true;
    layout.classList.add('is-resizing');
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const rect = layout.getBoundingClientRect();
    // Mouse X relative to the layout container
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    // Convert to percentage of layout width
    let pct = x / rect.width;
    // Clamp sidebar between 15% and 40%
    pct = clamp(pct, 0.15, 0.40);
    const pctStr = (pct * 100).toFixed(2) + '%';
    root.style.setProperty('--sidebar-pct', pctStr);
  }

  function onPointerUp() {
    dragging = false;
    layout.classList.remove('is-resizing');
    document.removeEventListener('pointermove', onPointerMove);
    // Persist
    const current = getComputedStyle(root).getPropertyValue('--sidebar-pct').trim();
    localStorage.setItem('sidebarPct', current);
  }

  // Keyboard accessibility: Left/Right to resize in 2% steps (still clamped 15–33%)
  function onKeyDown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const current = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-pct'));
    const delta = (e.key === 'ArrowLeft') ? -2 : 2;
    const next = clamp((current + delta), 15, 40);
    const pctStr = next.toFixed(2) + '%';
    root.style.setProperty('--sidebar-pct', pctStr);
    localStorage.setItem('sidebarPct', pctStr);
  }

  resizer.addEventListener('pointerdown', onPointerDown);
  resizer.addEventListener('keydown', onKeyDown);
})();

// ==================================
// ========== UTIL FUNCTIONS ========
// ==================================

// Toggle button for opening and closing chat
document.addEventListener('DOMContentLoaded', () => {
    // 1. Select the elements needed
    const toggleButton = document.getElementById('chatToggleBtn');
    // Note: Selecting by class to match your CSS snippet
    const chatFrame = document.querySelector('.visible-outside-frame');

    // Safety check: Ensure elements exist before trying to add events
    if (toggleButton && chatFrame) {
        
        toggleButton.addEventListener('click', () => {
            // 2. Toggle the 'is-hidden' class on the frame container.
            // This applies the CSS rule: .visible-outside-frame.is-hidden
            chatFrame.classList.toggle('is-hidden');
            
            // Optional: Toggle a class on the button itself for visual feedback
            toggleButton.classList.toggle('chat-off');
        });
        
    } else {
        console.error("Could not find Chat Toggle Button or Visible Outside Frame in the DOM.");
    }
});

/** Update avatar card status (live indicator). This should be called when the connection to liveAvatar is made */
function updateAvatarStatus(live) {
  // 1. Existing logic for the Avatar Card
  const avatarCard = document.getElementById("avatarCard");
  if (avatarCard) {
    avatarCard.classList.toggle("live", live);
  }

  // 2. NEW LOGIC: Select the overlay
  const overlay = document.querySelector(".overlay-unconnected");
  
  if (overlay) {
    // If live is TRUE, we ADD "is-hidden" (Overlay disappears)
    // If live is FALSE, we REMOVE "is-hidden" (Overlay appears)
    overlay.classList.toggle("is-hidden", live);
  }
}

/** Scroll the container so that the given message is at the top, with bottom padding. */
function scrollToBottomWithPadding(msgEl) {
  if (!msgEl) return;
  // Use container height minus message height as padding so the last bubble isn't flush with the edge.
  messagesDiv.style.paddingBottom = `${messagesDiv.clientHeight - msgEl.offsetHeight}px`;
  msgEl.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
}

/** Render Markdown → compact HTML (strip extra whitespace between tags). */
function toTightHtml(text) {
  return marked
    .parse(text)
    .replace(/\n+/g, '')
    .replace(/>\s+</g, '><'); // remove inter-tag gaps that create layout whitespace
}

/** Toggle the send button busy state. */
function setBusy(isBusy) {
  sendBtn.classList.toggle('busy', isBusy);
}

/** Create and append a copy-to-clipboard button inside a message bubble. */
function addCopyButton(msgEl) {
  if (!msgEl) return;
  const contentToCopy = msgEl.innerText; // plain text copy of the bubble

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.type = 'button';
  copyBtn.innerHTML = ICON_COPY;

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(contentToCopy);
      copyBtn.innerHTML = ICON_CHECK;
      setTimeout(() => (copyBtn.innerHTML = ICON_COPY), 1500); // reset back to copy icon
    } catch (err) {
      console.error('Clipboard error:', err);
    }
  });

  msgEl.appendChild(copyBtn);
}

/**
 * Add source citation chips. Clicking a chip downloads the file from the local server.
 * @param {string|string[]} refs - one or more file names
 */
function addCitation(refs) {
  const files = Array.isArray(refs) ? refs : [refs];
  files.forEach((fn) => {
    // If chip already exists, reinsert it at the top to indicate recency of use.
    const existing = Array.from(sourcesContainer.querySelectorAll('.citation'))
      .find((el) => el.dataset.fn === fn);

    let chip = existing || document.createElement('div');

    if (!existing) {
      chip.className = 'citation';
      chip.dataset.fn = fn;
      chip.textContent = fn;
      chip.style.cursor = 'pointer';
      // Long function that calls download function, but also makes sure that the loading symbol is rendered
      chip.addEventListener('click', async () => {
        // Guard against double-clicks
        if (chip.dataset.downloading === '1') return;
        chip.dataset.downloading = '1';

        // Show spinner (CSS handles the animation)
        chip.classList.add('loading');

        const MIN_SPIN_MS = 350; // small minimum loading time so it never looks glitchy
        const start = performance.now();

        const buildUrl = (f) => `/api/file_download?fn=${encodeURIComponent(f)}`;

        try {
          // Preflight: ask our backend for the SAS redirect but don't follow it.
          // This also "warms up" any cold start and keeps the spinner visible
          // *until* the real download click.
          const res = await fetch(buildUrl(fn), { method: 'GET', redirect: 'manual', cache: 'no-cache' });

          // Prefer backend-provided redirect target if present; otherwise fall back to the local URL
          const redirectTarget = res.headers.get('Location') || buildUrl(fn);

          // Enforce the minimum spinner time
          const elapsed = performance.now() - start;
          const wait = Math.max(0, MIN_SPIN_MS - elapsed);

          setTimeout(() => {
            // Trigger the real browser download
            const a = document.createElement('a');
            a.href = redirectTarget;     // go straight to SAS URL if we got it
            a.download = fn;             // hint to save-as
            a.rel = 'noopener noreferrer';

            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Remove spinner right when download is triggered
            chip.classList.remove('loading');
            chip.dataset.downloading = '0';
          }, wait);
        } catch (err) {
          console.error('Download prep failed:', err);

          // Fail-safe: try direct download without preflight and clear spinner
          const a = document.createElement('a');
          a.href = buildUrl(fn);
          a.download = fn;
          a.rel = 'noopener noreferrer';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          chip.classList.remove('loading');
          chip.dataset.downloading = '0';
        }
      });
      chip.insertAdjacentHTML(
        'beforeend',
        '<svg class="citation-icon" aria-hidden="true" focusable="false">' +
          '<use href="#icon-download"></use>' +
        '</svg>'
      );
    } else {
      // Remove then reinsert so it appears at the top of the list.
      sourcesContainer.removeChild(chip);
    }

    sourcesContainer.insertBefore(chip, sourcesContainer.firstChild);
  });
}

/**
 * Render a message bubble and return its element.
 * @param {'user'|'assistant'} role
 * @param {string} text - markdown (assistant) or plain text (user)
 * @param {boolean} [isLoading=false] - whether this is a streaming placeholder
 */
function renderMessage(role, text, isLoading = false) {
  messagesDiv.classList.remove("empty");
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role}${isLoading ? ' loading' : ''}`;

  if (role === 'user') {
    // Escape + convert newlines for user text to prevent HTML injection.
    const safe = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\r?\n/g, '<br>');

    msgEl.innerHTML = safe;
    messagesDiv.appendChild(msgEl);
    scrollToBottomWithPadding(msgEl);
  } else {
    // For assistant, start with a placeholder; text is filled while streaming.
    msgEl.textContent = text;
    messagesDiv.appendChild(msgEl);
  }

  return msgEl;
}

/**
 * Convert a .docx File → PDF on the client using Mammoth (docx→html) + html2pdf.
 * Returns a new File instance of the produced PDF with a generated filename.
 */
async function convertDocxToPdfClient(file) {
  // 1) Read DOCX bytes into memory for Mammoth.
  const arrayBuffer = await file.arrayBuffer();

  // 2) Convert DOCX → HTML (inline images for the browser)
  const result = await window.mammoth.convertToHtml(
    { arrayBuffer },
    { convertImage: window.mammoth.images.inline() }
  );
  const html = result.value; // HTML string output

  // 3) Render HTML off-screen so html2pdf can measure/layout accurately
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.left = '-99999px';
  iframe.width = '0';
  iframe.height = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  doc.open();
  // Basic A4 layout; tweak styles to match your brand/fonts
  doc.write(`
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        @page { size: A4; margin: 24pt; }
        body { margin: 24pt; font-family: Arial, Helvetica, sans-serif; }
        img { max-width: 100%; }
        table { border-collapse: collapse; width: 100%; }
        table, th, td { border: 1px solid #ccc; }
        h1,h2,h3 { margin-top: 1.2em; }
      </style>
    </head>
    <body>${html}</body>
    </html>
  `);
  doc.close();

  // 4) HTML → PDF (blob)
  const opts = {
    margin:       0,
    filename:     file.name.replace(/\.docx$/i, '.pdf'),
    image:        { type: 'jpeg', quality: 0.75 },
    html2canvas:  { scale: 1, useCORS: true },
    jsPDF:        { unit: 'pt', format: 'a4', orientation: 'portrait' }
  };

  // html2pdf returns a Promise; outputPdf('blob') yields a Blob
  const pdfBlob = await html2pdf().from(doc.body).set(opts).outputPdf('blob');
  iframe.remove(); // cleanup hidden iframe

  // Wrap in a File so your existing uploader sees a “real” PDF file
  return new File([pdfBlob], opts.filename, { type: 'application/pdf' });
}

// Basic notifier (replace with a toast UI if you have one)
function notify(msg){
  try { alert(msg); } catch(e) { console.log(msg); }
}

// True if file is a .pdf or .docx by extension or MIME
function isAllowedFile(file){
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const byExt = ext === 'pdf' || ext === 'docx';
  const byMime = file.type === 'application/pdf' ||
                 file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return byExt || byMime;
}

// Current total (what's already attached for THIS message)
function getCurrentTotalSize(){
  return (pendingFiles || []).reduce((sum, f) => sum + (f?.size || 0), 0);
}

// Human-readable for messages
function human(bytes){
  return formatBytes(bytes); // pass-through to keep one formatter source of truth
}

// ============================================
// ========== PROMPT BUTTON SHORTCUTS ==========
// ============================================

function hidePrompts() {
  if (promptContainer) promptContainer.style.display = 'none';
}

if (promptContainer) {
  // Delegate simple autofill behavior to prompt buttons.
  promptContainer.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      userInput.value = btn.textContent;
      hidePrompts();
      // Auto-resize to content but clamp to 25% viewport height.
      userInput.style.height = 'auto';
      const maxHeight = window.innerHeight * 0.25; // px limit before scrollbar appears
      const newHeight = Math.min(userInput.scrollHeight, maxHeight);
      userInput.style.height = `${newHeight}px`;
      userInput.style.overflowY = userInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
      userInput.focus();
    });
  });
}

// ==============================================
// ========== STREAMING AVATAR ==================
// ==============================================


/* ========== START STREAMING (no stop/cleanup here) ========== */
async function startAvatarStreaming() {
  const avatarVideo = window.avatarVideo;
  const avatarMedia = window.avatarMedia;
  const LANGUAGE = "nl";

  try {
    // 1) Get session token from your backend
    const tokRes = await fetch("/api/get_liveavatar_token", { method: "POST" });
    if (!tokRes.ok) throw new Error("Token request failed");
    const tokJson = await tokRes.json();
    const sessionToken = tokJson?.data?.session_token;
    if (!sessionToken) throw new Error("No token returned from backend");

    // 2) Create LiveAvatarSession (this will call /v1/sessions/start inside)
    const session = new LiveAvatarSession(sessionToken, {
      voiceChat: false,
    });

    window.liveAvatar = window.liveAvatar || {};
    window.liveAvatar.session = session;

    // When both audio+video are ready, attach to your <video>
    session.on(SessionEvent.SESSION_STREAM_READY, () => {
      if (avatarMedia) avatarMedia.style.display = "none";
      avatarVideo.style.display = "block";

      session.attach(avatarVideo);  // SDK attaches both audio and video
      avatarVideo.muted = false;
      avatarVideo.volume = 1;
      avatarVideo.play().catch(() => {});
    });

    // Sync buttons when the session disconnects (for any reason)
    session.on(SessionEvent.SESSION_DISCONNECTED, () => {
      btnStartStop.dataset.state = 'start';
      btnInterrupt.disabled = true;
      btnStartStop.title = "Verbinden";
      avatarOnline = false;
      updateAvatarStatus(false);
    });

    await session.start();

    console.log("✅ Avatar streaming (SDK) started");
    avatarOnline = true;
    updateAvatarStatus(true);
    return session;
  } catch (err) {
    console.error("startAvatarStreaming error:", err);
    avatarOnline = false;
    updateAvatarStatus(false);
    return null;
  }
}

async function stopAvatarStreaming() {
  const avatarVideo = window.avatarVideo;
  const avatarMedia = window.avatarMedia;
  const session = window.liveAvatar?.session;

  try {
    if (session) {
      await session.stop();  // does full cleanup + /v1/sessions/stop
    }
  } catch (e) {
    console.warn("stopAvatarStreaming: session.stop failed", e);
  }

  try {
    if (avatarVideo) {
      avatarVideo.srcObject = null;
      avatarVideo.removeAttribute("src");
      avatarVideo.load?.();
      avatarVideo.style.display = "none";
    }
    if (avatarMedia) avatarMedia.style.display = "block";
  } catch {}

  console.log("🛑 Avatar streaming stopped");
  avatarOnline = false;
  updateAvatarStatus(false);
}

/* Optional: clean up when leaving the page */
window.addEventListener("beforeunload", () => {
  // Fire-and-forget; no await on unload
  stopAvatarStreaming();
});

async function speakAvatar(inputText) {
  const text = inputText && inputText.trim();
  if (!text) return;

  const session = window.liveAvatar?.session;
  if (!session) {
    console.error("speakAvatar: no active session");
    return;
  }

  // Uses avatar.speak_text under the hood
  session.repeat(text);
}

async function interruptSpeaking() {
  const session = window.liveAvatar?.session;
  if (!session) {
    console.error("interruptSpeaking: no active session");
    return;
  }

  // Uses avatar.interrupt under the hood
  session.interrupt();
}


// ==============================================
// ==========  AVATAR BUTTONS  ==================
// ==============================================

// Ensure initial state
if (btnStartStop && !btnStartStop.dataset.state) {
  btnStartStop.dataset.state = 'start';
}

// Helpers for loading state
const beginLoading = (el, label = null) => {
  if (!el) return;
  el.classList.add('loading');
  el.setAttribute('aria-busy', 'true');
  if (label) el.setAttribute('aria-label', label);
};
const endLoading = (el) => {
  if (!el) return;
  el.classList.remove('loading');
  el.removeAttribute('aria-busy');
};

// Start / Stop toggle
btnStartStop?.addEventListener('click', async () => {
  if (btnStartStop.classList.contains('loading')) return;

  const state = btnStartStop.dataset.state || 'start';
  const starting = state === 'start';

  try {
    beginLoading(btnStartStop, starting ? 'Starting…' : 'Stopping…');

    if (starting) {
      const ok = await startAvatarStreaming();
      if (ok) {
        btnStartStop.dataset.state = 'stop';  // 🔴 turn red
        btnInterrupt.disabled = false; // enable interrupt
        btnStartStop.title = "Verbinding verbreken"
        controlHideTimer = setTimeout(() => {
          hideAvatarControls();
        }, 2500);
      } else {
        btnStartStop.dataset.state = 'start';
        btnInterrupt.disabled = true; // disable when not streaming
        btnStartStop.title = "Verbinden"
      }
    } else {
      await stopAvatarStreaming();
      btnStartStop.dataset.state = 'start';   // 🟢 turn green
      btnInterrupt.disabled = true; // disable when not streaming
      btnStartStop.title = "Verbinden"
    }
  } catch (err) {
    console.error('Start/Stop error:', err);
    btnStartStop.dataset.state = 'start';
    btnInterrupt.disabled = true; // disable when not streaming
    btnStartStop.title = "Verbinden"
  } finally {
    endLoading(btnStartStop);
  }
});

btnInterrupt?.addEventListener("click", async () => {
  if (!window.liveAvatar?.session) {
    console.warn("No active session to interrupt.");
    return;
  }

  try {
    beginLoading(btnInterrupt, "Interrupting…");
    const res = await interruptSpeaking();
    if (res.ok) {
      console.log("🟡 Interrupt sent successfully");
    } else {
      console.warn("Interrupt request failed");
    }
  } catch (err) {
    console.error("Interrupt failed:", err);
  } finally {
    setTimeout(() => {
      endLoading(btnInterrupt);
    }, 500);  // minimum time that the spinner is visible
  }
});

// Reset UI state on unload
window.addEventListener('beforeunload', () => {
  try { btnStartStop.dataset.state = 'start'; } catch {}
});

// =================================
// === Avatar Controls Auto-Hide ===
// =================================

let controlHideTimer = null;

function getAvatarBits() {
  const card = document.getElementById('visible-frame');
  const controls = card?.querySelector('.avatar-controls');
  return { card, controls };
}

function showAvatarControls() {
  const { controls } = getAvatarBits();
  if (!controls) return;
  controls.classList.remove('auto-hidden');
}

function hideAvatarControls() {
  const { card, controls } = getAvatarBits();
  if (!controls) return;
  // Skip hiding if mouse is currently over the avatar card
  if (card.matches(':hover')) return;
  controls.classList.add('auto-hidden');
}

function clearControlsTimer() {
  if (controlHideTimer) {
    clearTimeout(controlHideTimer);
    controlHideTimer = null;
  }
}

/**
 * Setup hover listeners once.
 * - Always show on mouseenter
 * - If streaming, schedule a 3s hide on mouseleave
 */
(function initAvatarControlsHover() {
  const { card } = getAvatarBits();
  if (!card) return;

  card.addEventListener('mouseenter', () => {
    clearControlsTimer();
    showAvatarControls();
  });

  card.addEventListener('mouseleave', () => {
    clearControlsTimer();
    if (avatarOnline) {
      controlHideTimer = setTimeout(() => {
        hideAvatarControls();
      }, 100);
    }
  });
})();

/**
 * Call this after streaming starts: show controls now, then if not hovered,
 * schedule the 3s auto-hide.
 */
function scheduleAutoHideIfNotHovered() {
  const { card } = getAvatarBits();
  if (!card) return;
  clearControlsTimer();

  // If mouse isn't currently over the card, hide after 3s
  if (!card.matches(':hover')) {
    controlHideTimer = setTimeout(() => {
      hideAvatarControls();
    }, 3000);
  }
}

// ==============================================
// ========== STREAMING SEND FLOW (SSE) =========
// ==============================================

async function sendMessage() {
  const text = userInput.value.trim();
  if (!text && !pendingFiles.length) return; // nothing to send

  setBusy(true);

  if (window.showAvatar === true && avatarOnline === true){
          await interruptSpeaking()
      }

  renderMessage('user', text);

  // show attachments inside the just-rendered user bubble
  const userBubble = messagesDiv.lastElementChild;
  if (pendingFiles.length) appendAttachmentsToMessage(userBubble, pendingFiles);

  // reset input field sizing
  userInput.value = '';
  userInput.style.height = 'auto';

  // Clear attachments strip after moving them into the message
  document.getElementById('attachments').innerHTML = '';

  // Create the assistant bubble in "loading" state (will stream content)
  const bubble = renderMessage('assistant', '...', true);
  
  // Build content payload: user text + any file parts (as OpenAI content array)
  const contentParts = [{ type: "input_text", text }];
  pendingFiles.forEach(f => contentParts.push({ type: "input_file", file_url: f.openaiUrl }));  
  context.push({ role: 'user', content: contentParts });

  // Reset pending list after it's been used (preserves uploadedFiles history)
  pendingFiles.length = 0;

  // Limit context to most recent N messages
  const payload = context.slice(-MAX_CONTEXT_MESSAGES);

  let fullText = '';
  let citations = null; // will hold array from server if provided
  try {
    abortController = new AbortController();

    const response = await fetch(window.CUSTOM_API_OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: payload, instruction: instruction_prompt }),
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      // include server message to aid debugging
      throw new Error(await response.text());
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Read loop — protocol frames are separated by blank lines ("\n\n").
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // Append the chunk; decode in streaming mode to preserve multi-byte sequences
      buffer += decoder.decode(value, { stream: true });

      // Split into complete frames; keep the trailing partial in `buffer`
      const parts = buffer.split('\n\n');
      buffer = parts.pop(); // leftover partial frame (may be empty)

      for (const chunk of parts) {
        if (chunk.startsWith('data: ')) {
          // Content frame: { content: "..." }
          try {
            const json = JSON.parse(chunk.slice(6));
            fullText += json.content || '';
            bubble.innerHTML = toTightHtml(fullText); // progressively render markdown
          } catch (e) {
            console.warn('Bad data frame:', chunk, e);
          }
        } else if (chunk.startsWith('sources: ')) {
          // Citations frame: JSON stringified array
          try {
            citations = JSON.parse(chunk.slice(9));
          } catch (e) {
            console.warn('Bad sources frame:', chunk, e);
          }
        }
      }
    }

    // Done streaming – finalize bubble content and styling
    bubble.classList.remove('loading');
    bubble.innerHTML = toTightHtml(fullText || '');

    // If server provided citations, render chips (defensive checks included)
    if (citations && Array.isArray(citations) && citations.length) {
      addCitation(citations);
    }

    // Persist assistant message into context as plain text (no HTML)
    context.push({ role: 'assistant', content: bubble.textContent });
    if (window.showAvatar === true && avatarOnline === true){
        await speakAvatar(bubble.textContent)
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      // Silently finalize the bubble after a manual stop
      bubble.classList.remove('loading');
      context.push({ role: 'assistant', content: bubble.textContent });
    } else {
      console.error(err);
      bubble.classList.remove('loading');
      renderMessage('assistant', '⚠️ Sorry, er ging iets verkeerd.', false);
    }
  } finally {
    setBusy(false);
    addCopyButton(bubble);
    userInput.focus();
  }
}

// ==========================================
// ========== EVENT LISTENERS (UI) ==========
// ==========================================

// Auto-resize the textarea as the user types
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  const maxHeight = window.innerHeight * 0.25; // px limit before scrollbar appears
  const newHeight = Math.min(userInput.scrollHeight, maxHeight);
  userInput.style.height = `${newHeight}px`;
  userInput.style.overflowY = userInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
});

// Send/stop button toggles between sending and aborting
sendBtn.addEventListener('click', () => {
  if (sendBtn.classList.contains('busy')) {
    if (abortController) {
      abortController.abort();
      abortController = null; // clear handle
    }
  } else {
    sendMessage();
    hidePrompts();
  }
});

// Enter to send (Shift+Enter for newline)
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.classList.contains('busy')) sendBtn.click();
  }
});

// Reset conversation to a clean state (full page reload ensures all state resets)
resetBtn.addEventListener('click', async () => {
  location.reload();
});

// ==================================
// ========== BYTES UTILITY ==========
// ==================================

// UTIL: bytes -> human readable (e.g., 1.2 MB)
function formatBytes(bytes){
  if (!bytes && bytes !== 0) return '';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, n = Math.max(bytes, 0);
  while(n >= 1024 && i < units.length-1){ n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// =====================================================
// ========== ATTACHMENT CHIP (UI + STATE HOOK) =========
// =====================================================

/**
 * Render an attachment chip and return an API to control its state.
 * The returned handle exposes an id, alive flag, and helper methods.
 */
function addAttachmentChip(file){
  const wrap = document.getElementById('attachments'); // container strip for chips
  const chip = document.createElement('div');
  chip.className = 'attach-chip';

  // Generate a stable unique id with native crypto API, fallback to timestamp+rand
  const id = (crypto?.randomUUID && crypto.randomUUID()) ||
             ('att-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
  chip.dataset.attachId = id;

  // left icon
  const icon = document.createElement('div');
  icon.className = 'attach-icon';
  icon.innerHTML = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 2a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6H6zm7 1.5L18.5 9H13V3.5z"/>
    </svg>`;
  chip.appendChild(icon);

  // meta (name + size)
  const meta = document.createElement('div');
  meta.className = 'attach-meta';
  const name = document.createElement('div'); name.className = 'attach-name'; name.textContent = file.name;
  const size = document.createElement('div'); size.className = 'attach-size'; size.textContent = formatBytes(file.size);
  meta.appendChild(name); meta.appendChild(size);
  chip.appendChild(meta);

  // progress bar
  const bar = document.createElement('div'); bar.className = 'attach-progress';
  const fill = document.createElement('span'); bar.appendChild(fill);
  chip.appendChild(bar);

  // remove button
  const removeBtn = document.createElement('button');
  removeBtn.className = 'attach-remove'; removeBtn.type = 'button'; removeBtn.title = 'Verwijderen'; removeBtn.innerHTML = '&times;';
  chip.appendChild(removeBtn);

  // state flag so upload .then() knows if chip is still alive
  let alive = true;

  // Remove corresponding entry from pendingFiles
  const removeFromPending = () => {
    if (Array.isArray(pendingFiles)) {
      const i = pendingFiles.findIndex(p => p && p.id === id);
      if (i > -1) pendingFiles.splice(i, 1);
    }
  };

  const handle = {
    id,
    get alive(){ return alive; },
    updateProgress: (percent) => { fill.style.width = Math.max(0, Math.min(100, percent)) + '%'; },
    markDone: () => { fill.style.width = '100%'; chip.classList.add('done'); bar.remove(); },
    remove: () => { alive = false; removeFromPending(); chip.remove(); }
  };

  removeBtn.addEventListener('click', () => { handle.remove(); });

  wrap.appendChild(chip);
  return handle;
}

// =====================================================
// ========== FILE UPLOADS (NETWORK OPERATIONS) =========
// =====================================================

/**
 * Upload a File to Azure Blob Storage using a SAS URL retrieved from the backend.
 * Returns the blob URL *without* the SAS query string (safe to display/share).
 */
async function uploadFileToAzure(file, chipApi) {
  // 1. Ask backend for SAS URL (server returns a pre-signed PUT URL)
  const res = await fetch("/api/file_upload?filename=" + encodeURIComponent(file.name));
  const sasUrl = await res.text();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sasUrl, true);
    xhr.setRequestHeader("x-ms-blob-type", "BlockBlob");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    // Track progress for chip UI
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        const percent = (evt.loaded / evt.total) * 100;
        chipApi.updateProgress(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        chipApi.markDone();
        // Return the clean blob URL (strip ?SAS) for display/download
        resolve(sasUrl.split("?")[0]);
      } else {
        reject(new Error("Azure upload failed: " + xhr.statusText));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));

    xhr.send(file);
  });
}

/**
 * Upload a .docx, convert it client-side to PDF, then upload the PDF.
 * Returns the pair of URLs (display/download docx + openai PDF) and metadata.
 */
async function uploadDocxAndConvertClient(file, chipApi) {
  // 1) Upload the original .docx (what users will click/download in the chat)
  const docxUrl = await uploadFileToAzure(file, chipApi);

  // 2) Convert DOCX → PDF client-side
  const pdfFile = await convertDocxToPdfClient(file);

  // 3) Upload the produced PDF (this is what you’ll send to OpenAI)
  const pdfUrl = await uploadFileToAzure(pdfFile, chipApi);

  return {
    displayName: file.name,       // show original docx name in the chat
    displayUrl: docxUrl,          // when clicked, user downloads the docx
    openaiUrl: pdfUrl,            // send this to OpenAI
    size: file.size
  };
}

// =====================================
// ========== FILE PICKER HOOKUP =========
// =====================================

const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  const selected = Array.from(e.target.files || []);

  // Track how much of the 32MB cap we are about to consume in THIS selection
  let selectionBytesAccepted = 0;

  selected.forEach((file) => {
    // 1) Type check (UI already filters, but keep the guard)
    if (!isAllowedFile(file)) {
      notify("Alleen .docx en .pdf-bestanden zijn toegestaan.");
      return; // ❌ do not upload
    }

    // 2) Per-file max (10 MB)
    if (file.size > MAX_PER_FILE) {
      notify(`Bestand te groot: “${file.name}” is ${formatBytes(file.size)} (max 10 MB).`);
      return; // ❌ do not upload
    }

    // 3) Total-per-message max (32 MB) — current pending + already accepted in this selection + this file
    const alreadyPending = getCurrentTotalSize();
    const wouldBeTotal = alreadyPending + selectionBytesAccepted + file.size;
    if (wouldBeTotal > MAX_TOTAL) {
      const remaining = MAX_TOTAL - alreadyPending - selectionBytesAccepted;
      notify(
        `Totale bijlage-limiet overschreden door “${file.name}”. ` +
        `Er is nog ${remaining > 0 ? formatBytes(remaining) : '0 B'} over (max 32 MB per bericht).`
      );
      return; // ❌ do not upload
    }

    // If we reach here, the file is accepted. Now render a chip and start the upload.
    const chipApi = addAttachmentChip(file);
    const id = chipApi.id;
    const ext = (file.name.split('.').pop() || '').toLowerCase();

    // Increment our accepted counter so subsequent files respect 32MB cap within this selection
    selectionBytesAccepted += file.size;

    if (ext === 'pdf') {
      uploadFileToAzure(file, chipApi)
        .then((url) => {
          if (!chipApi.alive) return; // chip removed while uploading
          pendingFiles.push({
            id,
            displayName: file.name,
            displayUrl: url,
            openaiUrl: url,
            size: file.size,
          });
          uploadedFiles.push(url);
        })
        .catch((err) => { console.error(err); notify("Upload mislukt."); });

    } else if (ext === 'docx') {
      uploadDocxAndConvertClient(file, chipApi)
        .then((fileInfo) => {
          if (!chipApi.alive) return; // chip removed while converting/uploading
          fileInfo.id = id; // keep chip ↔ pending link
          pendingFiles.push(fileInfo); // size equals original .docx size
          uploadedFiles.push(fileInfo.displayUrl, fileInfo.openaiUrl);
        })
        .catch((err) => { console.error(err); notify("Client-side conversie mislukt."); });
    } else {
      // Shouldn't happen because of isAllowedFile, but just in case:
      notify("Alleen .docx en .pdf-bestanden zijn toegestaan.");
    }
  });

  // Reset the input so selecting the same file again will retrigger 'change'
  fileInput.value = '';
});

// =======================================================
// ========== RENDER ATTACHMENTS INSIDE A BUBBLE =========
// =======================================================

/**
 * Append a visual attachment strip to a message bubble while preserving existing text.
 * Structure: [attachments] → [divider] → [message-body]
 */
function appendAttachmentsToMessage(msgEl, files){
  if (!msgEl || !files || !files.length) return;

  // Mark bubble for styling hooks
  msgEl.classList.add('has-attachments');

  // If we haven't wrapped the text yet, do it now
  let body = msgEl.querySelector('.message-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = msgEl.innerHTML; // preserve the existing safe text
    msgEl.innerHTML = '';             // clear bubble to rebuild structure
  }

  // Build the attachments box
  const box = document.createElement('div');
  box.className = 'message-attachments';

  files.forEach(f => {
    const a = document.createElement('a');
    a.href = f.displayUrl;          // user downloads the original (DOCX/PDF)
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'attachment-card';

    const icon = document.createElement('div');
    icon.className = 'attachment-icon';
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M6 2a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6H6zm7 1.5L18.5 9H13V3.5z"/>
      </svg>
    `;

    const details = document.createElement('div');
    details.className = 'attachment-details';

    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = f.displayName || 'Bestand';

    const type = document.createElement('span');
    type.className = 'attachment-type';
    // Try to show file type + size, e.g. "PDF · 1.2 MB"
    const ext = (f.displayName?.split('.').pop() || '').toUpperCase();
    const sizeText = typeof f.size === 'number' ? ` · ${formatBytes(f.size)}` : '';
    type.textContent = (ext ? `${ext}` : 'Bestand') + sizeText;

    details.appendChild(name);
    details.appendChild(type);

    a.appendChild(icon);
    a.appendChild(details);
    box.appendChild(a);
  });

  // Build the labeled divider (between attachments and text)
  const divider = document.createElement('div');
  divider.className = 'attachment-divider';
  divider.innerHTML = `
    <span class="label" aria-hidden="true" title="Bijlagen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21.44 11.05l-8.49 8.49a5 5 0 01-7.07-7.07l8.49-8.49a3.5 3.5 0 015 5l-8.49 8.49a2 2 0 01-2.83-2.83l7.78-7.78"/>
      </svg>
    </span>
  `;

  // Rebuild bubble: attachments → divider → text
  msgEl.appendChild(box);
  msgEl.appendChild(divider);
  msgEl.appendChild(body);
}

// =============================
// ====== Voice Dictation ======
// =============================

// ====== Voice Dictation (always live typing + configurable auto-stop) ======
const micBtn = document.getElementById('micBtn');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// Configurable variable, that determines how long (ms) of silence to wait before auto-stopping.
const AUTO_STOP_SILENCE_MS = 1800;  // 1000 = 1s, 0 = disabled --> 1800 gives good balance for conversation

/** Update dictation status - necessary for UI styling */
function updateDictationStatus(recording) {
  const micBtn = document.getElementById("micBtn");
  if (!micBtn) return;
  micBtn.classList.toggle("recording", recording);
}

// Internal state
let recognition = null;
let listening = false;
let finalBuffer = "";
let lastStaticText = "";
let silenceTimer = null;

function ensureRecognition() {
  if (!SpeechRecognition) {
    alert("Spraakherkenning wordt niet door deze browser ondersteund. Probeer Chrome of Edge.");
    return null;
  }
  const r = new SpeechRecognition();
  r.lang = 'nl-NL' || navigator.language;
  r.interimResults = true;
  r.continuous = true;
  return r;
}

function setMicVisual(on) {
  micBtn.classList.toggle('recording', on);
  micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function resetSilenceTimer() {
  clearTimeout(silenceTimer);
  if (AUTO_STOP_SILENCE_MS > 0) {
    silenceTimer = setTimeout(() => {
      console.log(`⏸️ Auto-stopping after ${AUTO_STOP_SILENCE_MS / 1000}s of silence`);
      stopDictation();
    }, AUTO_STOP_SILENCE_MS);
  }
}

function startDictation() {
  if (listening) return;
  recognition = ensureRecognition();
  if (!recognition) return;

  listening = true;
  updateDictationStatus(true);  // Make sure button styling knows it is listening
  setMicVisual(true);
  finalBuffer = "";
  lastStaticText = userInput.value;

  recognition.onresult = (ev) => {
    resetSilenceTimer();

    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      const text = res[0]?.transcript || "";
      if (res.isFinal) {
        finalBuffer += (finalBuffer && !finalBuffer.endsWith(' ') ? ' ' : '') + text.trim();
      } else {
        interim += text;
      }
    }

    // Show text as you speak (real-time)
    const base = lastStaticText ? (lastStaticText.trimEnd() + ' ') : '';
    const full = (base + finalBuffer + (interim ? (' ' + interim) : '')).replace(/\s+/g, ' ').trimStart();
    userInput.value = full;
    userInput.dispatchEvent(new Event('input')); // triggers autoresize
  };

  recognition.onerror = (e) => {
    console.warn('Speech error:', e.error);
    stopDictation();
  };

  recognition.onend = () => {
    if (listening) stopDictation();
  };

  try {
    recognition.start();
    resetSilenceTimer(); // initialize early in case of instant silence
  } catch (e) {
    console.warn('recognition.start error:', e);
  }
}

function stopDictation() {
  if (!listening) return;
  listening = false;
  updateDictationStatus(false); // revert dictation button to normal styling
  clearTimeout(silenceTimer);
  setMicVisual(false);
  sendMessage()
  try { recognition && recognition.stop(); } catch {}
  recognition = null;
}

micBtn?.addEventListener('click', () => {
  if (listening) stopDictation();
  else startDictation();
});
