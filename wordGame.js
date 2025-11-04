/*
 * Complete rewrite of the word game logic. The UI markup, CSS hooks, and
 * exposed entry points remain identical, but the internals now revolve around a
 * stateful WordGameEngine with a spaced-repetition scheduler and a dedicated
 * renderer. The goals for this rewrite are:
 *   • isolate state management inside a deterministic engine instead of loose
 *     globals
 *   • funnel all DOM work through a renderer layer so the UI can be reused
 *     without duplicating template strings
 *   • replace the ad-hoc incorrect-word queue with a lightweight spaced
 *     repetition system that can prioritise review cards while still drawing
 *     new material
 */

/** ------------------------------------------------------------------------
 * Utilities
 * ----------------------------------------------------------------------- */

const UI_IDS = {
  container: "results-container",
  stats: "game-session-stats",
  bannerPlaceholder: "game-banner-placeholder",
  englishToggle: "game-english-select",
  lockIcon: "lock-icon",
  searchWrapper: "search-bar-wrapper",
  randomButton: "random-btn",
  searchContainer: "search-container-inner",
};

// Preserve the legacy gameActive flag because other scripts rely on it to gate
// certain interactions while the word game is running.
let gameActive = false;

const CLASSNAMES = {
  translationCard: "game-translation-card",
  nextButton: "game-next-word-button",
  englishTranslation: "game-english-translation",
};

const LEVEL_THRESHOLDS = {
  A1: { up: 0.85, down: null },
  A2: { up: 0.9, down: 0.6 },
  B1: { up: 0.94, down: 0.7 },
  B2: { up: 0.975, down: 0.8 },
  C: { up: null, down: 0.9 },
};

const BANNER_MESSAGES = {
  congratulations: [
    "🎉 Fantastic work! You've reached level {X}!",
    "🏅 Congratulations! Level {X} achieved!",
    "🌟 You're shining bright at level {X}!",
    "🚀 Level up! Welcome to level {X}!",
    "👏 Great job! You've advanced to level {X}!",
    "🎯 Target hit! Now at level {X}!",
    "🎓 Smart move! Level {X} unlocked!",
    "🔥 Keep it up! Level {X} is yours!",
    "💡 Brilliant! You've made it to level {X}!",
    "🏆 Victory! Level {X} reached!",
  ],
  fallback: [
    "🔄 Don't worry! You're back at level {X}. Keep going!",
    "💪 Stay strong! Level {X} is a chance to improve.",
    "🌱 Growth time! Revisit level {X} and conquer it.",
    "🎯 Aim steady! Level {X} is your new target.",
    "🚀 Regroup at level {X} and launch again!",
    "🔥 Keep the fire alive! Level {X} awaits.",
    "🧠 Sharpen your skills at level {X}.",
    "🎓 Learning is a journey. Level {X} is part of it.",
    "🏗️ Rebuild your streak starting at level {X}.",
    "💡 Reflect and rise! Level {X} is your step forward.",
  ],
  streak: [
    "🔥 You're on fire with a {X}-word streak!",
    "💪 Power streak! That's {X} in a row!",
    "🎯 Precision mode: {X} correct straight!",
    "🎉 Amazing! You've hit a {X}-word streak!",
    "👏 Well done! {X} correct answers without a miss!",
    "🌟 Stellar performance! {X} consecutive correct answers!",
    "🚀 You're soaring! {X} right answers in a row!",
    "🏆 Champion streak! {X} correct answers and counting!",
    "🎓 Scholar level: {X} correct answers straight!",
    "🧠 Brainpower unleashed! {X} correct answers consecutively!",
  ],
  clearedPracticeWords: [
    "🎉 Awesome! You've cleared all practice words!",
    "👏 Great job! Practice makes perfect.",
    "🌟 Stellar effort! Practice words completed.",
    "🏆 Victory! Practice session conquered.",
    "🚀 You're ready for the next challenge!",
    "🎓 Practice complete! Onward to new words.",
    "🔥 Practice words? Done and dusted!",
    "💡 Bright work! Practice session finished.",
    "🎯 Target achieved! Practice words cleared.",
    "🧠 Brainpower at its best! Practice complete.",
  ],
  levelLock: {
    locked: ["🔒 Level lock enabled. You won’t advance or fall back."],
    unlocked: ["🚀 Level lock disabled. Progression is active."],
  },
};

const BANNERS = {
  congratulations: "game-congratulations-banner",
  fallback: "game-fallback-banner",
  streak: "game-streak-banner",
  clearedPracticeWords: "game-cleared-practice-banner",
  levelLock: "game-lock-banner",
};

const AUDIO_FILES = {
  good: "Resources/Audio/goodChime.wav",
  bad: "Resources/Audio/badChime.wav",
  pop: "Resources/Audio/popChime.wav",
};

