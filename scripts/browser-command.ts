import assert from 'node:assert/strict';
import type { Page, Request, Response } from '@playwright/test';

export async function postBrowserCommand(
  page: Page,
  line: string,
  timeout: number,
  observe: { step: (value: string) => void; retry: (commandId: string) => void },
) {
  observe.step(line.startsWith('/') ? `browser command ${line.split(' ')[0]}` : 'browser send');
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  const matches = (request: Request) =>
    new URL(request.url()).pathname === '/api/command' &&
    request.method() === 'POST' &&
    request.postDataJSON()?.line?.trim() === line.trim();
  let expectedId: string | undefined;
  let first = true;
  while (Date.now() < deadline) {
    let cleanup = () => {};
    const outcome = new Promise<{ request: Request; response?: Response }>((resolve, reject) => {
      const onResponse = (response: Response) => {
        if (matches(response.request())) {
          cleanup();
          resolve({ request: response.request(), response });
        }
      };
      const onFailure = (request: Request) => {
        if (matches(request)) {
          cleanup();
          resolve({ request });
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Browser command timed out'));
      }, remaining());
      cleanup = () => {
        clearTimeout(timer);
        page.off('response', onResponse);
        page.off('requestfailed', onFailure);
      };
      page.on('response', onResponse);
      page.on('requestfailed', onFailure);
    });
    // Keep a failed browser action from leaving an unhandled waiter rejection.
    void outcome.catch(() => {});
    try {
      if (first) {
        await page.getByRole('textbox', { name: 'Message', exact: true }).fill(line);
        // End dismisses name completion without accepting another token.
        await page.getByRole('textbox', { name: 'Message', exact: true }).press('End');
        await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
        first = false;
      } else {
        // The product's 12-second request timeout can precede native reconnect.
        // Reconcile through its existing UI, retaining the original operation ID.
        await page
          .getByRole('button', { name: 'Check last action', exact: true })
          .click({ timeout: remaining() });
      }
      const received = await outcome;
      const id = received.request.postDataJSON()?.id;
      assert.equal(typeof id, 'string', 'Browser command omitted its operation ID');
      if (expectedId) assert.equal(id, expectedId, 'Checking last action changed the operation ID');
      expectedId = id;
      if (!received.response) {
        observe.retry(id);
        continue;
      }
      observe.step('browser command response body');
      const result = await received.response.json();
      if (result.ok !== true) throw new Error('Browser command rejected');
      return result;
    } finally {
      cleanup();
    }
  }
  throw new Error('Browser command timed out');
}
