// platforms/eitaa.js
(function() {
  const EITAA_SELECTORS = {
    activeChatItem: '.chatlist-chat.active',
    messageContainer: '.bubbles-inner',
    messageItemCandidates: ['.bubble', '.bubble.service'],
    textCandidates: ['.message[dir="auto"]', '.message', '[data-mid] .message'],
    inputCandidates: ['.input-message-input[contenteditable="true"]', '.new-message-wrapper div[contenteditable="true"]'],
    sendButtonCandidates: ['.btn-send', '.btn-send-container button.btn-send']
  };

  async function getChatId() {
    const activeChat = document.querySelector(EITAA_SELECTORS.activeChatItem);
    if (activeChat && activeChat.dataset.peerId) return activeChat.dataset.peerId;
    const hash = location.hash;
    if (hash) {
      const match = hash.match(/^#(\d+)$/);
      if (match) return match[1];
    }
    const centerColumn = document.querySelector('#column-center');
    if (centerColumn) {
      const chatDiv = centerColumn.querySelector('.chat');
      if (chatDiv && chatDiv.dataset.peerId) return chatDiv.dataset.peerId;
    }
    return null;
  }

  function getMessageContainer() {
    return document.querySelector(EITAA_SELECTORS.messageContainer);
  }

  function getMessageItemsFromNode(node) {
    const items = [];
    if (!(node instanceof Element)) return items;
    for (const sel of EITAA_SELECTORS.messageItemCandidates) {
      if (node.matches?.(sel)) { items.push(node); return items; }
    }
    for (const sel of EITAA_SELECTORS.messageItemCandidates) {
      const found = node.querySelectorAll?.(sel);
      if (found?.length) { items.push(...found); return items; }
    }
    return items;
  }

  function getAllMessageElements(container) {
    const items = [];
    for (const sel of EITAA_SELECTORS.messageItemCandidates) {
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

  function findBestTextContainer(messageElement) {
    for (const selector of EITAA_SELECTORS.textCandidates) {
      const nodes = messageElement.querySelectorAll(selector);
      for (const node of nodes) {
        const txt = node.textContent?.trim();
        if (txt && (txt.includes('E2EMSG:') || txt.includes('E2EHS'))) return node;
      }
    }
    const dirDiv = messageElement.querySelector('div[dir="auto"]');
    if (dirDiv && dirDiv.textContent?.trim()) return dirDiv;
    return messageElement;
  }

  function getMessageInput() {
    for (const selector of EITAA_SELECTORS.inputCandidates) {
      const el = document.querySelector(selector);
      if (el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return el;
    }
    return null;
  }

  function getSendButton() {
    for (const selector of EITAA_SELECTORS.sendButtonCandidates) {
      const el = document.querySelector(selector);
      if (el) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') return el;
      }
    }
    const container = document.querySelector('.btn-send-container');
    if (container) {
      const btn = container.querySelector('button');
      if (btn) return btn;
    }
    return null;
  }

  window.__E2E_PLATFORM.register("eitaa", {
    name: "eitaa",
    getChatId,
    getMessageContainer,
    getMessageItemsFromNode,
    getAllMessageElements,
    extractMessagePayload,
    getMessageInput,
    getSendButton
  });

  console.log("[Eitaa] Platform module registered");
})();
