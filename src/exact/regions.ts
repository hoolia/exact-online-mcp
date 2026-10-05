import type { Region } from '../config.js';

const TLD: Record<Region, string> = { nl: 'nl', be: 'be', de: 'de', uk: 'co.uk', fr: 'fr', es: 'es', us: 'com' };

export const REGION_LABELS: Record<Region, string> = {
  nl: 'Netherlands', be: 'Belgium', de: 'Germany', uk: 'United Kingdom', fr: 'France', es: 'Spain', us: 'United States',
};

export const exactHost = (r: Region) => `https://start.exactonline.${TLD[r]}`;
export const apiBase = (r: Region) => `${exactHost(r)}/api/v1`;
export const authUrl = (r: Region) => `${exactHost(r)}/api/oauth2/auth`;
export const tokenUrl = (r: Region) => `${exactHost(r)}/api/oauth2/token`;
