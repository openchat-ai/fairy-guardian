/**
 * fairy-guardian — Self-healing cluster SDK for AI model servers
 *
 * Usage:
 *
 *   import { FairyGuardian } from 'fairy-guardian';
 *
 *   const guardian = new FairyGuardian({
 *     myPort: 11434,
 *     childNames: ['llama3.1:8b', 'mistral:7b', 'codellama:13b'],
 *     portOffset: 100,
 *     healthPath: '/api/tags',
 *     spawnCmd: (port) => ['ollama', 'serve'],
 *   });
 *
 *   // Rolling restart — zero downtime
 *   await guardian.rollingRestart();
 */

export { FairyGuardian } from './src/guardian.js';
import FairyGuardian from './src/guardian.js';
export default FairyGuardian;
