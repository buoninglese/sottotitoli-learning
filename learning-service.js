/**
 * learning-service.js
 *
 * REST service for:
 *  - Vocab + grammar analysis (lesson reports) using local JSON banks
 *  - Optional Oxford Dictionaries API lookup for dictionary detail
 *
 * Requirements:
 *  - Node 18+ (for global fetch)
 *  - npm install express
 *
 * Folder layout expected:
 *  learning-resources/
 *    vocab/
 *      spoken-ngsl/core.json
 *      longman-comm3000/core.json
 *      oxford3000/core.json
 *    grammar/
 *      egui/units.json
 *      verbs-book/patterns.json
 *
 * Environment variables (optional):
 *  OXFORD_APP_ID
 *  OXFORD_APP_KEY
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ----------------------
// 1. Utility: load JSON
// ----------------------

function loadJson(relativePath) {
  const fullPath = path.join(__dirname, relativePath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  return JSON.parse(raw);
}

// -----------------------------
// 2. Load vocab / grammar banks
// -----------------------------

// Vocab banks
let spokenNgsl = null;
let longmanComm = null;
let oxford3000 = null;

// Grammar banks
let eguiUnits = null;
let verbPatterns = null;

function loadBanks() {
  spokenNgsl = loadJson('learning-resources/vocab/spoken-ngsl/core.json');
  longmanComm = loadJson('learning-resources/vocab/longman-comm3000/core.json');
  oxford3000 = loadJson('learning-resources/vocab/oxford3000/core.json');

  eguiUnits = loadJson('learning-resources/grammar/egui/units.json');
  verbPatterns = loadJson('learning-resources/grammar/verbs-book/patterns.json');
}

// do it once at startup
loadBanks();

// ------------------------
// 3. Build lookup indices
// ------------------------

// NGSL: lemma -> entry
const ngslByLemma = new Map(
  (spokenNgsl.entries || []).map(e => [e.lemma.toLowerCase(), e])
);

// NGSL: form -> lemma mapping using the forms array
const ngslLemmaByForm = new Map();
for (const entry of spokenNgsl.entries || []) {
  const lemma = (entry.lemma || '').toLowerCase();
  if (!lemma) continue;

  // Map lemma to itself
  if (!ngslLemmaByForm.has(lemma)) {
    ngslLemmaByForm.set(lemma, lemma);
  }

  if (Array.isArray(entry.forms)) {
    for (const form of entry.forms) {
      const f = (form || '').toLowerCase();
      if (!f) continue;
      // Only set if not already set, to keep the first mapping
      if (!ngslLemmaByForm.has(f)) {
        ngslLemmaByForm.set(f, lemma);
      }
    }
  }
}

// Longman: lemma -> entry
const longmanByLemma = new Map(
  (longmanComm.entries || []).map(e => [e.lemma.toLowerCase(), e])
);

// Oxford 3000: lemma -> entry
const oxByLemma = new Map(
  (oxford3000.entries || []).map(e => [e.lemma.toLowerCase(), e])
);

// --------------------------
// 4. RoomConfig defaults
// --------------------------

// Default config if caller does not supply one
const defaultRoomConfig = {
  targetLanguage: 'en',
  learnerL1: 'it',
  targetLevel: 'A2',
  vocab: {
    sources: ['spoken-ngsl', 'oxford3000'],
    frequencyBands: ['1-500', '501-1000'],
    maxItemsPerReport: 40,
    includeDefinitions: true,
    includeExamples: false
  },
  grammar: {
    sources: ['egui', 'verbs-book'],
    maxItemsPerReport: 5
  },
  dictionary: {
    enableOxfordLookup: false
  }
};

// simple merge (shallow) between default and user config
function mergeConfig(userConfig = {}) {
  const merged = {
    ...defaultRoomConfig,
    ...userConfig,
    vocab: {
      ...defaultRoomConfig.vocab,
      ...(userConfig.vocab || {})
    },
    grammar: {
      ...defaultRoomConfig.grammar,
      ...(userConfig.grammar || {})
    },
    dictionary: {
      ...defaultRoomConfig.dictionary,
      ...(userConfig.dictionary || {})
    }
  };
  return merged;
}

// -------------------------------
// 5. Vocab analysis implementation
// -------------------------------

/**
 * Normalize a line of text to tokens (lowercase words).
 */
