// Restore the live config to the real upstream after a test run crashed mid-flight.
import { loadConfig, saveConfig, CONFIG_PATH } from './config.mjs';
const cfg = loadConfig();
const before = cfg.upstream;
cfg.upstream = process.argv[2] || 'https://api.anthropic.com';
saveConfig(cfg);
console.log(`${CONFIG_PATH}\nupstream: ${before}  ->  ${cfg.upstream}`);
