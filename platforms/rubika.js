// Rubika messenger platform module (web.rubika.ir — Angular SPA)
// Reverse-engineered from main-es2015 bundle:
// - message list: .bubbles-inner > .bubbles-group > div.bubble > div[rb-message-item].bubble-content-wrapper
// - text: div[rb-message-text] > div[rb-copyable]
// - composer: .chat-input-container .new-message-wrapper .input-message-input
//   + dynamically created div.composer_rich_textarea[contenteditable] (rich mode)
//   + hidden textarea[name=draftMessage] (ngModel)
// - send: div.btn-send-container > div.btn-icon.btn-send (click => sendClicked, reads draftMessage.text)
// - chat list active item gets class "active" (ngClass object_guid === selectedChatId)
(function() {
  const RUBIKA_SELECTORS = {
    messageContainerCandidates: [
      '.bubbles-inner',
      'rb-history .bubbles-inner',
      '.bubbles',
      'rb-history .scrollable',
      '[rb-history] .scrollable'
    ],
    // Primary: Angular attribute component. Fallback: classic bubble class (excluding service/date dividers).
    messageItemCandidates: [
      '[rb-message-item]',
      '.bubbles-group .bubble:not(.service)',
      '.bubble:not(.service)',
      '.bubble'
    ],
    textCandidates: [
      '[rb-copyable]',
      '[rb-message-text]',
      'div[rb-message-text]',
      'div[dir="auto"]',
      '.message [dir="auto"]'
    ],
    inputCandidates: [
      '.composer_rich_textarea[contenteditable="true"]',
      '.composer_rich_textarea',
      'textarea[name="draftMessage"]',
      '.new-message-wrapper .input-message-input',
      '.input-message-input[contenteditable="true"]',
      '.input-message-container [contenteditable="true"]',
      '.chat-input-container [contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    sendButtonCandidates: [
      '.btn-send-container .btn-send',
      '.btn-send',
      '.btn-send-container',
      'div.btn-send',
      '[class*="btn-send"]'
    ],
    activeChatCandidates: [
      '.chatlist li.active',
      'rb-chats-list li.active',
      'li.active',
      '.dialog.active',
      '[class*="chatlist"] .active'
    ],
    headerTitleCandidates: [
      '.peer-title',
      '[rb-abs-link]',
      '.user-title',
      '.dialog-title',
      'rb-history header',
      '.chat-header',
      '.topbar'
    ]
  };

  function debug(msg, data) {
    console.log(`[Rubika] ${msg}`, data || '');
  }

  function firstVisibleMatch(selectors) {
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!(el instanceof Element)) continue;
          // For inputs/buttons hidden elements are useless; for messages all are fine.
          return el;
        }
      } catch (_) {}
    }
    return null;
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0 && (el.textContent || '').length === 0) return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  // ---- chat id ----
  // NOTE: ids only need to be stable *per side* (each side stores its own key
  // under its own id). They do NOT need to match across peers.
  async function getChatId() {
    // ONLY stable, chat-specific sources. Fuzzy fallbacks (e.g. peer titles)
    // are deliberately excluded: a second ID format for the same chat maps to
    // a different storage key, so the shared key "vanishes" mid-send and both
    // encryption and echo-decrypt silently stop working.
    try {
      const topbar = document.querySelector('.sidebar-header.topbar');
      if (topbar?.dataset?.chatId) return `rubika:${topbar.dataset.chatId}`;
      // The message list itself is tagged with the open chat id.
      const bubblesInner = document.querySelector('.bubbles-inner');
      if (bubblesInner?.dataset?.chatId) return `rubika:${bubblesInner.dataset.chatId}`;
    } catch (_) {}

    // 0. If no chat UI is open (login page / empty state), report null so the
    //    popup correctly shows "Not detected" instead of a bogus shared id.
    const chatOpen = getMessageContainer() || getMessageInput();
    if (!chatOpen) return null;

    // 1. Explicit data attributes (most reliable when present).
    try {
      const guidEl = document.querySelector(
        '[data-object-guid], [data-object_guid], [data-peer-id], [data-peerId], [data-chat-id], [data-chatId]'
      );
      const guid = guidEl?.dataset?.objectGuid || guidEl?.dataset?.object_guid ||
                   guidEl?.dataset?.peerId || guidEl?.dataset?.peer_id ||
                   guidEl?.dataset?.chatId || guidEl?.dataset?.chat_id;
      if (guid) return `rubika:${guid}`;
    } catch (_) {}

    // 2. URL params / hash (e.g. https://web.rubika.ir/#c=u0Jpt...).
    try {
      const hash = location.hash || '';
      const hashMatch = hash.match(/[#&]c=([^&]+)/);
      if (hashMatch) return `rubika:${decodeURIComponent(hashMatch[1])}`;
    } catch (_) {}
    try {
      const url = new URL(location.href);
      const qp = url.searchParams.get('peerId') || url.searchParams.get('chatId') ||
                 url.searchParams.get('dialogId') || url.searchParams.get('object_guid') ||
                 url.searchParams.get('objectGuid');
      if (qp) return `rubika:${qp}`;
    } catch (_) {}

    // 3. Angular object_guid scraped from component context (best-effort).
    //    Angular stores instance data on __ngContext__; layout varies by version,
    //    so wrap everything in try/catch and validate the shape.
    try {
      const ngGuid = readNgChatGuid();
      if (ngGuid) return `rubika:${ngGuid}`;
    } catch (_) {}

    // No stable id — return null (NOT a guessed one: reusing one id across
    // chats would reuse one AES key across peers; using a wrong id drops the
    // real key). Callers debounce transient nulls during re-renders.
    return null;
  }

  function readNgChatGuid() {
    // Try composer + history host elements; Angular attaches __ngContext__ (array-like).
    const hosts = [
      document.querySelector('rb-composer'),
      document.querySelector('rb-history'),
      document.querySelector('[rb-composer]'),
      document.querySelector('.chat-input-container')
    ].filter(Boolean);
    const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const host of hosts) {
      const ctx = host.__ngContext__;
      if (!ctx) continue;
      // Walk shallowly (max ~3 levels, bounded) looking for object_guid strings.
      const seen = new Set();
      const queue = [ctx];
      let steps = 0;
      while (queue.length && steps < 60) {
        steps++;
        const cur = queue.shift();
        if (!cur || (typeof cur !== 'object')) continue;
        if (seen.has(cur)) continue;
        seen.add(cur);
        try {
          if (typeof cur.object_guid === 'string' && (guidRe.test(cur.object_guid) || cur.object_guid.length >= 8)) {
            return cur.object_guid;
          }
          if (cur.chat && typeof cur.chat.object_guid === 'string') return cur.chat.object_guid;
          if (Array.isArray(cur)) {
            for (let i = 0; i < Math.min(cur.length, 40); i++) queue.push(cur[i]);
          } else {
            const keys = Object.keys(cur).slice(0, 40);
            for (const k of keys) {
              if (k === 'chat' || k === 'object_guid' || k === 'composer' || k === 'currentChat') queue.push(cur[k]);
            }
          }
        } catch (_) {}
      }
    }
    return null;
  }

  function getMessageContainer() {
    for (const sel of RUBIKA_SELECTORS.messageContainerCandidates) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function isServiceBubble(node) {
    try {
      if (!(node instanceof Element)) return false;
      if (node.classList?.contains('service')) return true;
      // Date dividers: .bubble.service.is-date > .bubble-content > .service-msg
      if (node.querySelector?.(':scope > .bubble-content > .service-msg')) return true;
      if (node.matches?.('.bubble.service, .is-date, .im_message_unread_split')) return true;
    } catch (_) {}
    return false;
  }

  function getMessageItemsFromNode(node) {
    if (!(node instanceof Element)) return [];
    // Direct hit first (skip service dividers).
    for (const sel of RUBIKA_SELECTORS.messageItemCandidates) {
      try {
        if (node.matches?.(sel)) {
          if (isServiceBubble(node)) return [];
          return [node];
        }
      } catch (_) {}
    }
    for (const sel of RUBIKA_SELECTORS.messageItemCandidates) {
      try {
        const found = node.querySelectorAll?.(sel);
        if (found?.length) {
          const items = [...found].filter((el) => !isServiceBubble(el));
          if (items.length) return items;
        }
      } catch (_) {}
    }
    return [];
  }

  function getAllMessageElements(container) {
    const seen = new Set();
    const items = [];
    for (const sel of RUBIKA_SELECTORS.messageItemCandidates) {
      let found = [];
      try {
        found = container.querySelectorAll(sel);
      } catch (_) { continue; }
      for (const el of found) {
        if (seen.has(el) || isServiceBubble(el)) continue;
        seen.add(el);
        items.push(el);
      }
    }
    return items;
  }

  function extractMessagePayload(messageElement) {
    const fullText = messageElement.textContent?.trim();
    if (!fullText) return null;
    const hsEnvelope = extractHandshakeEnvelope(fullText);
    // Handshake: return whole bubble as element (content.js only needs .text).
    if (hsEnvelope) return { text: hsEnvelope, textElement: messageElement, kind: 'handshake' };
    const textElement = findBestTextContainer(messageElement);
    if (!textElement) return null;
    const text = textElement.textContent?.trim();
    if (!text) return null;
    const msgEnvelope = extractEncryptedEnvelope(text);
    if (msgEnvelope) return { text: msgEnvelope, textElement, kind: 'encrypted' };
    return null;
  }

  function findBestTextContainer(messageElement) {
    // Prefer the actual Angular text nodes; never return the whole bubble as a
    // text container for encrypted msgs (wiping it would destroy timestamps).
    for (const sel of RUBIKA_SELECTORS.textCandidates) {
      let nodes = [];
      try {
        nodes = messageElement.querySelectorAll(sel);
      } catch (_) { continue; }
      for (const node of nodes) {
        const txt = node.textContent?.trim();
        if (txt && (txt.includes('E2EMSG:') || txt.includes('E2EHS'))) return node;
      }
    }
    const dirDiv = messageElement.querySelector('div[dir]');
    if (dirDiv && dirDiv.textContent?.trim()) {
      const t = dirDiv.textContent.trim();
      if (t.includes('E2EMSG:') || t.includes('E2EHS')) return dirDiv;
    }
    return null;
  }

  function extractHandshakeEnvelope(text) {
    const hs1b = text.match(/\[\[E2EHS1:([A-Za-z0-9+/=]{80,140})\]\]/);
    if (hs1b) return `[[E2EHS1:${hs1b[1]}]]`;
    const hs2b = text.match(/\[\[E2EHS2:([A-Za-z0-9+/=]{80,140})\]\]/);
    if (hs2b) return `[[E2EHS2:${hs2b[1]}]]`;
    const hs1 = text.match(/E2EHS1:[A-Za-z0-9+/=]{80,140}/);
    if (hs1) return hs1[0];
    const hs2 = text.match(/E2EHS2:[A-Za-z0-9+/=]{80,140}/);
    if (hs2) return hs2[0];
    return null;
  }

  function extractEncryptedEnvelope(text) {
    const msg = text.match(/E2EMSG:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)/);
    return msg ? msg[0] : null;
  }

  function getMessageInput() {
    // Prefer visible rich editor; hidden textarea[name=draftMessage] is *not*
    // user-visible but is a valid fallback for reading/writing via ngModel path.
    for (const sel of RUBIKA_SELECTORS.inputCandidates) {
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch (_) { continue; }
      if (!el) continue;
      if (el.isContentEditable) {
        if (isVisible(el) || el.classList?.contains('composer_rich_textarea')) return el;
      } else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        return el;
      } else if (el) {
        return el;
      }
    }
    return null;
  }

  function getSendButton() {
    for (const sel of RUBIKA_SELECTORS.sendButtonCandidates) {
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch (_) { continue; }
      if (!el) continue;
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
      } catch (_) {}
      // .btn-send-container itself is a wrapper; prefer a clickable child.
      if (el.classList?.contains('btn-send-container') && !el.classList.contains('btn-send')) {
        const inner = el.querySelector('.btn-send, [class*="btn-send"], div, button');
        if (inner) return inner;
      }
      return el;
    }
    const container = document.querySelector('.btn-send-container');
    return container?.querySelector('button, div') || container || null;
  }

  // ---- Angular-aware composer helpers ----
  // Rubika's composer keeps the draft in `draftMessage.text` (Angular state),
  // synced from the rich div via texteditor.onChange() on *keyup*. Setting
  // innerText + firing a generic `input` event is NOT enough — a real `keyup`
  // must follow so `checkDraft` copies the text into draftMessage. The send
  // button then calls sendClicked() which reads draftMessage.text directly.
  function setComposerText(text) {
    const rich = document.querySelector('.composer_rich_textarea[contenteditable="true"]') ||
                 document.querySelector('.composer_rich_textarea');
    const hiddenTextarea = document.querySelector('textarea[name="draftMessage"]');
    if (!rich && !hiddenTextarea) return false;

    if (rich) {
      try { rich.focus(); } catch (_) {}
      let inserted = false;
      try {
        // Select-all first so we replace any existing draft.
        const range = document.createRange();
        range.selectNodeContents(rich);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch (_) {}
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch (_) { inserted = false; }
      if (!inserted) {
        try { rich.textContent = text; } catch (_) {}
      }
      // Notify Angular/jQuery listeners: beforeinput + input + keyup (keyup is
      // what actually triggers texteditor.onChange -> draftMessage sync).
      try {
        rich.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      } catch (_) {}
      try {
        rich.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: text }));
      } catch (_) {
        try { rich.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      }
      try {
        rich.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Unidentified', code: '', keyCode: 0, which: 0 }));
      } catch (_) {}
      try { rich.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    }

    if (hiddenTextarea) {
      try {
        hiddenTextarea.focus();
        hiddenTextarea.value = text;
        hiddenTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        hiddenTextarea.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) {}
    }
    return true;
  }

  function dispatchEnterKey(el) {
    // NOTE: `new KeyboardEvent(..., {keyCode: 13})` does NOT set keyCode in
    // Chrome (read-only). Rubika checks `13 == e.keyCode`, so define it manually.
    const mk = (type) => {
      const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', composed: true });
      try {
        Object.defineProperty(ev, 'keyCode', { value: 13 });
        Object.defineProperty(ev, 'which', { value: 13 });
      } catch (_) {}
      return ev;
    };
    el.dispatchEvent(mk('keydown'));
    el.dispatchEvent(mk('keypress'));
    el.dispatchEvent(mk('keyup'));
  }

  // Enter-only submit. Rubika's Enter path (onMessageSubmit) re-syncs the
  // composer DOM into draftMessage.text via updateValue() before sending, so
  // it works even when the draft is stale. A synthetic *click* instead calls
  // sendClicked() directly on the possibly-stale draft: if the draft still
  // holds the user's pre-encryption plaintext at that moment, the click would
  // send it UNENCRYPTED. Clicks are therefore never synthesized here.
  function submitComposer() {
    const rich = document.querySelector('.composer_rich_textarea[contenteditable="true"]') ||
                 document.querySelector('.composer_rich_textarea') ||
                 getMessageInput();
    if (rich) {
      try { rich.focus(); } catch (_) {}
      try { dispatchEnterKey(rich); } catch (_) {}
      return true;
    }
    return false;
  }

  function getComposerText() {
    const rich = document.querySelector('.composer_rich_textarea[contenteditable="true"]') ||
                 document.querySelector('.composer_rich_textarea');
    if (rich) return rich.innerText || rich.textContent || '';
    const ta = document.querySelector('textarea[name="draftMessage"]');
    if (ta) return ta.value || '';
    const input = getMessageInput();
    if (!input) return '';
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value || '';
    if (input.isContentEditable) return input.innerText || input.textContent || '';
    return '';
  }

  // Platform‑specific lock indicator for Rubika
  function addDecryptionIndicator(textElement) {
    try {
      const bubble = textElement.closest('.bubble');
      if (!bubble) return;
      const timeSpan = bubble.querySelector('.time, rb-message-time, [class*="time"]');
      const anchor = timeSpan?.parentElement || bubble;
      if (!anchor || anchor.querySelector('.e2e-message-lock-indicator')) return;
      const lockIndicator = document.createElement('span');
      lockIndicator.textContent = '🔒';
      lockIndicator.className = 'e2e-message-lock-indicator';
      lockIndicator.setAttribute('aria-label', 'Decrypted message');
      lockIndicator.title = 'Decrypted message';
      lockIndicator.style.marginRight = '4px';
      lockIndicator.style.fontSize = '0.9em';
      if (timeSpan) timeSpan.parentElement.insertBefore(lockIndicator, timeSpan);
      else anchor.appendChild(lockIndicator);
    } catch (_) {}
  }

  window.__E2E_PLATFORM.register("rubika", {
    name: "rubika",
    getChatId,
    getMessageContainer,
    getMessageItemsFromNode,
    getAllMessageElements,
    extractMessagePayload,
    getMessageInput,
    getSendButton,
    addDecryptionIndicator,
    // Optional Angular-aware hooks consumed by content.js when present.
    setComposerText,
    submitComposer,
    getComposerText,
    // Rubika clears the composer when a message is sent: content.js uses this
    // to verify the send and retry automatically (single-Enter UX).
    composerClearedOnSend: true
  });

  console.log("[Rubika] Platform module registered (Angular-aware)");
})();
