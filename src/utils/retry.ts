export interface RetryOptions {
  attempts: number;
  initialDelayMs: number;
  shouldRetry: (error: unknown) => boolean;
}

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts || !options.shouldRetry(error)) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, options.initialDelayMs * attempt);
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Retry failed");
}