const RENDER_CONSTANTS = {
  trickyIcon: '<div class="game-tricky-word"><i class="fa fa-repeat" aria-hidden="true"></i></div>',
  hiddenTrickyIcon:
    '<div class="game-tricky-word" style="visibility: hidden;"><i class="fa fa-repeat" aria-hidden="true"></i></div>',
  trickyIconVisible:
    '<div class="game-tricky-word visible"><i class="fa fa-repeat" aria-hidden="true"></i></div>',
};

const CLOZE_CONFIG = {
  bannedWordClasses: ["numeral", "pronoun", "possessive", "determiner"],
  blank: "<span class=\"cloze-blank\">_____</span>",
};

const SCHEDULER_BUCKETS = [0, 2, 5, 10, 20];

/** ------------------------------------------------------------------------
 * Helpers and formatters
 * ----------------------------------------------------------------------- */

function pickRandom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function shuffle(array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function ensureUniqueDisplayedValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    const trimmed = value.split(",")[0].trim();
    if (seen.has(trimmed.toLowerCase())) return false;
    seen.add(trimmed.toLowerCase());
    return true;
  });
}

function stripHtml(htmlString) {
  const div = document.createElement("div");
  div.innerHTML = htmlString;
  return div.textContent || div.innerText || "";
}

function formatGender(genderRaw = "") {
  const mapping = [
    { match: /^noun/i, label: "Noun" },
    { match: /^masculine/i, label: "N - Masc" },
    { match: /^feminine/i, label: "N - Fem" },
    { match: /^neuter/i, label: "N - Neut" },
    { match: /^adjective/i, label: "Adj" },
    { match: /^adverb/i, label: "Adv" },
    { match: /^conjunction/i, label: "Conj" },
    { match: /^determiner/i, label: "Det" },
    { match: /^expression/i, label: "Exp" },
    { match: /^interjection/i, label: "Inter" },
    { match: /^numeral/i, label: "Num" },
    { match: /^particle/i, label: "Part" },
    { match: /^possessive/i, label: "Poss" },
    { match: /^preposition/i, label: "Prep" },
    { match: /^pronoun/i, label: "Pron" },
    { match: /^verb/i, label: "Verb" },
  ];

  const entry = mapping.find((m) => m.match.test(genderRaw));
  return entry ? entry.label : genderRaw;
}

function formatCEFRLabel(word) {
  switch (word.CEFR) {
    case "A1":
    case "A2":
      return '<div class="game-cefr-label easy">' + word.CEFR + "</div>";
    case "B1":
    case "B2":
      return '<div class="game-cefr-label medium">' + word.CEFR + "</div>";
    case "C":
      return '<div class="game-cefr-label hard">C</div>';
    default:
      console.warn("Missing CEFR value for", word);
      return "";
  }
}

function buildWordAudioUrl(word) {
  const encodedWord = encodeURIComponent(word.toLowerCase());
  return `https://cdn.norwegian.cool/audio/croatian/${encodedWord}.mp3`;
}

function buildPronAudioUrl(sentence) {
  const encodedSentence = encodeURIComponent(sentence.toLowerCase());
  return `https://cdn.norwegian.cool/audio/croatian/sentences/${encodedSentence}.mp3`;
}

function isBaseForm(word, baseWord) {
  return word.toLowerCase() === baseWord.toLowerCase();
}

/** ------------------------------------------------------------------------
 * Audio Controller
 * ----------------------------------------------------------------------- */

class AudioController {
  constructor() {
    this.active = [];
    this.good = new Audio(AUDIO_FILES.good);
    this.bad = new Audio(AUDIO_FILES.bad);
    this.pop = new Audio(AUDIO_FILES.pop);
    this.good.volume = 0.2;
    this.bad.volume = 0.2;
  }

  playGood() {
    this.good.currentTime = 0;
    this.good.play().catch((err) => console.warn("Word audio failed:", err));
  }

  playBad() {
    this.bad.currentTime = 0;
    this.bad.play().catch((err) => console.warn("Word audio failed:", err));
  }

  playPop() {
    this.pop.currentTime = 0;
    this.pop.play().catch((err) => console.warn("Word audio failed:", err));
  }

  playWord(wordObj) {
    if (!wordObj || !wordObj.ord) return;
    const cleanWord = wordObj.ord.split(",")[0].trim();
    const audio = new Audio(buildWordAudioUrl(cleanWord));
    this.active.push(audio);
    audio.play().catch((err) => console.warn("Word audio failed:", err));
  }

  playSentence(exampleSentence = "") {
    if (!exampleSentence) return;
    const cleanSentence = stripHtml(exampleSentence).trim();
    const audio = new Audio(buildPronAudioUrl(cleanSentence));
    this.active.push(audio);
    audio.play().catch((err) => console.warn("Sentence audio failed:", err));
  }

