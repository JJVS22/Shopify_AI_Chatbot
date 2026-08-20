/**
 * Shop AI Chat - Client-side implementation
 *
 * This module handles the chat interface for the Shopify AI Chat application.
 * It manages the UI interactions, API communication, and message rendering.
 */
(function() {
  'use strict';

  /**
   * Resolve the app backend base URL.
   * Priority: theme-editor block setting (`api_base_url`) → APP_URL from the
   * server-rendered page → the local `shopify app dev` proxy (localhost:3458).
   * In production the merchant MUST set the "App API Base URL" block setting;
   * the localhost fallback exists so the chat works out of the box in dev.
   */
  function getApiBaseUrl() {
    var configured = window.shopChatConfig && window.shopChatConfig.apiBaseUrl;
    var fallback = window.shopChatConfig && window.shopChatConfig.appUrl;
    var base = configured || fallback || 'https://localhost:3458';
    return String(base || '').replace(/\/+$/, '');
  }

  /**
   * Build an absolute URL for a backend API path (e.g. '/chat', '/auth/token-status').
   * Throws a clear error when the app API base URL is not configured.
   * @param {string} path - Path starting with '/'
   * @returns {string}
   */
  function apiUrl(path) {
    var base = getApiBaseUrl();
    if (!base) {
      throw new Error('App API base URL is not configured. Set the "App API Base URL" setting in the theme editor (AI Chat Assistant block).');
    }
    return base + (path.charAt(0) === '/' ? path : '/' + path);
  }

  var DEFAULT_WELCOME_MESSAGE =
    "Hello there! 👋 Great to see you!\n" +
    "\n" +
    "I'd love to help you out today. Just to remind you what I can do:\n" +
    "\n" +
    "- 🛍️ **Browse products & add to cart** – no login needed, just checkout at the end\n" +
    "- ✨ **Virtual try-on** – upload a photo (use the 📷 icon) and see how any product looks on you in 2D or 3D\n" +
    "- 📞 **Schedule a callback** – if you'd like to speak with a human support agent\n" +
    "\n" +
    "I've put our **newest products** above — is there anything that caught your eye? Or would you like to search for something specific — maybe a gift, a color, or a style? Just let me know and I'll point you in the right direction! 😊";

  /**
   * Welcome message shown when a new conversation starts.
   * Respects a merchant's customized block setting, but ignores older default
   * values that may still be saved in a theme that configured the block before
   * the message was updated.
   */
  function getWelcomeMessage() {
    var configured = window.shopChatConfig && window.shopChatConfig.welcomeMessage;
    var trimmed = String(configured || '').trim();
    var OLD_DEFAULTS = [
      '👋 Hi there! How can I help you today?',
      "👋 Hi! I'm your AI store assistant.",
    ];
    if (trimmed && OLD_DEFAULTS.indexOf(trimmed) === -1) {
      return trimmed;
    }
    return DEFAULT_WELCOME_MESSAGE;
  }

  /**
   * Application namespace to prevent global scope pollution
   */
  const ShopAIChat = {
    /**
     * UI-related elements and functionality
     */
    UI: {
      elements: {},
      isMobile: false,

      /**
       * Initialize UI elements and event listeners
       * @param {HTMLElement} container - The main container element
       */
      init: function(container) {
        if (!container) return;

        // Cache DOM elements
        this.elements = {
          container: container,
          chatBubble: container.querySelector('.shop-ai-chat-bubble'),
          chatWindow: container.querySelector('.shop-ai-chat-window'),
          closeButton: container.querySelector('.shop-ai-chat-close'),
          resizeButton: container.querySelector('.shop-ai-chat-resize'),
          resizeGrip: container.querySelector('.shop-ai-chat-resize-grip'),
          attachButton: container.querySelector('.shop-ai-chat-attach'),
          chatFile: container.querySelector('.shop-ai-chat-file'),
          chatInput: container.querySelector('.shop-ai-chat-input input[type="text"]'),
          sendButton: container.querySelector('.shop-ai-chat-send'),
          messagesContainer: container.querySelector('.shop-ai-chat-messages')
        };

        // Detect mobile device
        this.isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

        // Restore persisted UI state (bubble position + window size)
        this.restorePersistedUi();

        // Set up event listeners
        this.setupEventListeners();

        // Fix for iOS Safari viewport height issues
        if (this.isMobile) {
          this.setupMobileViewport();
        }
      },

      /**
       * Set up all event listeners for UI interactions
       */
      setupEventListeners: function() {
        const { closeButton, chatInput, sendButton, messagesContainer, resizeButton, attachButton, chatFile } = this.elements;

        // Bubble: drag to move (snaps left/right) OR click to toggle window
        this.enableBubbleDrag();

        // Drag-to-resize the chat window from the bottom-right grip
        this.enableResizeDrag();

        // Close chat window
        closeButton.addEventListener('click', () => this.closeChatWindow());

        // Toggle chat window size (enlarge / shrink)
        if (resizeButton) {
          resizeButton.addEventListener('click', () => this.toggleResize());
        }

        // Upload an image for try-on (works even without a product selected)
        if (attachButton && chatFile) {
          attachButton.addEventListener('click', () => chatFile.click());
          chatFile.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
              this.handleAttachUpload(e.target.files[0]);
            }
            chatFile.value = '';
          });
        }

        // Send message when pressing Enter in input
        chatInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter' && chatInput.value.trim() !== '') {
            ShopAIChat.Message.send(chatInput, messagesContainer);

            // On mobile, handle keyboard
            if (this.isMobile) {
              chatInput.blur();
              setTimeout(() => chatInput.focus(), 300);
            }
          }
        });

        // Send message when clicking send button
        sendButton.addEventListener('click', () => {
          if (chatInput.value.trim() !== '') {
            ShopAIChat.Message.send(chatInput, messagesContainer);

            // On mobile, focus input after sending
            if (this.isMobile) {
              setTimeout(() => chatInput.focus(), 300);
            }
          }
        });

        // Handle window resize to adjust scrolling
        window.addEventListener('resize', () => this.scrollToBottom());
        window.addEventListener('resize', () => this.updateWindowDirection());

        // Add global click handler for auth links
        document.addEventListener('click', function(event) {
          if (event.target && event.target.classList.contains('shop-auth-trigger')) {
            event.preventDefault();
            if (window.shopAuthUrl) {
              ShopAIChat.Auth.openAuthPopup(window.shopAuthUrl);
            }
          }
        });
      },

      /**
       * Setup mobile-specific viewport adjustments
       */
      setupMobileViewport: function() {
        const setViewportHeight = () => {
          document.documentElement.style.setProperty('--viewport-height', `${window.innerHeight}px`);
        };
        window.addEventListener('resize', setViewportHeight);
        setViewportHeight();
      },

      /**
       * Restore persisted UI state (bubble position + window size) from sessionStorage.
       */
      restorePersistedUi: function() {
        const chatWindow = this.elements.chatWindow;

        // Window size
        if (sessionStorage.getItem('shopAiWindowLarge') === '1') {
          chatWindow.classList.add('large');
        }

        // Bubble position
        try {
          const pos = JSON.parse(sessionStorage.getItem('shopAiBubblePos'));
          if (pos && typeof pos === 'object') {
            this.applyBubblePosition(pos);
          }
        } catch (e) {
          // ignore corrupt state
        }

        this.updateWindowDirection();
      },

      /**
       * Enable dragging the bubble. On release it snaps to the nearest
       * left/right edge; a simple click (no movement) toggles the window.
       */
      enableBubbleDrag: function() {
        const bubble = this.elements.chatBubble;
        const container = this.elements.container;
        if (!bubble || !container) return;

        let startX = null, startY = null, dragging = false, rafId = null;

        bubble.addEventListener('pointerdown', (e) => {
          startX = e.clientX;
          startY = e.clientY;
          dragging = false;
          try { bubble.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        });

        bubble.addEventListener('pointermove', (e) => {
          if (startX === null) return;
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          if (!dragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
            dragging = true;
            container.classList.add('shop-ai-bubble-dragging');
          }
          if (dragging) {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => this.moveBubbleTo(e.clientX, e.clientY));
          }
        });

        const endDrag = (e) => {
          if (startX === null) return;
          try { bubble.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          if (dragging) {
            this.snapBubble();
          } else {
            this.toggleChatWindow();
          }
          startX = null;
          startY = null;
          dragging = false;
          container.classList.remove('shop-ai-bubble-dragging');
        };

        bubble.addEventListener('pointerup', endDrag);
        bubble.addEventListener('pointercancel', endDrag);
      },

      /**
       * Drag any of the four corner grips to resize the chat window. The corner
       * under the grip follows the mouse; the opposite corner stays anchored.
       * The size is persisted in sessionStorage and clamped to bounds.
       */
      enableResizeDrag: function() {
        const chatWindow = this.elements.chatWindow;
        const container = this.elements.container;
        if (!chatWindow || !container) return;

        // On small screens the window is fullscreen (position: fixed), so
        // corner-grip resizing doesn't apply — skip attaching the handlers.
        if (this.isMobile || window.innerWidth <= 480) return;

        const grips = chatWindow.querySelectorAll('.shop-ai-chat-resize-grip');
        if (grips.length === 0) return;

        const MIN_W = 300;
        const MIN_H = 300;
        const MAX_W = Math.max(320, window.innerWidth - 40);
        const MAX_H = Math.max(360, window.innerHeight - 80);

        // Restore persisted size.
        try {
          const saved = JSON.parse(sessionStorage.getItem('shopAiWindowSize') || 'null');
          if (saved && saved.width && saved.height) {
            chatWindow.style.width = Math.min(Math.max(saved.width, MIN_W), MAX_W) + 'px';
            chatWindow.style.height = Math.min(Math.max(saved.height, MIN_H), MAX_H) + 'px';
            chatWindow.style.maxWidth = 'none';
            chatWindow.style.maxHeight = 'none';
          }
        } catch (err) { /* ignore malformed stored size */ }

        const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
        const self = this;

        // Opposite corner names for the anchor.
        const ANCHOR = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };

        function attachGrip(grip, corner) {
          let startX = null;
          let anchor = null; // opposite (fixed) corner in container coordinates

          grip.addEventListener('pointerdown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            const crect = container.getBoundingClientRect();
            const wrect = chatWindow.getBoundingClientRect();
            const a = ANCHOR[corner];
            if (a === 'br') anchor = { x: wrect.right - crect.left, y: wrect.bottom - crect.top };
            else if (a === 'bl') anchor = { x: wrect.left - crect.left, y: wrect.bottom - crect.top };
            else if (a === 'tr') anchor = { x: wrect.right - crect.left, y: wrect.top - crect.top };
            else anchor = { x: wrect.left - crect.left, y: wrect.top - crect.top };
            startX = e.clientX;
            chatWindow.classList.add('resizing');
            try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          });

          grip.addEventListener('pointermove', function(e) {
            if (startX === null) return;
            const crect = container.getBoundingClientRect();
            const mouseX = e.clientX - crect.left;
            const mouseY = e.clientY - crect.top;

            let width, left;
            if (corner === 'tr' || corner === 'br') {
              width = clamp(mouseX - anchor.x, MIN_W, MAX_W);
              left = anchor.x;
            } else {
              width = clamp(anchor.x - mouseX, MIN_W, MAX_W);
              left = anchor.x - width;
            }

            let height, top;
            if (corner === 'tl' || corner === 'tr') {
              height = clamp(anchor.y - mouseY, MIN_H, MAX_H);
              top = anchor.y - height;
            } else {
              height = clamp(mouseY - anchor.y, MIN_H, MAX_H);
              top = anchor.y;
            }

            // Keep the window on-screen: the dragged top/left edge can never go
            // past the viewport. The window coordinates here are relative to
            // the container (which floats above/left of the bubble), so the
            // viewport thresholds must be converted into container space.
            const minLeft = 10 - crect.left;
            const minTop = 10 - crect.top;
            if ((corner === 'tl' || corner === 'tr') && top < minTop) {
              top = minTop;
              height = Math.max(MIN_H, anchor.y - top);
            }
            if ((corner === 'tl' || corner === 'bl') && left < minLeft) {
              left = minLeft;
              width = Math.max(MIN_W, anchor.x - left);
            }

            chatWindow.style.left = left + 'px';
            chatWindow.style.top = top + 'px';
            chatWindow.style.width = width + 'px';
            chatWindow.style.height = height + 'px';
            chatWindow.style.right = 'auto';
            chatWindow.style.bottom = 'auto';
            chatWindow.style.maxWidth = 'none';
            chatWindow.style.maxHeight = 'none';
            self.scrollToBottom();
          });

          const endResize = function() {
            if (startX === null) return;
            try { grip.releasePointerCapture(); } catch (err) { /* ignore */ }
            chatWindow.classList.remove('resizing');
            try {
              sessionStorage.setItem('shopAiWindowSize', JSON.stringify({
                width: chatWindow.offsetWidth,
                height: chatWindow.offsetHeight,
              }));
            } catch (err) { /* ignore */ }
            // Keep the window where the user dragged it (don't reset position).
            startX = null;
            anchor = null;
          };

          grip.addEventListener('pointerup', endResize);
          grip.addEventListener('pointercancel', endResize);
        }

        grips.forEach(function(g) {
          const cls = ['grip-tl', 'grip-tr', 'grip-bl', 'grip-br'].find(function(c) { return g.classList.contains(c); });
          // Normalize the grip's class ("grip-tl") to the short corner name
          // ("tl") used by ANCHOR and the resize branches below.
          const corner = cls ? cls.replace('grip-', '') : 'tr';
          attachGrip(g, corner);
        });
      },

      /**
       * Handle an image chosen via the upload icon next to the send button.
       * The image is STAGED (not sent to the chat yet) and shown as a small
       * pending thumbnail near the input. It is uploaded and sent together with
       * the message only when the customer presses the send button (or when they
       * tap "Try On" on a product card).
       * @param {File} file
       */
      handleAttachUpload: function(file) {
        if (!file || !file.type.startsWith('image/')) {
          alert('Please upload an image file.');
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          alert('Photo is too large. Please use an image under 10MB.');
          return;
        }

        const tryonState = ShopAIChat.TryOn.state;
        tryonState.stagedFile = file;

        const reader = new FileReader();
        reader.onload = function(e) {
          tryonState.stagedPreview = e.target.result;
          ShopAIChat.UI.renderStagedImage();
        };
        reader.readAsDataURL(file);
      },

      /**
       * Render (or update) the pending uploaded-image chip shown next to the
       * chat input. The image stays here until the message is sent.
       */
      renderStagedImage: function() {
        const { chatInput, chatWindow } = this.elements;
        if (!chatInput) return;

        let chip = chatWindow.querySelector('.shop-ai-staged-image');
        const preview = ShopAIChat.TryOn.state.stagedPreview;

        if (!preview) {
          if (chip) chip.remove();
          return;
        }

        if (!chip) {
          chip = document.createElement('div');
          chip.className = 'shop-ai-staged-image';
          chatWindow.appendChild(chip);
        }

        chip.innerHTML = '';
        const img = document.createElement('img');
        img.src = preview;
        img.alt = 'Photo to send';
        chip.appendChild(img);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'shop-ai-staged-remove';
        remove.textContent = '✕';
        remove.setAttribute('aria-label', 'Remove photo');
        remove.addEventListener('click', function() {
          ShopAIChat.TryOn.state.stagedFile = null;
          ShopAIChat.TryOn.state.stagedPreview = null;
          chip.remove();
        });
        chip.appendChild(remove);
      },

      /**
       * Clear the staged image chip (called after the photo is sent).
       */
      clearStagedImage: function() {
        const chip = this.elements.chatWindow && this.elements.chatWindow.querySelector('.shop-ai-staged-image');
        if (chip) chip.remove();
        ShopAIChat.TryOn.state.stagedFile = null;
        ShopAIChat.TryOn.state.stagedPreview = null;
      },

      /**
       * Position the container so the bubble follows the pointer.
       */
      moveBubbleTo: function(clientX, clientY) {
        const container = this.elements.container;
        const bubbleSize = this.elements.chatBubble.offsetWidth || 60;
        const margin = 20;
        const left = Math.max(margin, Math.min(clientX - bubbleSize / 2, window.innerWidth - bubbleSize - margin));
        const bottom = Math.max(margin, Math.min(window.innerHeight - clientY - bubbleSize / 2, window.innerHeight - bubbleSize - margin));

        container.style.left = left + 'px';
        container.style.right = 'auto';
        container.style.bottom = bottom + 'px';
        container.classList.remove('side-left', 'side-right');

        this.updateWindowDirection();
      },

      /**
       * Snap the bubble to the nearest edge (left or right) and persist position.
       */
      snapBubble: function() {
        const container = this.elements.container;
        const rect = container.getBoundingClientRect();
        const margin = 20;
        const centerX = rect.left + rect.width / 2;
        const side = centerX < window.innerWidth / 2 ? 'left' : 'right';
        const bottom = Math.max(margin, window.innerHeight - rect.bottom);

        container.style.left = '';
        container.style.right = '';
        if (side === 'left') {
          container.style.left = margin + 'px';
        } else {
          container.style.right = margin + 'px';
        }
        container.style.bottom = bottom + 'px';
        container.classList.remove('side-left', 'side-right');
        container.classList.add('side-' + side);

        // Re-anchor the chat window to the correct side of the bubble (the CSS
        // uses .side-left/.side-right). Clear any inline position left over from
        // a previous resize, keeping the resized width/height.
        const w = this.elements.chatWindow;
        if (w) {
          w.style.left = '';
          w.style.top = '';
          w.style.right = '';
          w.style.bottom = '';
          const wrect = w.getBoundingClientRect();
          if (wrect.top < 10) {
            w.style.height = Math.max(220, w.offsetHeight - (10 - wrect.top)) + 'px';
            w.style.maxHeight = 'none';
          }
        }

        sessionStorage.setItem('shopAiBubblePos', JSON.stringify({ side, bottom }));
        this.updateWindowDirection();
      },

      /**
       * Decide whether the chat window should open upward (default) or,
       * when the bubble sits near the top of the viewport, downward so it
       * stays on screen. Prefers whichever side has enough room for the window.
       */
      updateWindowDirection: function() {
        const container = this.elements.container;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const gap = 20;
        const spaceAbove = rect.top - gap;
        const spaceBelow = window.innerHeight - rect.bottom - gap;
        const need = Math.min(window.innerHeight * 0.7, 650);

        let openDown;
        if (spaceBelow >= need) {
          openDown = true;       // plenty of room below → open downward
        } else if (spaceAbove >= need) {
          openDown = false;      // plenty of room above → open upward
        } else {
          openDown = spaceBelow >= spaceAbove; // open on the bigger side
        }

        if (openDown) {
          container.classList.add('open-down');
          const avail = Math.max(220, Math.min(spaceBelow, 650));
          container.style.setProperty('--chat-avail', avail + 'px');
        } else {
          container.classList.remove('open-down');
          container.style.removeProperty('--chat-avail');
        }
      },

      /**
       * Apply a persisted bubble position {side, bottom}.
       */
      applyBubblePosition: function(pos) {
        const container = this.elements.container;
        const margin = 20;
        const bottom = Number.isFinite(pos.bottom) ? pos.bottom : margin;

        container.style.bottom = bottom + 'px';
        if (pos.side === 'left') {
          container.style.left = margin + 'px';
          container.style.right = '';
          container.classList.add('side-left');
        } else {
          container.style.right = margin + 'px';
          container.style.left = '';
          container.classList.add('side-right');
        }
      },

      /**
       * Toggle the chat window between default and large size.
       */
      toggleResize: function() {
        const chatWindow = this.elements.chatWindow;
        if (!chatWindow) return;
        const large = chatWindow.classList.toggle('large');
        sessionStorage.setItem('shopAiWindowLarge', large ? '1' : '0');
        this.scrollToBottom();
      },

      /**
       * Toggle chat window visibility
       */
      toggleChatWindow: function() {
        const { chatWindow, chatInput } = this.elements;

        chatWindow.classList.toggle('active');

        if (chatWindow.classList.contains('active')) {
          // On mobile, prevent body scrolling and delay focus
          if (this.isMobile) {
            document.body.classList.add('shop-ai-chat-open');
            setTimeout(() => chatInput.focus(), 500);
          } else {
            chatInput.focus();
          }
          // Always scroll messages to bottom when opening
          this.scrollToBottom();
        } else {
          // Remove body class when closing
          document.body.classList.remove('shop-ai-chat-open');
        }
      },

      /**
       * Close chat window
       */
      closeChatWindow: function() {
        const { chatWindow, chatInput } = this.elements;

        chatWindow.classList.remove('active');

        // On mobile, blur input to hide keyboard and enable body scrolling
        if (this.isMobile) {
          chatInput.blur();
          document.body.classList.remove('shop-ai-chat-open');
        }
      },

      /**
       * Scroll messages container to bottom
       */
      scrollToBottom: function() {
        const { messagesContainer } = this.elements;
        setTimeout(() => {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }, 100);
      },

      /**
       * Show typing indicator in the chat
       */
      showTypingIndicator: function() {
        const { messagesContainer } = this.elements;

        const typingIndicator = document.createElement('div');
        typingIndicator.classList.add('shop-ai-typing-indicator');
        typingIndicator.innerHTML = '<span></span><span></span><span></span>';
        messagesContainer.appendChild(typingIndicator);
        this.scrollToBottom();
      },

      /**
       * Remove typing indicator from the chat
       */
      removeTypingIndicator: function() {
        const { messagesContainer } = this.elements;

        const typingIndicator = messagesContainer.querySelector('.shop-ai-typing-indicator');
        if (typingIndicator) {
          typingIndicator.remove();
        }
      },

      /**
       * Display product results in the chat
       * @param {Array} products - Array of product data objects
       * @param {string} [headerText] - Optional header text for the product section
       */
      displayProductResults: function(products, headerText) {
        const { messagesContainer } = this.elements;

        // Create a wrapper for the product section
        const productSection = document.createElement('div');
        productSection.classList.add('shop-ai-product-section');
        messagesContainer.appendChild(productSection);

        // Add a header for the product results
        const header = document.createElement('div');
        header.classList.add('shop-ai-product-header');
        header.innerHTML = '<h4>' + (headerText || 'Top Matching Products') + '</h4>';
        productSection.appendChild(header);

        // Create the product grid container
        const productsContainer = document.createElement('div');
        productsContainer.classList.add('shop-ai-product-grid');
        productSection.appendChild(productsContainer);

        if (!products || !Array.isArray(products) || products.length === 0) {
          const noProductsMessage = document.createElement('p');
          noProductsMessage.textContent = "No products found";
          noProductsMessage.style.padding = "10px";
          productsContainer.appendChild(noProductsMessage);
        } else {
          products.forEach(product => {
            const productCard = ShopAIChat.Product.createCard(product);
            productsContainer.appendChild(productCard);
          });
        }

        this.scrollToBottom();
      },

      /**
       * Show a "Log in" card when customer authentication is required.
       * @param {string} authUrl
       * @param {HTMLElement} messagesContainer
       */
      displayAuthRequired: function(authUrl, messagesContainer) {
        var card = document.createElement('div');
        card.classList.add('shop-ai-auth-card');

        var text = document.createElement('p');
        text.textContent = 'This action requires you to log in to your customer account.';
        card.appendChild(text);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'shop-ai-login-btn';
        btn.textContent = 'Log in to continue';
        btn.addEventListener('click', function() {
          ShopAIChat.Auth.openAuthPopup(authUrl);
          var conversationId = sessionStorage.getItem('shopAiConversationId');
          if (conversationId) {
            ShopAIChat.Auth.startTokenPolling(conversationId, messagesContainer);
          }
        });
        card.appendChild(btn);

        messagesContainer.appendChild(card);
        this.scrollToBottom();
      },

      /**
       * Show a cart-update message with a checkout link (no buttons).
       * @param {Object} data - { message, checkout_url }
       * @param {HTMLElement} messagesContainer
       */
      displayCartUpdated: function(data, messagesContainer) {
        var el = document.createElement('div');
        el.classList.add('shop-ai-message', 'assistant');

        var txt = document.createTextNode((data.message || 'Your cart has been updated.') + ' — ');
        el.appendChild(txt);

        var a = document.createElement('a');
        a.href = data.checkout_url || '/cart';
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Proceed to checkout';
        el.appendChild(a);

        messagesContainer.appendChild(el);
        this.scrollToBottom();
      },

      /**
       * Show a callback booking form (fixed questions) so the customer does
       * not have to type answers.
       * @param {string} intro - Optional intro message
       * @param {HTMLElement} messagesContainer
       */
      displayCallbackForm: function(intro, messagesContainer) {
        var self = this;
        var card = document.createElement('div');
        card.classList.add('shop-ai-callback-form');

        if (intro) {
          var introP = document.createElement('p');
          introP.classList.add('shop-ai-callback-intro');
          introP.textContent = intro;
          card.appendChild(introP);
        }

        function field(labelText, type, id, placeholder, required) {
          var wrap = document.createElement('label');
          wrap.classList.add('shop-ai-callback-field');

          var label = document.createElement('span');
          label.textContent = labelText;
          wrap.appendChild(label);

          var input = document.createElement('input');
          input.type = type;
          input.id = id;
          input.placeholder = placeholder || '';
          if (required) input.required = true;
          wrap.appendChild(input);
          card.appendChild(wrap);
          return input;
        }

        field('Full name', 'text', 'shop-cb-name', 'e.g. Jane Doe', true);
        field('Email', 'email', 'shop-cb-email', 'e.g. jane@example.com', false);
        field('Phone', 'tel', 'shop-cb-phone', 'e.g. +1 555 000 1234', true);
        field('Preferred date (DD/MM/YYYY)', 'text', 'shop-cb-date', 'e.g. 24/12/2026', true);
        field('Preferred time', 'time', 'shop-cb-time', '', true);
        field('Reason (optional)', 'text', 'shop-cb-reason', 'e.g. Question about an order', false);

        var submit = document.createElement('button');
        submit.type = 'button';
        submit.className = 'shop-ai-callback-submit';
        submit.textContent = 'Request Callback';
        card.appendChild(submit);

        var status = document.createElement('p');
        status.classList.add('shop-ai-callback-status');
        status.style.display = 'none';
        card.appendChild(status);

        /**
         * Parse a DD/MM/YYYY string into { day, month, year } after validating
         * that it is a real calendar date (rejects 31/02, 00/13, etc.).
         * @param {string} value
         * @returns {{day:number, month:number, year:number}|null}
         */
        function parseDDMMYYYY(value) {
          var match = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (!match) return null;
          var day = parseInt(match[1], 10);
          var month = parseInt(match[2], 10);
          var year = parseInt(match[3], 10);
          if (month < 1 || month > 12 || day < 1 || day > 31) return null;
          var daysInMonth = new Date(year, month, 0).getDate();
          if (day > daysInMonth) return null;
          return { day: day, month: month, year: year };
        }

        function pad2(n) {
          return (n < 10 ? '0' : '') + n;
        }

        submit.addEventListener('click', function() {
          var name = document.getElementById('shop-cb-name').value.trim();
          var phone = document.getElementById('shop-cb-phone').value.trim();
          var dateValue = document.getElementById('shop-cb-date').value.trim();
          var timeValue = document.getElementById('shop-cb-time').value.trim();

          if (!name || !phone) {
            status.textContent = 'Please fill in your name and phone number.';
            status.style.display = 'block';
            return;
          }

          var parsedDate = parseDDMMYYYY(dateValue);
          if (!parsedDate) {
            status.textContent = 'Please enter the date as DD/MM/YYYY (e.g. 24/12/2026).';
            status.style.display = 'block';
            return;
          }

          if (!timeValue) {
            status.textContent = 'Please choose a preferred time.';
            status.style.display = 'block';
            return;
          }

          var timeParts = timeValue.split(':');
          var hour = parseInt(timeParts[0], 10);
          var minute = parseInt(timeParts[1], 10);
          if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            status.textContent = 'Please choose a valid time (HH:MM).';
            status.style.display = 'block';
            return;
          }

          var isoDateTime = parsedDate.year + '-' + pad2(parsedDate.month) + '-' + pad2(parsedDate.day) +
            'T' + pad2(hour) + ':' + pad2(minute);

          submit.disabled = true;
          submit.textContent = 'Scheduling...';

          var payload = {
            name: name,
            email: document.getElementById('shop-cb-email').value.trim(),
            phone: phone,
            call_time: isoDateTime,
            reason: document.getElementById('shop-cb-reason').value.trim()
          };
          var conversationId = sessionStorage.getItem('shopAiConversationId');
          if (conversationId) payload.conversation_id = conversationId;

          var callbackUrl;
          try {
            callbackUrl = apiUrl('/api/tryon/callback');
          } catch (err) {
            console.error('Callback scheduling failed:', err);
            submit.disabled = false;
            submit.textContent = 'Request Callback';
            status.textContent = 'The chat is not configured. Set the "App API Base URL" in the theme editor.';
            status.style.display = 'block';
            return;
          }

          fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
            .then(function(res) { return res.json(); })
            .then(function(data) {
              if (!data.ok) throw new Error(data.error || 'Failed to schedule callback');
              card.innerHTML = '';
              var ok = document.createElement('p');
              ok.classList.add('shop-ai-callback-status');
              ok.textContent = data.message || 'Callback scheduled. A support agent will contact you.';
              card.appendChild(ok);
              self.scrollToBottom();
            })
            .catch(function(err) {
              console.error('Callback scheduling failed:', err);
              submit.disabled = false;
              submit.textContent = 'Request Callback';
              status.textContent = 'Sorry, scheduling failed. Please try again.';
              status.style.display = 'block';
            });
        });

        messagesContainer.appendChild(card);
        this.scrollToBottom();
      }
    },

    /**
     * Message handling and display functionality
     */
    Message: {
      /**
       * Send a message to the API
       * @param {HTMLInputElement} chatInput - The input element
       * @param {HTMLElement} messagesContainer - The messages container
       */
      send: async function(chatInput, messagesContainer) {
        const userMessage = chatInput.value.trim();
        const conversationId = sessionStorage.getItem('shopAiConversationId');

        const staged = ShopAIChat.TryOn.state.stagedFile;
        const stagedPreview = ShopAIChat.TryOn.state.stagedPreview;

        // Upload the staged image first so it can be attached to the message.
        let imageUrl = null;
        if (staged) {
          try {
            const formData = new FormData();
            formData.append('image', staged);
            if (conversationId) formData.append('conversation_id', conversationId);
            const res = await fetch(apiUrl('/api/upload'), {
              method: 'POST',
              body: formData
            });
            const data = await res.json();
            if (data && data.ok && data.url) {
              imageUrl = data.url;
            } else {
              throw new Error((data && data.error) || 'Upload failed');
            }
          } catch (err) {
            console.error('Image upload failed:', err);
            this.add('Sorry, I couldn\'t upload your photo. Please try again.', 'assistant', messagesContainer);
            return;
          }
        }

        // When a photo is attached but no text was typed, give the LLM context.
        const effectiveMessage = userMessage || (imageUrl ? 'I uploaded a photo for try-on.' : '');

        // Add the user's turn to the chat: image first, then the typed text.
        if (imageUrl && stagedPreview) {
          const bubble = document.createElement('div');
          bubble.className = 'shop-ai-message user shop-ai-user-with-image';
          const img = document.createElement('img');
          img.className = 'shop-ai-user-image';
          img.src = stagedPreview;
          img.alt = 'Uploaded photo';
          bubble.appendChild(img);
          if (effectiveMessage) {
            const text = document.createElement('p');
            text.textContent = effectiveMessage;
            bubble.appendChild(text);
          }
          messagesContainer.appendChild(bubble);
          ShopAIChat.UI.scrollToBottom();
        } else {
          this.add(effectiveMessage, 'user', messagesContainer);
        }

        // Clear the staged image (it has been consumed by this message).
        ShopAIChat.UI.clearStagedImage();

        // Clear input
        chatInput.value = '';

        // Show typing indicator
        ShopAIChat.UI.showTypingIndicator();

        try {
          ShopAIChat.API.streamResponse(effectiveMessage, conversationId, messagesContainer, imageUrl);
        } catch (error) {
          console.error('Error communicating with AI API:', error);
          ShopAIChat.UI.removeTypingIndicator();
          this.add("Sorry, I couldn't process your request at the moment. Please try again later.", 'assistant', messagesContainer);
        }
      },

      /**
       * Add a message to the chat
       * @param {string} text - Message content
       * @param {string} sender - Message sender ('user' or 'assistant')
       * @param {HTMLElement} messagesContainer - The messages container
       * @returns {HTMLElement} The created message element
       */
      add: function(text, sender, messagesContainer) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('shop-ai-message', sender);

        if (sender === 'assistant') {
          messageElement.dataset.rawText = text;
          ShopAIChat.Formatting.formatMessageContent(messageElement);
        } else {
          messageElement.textContent = text;
        }

        messagesContainer.appendChild(messageElement);
        ShopAIChat.UI.scrollToBottom();

        return messageElement;
      },

      /**
       * Add a tool use message to the chat with expandable arguments
       * @param {string} toolMessage - Tool use message content
       * @param {HTMLElement} messagesContainer - The messages container
       */
      addToolUse: function(toolMessage, messagesContainer) {
        // Parse the tool message to extract tool name and arguments
        const match = toolMessage.match(/Calling tool: (\w+) with arguments: (.+)/);
        if (!match) {
          // Fallback for unexpected format
          const toolUseElement = document.createElement('div');
          toolUseElement.classList.add('shop-ai-message', 'tool-use');
          toolUseElement.textContent = toolMessage;
          messagesContainer.appendChild(toolUseElement);
          ShopAIChat.UI.scrollToBottom();
          return;
        }

        const toolName = match[1];
        const argsString = match[2];

        // Create the main tool use element
        const toolUseElement = document.createElement('div');
        toolUseElement.classList.add('shop-ai-message', 'tool-use');

        // Create the header (always visible)
        const headerElement = document.createElement('div');
        headerElement.classList.add('shop-ai-tool-header');

        const toolText = document.createElement('span');
        toolText.classList.add('shop-ai-tool-text');
        toolText.textContent = `Calling tool: ${toolName}`;

        const toggleElement = document.createElement('span');
        toggleElement.classList.add('shop-ai-tool-toggle');
        toggleElement.textContent = '[+]';

        headerElement.appendChild(toolText);
        headerElement.appendChild(toggleElement);

        // Create the arguments section (initially hidden)
        const argsElement = document.createElement('div');
        argsElement.classList.add('shop-ai-tool-args');

        try {
          // Try to format JSON arguments nicely
          const parsedArgs = JSON.parse(argsString);
          argsElement.textContent = JSON.stringify(parsedArgs, null, 2);
        } catch (e) {
          // If not valid JSON, just show as-is
          argsElement.textContent = argsString;
        }

        // Add click handler to toggle arguments visibility
        headerElement.addEventListener('click', function() {
          const isExpanded = argsElement.classList.contains('expanded');
          if (isExpanded) {
            argsElement.classList.remove('expanded');
            toggleElement.textContent = '[+]';
          } else {
            argsElement.classList.add('expanded');
            toggleElement.textContent = '[-]';
          }
        });

        // Assemble the complete element
        toolUseElement.appendChild(headerElement);
        toolUseElement.appendChild(argsElement);

        messagesContainer.appendChild(toolUseElement);
        ShopAIChat.UI.scrollToBottom();
      }
    },

    /**
     * Text formatting and markdown handling
     */
    Formatting: {
      /**
       * Format message content with markdown and links
       * @param {HTMLElement} element - The element to format
       */
      formatMessageContent: function(element) {
        if (!element || !element.dataset.rawText) return;

        const rawText = element.dataset.rawText;

        // Process the text with various Markdown features
        let processedText = rawText;

        // Process Markdown links
        const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
        processedText = processedText.replace(markdownLinkRegex, (match, text, url) => {
          // Check if it's an auth URL
          if (url.includes('shopify.com/authentication') &&
             (url.includes('oauth/authorize') || url.includes('authentication'))) {
            // Store the auth URL in a global variable for later use - this avoids issues with onclick handlers
            window.shopAuthUrl = url;
            // Just return normal link that will be handled by the document click handler
            return '<a href="#auth" class="shop-auth-trigger">' + text + '</a>';
          }
          // If it's a checkout link, replace the text
          else if (url.includes('/cart') || url.includes('checkout')) {
            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">click here to proceed to checkout</a>';
          } else {
            // For normal links, preserve the original text
            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
          }
        });

        // Convert text to HTML with proper list handling
        processedText = this.convertMarkdownToHtml(processedText);

        // Apply the formatted HTML
        element.innerHTML = processedText;
      },

      /**
       * Convert Markdown text to HTML with list support
       * @param {string} text - Markdown text to convert
       * @returns {string} HTML content
       */
      convertMarkdownToHtml: function(text) {
        text = text.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>');
        const lines = text.split('\n');
        let currentList = null;
        let listItems = [];
        let htmlContent = '';
        let startNumber = 1;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const unorderedMatch = line.match(/^\s*([-*])\s+(.*)/);
          const orderedMatch = line.match(/^\s*(\d+)[\.)]\s+(.*)/);

          if (unorderedMatch) {
            if (currentList !== 'ul') {
              if (currentList === 'ol') {
                htmlContent += `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
                listItems = [];
              }
              currentList = 'ul';
            }
            listItems.push('<li>' + unorderedMatch[2] + '</li>');
          } else if (orderedMatch) {
            if (currentList !== 'ol') {
              if (currentList === 'ul') {
                htmlContent += '<ul>' + listItems.join('') + '</ul>';
                listItems = [];
              }
              currentList = 'ol';
              startNumber = parseInt(orderedMatch[1], 10);
            }
            listItems.push('<li>' + orderedMatch[2] + '</li>');
          } else {
            if (currentList) {
              htmlContent += currentList === 'ul'
                ? '<ul>' + listItems.join('') + '</ul>'
                : `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
              listItems = [];
              currentList = null;
            }

            if (line.trim() === '') {
              htmlContent += '<br>';
            } else {
              htmlContent += '<p>' + line + '</p>';
            }
          }
        }

        if (currentList) {
          htmlContent += currentList === 'ul'
            ? '<ul>' + listItems.join('') + '</ul>'
            : `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
        }

        htmlContent = htmlContent.replace(/<\/p><p>/g, '</p>\n<p>');
        return htmlContent;
      }
    },

    /**
     * API communication and data handling
     */
    API: {
      /**
       * Stream a response from the API
       * @param {string} userMessage - User's message text
       * @param {string} conversationId - Conversation ID for context
       * @param {HTMLElement} messagesContainer - The messages container
       * @param {string|null} [imageUrl] - URL of an uploaded photo attached to this message
       */
      streamResponse: async function(userMessage, conversationId, messagesContainer, imageUrl) {
        // Per-turn state: messageElement is created lazily on the first text
        // chunk (so the loading line appears first); loadingLine is a single
        // reused line for all tool-use messages (condensed to one line).
        const state = { messageElement: null, loadingLine: null };

        try {
          const promptType = window.shopChatConfig?.promptType || "standardAssistant";
          const requestBody = JSON.stringify({
            message: userMessage,
            conversation_id: conversationId,
            prompt_type: promptType,
            image_url: imageUrl || null
          });

          const streamUrl = apiUrl('/chat');
          const shopId = window.shopId;

          const response = await fetch(streamUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'X-Shopify-Shop-Id': shopId
            },
            body: requestBody
          });

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          // Process the stream
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  this.handleStreamEvent(data, state, messagesContainer, userMessage);
                } catch (e) {
                  console.error('Error parsing event data:', e, line);
                }
              }
            }
          }
        } catch (error) {
          console.error('Error in streaming:', error);
          ShopAIChat.UI.removeTypingIndicator();
          ShopAIChat.Message.add("Sorry, I couldn't process your request. Please try again later.",
            'assistant', messagesContainer);
        }
      },

      /**
       * Handle stream events from the API
       * @param {Object} data - Event data
       * @param {{messageElement: HTMLElement|null, loadingLine: HTMLElement|null}} state - Per-turn DOM state
       * @param {HTMLElement} messagesContainer - The messages container
       * @param {string} userMessage - The original user message
       */
      handleStreamEvent: function(data, state, messagesContainer, userMessage) {
        switch (data.type) {
          case 'id':
            if (data.conversation_id) {
              sessionStorage.setItem('shopAiConversationId', data.conversation_id);
            }
            break;

          case 'chunk':
            ShopAIChat.UI.removeTypingIndicator();
            // Create the assistant text bubble lazily on the first chunk so the
            // loading line (rendered earlier) stays above the text response.
            if (!state.messageElement) {
              state.messageElement = document.createElement('div');
              state.messageElement.classList.add('shop-ai-message', 'assistant');
              state.messageElement.textContent = '';
              state.messageElement.dataset.rawText = '';
              messagesContainer.appendChild(state.messageElement);
            }
            state.messageElement.dataset.rawText += data.chunk;
            state.messageElement.textContent = state.messageElement.dataset.rawText;
            ShopAIChat.UI.scrollToBottom();
            break;

          case 'message_complete':
            ShopAIChat.UI.removeTypingIndicator();
            if (state.messageElement) {
              ShopAIChat.Formatting.formatMessageContent(state.messageElement);
            }
            // The answer is in — remove the single loading line.
            if (state.loadingLine && state.loadingLine.parentNode) {
              state.loadingLine.parentNode.removeChild(state.loadingLine);
            }
            state.loadingLine = null;
            ShopAIChat.UI.scrollToBottom();
            break;

          case 'end_turn':
            ShopAIChat.UI.removeTypingIndicator();
            break;

          case 'error':
            console.error('Stream error:', data.error);
            ShopAIChat.UI.removeTypingIndicator();
            if (state.messageElement) {
              state.messageElement.textContent = "Sorry, I couldn't process your request. Please try again later.";
            } else {
              ShopAIChat.Message.add("Sorry, I couldn't process your request. Please try again later.", 'assistant', messagesContainer);
            }
            break;

          case 'rate_limit_exceeded':
            console.error('Rate limit exceeded:', data.error);
            ShopAIChat.UI.removeTypingIndicator();
            if (state.messageElement) {
              state.messageElement.textContent = "Sorry, our servers are currently busy. Please try again later.";
            } else {
              ShopAIChat.Message.add("Sorry, our servers are currently busy. Please try again later.", 'assistant', messagesContainer);
            }
            break;

          case 'auth_required':
            // Save the last user message for resuming after authentication
            sessionStorage.setItem('shopAiLastMessage', userMessage || '');

            // Show a "Log in" button/link so the customer can authorize directly.
            if (data.auth_url) {
              ShopAIChat.UI.displayAuthRequired(data.auth_url, messagesContainer);
            }
            break;

          case 'cart_updated':
            ShopAIChat.UI.displayCartUpdated(data, messagesContainer);
            break;

          case 'product_results':
            ShopAIChat.UI.displayProductResults(data.products, data.header);
            break;

          case 'tryon_2d_result':
            if (data.image_url) {
              ShopAIChat.TryOn.displayResult(data.image_url, data.product_title, true);
            }
            break;

          case 'tryon_3d_result':
            if (data.viewer_url || data.glb_url) {
              var link = data.viewer_url || data.glb_url;
              ShopAIChat.TryOn.add3dLinkMessage(link);
              window.open(link, '_blank');
            }
            break;

          case 'human_support':
            ShopAIChat.Message.add(data.message || 'Connecting you to a human agent...', 'assistant', messagesContainer);
            break;

          case 'callback_form':
            ShopAIChat.UI.displayCallbackForm(data.message, messagesContainer);
            break;

          case 'tool_use':
            // Reuse a single loading line so repeated tool messages collapse
            // into one chat line, always rendered before the text response.
            if (data.tool_use_message) {
              if (!state.loadingLine) {
                state.loadingLine = document.createElement('div');
                state.loadingLine.classList.add('shop-ai-message', 'tool-use');
                state.loadingLine.textContent = data.tool_use_message;
                messagesContainer.appendChild(state.loadingLine);
                ShopAIChat.UI.scrollToBottom();
              } else {
                state.loadingLine.textContent = data.tool_use_message;
              }
            }
            break;

          case 'new_message': {
            if (state.messageElement) {
              ShopAIChat.Formatting.formatMessageContent(state.messageElement);
            }
            ShopAIChat.UI.showTypingIndicator();

            // Create a new assistant element for the next response.
            const newMessageElement = document.createElement('div');
            newMessageElement.classList.add('shop-ai-message', 'assistant');
            newMessageElement.textContent = '';
            newMessageElement.dataset.rawText = '';
            messagesContainer.appendChild(newMessageElement);
            state.messageElement = newMessageElement;
            break;
          }

          case 'content_block_complete':
            ShopAIChat.UI.showTypingIndicator();
            break;
        }
      },

      /**
       * Fetch chat history from the server
       * @param {string} conversationId - Conversation ID
       * @param {HTMLElement} messagesContainer - The messages container
       */
      fetchChatHistory: async function(conversationId, messagesContainer) {
        try {
          // Show a loading message
          const loadingMessage = document.createElement('div');
          loadingMessage.classList.add('shop-ai-message', 'assistant');
          loadingMessage.textContent = "Loading conversation history...";
          messagesContainer.appendChild(loadingMessage);

          // Fetch history from the server
          const historyUrl = apiUrl('/chat') + `?history=true&conversation_id=${encodeURIComponent(conversationId)}`;
          console.log('Fetching history from:', historyUrl);

          const response = await fetch(historyUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            },
            mode: 'cors'
          });

          if (!response.ok) {
            console.error('History fetch failed:', response.status, response.statusText);
            throw new Error('Failed to fetch chat history: ' + response.status);
          }

          const data = await response.json();

          // Remove loading message
          messagesContainer.removeChild(loadingMessage);

          // No messages, show welcome message
          if (!data.messages || data.messages.length === 0) {
            const welcomeMessage = getWelcomeMessage();
            ShopAIChat.Message.add(welcomeMessage, 'assistant', messagesContainer);
            return;
          }

          // Add messages to the UI - keep only displayable chat text
          data.messages.forEach(message => {
            // Restore product cards saved as "product" messages
            if (message.role === 'product') {
              try {
                const products = JSON.parse(message.content);
                if (Array.isArray(products)) {
                  ShopAIChat.UI.displayProductResults(products);
                }
              } catch (e) {
                console.warn('[History] Skipping malformed product message');
              }
              return;
            }

            // Skip raw tool results (JSON from catalog/tool calls) — not chat text
            if (message.role === 'tool') return;

            let textToAdd = null;
            try {
              const parsed = JSON.parse(message.content);
              if (Array.isArray(parsed)) {
                textToAdd = parsed
                  .filter(b => b && b.type === 'text' && typeof b.text === 'string')
                  .map(b => b.text)
                  .join('\n') || null;
              } else if (typeof parsed === 'string') {
                textToAdd = parsed;
              } else if (parsed && typeof parsed === 'object') {
                // Structured tool-call assistant message — no displayable text
                textToAdd = null;
              }
            } catch (e) {
              // Plain text content (not JSON)
              textToAdd = message.content;
            }

            if (textToAdd && textToAdd.trim()) {
              ShopAIChat.Message.add(textToAdd, message.role, messagesContainer);
            }
          });

          // Scroll to bottom
          ShopAIChat.UI.scrollToBottom();

        } catch (error) {
          console.error('Error fetching chat history:', error);

          // Remove loading message if it exists
          const loadingMessage = messagesContainer.querySelector('.shop-ai-message.assistant');
          if (loadingMessage && loadingMessage.textContent === "Loading conversation history...") {
            messagesContainer.removeChild(loadingMessage);
          }

          // Show error and welcome message. IMPORTANT: do NOT clear the
          // conversation ID here — a transient fetch error shouldn't lose the
          // customer's history. Keep it so the next page load retries.
          const welcomeMessage = getWelcomeMessage();
          ShopAIChat.Message.add(welcomeMessage, 'assistant', messagesContainer);
        }
      },

      /**
       * Initial experience for a brand-new conversation: load a few featured
       * products from the backend, show them above the greeting (the greeting
       * references "featured products above"), then display the welcome message.
       * @param {HTMLElement} messagesContainer
       */
      loadInitialExperience: async function(messagesContainer) {
        let products = null;
        try {
          const response = await fetch(apiUrl('/api/featured'), {
            headers: { 'X-Shopify-Shop-Id': window.shopId || '' }
          });
          const data = await response.json();
          if (data && data.ok && Array.isArray(data.products) && data.products.length) {
            products = data.products;
          }
        } catch (err) {
          console.error('[Chat] Failed to load featured products:', err);
        }

        if (products && products.length) {
          ShopAIChat.UI.displayProductResults(products, 'New products');
        }

        const welcomeMessage = getWelcomeMessage();
        ShopAIChat.Message.add(welcomeMessage, 'assistant', messagesContainer);
      }
    },

    /**
     * Authentication-related functionality
     */
    Auth: {
      /**
       * Opens an authentication popup window
       * @param {string|HTMLElement} authUrlOrElement - The auth URL or link element that was clicked
       */
      openAuthPopup: function(authUrlOrElement) {
        let authUrl;
        if (typeof authUrlOrElement === 'string') {
          // If a string URL was passed directly
          authUrl = authUrlOrElement;
        } else {
          // If an element was passed
          authUrl = authUrlOrElement.getAttribute('data-auth-url');
          if (!authUrl) {
            console.error('No auth URL found in element');
            return;
          }
        }

        // Open the popup window centered in the screen
        const width = 600;
        const height = 700;
        const left = (window.innerWidth - width) / 2 + window.screenX;
        const top = (window.innerHeight - height) / 2 + window.screenY;

        const popup = window.open(
          authUrl,
          'ShopifyAuth',
          `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
        );

        // Focus the popup window
        if (popup) {
          popup.focus();
        } else {
          // If popup was blocked, show a message
          alert('Please allow popups for this site to authenticate with Shopify.');
        }

        // Start polling for token availability
        const conversationId = sessionStorage.getItem('shopAiConversationId');
        if (conversationId) {
          const messagesContainer = document.querySelector('.shop-ai-chat-messages');

          // Add a message to indicate authentication is in progress
          ShopAIChat.Message.add("Authentication in progress. Please complete the process in the popup window.",
            'assistant', messagesContainer);

          this.startTokenPolling(conversationId, messagesContainer);
        }
      },

      /**
       * Start polling for token availability
       * @param {string} conversationId - Conversation ID
       * @param {HTMLElement} messagesContainer - The messages container
       */
      startTokenPolling: function(conversationId, messagesContainer) {
        if (!conversationId) return;

        console.log('Starting token polling for conversation:', conversationId);
        const pollingId = 'polling_' + Date.now();
        sessionStorage.setItem('shopAiTokenPollingId', pollingId);

        let attemptCount = 0;
        const maxAttempts = 30;

        const poll = async () => {
          if (sessionStorage.getItem('shopAiTokenPollingId') !== pollingId) {
            console.log('Another polling session has started, stopping this one');
            return;
          }

          if (attemptCount >= maxAttempts) {
            console.log('Max polling attempts reached, stopping');
            return;
          }

          attemptCount++;

          try {
            const tokenUrl = apiUrl('/auth/token-status') + '?conversation_id=' +
              encodeURIComponent(conversationId);
            const response = await fetch(tokenUrl);

            if (!response.ok) {
              throw new Error('Token status check failed: ' + response.status);
            }

            const data = await response.json();

            if (data.status === 'authorized') {
              console.log('Token available, resuming conversation');
              const message = sessionStorage.getItem('shopAiLastMessage');

              if (message) {
                sessionStorage.removeItem('shopAiLastMessage');
                setTimeout(() => {
                  ShopAIChat.Message.add("Authorization successful! I'm now continuing with your request.",
                    'assistant', messagesContainer);
                  ShopAIChat.API.streamResponse(message, conversationId, messagesContainer);
                  ShopAIChat.UI.showTypingIndicator();
                }, 500);
              }

              sessionStorage.removeItem('shopAiTokenPollingId');
              return;
            }

            console.log('Token not available yet, polling again in 10s');
            setTimeout(poll, 10000);
          } catch (error) {
            console.error('Error polling for token status:', error);
            setTimeout(poll, 10000);
          }
        };

        setTimeout(poll, 2000);
      }
    },

    /**
     * Product-related functionality
     */
    Product: {
      /**
       * Create a product card element
       * @param {Object} product - Product data (may include `tryon_image_url` + `tryon_product_title` for pairing cards)
       * @returns {HTMLElement} Product card element
       */
      createCard: function(product) {
        // Pairing cards carry the edited photo URL and original item title so we
        // can offer "Try with this look" that layers the suggested item on top.
        const sourceTryonImageUrl = product.tryon_image_url;
        const originalProductTitle = product.tryon_product_title;

        // Resolve a clickable, absolute product-page URL (fall back to the storefront origin).
        const productUrl = (function() {
          if (product.url && /^https?:\/\//i.test(product.url)) return product.url;
          if (product.handle) return (window.location.origin || '') + '/products/' + product.handle;
          if (product.url && product.url.indexOf('/') === 0) return (window.location.origin || '') + product.url;
          return null;
        })();

        const card = document.createElement('div');
        card.classList.add('shop-ai-product-card');

        // Create image container
        const imageContainer = document.createElement('div');
        imageContainer.classList.add('shop-ai-product-image');

        // Add product image or placeholder
        const image = document.createElement('img');
        image.src = product.image_url || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
        image.alt = product.title;
        image.onerror = function() {
          // If image fails to load, use a fallback placeholder
          this.src = 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
        };
        imageContainer.appendChild(image);

        // Make the image a link to the product page when possible.
        if (productUrl) {
          const imageLink = document.createElement('a');
          imageLink.href = productUrl;
          imageLink.target = '_blank';
          imageLink.rel = 'noopener noreferrer';
          imageLink.appendChild(imageContainer);
          card.appendChild(imageLink);
        } else {
          card.appendChild(imageContainer);
        }

        // Add product info
        const info = document.createElement('div');
        info.classList.add('shop-ai-product-info');

        // Add product title
        const title = document.createElement('h3');
        title.classList.add('shop-ai-product-title');
        title.textContent = product.title;

        // If product has a URL, make the title a link
        if (productUrl) {
          const titleLink = document.createElement('a');
          titleLink.href = productUrl;
          titleLink.target = '_blank';
          titleLink.rel = 'noopener noreferrer';
          titleLink.textContent = product.title;
          title.textContent = '';
          title.appendChild(titleLink);
        }

        info.appendChild(title);

        // Add product price
        const price = document.createElement('p');
        price.classList.add('shop-ai-product-price');
        price.textContent = product.price;
        info.appendChild(price);

        // Add stock badge (available: true | false | null=unknown)
        if (product.available !== null && product.available !== undefined) {
          const stock = document.createElement('span');
          stock.classList.add('shop-ai-stock');
          stock.classList.add(product.available ? 'shop-ai-stock--in' : 'shop-ai-stock--out');
          stock.textContent = product.available ? 'In stock' : 'Out of stock';
          info.appendChild(stock);
        }

        // Add add-to-cart button
        const button = document.createElement('button');
        button.classList.add('shop-ai-add-to-cart');
        button.textContent = 'Add to Cart';
        button.dataset.productId = product.id;

        // ---- Variant picker (size / color etc.) derived from variants ----
        const variants = Array.isArray(product.variants) ? product.variants : [];
        const selected = {};
        let selectedVariant = variants[0] || null;

        function findMatchingVariant() {
          if (variants.length === 0) return null;
          const keys = Object.keys(selected);
          if (keys.length === 0) return variants[0];
          const match = variants.find(function(v) {
            const vOpts = {};
            (v.options || []).forEach(function(o) { if (o && o.name) vOpts[o.name] = o.value || o.label; });
            return keys.every(function(k) { return selected[k] && vOpts[k] === selected[k]; });
          });
          return match || variants[0];
        }

        function variantLabel(v) {
          if (!v) return '';
          if (v.title && v.title !== 'Default Title') return v.title;
          return '';
        }

        // Build option groups from the actual variants (robust to catalog format).
        const optionNames = [];
        const optionValues = {};
        variants.forEach(function(v) {
          (v.options || []).forEach(function(o) {
            if (!o || !o.name) return;
            const val = o.value || o.label;
            if (!optionValues[o.name]) { optionValues[o.name] = []; optionNames.push(o.name); }
            if (val && optionValues[o.name].indexOf(val) === -1) optionValues[o.name].push(val);
          });
        });
        // Only show the picker when there is a real choice (an option with >1 value).
        const hasRealOptions = optionNames.some(function(n) { return optionValues[n].length > 1; });

        if (hasRealOptions) {
          const picker = document.createElement('div');
          picker.classList.add('shop-ai-variant-picker');

          optionNames.forEach(function(name) {
            const values = optionValues[name];
            const block = document.createElement('div');
            block.classList.add('shop-ai-variant-opt');

            const label = document.createElement('span');
            label.classList.add('shop-ai-variant-label');
            label.textContent = name + ':';
            block.appendChild(label);

            const row = document.createElement('div');
            row.classList.add('shop-ai-variant-values');

            values.forEach(function(val) {
              const vbtn = document.createElement('button');
              vbtn.type = 'button';
              vbtn.classList.add('shop-ai-variant-value');
              vbtn.textContent = val;
              vbtn.addEventListener('click', function() {
                selected[name] = val;
                selectedVariant = findMatchingVariant();
                row.querySelectorAll('.shop-ai-variant-value').forEach(function(b) {
                  b.classList.toggle('active', b.textContent === val);
                });
                const lbl = variantLabel(selectedVariant);
                button.textContent = lbl ? 'Add to Cart (' + lbl + ')' : 'Add to Cart';
              });
              row.appendChild(vbtn);
            });

            block.appendChild(row);
            picker.appendChild(block);
          });

          info.insertBefore(picker, button);
        }

        function buildCartAddedMessage(cart) {
          const title = product.title || 'Product';
          const vTitle = variantLabel(selectedVariant);
          const lines = ['**' + title + '**' + (vTitle ? ' (' + vTitle + ')' : '') + ' has been added to your cart.'];
          if (cart && Array.isArray(cart.items) && cart.items.length > 0) {
            lines.push('\n**Your cart:**');
            cart.items.forEach(function(it) {
              const qty = it.quantity || 1;
              const price = it.price != null ? (it.price / 100).toFixed(2) : null;
              const cur = cart.currency || '';
              const itTitle = it.product_title || it.title || 'Item';
              const vt = it.variant_title && it.variant_title !== 'Default Title' ? ' (' + it.variant_title + ')' : '';
              const priceStr = price != null ? (cur ? cur + ' ' : '') + price : '';
              lines.push('- ' + itTitle + vt + ' × ' + qty + (priceStr ? ' — ' + priceStr : ''));
            });
            if (cart.total_price != null) {
              lines.push('\n**Subtotal:** ' + (cart.currency ? cart.currency + ' ' : '') + (cart.total_price / 100).toFixed(2));
            }
          } else if (cart && cart.items_count != null) {
            lines.push('\nYour cart now has ' + cart.items_count + ' item(s).');
          }
          lines.push('\n[Proceed to checkout](/cart)');
          return lines.join('\n');
        }

        // Add click handler: adds the selected variant to the real storefront
        // cart via Shopify's Ajax Cart API (/cart/add.js) on the same origin.
        button.addEventListener('click', function() {
          const messagesContainer = ShopAIChat.UI.elements.messagesContainer;
          const variantId = (selectedVariant && selectedVariant.id) || product.variant_id;

          if (!variantId) {
            ShopAIChat.Message.add('This product has no selectable variant to add to cart.', 'assistant', messagesContainer);
            return;
          }

          button.disabled = true;
          button.textContent = 'Adding...';

          fetch('/cart/add.js', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'id=' + encodeURIComponent(variantId) + '&quantity=1'
          })
            .then(function(response) {
              if (!response.ok) {
                return response.json().then(function(err) {
                  throw new Error(err?.description || err?.message || ('HTTP ' + response.status));
                });
              }
              return response.json();
            })
            .then(function(cart) {
              button.disabled = false;
              button.textContent = '✓ Added';
              ShopAIChat.Message.add(buildCartAddedMessage(cart), 'assistant', messagesContainer);
            })
            .catch(function(err) {
              console.error('Add to cart failed:', err);
              button.disabled = false;
              button.textContent = 'Add to Cart';
              ShopAIChat.Message.add(
                'Sorry, I couldn\'t add **' + product.title + '** to your cart. Please try again on the product page.',
                'assistant',
                messagesContainer
              );
            });
        });

        info.appendChild(button);

        // Add try-on button (pairing cards use the edited photo as source)
        const tryonBtn = document.createElement('button');
        tryonBtn.classList.add('shop-ai-tryon-button');
        if (sourceTryonImageUrl) {
          tryonBtn.classList.add('shop-ai-tryon-pairing-button');
          tryonBtn.textContent = 'Try with this look';
          tryonBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            ShopAIChat.TryOn.runPairingTryon(product, sourceTryonImageUrl, originalProductTitle);
          });
        } else {
          tryonBtn.textContent = 'Try On';
          tryonBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            ShopAIChat.TryOn.open(product);
          });
        }
        info.appendChild(tryonBtn);

        card.appendChild(info);

        return card;
      }
    },

    /**
     * 2D Try-On functionality
     */
    TryOn: {
      state: {
        currentProduct: null,
        stagedFile: null,
        stagedPreview: null,
        poseDetector: null,
        isLoading: false,
        mediaPipeLoaded: false
      },

      open: function(product) {
        this.state.currentProduct = product;

        if (!product.image_url) {
          ShopAIChat.Message.add("This product doesn't have a preview image for try-on.", 'assistant',
            ShopAIChat.UI.elements.messagesContainer);
          return;
        }

        // If the customer staged a photo via the upload icon, use it directly
        // instead of showing the upload modal again.
        if (this.state.stagedFile) {
          this.handleFile(this.state.stagedFile);
          return;
        }

        this.showUploadUI();
      },

      showUploadUI: function() {
        var existingOverlay = document.getElementById('shop-ai-tryon-overlay');
        if (existingOverlay) existingOverlay.remove();

        const overlay = document.createElement('div');
        overlay.classList.add('shop-ai-tryon-overlay');
        overlay.id = 'shop-ai-tryon-overlay';

        const modal = document.createElement('div');
        modal.classList.add('shop-ai-tryon-modal');

        modal.innerHTML = '<h3>Try On ' + (this.state.currentProduct?.title || 'Product') + '</h3>' +
          '<p class="shop-ai-tryon-sub">Upload a full-body photo to see a demo overlay</p>' +
          '<div class="shop-ai-tryon-upload-area" id="shop-ai-tryon-upload">' +
            '<div class="shop-ai-tryon-upload-icon">📷</div>' +
            '<p>Click or drag a photo here</p>' +
            '<p class="shop-ai-tryon-hint">Stands facing the camera works best</p>' +
          '</div>' +
          '<input type="file" id="shop-ai-tryon-file" accept="image/*" style="display:none">' +
          '<div class="shop-ai-tryon-loading" id="shop-ai-tryon-loading" style="display:none">' +
            '<div class="shop-ai-tryon-spinner"></div>' +
            '<p>Processing your try-on...</p>' +
          '</div>' +
          '<button class="shop-ai-tryon-cancel" id="shop-ai-tryon-cancel">Cancel</button>';

        modal.querySelector('#shop-ai-tryon-cancel').addEventListener('click', () => this.closeUploadUI());
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', function(e) {
          if (e.target === overlay) ShopAIChat.TryOn.closeUploadUI();
        });

        var self = this;
        var uploadArea = modal.querySelector('#shop-ai-tryon-upload');
        var fileInput = modal.querySelector('#shop-ai-tryon-file');

        uploadArea.addEventListener('click', function() { fileInput.click(); });
        fileInput.addEventListener('change', function(e) {
          if (e.target.files && e.target.files[0]) self.handleFile(e.target.files[0]);
        });

        uploadArea.addEventListener('dragover', function(e) { e.preventDefault(); uploadArea.classList.add('dragover'); });
        uploadArea.addEventListener('dragleave', function() { uploadArea.classList.remove('dragover'); });
        uploadArea.addEventListener('drop', function(e) {
          e.preventDefault();
          uploadArea.classList.remove('dragover');
          if (e.dataTransfer.files && e.dataTransfer.files[0]) self.handleFile(e.dataTransfer.files[0]);
        });
      },

      closeUploadUI: function() {
        var overlay = document.getElementById('shop-ai-tryon-overlay');
        if (overlay) overlay.remove();
        this.state.currentProduct = null;
      },

      handleFile: async function(file) {
        if (!file.type.startsWith('image/')) {
          alert('Please upload an image file.');
          return;
        }

        if (file.size > 10 * 1024 * 1024) {
          alert('Photo is too large. Please use an image under 10MB.');
          return;
        }

        var product = this.state.currentProduct;
        this.showLoading();

        try {
          // Run the try-on and the pairing search in parallel, then show the
          // result image and the pairing cards together at the same time.
          var results = await Promise.all([
            this.runCloud2dTryon(file),
            this.fetchPairings(product && product.title)
          ]);
          var cloudResult = results[0];
          var pairingsData = results[1];

          if (cloudResult && cloudResult.image_url) {
            this.displayResult(cloudResult.image_url, cloudResult.product_title, true);

            var pairings = pairingsData && pairingsData.products ? pairingsData.products : [];
            if (pairings.length > 0) {
              var firstTitle = cloudResult.product_title || (product && product.title) || null;
              for (var i = 0; i < pairings.length; i++) {
                pairings[i].tryon_image_url = cloudResult.image_url;
                pairings[i].tryon_product_title = firstTitle;
              }
              ShopAIChat.UI.displayProductResults(
                pairings,
                'Pairs well with ' + (firstTitle || 'this item') + ' — tap "Try with this look"'
              );
            }
          } else {
            ShopAIChat.Message.add('AI 2D try-on returned no result. Please try again.', 'assistant',
              ShopAIChat.UI.elements.messagesContainer);
          }
        } catch (err) {
          console.error('Try-on failed:', err);
          ShopAIChat.Message.add('AI 2D try-on failed: ' + err.message, 'assistant',
            ShopAIChat.UI.elements.messagesContainer);
        } finally {
          this.closeUploadUI();
        }
      },

      /**
       * Fetch complementary product suggestions for a product title.
       * Runs independently of image generation so the two can be parallelized.
       * @param {string} [productTitle] - The item the customer just tried on
       * @returns {Promise<Object|null>} pairing payload (with `products`), or null
       */
      fetchPairings: async function(productTitle) {
        if (!productTitle) return null;

        try {
          var payload = { product_title: productTitle };

          var conversationId = sessionStorage.getItem('shopAiConversationId');
          if (conversationId) payload.conversation_id = conversationId;

          var response = await fetch(apiUrl('/api/tryon/pairings'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Shop-Id': window.shopId || ''
            },
            body: JSON.stringify(payload)
          });

          var data = await response.json();
          if (!response.ok || !data.ok) {
            throw new Error(data.error || ('HTTP ' + response.status));
          }

          return data;
        } catch (err) {
          console.error('[TryOn] Failed to fetch pairing suggestions:', err);
          return null;
        }
      },

      runCloud2dTryon: async function(file) {
        var product = this.state.currentProduct;
        if (!product || !product.image_url) return null;

        var formData = new FormData();
        formData.append('person_image', file);
        formData.append('product_image_url', product.image_url);
        if (product.title) formData.append('product_title', product.title);
        var conversationId = sessionStorage.getItem('shopAiConversationId');
        if (conversationId) formData.append('conversation_id', conversationId);

        var response = await fetch(apiUrl('/api/tryon/2d'), {
          method: 'POST',
          body: formData
        });

        var data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.error || ('HTTP ' + response.status));
        }

        console.log('[TryOn] Cloud 2D result:', data.image_url);
        return data;
      },

      /**
       * Run a 2D try-on using an existing edited photo as the source person image.
       * Used for pairing suggestions (layer the suggested item onto the look already created).
       * @param {Object} product - The suggested product to add
       * @param {string} sourceImageUrl - The edited result photo (already wearing the original item)
       * @param {string} [originalProductTitle] - The item already worn in the edited photo
       */
      runPairingTryon: async function(product, sourceImageUrl, originalProductTitle) {
        if (!product || !product.image_url || !sourceImageUrl) return;

        var messagesContainer = ShopAIChat.UI.elements.messagesContainer;
        ShopAIChat.Message.add('Pairing ' + product.title + ' with your look…', 'assistant', messagesContainer);

        try {
          // Fetch the edited result image so we can upload it as a file.
          // This works for localhost and avoids Replicate being unable to reach private URLs.
          var imageResponse = await fetch(sourceImageUrl);
          if (!imageResponse.ok) {
            throw new Error('Could not load the edited photo');
          }
          var imageBlob = await imageResponse.blob();
          var personFile = new File([imageBlob], 'edited-look.jpg', { type: imageBlob.type || 'image/jpeg' });

          var formData = new FormData();
          formData.append('person_image', personFile);
          formData.append('product_image_url', product.image_url);
          if (product.title) formData.append('product_title', product.title);
          formData.append('placement', 'pairing');
          if (originalProductTitle) formData.append('original_product_title', originalProductTitle);

          var conversationId = sessionStorage.getItem('shopAiConversationId');
          if (conversationId) formData.append('conversation_id', conversationId);

          var response = await fetch(apiUrl('/api/tryon/2d'), {
            method: 'POST',
            body: formData
          });

          var data = await response.json();
          if (!response.ok || !data.ok) {
            throw new Error(data.error || ('HTTP ' + response.status));
          }

          if (data.image_url) {
            this.displayResult(data.image_url, product.title + ' with your look', true);
          } else {
            throw new Error('No image returned');
          }
        } catch (err) {
          console.error('[TryOn] Pairing try-on failed:', err);
          ShopAIChat.Message.add('Sorry, the pairing try-on failed: ' + err.message, 'assistant', messagesContainer);
        }
      },

      showLoading: function() {
        var uploadArea = document.getElementById('shop-ai-tryon-upload');
        var loading = document.getElementById('shop-ai-tryon-loading');
        if (uploadArea) uploadArea.style.display = 'none';
        if (loading) loading.style.display = 'flex';
      },

      displayResult: function(imageSrc, productTitle, isCloud) {
        var container = document.createElement('div');
        container.classList.add('shop-ai-tryon-result');

        var img = document.createElement('img');
        img.alt = 'Try-on result';

        img.onload = function() {
          console.log('[TryOn] Result image rendered, size:', img.naturalWidth + 'x' + img.naturalHeight);
        };
        img.onerror = function() {
          console.error('[TryOn] Result image failed to render');
        };
        img.src = imageSrc;
        container.appendChild(img);

        var caption = document.createElement('p');
        caption.classList.add('shop-ai-tryon-caption');
        caption.textContent = (isCloud ? 'AI try-on of ' : 'Demo try-on of ') +
          (productTitle || this.state.currentProduct?.title || 'the selected product') +
          (isCloud ? '' : ' (local overlay)');
        container.appendChild(caption);

        if (imageSrc) {
          var btn3d = document.createElement('button');
          btn3d.type = 'button';
          btn3d.className = 'shop-ai-tryon-3d-btn';
          btn3d.textContent = 'View in 3D';
          var self = this;
          btn3d.addEventListener('click', function() {
            self.request3dFromImage(imageSrc);
          });
          container.appendChild(btn3d);
        }

        console.log('[TryOn] Appending result to chat');
        var messagesContainer = ShopAIChat.UI.elements.messagesContainer;
        messagesContainer.appendChild(container);
        ShopAIChat.UI.scrollToBottom();
      },

      add3dLinkMessage: function(viewerUrl) {
        var messagesContainer = ShopAIChat.UI.elements.messagesContainer;
        var el = document.createElement('div');
        el.classList.add('shop-ai-message', 'assistant');

        var txt = document.createTextNode('Your 3D model is ready — ');
        el.appendChild(txt);

        var a = document.createElement('a');
        a.href = viewerUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Open 3D viewer';
        el.appendChild(a);

        var saved = document.createTextNode('  (link: ' + viewerUrl + ')');
        el.appendChild(saved);

        messagesContainer.appendChild(el);
        ShopAIChat.UI.scrollToBottom();
      },

      request3dFromImage: async function(imageUrl) {
        var confirmed = window.confirm('Generate a 3D model from this try-on?\n\nThis runs the 3D generation model and uses AI tokens (may take ~20-60s).');
        if (!confirmed) return;

        var messagesContainer = ShopAIChat.UI.elements.messagesContainer;
        ShopAIChat.Message.add('Generating 3D model from your try-on… (this can take up to a minute)', 'assistant', messagesContainer);

        try {
          var payload = { image_url: imageUrl };
          var conversationId = sessionStorage.getItem('shopAiConversationId');
          if (conversationId) payload.conversation_id = conversationId;

          var response = await fetch(apiUrl('/api/tryon/3d'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          var data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || ('HTTP ' + response.status));

          var linkUrl = data.viewer_url || data.glb_url;
          if (linkUrl) {
            this.add3dLinkMessage(linkUrl);
            window.open(linkUrl, '_blank');
          } else {
            throw new Error('No 3D output returned');
          }
        } catch (e) {
          console.error('[TryOn] 3D generation failed:', e);
          ShopAIChat.Message.add('Sorry, the 3D generation failed. Please try again.', 'assistant', messagesContainer);
        }
      }
    },

    /**
     * Initialize the chat application
     */
    init: function() {
      // Initialize UI
      const container = document.querySelector('.shop-ai-chat-container');
      if (!container) return;

      this.UI.init(container);

      // Check for existing conversation
      const conversationId = sessionStorage.getItem('shopAiConversationId');

      if (conversationId) {
        // Fetch conversation history
        this.API.fetchChatHistory(conversationId, this.UI.elements.messagesContainer);
      } else {
        // No previous conversation: load featured products first (the greeting
        // references "featured products above"), then show the welcome message.
        this.API.loadInitialExperience(this.UI.elements.messagesContainer);
      }
    }
  };

  // Initialize the application when DOM is ready
  document.addEventListener('DOMContentLoaded', function() {
    ShopAIChat.init();
  });
})();
