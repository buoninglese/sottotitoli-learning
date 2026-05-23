/**
 * tools/build-banks.js
 *
 * Run with:
 *   node tools/build-banks.js
 *
 * It will:
 *  - Read your NGSL Spoken CSVs and build learning-resources/vocab/spoken-ngsl/core.json
 *  - Read your Oxford 3000 Word File (plain text export) and build learning-resources/vocab/oxford3000/core.json
 *
 * Adjust input paths if your filenames differ.
 */

const fs = require('fs');
const path = require('path');

function readText(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function readCsv(relPath) {
  const text = readText(relPath).replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter(line => line.trim() !== '');
  return lines.map(line => line.split(','));
}

// -----------------------
// 1. Build spoken NGSL
// -----------------------

function buildSpokenNgsl() {
  // Adjust filenames here if needed
  const teachingCsv = readCsv('NGSL-Spoken_1.2_lemmatized_for_teaching-6.csv');
  const defsCsv = readCsv('NGSL-Spoken_1.2_with_en_definitions-8.csv');
  const statsCsv = readCsv('NGSL-Spoken_1.2_stats-7.csv');

  // Build maps from lemma -> data
  const formsByLemma = new Map();
  for (const row of teachingCsv) {
    if (!row[0]) continue;
    const lemma = row[0].trim().toLowerCase();
    const forms = row.map(c => c.trim()).filter(Boolean);
    formsByLemma.set(lemma, forms);
  }

  const defByLemma = new Map();
  for (const row of defsCsv) {
    if (!row[0]) continue;
    const lemma = row[0].trim().toLowerCase();
    const def = row[1] ? row[1].trim() : '';
    defByLemma.set(lemma, def || null);
  }

  const statsByLemma = new Map();
  for (const row of statsCsv) {
    if (!row[0]) continue;
    const lemma = row[0].trim().toLowerCase();
    const rank = row[1] ? parseInt(row[1], 10) : null;
    const sfi = row[2] ? parseFloat(row[2]) : null;
    statsByLemma.set(lemma, { rank, sfi });
  }

  function bandFromRank(rank) {
    if (!rank || isNaN(rank)) return null;
    if (rank <= 500) return '1-500';
    if (rank <= 1000) return '501-1000';
    if (rank <= 1500) return '1001-1500';
    if (rank <= 2000) return '1501-2000';
    if (rank <= 2500) return '2001-2500';
    return '2501+';
  }

  const entries = [];
  for (const [lemma, forms] of formsByLemma.entries()) {
    const def = defByLemma.get(lemma) || null;
    const stats = statsByLemma.get(lemma) || { rank: null, sfi: null };
    const frequencyBand = bandFromRank(stats.rank);

    entries.push({
      lemma,
      pos: null,
      forms,
      definition_en: def,
      rank: stats.rank,
      sfi: stats.sfi,
      frequencyBand,
      sources: [
        'NGSL-Spoken-teaching',
        ...(def ? ['NGSL-Spoken-defs'] : []),
        ...(stats.rank != null ? ['NGSL-Spoken-stats'] : [])
      ],
      tags: ['spoken-core']
    });
  }

  // Sort by rank, then lemma
  entries.sort((a, b) => {
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

  const outPath = path.join(__dirname, '..', 'learning-resources/vocab/spoken-ngsl/core.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Written ${entries.length} NGSL spoken entries to ${outPath}`);
}

// -----------------------
// 2. Build Oxford 3000
// -----------------------

/**
 * For Oxford 3000, we only have a text/word file.
 * We’ll extract lemmas and leave level/wordClass as null for now unless
 * the file contains explicit markers you can later enhance manually.
 */
function buildOxford3000() {
  // Adjust this filename if needed; you may need a .txt export instead of .doc
  const raw = readText('The_Oxford_3000-Word-File-11.doc');

  // Very simple extraction: each line that starts with '· ' then a word
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  const seen = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('· ')) continue;
    const rest = trimmed.slice(2).trim();
    if (!rest) continue;

    // word until first space
    const match = rest.match(/^([A-Za-z-]+)/);
    if (!match) continue;
    const lemma = match[1].toLowerCase();

    if (seen.has(lemma)) continue;
    seen.add(lemma);

    entries.push({
      lemma,
      level: null,
      wordClass: [],
      tags: ['oxford3000']
    });
  }

  entries.sort((a, b) => a.lemma.localeCompare(b.lemma));

  const out = {
    meta: {
      source: 'Oxford 3000',
      language: 'en',
      description: 'Core Oxford 3000 lemma list extracted from word file.'
    },
    entries
  };

  const outPath = path.join(__dirname, '..', 'learning-resources/vocab/oxford3000/core.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Written ${entries.length} Oxford 3000 entries to ${outPath}`);
}

// -----------------------
// 3. Run builders
// -----------------------

buildSpokenNgsl();
buildOxford3000();