// #57 pass rule for the unsupported mixed recipient. It passes only when the
// product refused the image for a connected recipient before any dispatch or
// charge. `dispatch()` stamps an attemptId on every delivery it sends and charges
// in the same step, so an image delivery that never carries one, with no adapter run
// holding the image message, was never dispatched or charged. A connected recipient
// may still handle peers' ordinary text follow-ups while its image is refused, so its
// total activity is context only, like the room's shared exchange counter. scripts/integrated_outcomes.py mirrors it,
// and test/integrated-outcomes.test.ts runs both against one case table.
export interface UnsupportedRecipientObservation {
  connectionAfterRefusal?: string;
  statusShownBeforeSend?: boolean;
  shownStatus?: string | null;
  deliveryStatus?: string;
  rationaleIsImageRefusal?: boolean;
  noticeRecorded?: boolean;
  attemptIdAfterSend?: string | null;
  attemptIdAfterRetry?: string | null;
  imageMessageDispatches?: number;
  /** Context only: text follow-ups are legitimate while the image is refused. */
  recipientActivitiesInWindow?: number;
  retryRefusedAgain?: boolean;
  textAfterRefusal?: boolean;
}
export function unsupportedRecipientPassed(o: UnsupportedRecipientObservation): boolean {
  return (
    o.connectionAfterRefusal === 'ready' &&
    o.statusShownBeforeSend === true &&
    o.shownStatus === 'Unsupported' &&
    o.deliveryStatus === 'failed' &&
    o.rationaleIsImageRefusal === true &&
    o.noticeRecorded === true &&
    o.attemptIdAfterSend === null &&
    o.attemptIdAfterRetry === null &&
    o.imageMessageDispatches === 0 &&
    o.retryRefusedAgain === true &&
    o.textAfterRefusal === true
  );
}
