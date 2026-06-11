# 🔐 Pardeh – End‑to‑End Encryption Overlay for Web Messengers

## 🎯 Project Overview

Pardeh is a **Chrome extension** that adds end‑to‑end encryption (E2EE) to popular Persian‑language web messengers: **Bale**, **Rubika**, and **Eitaa**. It works as an overlay – it doesn’t replace the original chat, but transparently encrypts/decrypts messages using a **Diffie‑Hellman key exchange (P‑256)** and AES‑GCM.

> **Real‑world learning goal:** Understand how to build a secure, multi‑platform browser extension that intercepts DOM events, communicates with a background service worker, and manages cryptographic keys across different web apps.

---

## 📁 File Structure & Learning Focus

| File | What It Does | Key Concepts Learned | Skills You'll Gain |
|------|--------------|----------------------|---------------------|
| `manifest.json` | Extension declaration | Manifest V3, permissions, content scripts, service worker registration | Define extension capabilities, request host permissions, inject scripts at correct time |
| `background.js` | Service worker (persistent logic) | `chrome.runtime.onMessage`, `chrome.storage.local`/`session`, key generation/storage, handshake state machine | Manage long‑running tasks, handle cross‑tab communication, implement secure handshake protocol |
| `content.js` | In‑page script (injected into chat) | DOM manipulation, MutationObserver, event interception, encryption/decryption | Intercept user input, encrypt messages before sending, decrypt and replace received messages live |
| `platform.js` | Platform detection & registry | Abstraction layer, dynamic module loading, factory pattern | Write platform‑agnostic code – support multiple websites without duplication |
| `platforms/bale.js` | Bale‑specific selectors & logic | DOM selectors, platform adaptation | Identify message containers, send buttons, input fields for a specific site |
| `platforms/rubika.js` | Rubika‑specific implementation | Same as above | Quickly adapt the same encryption core to different DOM structures |
| `platforms/eitaa.js` | Eitaa‑specific implementation | Same as above | Handle different class names, data attributes, and event models |
| `popup.html` | Extension popup UI | HTML/CSS, dark/light mode, responsive layout | Build user‑friendly controls (toggle, handshake button, status display) |
| `popup.js` | Popup logic | `chrome.tabs.sendMessage`, UI state sync, event handling | Communicate with content script, reflect encryption status and chat ID in real time |

---

## 🧠 Core Technical Concepts (per file)

### 1. `background.js` – The Brain
- **ECDH key exchange** using `crypto.subtle` (P‑256 curve)
- **Handshake state machine** (Alice/Bob roles, HS1/HS2 messages)
- **Storage management**: `chrome.storage.local` for long‑term keys, `chrome.storage.session` for ephemeral handshake data
- **TTL cleanup** (10 minutes) for unfinished handshakes
- **Message routing** between popup, content script, and external events

### 2. `content.js` – The Interceptor
- **MutationObserver** to watch for new messages and decrypt them as they appear
- **Event listeners** on the send button and Enter key – intercept plaintext, encrypt, then simulate sending
- **Platform abstraction** – all DOM queries go through `state.platform`, which is loaded from `platforms/*.js`
- **Cache** of processed messages (`processedCache`) to avoid double‑decryption
- **Fallback decryption** for outgoing messages after they appear in the chat

### 3. `platform.js` – The Adapter
- Simple registry: `PLATFORMS` object with `register(name, module)`
- `detect()` based on `location.href`
- `getModule(name)` returns the correct platform implementation
- **Abstraction methods** each platform must provide: `getChatId()`, `getMessageContainer()`, `getMessageInput()`, `getSendButton()`, `extractMessagePayload()`, etc.

### 4. `popup.js` / `popup.html` – User Dashboard
- Query active tab for **chat ID** and **platform**
- Read encryption toggle state and shared key presence from background
- Send `ENCRYPT_TOGGLE` and `HANDSHAKE_CLICK` messages to background
- Display handshake progress (Not started → In progress → Complete)
- Clear keys button to reset chat state

---

