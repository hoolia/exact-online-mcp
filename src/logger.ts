import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    redact: {
      paths: [
        '*.access_token', '*.refresh_token', '*.client_secret', '*.code', '*.code_verifier',
        'req.headers.authorization', 'headers.authorization', 'access_token', 'refresh_token',
        'client_secret', 'token', '*.token',
      ],
      censor: '[redacted]',
    },
  });
}
export type Logger = pino.Logger;
