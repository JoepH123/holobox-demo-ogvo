// ============================
// ========== CONFIG ==========
// ============================

import {
  LiveAvatarSession,
  SessionEvent,
} from "https://esm.run/@heygen/liveavatar-web-sdk@0.0.9";

const MAX_CONTEXT_MESSAGES = 10;

// Globals (Injected in index.html or defaulted)
window.CUSTOM_API_OPENAI_URL = window.CUSTOM_API_OPENAI_URL || "";
let avatarOnline = false;
window.showAvatar = window.showAvatar || false;
window.liveAvatar = window.liveAvatar || { session: null };

// ===========================
// ========== STATE ==========
// ===========================

const context = [];               // Chat transcript for API context
let abortController = null;       // To cancel streaming

// ==========================
// ========== DOM ==========
// ==========================

// Hidden Debug UI
const messagesDiv     = document.getElementById('messages');
const userInput       = document.getElementById('userInput');
const sendBtn         = document.getElementById('sendBtn');

// Avatar UI
const avatarMedia     = document.getElementById("avatarMedia"); 
const avatarVideo     = document.getElementById("avatarVideo"); 
const btnStartStop    = document.getElementById("btnStartStop");
const btnInterrupt    = document.getElementById("btnInterrupt");
const micBtn          = document.getElementById("micBtn");

// ==================================
// ======= Instruction prompt =======
// ==================================
let instruction_prompt;

(async function init() {
  try {
    const res = await fetch("/api/get_instructions");
    if (res.ok) instruction_prompt = await res.text();
    else throw new Error("Fetch failed");
  } catch (e) {
    console.log("Using default instructions");
    instruction_prompt = "Je bent een behulpzame assistent.";
  }
})();

// ==================================
// ========== CORE FUNCTIONS ========
// ==================================

/**
 * Renders message.
 * MODIFIED: Instead of showing UI, this logs to Console.
 * It still appends a hidden DIV to keep the logic consistent if needed later.
 */
