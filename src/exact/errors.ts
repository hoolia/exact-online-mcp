export type ExactErrorKind = 'not_connected' | 'rate_limit' | 'api' | 'invalid_input';

export class ExactError extends Error {
  constructor(
    public kind: ExactErrorKind,
    public userMessage: string,
    public status?: number,
  ) {
    super(userMessage);
    this.name = 'ExactError';
  }
}

export const RECONNECT_MESSAGE =
  "Your Exact Online connection has expired. Please reconnect the connector in Claude's settings.";
