import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  unsupportedRecipientPassed,
  type UnsupportedRecipientObservation,
} from '../scripts/integrated-outcomes.js';

// The connected refusal #57 asks for: visible as Unsupported before send, failed
// with the image rationale, never dispatched or charged, refused again on retry,
// still chatting.
const refused: UnsupportedRecipientObservation = {
  connectionAfterRefusal: 'ready',
  statusShownBeforeSend: true,
  shownStatus: 'Unsupported',
  deliveryStatus: 'failed',
  rationaleIsImageRefusal: true,
  noticeRecorded: true,
  attemptIdAfterSend: null,
  attemptIdAfterRetry: null,
  imageMessageDispatches: 0,
  recipientActivitiesInWindow: 0,
  retryRefusedAgain: true,
  textAfterRefusal: true,
};
const cases: [string, UnsupportedRecipientObservation, boolean][] = [
  ['the connected refusal', refused, true],
  // Dispatched or charged before rejection: each observation alone must fail the row.
  ['an attempt stamped on the first send', { ...refused, attemptIdAfterSend: 'a1' }, false],
  ['an attempt stamped by the retry', { ...refused, attemptIdAfterRetry: 'a2' }, false],
  ['an adapter run carrying the image', { ...refused, imageMessageDispatches: 1 }, false],
  // A connected recipient may answer peers' text follow-ups while its image stays refused.
  [
    'legitimate peer-text activity beside the refusal',
    { ...refused, recipientActivitiesInWindow: 3 },
    true,
  ],
  [
    'peer-text activity cannot excuse an image dispatch',
    { ...refused, recipientActivitiesInWindow: 3, imageMessageDispatches: 1 },
    false,
  ],
  // The host blocker seen live: never connected, so never refused.
  [
    'a recipient that never connected',
    {
      ...refused,
      connectionAfterRefusal: 'unavailable',
      shownStatus: 'Not observed',
      deliveryStatus: 'queued',
      rationaleIsImageRefusal: false,
      noticeRecorded: false,
      retryRefusedAgain: false,
      textAfterRefusal: false,
    },
    false,
  ],
  ['a status that was not shown before send', { ...refused, statusShownBeforeSend: false }, false],
  [
    'a Not observed status on a connected recipient',
    { ...refused, shownStatus: 'Not observed' },
    false,
  ],
  ['a delivery left queued', { ...refused, deliveryStatus: 'queued' }, false],
  ['a failure for some other reason', { ...refused, rationaleIsImageRefusal: false }, false],
  ['no persisted notice', { ...refused, noticeRecorded: false }, false],
  ['a retry that was not refused again', { ...refused, retryRefusedAgain: false }, false],
  ['text that did not continue', { ...refused, textAfterRefusal: false }, false],
  // An observation that was never made is not a pass.
  ['an unobserved attempt field', { ...refused, attemptIdAfterSend: undefined }, false],
  ['an unobserved dispatch count', { ...refused, imageMessageDispatches: undefined }, false],
  ['nothing observed at all', {}, false],
];

it('passes only the connected refusal that was never dispatched or charged', () => {
  for (const [name, observation, expected] of cases)
    expect(unsupportedRecipientPassed(observation), name).toBe(expected);
});

it('holds the PTY driver to the same rule, case for case', () => {
  const python = spawnSync('python3', ['scripts/integrated_outcomes.py'], {
    // JSON drops undefined fields, which is how the PTY driver sees an unmade observation.
    input: JSON.stringify(cases.map(([, observation]) => observation)),
    encoding: 'utf8',
  });
  expect(python.status, python.stderr).toBe(0);
  expect(JSON.parse(python.stdout)).toEqual(cases.map(([, , expected]) => expected));
});
