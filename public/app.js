(() => {
  const chatLog = document.getElementById("chatLog");
  const composer = document.getElementById("composer");
  const messageInput = document.getElementById("messageInput");
  const sendButton = document.getElementById("sendButton");
  const attachButton = document.getElementById("attachButton");
  const fileInput = document.getElementById("fileInput");
  const quickActions = document.getElementById("quickActions");
  const agentModeLabel = document.getElementById("agentModeLabel");
  const modeButtons = [...document.querySelectorAll(".mode-btn")];

  const MODE_TITLES = {
    default: "Режим: обычный",
    coder: "Режим: программист",
    architect: "Режим: архитектор"
  };

  /**
   * @param {"bot"|"user"} role
   * @param {string} text
   * @param {{file?: {name: string, url: string}, image?: {url: string}}} [extra]
   * @returns {HTMLDivElement}
   */
  function addBubble(role, text, extra) {
    const bubble = document.createElement("div");

    bubble.className = `bubble ${role}`;

    const textEl = document.createElement("div");

    textEl.className = "bubble-text";
    textEl.textContent = text;
    bubble.appendChild(textEl);

    if (extra?.image) {
      const img = document.createElement("img");

      img.src = extra.image.url;
      img.alt = "Сгенерированная картинка";
      img.className = "bubble-image";
      bubble.appendChild(img);
    }

    if (extra?.file) {
      const link = document.createElement("a");

      link.href = extra.file.url;
      link.className = "file-card";
      link.download = extra.file.name;
      link.innerHTML = `
        <span class="file-icon">📄</span>
        <span class="file-name">${escapeHtml(extra.file.name)}</span>
        <span class="file-action">Скачать</span>
      `;
      bubble.appendChild(link);
    }

    chatLog.appendChild(bubble);
    chatLog.scrollTop = chatLog.scrollHeight;

    return bubble;
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function escapeHtml(value) {
    const div = document.createElement("div");

    div.textContent = value;

    return div.innerHTML;
  }

  function showTyping() {
    const bubble = document.createElement("div");

    bubble.className = "bubble bot typing";
    bubble.innerHTML = "<span></span><span></span><span></span>";
    bubble.id = "typingBubble";
    chatLog.appendChild(bubble);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function hideTyping() {
    document.getElementById("typingBubble")?.remove();
  }

  /**
   * @param {string} message
   */
  async function sendMessage(message) {
    if (!message.trim()) {
      return;
    }

    addBubble("user", message);
    messageInput.value = "";
    autoResize();
    sendButton.disabled = true;
    showTyping();

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      const data = await response.json();

      hideTyping();

      if (!response.ok) {
        addBubble("bot", data.error || "Что-то пошло не так.");
        return;
      }

      addBubble("bot", data.reply, { file: data.file, image: data.image });

      if (/^Режим агента переключён: (\w+)/.test(data.reply)) {
        const mode = data.reply.match(/^Режим агента переключён: (\w+)/)[1];

        setActiveMode(mode);
      }
    } catch {
      hideTyping();
      addBubble("bot", "Не достучался до сервера. Проверь соединение и попробуй ещё раз.");
    } finally {
      sendButton.disabled = false;
      messageInput.focus();
    }
  }

  /**
   * @param {string} mode
   */
  function setActiveMode(mode) {
    modeButtons.forEach(button => {
      button.classList.toggle("active", button.dataset.mode === mode);
    });
    agentModeLabel.textContent = MODE_TITLES[mode] || `Режим: ${mode}`;
  }

  function autoResize() {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 140)}px`;
  }

  composer.addEventListener("submit", event => {
    event.preventDefault();
    sendMessage(messageInput.value);
  });

  messageInput.addEventListener("input", autoResize);
  messageInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage(messageInput.value);
    }
  });

  modeButtons.forEach(button => {
    button.addEventListener("click", () => {
      sendMessage(`/agent ${button.dataset.mode}`);
    });
  });

  attachButton.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];

    if (!file) {
      return;
    }

    addBubble("user", `📎 ${file.name}`);
    showTyping();

    try {
      const contentBase64 = await fileToBase64(file);
      const response = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentBase64 })
      });
      const data = await response.json();

      hideTyping();
      addBubble("bot", response.ok ? data.message : (data.error || "Не удалось загрузить файл."));
    } catch {
      hideTyping();
      addBubble("bot", "Не удалось прочитать файл в браузере.");
    } finally {
      fileInput.value = "";
    }
  });

  /**
   * @param {File} file
   * @returns {Promise<string>}
   */
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        const result = String(reader.result || "");

        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /**
   * @param {{id: string, label: string, phrase: string|null, hint: string[]|null, menu: string|null}} action
   */
  function renderChip(action) {
    const chip = document.createElement("button");

    chip.type = "button";
    chip.className = "chip";
    chip.textContent = action.label;
    chip.addEventListener("click", () => {
      if (action.hint) {
        addBubble("bot", action.hint.join("\n"));
        return;
      }

      if (action.phrase) {
        sendMessage(action.phrase);
      }
    });

    return chip;
  }

  async function loadQuickActions() {
    try {
      const response = await fetch("/api/quick-actions");
      const data = await response.json();

      data.actions
        .filter(action => action.menu !== "criteria")
        .forEach(action => quickActions.appendChild(renderChip(action)));

      data.criteria.forEach(preset => {
        quickActions.appendChild(renderChip({
          id: preset.id,
          label: `🎯 ${preset.label}`,
          phrase: preset.phrase,
          hint: null,
          menu: null
        }));
      });
    } catch {
      // Чат работает и без быстрых кнопок — просто не критично для основной функции.
    }
  }

  loadQuickActions();
  messageInput.focus();
})();
