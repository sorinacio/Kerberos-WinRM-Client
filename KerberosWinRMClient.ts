import { Page, Request, Response } from '@playwright/test';

export class ApiTracker {
  private requestMap: Map<string, number> = new Map();
  private responseMap: Map<string, { status: number; body: any }> = new Map();
  private pendingRequests: Map<string, (() => void)[]> = new Map();

  constructor(private page: Page) {}

  startTracking(): void {
    this.page.on('request', (request: Request) => {
      const key = this.getRequestKey(request);
      this.requestMap.set(key, (this.requestMap.get(key) || 0) + 1);

      if (this.pendingRequests.has(key)) {
        this.pendingRequests.get(key)?.forEach(resolve => resolve());
        this.pendingRequests.delete(key);
      }
    });

    this.page.on('response', async (response: Response) => {
      const request = response.request();
      const key = this.getRequestKey(request);

      try {
        const body = await response.json().catch(() => null);
        this.responseMap.set(key, { status: response.status(), body });
      } catch (error) {
        console.error(`Failed to read response body for ${key}:`, error);
      }
    });
  }

  stopTracking(): void {
    this.page.removeListener('request', this.trackRequest);
  }

  async waitForRequest(url: string, method?: string, timeout: number = 5000): Promise<void> {
    const key = method ? `${method.toUpperCase()} ${url}` : url;
    if (this.requestMap.get(key)) return;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(key);
        reject(new Error(`Timeout: Request ${key} was not made within ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(key, [...(this.pendingRequests.get(key) || []), () => {
        clearTimeout(timer);
        resolve();
      }]);
    });
  }

  async waitForMultipleRequests(
    requests: { url: string; method?: string }[],
    timeout: number = 5000
  ): Promise<void> {
    await Promise.all(requests.map(req => this.waitForRequest(req.url, req.method, timeout)));
  }

  getRequestCount(url: string, method?: string): number {
    const key = method ? `${method.toUpperCase()} ${url}` : url;
    return this.requestMap.get(key) || 0;
  }

  getResponse(url: string, method?: string): { status: number; body: any } | null {
    const key = method ? `${method.toUpperCase()} ${url}` : url;
    return this.responseMap.get(key) || null;
  }

  resetTracking(): void {
    this.requestMap.clear();
    this.responseMap.clear();
    this.pendingRequests.clear();
  }

  private getRequestKey(request: Request): string {
    return `${request.method()} ${request.url()}`;
  }

  private trackRequest = (request: Request): void => {
    const key = this.getRequestKey(request);
    this.requestMap.set(key, (this.requestMap.get(key) || 0) + 1);
  };
}
