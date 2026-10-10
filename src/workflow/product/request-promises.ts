/** A browser or screen interface is mentioned; the request may then promise how it looks or feels. */
const UI_INTENT =
  /\b(?:browser|website|web\s*(?:app|game|page|site|interface|ui)|webpage|front-?end|dashboard|landing\s+page|canvas|html|css|gui|user\s+interface|ui)\b/i;

/** Wording that promises look, feel, feedback or a preview. */
const STRONG_CUES = [
  /\blook(?:s)?\s*(?:and|&)\s*feel\b/i,
  /\b(?:feel|feels|look|looks)\s+like\b/i,
  /\bin\s+the\s+(?:spirit|style|vein)\s+of\b/i,
  /\b\w+[-–]style\b/i,
  /\b(?:game|app|site|page|ui|interface)\s+like\s+[A-Z]/,
  /\b(?:polish(?:ed)?|refined|beautiful|attractive|gorgeous|elegant|slick|delightful|playful|intuitive|fun)\b/i,
  /\banimat(?:e|es|ed|ion|ions)\b/i,
  /\breadable\s+colou?rs?\b/i,
  /\b(?:visual|visible)\s+(?:\w+\s+){0,2}(?:arc|trail|trajectory|explosion|effect|effects|feedback|flames?|indicator|preview|guide)\b/i,
  /\bsimple\s+feedback\b/i,
  /\b(?:dotted\s+)?preview\b/i,
  /\bghost\b/i,
  /\btrajectory\b/i,
  /\baim(?:ing)?\s+(?:line|guide)\b/i,
  /\bdotted\b/i,
];
/** Weak cues only count when no sentence has a strong one. */
const WEAK_CUES = [
  /\b(?:people|players|users)\s+(?:will\s+)?(?:also\s+)?(?:play|enjoy)\b/i,
  /\bgame\b/i,
];

const MIN_SENTENCE = 12;
const MAX_SENTENCE = 400;

export function hasUiIntent(text: string): boolean {
  return UI_INTENT.test(text);
}

const matches = (cues: readonly RegExp[], sentence: string) =>
  cues.filter((cue) => cue.test(sentence)).length;

/**
 * Sentences of a UI request that promise look, feel, feedback or a preview, quoted verbatim.
 * Advisory: they point a reviewer at what the request said and add no requirement.
 */
export function experiencePromises(request: string, max = 3): string[] {
  if (!hasUiIntent(request)) return [];
  const sentences = request
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ""))
    .filter((sentence) => sentence.length >= MIN_SENTENCE)
    .map((sentence, index) => ({
      text: sentence.slice(0, MAX_SENTENCE),
      index,
      strong: matches(STRONG_CUES, sentence),
      weak: matches(WEAK_CUES, sentence),
    }));
  const anyStrong = sentences.some((entry) => entry.strong > 0);
  return sentences
    .filter((entry) => (anyStrong ? entry.strong > 0 : entry.weak > 0))
    .map((entry) => ({ ...entry, score: entry.strong * 2 + entry.weak }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.text);
}