  stopAll() {
    this.active.forEach((audio) => {
      audio.pause();
      audio.currentTime = 0;
    });
    this.active = [];
  }
}

/** ------------------------------------------------------------------------
 * Banner Manager
 * ----------------------------------------------------------------------- */

class BannerManager {
  constructor() {
    this.container = document.getElementById(UI_IDS.bannerPlaceholder);
  }

  ensureContainer() {
    if (!this.container) {
      this.container = document.getElementById(UI_IDS.bannerPlaceholder);
    }
    return this.container;
  }

  hideAll() {
    const container = this.ensureContainer();
    if (container) container.innerHTML = "";
  }

  show(type, level) {
    const container = this.ensureContainer();
    if (!container) return;

    let message = "";
    let markupClass = BANNERS[type] || "";

    if (type === "levelLock") {
      const key = level === "locked" ? "locked" : "unlocked";
      message = pickRandom(BANNER_MESSAGES.levelLock[key]);
      markupClass = BANNERS.levelLock;
    } else {
      message = pickRandom(BANNER_MESSAGES[type]).replace("{X}", level);
    }

    container.innerHTML = `<div class="${markupClass}"><p>${message}</p></div>`;
  }
}

/** ------------------------------------------------------------------------
 * Spaced repetition scheduler
 * ----------------------------------------------------------------------- */

class SpacedRepetitionScheduler {
  constructor(intervals = SCHEDULER_BUCKETS) {
    this.intervals = intervals;
    this.cards = new Map(); // id -> card
    this.dueHeap = [];
    this.newItems = [];
    this.counter = 0;
  }

  reset() {
    this.cards.clear();
    this.dueHeap = [];
    this.newItems = [];
    this.counter = 0;
  }

  now() {
    return Date.now();
  }

  enqueueNew(wordObj, meta = {}) {
    const card = {
      id: `card-${this.counter += 1}`,
      word: wordObj,
      bucket: 0,
      due: this.now(),
      meta: { ...meta },
      consecutiveCorrect: 0,
      isCloze: !!meta.isCloze,
    };
    this.cards.set(card.id, card);
    this.newItems.push(card.id);
    return card.id;
  }

  hasDueCard() {
    const now = this.now();
    return this.dueHeap.some((cardId) => {
      const card = this.cards.get(cardId);
      return card && card.due <= now;
    });
  }

  pullDueCard() {
    const now = this.now();
    let bestCard = null;
    let bestIndex = -1;
    this.dueHeap.forEach((cardId, index) => {
      const card = this.cards.get(cardId);
      if (!card) return;
      if (card.due <= now && bestCard === null) {
        bestCard = card;
        bestIndex = index;
      }
    });
    if (bestCard) {
      this.dueHeap.splice(bestIndex, 1);
      return bestCard;
    }
    return null;
  }

  nextCard(generateFresh) {
    if (this.hasDueCard()) {
      return this.pullDueCard();
    }

    if (this.newItems.length > 0) {
      const id = this.newItems.shift();
      const card = this.cards.get(id);
      if (card) return card;
    }

    const fresh = generateFresh ? generateFresh() : null;
    if (!fresh) return null;

    const id = this.enqueueNew(fresh.word, fresh.meta);
    return this.cards.get(id);
  }

  recordResult(cardId, isCorrect) {
    const card = this.cards.get(cardId);
    if (!card) return;

    if (isCorrect) {
      card.bucket = Math.min(card.bucket + 1, this.intervals.length - 1);
      card.consecutiveCorrect += 1;
    } else {
      card.bucket = Math.max(card.bucket - 1, 0);
      card.consecutiveCorrect = 0;
    }

    const intervalMinutes = this.intervals[card.bucket];
    const delay = intervalMinutes * 60 * 1000;
    card.due = this.now() + delay;

    if (!this.dueHeap.includes(cardId)) {
      this.dueHeap.push(cardId);
    }
  }

  removeCard(cardId) {
    this.cards.delete(cardId);
    this.dueHeap = this.dueHeap.filter((id) => id !== cardId);
    this.newItems = this.newItems.filter((id) => id !== cardId);
  }

  stats() {
    let reviewCount = 0;
    const now = this.now();
    this.dueHeap.forEach((id) => {
      const card = this.cards.get(id);
      if (card && card.due <= now) reviewCount += 1;
    });
    return { reviewCount };
  }
}

/** ------------------------------------------------------------------------
 * Renderer
 * ----------------------------------------------------------------------- */

class WordGameRenderer {
  constructor(audioController, bannerManager) {
    this.audio = audioController;
    this.banners = bannerManager;
    this.container = document.getElementById(UI_IDS.container);
    this.wordStore = [];
    this.translationListener = null;
    this.nextWordListener = null;
  }

  resetWordStore() {
    this.wordStore = [];
  }

