import { LIMITS_V3 as L } from '../../v3/limits.js';
import { READING_SECONDS_V3 } from '../../v3/measures.js';

/**
 * Fixed repair hints of the document v3 writer, one per code its compile can return, for the model's single repair. It
 * is the writer's own catalogue (at most 110 codes, each hint 1 to 256 characters, so the backend can add a few and stay
 * within the harness's 128) and a hint never quotes the model's text. A code that only a defect in code can raise keeps
 * a hint so that a finding is never silent.
 */
export const REPAIR_HINTS_V3: Readonly<Record<string, string>> = Object.freeze({
  // The shape of the reply.
  schema_invalid_type:
    'A value has the wrong type: text where a number goes, a number where text goes, or a list where an object goes.',
  schema_too_small: 'A text or a list is below its minimum length.',
  schema_too_big: 'A text or a list is above its maximum length.',
  schema_invalid_format: 'A value is not written in its required form, such as a figure that is not digits.',
  schema_invalid_value: 'A value is not one of the allowed words. Use a word exactly as listed.',
  schema_unrecognized_keys: 'An object has a key that is not in the shape. Remove it.',
  schema_invalid_union:
    'An item matches none of the allowed forms. Check its "type", "kind" or "form" and the keys that form takes.',
  schema_invalid: 'A value does not fit the shape.',
  text_not_plain: 'Text must be one plain line, without control characters or space at either end.',
  text_mentions_web_address: 'Remove web addresses, domains and source names from reader text.',
  id_format: 'Cite passages by their handle only: e1, e2, up to e99.',
  figure_format:
    'A chart value is digits only, with thousands commas and a decimal part if the passage has one. A word after it belongs in the unit.',
  document_too_large: 'The Scroll is too big; shorten it.',
  // Sections, paragraphs and their words.
  beats_too_few: `Write at least ${L.beats.min} paragraphs and quotations in all, across two or three sections.`,
  beats_too_many: `Write at most ${L.beats.max} paragraphs and quotations in all. Cut the ones the idea needs least.`,
  beat_too_long: `A paragraph or quotation has at most ${L.beatWords} words. Shorten it, or move the rest to the next paragraph.`,
  first_beat_too_long: `The first paragraph is the cover's opening line: at most ${L.firstBeatWords} words.`,
  simple_too_long: `The simple text says the same idea in plainer words, in at most ${L.beatWords} words.`,
  main_text_too_short: `The paragraphs together need at least ${L.mainWords.min} words. Add to the paragraphs, not to the asides.`,
  main_text_too_long: `The paragraphs together have at most ${L.mainWords.max} words. Cut the least needed.`,
  reading_length_out_of_brief: `The Scroll must take ${READING_SECONDS_V3.min / 60} to ${READING_SECONDS_V3.max / 60} minutes to read: ${L.mainWords.min} to ${L.mainWords.max} words of paragraphs, and a few seconds for each picture shown and each control.`,
  section_first_missing: 'Start the items list with a "section" item. Every paragraph belongs to a section.',
  // Pictures.
  picture_unshown: 'Every picture must be shown by some paragraph. Add a show for it, or take the picture out.',
  picture_kind_unplanned: 'Use exactly the picture kinds the plan names, one picture for each, in the plan’s order.',
  picture_label_duplicate:
    'Every named part of one picture needs its own label: no two steps, items, rows, columns, points or places share one. Cells may repeat a text, but then no phrase or lit can name that cell.',
  picture_ref_unknown: 'Name a row, column, point or place by its exact label, as written in the same picture.',
  picture_cell_taken: 'Two things sit in one cell of a plan or a grid. Give each its own cell.',
  picture_cell_outside: 'A plan cell is outside the plan. Keep every cell inside the columns and rows of "size".',
  picture_way_bent: 'A way runs straight along one row or one column and has some length.',
  picture_steps_missing: 'A tally that arrives at a step needs the plan’s "steps". Add them, or drop the tally’s step.',
  picture_tally_step_invalid: 'A tally’s step is a position in the plan’s "steps", counted from 0.',
  picture_region_invalid:
    'A region’s nearest place is one of its "among" places, each listed once and each a place of the plan.',
  picture_value_invalid: 'A bar chart cannot have a negative value. Use a line for a figure below zero.',
  picture_ids_duplicate: 'Part ids are assigned by code.',
  // What a paragraph shows, links and controls.
  show_picture_unknown:
    'A show names a picture by its number, counted from 1 in the pictures list. Use a number that exists.',
  show_state_invalid:
    'A show uses only the keys its picture understands: "upTo" within its items, "lit" labels that exist (at most four), and for a plan "step" and "region".',
  link_phrase_not_once: 'A linked phrase is the exact words of its paragraph, and they occur there once.',
  link_part_unknown: 'A link names a part of the picture on screen by its exact label.',
  link_without_picture:
    'A link needs a picture on screen. Show a picture in this paragraph, or in an earlier paragraph of the same section.',
  link_phrases_overlap: 'Two links of a paragraph must not share any words.',
  control_budget_exceeded: `Use at most ${L.controls} controls in the whole Scroll.`,
  control_without_show: 'A control sits on a paragraph that shows a picture. Add a show, or take the control off.',
  control_unfit:
    'The control does not fit its picture: a scrub needs two places to go, a switch a state that differs from the paragraph’s, a pick two items with notes. A quotation has none.',
  // Asides, the takeaway, the ask suggestions.
  aside_without_beat: 'An aside sits right after the paragraph or quotation it belongs to. Put it after one.',
  aside_anchor_unknown: 'An aside must follow a paragraph or a quotation.',
  limits_aside_missing: 'Add one aside of kind "limits" that says what this Scroll leaves out.',
  takeaway_sentences: `The takeaway is ${L.takeawaySentences.min} to ${L.takeawaySentences.max} plain sentences.`,
  takeaway_repeats_dek: 'The takeaway says again what the dek promised. Write what the reader now knows, in new words.',
  // Evidence.
  authoring_cite_unknown: 'Cite only the offered passage handles, such as e1 or e7.',
  authoring_too_few_cites:
    'Ground the Scroll in more of the offered passages: cite at least the number of different ones the instructions name.',
  authoring_number_not_in_evidence:
    'Use a figure only as a cited passage writes it, with the same word after it, and a range only whole; otherwise say it in words. A chart value and its unit must match the passage.',
  quote_not_in_evidence:
    'A quotation must match a cited passage word for word. Copy it exactly, or say it in your own words.',
  copied_passage:
    'Nine or more words in a row match the research. Rewrite this item in your own words, with a different sentence structure. The repair notes, when there are any, name the part and quote the words.',
  // Writing.
  first_beat_points_back:
    'Open the first paragraph with something new. The reader has met nothing yet, so it cannot start with this, that, it, so or but.',
  machine_phrase: 'A stock phrase of machine prose is used. Say the thing plainly, the way a person would to a friend.',
  // Staging (arm b).
  stage_para_unknown:
    'A stage entry’s "para" is the number of a paragraph or quotation, P1 to the last one. Use a number that exists.',
  stage_para_repeated: 'List each paragraph once in the stage. Put everything it shows into one entry.',
  // Defects of code; kept so a finding is never silent.
  measures_mismatch: 'The reading measures are computed by code.',
  integrity_mismatch: 'The integrity hash is computed by code.',
  id_duplicate: 'Ids are assigned by code.',
  authoring_reference_unknown: 'A cited passage names a source code did not supply; code sets this.',
});
