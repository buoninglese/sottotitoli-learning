// scripts/rebuild-spoken-ngsl-core.js
// Rebuilds learning-resources/vocab/spoken-ngsl/core.json
// using your three NGSL-Spoken CSVs, matching your current JSON schema.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEACHING_CSV = path.join(
  ROOT,
  'learning-resources',
  'vocab',
  'spoken-ngsl',
  'NGSL-Spoken_1.2_lemmatized_for_teaching-6.csv'
);
const DEFS_CSV = path.join(
  ROOT,
  'learning-resources',
  'vocab',
  'spoken-ngsl',
  'NGSL-Spoken_1.2_with_en_definitions-8.csv'
);
const STATS_CSV = path.join(
  ROOT,
  'learning-resources',
  'vocab',
  'spoken-ngsl',
  'NGSL-Spoken_1.2_stats-7.csv'
);
const OUT_DIR = path.join(ROOT, 'learning-resources', 'vocab', 'spoken-ngsl');
const OUT_PATH = path.join(OUT_DIR, 'core.json');

// A small list of irregulars to force-add as forms
const EXTRA_IRREGULARS = {
  forget: ['forgets', 'forgot', 'forgetting', 'forgotten'],
  go: ['goes', 'went', 'gone', 'going'],
  get: ['gets', 'got', 'gotten', 'getting'],
  come: ['comes', 'came', 'coming'],
  do: ['does', 'did', 'done', 'doing'],
  have: ['has', 'had', 'having'],
  say: ['says', 'said', 'saying'],
  make: ['makes', 'made', 'making'],
  take: ['takes', 'took', 'taken', 'taking'],
  see: ['sees', 'saw', 'seen', 'seeing'],
  think: ['thinks', 'thought', 'thinking'],
  know: ['knows', 'knew', 'known', 'knowing'],
  give: ['gives', 'gave', 'given', 'giving'],
  find: ['finds', 'found', 'finding']
};

