import { Page, Request } from '@playwright/test';

export class ApiTracker {
  private requestMap: Map<string, number> = new Map();

  constructor(private page: Page) {}

  startTracking(): void {
    this.page.on('request', (request: Request) => {
      const key = `${request.method()} ${request.url()}`;
      this.requestMap.set(key, (this.requestMap.get(key) || 0) + 1);
    });
  }

  async waitForRequestCount(url: string, method: string, expectedCount: number, timeout: number = 5000): Promise<void> {
    const key = `${method.toUpperCase()} ${url}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout: ${key} was not called ${expectedCount} times within ${timeout}ms`));
      }, timeout);

      const checkRequestCount = () => {
        if ((this.requestMap.get(key) || 0) >= expectedCount) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(checkRequestCount, 100);
        }
      };

      checkRequestCount();
    });
  }

  stopTracking(): void {
    this.page.removeListener('request', this.trackRequest);
  }

  resetTracking(): void {
    this.requestMap.clear();
  }

  private trackRequest = (request: Request): void => {
    const key = `${request.method()} ${request.url()}`;
    this.requestMap.set(key, (this.requestMap.get(key) || 0) + 1);
  };
}
