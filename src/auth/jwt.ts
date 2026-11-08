import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Who made a tool call: a person through the OAuth broker, or a workload with an OIDC access token. */
export interface CallerIdentity {
  kind: 'human' | 'workload';
  /** stable id: exact:<Exact UserID> or jwt:<issuer subject> */
  id: string;
  /** display name: Exact user name, or preferred_username / client id */
  name: string;
  /** OAuth client id (broker client, or azp of the access token) */
  clientId: string | null;
}

export interface JwtSettings {
  issuer: string;
  audience: string;
  jwksUrl: string;
  /** azp values allowed to call; empty: any client the issuer signed a token for */
  allowedClients: string[];
}

export const looksLikeJwt = (token: string) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);

/** Validates OIDC access tokens (signature from the issuer's JWKS, iss, aud, exp, nbf). */
export class JwtVerifier {
  private getKey: JWTVerifyGetKey;

  constructor(private s: JwtSettings, getKey?: JWTVerifyGetKey) {
    this.getKey = getKey ?? createRemoteJWKSet(new URL(s.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
  }

  async verify(token: string): Promise<CallerIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, this.getKey, {
        issuer: this.s.issuer, audience: this.s.audience, clockTolerance: 30, algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384', 'EdDSA'],
      });
      if (!payload.sub) return null;
      const azp = typeof payload.azp === 'string' ? payload.azp : typeof payload.client_id === 'string' ? payload.client_id : null;
      if (this.s.allowedClients.length && (!azp || !this.s.allowedClients.includes(azp))) return null;
      const username = typeof payload.preferred_username === 'string' ? payload.preferred_username : null;
      return { kind: 'workload', id: `jwt:${payload.sub}`, name: username ?? azp ?? payload.sub, clientId: azp };
    } catch {
      return null;
    }
  }
}
