(() => {
  "use strict";

  const INSTANCE_KEY = "__e2eExtensionInstance";
  const CHAT_KEY_PREFIX = "chat_key_";
  const ENCRYPTION_PREFIX = "encryption_enabled_";

  try {
    if (window[INSTANCE_KEY]?.cleanup) {
      window[INSTANCE_KEY].cleanup("reinject");
    }
  } catch (_) {}

  const state = {
    destroyed: false,
    initialized: false,
    platform: null,
    chatId: null,
    encryptionEnabled: false,
    sharedKey: null,
    messageObserver: null,
    domObserver: null,
    sendButton: null,
    messageInput: null,
    bypassNextSend: false,
    urlWatchInterval: null,
    chatIdPollInterval: null,
    attachRetryTimer: null,
    initTimer: null,
    processedCache: new Set(),
    maxProcessedCache: 500,
    handlersAttached: false,
    onRuntimeMessage: null,
    onStorageChanged: null,
    _sendClickHandler: null,
    _inputKeydownHandler: null,
    routeHooksInstalled: false,
    lastKnownUrl: location.href,
    platformRetryCount: 0,
    maxPlatformRetries: 10,
    pendingChatId: undefined,
    pendingChatCount: 0,
    chatIdHistory: []
  };

  window[INSTANCE_KEY] = { cleanup };
  // Debug hook for DevTools: __E2E_DEBUG.getState() / getHistory().
  try {
    window.__E2E_DEBUG = {
      getState: () => ({
        chatId: state.chatId,
        encryptionEnabled: state.encryptionEnabled,
        hasSharedKey: !!state.sharedKey,
        platform: state.platform?.name || null,
        inputFound: !!findMessageInput(),
        sendButtonFound: !!findSendButton(),
        containerFound: !!findMessageContainer()
      }),
      getHistory: () => state.chatIdHistory.slice(-15)
    };
  } catch (_) {}

  console.log("[E2E] ===================== CONTENT SCRIPT STARTED =====================");
  console.log("[E2E] build 2026-10-17e (enter-only-submit, debounce, sweep-heal)");

  bootstrap();

  function bootstrap() {
    console.log("[E2E] bootstrap: scheduling initialization in 600ms");
    state.initTimer = setTimeout(() => {
      initialize().catch((err) => console.error("[E2E] initialize failed:", err));
    }, 600);
  }

  async function initialize() {
    console.log("[E2E] initialize: starting");
    if (state.destroyed) { console.log("[E2E] initialize: destroyed, abort"); return; }
    if (state.initialized) { console.log("[E2E] initialize: already initialized"); return; }

    if (!window.__E2E_PLATFORM) {
      console.warn("[E2E] Platform detection not ready, retrying...");
      if (state.platformRetryCount < state.maxPlatformRetries) {
        state.platformRetryCount++;
        setTimeout(() => initialize(), 500);
      } else {
        console.error("[E2E] Platform detection module never loaded");
      }
      return;
    }

    const platformName = window.__E2E_PLATFORM.detect();
    console.log("[E2E] platformName detected:", platformName);
    if (!platformName) {
      console.warn("[E2E] No supported platform detected on this page");
      if (state.platformRetryCount < state.maxPlatformRetries) {
        state.platformRetryCount++;
        setTimeout(() => initialize(), 1000);
      }
      return;
    }

    state.platform = window.__E2E_PLATFORM.getModule(platformName);
    if (!state.platform) {
      console.error("[E2E] Platform module not found for", platformName);
      return;
    }

    console.log("[E2E] Platform detected:", platformName);
    state.initialized = true;

    registerRuntimeListener();
    registerStorageListener();

    state.chatId = await waitForChatId();
    console.log("[E2E] chatId =", state.chatId);
    await reloadChatState();

    installRouteChangeHooks();
    startChatIdPoller();
    startDomWatcher();
    attachUiHooks(true);
    observeMessages(true);
    await scanExistingMessages();
    updateEncryptionStatusUI();
    console.log("[E2E] Initialized for chat:", state.chatId, "platform:", platformName);
  }

  function cleanup() {
    console.log("[E2E] cleanup called");
    if (state.destroyed) return;
    state.destroyed = true;

    try {
      if (state.urlWatchInterval) clearInterval(state.urlWatchInterval);
      if (state.chatIdPollInterval) clearInterval(state.chatIdPollInterval);
      if (state.attachRetryTimer) clearTimeout(state.attachRetryTimer);
      if (state.initTimer) clearTimeout(state.initTimer);
      if (state.messageObserver) state.messageObserver.disconnect();
      if (state.domObserver) state.domObserver.disconnect();
      if (state.sendButton && state._sendClickHandler) {
        state.sendButton.removeEventListener("click", state._sendClickHandler, true);
      }
      if (state.messageInput && state._inputKeydownHandler) {
        state.messageInput.removeEventListener("keydown", state._inputKeydownHandler, true);
      }
      if (state.onRuntimeMessage) {
        chrome.runtime.onMessage.removeListener(state.onRuntimeMessage);
      }
      if (state.onStorageChanged) {
        chrome.storage.onChanged.removeListener(state.onStorageChanged);
      }
    } catch (_) {}
  }

  function registerRuntimeListener() {
    console.log("[E2E] registerRuntimeListener: adding listener");
    state.onRuntimeMessage = (message, sender, sendResponse) => {
      if (state.destroyed) {
        sendResponse?.({ success: false, error: "content_destroyed" });
        return true;
      }
      console.log("[E2E] runtime message received:", message.type);
      switch (message.type) {
        case "PING":
          sendResponse({ ok: true, chatId: state.chatId });
          return true;
        case "GET_CHAT_ID":
          sendResponse({ chatId: state.chatId });
          return true;
        case "GET_PLATFORM":
          sendResponse({ platform: state.platform?.name || null });
          return true;
        case "UPDATE_ENCRYPTION_STATUS":
          state.encryptionEnabled = !!message.enabled;
          reloadChatState()
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: String(err) }));
          return true;
        case "SEND_CHAT_MESSAGE":
          handleSendChatMessageCommand(message.text)
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: String(err) }));
          return true;
        default:
          sendResponse({ success: false, error: "unknown_message_type" });
          return true;
      }
    };
    chrome.runtime.onMessage.addListener(state.onRuntimeMessage);
  }

  function registerStorageListener() {
    console.log("[E2E] registerStorageListener");
    state.onStorageChanged = (changes, areaName) => {
      if (state.destroyed || areaName !== "local" || !state.chatId) return;
      const encryptionStorageKey = `${ENCRYPTION_PREFIX}${state.chatId}`;
      const sharedKeyStorageKey = `${CHAT_KEY_PREFIX}${state.chatId}`;
      if (!changes[encryptionStorageKey] && !changes[sharedKeyStorageKey]) return;
      reloadChatState().catch(console.error);
    };
    chrome.storage.onChanged.addListener(state.onStorageChanged);
  }

  async function reloadChatState() {
    console.log("[E2E] reloadChatState: chatId=", state.chatId);
    if (!state.chatId || state.destroyed) {
      state.encryptionEnabled = false;
      state.sharedKey = null;
      updateEncryptionStatusUI();
      return;
    }
    const status = await safeSendToBackground("GET_ENCRYPTION_STATUS", { chatId: state.chatId });
    state.encryptionEnabled = !!status?.enabled;
    const keyResult = await safeSendToBackground("GET_SHARED_KEY", { chatId: state.chatId });
    if (keyResult?.key) {
      try {
        state.sharedKey = await importAESKey(keyResult.key);
        console.log("[E2E] sharedKey imported successfully");
      } catch (err) {
        console.error("[E2E] Failed to import AES key:", err);
        state.sharedKey = null;
      }
    } else {
      state.sharedKey = null;
    }
    updateEncryptionStatusUI();
  }

  function installRouteChangeHooks() {
    if (state.routeHooksInstalled) return;
    state.routeHooksInstalled = true;
    console.log("[E2E] installRouteChangeHooks");

    const notifyRouteChange = async () => {
      if (state.destroyed) return;
      const newChatId = await extractChatId();
      await requestChatChanged(newChatId || null);
    };

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      setTimeout(() => notifyRouteChange().catch(console.error), 50);
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      setTimeout(() => notifyRouteChange().catch(console.error), 50);
      return result;
    };
    window.addEventListener("popstate", () => {
      setTimeout(() => notifyRouteChange().catch(console.error), 50);
    });
    state.urlWatchInterval = setInterval(async () => {
      if (state.destroyed) return;
      const currentUrl = location.href;
      if (currentUrl === state.lastKnownUrl) return;
      state.lastKnownUrl = currentUrl;
      await notifyRouteChange();
    }, 500);
  }

  async function handleChatChanged(newChatId) {
    if (state.destroyed || newChatId === state.chatId) return;
    console.log("[E2E] Chat changed:", state.chatId, "=>", newChatId);
    try {
      state.chatIdHistory.push({ from: state.chatId, to: newChatId || null, at: new Date().toISOString() });
      if (state.chatIdHistory.length > 30) state.chatIdHistory.shift();
    } catch (_) {}
    state.pendingChatId = undefined;
    state.pendingChatCount = 0;
    state.chatId = newChatId || null;
    state.processedCache.clear();
    if (newChatId) {
      await safeSendToBackground("CHAT_ID_CHANGED", { chatId: newChatId });
    }
    await reloadChatState();
    if (state.messageObserver) {
      state.messageObserver.disconnect();
      state.messageObserver = null;
    }
    attachUiHooks(true);
    observeMessages(true);
    await sleep(150);
    await scanExistingMessages();
    updateEncryptionStatusUI();
  }

  function startDomWatcher() {
    if (state.domObserver) state.domObserver.disconnect();
    state.domObserver = new MutationObserver(() => {
      if (state.destroyed) return;
      const sendButton = findSendButton();
      const input = findMessageInput();
      const oldButtonDetached = state.sendButton && !state.sendButton.isConnected;
      const oldInputDetached = state.messageInput && !state.messageInput.isConnected;
      if (sendButton !== state.sendButton || input !== state.messageInput || oldButtonDetached || oldInputDetached) {
        attachUiHooks(true);
      }
      if (!state.messageObserver || !findMessageContainer()) {
        observeMessages(true);
      }
    });
    state.domObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }

  function attachUiHooks(force = false) {
    console.log("[E2E] attachUiHooks called, force=", force);
    if (state.destroyed) return;
    const sendButton = findSendButton();
    const input = findMessageInput();
    console.log("[E2E] sendButton found?", !!sendButton, "input found?", !!input);
    if (!sendButton || !input) {
      if (state.attachRetryTimer) clearTimeout(state.attachRetryTimer);
      state.attachRetryTimer = setTimeout(() => attachUiHooks(true), 1200);
      console.log("[E2E] attachUiHooks: waiting for elements, retry in 1.2s");
      return;
    }
    if (!force && state.sendButton === sendButton && state.messageInput === input && state.handlersAttached) {
      console.log("[E2E] attachUiHooks: already attached, skipping");
      return;
    }
    if (state.sendButton && state._sendClickHandler) {
      state.sendButton.removeEventListener("click", state._sendClickHandler, true);
    }
    if (state.messageInput && state._inputKeydownHandler) {
      state.messageInput.removeEventListener("keydown", state._inputKeydownHandler, true);
    }
    state.sendButton = sendButton;
    state.messageInput = input;

    state._sendClickHandler = async (e) => {
      console.log("[E2E] send button clicked");
      if (state.destroyed) return;
      if (state.bypassNextSend) {
        console.log("[E2E] bypassNextSend true, skipping encryption");
        state.bypassNextSend = false;
        return;
      }
      const text = getInputText(state.messageInput).trim();
      console.log("[E2E] send click: text length", text.length);
      if (!text) return;
      if (isHandshakeText(text) || text.startsWith("E2EMSG:")) {
        console.log("[E2E] send click: handshake or already encrypted, skipping");
        return;
      }
      if (state.encryptionEnabled && state.sharedKey) {
        console.log("[E2E] send click: preventing default and calling handleEncryptedSend");
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        await handleEncryptedSend();
      } else {
        console.log("[E2E] send click: encryption not ready (enabled=", state.encryptionEnabled, "key=", !!state.sharedKey, ")");
      }
    };
    state._inputKeydownHandler = async (e) => {
      if (state.destroyed) return;
      if (e.key !== "Enter" || e.shiftKey) return;
      console.log("[E2E] Enter key pressed");
      const text = getInputText(state.messageInput).trim();
      if (!text) return;
      if (isHandshakeText(text) || text.startsWith("E2EMSG:")) {
        console.log("[E2E] Enter: handshake or already encrypted, skipping");
        return;
      }
      if (state.encryptionEnabled && state.sharedKey) {
        console.log("[E2E] Enter: preventing default and calling handleEncryptedSend");
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        await handleEncryptedSend();
      } else {
        console.log("[E2E] Enter: encryption not ready");
      }
    };
    state.sendButton.addEventListener("click", state._sendClickHandler, true);
    state.messageInput.addEventListener("keydown", state._inputKeydownHandler, true);
    state.handlersAttached = true;
    console.log("[E2E] attachUiHooks: handlers attached");
  }

  function observeMessages(force = false) {
    if (state.destroyed) return;
    if (state.messageObserver && !force) return;
    if (state.messageObserver) {
      state.messageObserver.disconnect();
      state.messageObserver = null;
    }
    const container = findMessageContainer();
    if (!container) return;
    state.messageObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Angular sometimes swaps bubble text in place (same node, new
        // characterData) instead of adding nodes — childList alone misses it.
        if (mutation.type === "characterData") {
          const t = mutation.target?.nodeValue || "";
          if (!t.includes("E2EMSG:") && !t.includes("E2EHS")) continue;
          const item = closestMessageItem(mutation.target?.parentElement);
          if (item) processNewMessage(item).catch(console.error);
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          const items = getMessageItemsFromNode(node);
          for (const item of items) {
            processNewMessage(item).catch(console.error);
          }
        }
      }
    });
    state.messageObserver.observe(container, { childList: true, subtree: true, characterData: true });
  }

  function closestMessageItem(el) {
    let cur = el instanceof Element ? el : null;
    const container = findMessageContainer();
    let depth = 0;
    while (cur && cur !== document.documentElement && depth < 10) {
      try {
        const items = getMessageItemsFromNode(cur);
        if (items.includes(cur)) return cur;
      } catch (_) {}
      if (cur === container) break;
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  async function scanExistingMessages() {
    if (state.destroyed) return;
    const container = findMessageContainer();
    if (!container) return;
    const items = state.platform?.getAllMessageElements?.(container) || [];
    for (const item of items) {
      await processNewMessage(item).catch(console.error);
    }
  }

  async function processNewMessage(messageElement) {
    if (state.destroyed) return;
    if (messageElement instanceof Element && !messageElement.isConnected) return;
    const payload = extractMessagePayload(messageElement);
    if (!payload?.text) return;
    const textEl = payload.textElement;
    // Already rendered into this exact node — never touch it again. EXCEPT a
    // node poisoned by a failed render (flag set, raw envelope still present):
    // clear the stale flag and heal it now, otherwise it stays raw forever.
    if (textEl?.dataset?.e2eDecrypted === "1") {
      const stillRaw = /E2EMSG:|E2EHS1:|E2EHS2:/.test(textEl.textContent || "");
      if (!stillRaw) return;
      try {
        delete textEl.dataset.e2eDecrypted;
        textEl.removeAttribute("data-e2e-decrypted");
      } catch (_) {}
    }
    const originalText = payload.text.trim();
    const cacheKey = buildProcessedKey(originalText);
    const isEncrypted = originalText.startsWith("E2EMSG:");
    // NOTE: the processed cache is only a dedup for handshake notifications.
    // Encrypted bubbles must NOT be skipped by text: Rubika replaces our
    // just-decrypted pending bubble with the server-confirmed echo (same
    // ciphertext, brand-new node). Skipping it leaves E2EMSG: visible.
    if (cacheKey && state.processedCache.has(cacheKey) && !isEncrypted) {
      console.log("[E2E] processNewMessage: already processed, skipping", originalText.slice(0, 50));
      return;
    }

    console.log("[E2E] processNewMessage: processing", originalText.slice(0, 80));

    if (originalText.startsWith("E2EHS1:") || originalText.startsWith("[[E2EHS1:")) {
      markProcessed(cacheKey);
      const rawKey = extractLegacyHandshakeKey(originalText, "E2EHS1:");
      if (!rawKey) return;
      const activeChatId = state.chatId || await extractChatId();
      if (!activeChatId) return;
      await safeSendToBackground("HANDSHAKE_MARK_HS1_DETECTED", {
        chatId: activeChatId,
        payload: { legacyRawKeyB64: rawKey }
      });
      console.log("[E2E] HS1 detected, sent to background");
      return;
    }
    if (originalText.startsWith("E2EHS2:") || originalText.startsWith("[[E2EHS2:")) {
      markProcessed(cacheKey);
      const rawKey = extractLegacyHandshakeKey(originalText, "E2EHS2:");
      if (!rawKey) return;
      const activeChatId = state.chatId || await extractChatId();
      if (!activeChatId) return;
      await safeSendToBackground("HANDSHAKE_MARK_HS2_DETECTED", {
        chatId: activeChatId,
        payload: { legacyRawKeyB64: rawKey }
      });
      console.log("[E2E] HS2 detected, sent to background");
      return;
    }

    if (originalText.startsWith("E2EMSG:")) {
      markProcessed(cacheKey);
      if (!state.sharedKey) {
        console.log("[E2E] processNewMessage: encrypted message but no sharedKey");
        return;
      }
      try {
        const parts = originalText.slice(7).split(":");
        if (parts.length < 2) return;
        const ivB64 = parts[0].trim();
        const ciphertextB64 = parts.slice(1).join(":").trim();
        if (!looksLikeBase64(ivB64) || !looksLikeBase64(ciphertextB64)) throw new Error("Malformed encrypted payload");
        const ivBytes = new Uint8Array(base64ToArrayBuffer(ivB64));
        if (ivBytes.length !== 12) throw new Error(`Invalid IV length: ${ivBytes.length}`);
        const decrypted = await decryptMessage(ciphertextB64, ivB64);
        if (payload.textElement) {
          console.log("[E2E] Decryption successful, rendering");
          renderDecryptedMessage(payload.textElement, decrypted, originalText);
        }
      } catch (err) {
        console.error("[E2E] Decryption failed:", err);
        if (payload.textElement) {
          renderDecryptError(payload.textElement, "Failed to decrypt");
        }
      }
      return;
    }

    if (payload.kind === "plain" && payload.textElement) {
      markProcessed(cacheKey);
      addMessageSecurityIndicator(payload.textElement, "plain");
    }
  }

  // Generic envelope fallback used when a platform module can't locate the
  // text node (e.g. Rubika's pending-bubble structure differs from confirmed
  // bubbles). Returns the deepest leaf element containing the envelope so
  // rendering never wipes bubble chrome (timestamps, tails).
  function extractAnyEnvelope(text) {
    if (!text) return null;
    const hs1b = text.match(/\[\[E2EHS1:([A-Za-z0-9+/=]{80,140})\]\]/);
    if (hs1b) return `[[E2EHS1:${hs1b[1]}]]`;
    const hs2b = text.match(/\[\[E2EHS2:([A-Za-z0-9+/=]{80,140})\]\]/);
    if (hs2b) return `[[E2EHS2:${hs2b[1]}]]`;
    const hs1 = text.match(/E2EHS1:[A-Za-z0-9+/=]{80,140}/);
    if (hs1) return hs1[0];
    const hs2 = text.match(/E2EHS2:[A-Za-z0-9+/=]{80,140}/);
    if (hs2) return hs2[0];
    const msg = text.match(/E2EMSG:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)/);
    return msg ? msg[0] : null;
  }

  // Post-send sweep: re-resolve everything FRESH from the live DOM on every
  // pass. The old implementation held onto element references across sleeps,
  // but Rubika swaps the pending bubble for the server-confirmed echo —
  // decrypting a detached node is invisible. Works for E2EMSG and HS texts.
  async function sweepOutgoingMessage(sentText, timeoutMs = 6000) {
    console.log("[E2E] sweepOutgoingMessage: watching for", sentText.slice(0, 50));
    const head = sentText.slice(0, 50);
    const start = Date.now();
    let healed = false;
    // The key may have been transiently wiped (chat view re-render between
    // send and echo). Reload once so decrypt actually has a key to work with.
    if (!state.sharedKey) {
      try {
        await reloadChatState();
      } catch (_) {}
    }
    while (Date.now() - start < timeoutMs) {
      if (state.destroyed) break;
      const container = findMessageContainer();
      if (container) {
        const items = state.platform?.getAllMessageElements?.(container) || [];
        for (const msg of items) {
          if (!(msg instanceof Element) || !msg.isConnected) continue;
          const txt = msg.textContent || "";
          if (txt !== sentText && !txt.includes(head)) continue;
          await processNewMessage(msg).catch(() => {});
          healed = true;
        }
        // Done when our envelope no longer appears raw in any connected node.
        const stillRaw = items.some((msg) => {
          if (!(msg instanceof Element) || !msg.isConnected) return false;
          const txt = msg.textContent || "";
          if (txt !== sentText && !txt.includes(head)) return false;
          if (msg.querySelector?.('[data-e2e-decrypted="1"]')) return false;
          return /E2EMSG:|E2EHS1:|E2EHS2:/.test(txt);
        });
        if (healed && !stillRaw) {
          console.log("[E2E] sweepOutgoingMessage: outgoing message healed");
          return true;
        }
      }
      await sleep(400);
    }
    if (!healed) console.warn("[E2E] sweepOutgoingMessage: sent message never observed");
    else console.warn("[E2E] sweepOutgoingMessage: timed out with raw echo remaining");
    return healed;
  }

  async function handleEncryptedSend() {
    console.log("[E2E] handleEncryptedSend called");
    // Re-resolve input: Rubika recreates the composer on chat switch.
    state.messageInput = findMessageInput() || state.messageInput;
    // Force-sync chat state to the VISIBLE chat before touching crypto: if a
    // transient misread drifted state.chatId, the key lookup below would miss
    // and the message would send unencrypted.
    try {
      const liveId = await extractChatId();
      if (liveId && liveId !== state.chatId) {
        console.log("[E2E] send-path chatId resync:", state.chatId, "=>", liveId);
        await handleChatChanged(liveId);
      }
    } catch (_) {}
    if (state.destroyed || !state.messageInput || !state.sharedKey) {
      console.log("[E2E] handleEncryptedSend aborted: destroyed=", state.destroyed, "input=", !!state.messageInput, "key=", !!state.sharedKey);
      return;
    }
    const originalMessage = getInputText(state.messageInput).trim();
    console.log("[E2E] originalMessage:", originalMessage);
    if (!originalMessage) return;
    try {
      const encrypted = await encryptMessage(originalMessage);
      console.log("[E2E] encrypted:", encrypted.slice(0, 80));
      setInputText(state.messageInput, encrypted);
      // Give Angular time to copy the composer DOM into draftMessage.text
      // before submitting (measured: 600ms is not enough, ~1s+ is safe;
      // ensureComposerSent below retries if it still wasn't).
      await sleep(900);

      submitComposerOnce(state.messageInput);
      console.log("[E2E] Submitted composer");

      // Single-Enter UX: verify the message actually left and retry
      // automatically while the composer still holds our exact ciphertext.
      // Only on platforms that clear the composer on send (Rubika does).
      if (state.platform?.composerClearedOnSend) {
        await ensureComposerSent(encrypted);
      } else {
        await sleep(120);
      }

      console.log("[E2E] Calling sweepOutgoingMessage...");
      await sweepOutgoingMessage(encrypted);
      console.log("[E2E] Done with outgoing message handling");
    } catch (err) {
      console.error("[E2E] Encryption failed:", err);
    }
  }

  function dispatchEnterKey(el) {
    // new KeyboardEvent({keyCode}) ignores keyCode in Chrome (read-only).
    // Rubika checks `13 == e.keyCode`, so patch the property explicitly.
    const make = (type) => {
      const ev = new KeyboardEvent(type, {
        bubbles: true, cancelable: true, key: "Enter", code: "Enter", composed: true
      });
      try {
        Object.defineProperty(ev, "keyCode", { value: 13 });
        Object.defineProperty(ev, "which", { value: 13 });
      } catch (_) {}
      return ev;
    };
    el.dispatchEvent(make("keydown"));
    el.dispatchEvent(make("keypress"));
    el.dispatchEvent(make("keyup"));
  }

  // Rubika copies the composer DOM into Angular state (draftMessage.text)
  // asynchronously after our programmatic set — the send button can flip to
  // `send` mode while the draft is still stale, and both synthetic Enter and
  // synthetic click then silently no-op. So after submitting, VERIFY the
  // composer actually cleared and retry automatically (the "second Enter" the
  // user would otherwise press by hand). Only retries while the composer
  // still holds exactly our text, so a real send is never duplicated.
  async function ensureComposerSent(expectedText, maxRetries = 2) {
    const want = (expectedText || "").trim();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await sleep(attempt === 0 ? 900 : 800);
      if (state.destroyed) return false;
      let cur = "";
      try {
        cur = getInputText(findMessageInput() || state.messageInput).trim();
      } catch (_) {}
      if (cur !== want) {
        console.log("[E2E] ensureComposerSent: composer cleared, message sent");
        return true;
      }
      if (attempt < maxRetries) {
        console.log("[E2E] ensureComposerSent: composer still holds text, retrying submit", attempt + 1);
        const input = findMessageInput() || state.messageInput;
        if (!input) return false;
        try {
          input.focus();
        } catch (_) {}
        await sleep(150);
        submitComposerOnce(input);
      }
    }
    let cur = "";
    try {
      cur = getInputText(findMessageInput() || state.messageInput).trim();
    } catch (_) {}
    return cur !== want;
  }

  function submitComposerOnce(input) {
    if (typeof state.platform?.submitComposer === "function") {
      try {
        state.platform.submitComposer();
        return;
      } catch (e) {
        console.warn("[E2E] platform submit failed, falling back", e);
      }
    }
    // Enter-only fallback (see platform note): never synthesize clicks, a
    // click would send whatever stale text the draft still holds.
    dispatchEnterKey(input);
  }

  async function handleSendChatMessageCommand(text) {
    const input = await waitForInput(5000);
    if (!input) throw new Error("Chat input not found");
    const sendButton = await waitForSendButton(5000);
    if (!sendButton) throw new Error("Send button not found");
    state.messageInput = input;
    state.sendButton = sendButton;
    setInputText(input, text);
    // Let Angular pick up the programmatic change before clicking send.
    await sleep(900);
    if (typeof state.platform?.submitComposer === "function") {
      state.bypassNextSend = true;
      try {
        state.platform.submitComposer();
      } finally {
        setTimeout(() => { state.bypassNextSend = false; }, 60);
      }
    } else {
      state.bypassNextSend = true;
      try {
        // Enter-only: it re-syncs the draft from the DOM before sending.
        // Never click here — a click would send the stale pre-encryption
        // draft (e.g. the user's half-typed plaintext) unencrypted.
        dispatchEnterKey(input);
      } finally {
        setTimeout(() => { state.bypassNextSend = false; }, 60);
      }
    }
    await sleep(120);
    if (state.platform?.composerClearedOnSend) {
      await ensureComposerSent(text, 1);
    }
    // Don't await: the popup's HANDSHAKE_CLICK already got its answer path via
    // this command's response; the sweep heals our own HS echo in the background
    // (same pending-vs-confirmed replacement issue as encrypted messages).
    sweepOutgoingMessage(text).catch(() => {});
  }

  // ---- Platform delegation helpers ----
  async function extractChatId() {
    if (!state.platform) return null;
    return await state.platform.getChatId();
  }

  function waitForChatId(timeoutMs = 15000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const check = async () => {
        if (settled || state.destroyed) return;
        try {
          const id = await extractChatId();
          if (id) {
            finish(id);
            return;
          }
        } catch (_) {}
        if (!settled) setTimeout(check, 300);
      };
      const timeout = setTimeout(() => finish(null), timeoutMs);
      check();
    });
  }

  // Debounced chat switch: Rubika re-renders the chat view (and briefly
  // detaches topbar/bubbles) on send and on navigation, so a single read can
  // transiently return null or a different id. Switching storage keys on such
  // a transient read wipes the shared key mid-send. Require two consecutive
  // identical reads before committing to the switch.
  async function requestChatChanged(newChatId) {
    if (state.destroyed || newChatId === state.chatId) {
      state.pendingChatId = undefined;
      state.pendingChatCount = 0;
      return;
    }
    if (newChatId === state.pendingChatId) {
      state.pendingChatCount++;
      if (state.pendingChatCount >= 1) {
        await handleChatChanged(newChatId);
      }
      return;
    }
    state.pendingChatId = newChatId;
    state.pendingChatCount = 0;
  }

  function startChatIdPoller() {
    // Rubika/Eitaa are SPAs: switching chats often does NOT change location.href,
    // so history hooks + URL polling miss it. Re-read getChatId() periodically.
    if (state.chatIdPollInterval) clearInterval(state.chatIdPollInterval);
    state.chatIdPollInterval = setInterval(async () => {
      if (state.destroyed) return;
      try {
        const id = await extractChatId();
        await requestChatChanged(id || null);
      } catch (_) {}
    }, 2000);
  }

  function findMessageContainer() {
    return state.platform?.getMessageContainer() || null;
  }

  function getMessageItemsFromNode(node) {
    if (!state.platform) return [];
    return state.platform.getMessageItemsFromNode(node);
  }

  function extractMessagePayload(messageElement) {
    if (!state.platform) return null;
    let payload = null;
    try {
      payload = state.platform.extractMessagePayload(messageElement);
    } catch (_) {
      payload = null;
    }
    if (payload) return payload;
    // Generic fallback for bubble structures the platform module doesn't know
    // (e.g. Rubika's pending bubble before server confirmation): scan leaf
    // nodes deepest-first and extract the envelope per-leaf, where the text
    // is exact (whole-bubble text can glue ciphertext to the timestamp).
    try {
      if (!(messageElement instanceof Element)) return null;
      const all = [messageElement, ...messageElement.querySelectorAll("*")];
      for (let i = all.length - 1; i >= 0; i--) {
        const el = all[i];
        if (!(el instanceof Element) || el.children.length > 0) continue;
        const t = el.textContent || "";
        if (!t.includes("E2EMSG:") && !t.includes("E2EHS")) continue;
        const env = extractAnyEnvelope(t);
        if (!env) continue;
        return {
          text: env,
          textElement: el,
          kind: env.startsWith("E2EMSG:") ? "encrypted" : "handshake"
        };
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function findMessageInput() {
    return state.platform?.getMessageInput() || null;
  }

  function findSendButton() {
    return state.platform?.getSendButton() || null;
  }

  function waitForInput(timeoutMs = 5000) {
    return waitForElement(findMessageInput, timeoutMs);
  }

  function waitForSendButton(timeoutMs = 5000) {
    return waitForElement(findSendButton, timeoutMs);
  }

  function waitForElement(getter, timeoutMs) {
    return new Promise((resolve) => {
      const found = getter();
      if (found) return resolve(found);
      const started = Date.now();
      const timer = setInterval(() => {
        if (state.destroyed) {
          clearInterval(timer);
          resolve(null);
          return;
        }
        const el = getter();
        if (el) {
          clearInterval(timer);
          resolve(el);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 200);
    });
  }

  function getInputText(el) {
    if (!el) return "";
    try {
      if (typeof state.platform?.getComposerText === "function" && state.messageInput && el === state.messageInput) {
        const t = state.platform.getComposerText();
        if (typeof t === "string" && t.trim()) return t;
      }
    } catch (_) {}
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    if (el.isContentEditable) return el.innerText || el.textContent || "";
    return "";
  }

  function setInputText(el, text) {
    if (!el) return;
    // Prefer the platform's framework-aware setter (Rubika/Angular needs a
    // keyup afterwards so draftMessage.text actually updates).
    try {
      if (typeof state.platform?.setComposerText === "function") {
        if (state.platform.setComposerText(text)) {
          // Extra keyup for jQuery texteditor.onChange -> checkDraft sync.
          try {
            el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
          } catch (_) {}
          return;
        }
      }
    } catch (_) {}
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      el.value = text;
    } else if (el.isContentEditable) {
      try {
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);
        if ((el.innerText || "").trim() !== text.trim()) {
          el.innerText = text;
        }
      } catch (_) {
        el.innerText = text;
      }
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    try {
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
    } catch (_) {}
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clearInput(el) {
    // NOTE: do NOT clear immediately after submit — Rubika reads
    // draftMessage.text on click; clearing the DOM first can blank the draft
    // before sendClicked runs. The app clears the composer itself on send.
  }

  // ---- Encryption utilities ----
  async function encryptMessage(plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, state.sharedKey, encoded);
    return `E2EMSG:${arrayBufferToBase64(iv)}:${arrayBufferToBase64(ciphertext)}`;
  }

  async function decryptMessage(ciphertextB64, ivB64) {
    const iv = base64ToArrayBuffer(ivB64);
    const ciphertext = base64ToArrayBuffer(ciphertextB64);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, state.sharedKey, ciphertext);
    return new TextDecoder().decode(decrypted);
  }

  async function importAESKey(keyB64) {
    const keyData = base64ToArrayBuffer(keyB64);
    return crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  function updateEncryptionStatusUI() {
    let indicator = document.getElementById("e2e-status-indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "e2e-status-indicator";
      indicator.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 6px 12px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: bold;
        z-index: 999999;
        pointer-events: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        color: #fff;
      `;
      document.body.appendChild(indicator);
      console.log("[E2E] created status indicator");
    }
    if (state.encryptionEnabled && state.sharedKey) {
      indicator.textContent = "🔒 E2E READY";
      indicator.style.background = "#4CAF50";
    } else if (state.encryptionEnabled && !state.sharedKey) {
      indicator.textContent = "🟡 E2E ON (NO KEY)";
      indicator.style.background = "#FF9800";
    } else {
      indicator.textContent = "🔓 E2E OFF";
      indicator.style.background = "#9E9E9E";
    }
  }

  function detectTextDirection(text) {
    if (!text) return "ltr";
    const rtlRegex = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/g;
    const ltrRegex = /[A-Za-z]/g;
    const rtlMatches = text.match(rtlRegex) || [];
    const ltrMatches = text.match(ltrRegex) || [];
    if (rtlMatches.length > ltrMatches.length) return "rtl";
    if (ltrMatches.length > rtlMatches.length) return "ltr";
    for (const ch of text) {
      if (/[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(ch)) return "rtl";
      if (/[A-Za-z]/.test(ch)) return "ltr";
    }
    return "ltr";
  }

  function replaceEnvelopeInTextNodes(root, envelope, replacement) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const dir = detectTextDirection(replacement);
    let node;
    while ((node = walker.nextNode())) {
      const idx = (node.nodeValue || "").indexOf(envelope);
      if (idx === -1) continue;
      const before = node.nodeValue.slice(0, idx);
      const after = node.nodeValue.slice(idx + envelope.length);
      const parent = node.parentNode;
      if (before) parent.insertBefore(document.createTextNode(before), node);
      const span = document.createElement("span");
      span.textContent = replacement;
      span.dir = dir;
      span.style.textAlign = dir === "rtl" ? "right" : "left";
      span.style.direction = dir;
      parent.insertBefore(span, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);
      return true;
    }
    return false;
  }

  function renderDecryptedMessage(textElement, decryptedText, rawEnvelope) {
    if (!textElement || textElement.dataset.e2eDecrypted === "1") return;
    // When the target node holds more than just the envelope (bubble chrome,
    // timestamps, pending-bubble wrappers), replace only the envelope
    // substring instead of wiping the whole node.
    const current = textElement.textContent || "";
    if (rawEnvelope && current.includes(rawEnvelope) && current.trim() !== rawEnvelope.trim()) {
      let replaced = false;
      try {
        replaced = replaceEnvelopeInTextNodes(textElement, rawEnvelope, decryptedText);
      } catch (err) {
        console.warn("[E2E] substring replace failed, falling back to full replace", err);
        replaced = false;
      }
      if (replaced) {
        // Verify the envelope is really gone before flagging: Angular reuses
        // bubble nodes across re-renders, and a flag on still-raw text would
        // suppress all future healing for that node.
        const leftover = (textElement.textContent || "").includes(rawEnvelope);
        if (!leftover) {
          textElement.dataset.e2eDecrypted = "1";
          if (state.platform?.addDecryptionIndicator) {
            state.platform.addDecryptionIndicator(textElement);
          } else {
            addDecryptedMessageIndicator(textElement);
          }
          console.log("[E2E] renderDecryptedMessage: substring-replaced envelope", decryptedText);
          return;
        }
        console.warn("[E2E] substring replace unverified, falling back to full replace");
      }
    }
    textElement.textContent = "";
    textElement.dataset.e2eDecrypted = "1";
    const textSpan = document.createElement("span");
    textSpan.textContent = decryptedText;
    textSpan.className = "p";
    const dir = detectTextDirection(decryptedText);
    textSpan.dir = dir;
    textSpan.style.textAlign = dir === "rtl" ? "right" : "left";
    textSpan.style.direction = dir;
    textElement.appendChild(textSpan);
    if (state.platform?.addDecryptionIndicator) {
      state.platform.addDecryptionIndicator(textElement);
    } else {
      addDecryptedMessageIndicator(textElement);
    }
    console.log("[E2E] renderDecryptedMessage: replaced with plaintext", decryptedText);
  }

  function renderDecryptError(textElement, message = "Failed to decrypt") {
    if (!textElement) return;
    textElement.dataset.e2eDecrypted = "1";
    textElement.textContent = "";
    const wrapper = document.createElement("span");
    wrapper.style.display = "inline-flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "0.35em";
    wrapper.style.direction = "ltr";
    const lock = document.createElement("span");
    lock.textContent = "🔒";
    const txt = document.createElement("span");
    txt.textContent = `[${message}]`;
    txt.style.fontStyle = "italic";
    txt.style.opacity = "0.8";
    wrapper.appendChild(lock);
    wrapper.appendChild(txt);
    textElement.appendChild(wrapper);
  }

  function addDecryptedMessageIndicator(textElement) {
    const bubble = textElement.closest('[data-sentry-component="BaseBubbleFC"]') ||
                   textElement.closest('[data-sentry-component="Message"]') ||
                   textElement.closest(".message-item");
    if (!bubble) return;
    const infoContainer = bubble.querySelector('[data-sentry-component="InfoFC"]') ||
                          bubble.querySelector('[data-testid="message-state-icon"]')?.parentElement;
    if (!infoContainer || infoContainer.querySelector(".e2e-message-lock-indicator")) return;
    const lockIndicator = document.createElement("span");
    lockIndicator.textContent = "🔒";
    lockIndicator.className = "e2e-message-lock-indicator x3ai0M";
    lockIndicator.setAttribute("aria-label", "Decrypted message");
    lockIndicator.title = "Decrypted message";
    const timestamp = infoContainer.querySelector("time") || infoContainer.querySelector("p") || infoContainer.lastElementChild;
    const stateIcon = infoContainer.querySelector('[data-testid="message-state-icon"]');
    if (stateIcon?.nextSibling) {
      infoContainer.insertBefore(lockIndicator, stateIcon.nextSibling);
    } else if (timestamp) {
      infoContainer.insertBefore(lockIndicator, timestamp);
    } else {
      infoContainer.appendChild(lockIndicator);
    }
  }

  function addMessageSecurityIndicator(textElement, kind) {}

  // ---- Shared helpers ----
  function extractLegacyHandshakeKey(text, prefix) {
    if (!text) return null;
    if (prefix === "E2EHS1:") {
      const marker = text.match(/^\[\[E2EHS1:([A-Za-z0-9+/=]{80,140})\]\]$/);
      if (marker) return marker[1];
      const raw = text.match(/^E2EHS1:([A-Za-z0-9+/=]{80,140})$/);
      return raw ? raw[1] : null;
    }
    if (prefix === "E2EHS2:") {
      const marker = text.match(/^\[\[E2EHS2:([A-Za-z0-9+/=]{80,140})\]\]$/);
      if (marker) return marker[1];
      const raw = text.match(/^E2EHS2:([A-Za-z0-9+/=]{80,140})$/);
      return raw ? raw[1] : null;
    }
    return null;
  }

  function buildProcessedKey(text) {
    if (!state.chatId || !text) return null;
    return `${state.chatId}|${text}`;
  }

  function markProcessed(key) {
    if (!key) return;
    state.processedCache.add(key);
    if (state.processedCache.size > state.maxProcessedCache) {
      const first = state.processedCache.values().next().value;
      state.processedCache.delete(first);
    }
  }

  function isHandshakeText(text) {
    return text.startsWith("[[E2EHS1:") || text.startsWith("[[E2EHS2:") ||
           text.startsWith("E2EHS1:") || text.startsWith("E2EHS2:");
  }

  function looksLikeBase64(s) { return !!s && /^[A-Za-z0-9+/=]+$/.test(s); }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
  }

  async function safeSendToBackground(type, data = {}) {
    if (state.destroyed) return { error: "content_destroyed" };
    try {
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, ...data }, (response) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(response || {});
        });
      });
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }
})();