  getWordIndex(word) {
    const existingIndex = this.wordStore.findIndex((w) => w === word);
    if (existingIndex !== -1) return existingIndex;
    this.wordStore.push(word);
    return this.wordStore.length - 1;
  }

  ensureContainer() {
    if (!this.container) {
      this.container = document.getElementById(UI_IDS.container);
    }
    return this.container;
  }

  renderStats(stats) {
    const container = document.getElementById(UI_IDS.stats);
    if (!container) return;

    const { correctPercentage, correctStreak, reviewCount, thresholds } = stats;

    let fillColor = "#c7e3b6";
    let fontColor = "#6b9461";

    if (correctPercentage === null) {
      fillColor = "#ddd";
      fontColor = "#444";
    } else if (
      thresholds.down !== null &&
      correctPercentage < thresholds.down * 100
    ) {
      fillColor = "#e9a895";
      fontColor = "#b5634d";
    } else if (
      thresholds.up !== null &&
      correctPercentage < thresholds.up * 100
    ) {
      fillColor = "#f2e29b";
      fontColor = "#a0881c";
    }

    if (!container.querySelector(".level-progress-bar-fill")) {
      container.innerHTML = `
        <div class="game-stats-content" style="width: 100%;">
          <div class="game-stats-correct-box"><p id="streak-count">${correctStreak}</p></div>
          <div class="level-progress-bar-bg" style="flex-grow: 1; border-radius: 10px; overflow: hidden; position: relative;">
            <div class="level-progress-bar-fill" style="width: 0%; background-color: ${fillColor}; height: 100%;"></div>
            <p class="level-progress-label" style="position: absolute; width: 100%; text-align: center; margin: 0; user-select: none; font-family: 'Noto Sans', sans-serif; font-size: 18px; font-weight: 500; z-index: 1; color: ${fontColor}; line-height: 38px;">
              ${correctPercentage === null ? 0 : Math.round(correctPercentage)}%
            </p>
          </div>
          <div class="game-stats-incorrect-box"><p id="review-count">${reviewCount}</p></div>
        </div>
      `;
    }

    const fillEl = container.querySelector(".level-progress-bar-fill");
    const labelEl = container.querySelector(".level-progress-label");
    const streakEl = container.querySelector("#streak-count");
    const reviewEl = container.querySelector("#review-count");

    if (fillEl) {
      fillEl.style.width = `${correctPercentage === null ? 0 : correctPercentage}%`;
      fillEl.style.backgroundColor = fillColor;
    }

    if (labelEl) {
      labelEl.textContent = `${correctPercentage === null ? 0 : Math.round(correctPercentage)}%`;
      labelEl.style.color = fontColor;
    }

    if (streakEl) streakEl.textContent = correctStreak;
    if (reviewEl) reviewEl.textContent = reviewCount;
  }

  renderPronunciation(word) {
    const container = document.getElementById(UI_IDS.bannerPlaceholder);
    if (!container) return;
    if (word.uttale) {
      const uttaleText = word.uttale.split(",")[0].trim();
      container.innerHTML = `<p class="game-pronunciation">${uttaleText}</p>`;
    } else {
      container.innerHTML = "";
    }
  }

  renderFlashcard({ word, translations, isReview }) {
    const container = this.ensureContainer();
    if (!container) return;

    const wordIndex = this.getWordIndex(word);
    const displayedWord = word.ord.split(",")[0].trim();
    const displayedGender = formatGender(word.gender);
    const cefrLabel = formatCEFRLabel(word);
    const trickyBadge = isReview
      ? RENDER_CONSTANTS.trickyIconVisible
      : RENDER_CONSTANTS.hiddenTrickyIcon;

    container.innerHTML = `
      <div class="game-stats-content" id="game-session-stats"></div>
      <div class="game-word-card">
        <div class="game-labels-container">
          <div class="game-label-subgroup">
            <div class="game-gender">${displayedGender}</div>
            ${cefrLabel}
          </div>
          <div id="game-banner-placeholder"></div>
          <div class="game-label-subgroup">
            ${trickyBadge}
            <div class="game-gender" style="visibility: hidden;">${displayedGender}</div>
          </div>
        </div>
        <div class="game-word">
          <h2>${displayedWord}</h2>
        </div>
        <div class="game-cefr-spacer"></div>
      </div>
      <div class="game-grid">
        ${translations
          .map(
            (translation, index) => `
              <div class="game-translation-card" data-id="${wordIndex}" data-index="${index}">
                ${translation.split(",")[0].trim()}
              </div>`
          )
          .join("")}
      </div>
      <div class="game-next-button-container">
        <button id="game-next-word-button" disabled>Next Word</button>
      </div>
    `;
  }