function tokenize(line) {
  return (line.toLowerCase().match(/[a-z']+/g) || []);
}

/**
 * Analyze vocab usage in transcriptLines based on config.
 * transcriptLines: array of strings
 * config: merged room config
 */
function analyzeVocab(transcriptLines, config) {
  const results = new Map(); // lemma -> stats

  for (const [lineIndex, line] of transcriptLines.entries()) {
    const tokens = tokenize(line);
    for (const token of tokens) {
      const form = token.toLowerCase();
      // Map form -> lemma using NGSL forms; fall back to the token itself
      const lemma = (ngslLemmaByForm.get(form) || form);
      const ngslEntry = ngslByLemma.get(lemma);
      if (!ngslEntry) continue;

      // Filter by frequency bands (if specified)
      if (
        Array.isArray(config.vocab.frequencyBands) &&
        config.vocab.frequencyBands.length > 0 &&
        !config.vocab.frequencyBands.includes(ngslEntry.frequencyBand)
      ) {
        continue;
      }

      let item = results.get(lemma);
      if (!item) {
        const oxEntry = oxByLemma.get(lemma);
        const longmanEntry = longmanByLemma.get(lemma);

        item = {
          lemma,
          occurrences: 0,
          lines: [],
          // meta
          level: oxEntry ? oxEntry.level || null : null,
          rank: ngslEntry.rank || null,
          sfi: ngslEntry.sfi || null,
          frequencyBand: ngslEntry.frequencyBand || null,
          definition_en: config.vocab.includeDefinitions
            ? (ngslEntry.definition_en || null)
            : null,
          sources: [],
          tags: []
        };

        // build source + tags
        const srcs = new Set();
        const tags = new Set();

        if (ngslEntry.sources) ngslEntry.sources.forEach(s => srcs.add(s));
        if (ngslEntry.tags) ngslEntry.tags.forEach(t => tags.add(t));

        if (oxEntry) {
          srcs.add('oxford3000');
          (oxEntry.tags || []).forEach(t => tags.add(t));
        }
        if (longmanEntry) {
          srcs.add('longman-comm3000');
          (longmanEntry.tags || []).forEach(t => tags.add(t));
        }

        item.sources = Array.from(srcs);
        item.tags = Array.from(tags);

        results.set(lemma, item);
      }

      item.occurrences += 1;
      item.lines.push(lineIndex);
    }
  }

  // Turn map -> sorted array & limit
  const arr = Array.from(results.values());
  arr.sort((a, b) => {
    // sort by rank ascending, then lemma
    const ra = a.rank || Number.MAX_SAFE_INTEGER;
    const rb = b.rank || Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.lemma.localeCompare(b.lemma);
  });

  return arr.slice(0, config.vocab.maxItemsPerReport || 40);
}

// --------------------------------
// 6. Grammar analysis implementation
// --------------------------------

/**
 * Very simple pattern-based grammar analysis.
 * You can extend this as you build more patterns.
 */
function analyzeGrammar(transcriptLines, config) {
  const suggestions = [];

  const text = transcriptLines.join('\n').toLowerCase();

  // helpers to push unit/pattern if conditions met & enabled
  function addUnit(id) {
    if (!config.grammar.sources.includes('egui')) return;
    const unit = (eguiUnits.units || []).find(u => u.id === id);
    if (unit) suggestions.push({ source: 'egui', ...unit });
  }

  function addPattern(id) {
    if (!config.grammar.sources.includes('verbs-book')) return;
    const pattern = (verbPatterns.patterns || []).find(p => p.id === id);
    if (pattern) suggestions.push({ source: 'verbs-book', ...pattern });
  }

  // Example heuristic 1: present continuous
  const presentContMatches = (text.match(/\b(am|is|are)\s+\w+ing\b/g) || []).length;
  if (presentContMatches >= 5) {
    addUnit('EGIU-01'); // you define this in units.json
  }

  // Example heuristic 2: present simple
  const presentSimpleMatches = (text.match(/\b(he|she|it)\s+\w+s\b/g) || []).length;
  if (presentSimpleMatches >= 5) {
    addUnit('EGIU-02');
  }

  // Example heuristic 3: verb + to + infinitive pattern
  const toInfMatches = (text.match(/\b(want|need|plan|decide)\s+to\s+\w+\b/g) || []).length;
  if (toInfMatches >= 3) {
    addPattern('V-INF-TO');
  }

  // Limit suggestions
  return suggestions.slice(0, config.grammar.maxItemsPerReport || 5);
}

// ---------------------------
// 7. Lesson report endpoint
// ---------------------------

/**
 * POST /lesson-report
 *
 * Body JSON:
 * {
 *   "roomId": "abc123",          // optional
 *   "config": { ... },           // optional roomConfig override
 *   "transcriptLines": [ "..."]  // required: array of strings
 * }
 *
 * Returns:
 * {
 *   "roomId": "abc123",
 *   "config": { ...mergedConfig },
 *   "vocab": [ ... ],
 *   "grammar": [ ... ],
 *   "meta": { ... }
 * }
 */
app.post('/lesson-report', (req, res) => {
  try {
    const { roomId, config: userConfig, transcriptLines } = req.body;

    if (!Array.isArray(transcriptLines)) {
      return res.status(400).json({ error: 'transcriptLines must be an array of strings' });
    }

    const config = mergeConfig(userConfig);

    const vocabReport = analyzeVocab(transcriptLines, config);
    const grammarReport = analyzeGrammar(transcriptLines, config);

    const response = {
      roomId: roomId || null,
      config,
      vocab: vocabReport,
      grammar: grammarReport,
      meta: {
        transcriptLength: transcriptLines.length,
        generatedAt: new Date().toISOString()
      }
    };

    res.json(response);
  } catch (err) {
    console.error('Error in /lesson-report:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------
// 8. Optional Oxford dictionary integration
// ----------------------------------------

const OXFORD_APP_ID = process.env.OXFORD_APP_ID || null;
const OXFORD_APP_KEY = process.env.OXFORD_APP_KEY || null;

// Very simple in-memory rate limit for demo: word -> { count, resetAt }
const oxfordRateState = {
  totalCount: 0,
  resetAt: Date.now() + 24 * 60 * 60 * 1000, // next day
  perWord: new Map()
};

const DAILY_TOTAL_LIMIT = 500;     // tune this
const DAILY_PER_WORD_LIMIT = 50;   // tune this

function resetOxfordCountersIfNeeded() {
  const now = Date.now();
  if (now >= oxfordRateState.resetAt) {
    oxfordRateState.totalCount = 0;
    oxfordRateState.perWord.clear();
    oxfordRateState.resetAt = now + 24 * 60 * 60 * 1000;
  }
}

function canCallOxford(word) {
  resetOxfordCountersIfNeeded();

  if (oxfordRateState.totalCount >= DAILY_TOTAL_LIMIT) return false;

  const key = word.toLowerCase();
  const entry = oxfordRateState.perWord.get(key) || { count: 0 };
  if (entry.count >= DAILY_PER_WORD_LIMIT) return false;

  return true;
}

function registerOxfordCall(word) {
  oxfordRateState.totalCount += 1;
  const key = word.toLowerCase();
  const entry = oxfordRateState.perWord.get(key) || { count: 0 };
  entry.count += 1;
  oxfordRateState.perWord.set(key, entry);
}

/**
 * Trim Oxford API response to a learner-friendly subset.
 */
function trimOxfordResponse(apiJson) {
  const result = {
    lemma: null,
    lexicalEntries: []
  };

  if (!apiJson || !Array.isArray(apiJson.results) || apiJson.results.length === 0) {
    return result;
  }

  const firstResult = apiJson.results[0];
  result.lemma = firstResult.id || null;

  if (Array.isArray(firstResult.lexicalEntries)) {
    result.lexicalEntries = firstResult.lexicalEntries.map(le => {
      const out = {
        lexicalCategory: le.lexicalCategory && le.lexicalCategory.text,
        entries: []
      };

      if (Array.isArray(le.entries)) {
        out.entries = le.entries.map(e => {
          const senses = [];
          if (Array.isArray(e.senses)) {
            e.senses.forEach(s => {
              const def = (s.definitions && s.definitions[0]) || null;
              const ex = (s.examples && s.examples[0] && s.examples[0].text) || null;
              if (def || ex) {
                senses.push({ definition: def, example: ex });
              }
            });
          }
          return { senses };
        });
      }

      return out;
    });
  }

  return result;
}

/**
 * GET /dictionary/:word
 *
 * Query param:
 *  ?useOxford=true  (default true if env keys are present)
 *
 * Returns:
 * {
 *   "word": "forget",
 *   "fromLocal": {...}
 *   "fromOxford": {...}
 *   "rateLimited": false
 * }
 */
app.get('/dictionary/:word', async (req, res) => {
  try {
    const word = (req.params.word || '').toLowerCase().trim();
    if (!word) {
      return res.status(400).json({ error: 'Missing word' });
    }

    const useOxfordParam = req.query.useOxford;
    const useOxford =
      (useOxfordParam === undefined || useOxfordParam === 'true') &&
      OXFORD_APP_ID &&
      OXFORD_APP_KEY;

    // local info
    const local = {};
    const lemma = (ngslLemmaByForm.get(word) || word);

    const ngslEntry = ngslByLemma.get(lemma);
    const oxEntry = oxByLemma.get(lemma);
    const longmanEntry = longmanByLemma.get(lemma);

    if (ngslEntry) {
      local.ngsl = {
        lemma,
        definition_en: ngslEntry.definition_en || null,
        rank: ngslEntry.rank || null,
        sfi: ngslEntry.sfi || null,
        frequencyBand: ngslEntry.frequencyBand || null
      };
    }

    if (oxEntry) {
      local.oxford3000 = {
        lemma,
        level: oxEntry.level || null,
        wordClass: oxEntry.wordClass || null
      };
    }

    if (longmanEntry) {
      local.longman = {
        lemma,
        spokenBand: longmanEntry.spokenBand || null,
        writtenBand: longmanEntry.writtenBand || null
      };
    }

    let fromOxford = null;
    let rateLimited = false;

    if (useOxford) {
      if (!canCallOxford(word)) {
        rateLimited = true;
      } else {
        const url = `https://od-api.oxforddictionaries.com/api/v2/words/en-gb?q=${encodeURIComponent(
          word
        )}`;
        const resp = await fetch(url, {
          headers: {
            'app_id': OXFORD_APP_ID,
            'app_key': OXFORD_APP_KEY
          }
        });

        if (resp.ok) {
          registerOxfordCall(word);
          const data = await resp.json();
          fromOxford = trimOxfordResponse(data);
        } else if (resp.status === 404) {
          fromOxford = null;
        } else {
          // For other errors, log and return null
          console.error('Oxford API error:', resp.status, await resp.text());
        }
      }
    }

    res.json({
      word,
      fromLocal: local,
      fromOxford,
      rateLimited
    });
  } catch (err) {
    console.error('Error in /dictionary/:word:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/debug/ngsl-forget', (req, res) => {
  const entry = ngslByLemma.get('forget');
  const mappedForgot = ngslLemmaByForm.get('forgot');
  res.json({
    hasForgetEntry: !!entry,
    forms: entry ? entry.forms : null,
    mappedForgot
  });
});
// ---------------------
// 9. Start the server
// ---------------------

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Learning service listening on port ${PORT}`);
});