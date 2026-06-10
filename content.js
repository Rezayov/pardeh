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
    maxPlatformRetries: 10
  };

  window[INSTANCE_KEY] = { cleanup };

  console.log("[E2E] ===================== CONTENT SCRIPT STARTED =====================");

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
      if (newChatId && newChatId !== state.chatId) {
        await handleChatChanged(newChatId);
      }
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
    if (!newChatId || state.destroyed || newChatId === state.chatId) return;
    console.log("[E2E] Chat changed:", state.chatId, "=>", newChatId);
    state.chatId = newChatId;
    state.processedCache.clear();
    await safeSendToBackground("CHAT_ID_CHANGED", { chatId: newChatId });
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
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          const items = getMessageItemsFromNode(node);
          for (const item of items) {
            processNewMessage(item).catch(console.error);
          }
        }
      }
    });
    state.messageObserver.observe(container, { childList: true, subtree: true });
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
    const payload = extractMessagePayload(messageElement);
    if (!payload?.text) return;
    const originalText = payload.text.trim();
    const cacheKey = buildProcessedKey(originalText);
    if (cacheKey && state.processedCache.has(cacheKey)) {
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
          renderDecryptedMessage(payload.textElement, decrypted);
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

  function findBestTextContainer(messageElement) {
    const textCandidates = ['[rb-copyable]', '[rb-message-text]', '.message [dir="auto"]', '.message'];
    for (const sel of textCandidates) {
      const nodes = messageElement.querySelectorAll(sel);
      for (const node of nodes) {
        const txt = node.textContent?.trim();
        if (txt && (txt.includes('E2EMSG:') || txt.includes('E2EHS'))) return node;
      }
    }
    const dirDiv = messageElement.querySelector('div[dir]');
    if (dirDiv && dirDiv.textContent?.trim()) return dirDiv;
    return messageElement;
  }

  async function waitForAndDecryptMessage(encryptedText, timeoutMs = 5000) {
    console.log("[E2E] waitForAndDecryptMessage: waiting for message with text", encryptedText.slice(0, 50));
    const start = Date.now();
    let foundMsg = null;
    let foundTextElement = null;

    while (Date.now() - start < timeoutMs) {
      const container = findMessageContainer();
      if (container) {
        const allMessages = state.platform?.getAllMessageElements?.(container) || [];
        console.log("[E2E] waitForAndDecryptMessage: scanning", allMessages.length, "messages");
        for (let i = allMessages.length - 1; i >= 0; i--) {
          const msg = allMessages[i];
          const msgText = msg.textContent?.trim() || "";
          if (msgText === encryptedText || msgText.includes(encryptedText.slice(0, 50))) {
            foundMsg = msg;
            foundTextElement = findBestTextContainer(msg);
            console.log("[E2E] Found outgoing message!");
            break;
          }
        }
        if (foundMsg) break;
      }
      await sleep(200);
    }

    if (!foundMsg) {
      console.warn("[E2E] Could not find outgoing message to decrypt after timeout");
      return false;
    }

    console.log("[E2E] Waiting 1200ms for platform to stabilize...");
    await sleep(1200);

    const cacheKey = buildProcessedKey(encryptedText);
    if (cacheKey) {
      state.processedCache.delete(cacheKey);
      console.log("[E2E] Cleared cache for this message");
    }

    if (foundTextElement && state.sharedKey) {
      try {
        const rawText = foundTextElement.textContent.trim();
        if (rawText.startsWith("E2EMSG:")) {
          const parts = rawText.slice(7).split(":");
          if (parts.length >= 2) {
            const ivB64 = parts[0].trim();
            const ciphertextB64 = parts.slice(1).join(":").trim();
            if (looksLikeBase64(ivB64) && looksLikeBase64(ciphertextB64)) {
              const decrypted = await decryptMessage(ciphertextB64, ivB64);
              console.log("[E2E] Direct decryption successful:", decrypted);
              renderDecryptedMessage(foundTextElement, decrypted);
              return true;
            }
          }
        }
      } catch (err) {
        console.error("[E2E] Direct decryption failed:", err);
      }
    }

    console.log("[E2E] Fallback: calling processNewMessage...");
    await processNewMessage(foundMsg);

    await sleep(800);
    const currentText = foundMsg.textContent?.trim() || "";
    if (currentText === encryptedText || currentText.includes(encryptedText.slice(0, 50))) {
      console.log("[E2E] Message still encrypted, forcing final decryption");
      if (foundTextElement && state.sharedKey) {
        try {
          const rawText = foundTextElement.textContent.trim();
          const parts = rawText.slice(7).split(":");
          const ivB64 = parts[0].trim();
          const ciphertextB64 = parts.slice(1).join(":").trim();
          const decrypted = await decryptMessage(ciphertextB64, ivB64);
          renderDecryptedMessage(foundTextElement, decrypted);
          console.log("[E2E] Final forced decryption applied");
        } catch (e) {
          console.error("[E2E] Final decryption failed:", e);
        }
      }
    } else {
      console.log("[E2E] Message already decrypted after first attempt");
    }
    return true;
  }

  async function handleEncryptedSend() {
    console.log("[E2E] handleEncryptedSend called");
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
      await sleep(100);

      const input = state.messageInput;
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
      input.dispatchEvent(enterEvent);
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      console.log("[E2E] Dispatched Enter events");

      await sleep(50);
      const sendButton = findSendButton();
      if (sendButton) {
        state.bypassNextSend = true;
        sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        await sleep(50);
        state.bypassNextSend = false;
        console.log("[E2E] Clicked send button as fallback");
      }

      clearInput(state.messageInput);
      console.log("[E2E] Calling waitForAndDecryptMessage...");
      await waitForAndDecryptMessage(encrypted);
      console.log("[E2E] Done with outgoing message handling");
    } catch (err) {
      console.error("[E2E] Encryption failed:", err);
    }
  }

  async function handleSendChatMessageCommand(text) {
    const input = await waitForInput(5000);
    if (!input) throw new Error("Chat input not found");
    const sendButton = await waitForSendButton(5000);
    if (!sendButton) throw new Error("Send button not found");
    setInputText(input, text);
    await sleep(120);
    state.bypassNextSend = true;
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    await sleep(50);
    state.bypassNextSend = false;
  }

  function triggerSendMessage() {
    const sendButton = findSendButton();
    if (!sendButton) return;
    state.bypassNextSend = true;
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  // ---- Platform delegation helpers ----
  async function extractChatId() {
    if (!state.platform) return null;
    return await state.platform.getChatId();
  }

  function waitForChatId(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const check = async () => {
        const id = await extractChatId();
        if (id) resolve(id);
        else setTimeout(check, 300);
      };
      const timeout = setTimeout(() => resolve(null), timeoutMs);
      check().finally(() => clearTimeout(timeout));
    });
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
    return state.platform.extractMessagePayload(messageElement);
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
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    if (el.isContentEditable) return el.innerText || el.textContent || "";
    return "";
  }

  function setInputText(el, text) {
    if (!el) return;
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
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clearInput(el) { setInputText(el, ""); }

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

  function renderDecryptedMessage(textElement, decryptedText) {
    if (!textElement || textElement.dataset.e2eDecrypted === "1") return;
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