  renderCloze({ word, sentence, options, correctOption, isReview }) {
    const container = this.ensureContainer();
    if (!container) return;

    const wordIndex = this.getWordIndex(word);
    const displayedGender = formatGender(word.gender);
    const cefrLabel = formatCEFRLabel(word);
    const trickyBadge = isReview
      ? RENDER_CONSTANTS.trickyIconVisible
      : RENDER_CONSTANTS.hiddenTrickyIcon;

    container.innerHTML = `
      <div class="game-stats-content" id="game-session-stats"></div>
      <div class="game-word-card">
        <div class="game-labels-container">
          <div class="game-label-subgroup">
            <div class="game-gender">${displayedGender}</div>
            ${cefrLabel}
          </div>
          <div id="game-banner-placeholder"></div>
          <div class="game-label-subgroup">
            ${trickyBadge}
            <div class="game-gender" style="visibility: hidden;">${displayedGender}</div>
          </div>
        </div>
        <div class="game-word">
          <p class="game-cloze-sentence">${sentence}</p>
        </div>
        <div class="game-cefr-spacer">
          <div class="game-english-translation">${word.engelsk}</div>
        </div>
      </div>
      <div class="game-grid">
        ${options
          .map(
            (option, index) => `
              <div class="game-translation-card" data-id="${wordIndex}" data-index="${index}">
                ${option}
              </div>`
          )
          .join("")}
      </div>
      <div class="game-next-button-container">
        <button id="game-next-word-button" disabled>Next Word</button>
      </div>
    `;
  }

  bindTranslations(handler) {
    document.querySelectorAll(`.${CLASSNAMES.translationCard}`).forEach((card) => {
      card.addEventListener("click", (event) => {
        const wordId = Number(event.currentTarget.getAttribute("data-id"));
        const index = Number(event.currentTarget.getAttribute("data-index"));
        const wordObj = this.wordStore[wordId];
        handler({
          selectedText: event.currentTarget.innerText.trim(),
          index,
          word: wordObj,
          element: event.currentTarget,
        });
      });
    });
  }

  bindNextButton(handler) {
    const button = document.getElementById(CLASSNAMES.nextButton);
    if (!button) return;
    button.addEventListener("click", handler);
  }

  highlightAnswer({ element, isCorrect }) {
    if (!element) return;
    element.classList.add(isCorrect ? "correct" : "incorrect");
  }

  showCorrectOption(correctText) {
    document.querySelectorAll(`.${CLASSNAMES.translationCard}`).forEach((card) => {
      if (
        card.innerText.trim().toLowerCase() ===
        correctText.trim().toLowerCase()
      ) {
        card.classList.add("correct");
      }
      card.classList.add("revealed");
    });
  }

  enableNextButton() {
    const button = document.getElementById(CLASSNAMES.nextButton);
    if (button) button.disabled = false;
  }

  disableNextButton() {
    const button = document.getElementById(CLASSNAMES.nextButton);
    if (button) button.disabled = true;
  }
}

/** ------------------------------------------------------------------------
 * Stats Tracker
 * ----------------------------------------------------------------------- */

class StatsTracker {
  constructor() {
    this.answers = [];
    this.correctStreak = 0;
  }

  recordAnswer(isCorrect) {
    this.answers.push(isCorrect ? 1 : 0);
    if (isCorrect) {
      this.correctStreak += 1;
    } else {
      this.correctStreak = 0;
    }
  }

  reset() {
    this.answers = [];
    this.correctStreak = 0;
  }

  getCorrectPercentage() {
    if (this.answers.length === 0) return null;
    const correctCount = this.answers.reduce((a, b) => a + b, 0);
    return (correctCount / this.answers.length) * 100;
  }
}

/** ------------------------------------------------------------------------
 * WordGameEngine
 * ----------------------------------------------------------------------- */

class WordGameEngine {
  constructor() {
    this.state = "idle";
    this.currentCard = null;
    this.currentMode = "flashcard";
    this.currentCEFR = "A1";
    this.correctTranslation = "";
    this.scheduler = new SpacedRepetitionScheduler();
    this.audio = new AudioController();
    this.banners = new BannerManager();
    this.renderer = new WordGameRenderer(this.audio, this.banners);
    this.stats = new StatsTracker();
    this.levelCorrectAnswers = 0;
    this.levelTotalQuestions = 0;
    this.correctlyAnsweredWords = new Set();
    this.levelLock = false;

    this.handleTranslationSelection = this.handleTranslationSelection.bind(this);
    this.handleNextWord = this.handleNextWord.bind(this);
  }

  setLevelLock(isLocked) {
    this.levelLock = isLocked;
  }

  setCEFR(level) {
    this.currentCEFR = level || "A1";
  }

  toggleLevelLock() {
    this.levelLock = !this.levelLock;
    this.banners.show("levelLock", this.levelLock ? "locked" : "unlocked");
  }

  resetForLevelChange() {
    this.scheduler.reset();
    this.stats.reset();
    this.correctlyAnsweredWords.clear();
    this.levelCorrectAnswers = 0;
    this.levelTotalQuestions = 0;
    this.currentCard = null;
    this.correctTranslation = "";
  }

