// Bale messenger platform module
(function() {
  const BALE_SELECTORS = {
    inputCandidates: [
      "#editable-message-text",
      '[contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    sendButtonCandidates: [
      'div[aria-label="send-button"]',
      'button[aria-label="send-button"]',
      'button[type="submit"]'
    ],
    messageListParents: [
      'div[data-sentry-component="MessagesListFC"]',
      "#message_list_scroller_id",
      ".messages-list",
      ".messages-container",
      ".message-list"
    ],
    messageItemCandidates: [
      ".message-item",
      '[data-sentry-component="Message"]',
      '[class*="message"]'
    ],
    textCandidates: [
      ".KTwPFW.YjkWXv",
      ".KTwPFW",
      ".YjkWXv",
      ".ljqtTr",
      ".message-text",
      ".text-content",
      "span",
      "div"
    ]
  };

  async function getChatId() {
    try {
      const url = new URL(location.href);
      const uid = url.searchParams.get("uid");
      if (uid) return uid;
      const peerId = url.searchParams.get("peerId");
      if (peerId) return peerId;
      const chatId = url.searchParams.get("chatId");
      if (chatId) return chatId;
      const dialogId = url.searchParams.get("dialogId");
      if (dialogId) return dialogId;
    } catch (_) {}
    const pathMatch = location.href.match(/\/chat\/([^/?#]+)/) ||
                      location.href.match(/[?&](chatId|peerId|dialogId)=([^&]+)/);
    return pathMatch ? pathMatch[pathMatch.length - 1] : null;
  }

  function getMessageContainer() {
    for (const sel of BALE_SELECTORS.messageListParents) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function getMessageItemsFromNode(node) {
    const items = [];
    if (!(node instanceof Element)) return items;
    for (const sel of BALE_SELECTORS.messageItemCandidates) {
      if (node.matches?.(sel)) {
        items.push(node);
        return items;
      }
    }
    for (const sel of BALE_SELECTORS.messageItemCandidates) {
      const found = node.querySelectorAll?.(sel);
      if (found?.length) {
        items.push(...found);
        return items;
      }
    }
    return items;
  }

  function getAllMessageElements(container) {
    const seen = new Set();
    const items = [];
    for (const sel of BALE_SELECTORS.messageItemCandidates) {
      const found = container.querySelectorAll(sel);
      for (const el of found) {
        if (!seen.has(el)) {
          seen.add(el);
          items.push(el);
        }
      }
    }
    if (items.length === 0) {
      for (const child of container.children) {
        if (child instanceof Element) items.push(child);
      }
    }
    return items;
  }

  function extractMessagePayload(messageElement) {
    const fullText = messageElement.textContent?.trim();
    if (!fullText) return null;
    // Check for handshake envelope
    const hsEnvelope = extractHandshakeEnvelope(fullText);
    if (hsEnvelope) return { text: hsEnvelope, textElement: messageElement };
    // Find best text container
    const textElement = findBestTextContainer(messageElement);
    if (!textElement) return null;
    const text = textElement.textContent?.trim();
    if (!text) return null;
    const msgEnvelope = extractEncryptedEnvelope(text);
    if (!msgEnvelope) return null;
    return { text: msgEnvelope, textElement };
  }

  function extractHandshakeEnvelope(text) {
    const hs1 = text.match(/\[\[E2EHS1:([A-Za-z0-9+/=]{80,140})\]\]/);
    if (hs1) return `[[E2EHS1:${hs1[1]}]]`;
    const hs2 = text.match(/\[\[E2EHS2:([A-Za-z0-9+/=]{80,140})\]\]/);
    if (hs2) return `[[E2EHS2:${hs2[1]}]]`;
    const rawHs1 = text.match(/E2EHS1:[A-Za-z0-9+/=]{80,140}/);
    if (rawHs1) return rawHs1[0];
    const rawHs2 = text.match(/E2EHS2:[A-Za-z0-9+/=]{80,140}/);
    if (rawHs2) return rawHs2[0];
    return null;
  }

  function extractEncryptedEnvelope(text) {
    const msg = text.match(/E2EMSG:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)/);
    return msg ? msg[0] : null;
  }

  function findBestTextContainer(messageElement) {
    for (const selector of BALE_SELECTORS.textCandidates) {
      const nodes = messageElement.querySelectorAll(selector);
      for (const node of nodes) {
        const txt = node.textContent?.trim();
        if (txt && txt.includes("E2EMSG:")) return node;
      }
    }
    return null;
  }

  function getMessageInput() {
    for (const selector of BALE_SELECTORS.inputCandidates) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function getSendButton() {
    for (const selector of BALE_SELECTORS.sendButtonCandidates) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  window.__E2E_PLATFORM.register("bale", {
    getChatId,
    getMessageContainer,
    getMessageItemsFromNode,
    getAllMessageElements,
    extractMessagePayload,
    getMessageInput,
    getSendButton
  });
})();
