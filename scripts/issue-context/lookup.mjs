// Resolve only tracked repository paths. Issue text may come from a public contributor.
export function readingPaths(body, files) {
  const paths = new Set();
  function add(candidate) {
    const path = candidate.replace(/\/$/, '');
    if (files.has(path)) paths.add(path);
    else if (files.has(path + '/README.md')) paths.add(path + '/README.md');
  }
  for (const match of body.matchAll(/\[([^\r\n]+?)\]\(/g)) add(match[1]);
  // Inline code preserves spaces and Expo's literal route punctuation.
  for (const match of body.matchAll(/\x60([^\x60\r\n]+)\x60/g)) add(match[1]);
  // A prose link can have an arbitrary label. Read the pinned revision's path in the current tree.
  for (const match of body.matchAll(
    /https:\/\/github\.com\/KnowScroll\/knowscroll\/(?:blob|tree)\/[a-f0-9]{40}\/([^\s#<>]+)/gi,
  )) {
    try {
      const path = decodeURIComponent(match[1]);
      add(path);
      add(path.replace(/\)$/, ''));
    } catch {
      // Ignore malformed URL escapes in the brief.
    }
  }
  for (const match of body.matchAll(/(?:^|[\s(\[])([\w.-]+(?:\/[\w.+()[\]-]+)+\/?)/gm)) {
    add(match[1]);
    add(match[1].replace(/[\]).]+$/, ''));
  }
  return [...paths];
}

export function owners(paths, files) {
  const found = new Set();
  for (const path of paths) {
    let dir = path.split('/').slice(0, -1);
    while (dir.length) {
      const readme = dir.join('/') + '/README.md';
      if (files.has(readme)) {
        found.add(readme);
        break;
      }
      dir.pop();
    }
  }
  return [...found];
}

export function headings(source) {
  return [...source.matchAll(/^## (D-\d+) · (?:addendum · )?\d{4}-\d\d-\d\d · (.+)$/gm)].map((match) => ({
    id: match[1],
    title: match[2],
    offset: match.index,
  }));
}

const stop = new Set(
  'which what with from when into that this these where after before should could issue feature users screen there about across enable remove check their working'.split(
    ' ',
  ),
);

function words(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !stop.has(word)));
}

export function ranked(query, items) {
  const terms = words(query);
  return items
    .map((item) => {
      const titleWords = words(item.title);
      const matches = [...terms].filter((term) => titleWords.has(term));
      const score = matches.reduce((sum, word) => sum + Math.min(10, word.length), 0);
      return { item, score };
    })
    .filter((hit) => hit.score)
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.item);
}

export function section(body, name) {
  const parts = body.split(/^#{1,3} (.+)\r?$/m);
  for (let index = 1; index < parts.length; index += 2) {
    if (name.test(parts[index].trim())) return parts[index + 1].trim();
  }
  return '';
}

export function decisionExcerpt(source, sections, id) {
  const excerpts = sections.flatMap((section, index) =>
    section.id === id ? [source.slice(section.offset, sections[index + 1]?.offset ?? source.length).trim()] : [],
  );
  if (!excerpts.length) throw new Error('Unknown decision ' + id + '. Search headings in docs/v2/decisions.md.');
  return excerpts.join('\n\n');
}