  setState(newState) {
    this.state = newState;
  }

  start() {
    const cefrSelect = document.getElementById("cefr-select");
    if (cefrSelect) {
      this.setCEFR((cefrSelect.value || "A1").toUpperCase());
    }
    this.prepareUI();
    this.setState("loading");
    this.renderer.resetWordStore();
    this.presentNextCard();
  }

  prepareUI() {
    const lockIcon = document.getElementById(UI_IDS.lockIcon);
    if (lockIcon) lockIcon.style.display = "inline";

    const searchContainer = document.getElementById(UI_IDS.searchContainer);
    if (searchContainer) searchContainer.classList.add("word-game-active");

    const searchWrapper = document.getElementById(UI_IDS.searchWrapper);
    if (searchWrapper) searchWrapper.style.display = "none";

    const randomButton = document.getElementById(UI_IDS.randomButton);
    if (randomButton) randomButton.style.display = "none";

    const genreFilterContainer = document.getElementById("genre-filter");
    if (genreFilterContainer) genreFilterContainer.style.display = "none";

    const posFilterContainer = document.querySelector(".pos-filter");
    if (posFilterContainer) posFilterContainer.style.display = "none";

    const gameEnglishFilterContainer = document.querySelector(".game-english-filter");
    if (gameEnglishFilterContainer)
      gameEnglishFilterContainer.style.display = "inline-flex";

    const gameEnglishSelect = document.getElementById(UI_IDS.englishToggle);
    if (gameEnglishSelect) gameEnglishSelect.style.display = "inline-flex";

    const cefrSelect = document.getElementById("cefr-select");
    if (cefrSelect) {
      cefrSelect.disabled = false;
      cefrSelect.classList.remove("disabled");
    }

    showLandingCard(false);
    this.banners.hideAll();
  }

  presentNextCard() {
    this.setState("loading");
    this.renderer.disableNextButton();
    this.audio.stopAll();
    this.banners.hideAll();

    const generateFresh = () => {
      const word = this.fetchRandomWord();
      if (!word) return null;

      const isClozeEligible = this.shouldUseCloze(word);
      return { word, meta: { isClozeEligible } };
    };

    const card = this.scheduler.nextCard(() => generateFresh());
    if (!card) {
      console.warn("No card available to present");
      gameActive = false;
      return;
    }

    this.currentCard = card;
    this.currentMode = this.selectMode(card);

    if (card.bucket > 0) {
      this.audio.playPop();
    }

    if (this.currentMode === "cloze") {
      this.renderCloze(card);
    } else {
      this.renderFlashcard(card);
    }

    this.renderer.renderPronunciation(card.word);

    this.bindInteractions();
    this.renderStats();
    this.setState("presenting");
  }

  selectMode(card) {
    if (card.meta.isClozeEligible && Math.random() < 0.5) {
      return "cloze";
    }
    return "flashcard";
  }

  shouldUseCloze(word) {
    if (!word.gender) return true;
    return !CLOZE_CONFIG.bannedWordClasses.some((banned) =>
      word.gender.toLowerCase().startsWith(banned)
    );
  }

  fetchRandomWord() {
    const availableWords = results.filter((word) => {
      if (word.CEFR !== this.currentCEFR) return false;
      if (noRandom.includes(word.ord.toLowerCase())) return false;
      return true;
    });

    if (availableWords.length === 0) return null;

    const unseen = availableWords.filter(
      (word) => !this.correctlyAnsweredWords.has(word.ord)
    );

    const selectionPool = unseen.length > 0 ? unseen : availableWords;
    const choice = selectionPool[Math.floor(Math.random() * selectionPool.length)];
    return choice;
  }

  bindInteractions() {
    this.renderer.bindTranslations(this.handleTranslationSelection);
    this.renderer.bindNextButton(this.handleNextWord);
  }

  handleNextWord() {
    if (this.state !== "revealed") return;
    this.presentNextCard();
  }

  handleTranslationSelection({ selectedText, word, element }) {
    if (this.state !== "presenting" || !this.currentCard) return;

    const isCorrect = this.currentMode === "cloze"
      ? selectedText.trim().toLowerCase() === this.correctTranslation.trim().toLowerCase()
      : selectedText.trim() === this.correctTranslation.split(",")[0].trim();

    this.stats.recordAnswer(isCorrect);
    this.levelTotalQuestions += 1;
    if (isCorrect) {
      this.levelCorrectAnswers += 1;
      this.audio.playGood();
    } else {
      this.audio.playBad();
    }

    this.renderer.highlightAnswer({ element, isCorrect });
    this.renderer.showCorrectOption(
      this.currentMode === "cloze"
        ? this.correctTranslation
        : this.correctTranslation.split(",")[0].trim()
    );

    this.renderer.enableNextButton();
    this.scheduler.recordResult(this.currentCard.id, isCorrect);

    if (isCorrect) {
      this.correctlyAnsweredWords.add(word.ord);
    }

    this.state = "revealed";
    this.renderStats();
  }

