"""#57 pass rule for the unsupported mixed recipient. Mirrors scripts/integrated-outcomes.ts;
test/integrated-outcomes.test.ts runs both against one case table. Reads a JSON list of
observations on stdin and prints a JSON list of booleans when run directly."""
import json, sys
def unsupported_passed(o):
    # A delivery dispatch() sent carries an attemptId, and dispatch() charges in the same step.
    # A connected recipient may handle peers' text follow-ups while its image is refused, so its
    # total activity is context only, like the shared room exchange counter.
    return (o.get('connectionAfterRefusal') == 'ready' and o.get('statusShownBeforeSend') is True
        and o.get('shownStatus') == 'Unsupported' and o.get('deliveryStatus') == 'failed'
        and o.get('rationaleIsImageRefusal') is True and o.get('noticeRecorded') is True
        and 'attemptIdAfterSend' in o and o['attemptIdAfterSend'] is None
        and 'attemptIdAfterRetry' in o and o['attemptIdAfterRetry'] is None
        and o.get('imageMessageDispatches') == 0
        and o.get('retryRefusedAgain') is True and o.get('textAfterRefusal') is True)
if __name__ == '__main__':
    print(json.dumps([unsupported_passed(o) for o in json.load(sys.stdin)]))
