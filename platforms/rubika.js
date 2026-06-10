// Rubika messenger platform module
(function() {
  const RUBIKA_SELECTORS = {
    chatIdTopbar: '.sidebar-header.topbar',
    messageContainer: '.bubbles-inner',
    messageItemCandidates: ['.bubble', '.bubble.service'],
    textCandidates: ['[rb-copyable]', '[rb-message-text]', '.message [dir="auto"]'  , '.mesasge'],
    inputCandidates: [
      '.composer_rich_textarea[contenteditable="true"]',
      '.composer_rich_textarea',
      'div[contenteditable="true"]'
    ],
    sendButtonCandidates: [
      '.btn-send-container .btn-send',   // explicit
      '.btn-send-container button',      // fallback
      '.btn-send',
      'button.btn-send'
    ]
  };

  function debug(msg, data) {
    console.log(`[Rubika] ${msg}`, data || '');
  }

  async function getChatId() {
    const topbar = document.querySelector(RUBIKA_SELECTORS.chatIdTopbar);
    if (topbar?.dataset.chatId) return topbar.dataset.chatId;
    const hash = location.hash;
    const match = hash.match(/[#&]c=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
    try {
      const url = new URL(location.href);
      return url.searchParams.get('peerId') || url.searchParams.get('chatId') || url.searchParams.get('dialogId');
    } catch (_) {}
    const chatArea = document.querySelector('.chat');
    return chatArea?.id || null;
  }

  function getMessageContainer() {
    return document.querySelector(RUBIKA_SELECTORS.messageContainer);
  }

  function getMessageItemsFromNode(node) {
    if (!(node instanceof Element)) return [];
    for (const sel of RUBIKA_SELECTORS.messageItemCandidates) {
      if (node.matches?.(sel)) return [node];
      const found = node.querySelectorAll?.(sel);
      if (found?.length) return [...found];
    }
    return [];
  }

  function getAllMessageElements(container) {
    const items = [];
    for (const sel of RUBIKA_SELECTORS.messageItemCandidates) {
      items.push(...container.querySelectorAll(sel));
    }
    return [...new Set(items)];
  }
function extractMessagePayload(messageElement) {
  const fullText = messageElement.textContent?.trim();
  if (!fullText) return null;
  const hsEnvelope = extractHandshakeEnvelope(fullText);
  if (hsEnvelope) return { text: hsEnvelope, textElement: messageElement };
  const textElement = findBestTextContainer(messageElement);
  if (!textElement) return null;
  const text = textElement.textContent?.trim();
  if (!text) return null;
  const msgEnvelope = extractEncryptedEnvelope(text);
  if (msgEnvelope) return { text: msgEnvelope, textElement };
  return null;
}

function findBestTextContainer(messageElement) {
  // Try known selectors (works for both incoming and outgoing)
  for (const sel of RUBIKA_SELECTORS.textCandidates) {
    const nodes = messageElement.querySelectorAll(sel);
    for (const node of nodes) {
      const txt = node.textContent?.trim();
      if (txt && (txt.includes('E2EMSG:') || txt.includes('E2EHS'))) return node;
    }
  }
  // Fallback: any div with dir attribute (Rubika uses dir="auto" for message text)
  const dirDiv = messageElement.querySelector('div[dir]');
  if (dirDiv && dirDiv.textContent?.trim()) return dirDiv;
  // Last resort: the message element itself
  return messageElement;
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
    for (const sel of RUBIKA_SELECTORS.inputCandidates) {
      const el = document.querySelector(sel);
      if (el?.isContentEditable) return el;
    }
    return document.querySelector('.chat-input [contenteditable="true"]') || null;
  }

  function getSendButton() {
    for (const sel of RUBIKA_SELECTORS.sendButtonCandidates) {
      const el = document.querySelector(sel);
      if (el && window.getComputedStyle(el).display !== 'none') return el;
    }
    const container = document.querySelector('.btn-send-container');
    return container?.querySelector('button') || null;
  }

  // Platform‑specific lock indicator for Rubika
  function addDecryptionIndicator(textElement) {
    // Find the bubble that contains this text element
    const bubble = textElement.closest('.bubble');
    if (!bubble) return;

    // Look for the time element (Rubika puts time inside .time span)
    const timeSpan = bubble.querySelector('.time');
    if (!timeSpan) return;

    // Check if indicator already exists
    if (timeSpan.parentElement.querySelector('.e2e-message-lock-indicator')) return;

    const lockIndicator = document.createElement('span');
    lockIndicator.textContent = '🔒';
    lockIndicator.className = 'e2e-message-lock-indicator';
    lockIndicator.setAttribute('aria-label', 'Decrypted message');
    lockIndicator.title = 'Decrypted message';
    lockIndicator.style.marginRight = '4px';
    lockIndicator.style.fontSize = '0.9em';

    // Insert before the time span
    timeSpan.parentElement.insertBefore(lockIndicator, timeSpan);
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
    addDecryptionIndicator   // new platform hook
  });

  console.log("[Rubika] Platform module registered with lock indicator support");
})();