  renderStats() {
    const correctPercentage = this.stats.getCorrectPercentage();
    const thresholds = LEVEL_THRESHOLDS[this.currentCEFR];
    const { reviewCount } = this.scheduler.stats();
    this.renderer.renderStats({
      correctPercentage,
      thresholds,
      reviewCount,
      correctStreak: this.stats.correctStreak,
    });
  }

  renderFlashcard(card) {
    const translations = this.buildFlashcardOptions(card.word);
    this.correctTranslation = card.word.engelsk;
    this.renderer.renderFlashcard({
      word: card.word,
      translations,
      isReview: card.bucket > 0,
    });
  }

  renderCloze(card) {
    const clozeData = this.buildClozeOptions(card.word);

    if (!clozeData) {
      this.renderFlashcard(card);
      return;
    }

    this.correctTranslation = clozeData.correctOption;
    this.renderer.renderCloze({
      word: card.word,
      sentence: clozeData.sentence,
      options: clozeData.options,
      correctOption: clozeData.correctOption,
      isReview: card.bucket > 0,
    });

    if (typeof toggleGameEnglish === "function") {
      toggleGameEnglish();
    }
  }

  buildFlashcardOptions(word) {
    const correct = word.engelsk;
    const incorrects = fetchIncorrectTranslations(word.gender, correct, this.currentCEFR);
    const options = ensureUniqueDisplayedValues(shuffle([correct, ...incorrects]));
    return options;
  }

  buildClozeOptions(word) {
    const exampleText = word.eksempel || "";
    if (!exampleText) return null;

    const sentences = exampleText.split(/(?<=[.!?])\s+/);
    const croatian = sentences.find((sentence) => /[\p{L}]/u.test(sentence));
    if (!croatian) return null;

    const baseWord = word.ord.split(",")[0].trim();
    const cleanSentence = croatian.trim();
    const blankSentence = this.insertBlank(cleanSentence, baseWord, word);
    if (!blankSentence) return null;

    const distractors = generateClozeDistractors(
      baseWord,
      blankSentence.answer,
      word.CEFR,
      word.gender
    );

    const options = ensureUniqueDisplayedValues(
      shuffle([blankSentence.answer, ...distractors])
    ).map((opt) => opt.trim());

    return {
      sentence: blankSentence.sentence,
      correctOption: blankSentence.answer.trim(),
      options,
    };
  }

  insertBlank(sentence, baseWord, wordObj) {
    const tokens = sentence.match(/\p{L}+/gu) || [];
    let clozeTarget = null;
    const lowerBase = baseWord.toLowerCase();

    for (const token of tokens) {
      const cleaned = token.toLowerCase();
      if (isBaseForm(cleaned, lowerBase)) {
        clozeTarget = token;
        break;
      }
    }

    if (!clozeTarget) return null;

    const blanked = sentence.replace(clozeTarget, CLOZE_CONFIG.blank);
    return { sentence: blanked, answer: clozeTarget };
  }
}

/** ------------------------------------------------------------------------
 * Legacy helpers retained from the previous implementation. They are kept
 * outside of the new classes to maintain compatibility with other scripts that
 * might import them.
 * ----------------------------------------------------------------------- */

