/**
 * learning-service.js
 *
 * REST service for:
 *  - Vocab + grammar analysis (lesson reports) using local JSON banks
 *  - Optional Oxford Dictionaries API lookup for dictionary detail
 */

const fs = require('fs');
const path = require('path');
const express = require('express'); const cors = require('cors');

const app = express();
app.use(cors({
  origin: (origin, cb) => {
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  }
}));
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

  if (!ngslLemmaByForm.has(lemma)) {
    ngslLemmaByForm.set(lemma, lemma);
  }

  if (Array.isArray(entry.forms)) {
    for (const form of entry.forms) {
      const f = (form || '').toLowerCase();
      if (!f) continue;
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

function tokenize(line) {
  return (line.toLowerCase().match(/[a-z']+/g) || []);
}

/**
 * Analyze vocab usage in transcriptLines based on config.
 * Returns:
 * {
 *   items: [...],            // per-lemma items
 *   lexicalOverview: {...}   // counts by pos, bands, sources
 * }
 */
function analyzeVocab(transcriptLines, config) {
  const results = new Map();

  const posCounts = { verb: 0, noun: 0, adj: 0, adv: 0, other: 0 };
  const bandCounts = {};
  const sourceCounts = { 'spoken-ngsl': 0, oxford3000: 0, longman3000: 0 };

  for (const [lineIndex, line] of transcriptLines.entries()) {
    const tokens = tokenize(line);
    for (const token of tokens) {
      const form = token.toLowerCase();
      const lemma = (ngslLemmaByForm.get(form) || form);
      const ngslEntry = ngslByLemma.get(lemma);
      if (!ngslEntry) continue;

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
          level: oxEntry ? oxEntry.level || null : null,
          rank: ngslEntry.rank || null,
          sfi: ngslEntry.sfi || null,
          frequencyBand: ngslEntry.frequencyBand || null,
          definition_en: config.vocab.includeDefinitions
            ? (ngslEntry.definition_en || null)
            : null,
          pos: ngslEntry.pos || (oxEntry && oxEntry.wordClass) || null,
          sources: [],
          tags: []
        };

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

  const arr = Array.from(results.values());
  arr.sort((a, b) => {
    const ra = a.rank || Number.MAX_SAFE_INTEGER;
    const rb = b.rank || Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.lemma.localeCompare(b.lemma);
  });

  const seenNgsl = new Set();
  const seenOxford = new Set();
  const seenLongman = new Set();

  for (const item of arr) {
    const coarsePos = (item.pos || '').toLowerCase();
    if (coarsePos.startsWith('v')) posCounts.verb++;
    else if (coarsePos.startsWith('n')) posCounts.noun++;
    else if (coarsePos.startsWith('adj')) posCounts.adj++;
    else if (coarsePos.startsWith('adv')) posCounts.adv++;
    else posCounts.other++;

    const band = item.frequencyBand || 'unknown';
    bandCounts[band] = (bandCounts[band] || 0) + 1;

    if (item.sources.includes('NGSL-Spoken-teaching')) {
      seenNgsl.add(item.lemma);
    }
    if (item.sources.includes('oxford3000')) {
      seenOxford.add(item.lemma);
    }
    if (item.sources.includes('longman-comm3000')) {
      seenLongman.add(item.lemma);
    }
  }

  sourceCounts['spoken-ngsl'] = seenNgsl.size;
  sourceCounts.oxford3000 = seenOxford.size;
  sourceCounts.longman3000 = seenLongman.size;

  const lexicalOverview = {
    totalDistinct: arr.length,
    posCounts,
    bandCounts,
    sourceCounts
  };

  return {
    items: arr.slice(0, config.vocab.maxItemsPerReport || 40),
    lexicalOverview
  };
}

// --------------------------------
// 6. Grammar analysis implementation
// --------------------------------

function analyzeGrammar(transcriptLines, config) {
  const suggestions = [];
  const text = transcriptLines.join('\n').toLowerCase();

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

  const presentContMatches = (text.match(/\b(am|is|are)\s+\w+ing\b/g) || []).length;
  if (presentContMatches >= 5) {
    addUnit('EGIU-01');
  }

  const presentSimpleMatches = (text.match(/\b(he|she|it)\s+\w+s\b/g) || []).length;
  if (presentSimpleMatches >= 5) {
    addUnit('EGIU-02');
  }

  const toInfMatches = (text.match(/\b(want|need|plan|decide)\s+to\s+\w+\b/g) || []).length;
  if (toInfMatches >= 3) {
    addPattern('V-INF-TO');
  }

  const items = suggestions.slice(0, config.grammar.maxItemsPerReport || 5);

  const levelCounts = {};
  for (const item of items) {
    const level = item.level || 'unknown';
    levelCounts[level] = (levelCounts[level] || 0) + 1;
  }

  return {
    items,
    overview: {
      levelCounts
    }
  };
}

// ---------------------------
// 7. Metrics + summary
// ---------------------------

function computeMetrics(transcriptLines) {
  const text = transcriptLines.join(' ').trim();
  if (!text) {
    return {
      totalWords: 0,
      totalChars: 0,
      durationMinutes: null,
      wpm: null,
      fillersPerMinute: null,
      lexicalDiversity: null,
      uniqueWords: 0,
      qualityScore: null
    };
  }

  const tokens = tokenize(text);
  const totalWords = tokens.length;
  const totalChars = text.length;

  const fillers = ['uh', 'um', 'ehm', 'erm', 'you know', 'like'];
  const lower = text.toLowerCase();
  let fillersCount = 0;
  fillers.forEach(f => {
    const re = new RegExp(f.replace(' ', '\\s+'), 'g');
    const matches = lower.match(re);
    if (matches) fillersCount += matches.length;
  });

  const unique = new Set(tokens).size;
  const lexicalDiversity = totalWords > 0 ? unique / totalWords : null;

  let qualityScore = 50;
  if (lexicalDiversity !== null) {
    if (lexicalDiversity >= 0.45) qualityScore += 20;
    else if (lexicalDiversity >= 0.35) qualityScore += 12;
    else if (lexicalDiversity >= 0.25) qualityScore += 6;
  }
  if (fillersCount <= 3) qualityScore += 10;
  if (qualityScore < 0) qualityScore = 0;
  if (qualityScore > 100) qualityScore = 100;

  return {
    totalWords,
    totalChars,
    durationMinutes: null,
    wpm: null,
    fillersPerMinute: null,
    lexicalDiversity,
    uniqueWords: unique,
    qualityScore
  };
}

function buildSummary(transcriptLines, metrics, lexicalOverview, grammarResult) {
  const parts = [];

  if (metrics.totalWords === 0) {
    return 'No speech was captured for this lesson.';
  }

  const approxLevel = 'A2–B1';
  parts.push(
    `In this lesson you produced about ${metrics.totalWords} words of spoken English, with a vocabulary range consistent with ${approxLevel} learners.`
  );

  const { posCounts } = lexicalOverview;
  if (posCounts.verb > 0 || posCounts.adj > 0) {
    parts.push(
      'You used a good mix of verbs and describing words, including several useful action verbs.'
    );
  }

  if (metrics.lexicalDiversity !== null) {
    const ld = metrics.lexicalDiversity;
    if (ld >= 0.45) {
      parts.push('Your vocabulary was quite varied for the length of the session.');
    } else if (ld >= 0.3) {
      parts.push(
        'Your vocabulary had a reasonable amount of variety, with room to recycle and expand key words.'
      );
    } else {
      parts.push(
        'You tended to repeat the same words; future lessons can focus on adding and recycling new vocabulary.'
      );
    }
  }

  if (grammarResult.items && grammarResult.items.length > 0) {
    parts.push(
      'You demonstrated some useful grammar patterns; these can be reused and expanded in future conversations.'
    );
  }

  return parts.join(' ');
}

// ---------------------------
// 8. Lesson report endpoint
// ---------------------------

app.post('/lesson-report', (req, res) => {
      if (process.env.INTERNAL_API_KEY && req.headers['x-api-key'] !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  try {
    const { roomId, config: userConfig, transcriptLines } = req.body;

    if (!Array.isArray(transcriptLines)) {
      return res
        .status(400)
        .json({ error: 'transcriptLines must be an array of strings' });
    }

    // Input length limits
    if (transcriptLines.length > 500) {
      return res.status(400).json({ error: 'Transcript exceeds maximum length (500 lines)' });
    }
    const totalChars = transcriptLines.reduce((sum, l) => sum + l.length, 0);
    if (totalChars > 50000) {
      return res.status(400).json({ error: 'Transcript exceeds maximum text length' });
    }

    const config = mergeConfig(userConfig);

    const vocabResult = analyzeVocab(transcriptLines, config);
    const grammarResult = analyzeGrammar(transcriptLines, config);
    const metrics = computeMetrics(transcriptLines);
    const summary = buildSummary(
      transcriptLines,
      metrics,
      vocabResult.lexicalOverview,
      grammarResult
    );

    const response = {
      roomId: roomId || null,
      config,
      vocab: vocabResult.items,
      grammar: grammarResult.items,
      summary,
      lexicalOverview: vocabResult.lexicalOverview,
      grammarOverview: grammarResult.overview,
      metrics,
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
// 9. Oxford dictionary integration
// ----------------------------------------

const OXFORD_APP_ID = process.env.OXFORD_APP_ID || null;
const OXFORD_APP_KEY = process.env.OXFORD_APP_KEY || null;

const oxfordRateState = {
  totalCount: 0,
  resetAt: Date.now() + 24 * 60 * 60 * 1000,
  perWord: new Map()
};

const DAILY_TOTAL_LIMIT = 500;
const DAILY_PER_WORD_LIMIT = 50;

// Simple in-memory dictionary cache
const dictionaryCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

app.get('/dictionary/:word', async (req, res) => {
      if (process.env.INTERNAL_API_KEY && req.headers['x-api-key'] !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  try {
       const word = (req.params.word || '').toLowerCase().trim();
    if (!word) {
      return res.status(400).json({ error: 'Missing word' });
    }

    // Check cache
    const cacheKey = word;
    const cached = dictionaryCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
      return res.json(cached.data);
    }

    const useOxfordParam = req.query.useOxford;
    const useOxford =
      (useOxfordParam === undefined || useOxfordParam === 'true') &&
      OXFORD_APP_ID &&
      OXFORD_APP_KEY;

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
        frequencyBand: ngslEntry.frequencyBand || null,
        pos: ngslEntry.pos || null
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
          console.error('Oxford API error:', resp.status);  // log server-side only
        }
      }
    }

    const responseData = {
      word,
      fromLocal: local,
      fromOxford,
      rateLimited
    };

    // Store in cache
    dictionaryCache.set(cacheKey, { ts: Date.now(), data: responseData });

    res.json(responseData);
  } catch (err) {
    console.error('Error in /dictionary/:word:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------
// 10. Debug endpoint
// ---------------------

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
// 11. Start the server
// ---------------------

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Learning service listening on port ${PORT}`);
});
