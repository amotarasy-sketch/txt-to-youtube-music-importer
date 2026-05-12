(async () => {
  /*
    YouTube Music playlist importer from .txt

    Формат .txt:
      Один трек на строку:
      Artist - Song

    Как запустить:
      1. Откройте YouTube Music.
      2. Создайте или откройте нужный плейлист.
      3. Нажмите F12, Вкладка (сверху слева в этом окне) Console.
      4. Вставьте этот скрипт.
      5. Укажите название плейлиста в 24 строке.
      6. Нажмите Enter и выберите .txt файл.

    Что бы остановить, перезагрузите страницу

    Лучше выполнять в отдельном окне браузера, во время работы не взаимодействуйте с вкладкой
    По завершению, будет скачан файл с отчётом (можно открыть блокнотом), а в консоли выведено резюме.
  */

  const CONFIG = {
    PLAYLIST_NAME: "_____",  // В кавычки название своего плейлиста. Должно быть вида, напр.: PLAYLIST_NAME: "My Main"

    START_FROM: 0,
    RESUME_FROM_SAVED_PROGRESS: false, // Если true, при наличии сохранённого прогресса, начнёт с последнего результата
    REMOVE_DUPLICATES: true,
    DEBUG: true,

    // Минимальная проверка найденного результата.
    // Если true, скрипт попробует убедиться, что первый результат похож на строку из txt.
    VERIFY_FIRST_RESULT: true,

    // Насколько мягко сравнивать запрос и результат.
    // Чем меньше значение, тем строже проверка.
    MIN_RESULT_SCORE: 0.35,

    SAVE_BUTTON_TEXTS: ["сохранить", "save"],
    SAVED_HINT_TEXTS: ["сохранено", "saved", "добавлено", "added"],

    SEARCH_BUTTON_SELECTOR: "ytmusic-search-box button",
    SEARCH_INPUT_SELECTOR: "ytmusic-search-box input",

    RESULT_SELECTORS: [
      "ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer",
      "ytmusic-responsive-list-item-renderer",
      "ytmusic-card-shelf-renderer ytmusic-two-row-item-renderer"
    ],

    PLAYLIST_CARD_SELECTORS: [
      "ytmusic-two-row-item-renderer",
      "ytmusic-responsive-list-item-renderer",
      "ytmusic-playlist-add-to-option-renderer"
    ],

    BUTTON_SELECTORS: [
      "button",
      "tp-yt-paper-button",
      "yt-button-shape button",
      "ytmusic-button-renderer button"
    ],

    STORAGE_KEY: "ytmImportProgressV2"
  };
      // Временные задержки, чтобы дать YouTube Music время на обновление интерфейса после действий. 
      // На случай медленного интернета или слабого компьютера. Можно подстроить под себя, но лучше не ставить слишком маленькие значения.
      //чем дольше грузится страница, тем больше эти задержки должны быть, чтобы скрипт успевал находить нужные элементы. 
      //Задеержки в милисекундах. 1 секунда = 1000 миллисекунд. Например, 700 означает 0.7 секунды.
      //Сейчас примерно 15 сек на одну песню
      //то есть примерно 240 песен в час
  const DELAYS = {
    afterClosePopups: 700,
    afterSearchButtonClick: 100,
    afterClearSearchInput: 400,
    beforePressEnter: 100,
    afterSearch: 3000,
    beforeClick: 100,
    afterClick: 900,
    beforePlaylistDialogCheck: 800,
    playlistDialogTimeout: 7000,
    playlistDialogCheckInterval: 700,
    afterPlaylistClick: 1000,
    betweenTracks: 1200,
    waitForInterval: 400
  };

  window.stopYtmImport = false;

  const result = {
    added: [],
    probablyAdded: [],
    skipped: [],
    failed: [],
    duplicatesRemoved: 0,
    startedFrom: 0,
    nextStartFrom: 0,
    total: 0,
    finished: false
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const log = (...args) => {
    if (CONFIG.DEBUG) console.log(...args);
  };

  const warn = (...args) => console.warn(...args);

  function normalizeText(value) {
    return String(value || "")
      .replace(/[\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeComparable(value) {
    return normalizeText(value)
      .toLowerCase()
      .replace(/[“”„«»]/g, '"')
      .replace(/[’`]/g, "'")
      .replace(/[^\p{L}\p{N}\s'"-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getText(el) {
    if (!el) return "";

    return normalizeText([
      el.innerText,
      el.textContent,
      el.ariaLabel,
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("title")
    ].filter(Boolean).join(" "));
  }

  function textContainsAny(text, words) {
    const source = normalizeComparable(text);
    return words.some(word => source.includes(normalizeComparable(word)));
  }

  function visible(el) {
    if (!el) return false;

    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  async function waitFor(label, fn, timeout = 15000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const value = fn();
      if (value) return value;
      await sleep(DELAYS.waitForInterval);
    }

    throw new Error(`Не найден элемент: ${label}`);
  }

  async function realClick(el, label = "element") {
    if (!el) throw new Error(`realClick: пустой элемент: ${label}`);

    el.scrollIntoView({ block: "center", inline: "center" });
    await sleep(DELAYS.beforeClick);

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y) || el;

    log("🖱 Клик:", label, getText(target).slice(0, 160));

    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y
      }));
    }

    await sleep(DELAYS.afterClick);
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
    }
  }

  function setNativeInputValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");

    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function saveProgress(nextStartFrom, track, status) {
    const payload = {
      nextStartFrom,
      lastTrack: track,
      lastStatus: status,
      updatedAt: new Date().toISOString()
    };

    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(payload));
    result.nextStartFrom = nextStartFrom;
  }

  function readProgress() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearProgress() {
    localStorage.removeItem(CONFIG.STORAGE_KEY);
  }

  function pickTextFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".txt,text/plain";

      input.onchange = async () => {
        try {
          const file = input.files && input.files[0];
          if (!file) return reject(new Error("Файл не выбран"));
          resolve(await file.text());
        } catch (error) {
          reject(error);
        }
      };

      input.click();
    });
  }

  function parseTracks(raw) {
    const lines = String(raw || "")
      .replace(/\r/g, "")
      .split("\n")
      .map(line => normalizeText(line))
      .filter(Boolean);

    if (!CONFIG.REMOVE_DUPLICATES) return lines;

    const seen = new Set();
    const unique = [];

    for (const line of lines) {
      const key = normalizeComparable(line);
      if (seen.has(key)) {
        result.duplicatesRemoved += 1;
        continue;
      }

      seen.add(key);
      unique.push(line);
    }

    return unique;
  }

  async function closePopups() {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    }));

    await sleep(DELAYS.afterClosePopups);
  }

  async function searchTrack(query) {
    await closePopups();

    const searchButton = document.querySelector(CONFIG.SEARCH_BUTTON_SELECTOR);
    if (searchButton && visible(searchButton)) {
      await realClick(searchButton, "кнопка поиска");
      await sleep(DELAYS.afterSearchButtonClick);
    }

    const input = await waitFor(
      "поле поиска YouTube Music",
      () => document.querySelector(CONFIG.SEARCH_INPUT_SELECTOR),
      15000
    );

    input.focus();
    setNativeInputValue(input, "");
    await sleep(DELAYS.afterClearSearchInput);

    setNativeInputValue(input, query);
    log("🔎 Ищу:", query);

    await sleep(DELAYS.beforePressEnter);
    pressEnter(input);
    await sleep(DELAYS.afterSearch);
  }

  function getSearchResults() {
    const selectors = [
      ...CONFIG.RESULT_SELECTORS,
      "ytmusic-card-shelf-renderer",
      "ytmusic-shelf-renderer",
      "ytmusic-responsive-list-item-renderer",
      "ytmusic-two-row-item-renderer"
    ];

    const all = Array.from(document.querySelectorAll(selectors.join(", ")))
      .filter(visible)
      .filter(el => getText(el).length > 0);

    // Убираем вложенные дубли: если один найденный элемент лежит внутри другого,
    // оставляем более конкретный внутренний элемент.
    return all.filter(el => !all.some(other => other !== el && other.contains(el)));
  }

  function looksLikeArtistCard(text) {
    return textContainsAny(text, ["исполнитель", "artist", "подписчиков", "subscribers"]);
  }

  function looksLikeTrackCard(text) {
    const source = normalizeComparable(text);
    const words = source.split(" ");
    const hasTrackWord = textContainsAny(text, ["композиция", "song", "track", "трек"]);
    const hasDuration = words.some(word => {
      const parts = word.split(":");
      return parts.length === 2 && parts[0].length >= 1 && parts[0].length <= 2 && parts[1].length === 2 && parts.every(part => Array.from(part).every(ch => ch >= "0" && ch <= "9"));
    });

    return hasTrackWord || hasDuration;
  }

  function scoreResult(query, resultText) {
    const queryWords = normalizeComparable(query).split(" ").filter(word => word.length > 1);
    const resultSource = normalizeComparable(resultText);

    if (!queryWords.length || !resultSource) return 0;

    const matched = queryWords.filter(word => resultSource.includes(word));
    let score = matched.length / queryWords.length;

    // YouTube Music часто показывает карточку исполнителя выше песни.
    // Нам нужна композиция, поэтому карточку трека усиливаем, а чистую карточку артиста штрафуем.
    if (looksLikeTrackCard(resultText)) score += 0.35;
    if (looksLikeArtistCard(resultText) && !looksLikeTrackCard(resultText)) score -= 0.35;

    return Math.max(0, Math.min(1, score));
  }

  function getFirstMatchingResult(query) {
    const results = getSearchResults();
    if (!results.length) return null;

    const candidates = results.map(el => {
      const text = getText(el);
      return {
        el,
        text,
        score: scoreResult(query, text),
        isTrack: looksLikeTrackCard(text),
        isArtist: looksLikeArtistCard(text)
      };
    });

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.isTrack !== b.isTrack) return a.isTrack ? -1 : 1;
      if (a.isArtist !== b.isArtist) return a.isArtist ? 1 : -1;
      return 0;
    });

    log("📋 Лучший результат:", {
      score: candidates[0].score,
      isTrack: candidates[0].isTrack,
      isArtist: candidates[0].isArtist,
      text: candidates[0].text.slice(0, 240)
    });

    return candidates[0];
  }

  function getButtonSearchText(button) {
    return normalizeText([
      getText(button),
      getText(button.closest("ytmusic-button-renderer")),
      getText(button.closest("yt-button-shape")),
      button.getAttribute("aria-label"),
      button.getAttribute("title")
    ].filter(Boolean).join(" "));
  }

  function findSaveButtonInScope(scope) {
    const root = scope || document;
    const buttons = Array.from(root.querySelectorAll(CONFIG.BUTTON_SELECTORS.join(", "))).filter(visible);

    return buttons.find(button => textContainsAny(getButtonSearchText(button), CONFIG.SAVE_BUTTON_TEXTS));
  }

  async function clickSaveButtonForTrack(query) {
    if (CONFIG.VERIFY_FIRST_RESULT) {
      const best = getFirstMatchingResult(query);

      if (!best) {
        throw new Error("Не найден ни один результат поиска");
      }

      if (best.score < CONFIG.MIN_RESULT_SCORE) {
        result.skipped.push({ track: query, reason: "first-result-low-score", score: best.score, resultText: best.text });
        return "skipped-low-confidence";
      }

      const scopedButton = findSaveButtonInScope(best.el);
      if (scopedButton) {
        await realClick(scopedButton, "Save внутри лучшего результата");
        return "save-clicked";
      }

      log("Не нашёл Save внутри результата, пробую общий поиск кнопки Save.");
    }

    const saveButton = await waitFor(
      "кнопка Сохранить / Save",
      () => findSaveButtonInScope(document),
      15000
    );

    await realClick(saveButton, "Сохранить / Save");
    return "save-clicked";
  }

  function getPlaylistCards() {
    return Array.from(document.querySelectorAll(CONFIG.PLAYLIST_CARD_SELECTORS.join(", "))).filter(visible);
  }

  function playlistCardText(card) {
    return normalizeText([
      getText(card),
      card.querySelector("[title]") && card.querySelector("[title]").getAttribute("title")
    ].filter(Boolean).join(" "));
  }

  function findPlaylistCard() {
    const cards = getPlaylistCards();
    const wanted = normalizeComparable(CONFIG.PLAYLIST_NAME);

    const exact = cards.find(card => {
      const titleNode = card.querySelector("[title]");
      const title = normalizeComparable(titleNode && titleNode.getAttribute("title"));
      const text = normalizeComparable(playlistCardText(card));

      return title === wanted || text === wanted;
    });

    if (exact) return exact;

    return cards.find(card => normalizeComparable(playlistCardText(card)).includes(wanted));
  }

  function findClickableInsidePlaylistCard(card) {
    return (
      card.querySelector("tp-yt-paper-checkbox") ||
      card.querySelector("ytmusic-checkbox") ||
      card.querySelector("ytmusic-thumbnail-renderer") ||
      card.querySelector("img") ||
      card.querySelector(".details") ||
      card
    );
  }

  async function choosePlaylistIfDialogAppears(timeout = DELAYS.playlistDialogTimeout) {
    await sleep(DELAYS.beforePlaylistDialogCheck);

    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      const playlistCard = findPlaylistCard();

      if (playlistCard) {
        log("🎯 Нашёл плейлист:", CONFIG.PLAYLIST_NAME);
        await realClick(findClickableInsidePlaylistCard(playlistCard), `плейлист: ${CONFIG.PLAYLIST_NAME}`);
        await sleep(DELAYS.afterPlaylistClick);
        await closePopups();
        return "added-to-selected-playlist";
      }

      await sleep(DELAYS.playlistDialogCheckInterval);
    }

    return "playlist-dialog-not-found";
  }

  function pageHasSavedHint() {
    const activeLayerText = normalizeText([
      getText(document.querySelector("ytmusic-popup-container")),
      getText(document.querySelector("tp-yt-paper-toast")),
      getText(document.querySelector("yt-notification-action-renderer"))
    ].filter(Boolean).join(" "));

    return textContainsAny(activeLayerText, CONFIG.SAVED_HINT_TEXTS);
  }

  let playlistWasSelectedInThisRun = false;

  async function addCurrentSearchResultToPlaylist(query) {
    const clickStatus = await clickSaveButtonForTrack(query);

    if (clickStatus === "skipped-low-confidence") {
      return "skipped";
    }

    if (!playlistWasSelectedInThisRun) {
      const dialogStatus = await choosePlaylistIfDialogAppears(DELAYS.playlistDialogTimeout);

      if (dialogStatus === "added-to-selected-playlist") {
        playlistWasSelectedInThisRun = true;
        return "added";
      }

      if (pageHasSavedHint()) {
        return "probably-added";
      }

      await closePopups();
      return "uncertain";
    }

    // После первого выбора плейлиста YouTube Music обычно запоминает последний плейлист
    // и следующие нажатия Save добавляют треки туда автоматически, без окна выбора.
    // Поэтому со второго трека не ждём долгий timeout и считаем успешный клик вероятным добавлением.
    const quickDialogStatus = await choosePlaylistIfDialogAppears(1200);

    if (quickDialogStatus === "added-to-selected-playlist") {
      return "added";
    }

    if (pageHasSavedHint()) {
      return "probably-added";
    }

    await closePopups();
    return "probably-added";
  }

  function downloadJsonReport() {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = `ytm-import-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function printSummary() {
    console.log("");
    console.log("Готово.");
    console.log(`✅ Добавлено подтверждённо: ${result.added.length}`);
    console.log(`Быстрое сохранение: ${result.probablyAdded.length}`);
    console.log(`⏭ Пропущено из-за низкой уверенности: ${result.skipped.length}`);
    console.log(`❌ Ошибки: ${result.failed.length}`);
    console.log(`Следующий стартовый индекс: ${result.nextStartFrom}`);
    console.log("Полный результат доступен в window.ytmImportResult");

    if (result.skipped.length) {
      console.log("");
      console.log("Пропущено:");
      console.table(result.skipped);
    }

    if (result.failed.length) {
      console.log("");
      console.log("Ошибки:");
      console.table(result.failed);
    }
  }

  if (!CONFIG.PLAYLIST_NAME || CONFIG.PLAYLIST_NAME === "________") {
    throw new Error("Заполните CONFIG.PLAYLIST_NAME перед запуском скрипта.");
  }

  const raw = await pickTextFile();
  const tracks = parseTracks(raw);
  result.total = tracks.length;

  const savedProgress = readProgress();
  const startFrom = CONFIG.RESUME_FROM_SAVED_PROGRESS && savedProgress
    ? Number(savedProgress.nextStartFrom || 0)
    : Number(CONFIG.START_FROM || 0);

  result.startedFrom = startFrom;
  result.nextStartFrom = startFrom;

  console.log("🎵 YouTube Music importer V2 запущен");
  console.log(`Плейлист: ${CONFIG.PLAYLIST_NAME}`);
  console.log(`Строк после обработки файла: ${tracks.length}`);
  console.log(`Удалено дублей: ${result.duplicatesRemoved}`);
  console.log(`Старт с индекса: ${startFrom} / строки: ${startFrom + 1}`);

  if (savedProgress && CONFIG.RESUME_FROM_SAVED_PROGRESS) {
    console.log("Найден сохранённый прогресс:", savedProgress);
  }

  if (startFrom >= tracks.length) {
    console.log("Все строки уже обработаны. Чтобы начать заново, выполните:");
    console.log(`localStorage.removeItem("${CONFIG.STORAGE_KEY}")`);
    window.ytmImportResult = result;
    return;
  }

  for (let i = startFrom; i < tracks.length; i += 1) {
    if (window.stopYtmImport) {
      console.log("⛔ Остановлено пользователем");
      break;
    }

    const currentTrack = tracks[i];
    console.log("");
    console.log(`[${i + 1}/${tracks.length}] ${currentTrack}`);

    try {
      await searchTrack(currentTrack);
      const status = await addCurrentSearchResultToPlaylist(currentTrack);

      if (status === "added") {
        result.added.push(currentTrack);
        console.log(`✅ Добавлено в выбранный плейлист: ${currentTrack}`);
        saveProgress(i + 1, currentTrack, status);
      } else if (status === "probably-added") {
        result.probablyAdded.push(currentTrack);
        console.log(`🟢 Быстрое сохранение: ${currentTrack}`);
        saveProgress(i + 1, currentTrack, status);
      } else if (status === "skipped") {
        console.log(`⏭ Пропущено из-за низкой уверенности: ${currentTrack}`);
        saveProgress(i + 1, currentTrack, status);
      } else {
        result.failed.push({ track: currentTrack, reason: "unable-to-confirm-add" });
        warn(`❌ Не удалось подтвердить добавление: ${currentTrack}`);

        // Важно: при неопределённой ошибке НЕ двигаем прогресс автоматически.
        // Так трек можно повторить после перезапуска.
        saveProgress(i, currentTrack, status);
      }
    } catch (error) {
      result.failed.push({
        track: currentTrack,
        reason: error && error.message ? error.message : String(error)
      });

      warn(`❌ Ошибка на треке: ${currentTrack}`);
      warn("Причина:", error && error.message ? error.message : error);
      warn(error);

      // Важно: при ошибке сохраняем текущий индекс, а не следующий.
      // Resume попробует этот же трек ещё раз.
      saveProgress(i, currentTrack, "error");

      await closePopups();
    }

    await sleep(DELAYS.betweenTracks);
  }

  result.finished = !window.stopYtmImport && result.nextStartFrom >= tracks.length;

  if (result.finished) {
    clearProgress();
  }

  window.ytmImportResult = result;
  printSummary();
  downloadJsonReport();
})();