function renderMessage(role, text, isLoading = false) {
  // 1. Log to Console as requested
  if (isLoading) {
      console.log(`[${role.toUpperCase()}] Streaming started...`);
  } else {
      console.log(`%c[${role.toUpperCase()}]:`, 'font-weight:bold; color: ' + (role === 'user' ? 'blue' : 'green'), text);
  }

  // 2. Keep hidden DOM logic (minimal)
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role}`;
  msgEl.textContent = text; 
  messagesDiv.appendChild(msgEl);
  
  return msgEl;
}

/** Toggle the send button busy state (affects hidden button) */
function setBusy(isBusy) {
  if(sendBtn) sendBtn.disabled = isBusy;
}

/** render Markdown -> HTML (Used for the hidden bubble content) */
function toTightHtml(text) {
  // If marked isn't loaded, return plain text
  return window.marked ? window.marked.parse(text) : text;
}

// ==============================================
// ========== STREAMING AVATAR ==================
// ==============================================

async function startAvatarStreaming() {
  try {
    const tokRes = await fetch("/api/get_liveavatar_token", { method: "POST" });
    if (!tokRes.ok) throw new Error("Token request failed");
    const tokJson = await tokRes.json();
    const sessionToken = tokJson?.data?.session_token;
    if (!sessionToken) throw new Error("No token returned");

    const session = new LiveAvatarSession(sessionToken, { voiceChat: false });
    window.liveAvatar.session = session;

    session.on(SessionEvent.SESSION_STREAM_READY, () => {
      if (avatarMedia) avatarMedia.style.display = "none";
      if (avatarVideo) {
          avatarVideo.style.display = "block";
          avatarVideo.muted = false;
          avatarVideo.play().catch(e => console.log(e));
      }
    });

    session.on(SessionEvent.SESSION_DISCONNECTED, () => {
      resetAvatarUI();
    });

    await session.start();
    
    avatarOnline = true;
    updateAvatarStatus(true);
    return true;
  } catch (err) {
    console.error("Avatar start failed:", err);
    resetAvatarUI();
    return false;
  }
}

async function stopAvatarStreaming() {
  const session = window.liveAvatar?.session;
  if (session) await session.stop();
  resetAvatarUI();
}

function resetAvatarUI() {
    avatarOnline = false;
    if (avatarVideo) {
        avatarVideo.style.display = "none";
        avatarVideo.srcObject = null;
    }
    if (avatarMedia) avatarMedia.style.display = "block";
    updateAvatarStatus(false);
}

function updateAvatarStatus(isOnline) {
    btnStartStop.dataset.state = isOnline ? 'stop' : 'start';
    btnInterrupt.disabled = !isOnline;
}

async function speakAvatar(text) {
  if (!text || !window.liveAvatar?.session) return;
  window.liveAvatar.session.repeat(text);
}

async function interruptSpeaking() {
  if (window.liveAvatar?.session) window.liveAvatar.session.interrupt();
}

// ==============================================
// ==========  AVATAR CONTROLS UI  ==============
// ==============================================

// Start/Stop Click
btnStartStop?.addEventListener('click', async () => {
  if (btnStartStop.classList.contains('loading')) return;
  const isStarting = btnStartStop.dataset.state === 'start';
  
  btnStartStop.classList.add('loading');
  
  if (isStarting) {
      const success = await startAvatarStreaming();
      if(success) scheduleAutoHide();
  } else {
      await stopAvatarStreaming();
  }
  
  btnStartStop.classList.remove('loading');
});

// Interrupt Click
btnInterrupt?.addEventListener("click", async () => {
  btnInterrupt.classList.add('loading');
  await interruptSpeaking();
  setTimeout(() => btnInterrupt.classList.remove('loading'), 500);
});

// Auto-hide controls logic
let hideTimer = null;
const avatarCard = document.getElementById('avatarCard');
const controls = document.querySelector('.avatar-controls');

function scheduleAutoHide() {
    if(hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        if(!avatarCard.matches(':hover') && avatarOnline) {
            controls.classList.add('auto-hidden');
        }
    }, 2500);
}

avatarCard.addEventListener('mouseenter', () => {
    if(hideTimer) clearTimeout(hideTimer);
    controls.classList.remove('auto-hidden');
});

avatarCard.addEventListener('mouseleave', () => {
    if(avatarOnline) scheduleAutoHide();
});

// ==============================================
// ========== CHAT LOGIC (OPENAI SSE) ===========
// ==============================================

async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  setBusy(true);

  if (avatarOnline) await interruptSpeaking();

  // Render User Message (Logs to console)
  renderMessage('user', text);
  
  // Clear input
  userInput.value = '';

  // Setup Assistant Bubble (Hidden DOM + Console placeholder)
  const bubble = renderMessage('assistant', '...', true);
  
  // Prepare Context
  const payloadMsg = { role: 'user', content: [{ type: "input_text", text }] };
  context.push(payloadMsg);
  
  // Prune context
  const payload = context.slice(-MAX_CONTEXT_MESSAGES);

  let fullText = '';
  
  try {
    abortController = new AbortController();
    
    // Check if URL is loaded from settings
    const apiUrl = window.CUSTOM_API_OPENAI_URL;
    if(!apiUrl) throw new Error("No API URL loaded from tenant settings.");

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: payload, instruction: instruction_prompt }),
      signal: abortController.signal,
    });

    if (!response.ok) throw new Error(await response.text());

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop(); 

      for (const chunk of parts) {
        if (chunk.startsWith('data: ')) {
          try {
            const json = JSON.parse(chunk.slice(6));
            fullText += json.content || '';
            // Note: We don't log every chunk to console to avoid spam,
            // but we update the hidden bubble text
            bubble.innerHTML = toTightHtml(fullText); 
          } catch (e) { console.warn('Stream parse error', e); }
        }
      }
    }

    // Final Console Log of complete response
    console.log(`%c[ASSISTANT FINAL]:`, 'color: green; font-weight:bold;', fullText);

    // Save to context
    context.push({ role: 'assistant', content: fullText });
    
    // Speak
    if (avatarOnline) await speakAvatar(fullText);

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error("Chat Error:", err);
      renderMessage('assistant', 'Error: ' + err.message);
    }
  } finally {
    setBusy(false);
  }
}

// ==========================================
// ========== MANUAL DEBUG INPUT ============
// ==========================================

sendBtn.addEventListener('click', () => {
    if(abortController) {
        abortController.abort();
        abortController = null;
    } else {
        sendMessage();
    }
});

// ==========================================
// ========== VOICE DICTATION ===============
// ==========================================

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
let silenceTimer = null;
const AUTO_STOP_MS = 2500; // Time of silence to auto-send

function startDictation() {
    if (!SpeechRecognition) {
        alert("Browser does not support Speech API");
        return;
    }
    if (listening) return;

    recognition = new SpeechRecognition();
    recognition.lang = 'nl-NL';
    recognition.interimResults = true;
    recognition.continuous = true;

    listening = true;
    micBtn.classList.add('recording');
    userInput.value = ""; // Clear hidden input

    recognition.onresult = (ev) => {
        // Reset auto-send timer on new input
        clearTimeout(silenceTimer);
        
        let finalTrans = "";
        let interimTrans = "";

        for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const t = ev.results[i][0].transcript;
            if (ev.results[i].isFinal) finalTrans += t;
            else interimTrans += t;
        }
        
        // Update hidden input so sendMessage can read it
        const currentFull = (finalTrans + " " + interimTrans).trim();
        if(currentFull) {
            userInput.value = currentFull;
            
            // Set timer to auto-send
            silenceTimer = setTimeout(() => {
                stopDictation(); // Stop listening
                sendMessage();   // Send what we have
            }, AUTO_STOP_MS);
        }
    };

    recognition.onerror = (e) => {
        console.warn("Voice error", e);
        stopDictation();
    };

    recognition.onend = () => {
        if(listening) stopDictation();
    };

    recognition.start();
}

function stopDictation() {
    listening = false;
    micBtn.classList.remove('recording');
    clearTimeout(silenceTimer);
    if (recognition) {
        recognition.stop();
        recognition = null;
    }
}

// Mic Button Click Handler
micBtn.addEventListener('click', () => {
    if (listening) stopDictation();
    else startDictation();
});