function fetchIncorrectTranslations(gender, correctTranslation, currentCEFR) {
  const isCapitalized = /^[A-Z]/.test(correctTranslation);

  let incorrectResults = results.filter((entry) => {
    const isMatchingCase = /^[A-Z]/.test(entry.engelsk) === isCapitalized;
    return (
      entry.gender === gender &&
      entry.engelsk !== correctTranslation &&
      entry.CEFR === currentCEFR &&
      isMatchingCase &&
      !noRandom.includes(entry.ord.toLowerCase())
    );
  });

  incorrectResults = shuffle(incorrectResults);

  const displayedTranslationsSet = new Set();
  const incorrectTranslations = [];

  for (let i = 0; i < incorrectResults.length && incorrectTranslations.length < 3; i += 1) {
    const displayedTranslation = incorrectResults[i].engelsk.split(",")[0].trim();
    if (!displayedTranslationsSet.has(displayedTranslation)) {
      incorrectTranslations.push(incorrectResults[i].engelsk);
      displayedTranslationsSet.add(displayedTranslation);
    }
  }

  if (incorrectTranslations.length < 4) {
    const additionalResults = results.filter((entry) => {
      const isMatchingCase = /^[A-Z]/.test(entry.engelsk) === isCapitalized;
      return (
        entry.gender === gender &&
        entry.engelsk !== correctTranslation &&
        isMatchingCase &&
        !noRandom.includes(entry.ord.toLowerCase()) &&
        !displayedTranslationsSet.has(entry.engelsk.split(",")[0].trim())
      );
    });

    for (let i = 0; i < additionalResults.length && incorrectTranslations.length < 3; i += 1) {
      const displayedTranslation = additionalResults[i].engelsk.split(",")[0].trim();
      if (!displayedTranslationsSet.has(displayedTranslation)) {
        incorrectTranslations.push(additionalResults[i].engelsk);
        displayedTranslationsSet.add(displayedTranslation);
      }
    }
  }

  if (incorrectTranslations.length < 4) {
    const fallbackResults = results.filter((entry) => {
      const isMatchingCase = /^[A-Z]/.test(entry.engelsk) === isCapitalized;
      return (
        entry.engelsk !== correctTranslation &&
        isMatchingCase &&
        !noRandom.includes(entry.ord.toLowerCase()) &&
        !displayedTranslationsSet.has(entry.engelsk.split(",")[0].trim())
      );
    });

    for (let i = 0; i < fallbackResults.length && incorrectTranslations.length < 3; i += 1) {
      const displayedTranslation = fallbackResults[i].engelsk.split(",")[0].trim();
      if (!displayedTranslationsSet.has(displayedTranslation)) {
        incorrectTranslations.push(fallbackResults[i].engelsk);
        displayedTranslationsSet.add(displayedTranslation);
      }
    }
  }

  return incorrectTranslations;
}

function generateClozeDistractors(baseWord, correctAnswer, cefr, gender) {
  const normalizedCorrect = correctAnswer.toLowerCase();
  const baseLower = baseWord.toLowerCase();

  const candidates = results.filter((entry) => {
    if (noRandom.includes(entry.ord.toLowerCase())) return false;
    if (entry.CEFR !== cefr) return false;
    if (entry.gender !== gender) return false;
    const stem = entry.ord.split(",")[0].trim().toLowerCase();
    return stem !== baseLower && stem !== normalizedCorrect;
  });

  const selected = [];
  const seen = new Set([baseLower, normalizedCorrect]);

  shuffle(candidates).forEach((entry) => {
    if (selected.length >= 4) return;
    const candidate = entry.ord.split(",")[0].trim();
    const lowered = candidate.toLowerCase();
    if (seen.has(lowered)) return;
    seen.add(lowered);
    selected.push(candidate);
  });

  if (selected.length >= 4) {
    return selected.slice(0, 4);
  }

  const fallbackPool = shuffle(results).filter((entry) => {
    const candidate = entry.ord.split(",")[0].trim().toLowerCase();
    if (seen.has(candidate)) return false;
    return !noRandom.includes(entry.ord.toLowerCase());
  });

  fallbackPool.forEach((entry) => {
    if (selected.length >= 4) return;
    const candidate = entry.ord.split(",")[0].trim();
    const lowered = candidate.toLowerCase();
    if (seen.has(lowered)) return;
    seen.add(lowered);
    selected.push(candidate);
  });

  return selected;
}

/** ------------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */

const wordGameEngine = new WordGameEngine();

async function startWordGame() {
  gameActive = true;
  wordGameEngine.start();
}

const cefrSelect = document.getElementById("cefr-select");
if (cefrSelect) {
  cefrSelect.addEventListener("change", function () {
    const typeValue = document.getElementById("type-select")?.value;
    if (typeValue === "word-game") {
      const selectedCEFR = (this.value || "A1").toUpperCase();
      wordGameEngine.setCEFR(selectedCEFR);
      wordGameEngine.resetForLevelChange();
      gameActive = true;
      wordGameEngine.start();
    }
  });
}

document.addEventListener("keydown", (event) => {
  const typeValue = document.getElementById("type-select")?.value;
  if (event.key === "Enter" && typeValue === "word-game") {
    const nextWordButton = document.getElementById("game-next-word-button");
    if (
      nextWordButton &&
      window.getComputedStyle(nextWordButton).display !== "none"
    ) {
      nextWordButton.click();
    }
  }
});

function toggleGameEnglish() {
  const select = document.getElementById(UI_IDS.englishToggle);
  const shouldShow = select && select.value === "show-english";
  document.querySelectorAll(`.${CLASSNAMES.englishTranslation}`).forEach((node) => {
    node.style.display = shouldShow ? "block" : "none";
  });
}

function stopAllAudio() {
  wordGameEngine.audio.stopAll();
}

function toggleLevelLock() {
  wordGameEngine.toggleLevelLock();
}

// Preserve existing global references that other scripts may use.
window.startWordGame = startWordGame;
window.toggleGameEnglish = toggleGameEnglish;
window.stopAllAudio = stopAllAudio;
window.toggleLevelLock = toggleLevelLock;
window.wordGameEngine = wordGameEngine;