## 🛠️ Skills You Will Develop

After studying and modifying this project, you will be able to:

1. **Build a Chrome Extension from scratch** (Manifest V3)
2. **Use the Web Crypto API** for real asymmetric + symmetric cryptography:
   - Generate ECDH key pairs
   - Export/import keys (raw, JWK)
   - Derive shared secrets
   - Encrypt/decrypt with AES‑GCM
3. **Implement a secure handshake protocol** over an insecure channel (text messages)
4. **Manipulate DOM in real time**:
   - Intercept clicks and keypresses
   - Replace message text before sending
   - Decrypt and replace received messages without breaking the original UI
5. **Use MutationObserver** to react to dynamically added elements (new messages)
6. **Write platform‑agnostic code** – separate core logic from site‑specific selectors
7. **Communicate between extension contexts**:
   - Popup ↔ background (via `chrome.runtime.sendMessage`)
   - Background ↔ content script (via `chrome.tabs.sendMessage`)
   - Content script ↔ injected platform modules (via closure)
8. **Manage storage** – local (persistent) vs session (ephemeral)
9. **Handle errors and timeouts** (handshake TTL, retries for DOM elements)

---

## 🔧 How to Use This Repository for Learning

### Step 1 – Understand the flow
1. User opens a chat on Bale/Rubika/Eitaa.
2. Content script detects platform and attaches listeners.
3. User clicks “Enable Encryption” in popup – background stores preference.
4. User clicks “Initiate Handshake” – background sends HS1 via content script.
5. Peer’s extension detects HS1, replies with HS2, both derive same AES key.
6. From then on, typed messages are encrypted locally, sent as `E2EMSG:iv:ciphertext`, and automatically decrypted on the receiving side.

### Step 2 – Experiment with modifications
- **Add a new platform** (e.g., WhatsApp Web) by creating a new file in `platforms/` and registering it.
- **Change the cipher** from AES‑GCM to ChaCha20‑Poly1305 (if supported).
- **Add message‑integrity checks** (e.g., include a MAC).
- **Store handshake state in IndexedDB** instead of session storage.
- **Add a visual indicator** for decrypted messages (already partially implemented).

### Step 3 – Debugging tips
- Use `console.log` in background, content, and popup – they appear in different DevTools contexts.
- Inspect `chrome.storage.local` via `chrome://extensions` → “Inspect views” background page.
- Simulate two users by opening two different browsers or two profiles.

---

## 🧪 Required Knowledge Prerequisites

- Basic JavaScript (promises, async/await, event listeners)
- Familiarity with Chrome DevTools
- Understanding of symmetric vs asymmetric encryption (conceptual)
- No prior extension or crypto experience needed – the code explains step by step.

---

## 📖 Real‑World Value

This project is **not a toy** – it’s a fully functional security tool that you could actually use. It demonstrates:
- How secure messaging apps (Signal, WhatsApp) implement the **Signal Protocol** at a much simpler scale.
- How to **retrofit encryption** onto existing web apps without backend changes.
- How to **isolate platform‑specific code** from core logic – a pattern used in large projects like `electron` or `VS Code`.

---

## 🚀 Getting Started

```bash
# Clone the repository
git clone https://github.com/yourusername/pardeh.git
cd pardeh

# Load unpacked extension in Chrome:
# 1. Go to chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked" and select the project folder

# Open web.bale.ai / web.rubika.ir / web.eitaa.com
# Click the extension icon and start a handshake with a friend who also installed it
```

---

## 📚 Summary – What Makes This a Great Learning Project

| Aspect | What You Learn |
|--------|----------------|
| **Cryptography** | Real ECDH + AES, not just theory |
| **Browser Extensions** | Full lifecycle: manifest, background, content, popup |
| **DOM Integration** | Intercepting and modifying UI of third‑party sites |
| **Asynchronous Patterns** | Promises, message passing, event‑driven architecture |
| **Security** | Key management, replay prevention, TTL, state machines |
| **Abstraction** | Platform adapter pattern – supports multiple websites with same core |

---

