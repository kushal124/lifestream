// @ts-check
import { installClock } from './lib/home-clock.js';

installClock({ id: 'kit-gallery', runs: [{ day: '1970-01-01', start_ms: 4 * 3_600_000, days: 1, zone: 'UTC' }] });
