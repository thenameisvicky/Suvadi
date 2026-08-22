(() => {
  let activeChat = null;
  let widgetContainer = null;
  let isDragging = false;
  let startX, startY;
  let initialLeft, initialTop;
  let saveTimeout = null;
  let isAutoSyncEnabled = false;
  let isCollapseHistoryEnabled = false;

  let composerContainer = null;
  let isComposerDragging = false;
  let composerStartX = 0, composerStartY = 0;
  let composerInitialLeft = 0, composerInitialTop = 0;

  // Intercept normal Enter in ChatGPT to prevent accidental half-written submissions
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    if (target && target.matches('[contenteditable="true"], textarea')) {
      // Exclude our own composer textarea
      if (target.id === 'suvadi-composer-textarea') return;
      
      // If it is ChatGPT's input box, intercept normal Enter
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();

        // Convert it to a Shift+Enter keypress so it inserts a newline instead
        const shiftEnterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
          shiftKey: true
        });
        target.dispatchEvent(shiftEnterEvent);
      }
    }
  }, true);

  let tabId = null;

  function getTabKey(key) {
    const tabSpecificKeys = [
      'chatgpt_active_chat',
      'chatgpt_saver_visible',
      'chatgpt_composer_visible',
      'chatgpt_composer_draft',
      'chatgpt_hyper_focus'
    ];
    if (tabSpecificKeys.includes(key) && tabId) {
      return `${key}_${tabId}`;
    }
    return key;
  }

  const tabStorage = {
    get: (keys, cb) => {
      const queryObj = {};
      if (typeof keys === 'string') {
        queryObj[getTabKey(keys)] = null;
      } else if (Array.isArray(keys)) {
        keys.forEach(k => {
          queryObj[getTabKey(k)] = null;
        });
      } else if (keys && typeof keys === 'object') {
        for (const [k, v] of Object.entries(keys)) {
          queryObj[getTabKey(k)] = v;
        }
      }
      chrome.storage.local.get(queryObj, (data) => {
        const result = {};
        if (typeof keys === 'string') {
          result[keys] = data[getTabKey(keys)];
          cb(result);
        } else if (Array.isArray(keys)) {
          keys.forEach(k => {
            result[k] = data[getTabKey(k)];
          });
          cb(result);
        } else if (keys && typeof keys === 'object') {
          for (const k of Object.keys(keys)) {
            result[k] = data[getTabKey(k)] !== undefined ? data[getTabKey(k)] : keys[k];
          }
          cb(result);
        }
      });
    },
    set: (obj, cb) => {
      const storeObj = {};
      for (const [k, v] of Object.entries(obj)) {
        storeObj[getTabKey(k)] = v;
      }
      chrome.storage.local.set(storeObj, cb);
    },
    remove: (keys, cb) => {
      const keysToRemove = Array.isArray(keys) ? keys : [keys];
      const mappedKeys = keysToRemove.map(k => getTabKey(k));
      chrome.storage.local.remove(mappedKeys, cb);
    }
  };

  function getCleanMessageText(msgEl, role, isLast) {
    if (msgEl.__suvadi_clean_text) {
      return msgEl.__suvadi_clean_text;
    }

    const clone = msgEl.cloneNode(true);
    
    const interactiveSelectors = [
      'button',
      'svg',
      '.sr-only',
      'input',
      'select',
      '[role="button"]',
      'style',
      'script',
      '.flex.items-center.justify-between'
    ];
    
    interactiveSelectors.forEach(selector => {
      clone.querySelectorAll(selector).forEach(el => el.remove());
    });

    let cleanText = "";
    if (role === 'assistant') {
      const markdown = clone.querySelector('.markdown') || clone;
      cleanText = markdown.innerText.trim();
    } else {
      cleanText = clone.innerText.trim();
    }

    // Cache clean text for static historic messages (not the last active one)
    if (!isLast && cleanText) {
      msgEl.__suvadi_clean_text = cleanText;
    }

    return cleanText;
  }

  function syncConversation() {
    if (!activeChat) return;
    
    const sendButton = document.querySelector('button[data-testid="send-button"]') ||
                        document.querySelector('button[aria-label*="Send"]') ||
                        document.querySelector('button[title*="Send"]');
    if (!sendButton || sendButton.hasAttribute('disabled')) {
      return; 
    }

    const messageElements = document.querySelectorAll('[data-message-author-role]');
    if (messageElements.length === 0) return;

    const currentDOMMessages = [];
    messageElements.forEach((el, index) => {
      const role = el.getAttribute('data-message-author-role');
      const isLast = (index === messageElements.length - 1);
      const text = getCleanMessageText(el, role, isLast);
      if (text) {
        currentDOMMessages.push({ role, text });
      }
    });

    let messagesToStore = [];
    if (activeChat.isContinuation) {
      const newMessages = currentDOMMessages.filter(msg => {
        const isHistoryPrompt = msg.role === 'user' && msg.text.includes('--- START OF CONVERSATION HISTORY ---');
        const isHistoryGreeting = msg.role === 'assistant' && (
          msg.text.includes('I have loaded the history context') || 
          msg.text.includes('loaded the history')
        );
        return !isHistoryPrompt && !isHistoryGreeting;
      });
      messagesToStore = [...activeChat.baseMessages, ...newMessages];
    } else {
      messagesToStore = currentDOMMessages;
    }

    tabStorage.get(['chatgpt_saved_chats'], (data) => {
      const saved = data.chatgpt_saved_chats || {};
      if (saved[activeChat.id]) {
        const prevLength = saved[activeChat.id].messages.length;
        const newLength = messagesToStore.length;
        
        let hasChanged = prevLength !== newLength;
        if (!hasChanged && newLength > 0) {
          const lastIndex = newLength - 1;
          if (saved[activeChat.id].messages[lastIndex].text !== messagesToStore[lastIndex].text) {
            hasChanged = true;
          }
        }

        if (hasChanged) {
          saved[activeChat.id].messages = messagesToStore;
          saved[activeChat.id].timestamp = Date.now();
          
          // Keep activeChat updated in memory and storage so refreshes restore the full state
          activeChat.baseMessages = messagesToStore;
          
          tabStorage.set({ 
            chatgpt_saved_chats: saved,
            chatgpt_active_chat: activeChat
          }, () => {
            renderSavedChatsList();
            syncSingleToLocal(saved[activeChat.id], saved);
          });
        }
      }
    });
  }

  function queueSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      syncConversation();
    }, 1000);
  }

  const observer = new MutationObserver((mutations) => {
    let shouldSync = false;
    let hasNewArticles = false;
    
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.querySelector('[data-message-author-role]') || node.hasAttribute('data-message-author-role') || node.tagName === 'ARTICLE') {
              shouldSync = true;
              hasNewArticles = true;
              break;
            }
          }
        }
      } else if (mutation.type === 'characterData') {
        shouldSync = true;
      }
      if (shouldSync) break;
    }
    
    if (hasNewArticles && isCollapseHistoryEnabled) {
      collapseOlderMessages();
    }
    
    if (shouldSync && activeChat) {
      queueSave();
    }
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    });
  }

  function formatChatHistory(messages) {
    let historyStr = "This is a continuation of our previous conversation. Please analyze this history and prepare to continue. Reply only with 'I have loaded the history context. How can I help you continue?' and do not output anything else yet.\n\n";
    historyStr += "--- START OF CONVERSATION HISTORY ---\n";
    messages.forEach(msg => {
      const roleName = msg.role === 'user' ? 'User' : 'Assistant';
      historyStr += `[${roleName}]: ${msg.text}\n\n`;
    });
    historyStr += "--- END OF CONVERSATION HISTORY ---";
    return historyStr;
  }

  function insertTextIntoInput(text) {
    const chatInput = document.querySelector('#prompt-textarea') || 
                      document.querySelector('textarea') || 
                      document.querySelector('[contenteditable="true"]');
    if (!chatInput) {
      console.error("ChatGPT input element not found!");
      return false;
    }
    chatInput.focus();
    
    // 1. Optimized direct DOM assignment for Lexical/contenteditable
    if (chatInput.getAttribute('contenteditable') === 'true') {
      try {
        chatInput.innerHTML = '';
        const lines = text.split('\n');
        const fragment = document.createDocumentFragment();
        lines.forEach(line => {
          const p = document.createElement('p');
          p.appendChild(document.createTextNode(line || ''));
          fragment.appendChild(p);
        });
        chatInput.appendChild(fragment);

        // Notify Lexical editor of the content change
        const inputEvent = new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text
        });
        chatInput.dispatchEvent(inputEvent);
        return true;
      } catch (err) {
        console.warn("Direct DOM insertion failed, falling back:", err);
      }
    }

    // 2. Standard Textarea/Input setter
    if (chatInput.tagName === 'TEXTAREA' || chatInput.tagName === 'INPUT') {
      try {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set ||
                                       Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(chatInput, text);
          chatInput.dispatchEvent(new Event('input', { bubbles: true }));
          chatInput.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      } catch (e) {
        console.error("Native setter assignment failed:", e);
      }
      chatInput.value = text;
      chatInput.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    
    // 3. Fallback to execCommand (fast for smaller strings, safe fallback)
    try {
      document.execCommand('insertText', false, text);
      return true;
    } catch (e) {
      console.warn("execCommand failed:", e);
    }
    
    chatInput.innerText = text;
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function submitChatInput() {
    setTimeout(() => {
      const sendButton = document.querySelector('button[data-testid="send-button"]') ||
                          document.querySelector('button[aria-label*="Send"]') ||
                          document.querySelector('button[title*="Send"]');
      if (sendButton) {
        sendButton.click();
      } else {
        console.warn("ChatGPT send button not found.");
      }
    }, 300);
  }

  function toggleHyperFocus() {
    const body = document.body;
    const isEnabled = body.classList.contains('suvadi-hyper-focus');
    
    if (isEnabled) {
      body.classList.remove('suvadi-hyper-focus');
      tabStorage.set({ chatgpt_hyper_focus: false });
      updateHyperFocusUI(false);
    } else {
      body.classList.add('suvadi-hyper-focus');
      tabStorage.set({ chatgpt_hyper_focus: true });
      updateHyperFocusUI(true);
    }
  }

  function updateHyperFocusUI(isEnabled) {
    const btns = document.querySelectorAll('.suvadi-hyper-focus-toggle');
    btns.forEach(btn => {
      if (isEnabled) {
        btn.classList.add('active');
        btn.setAttribute('title', 'Exit Hyper Focus');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('title', 'Enter Hyper Focus');
      }
    });
  }

  function toggleCollapseHistory() {
    tabStorage.get(['chatgpt_collapse_history'], (data) => {
      const isCollapsed = data.chatgpt_collapse_history === true;
      if (isCollapsed) {
        tabStorage.set({ chatgpt_collapse_history: false }, () => {
          isCollapseHistoryEnabled = false;
          updateCollapseHistoryUI(false);
          expandAllMessages();
        });
      } else {
        tabStorage.set({ chatgpt_collapse_history: true }, () => {
          isCollapseHistoryEnabled = true;
          updateCollapseHistoryUI(true);
          collapseOlderMessages();
        });
      }
    });
  }

  function updateCollapseHistoryUI(isEnabled) {
    const btn = document.getElementById('suvadi-collapse-history-toggle');
    if (!btn) return;
    const icon = document.getElementById('suvadi-collapse-history-icon');
    if (isEnabled) {
      btn.classList.add('active');
      btn.setAttribute('title', 'Expand History (Show all messages)');
      if (icon) {
        icon.innerHTML = `<polyline points="17 13 12 18 7 13"></polyline><polyline points="17 6 12 11 7 6"></polyline>`;
      }
    } else {
      btn.classList.remove('active');
      btn.setAttribute('title', 'Collapse History (Speed Boost)');
      if (icon) {
        icon.innerHTML = `<polyline points="17 11 12 6 7 11"></polyline><polyline points="17 18 12 13 7 18"></polyline>`;
      }
    }
  }

  function collapseOlderMessages() {
    const articles = document.querySelectorAll('article');
    if (articles.length <= 8) {
      const existingBtn = document.getElementById('suvadi-show-older-btn');
      if (existingBtn) existingBtn.remove();
      return;
    }
    
    const collapsedCount = articles.length - 8;
    for (let i = 0; i < collapsedCount; i++) {
      articles[i].classList.add('suvadi-collapsed-message');
    }
    for (let i = collapsedCount; i < articles.length; i++) {
      articles[i].classList.remove('suvadi-collapsed-message');
    }
    
    // Insert fold toggle button before the 9th article (the first visible one)
    const targetArticle = articles[collapsedCount];
    let showOlderBtn = document.getElementById('suvadi-show-older-btn');
    if (!showOlderBtn) {
      showOlderBtn = document.createElement('button');
      showOlderBtn.id = 'suvadi-show-older-btn';
      showOlderBtn.addEventListener('click', () => {
        tabStorage.set({ chatgpt_collapse_history: false }, () => {
          isCollapseHistoryEnabled = false;
          updateCollapseHistoryUI(false);
          expandAllMessages();
        });
      });
      targetArticle.parentNode.insertBefore(showOlderBtn, targetArticle);
    }
    showOlderBtn.textContent = `Show older messages (${collapsedCount} hidden for performance)`;
  }

  function expandAllMessages() {
    const collapsed = document.querySelectorAll('.suvadi-collapsed-message');
    collapsed.forEach(el => el.classList.remove('suvadi-collapsed-message'));
    
    const showOlderBtn = document.getElementById('suvadi-show-older-btn');
    if (showOlderBtn) {
      showOlderBtn.remove();
    }
  }

  function setupDragAndDrop(container) {
    if (!container) return;
    const dragHandle = container.querySelector('#chat-saver-drag-handle');
    if (!dragHandle) return;
    
    let cachedWidth = 0;
    let cachedHeight = 0;
    
    dragHandle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.chat-saver-controls')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = container.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      cachedWidth = rect.width;
      cachedHeight = rect.height;

      container.style.left = `${initialLeft}px`;
      container.style.top = `${initialTop}px`;
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.transition = 'none';
      
      container.classList.add('chat-saver-dragging');
      document.body.classList.add('suvadi-global-dragging');

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      
      e.preventDefault();
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      
      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;
      
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      if (newLeft < 0) newLeft = 0;
      if (newLeft + cachedWidth > viewportWidth) newLeft = viewportWidth - cachedWidth;
      if (newTop < 0) newTop = 0;
      if (newTop + cachedHeight > viewportHeight) newTop = viewportHeight - cachedHeight;
      
      container.style.left = `${newLeft}px`;
      container.style.top = `${newTop}px`;
      container.style.right = 'auto';
      container.style.bottom = 'auto';
    }

    function onMouseUp() {
      if (!isDragging) return;
      isDragging = false;
      container.style.transition = 'width 0.2s ease, height 0.2s ease, right 0.2s ease, top 0.2s ease, border-radius 0.2s ease';
      
      container.classList.remove('chat-saver-dragging');
      document.body.classList.remove('suvadi-global-dragging');

      const rect = container.getBoundingClientRect();
      tabStorage.set({
        chatgpt_saver_pos: {
          left: rect.left,
          top: rect.top
        }
      });

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
  }

  function maximizeWidget(useTransition = true) {
    if (!widgetContainer) return;
    if (!useTransition) {
      widgetContainer.style.transition = 'none';
    }
    
    // Clear inline styles before maximizing so stylesheet rules apply cleanly
    widgetContainer.style.width = '';
    widgetContainer.style.height = '';
    widgetContainer.style.left = '';
    widgetContainer.style.top = '';
    widgetContainer.style.right = '';
    widgetContainer.style.bottom = '';

    widgetContainer.classList.remove('chat-saver-minimized');
    widgetContainer.classList.add('chat-saver-maximized');
    
    const sizeIcon = document.getElementById('chat-saver-size-icon');
    if (sizeIcon) {
      sizeIcon.innerHTML = `<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/>`;
    }
    
    if (!useTransition) {
      widgetContainer.offsetHeight;
      widgetContainer.style.transition = 'width 0.2s ease, height 0.2s ease, right 0.2s ease, top 0.2s ease, border-radius 0.2s ease';
    }
    
    tabStorage.set({ chatgpt_saver_state: 'maximized' });
  }

  function minimizeWidget(useTransition = true) {
    if (!widgetContainer) return;
    if (!useTransition) {
      widgetContainer.style.transition = 'none';
    }
    widgetContainer.classList.remove('chat-saver-maximized');
    widgetContainer.classList.add('chat-saver-minimized');
    
    tabStorage.get(['chatgpt_saver_pos'], (data) => {
      if (!widgetContainer) return;
      if (data.chatgpt_saver_pos) {
        widgetContainer.style.left = `${data.chatgpt_saver_pos.left}px`;
        widgetContainer.style.top = `${data.chatgpt_saver_pos.top}px`;
        widgetContainer.style.right = 'auto';
        widgetContainer.style.bottom = 'auto';
      } else {
        widgetContainer.style.top = '70px';
        widgetContainer.style.right = '20px';
        widgetContainer.style.left = 'auto';
        widgetContainer.style.bottom = 'auto';
      }
    });

    const sizeIcon = document.getElementById('chat-saver-size-icon');
    if (sizeIcon) {
      sizeIcon.innerHTML = `<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>`;
    }

    if (!useTransition) {
      widgetContainer.offsetHeight; 
      widgetContainer.style.transition = 'width 0.2s ease, height 0.2s ease, right 0.2s ease, top 0.2s ease, border-radius 0.2s ease';
    }

    tabStorage.set({ chatgpt_saver_state: 'minimized' });
  }

  function applyStoredPosition() {
    if (!widgetContainer) return;
    tabStorage.get(['chatgpt_saver_pos', 'chatgpt_saver_state'], (data) => {
      if (!widgetContainer) return;
      const isMaximized = data.chatgpt_saver_state === 'maximized';
      
      if (isMaximized) {
        maximizeWidget(false);
      } else {
        minimizeWidget(false);
        if (data.chatgpt_saver_pos) {
          let { left, top } = data.chatgpt_saver_pos;
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;
          const rect = widgetContainer.getBoundingClientRect();
          
          if (left < 0) left = 0;
          if (left + rect.width > viewportWidth) left = viewportWidth - rect.width;
          if (top < 0) top = 0;
          if (top + rect.height > viewportHeight) top = viewportHeight - rect.height;
          
          widgetContainer.style.left = `${left}px`;
          widgetContainer.style.top = `${top}px`;
          widgetContainer.style.right = 'auto';
          widgetContainer.style.bottom = 'auto';
        } else {
          widgetContainer.style.top = '70px';
          widgetContainer.style.right = '20px';
          widgetContainer.style.left = 'auto';
          widgetContainer.style.bottom = 'auto';
        }
      }
    });
  }

  function setupControlButtons(container) {
    if (!container) return;
    const toggleSizeBtn = container.querySelector('#chat-saver-toggle-size');
    if (toggleSizeBtn) {
      toggleSizeBtn.addEventListener('click', () => {
        if (container.classList.contains('chat-saver-maximized')) {
          minimizeWidget(true);
        } else {
          maximizeWidget(true);
        }
      });
    }

    const toggleHyperFocusBtn = container.querySelector('#suvadi-hyper-focus-toggle-main');
    if (toggleHyperFocusBtn) {
      toggleHyperFocusBtn.addEventListener('click', toggleHyperFocus);
    }

    const toggleCollapseBtn = container.querySelector('#suvadi-collapse-history-toggle');
    if (toggleCollapseBtn) {
      toggleCollapseBtn.addEventListener('click', toggleCollapseHistory);
      updateCollapseHistoryUI(isCollapseHistoryEnabled);
    }

    const toggleComposerBtn = container.querySelector('#suvadi-composer-toggle-trigger');
    if (toggleComposerBtn) {
      toggleComposerBtn.addEventListener('click', () => {
        if (!composerContainer) return;
        
        if (composerContainer.style.display === 'none') {
          composerContainer.style.display = 'flex';
          tabStorage.set({ chatgpt_composer_visible: true });
          const textarea = composerContainer.querySelector('#suvadi-composer-textarea');
          if (textarea) textarea.focus();
        } else {
          composerContainer.style.display = 'none';
          tabStorage.set({ chatgpt_composer_visible: false });
        }
      });
    }

    const closeBtn = container.querySelector('#chat-saver-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        container.style.display = 'none';
        tabStorage.set({ chatgpt_saver_visible: false });
      });
    }
  }

  function startRecording(name, identifier) {
    const chatId = 'chat_' + Date.now();
    activeChat = {
      id: chatId,
      name: name,
      identifier: identifier,
      isContinuation: false,
      baseMessages: []
    };

    tabStorage.get(['chatgpt_saved_chats'], (data) => {
      const saved = data.chatgpt_saved_chats || {};
      saved[chatId] = {
        id: chatId,
        name: name,
        identifier: identifier,
        messages: [],
        timestamp: Date.now()
      };
      tabStorage.set({ 
        chatgpt_active_chat: activeChat, 
        chatgpt_saved_chats: saved 
      }, () => {
        renderActiveArea();
        renderSavedChatsList();
        syncConversation(); 
      });
    });
  }

  function getSuggestedChatInfo() {
    const messageElements = document.querySelectorAll('[data-message-author-role]');
    let firstUserText = "";
    
    for (const el of messageElements) {
      const role = el.getAttribute('data-message-author-role');
      if (role === 'user') {
        firstUserText = getCleanMessageText(el, role);
        break;
      }
    }

    if (!firstUserText) {
      return { name: "", identifier: "" };
    }

    const words = firstUserText.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
    const suggestedName = words.slice(0, 4).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const suggestedId = suggestedName.toLowerCase().replace(/\s+/g, '-');

    return {
      name: suggestedName,
      identifier: suggestedId
    };
  }

  function stopRecording() {
    activeChat = null;
    tabStorage.remove('chatgpt_active_chat', () => {
      renderActiveArea();
    });
  }

  function renderActiveArea() {
    const activeArea = document.getElementById('chat-saver-active-area');
    if (!activeArea) return;

    if (activeChat) {
      activeArea.innerHTML = `
        <div style="background: rgba(255, 77, 77, 0.1); border: 1px solid rgba(255, 77, 77, 0.3); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 8px;">
          <div style="font-size: 10px; font-weight: bold; color: #ff4d4d; text-transform: uppercase; letter-spacing: 0.5px;">Recording Session</div>
          <div style="font-size: 13px; font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" id="active-chat-name"></div>
          <div style="font-size: 10px; color: #acacbe;">Identifier: <code id="active-chat-identifier"></code></div>
          <button class="chat-saver-submit-btn" id="chat-saver-stop-btn" style="background: #e03c3c; width: 100%;">Stop Saving</button>
        </div>
      `;
      
      const nameEl = document.getElementById('active-chat-name');
      const idEl = document.getElementById('active-chat-identifier');
      if (nameEl) nameEl.textContent = activeChat.name;
      if (idEl) idEl.textContent = activeChat.identifier;
      
      const stopBtn = document.getElementById('chat-saver-stop-btn');
      if (stopBtn) {
        stopBtn.addEventListener('click', () => {
          stopRecording();
        });
      }
    } else {
      const suggested = getSuggestedChatInfo();
      activeArea.innerHTML = `
        <form class="chat-saver-form" id="chat-saver-start-form">
          <div class="chat-saver-input-group">
            <label for="chat-saver-name">Chat Name</label>
            <input class="chat-saver-input" type="text" id="chat-saver-name" placeholder="e.g. Flask API Help" required />
          </div>
          <div class="chat-saver-input-group">
            <label for="chat-saver-id">Identifier (Short tag)</label>
            <input class="chat-saver-input" type="text" id="chat-saver-id" placeholder="e.g. flask-api" required />
          </div>
          <button class="chat-saver-submit-btn" type="submit">Start Saving This Chat</button>
        </form>
      `;

      const nameInput = document.getElementById('chat-saver-name');
      const idInput = document.getElementById('chat-saver-id');
      if (nameInput && suggested.name) nameInput.value = suggested.name;
      if (idInput && suggested.identifier) idInput.value = suggested.identifier;

      const startForm = document.getElementById('chat-saver-start-form');
      if (startForm) {
        startForm.addEventListener('submit', (e) => {
          e.preventDefault();
          const nameVal = nameInput ? nameInput.value.trim() : '';
          const idVal = idInput ? idInput.value.trim() : '';
          if (nameVal && idVal) {
            startRecording(nameVal, idVal);
          }
        });
      }
    }
  }

  function renderSavedChatsList() {
    const listContainer = document.getElementById('chat-saver-list-container');
    if (!listContainer) return;

    tabStorage.get(['chatgpt_saved_chats'], (data) => {
      const saved = data.chatgpt_saved_chats || {};
      const chatIds = Object.keys(saved).sort((a, b) => saved[b].timestamp - saved[a].timestamp);

      if (chatIds.length === 0) {
        listContainer.innerHTML = `<div style="font-size: 11px; color: #acacbe; text-align: center; padding: 12px 0;">No saved chats.</div>`;
        return;
      }

      listContainer.innerHTML = '';
      chatIds.forEach(id => {
        const chat = saved[id];
        const dateStr = new Date(chat.timestamp).toLocaleString();
        const messageCount = chat.messages ? chat.messages.length : 0;
        
        const itemEl = document.createElement('div');
        itemEl.className = 'chat-saver-item';
        itemEl.innerHTML = `
          <div class="chat-saver-item-title" id="title-${id}"></div>
          <div class="chat-saver-item-meta">ID: <code id="identifier-${id}"></code></div>
          <div class="chat-saver-item-meta">${messageCount} messages | ${dateStr}</div>
          <div class="chat-saver-item-actions">
            <button class="chat-saver-action-btn load-btn" data-id="${id}">Load</button>
            <button class="chat-saver-action-btn copy-btn" data-id="${id}">Copy</button>
            <button class="chat-saver-action-btn delete-btn" data-id="${id}">Delete</button>
          </div>
        `;

        listContainer.appendChild(itemEl);

        const titleEl = document.getElementById(`title-${id}`);
        const identifierEl = document.getElementById(`identifier-${id}`);
        if (titleEl) titleEl.textContent = chat.name;
        if (identifierEl) identifierEl.textContent = chat.identifier;

        const loadBtn = itemEl.querySelector('.load-btn');
        if (loadBtn) {
          loadBtn.addEventListener('click', () => {
            loadSavedChat(id);
          });
        }
        
        const copyBtn = itemEl.querySelector('.copy-btn');
        if (copyBtn) {
          copyBtn.addEventListener('click', () => {
            copySavedChat(id);
          });
        }

        const deleteBtn = itemEl.querySelector('.delete-btn');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', () => {
            deleteSavedChat(id);
          });
        }
      });
    });
  }

  function loadSavedChat(id) {
    tabStorage.get(['chatgpt_saved_chats'], (data) => {
      const saved = data.chatgpt_saved_chats || {};
      const chat = saved[id];
      if (!chat || !chat.messages || chat.messages.length === 0) {
        alert("No messages found in this chat to load!");
        return;
      }

      activeChat = {
        id: chat.id,
        name: chat.name,
        identifier: chat.identifier,
        isContinuation: true,
        baseMessages: chat.messages
      };

      tabStorage.set({ chatgpt_active_chat: activeChat }, () => {
        renderActiveArea();
        
        const formattedPrompt = formatChatHistory(chat.messages);
        const inserted = insertTextIntoInput(formattedPrompt);
        if (inserted) {
          submitChatInput();
        } else {
          alert("Could not automatically insert prompt. Copied to clipboard instead. Please paste it into the ChatGPT input box.");
          navigator.clipboard.writeText(formattedPrompt);
        }
      });
    });
  }

  function copySavedChat(id) {
    tabStorage.get(['chatgpt_saved_chats'], (data) => {
      const saved = data.chatgpt_saved_chats || {};
      const chat = saved[id];
      if (!chat || !chat.messages) return;

      let text = `Chat Name: ${chat.name}\nIdentifier: ${chat.identifier}\n\n`;
      chat.messages.forEach(msg => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        text += `[${role}]: ${msg.text}\n\n`;
      });

      navigator.clipboard.writeText(text).then(() => {
        alert("Chat history copied to clipboard!");
      }).catch(err => {
        console.error("Could not copy chat: ", err);
      });
    });
  }

  function deleteSavedChat(id) {
    if (!confirm("Are you sure you want to delete this saved chat?")) return;

    tabStorage.get(['chatgpt_saved_chats'], (data) => {
      const saved = data.chatgpt_saved_chats || {};
      delete saved[id];
      
      if (activeChat && activeChat.id === id) {
        activeChat = null;
        tabStorage.remove('chatgpt_active_chat');
      }

      tabStorage.set({ chatgpt_saved_chats: saved }, () => {
        renderActiveArea();
        renderSavedChatsList();
        syncAllToLocal(saved); 
      });
    });
  }

  // ==========================================
  // LOCAL SYNC LOGIC VIA BACKGROUND SERVICE WORKER
  // ==========================================

  function writeLocalFile(fileName, content) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: "write_local_file",
        fileName: fileName,
        content: content
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error("Write local file error:", chrome.runtime.lastError);
          resolve(false);
        } else {
          resolve(response && response.success);
        }
      });
    });
  }

  function deleteLocalFile(fileName) {
    console.log(`File deletion of ${fileName} requested, but not supported via Downloads API.`);
  }

  function extractConcepts(messages) {
    const text = messages.map(m => m.text).join(' ').toLowerCase();
    const conceptsList = [
      'python', 'javascript', 'html', 'css', 'react', 'node', 'express', 'flask', 'django', 'sql',
      'database', 'api', 'json', 'debugging', 'bug', 'error', 'docker', 'git', 'aws', 'deploy',
      'security', 'auth', 'login', 'performance', 'flexbox', 'grid', 'array', 'object'
    ];
    
    const found = [];
    conceptsList.forEach(concept => {
      const regex = new RegExp('\\b' + concept + '\\b', 'i');
      if (regex.test(text)) {
        found.push(concept.charAt(0).toUpperCase() + concept.slice(1));
      }
    });
    
    return found;
  }

  function generateUnifiedMarkdown(savedChats) {
    let md = `# ChatGPT Memory Graph & Session Archive\n\n`;
    md += `Last Updated: ${new Date().toLocaleString()}\n\n`;
    
    md += `## Concept Map\n`;
    const conceptMap = {};
    const chatIds = Object.keys(savedChats).sort((a, b) => savedChats[b].timestamp - savedChats[a].timestamp);
    
    chatIds.forEach(id => {
      const chat = savedChats[id];
      const concepts = extractConcepts(chat.messages || []);
      concepts.forEach(concept => {
        if (!conceptMap[concept]) {
          conceptMap[concept] = [];
        }
        conceptMap[concept].push(`\`${chat.identifier}\` (${chat.name})`);
      });
    });
    
    const concepts = Object.keys(conceptMap).sort();
    if (concepts.length === 0) {
      md += `No concepts detected yet. Start chatting to build the graph!\n\n`;
    } else {
      concepts.forEach(concept => {
        md += `- **${concept}**: Discussed in ${conceptMap[concept].join(', ')}\n`;
      });
      md += `\n`;
    }
    
    md += `## Chat Index\n`;
    if (chatIds.length === 0) {
      md += `No saved chats yet.\n\n`;
    } else {
      chatIds.forEach(id => {
        const chat = savedChats[id];
        const messageCount = chat.messages ? chat.messages.length : 0;
        md += `- **${chat.name}** (ID: \`${chat.identifier}\` | ${messageCount} messages | ${new Date(chat.timestamp).toLocaleString()})\n`;
      });
      md += `\n`;
    }
    
    md += `---\n\n`;
    
    chatIds.forEach(id => {
      const chat = savedChats[id];
      md += `## Chat: ${chat.name} (\`${chat.identifier}\`)\n`;
      md += `- **Saved At**: ${new Date(chat.timestamp).toLocaleString()}\n`;
      md += `- **Total Messages**: ${chat.messages ? chat.messages.length : 0}\n\n`;
      
      if (!chat.messages || chat.messages.length === 0) {
        md += `*No messages in this chat.*\n\n`;
      } else {
        chat.messages.forEach(msg => {
          const roleName = msg.role === 'user' ? 'User' : 'Assistant';
          md += `### ${roleName}\n\n`;
          md += `${msg.text}\n\n`;
        });
      }
      
      md += `---\n\n`;
    });
    
    return md;
  }

  function generateChatMarkdown(chat) {
    let md = `# Chat Name: ${chat.name}\n`;
    md += `Identifier: ${chat.identifier}\n`;
    md += `Saved At: ${new Date(chat.timestamp).toLocaleString()}\n\n`;
    
    if (!chat.messages || chat.messages.length === 0) {
      md += `*No messages in this chat.*\n\n`;
    } else {
      chat.messages.forEach(msg => {
        const roleName = msg.role === 'user' ? 'User' : 'Assistant';
        md += `### ${roleName}\n\n`;
        md += `${msg.text}\n\n`;
        md += `---\n\n`;
      });
    }
    return md;
  }

  async function syncSingleToLocal(chat, savedChats) {
    if (!isAutoSyncEnabled) return;
    const content = generateChatMarkdown(chat);
    await writeLocalFile(`${chat.identifier}.md`, content);
  }

  async function syncAllToLocal(savedChats, force = false) {
    if (!isAutoSyncEnabled && !force) return;
    const chatIds = Object.keys(savedChats);
    for (let i = 0; i < chatIds.length; i++) {
      const chatId = chatIds[i];
      const chat = savedChats[chatId];
      const content = generateChatMarkdown(chat);
      await writeLocalFile(`${chat.identifier}.md`, content);
      // Spacing delay of 250ms prevents Chrome from dropping/skipping multiple downloads
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  function forceSyncConversation() {
    return new Promise((resolve) => {
      if (!activeChat) {
        resolve();
        return;
      }

      const messageElements = document.querySelectorAll('[data-message-author-role]');
      if (messageElements.length === 0) {
        resolve();
        return;
      }

      const currentDOMMessages = [];
      messageElements.forEach(el => {
        const role = el.getAttribute('data-message-author-role');
        const text = getCleanMessageText(el, role);
        if (text) {
          currentDOMMessages.push({ role, text });
        }
      });

      let messagesToStore = [];
      if (activeChat.isContinuation) {
        // Robust filtering: Exclude the history continuation block and its loader confirmation greeting
        const newMessages = currentDOMMessages.filter(msg => {
          const isHistoryPrompt = msg.role === 'user' && msg.text.includes('--- START OF CONVERSATION HISTORY ---');
          const isHistoryGreeting = msg.role === 'assistant' && (
            msg.text.includes('I have loaded the history context') || 
            msg.text.includes('loaded the history')
          );
          return !isHistoryPrompt && !isHistoryGreeting;
        });
        messagesToStore = [...activeChat.baseMessages, ...newMessages];
      } else {
        messagesToStore = currentDOMMessages;
      }

      tabStorage.get(['chatgpt_saved_chats'], (data) => {
        const saved = data.chatgpt_saved_chats || {};
        if (saved[activeChat.id]) {
          saved[activeChat.id].messages = messagesToStore;
          saved[activeChat.id].timestamp = Date.now();
          
          // Keep activeChat updated in memory and storage so refreshes restore the full state
          activeChat.baseMessages = messagesToStore;

          tabStorage.set({ 
            chatgpt_saved_chats: saved,
            chatgpt_active_chat: activeChat
          }, () => {
            renderSavedChatsList();
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  }

  function triggerFullSync() {
    forceSyncConversation().then(() => {
      tabStorage.get(['chatgpt_saved_chats'], (data) => {
        const saved = data.chatgpt_saved_chats || {};
        const chatIds = Object.keys(saved);
        if (chatIds.length === 0) {
          alert("No saved chats found to export.");
          return;
        }
        syncAllToLocal(saved, true).then(() => {
          alert(`Export complete! Saved ${chatIds.length} chat sessions inside your downloads folder: 'suvadi_vault/'.`);
        });
      });
    });
  }

  // Check sync states on UI load
  function checkLocalSyncOnLoad() {
    tabStorage.get(['chatgpt_auto_sync'], (data) => {
      isAutoSyncEnabled = data.chatgpt_auto_sync === true;
      const autoSyncCb = document.getElementById('chat-saver-auto-sync-cb');
      if (autoSyncCb) {
        autoSyncCb.checked = isAutoSyncEnabled;
      }
    });
  }

  function setupSyncSection(container) {
    if (!container) return;
    
    const syncNowBtn = container.querySelector('#chat-saver-sync-now-btn');
    if (syncNowBtn) {
      syncNowBtn.addEventListener('click', () => {
        triggerFullSync();
      });
    }

    const autoSyncCb = container.querySelector('#chat-saver-auto-sync-cb');
    if (autoSyncCb) {
      autoSyncCb.addEventListener('change', (e) => {
        isAutoSyncEnabled = e.target.checked;
        tabStorage.set({ chatgpt_auto_sync: isAutoSyncEnabled });
      });
    }
  }

  // WIRE UP TAB SWITCHING FOR MINIMIZED STATE
  function setupTabs(container) {
    if (!container) return;
    const tabBtns = container.querySelectorAll('.chat-saver-tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabName = btn.getAttribute('data-tab');
        
        container.querySelectorAll('.chat-saver-tab-btn').forEach(b => b.classList.remove('active'));
        container.querySelectorAll('.chat-saver-tab-pane').forEach(p => p.classList.remove('active'));
        
        btn.classList.add('active');
        const targetPane = container.querySelector(`#chat-saver-tab-content-${tabName}`);
        if (targetPane) {
          targetPane.classList.add('active');
        }
      });
    });
  }

  function parseMarkdownToChats(text) {
    const chats = {};
    
    if (text.includes('## Chat: ')) {
      const sections = text.split(/## Chat:\s*/);
      for (let i = 1; i < sections.length; i++) {
        const section = sections[i];
        const lines = section.split('\n');
        const firstLine = lines[0];
        const match = firstLine.match(/^(.*?)\s*\(\`([^\`]+)\`\)/);
        if (!match) continue;
        
        const name = match[1].trim();
        const identifier = match[2].trim();
        const messages = [];
        
        const content = lines.slice(1).join('\n');
        const msgBlocks = content.split(/###\s*(User|Assistant)\n+/i);
        
        for (let j = 1; j < msgBlocks.length; j += 2) {
          const role = msgBlocks[j].toLowerCase() === 'user' ? 'user' : 'assistant';
          let body = msgBlocks[j + 1] || '';
          
          body = body.split('\n---')[0].trim();
          if (body) {
            messages.push({ role, text: body });
          }
        }
        
        const id = 'chat_' + (Date.now() + i);
        chats[id] = {
          id,
          name,
          identifier,
          messages,
          timestamp: Date.now()
        };
      }
    } else {
      const nameMatch = text.match(/Chat Name:\s*(.*)/i);
      const idMatch = text.match(/Identifier:\s*(.*)/i);
      if (nameMatch && idMatch) {
        const name = nameMatch[1].trim();
        const identifier = idMatch[1].trim();
        const messages = [];
        
        const msgBlocks = text.split(/###\s*(User|Assistant)\n+/i);
        for (let j = 1; j < msgBlocks.length; j += 2) {
          const role = msgBlocks[j].toLowerCase() === 'user' ? 'user' : 'assistant';
          let body = msgBlocks[j + 1] || '';
          body = body.split('\n---')[0].trim();
          if (body) {
            messages.push({ role, text: body });
          }
        }
        
        const id = 'chat_' + Date.now();
        chats[id] = {
          id,
          name,
          identifier,
          messages,
          timestamp: Date.now()
        };
      }
    }
    
    return chats;
  }

  function setupImportHandler(container) {
    if (!container) return;
    const importBtn = container.querySelector('#chat-saver-import-btn');
    const fileInput = container.querySelector('#chat-saver-file-input');
    if (!importBtn || !fileInput) return;

    importBtn.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target.result;
        const importedChats = parseMarkdownToChats(text);
        const importedCount = Object.keys(importedChats).length;

        if (importedCount === 0) {
          alert("Could not find any valid chat sessions to import. Please make sure you selected a valid Suvadi markdown backup file.");
          return;
        }

        tabStorage.get(['chatgpt_saved_chats'], (data) => {
          const saved = data.chatgpt_saved_chats || {};
          let mergedCount = 0;
          
          for (const key in importedChats) {
            const chat = importedChats[key];
            const existingId = Object.keys(saved).find(id => saved[id].identifier === chat.identifier);
            if (existingId) {
              if (saved[existingId].messages.length < chat.messages.length) {
                saved[existingId].messages = chat.messages;
                saved[existingId].timestamp = Date.now();
                mergedCount++;
              }
            } else {
              saved[chat.id] = chat;
              mergedCount++;
            }
          }

          tabStorage.set({ chatgpt_saved_chats: saved }, () => {
            renderSavedChatsList();
            alert(`Import complete! Successfully imported/updated ${mergedCount} chat sessions.`);
            fileInput.value = '';
          });
        });
      };
      reader.readAsText(file);
    });
  }

  function setupComposerDrag(container) {
    const dragHandle = container.querySelector('#suvadi-composer-drag-handle');
    if (!dragHandle) return;

    let cachedWidth = 0;
    let cachedHeight = 0;

    dragHandle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.chat-saver-controls')) return;
      if (container.classList.contains('suvadi-composer-maximized')) return;

      isComposerDragging = true;
      composerStartX = e.clientX;
      composerStartY = e.clientY;

      const rect = container.getBoundingClientRect();
      composerInitialLeft = rect.left;
      composerInitialTop = rect.top;
      cachedWidth = rect.width;
      cachedHeight = rect.height;

      container.style.left = `${composerInitialLeft}px`;
      container.style.top = `${composerInitialTop}px`;
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.transition = 'none';

      container.classList.add('suvadi-dragging');
      document.body.classList.add('suvadi-global-dragging');

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      
      e.preventDefault();
    });

    function onMouseMove(e) {
      if (!isComposerDragging) return;
      
      const dx = e.clientX - composerStartX;
      const dy = e.clientY - composerStartY;
      
      let newLeft = composerInitialLeft + dx;
      let newTop = composerInitialTop + dy;
      
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      if (newLeft < 0) newLeft = 0;
      if (newLeft + cachedWidth > viewportWidth) newLeft = viewportWidth - cachedWidth;
      if (newTop < 0) newTop = 0;
      if (newTop + cachedHeight > viewportHeight) newTop = viewportHeight - cachedHeight;
      
      container.style.left = `${newLeft}px`;
      container.style.top = `${newTop}px`;
    }

    function onMouseUp() {
      if (!isComposerDragging) return;
      isComposerDragging = false;
      container.style.transition = 'width 0.2s ease, height 0.2s ease, left 0.2s ease, top 0.2s ease, border-radius 0.2s ease';
      
      container.classList.remove('suvadi-dragging');
      document.body.classList.remove('suvadi-global-dragging');

      const rect = container.getBoundingClientRect();
      tabStorage.set({
        chatgpt_composer_pos: {
          left: rect.left,
          top: rect.top
        }
      });

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    
    // Save size when manually resized by native handles
    container.addEventListener('mouseup', () => {
      if (!container.classList.contains('suvadi-composer-maximized') && container.style.display !== 'none') {
        const rect = container.getBoundingClientRect();
        tabStorage.set({
          chatgpt_composer_size: {
            width: rect.width,
            height: rect.height
          }
        });
      }
    });
  }

  function maximizeComposer(useTransition = true) {
    if (!composerContainer) return;
    if (!useTransition) {
      composerContainer.style.transition = 'none';
    }
    
    // Clear inline styles before maximizing so stylesheet rules apply cleanly
    composerContainer.style.width = '';
    composerContainer.style.height = '';
    composerContainer.style.left = '';
    composerContainer.style.top = '';
    composerContainer.style.right = '';
    composerContainer.style.bottom = '';

    composerContainer.classList.remove('suvadi-composer-minimized');
    composerContainer.classList.add('suvadi-composer-maximized');
    
    const sizeIcon = composerContainer.querySelector('#suvadi-composer-size-icon');
    if (sizeIcon) {
      sizeIcon.innerHTML = `<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/>`;
    }
    
    if (!useTransition) {
      composerContainer.offsetHeight; // force reflow
      composerContainer.style.transition = 'width 0.2s ease, height 0.2s ease, left 0.2s ease, top 0.2s ease, border-radius 0.2s ease';
    }
    
    tabStorage.set({ chatgpt_composer_state: 'maximized' });
  }

  function minimizeComposer(useTransition = true) {
    if (!composerContainer) return;
    if (!useTransition) {
      composerContainer.style.transition = 'none';
    }
    composerContainer.classList.remove('suvadi-composer-maximized');
    composerContainer.classList.add('suvadi-composer-minimized');
    
    const sizeIcon = composerContainer.querySelector('#suvadi-composer-size-icon');
    if (sizeIcon) {
      sizeIcon.innerHTML = `<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>`;
    }
    
    // Restore size & pos inline style rules
    tabStorage.get(['chatgpt_composer_pos', 'chatgpt_composer_size'], (data) => {
      if (!composerContainer) return;
      if (data.chatgpt_composer_size) {
        composerContainer.style.width = `${data.chatgpt_composer_size.width}px`;
        composerContainer.style.height = `${data.chatgpt_composer_size.height}px`;
      } else {
        composerContainer.style.width = '400px';
        composerContainer.style.height = '300px';
      }
      
      if (data.chatgpt_composer_pos) {
        composerContainer.style.left = `${data.chatgpt_composer_pos.left}px`;
        composerContainer.style.top = `${data.chatgpt_composer_pos.top}px`;
      } else {
        composerContainer.style.top = '70px';
        composerContainer.style.left = '70px';
      }
      composerContainer.style.right = 'auto';
      composerContainer.style.bottom = 'auto';
    });

    if (!useTransition) {
      composerContainer.offsetHeight; // force reflow
      composerContainer.style.transition = 'width 0.2s ease, height 0.2s ease, left 0.2s ease, top 0.2s ease, border-radius 0.2s ease';
    }
    
    tabStorage.set({ chatgpt_composer_state: 'minimized' });
  }

  function setupComposerControls(container) {
    const toggleSizeBtn = container.querySelector('#suvadi-composer-toggle-size');
    if (toggleSizeBtn) {
      toggleSizeBtn.addEventListener('click', () => {
        if (container.classList.contains('suvadi-composer-maximized')) {
          minimizeComposer(true);
        } else {
          maximizeComposer(true);
        }
      });
    }

    const toggleHyperFocusBtn = container.querySelector('#suvadi-hyper-focus-toggle-composer');
    if (toggleHyperFocusBtn) {
      toggleHyperFocusBtn.addEventListener('click', toggleHyperFocus);
    }

    const closeBtn = container.querySelector('#suvadi-composer-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        container.style.display = 'none';
        tabStorage.set({ chatgpt_composer_visible: false });
      });
    }
  }

  function setupComposerEditor(container) {
    const textarea = container.querySelector('#suvadi-composer-textarea');
    const sendBtn = container.querySelector('#suvadi-composer-send-btn');
    const charCount = container.querySelector('#suvadi-composer-char-count');
    const tokensCount = container.querySelector('#suvadi-composer-tokens');
    
    if (!textarea) return;

    // Helper for editing text
    function insertMarkup(before, after = '') {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;
      const selected = text.substring(start, end);
      const replacement = before + selected + after;
      textarea.value = text.substring(0, start) + replacement + text.substring(end);
      
      textarea.focus();
      textarea.selectionStart = start + before.length;
      textarea.selectionEnd = start + before.length + selected.length;
      updateStats();
    }

    function updateStats() {
      const text = textarea.value;
      const chars = text.length;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      
      if (chars > 0) {
        const tokens = Math.max(1, Math.round(chars / 4));
        if (charCount) {
          charCount.textContent = `${chars} character${chars !== 1 ? 's' : ''} | ${words} word${words !== 1 ? 's' : ''}`;
        }
        if (tokensCount) {
          tokensCount.textContent = `~${tokens} token${tokens !== 1 ? 's' : ''}`;
          tokensCount.style.display = 'inline-block';
        }
      } else {
        if (charCount) {
          charCount.textContent = `0 characters | 0 words`;
        }
        if (tokensCount) {
          tokensCount.style.display = 'none';
        }
      }
    }

    textarea.addEventListener('input', updateStats);

    // Toolbar event delegation
    container.querySelectorAll('.suvadi-toolbar-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'bold') {
          insertMarkup('**', '**');
        } else if (action === 'italic') {
          insertMarkup('_', '_');
        } else if (action === 'code') {
          insertMarkup('```\n', '\n```');
        } else if (action === 'bullet') {
          insertMarkup('- ');
        } else if (action === 'clear') {
          textarea.value = '';
          updateStats();
        }
      });
    });

    // Keydown listeners inside composer textarea
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'b' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        insertMarkup('**', '**');
      } else if (e.key === 'i' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        insertMarkup('_', '_');
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendPrompt();
      }
    });

    // Send button event
    if (sendBtn) {
      sendBtn.addEventListener('click', sendPrompt);
    }

    function sendPrompt() {
      const promptText = textarea.value.trim();
      if (!promptText) return;

      const success = insertTextIntoInput(promptText);
      if (success) {
        submitChatInput();
        textarea.value = '';
        updateStats();
      } else {
        alert("Failed to send prompt to ChatGPT input. Please make sure you are on an active ChatGPT conversation page.");
      }
    }
  }

  function initComposer() {
    const existing = document.getElementById('suvadi-composer-panel');
    if (existing) {
      existing.remove();
    }

    composerContainer = document.createElement('div');
    composerContainer.id = 'suvadi-composer-panel';
    composerContainer.className = 'suvadi-composer-minimized';
    composerContainer.style.display = 'none';

    composerContainer.innerHTML = `
      <div class="chat-saver-header" id="suvadi-composer-drag-handle">
        <span class="chat-saver-title">
          Suvadi Composer
          <span id="suvadi-composer-tokens" class="suvadi-tokens-badge" style="display: none; font-size: 10px; opacity: 0.8; background: rgba(255, 77, 77, 0.2); border: 1px solid rgba(255, 77, 77, 0.4); color: #ff9999; padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 600;">0 tokens</span>
        </span>
        <div class="chat-saver-controls">
          <button class="chat-saver-btn suvadi-hyper-focus-toggle" id="suvadi-hyper-focus-toggle-composer" title="Enter Hyper Focus">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>
          </button>
          <button class="chat-saver-btn" id="suvadi-composer-toggle-size" title="Maximize/Minimize">
            <svg id="suvadi-composer-size-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          </button>
          <button class="chat-saver-btn" id="suvadi-composer-close" title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>
      
      <div class="suvadi-composer-toolbar">
        <button class="suvadi-toolbar-btn" data-action="bold" title="Bold (Ctrl+B)">B</button>
        <button class="suvadi-toolbar-btn" data-action="italic" title="Italic (Ctrl+I)">I</button>
        <button class="suvadi-toolbar-btn" data-action="code" title="Code Block">Code</button>
        <button class="suvadi-toolbar-btn" data-action="bullet" title="Bullet List">- List</button>
        <button class="suvadi-toolbar-btn" data-action="clear" title="Clear">Clear</button>
      </div>
      
      <div class="suvadi-composer-editor-wrapper">
        <textarea id="suvadi-composer-textarea" class="suvadi-composer-textarea" placeholder="Compose your prompt here... Enter adds a newline. Ctrl+Enter sends to ChatGPT."></textarea>
      </div>
      
      <div class="suvadi-composer-footer">
        <div id="suvadi-composer-char-count" class="suvadi-composer-char-count">0 characters | 0 words</div>
        <button id="suvadi-composer-send-btn" class="chat-saver-submit-btn" style="width: auto; padding: 6px 16px;">Send</button>
      </div>
    `;

    document.body.appendChild(composerContainer);

    setupComposerDrag(composerContainer);
    setupComposerControls(composerContainer);
    setupComposerEditor(composerContainer);

    tabStorage.get([
      'chatgpt_composer_visible',
      'chatgpt_composer_state',
      'chatgpt_composer_pos',
      'chatgpt_composer_size',
      'chatgpt_hyper_focus'
    ], (data) => {
      const isVisible = data.chatgpt_composer_visible === true;
      const state = data.chatgpt_composer_state || 'minimized';
      
      if (state === 'maximized') {
        maximizeComposer(false);
      } else {
        minimizeComposer(false);
        if (data.chatgpt_composer_size) {
          composerContainer.style.width = `${data.chatgpt_composer_size.width}px`;
          composerContainer.style.height = `${data.chatgpt_composer_size.height}px`;
        }
        if (data.chatgpt_composer_pos) {
          composerContainer.style.left = `${data.chatgpt_composer_pos.left}px`;
          composerContainer.style.top = `${data.chatgpt_composer_pos.top}px`;
          composerContainer.style.right = 'auto';
          composerContainer.style.bottom = 'auto';
        } else {
          composerContainer.style.top = '70px';
          composerContainer.style.left = '70px';
          composerContainer.style.right = 'auto';
          composerContainer.style.bottom = 'auto';
        }
      }

      if (isVisible) {
        composerContainer.style.display = 'flex';
      }

      if (data.chatgpt_hyper_focus === true) {
        updateHyperFocusUI(true);
      }
    });
  }

  function initWidget() {
    const existing = document.getElementById('chatgpt-session-saver-container');
    if (existing) {
      existing.remove();
    }

    widgetContainer = document.createElement('div');
    widgetContainer.id = 'chatgpt-session-saver-container';
    widgetContainer.className = 'chat-saver-minimized';
    widgetContainer.style.display = 'none';

    widgetContainer.innerHTML = `
      <div class="chat-saver-header" id="chat-saver-drag-handle">
        <span class="chat-saver-title" id="chat-saver-widget-title">Suvadi</span>
        <div class="chat-saver-controls">
          <button class="chat-saver-btn suvadi-hyper-focus-toggle" id="suvadi-hyper-focus-toggle-main" title="Enter Hyper Focus">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>
          </button>
          <button class="chat-saver-btn" id="suvadi-collapse-history-toggle" title="Collapse History (Speed Boost)">
            <svg id="suvadi-collapse-history-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 11 12 6 7 11"></polyline><polyline points="17 18 12 13 7 18"></polyline></svg>
          </button>
          <button class="chat-saver-btn" id="suvadi-composer-toggle-trigger" title="Use custom message bar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
          </button>
          <button class="chat-saver-btn" id="chat-saver-toggle-size" title="Maximize/Minimize">
            <svg id="chat-saver-size-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          </button>
          <button class="chat-saver-btn" id="chat-saver-close" title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>
      
      <!-- TABS BAR FOR MINIMIZED STATE -->
      <div class="chat-saver-tabs" id="chat-saver-tabs-bar">
        <button class="chat-saver-tab-btn active" data-tab="active">Record</button>
        <button class="chat-saver-tab-btn" data-tab="history">Saved</button>
        <button class="chat-saver-tab-btn" data-tab="sync">Export</button>
      </div>
      
      <div class="chat-saver-content">
        <!-- TAB PANE: ACTIVE / RECORD -->
        <div id="chat-saver-tab-content-active" class="chat-saver-tab-pane active">
          <div id="chat-saver-active-area"></div>
        </div>

        <!-- TAB PANE: SAVED HISTORY -->
        <div id="chat-saver-tab-content-history" class="chat-saver-tab-pane">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; margin-bottom: 8px; border-bottom: 1px solid #343541; padding-bottom: 6px;">
            <div class="chat-saver-list-header" style="margin: 0; border: none; padding: 0;">Saved Chats</div>
            <button class="chat-saver-action-btn" id="chat-saver-import-btn" style="flex: none; padding: 4px 8px; font-size: 11px;">Import File</button>
            <input type="file" id="chat-saver-file-input" style="display: none;" accept=".md" />
          </div>
          <div class="chat-saver-list" id="chat-saver-list-container"></div>
        </div>

        <!-- TAB PANE: SYNC SETTINGS -->
        <div id="chat-saver-tab-content-sync" class="chat-saver-tab-pane">
          <div class="chat-saver-list-header">Export to Markdown</div>
          <div class="chat-saver-sync-box">
            <button class="chat-saver-submit-btn" id="chat-saver-sync-now-btn" style="width: 100%; margin-bottom: 8px;">Export as MD</button>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 11px; color: #acacbe; cursor: pointer; user-select: none;">
              <input type="checkbox" id="chat-saver-auto-sync-cb" style="cursor: pointer;" />
              Auto-Export on Chat
            </label>
            <div style="font-size: 9px; color: #acacbe; margin-top: 6px; line-height: 1.3;">
              Note: If Chrome's "Ask where to save" setting is enabled, Auto-Export will prompt on every message. Disable it in Chrome settings for silent background export.
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(widgetContainer);

    tabStorage.get(['chatgpt_saver_visible', 'chatgpt_active_chat'], (data) => {
      activeChat = data.chatgpt_active_chat || null;

      setupDragAndDrop(widgetContainer);
      setupControlButtons(widgetContainer);
      setupSyncSection(widgetContainer);
      setupTabs(widgetContainer);
      setupImportHandler(widgetContainer);
      initComposer();
      
      renderActiveArea();
      renderSavedChatsList();
      checkLocalSyncOnLoad();
      
      const isVisible = data.chatgpt_saver_visible === true;
      if (isVisible) {
        widgetContainer.style.display = 'flex';
        applyStoredPosition();
      }
    });
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'toggle_widget') {
      if (!widgetContainer || !document.getElementById('chatgpt-session-saver-container')) {
        initWidget();
      }
      
      if (widgetContainer.style.display === 'none') {
        widgetContainer.style.display = 'flex';
        tabStorage.set({ chatgpt_saver_visible: true });
        applyStoredPosition();
        
        tabStorage.get(['chatgpt_active_chat'], (data) => {
          activeChat = data.chatgpt_active_chat || null;
          renderActiveArea();
        });
      } else {
        widgetContainer.style.display = 'none';
        tabStorage.set({ chatgpt_saver_visible: false });
      }
    }
  });

  function startInit() {
    chrome.runtime.sendMessage({ action: 'get_tab_id' }, (response) => {
      if (response && response.tabId) {
        tabId = response.tabId;
      }
      
      tabStorage.get(['chatgpt_hyper_focus', 'chatgpt_collapse_history'], (focusData) => {
        if (focusData && focusData.chatgpt_hyper_focus === true) {
          document.body.classList.add('suvadi-hyper-focus');
        }
        if (focusData && focusData.chatgpt_collapse_history === true) {
          isCollapseHistoryEnabled = true;
          setTimeout(collapseOlderMessages, 800);
        }
        
        // Consume the global launch flag if set by clicking icon on a non-chatgpt page
        chrome.storage.local.get(['chatgpt_saver_visible'], (data) => {
          if (data.chatgpt_saver_visible === true) {
            const storeObj = {
              [`chatgpt_saver_visible_${tabId}`]: true,
              chatgpt_saver_visible: null
            };
            chrome.storage.local.set(storeObj, () => {
              initWidget();
            });
          } else {
            initWidget();
          }
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startInit);
  } else {
    startInit();
  }
})();
