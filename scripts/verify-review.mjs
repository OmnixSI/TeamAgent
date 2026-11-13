#!/usr/bin/env node
// Read-only deployment verification. Token is supplied in the environment.
const base = process.env.REVIEW_BASE, expected = process.env.RELEASE;
if (!base || !expected) throw Error('REVIEW_BASE and RELEASE are required');
const url = new URL('/review/health', base);
if (url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname)) throw Error('HTTPS required');
const response = await fetch(url, { headers: { Authorization: 'Bearer ' + (process.env.REVIEW_TOKEN || '') }, signal: AbortSignal.timeout(15000), redirect: 'error' });
if (!response.ok) throw Error('review health HTTP ' + response.status);
const health = await response.json();
if (health.release !== expected || health.migration !== '0008' || !health.ok) throw Error('review release or migration mismatch');
console.log(`review health verified: release=${health.release}, migration=${health.migration}`);