// Minimal CSV parser that handles quoted fields
function parseCsvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    return { header: [], rows: [] };
  }

  const header = splitCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => {
      row[h.trim()] = (cells[idx] || '').trim();
    });
    rows.push(row);
  }

  return { header, rows };
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '"') {
      if (inQuotes && line[j + 1] === '"') {
        current += '"';
        j++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function buildIndex(header, keyCandidates) {
  const lower = header.map(h => h.toLowerCase());
  for (const cand of keyCandidates) {
    const idx = lower.findIndex(h => h === cand);
    if (idx !== -1) return header[idx];
  }
  return null;
}

function main() {
  console.log('Reading NGSL-Spoken CSVs...');
  const teaching = parseCsvFile(TEACHING_CSV);
  const defs = parseCsvFile(DEFS_CSV);
  const stats = parseCsvFile(STATS_CSV);

  // Build column maps
  const teachCols = teaching.header;
  const teachLemmaCol = buildIndex(teachCols, ['lemma', 'lemmas']);
  const teachHeadCol = buildIndex(teachCols, ['headword', 'head lemma', 'head']);
  const teachPosCol = buildIndex(teachCols, ['pos', 'part of speech']);
  const teachFormsCol =
    buildIndex(teachCols, ['forms', 'inflections', 'variants', 'form']) || null;

  const defsCols = defs.header;
  const defsLemmaCol = buildIndex(defsCols, ['lemma', 'lemmas', 'headword']);
  const defsDefCol = buildIndex(defsCols, ['definition', 'definition en', 'def_en']);

  const statsCols = stats.header;
  const statsLemmaCol = buildIndex(statsCols, ['lemma', 'lemmas', 'headword']);
  const statsRankCol = buildIndex(statsCols, ['rank', 'ngsl rank', 'frequency rank']);
  const statsSfiCol = buildIndex(statsCols, ['sfi']);
  const statsBandCol = buildIndex(statsCols, ['freq_band', 'frequency band', 'frequency_band']);

  if (!teachLemmaCol) {
    console.error('Could not find lemma column in teaching CSV:', teachCols);
    process.exit(1);
  }

  console.log('Teaching columns:', {
    lemma: teachLemmaCol,
    headword: teachHeadCol,
    pos: teachPosCol,
    forms: teachFormsCol
  });
  console.log('Defs columns:', { lemma: defsLemmaCol, def: defsDefCol });
  console.log('Stats columns:', {
    lemma: statsLemmaCol,
    rank: statsRankCol,
    sfi: statsSfiCol,
    freqBand: statsBandCol
  });

  // Index defs and stats by lemma
  const defsByLemma = new Map();
  defs.rows.forEach(r => {
    const lemma = (r[defsLemmaCol] || '').toLowerCase().trim();
    if (!lemma) return;
    const def = (defsDefCol && r[defsDefCol]) ? r[defsDefCol].trim() : '';
    if (!def) return;
    // if multiple, keep first non-empty
    if (!defsByLemma.has(lemma)) {
      defsByLemma.set(lemma, def);
    }
  });

  const statsByLemma = new Map();
  stats.rows.forEach(r => {
    const lemma = (r[statsLemmaCol] || '').toLowerCase().trim();
    if (!lemma) return;
    const rankRaw = statsRankCol ? r[statsRankCol] : '';
    const sfiRaw = statsSfiCol ? r[statsSfiCol] : '';
    const bandRaw = statsBandCol ? r[statsBandCol] : '';

    const rank = parseInt(rankRaw || '', 10);
    const sfi = parseFloat(sfiRaw || '');
    const band = bandRaw.trim() || null;

    const entry = {
      rank: Number.isFinite(rank) ? rank : null,
      sfi: Number.isFinite(sfi) ? sfi : null,
      frequencyBand: band
    };
    statsByLemma.set(lemma, entry);
  });

  // Aggregate by lemma
  const byLemma = new Map();

  teaching.rows.forEach(r => {
    const lemmaRaw =
      (teachLemmaCol && r[teachLemmaCol]) ||
      (teachHeadCol && r[teachHeadCol]) ||
      '';
    const lemma = lemmaRaw.toLowerCase().trim();
    if (!lemma) return;

    const pos = teachPosCol ? (r[teachPosCol] || '').trim() : null;
    let entry = byLemma.get(lemma);
    if (!entry) {
      entry = {
        lemma,
        pos: pos || null,
        forms: new Set(),
        definition_en: null,
        rank: null,
        sfi: null,
        frequencyBand: null,
        sources: new Set(),
        tags: new Set()
      };
      byLemma.set(lemma, entry);
    } else if (pos && !entry.pos) {
      entry.pos = pos;
    }

    // base forms
    const head = teachHeadCol ? (r[teachHeadCol] || '').toLowerCase().trim() : '';
    if (head) entry.forms.add(head);
    if (lemma) entry.forms.add(lemma);

    // explicit forms / inflections column if present
    if (teachFormsCol && r[teachFormsCol]) {
      r[teachFormsCol]
        .split(/[;,\s]+/)
        .map(s => s.toLowerCase().trim())
        .filter(Boolean)
        .forEach(f => entry.forms.add(f));
    }

    // mark sources/tags
    entry.sources.add('NGSL-Spoken-teaching');
    entry.tags.add('spoken-core');
  });

  // Merge in defs
  byLemma.forEach(entry => {
    const def = defsByLemma.get(entry.lemma);
    if (def && !entry.definition_en) {
      entry.definition_en = def;
    }
    entry.sources.add('NGSL-Spoken-defs');
  });

  // Merge in stats
  byLemma.forEach(entry => {
    const stats = statsByLemma.get(entry.lemma);
    if (stats) {
      if (stats.rank !== null) entry.rank = stats.rank;
      if (stats.sfi !== null) entry.sfi = stats.sfi;
      if (stats.frequencyBand) entry.frequencyBand = stats.frequencyBand;
      entry.sources.add('NGSL-Spoken-stats');
    }
  });

  // Add extra irregulars
  Object.entries(EXTRA_IRREGULARS).forEach(([lemma, forms]) => {
    lemma = lemma.toLowerCase();
    let entry = byLemma.get(lemma);
    if (!entry) {
      entry = {
        lemma,
        pos: null,
        forms: new Set(),
        definition_en: null,
        rank: null,
        sfi: null,
        frequencyBand: null,
        sources: new Set(['NGSL-Spoken-teaching']),
        tags: new Set(['spoken-core'])
      };
      byLemma.set(lemma, entry);
    }
    forms.forEach(f => entry.forms.add(f.toLowerCase()));
  });

  // Build final entries array sorted by rank then lemma
  const entries = Array.from(byLemma.values())
    .map(e => ({
      lemma: e.lemma,
      pos: e.pos,
      forms: Array.from(e.forms),
      definition_en: e.definition_en,
      rank: e.rank,
      sfi: e.sfi,
      frequencyBand: e.frequencyBand,
      sources: Array.from(e.sources),
      tags: Array.from(e.tags)
    }))
    .sort((a, b) => {
      const ra = a.rank || Number.MAX_SAFE_INTEGER;
      const rb = b.rank || Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.lemma.localeCompare(b.lemma);
    });

  const out = {
    meta: {
      source: 'NGSL-Spoken 1.2',
      language: 'en',
      description: 'Spoken frequency list built from NGSL-Spoken CSV files.'
    },
    entries
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Wrote ${entries.length} entries to ${OUT_PATH}`);
}

main();