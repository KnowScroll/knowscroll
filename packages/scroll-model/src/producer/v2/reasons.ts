import { LIMITS_V2 } from '../../v2/limits.js';
import { READING_SECONDS_V2 } from '../../v2/measures.js';

/**
 * Fixed repair hints of the v2 writer, one per code it can meet, for its single repair. They are
 * the writer's own catalogue (at most 128 codes, each hint under 256 characters) so the v1 catalogue
 * can keep filling its share. A hint never quotes the model's text.
 */
export const REPAIR_HINTS_V2: Readonly<Record<string, string>> = Object.freeze({
  // The model's own mistakes.
  stops_too_few: `Write at least ${LIMITS_V2.minStops} stops and calls in all: the spine needs enough dots for a ${READING_SECONDS_V2.min / 60} to ${READING_SECONDS_V2.max / 60} minute read.`,
  read_stops_too_few: `Write at least ${LIMITS_V2.minReadStops} stops that explain (type "stop"), besides the calls: the picture and the reader's progress rest on them.`,
  stop_too_long: `Cut this to at most ${LIMITS_V2.stopWords} words (a stop's text and line together). One idea per stop; move the rest into the next stop.`,
  line_too_long: `A line stands alone and has at most ${LIMITS_V2.lineWords} words. Shorten it or put the idea in the stop's text.`,
  simple_too_long: `The simple text is shorter than the original: at most ${LIMITS_V2.stopWords} words, in plainer words.`,
  heading_misplaced: 'Use at most one heading per stop and keep it rare.',
  call_it_missing: 'Add at least one call_it item before the final_call.',
  call_budget_exceeded: `Use at most ${LIMITS_V2.calls} calls in all, the final_call included.`,
  final_call_missing: 'End the list with exactly one final_call item.',
  final_call_misplaced: 'The final_call is the last stop: put it after every other stop and call, and use exactly one.',
  call_answer_invalid: 'Give two or three options for each call, the correct one first.',
  call_options_duplicate: 'Every option of a call must be different.',
  final_call_restates_call:
    'The final_call asks again what an earlier call asked. Make it a new case that uses the whole idea, with a new question and a new correct answer.',
  final_call_binding_invalid:
    'The final_call lets the reader turn Earth’s tilt, so end on a June or December picture (earthAt jun or dec) in the sun-earth, earth-close or orbit view: in March, September or the Moon view the tilt changes nothing.',
  aside_before_stop: 'An aside belongs to the stop before it. Put it after the stop it comments on.',
  aside_after_final_call: 'Put asides before the final_call, never after it.',
  aside_anchor_unknown: 'An aside must follow a stop or a call.',
  limits_aside_missing: 'Add one aside of kind "limits" next to the claim it limits: what this picture leaves out.',
  limits_aside_last:
    'The limits aside belongs next to the claim it limits, well before the final_call, not at the end.',
  recap_small_print_unknown: 'The recap links to the limits aside; add one.',
  stage_unexpected: 'This Scroll has no stage: remove the stage object from this item.',
  stage_choice_invalid:
    'A stage change may use only the keys and words listed for this Scroll’s picture. Remove any other key, and use a word exactly as listed.',
  stage_missing: 'This Scroll has a stage: give the first stop a stage object that sets the starting picture.',
  earth_axis_sideways:
    'Earth’s axis is tilted by a fixed angle and points the same way all year. Say it is tilted or leans, and never call it sideways or on its side.',
  stage_state_on_call:
    'A call never changes the picture, or it would show the answer before the reader has chosen. Remove stage here and change the picture on the stop after the call.',
  stage_first_state_missing:
    'The first stop must set the starting picture: give it a stage object with at least a view.',
  stage_too_static: `The stage must change at least ${LIMITS_V2.minStageStates} times as the stops go by. Add stage changes that follow the explanation.`,
  stage_states_unordered: 'Stage changes follow the order of the stops.',
  reading_length_out_of_brief: `The Scroll must take ${READING_SECONDS_V2.min / 60} to ${READING_SECONDS_V2.max / 60} minutes to read: about 650 to 900 words in all, plus ten seconds for every call.`,
  // The play blocks and the guide (D-207).
  block_unexpected:
    'Use only the play block the instructions name for this Scroll, and only once. Remove this block and keep its lead-in as a plain stop if it is needed.',
  block_missing: 'This Scroll has a play block named in the instructions (sort, fork, scale or chart): add it once.',
  block_value_invalid:
    'Write each value as the passage writes the figure: digits, with commas or a decimal point, and no units. If the passage writes "million" or "billion" after the figure, give that word as "magnitude" and keep the figure as written. The unit goes in "unit".',
  interactive_budget_exceeded: `Use at most ${LIMITS_V2.otherInteractives} play blocks (sort, fork, scale, chart) in a Scroll.`,
  sort_items_duplicate: 'Every item of a sort must be different.',
  fork_branches_duplicate: 'The two paths of a fork need different labels.',
  fork_branch_too_long: `Each path of a fork is at most ${LIMITS_V2.branchWords} words.`,
  scale_values_invalid: 'The points of a scale need different values, and a log scale has no zero.',
  scale_here_invalid: '"here" must be the label of one of the points, written exactly as there.',
  chart_labels_duplicate: 'Every point of a scale or a chart needs its own label.',
  guide_unexpected: 'This Scroll has no guide: remove the guide from this stop.',
  guide_budget_exceeded: `The guide speaks at most ${LIMITS_V2.guides} times in a Scroll.`,
  guide_too_close: 'The guide speaks rarely: leave at least two stops between its lines.',
  guide_too_long: `A guide line is at most ${LIMITS_V2.guideWords} words.`,
  // Checks shared with v1.
  copied_passage:
    'Nine or more words in a row match a passage. Rewrite only the text of this item in your own words, with a different sentence structure.',
  authoring_cite_unknown: 'Cite only the offered passage handles, such as e1 or e7.',
  authoring_too_few_cites: 'Ground the Scroll in more of the offered passages: cite at least four different ones.',
  authoring_number_not_in_evidence:
    'Use a number only if it appears in a passage this item cites; otherwise say it in words.',
  text_not_plain: 'Text must be one plain line without control characters.',
  text_mentions_web_address: 'Remove web addresses, domains and source names from reader text.',
  schema_too_big: 'A text or a list is above its maximum length.',
  schema_too_small: 'A text or a list is below its minimum length.',
  schema_invalid_value: 'A value is not one of the allowed words.',
  document_too_large: 'The Scroll is too big; shorten it.',
  // Checks that only a defect in the assembler can fail; kept so a finding is never silent.
  sort_order_invalid: 'The order of a sort is set by code.',
  sort_already_ordered: 'The order of a sort is set by code.',
  common_guess_invalid: 'The common guess is the second option of the first call_it of a myth Scroll; code sets it.',
  common_guess_missing: 'The common guess is the second option of the first call_it of a myth Scroll; code sets it.',
  common_guess_unexpected: 'Only the first call_it of a myth Scroll has a common guess; code sets it.',
  stage_state_unsettled: 'A stage state holds only what its view draws; code settles it.',
  measures_mismatch: 'The reading measures are computed by code.',
  integrity_mismatch: 'The integrity hash is computed by code.',
  stage_alt_mismatch: 'The description of a stage state is derived by code.',
  stage_state_repeated: 'Consecutive stage states differ.',
  stage_state_stop_unknown: 'A stage state names a stop that exists.',
  id_duplicate: 'Ids are assigned by code.',
});
